import { join } from '@std/path'
import { exists } from '@std/fs'
import {
  MAX_DESCRIPTION_LENGTH,
  validateReadme,
  validateSlugMatch,
} from './entity-schema.ts'
import type { Frontmatter } from './entity-schema.ts'

type ToolType = 'stdio' | 'mcp'

type McpConfig = {
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  url?: string
  headers?: Record<string, string>
}

type ToolManifest = {
  name: string
  slug: string
  version: string
  description?: string
  template?: boolean
  type?: ToolType
  mcp?: McpConfig
  flags: string[]
  env: Record<string, string>
}

type ValidatedTool = {
  frontmatter: Frontmatter
  manifest: ToolManifest
}

async function resolveExecutable(
  dir: string,
  prefix: string,
): Promise<string | null> {
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile) continue
      const lower = entry.name.toLowerCase()
      if (
        lower === prefix ||
        (lower.startsWith(`${prefix}.`) && lower !== `${prefix}.json`)
      ) {
        return join(dir, entry.name)
      }
    }
  } catch {
    // directory doesn't exist or isn't readable
  }
  return null
}

async function validate(dir: string): Promise<ValidatedTool> {
  const frontmatter = await validateReadme(dir)
  validateSlugMatch(frontmatter.name, dir)

  const manifestPath = join(dir, 'tool.json')
  if (!await exists(manifestPath)) {
    throw new Error(`tool.json not found in ${dir}`)
  }
  const manifest = JSON.parse(
    await Deno.readTextFile(manifestPath),
  ) as ToolManifest

  if (manifest.slug !== frontmatter.name) {
    throw new Error(
      `README name '${frontmatter.name}' must match tool.json slug` +
        ` '${manifest.slug}'.`,
    )
  }

  if (manifest.type === 'mcp') {
    if (!manifest.mcp) {
      throw new Error(
        `MCP tool '${manifest.slug}' must have an "mcp" config` +
          ' in tool.json with transport, command/url.',
      )
    }
    if (
      manifest.mcp.transport === 'stdio' && !manifest.mcp.command
    ) {
      throw new Error(
        `MCP stdio tool '${manifest.slug}' must specify` +
          ' "command" in mcp config.',
      )
    }
    if (manifest.mcp.transport === 'http' && !manifest.mcp.url) {
      throw new Error(
        `MCP http tool '${manifest.slug}' must specify` +
          ' "url" in mcp config.',
      )
    }
  } else {
    const hasTool = await resolveExecutable(dir, 'tool')
    const hasInstall = await resolveExecutable(dir, 'install')
    if (!hasTool && !hasInstall) {
      throw new Error(
        `Tool folder must contain an executable named 'tool'` +
          ` (any extension) or an install script named` +
          ` 'install' (any extension). Neither found in ${dir}`,
      )
    }
  }

  manifest.description = frontmatter.description

  return { frontmatter, manifest }
}

export { MAX_DESCRIPTION_LENGTH, resolveExecutable, validate }
export type { McpConfig, ToolManifest, ToolType, ValidatedTool }

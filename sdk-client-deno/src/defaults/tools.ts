import { join } from '@std/path'
import { load, registryDir } from '../runtime.ts'
import type { ToolManifest } from '../tool-schema.ts'
import { parseFrontmatter } from '../entity-schema.ts'

const BUILTIN: ToolManifest[] = [
  {
    name: 'cursor',
    slug: 'cursor',
    version: '0.0.1',
    flags: ['-p', '--force', '--trust'],
    env: { CURSOR_API_KEY: '${CURSOR_API_KEY}' },
  },
  {
    name: 'claude',
    slug: 'claude',
    version: '0.0.1',
    flags: ['--output-format', 'json'],
    env: { ANTHROPIC_API_KEY: '${ANTHROPIC_API_KEY}' },
  },
  {
    name: 'github',
    slug: 'github',
    version: '0.0.1',
    flags: ['--no-pager'],
    env: { GH_TOKEN: '${GH_TOKEN}' },
  },
  {
    name: 'auth0',
    slug: 'auth0',
    version: '0.0.1',
    flags: ['--no-input'],
    env: {
      AUTH0_DOMAIN: '${AUTH0_DOMAIN}',
      AUTH0_CLIENT_ID: '${AUTH0_CLIENT_ID}',
      AUTH0_CLIENT_SECRET: '${AUTH0_CLIENT_SECRET}',
    },
  },
  {
    name: 'datadog',
    slug: 'datadog',
    version: '0.0.1',
    flags: [],
    env: {
      DD_API_KEY: '${DD_API_KEY}',
      DD_APP_KEY: '${DD_APP_KEY}',
      DD_SITE: '${DD_SITE}',
    },
  },
  {
    name: 'gemini',
    slug: 'gemini',
    version: '0.0.1',
    flags: [],
    env: {
      GOOGLE_CLOUD_PROJECT: '${GOOGLE_CLOUD_PROJECT}',
      GCP_PROJECT: '${GCP_PROJECT}',
    },
  },
]

let cached: ToolManifest[] | null = null

function resolve(): ToolManifest[] {
  let registry: string
  try {
    registry = registryDir()
  } catch {
    return BUILTIN
  }

  const results: ToolManifest[] = []
  for (const ref of load().tools) {
    const dir = join(registry, 'tools', ref.slug, ref.version)
    try {
      const raw = Deno.readTextFileSync(join(dir, 'tool.json'))
      const manifest = JSON.parse(raw) as ToolManifest
      try {
        const readme = Deno.readTextFileSync(join(dir, 'README.md'))
        manifest.description = parseFrontmatter(readme).description
      } catch {
        // README frontmatter is optional
      }
      results.push(manifest)
    } catch {
      const builtin = BUILTIN.find(
        (b) => b.slug === ref.slug && b.version === ref.version,
      )
      if (builtin) results.push(builtin)
    }
  }
  return results.length > 0 ? results : BUILTIN
}

function TOOLS(): ToolManifest[] {
  if (!cached) cached = resolve()
  return cached
}

export { TOOLS }

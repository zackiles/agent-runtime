import { join } from '@std/path'
import { exists } from '@std/fs'
import {
  MAX_COMPATIBILITY_LENGTH,
  MAX_SKILL_DESCRIPTION_LENGTH,
  MAX_SKILL_NAME_LENGTH,
  SKILL_NAME_PATTERN,
  validateReadme,
  validateSlugMatch,
} from './entity-schema.ts'
import type { Frontmatter } from './entity-schema.ts'

type SkillManifest = {
  name: string
  slug: string
  version: string
  description?: string
  template?: boolean
}

type SkillFrontmatter = Frontmatter & {
  license?: string
  compatibility?: string
  metadata?: Record<string, string>
  allowedTools?: string
  disableModelInvocation?: boolean
}

type ValidatedSkill = {
  frontmatter: SkillFrontmatter
  manifest: SkillManifest
  body: string
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/

function parseSkillMd(content: string): {
  frontmatter: SkillFrontmatter
  body: string
} {
  const match = content.match(FRONTMATTER_RE)
  if (!match) {
    throw new Error(
      'SKILL.md must start with YAML frontmatter (--- delimiters)',
    )
  }

  const block = match[1]
  const body = content.slice(match[0].length).replace(/^\n+/, '')

  const name = block.match(/^name:\s*(.+)$/m)?.[1]?.trim()
  const description = block.match(/^description:\s*(.+)$/m)?.[1]?.trim()
  if (!name) {
    throw new Error(
      'SKILL.md frontmatter must include a "name" field',
    )
  }
  if (!description) {
    throw new Error(
      'SKILL.md frontmatter must include a "description" field',
    )
  }

  if (name.length > MAX_SKILL_NAME_LENGTH) {
    throw new Error(
      `Skill name must be ${MAX_SKILL_NAME_LENGTH} characters or` +
        ` fewer (currently ${name.length}).`,
    )
  }
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new Error(
      `Skill name '${name}' must be lowercase alphanumeric with` +
        ' hyphens, no consecutive hyphens, and must not start or' +
        ' end with a hyphen.',
    )
  }
  if (description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
    throw new Error(
      `Skill description must be ${MAX_SKILL_DESCRIPTION_LENGTH}` +
        ` characters or fewer (currently ${description.length}).`,
    )
  }

  const fm: SkillFrontmatter = { name, description }

  const license = block.match(/^license:\s*(.+)$/m)?.[1]?.trim()
  if (license) fm.license = license

  const compat = block.match(/^compatibility:\s*(.+)$/m)?.[1]?.trim()
  if (compat) {
    if (compat.length > MAX_COMPATIBILITY_LENGTH) {
      throw new Error(
        `Compatibility must be ${MAX_COMPATIBILITY_LENGTH}` +
          ` characters or fewer (currently ${compat.length}).`,
      )
    }
    fm.compatibility = compat
  }

  const allowedTools = block.match(/^allowed-tools:\s*(.+)$/m)?.[1]?.trim()
  if (allowedTools) fm.allowedTools = allowedTools

  const disableRaw = block.match(/^disable-model-invocation:\s*(.+)$/m)?.[1]
    ?.trim()
  if (disableRaw) fm.disableModelInvocation = disableRaw === 'true'

  const metaBlock = block.match(
    /^metadata:\s*\n((?:\s{2,}.+\n?)*)/m,
  )
  if (metaBlock) {
    fm.metadata = {}
    for (const line of metaBlock[1].split('\n')) {
      const kv = line.match(/^\s+(\S+):\s*(.+)$/)
      if (kv) fm.metadata[kv[1]] = kv[2].trim()
    }
  }

  return { frontmatter: fm, body }
}

async function validate(dir: string): Promise<ValidatedSkill> {
  const skillMdPath = join(dir, 'SKILL.md')
  const hasSkillMd = await exists(skillMdPath)

  let frontmatter: SkillFrontmatter
  let body: string

  if (hasSkillMd) {
    const content = await Deno.readTextFile(skillMdPath)
    const parsed = parseSkillMd(content)
    frontmatter = parsed.frontmatter
    body = parsed.body
  } else {
    const readme = await validateReadme(dir)
    const readmePath = join(dir, 'README.md')
    const content = await Deno.readTextFile(readmePath)
    const match = content.match(FRONTMATTER_RE)
    body = match ? content.slice(match[0].length).replace(/^\n+/, '') : content
    frontmatter = { ...readme }
  }
  validateSlugMatch(frontmatter.name, dir)

  const manifestPath = join(dir, 'skill.json')
  let manifest: SkillManifest
  if (await exists(manifestPath)) {
    manifest = JSON.parse(
      await Deno.readTextFile(manifestPath),
    ) as SkillManifest
    if (manifest.slug !== frontmatter.name) {
      throw new Error(
        `Skill name '${frontmatter.name}' must match skill.json` +
          ` slug '${manifest.slug}'.`,
      )
    }
    manifest.description = frontmatter.description
  } else {
    const version = frontmatter.metadata?.version ?? '0.0.1'
    manifest = {
      name: frontmatter.name,
      slug: frontmatter.name,
      version,
      description: frontmatter.description,
    }
  }

  return { frontmatter, manifest, body }
}

export { parseSkillMd, validate }
export type { SkillFrontmatter, SkillManifest, ValidatedSkill }

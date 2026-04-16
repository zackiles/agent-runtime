import { join } from '@std/path'
import { exists } from '@std/fs'
import { validateReadme, validateSlugMatch } from './entity-schema.ts'
import type { Frontmatter } from './entity-schema.ts'

type RuleManifest = {
  name: string
  slug: string
  version: string
  description?: string
  template?: boolean
  globs: string[]
}

type ValidatedRule = {
  frontmatter: Frontmatter
  manifest: RuleManifest
  body: string
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/

async function validate(dir: string): Promise<ValidatedRule> {
  const frontmatter = await validateReadme(dir)
  validateSlugMatch(frontmatter.name, dir)

  const readmePath = join(dir, 'README.md')
  const content = await Deno.readTextFile(readmePath)
  const match = content.match(FRONTMATTER_RE)
  const body = match
    ? content.slice(match[0].length).replace(/^\n+/, '')
    : content

  const manifestPath = join(dir, 'rule.json')
  if (!await exists(manifestPath)) {
    throw new Error(`rule.json not found in ${dir}`)
  }
  const manifest = JSON.parse(
    await Deno.readTextFile(manifestPath),
  ) as RuleManifest

  if (manifest.slug !== frontmatter.name) {
    throw new Error(
      `README name '${frontmatter.name}' must match rule.json` +
        ` slug '${manifest.slug}'.`,
    )
  }

  manifest.description = frontmatter.description

  return { frontmatter, manifest, body }
}

export { validate }
export type { RuleManifest, ValidatedRule }

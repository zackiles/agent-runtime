import { basename, dirname, join } from '@std/path'
import { exists } from '@std/fs'

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/
const SKILL_NAME_PATTERN = /^[a-z](?:[a-z0-9]|-(?!-))*[a-z0-9]$/
const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---/
const MAX_DESCRIPTION_LENGTH = 250
const MAX_SKILL_DESCRIPTION_LENGTH = 1024
const MAX_SKILL_NAME_LENGTH = 64
const MAX_COMPATIBILITY_LENGTH = 500

type Frontmatter = {
  name: string
  description: string
}

function parseFrontmatter(content: string): Frontmatter {
  const match = content.match(FRONTMATTER_PATTERN)
  if (!match) {
    throw new Error(
      'README.md must start with YAML frontmatter (--- delimiters)',
    )
  }

  const block = match[1]
  const name = block.match(/^name:\s*(.+)$/m)?.[1]?.trim()
  const description = block.match(/^description:\s*(.+)$/m)?.[1]?.trim()

  if (!name) {
    throw new Error('README.md frontmatter must include a "name" field')
  }
  if (!description) {
    throw new Error(
      'README.md frontmatter must include a "description" field',
    )
  }

  return { name, description }
}

async function validateReadme(dir: string): Promise<Frontmatter> {
  const readmePath = join(dir, 'README.md')
  if (!await exists(readmePath)) {
    throw new Error(`README.md not found in ${dir}`)
  }
  const readme = await Deno.readTextFile(readmePath)
  const frontmatter = parseFrontmatter(readme)

  if (!NAME_PATTERN.test(frontmatter.name)) {
    throw new Error(
      `Name '${frontmatter.name}' must be lowercase alphanumeric` +
        ' with hyphens, starting with a letter.',
    )
  }

  if (frontmatter.description.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(
      `Description must be ${MAX_DESCRIPTION_LENGTH} characters or` +
        ` fewer (currently ${frontmatter.description.length}).`,
    )
  }

  return frontmatter
}

function validateSlugMatch(
  frontmatterName: string,
  dir: string,
): void {
  const parentName = basename(dirname(dir))
  if (
    parentName !== frontmatterName &&
    basename(dir) !== frontmatterName
  ) {
    throw new Error(
      `README name '${frontmatterName}' must match the folder` +
        ` name '${parentName}'.`,
    )
  }
}

export {
  MAX_COMPATIBILITY_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_SKILL_DESCRIPTION_LENGTH,
  MAX_SKILL_NAME_LENGTH,
  NAME_PATTERN,
  parseFrontmatter,
  SKILL_NAME_PATTERN,
  validateReadme,
  validateSlugMatch,
}
export type { Frontmatter }

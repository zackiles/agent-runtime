import { join } from '@std/path'
import { exists } from '@std/fs'
import { validateReadme, validateSlugMatch } from './entity-schema.ts'
import type { Frontmatter } from './entity-schema.ts'
import type { Subsystem } from './subsystems.ts'

type TriggerDescriptor =
  | { type: 'cron'; name: string; schedule: string; timezone: string }
  | { type: 'pubsub'; name: string; topic: string }

type AgentManifest = {
  name: string
  slug: string
  version: string
  entryPoint: string
  secrets: string[]
  sourceType?: 'function' | 'prompt'
  subsystem?: Subsystem
  description?: string
  uri?: string
  deployedAt?: string
  runtimeAccount?: string
  template?: boolean
  memory?: string
  cpu?: string
  timeout?: string
  triggers: TriggerDescriptor[]
}

type ValidatedAgent = {
  frontmatter: Frontmatter
  manifest: AgentManifest
}

async function validate(dir: string): Promise<ValidatedAgent> {
  const frontmatter = await validateReadme(dir)
  validateSlugMatch(frontmatter.name, dir)

  const manifestPath = join(dir, 'agent.json')
  if (!await exists(manifestPath)) {
    throw new Error(`agent.json not found in ${dir}`)
  }
  const manifest = JSON.parse(
    await Deno.readTextFile(manifestPath),
  ) as AgentManifest

  if (manifest.slug !== frontmatter.name) {
    throw new Error(
      `README name '${frontmatter.name}' must match agent.json` +
        ` slug '${manifest.slug}'.`,
    )
  }

  manifest.description = frontmatter.description

  return { frontmatter, manifest }
}

export { validate }
export type { AgentManifest, TriggerDescriptor, ValidatedAgent }

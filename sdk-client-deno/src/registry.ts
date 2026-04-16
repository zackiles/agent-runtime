import { exists } from '@std/fs'
import { join } from '@std/path'
import { compare, parse } from '@std/semver'
import type {
  AgentManifest,
  TriggerDescriptor as _TriggerDescriptor,
} from './agent-schema.ts'

const AGENT_MANIFEST_FILE = 'agent.json'
const SEMVER_PATTERN = /^\d+\.\d+\.\d+/

type AgentRef = {
  id: string
  version?: string | undefined
}

function parseAgentRef(input: string): AgentRef {
  const atIndex = input.indexOf('@')
  if (atIndex > 0) {
    const id = input.slice(0, atIndex)
    const ver = input.slice(atIndex + 1)
    if (SEMVER_PATTERN.test(ver)) {
      return { id, version: ver }
    }
  }
  return { id: input }
}

async function resolveVersionedDir(
  baseDir: string,
  version?: string,
): Promise<string> {
  if (version) return join(baseDir, version)
  if (!await exists(baseDir)) return baseDir

  try {
    const versions: string[] = []
    for await (const entry of Deno.readDir(baseDir)) {
      if (entry.isDirectory && SEMVER_PATTERN.test(entry.name)) {
        versions.push(entry.name)
      }
    }
    if (versions.length > 0) {
      versions.sort((a, b) => {
        try {
          return compare(parse(a), parse(b))
        } catch {
          return a.localeCompare(b)
        }
      }).reverse()
      return join(baseDir, versions[0])
    }
  } catch {
    // not a directory or can't read it
  }

  return baseDir
}

async function resolveAgentDir(
  registry: string,
  ref: AgentRef,
): Promise<string> {
  return await resolveVersionedDir(
    join(registry, 'agents', ref.id),
    ref.version,
  )
}

function agentDir(registry: string, ref: AgentRef): string {
  if (ref.version) {
    return join(registry, 'agents', ref.id, ref.version)
  }
  return join(registry, 'agents', ref.id)
}

async function readAgent(
  registry: string,
  ref: AgentRef,
): Promise<AgentManifest> {
  const dir = await resolveAgentDir(registry, ref)
  const path = join(dir, AGENT_MANIFEST_FILE)
  if (!await exists(path)) {
    const label = ref.version ? `${ref.id}@${ref.version}` : ref.id
    throw new Error(
      `No agent.json found. Run 'ar agent create ${label}' or` +
        ' create one manually.',
    )
  }
  const raw = await Deno.readTextFile(path)
  return JSON.parse(raw) as AgentManifest
}

async function writeAgent(
  registry: string,
  ref: AgentRef,
  config: AgentManifest,
): Promise<void> {
  const path = join(agentDir(registry, ref), AGENT_MANIFEST_FILE)
  await Deno.writeTextFile(path, JSON.stringify(config, null, 2) + '\n')
}

async function agentDirExists(
  registry: string,
  ref: AgentRef,
): Promise<boolean> {
  const dir = await resolveAgentDir(registry, ref)
  return await exists(dir)
}

function entityDir(
  registry: string,
  type: string,
  slug: string,
  version?: string,
): string {
  if (version) return join(registry, type, slug, version)
  return join(registry, type, slug)
}

async function resolveEntityDir(
  registry: string,
  type: string,
  slug: string,
  version?: string,
): Promise<string> {
  return await resolveVersionedDir(
    join(registry, type, slug),
    version,
  )
}

function toolDir(
  registry: string,
  slug: string,
  version?: string,
): string {
  return entityDir(registry, 'tools', slug, version)
}

async function resolveToolDir(
  registry: string,
  slug: string,
  version?: string,
): Promise<string> {
  return await resolveEntityDir(registry, 'tools', slug, version)
}

function ruleDir(
  registry: string,
  slug: string,
  version?: string,
): string {
  return entityDir(registry, 'rules', slug, version)
}

async function resolveRuleDir(
  registry: string,
  slug: string,
  version?: string,
): Promise<string> {
  return await resolveEntityDir(registry, 'rules', slug, version)
}

function skillDir(
  registry: string,
  slug: string,
  version?: string,
): string {
  return entityDir(registry, 'skills', slug, version)
}

async function resolveSkillDir(
  registry: string,
  slug: string,
  version?: string,
): Promise<string> {
  return await resolveEntityDir(registry, 'skills', slug, version)
}

const ID_PATTERN = /^[a-z][a-z0-9-]*$/

function validateId(id: string, label: string): void {
  if (!ID_PATTERN.test(id)) {
    throw new Error(
      `Invalid ${label} '${id}'. Must be lowercase alphanumeric` +
        ' with hyphens, starting with a letter.',
    )
  }
}

function secretEnvVar(secretName: string, agentId?: string): string {
  let name = secretName
  if (agentId && name.startsWith(`${agentId}--`)) {
    name = name.slice(agentId.length + 2)
  }
  return name.toUpperCase().replace(/-/g, '_')
}

function resolveSecretName(name: string, agentId?: string): string {
  if (agentId) return `${agentId}--${name}`
  return name
}

export {
  AGENT_MANIFEST_FILE,
  agentDir,
  agentDirExists,
  entityDir,
  parseAgentRef,
  readAgent,
  resolveAgentDir,
  resolveEntityDir,
  resolveRuleDir,
  resolveSecretName,
  resolveSkillDir,
  resolveToolDir,
  ruleDir,
  secretEnvVar,
  skillDir,
  toolDir,
  validateId,
  writeAgent,
}

export type { AgentRef }
export type { AgentManifest, TriggerDescriptor } from './agent-schema.ts'

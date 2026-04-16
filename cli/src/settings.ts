import { exists } from '@std/fs'
import { join } from '@std/path'
import { parse as parseJsonc } from '@std/jsonc'
import { configDir, homeDir, load as loadRuntime } from '@ar/client/runtime'
import { isProduction } from '@ar/client/build'

type AuthMethod = 'user' | 'adc'

type AgentDeployMode = 'source' | 'container'

type Settings = {
  project?: string | undefined
  region?: string | undefined
  runtimeAccount?: string | undefined
  workerAccount?: string | undefined
  vpcConnector?: string | undefined
  runtime?: string | undefined
  tenant?: string | undefined
  registry?: string | undefined
  controlPlaneUrl?: string | null | undefined
  lastControlPlaneUrl?: string | undefined
  agentDeployMode?: AgentDeployMode | undefined
  botName?: string | undefined
  botDisplayName?: string | undefined
  auth?: {
    method?: AuthMethod | undefined
  } | undefined
}

type GcpSettings = {
  project: string
  region: string
  runtimeAccount: string
  workerAccount: string
  vpcConnector?: string | undefined
  runtime: string
  controlPlaneUrl: string | null
  agentDeployMode?: AgentDeployMode | undefined
}

const SETTINGS_FILENAME = 'settings.jsonc'
const LOCAL_SETTINGS_FILENAME = 'settings.local.jsonc'

const ENV_MAP: Record<string, string> = {
  AR_PROJECT: 'project',
  AR_REGION: 'region',
  AR_RUNTIME_ACCOUNT: 'runtimeAccount',
  AR_WORKER_ACCOUNT: 'workerAccount',
  AR_VPC_CONNECTOR: 'vpcConnector',
  AR_RUNTIME: 'runtime',
  AR_TENANT: 'tenant',
  AR_REGISTRY: 'registry',
  AR_CONTROL_PLANE_URL: 'controlPlaneUrl',
  AR_AGENT_DEPLOY_MODE: 'agentDeployMode',
  AR_BOT_NAME: 'botName',
  AR_AUTH_METHOD: 'auth.method',
}

const FIELD_MAP: Record<string, string> = {
  'project': 'project',
  'region': 'region',
  'runtime-account': 'runtimeAccount',
  'worker-account': 'workerAccount',
  'vpc-connector': 'vpcConnector',
  'runtime': 'runtime',
  'control-plane-url': 'controlPlaneUrl',
  'agent-deploy-mode': 'agentDeployMode',
}

const FIELD_DEFAULTS: Record<string, string | null> = {
  'runtime': loadRuntime().platform.runtime,
  'control-plane-url': null,
  'agent-deploy-mode': 'container',
}

const VALID_SET_OPTIONS = Object.keys(FIELD_MAP)

function defaultSettingsDir(): string {
  if (isProduction()) return homeDir()
  return configDir()
}

function setNested(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const parts = path.split('.')
  let current = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]
    if (
      current[key] === undefined || current[key] === null ||
      typeof current[key] !== 'object'
    ) {
      current[key] = {}
    }
    current = current[key] as Record<string, unknown>
  }
  current[parts[parts.length - 1]] = value
}

function getNested(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.')
  let current: unknown = obj
  for (const part of parts) {
    if (current === null || current === undefined) return undefined
    if (typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  for (const key of Object.keys(source)) {
    const sv = source[key]
    const tv = target[key]
    if (
      sv && typeof sv === 'object' && !Array.isArray(sv) &&
      tv && typeof tv === 'object' && !Array.isArray(tv)
    ) {
      target[key] = deepMerge(
        tv as Record<string, unknown>,
        sv as Record<string, unknown>,
      )
    } else if (sv !== undefined) {
      target[key] = sv
    }
  }
  return target
}

async function readSettingsFile(
  path: string,
): Promise<Record<string, unknown>> {
  const raw = await Deno.readTextFile(path)
  return (parseJsonc(raw) as Record<string, unknown>) || {}
}

async function findSettingsFile(
  dir: string,
): Promise<string | null> {
  const path = join(dir, SETTINGS_FILENAME)
  if (await exists(path)) return path
  return null
}

function pickSettings(raw: Record<string, unknown>): Settings {
  const result: Record<string, unknown> = {}
  const allowed = [
    'project',
    'region',
    'runtimeAccount',
    'workerAccount',
    'vpcConnector',
    'runtime',
    'tenant',
    'registry',
    'controlPlaneUrl',
    'lastControlPlaneUrl',
    'agentDeployMode',
    'botName',
    'botDisplayName',
    'auth',
  ]
  for (const key of allowed) {
    if (raw[key] !== undefined) result[key] = raw[key]
  }
  if (result.auth && typeof result.auth === 'object') {
    const auth = result.auth as Record<string, unknown>
    result.auth = {}
    if (auth.method === 'user' || auth.method === 'adc') {
      ;(result.auth as Record<string, unknown>).method = auth.method
    }
  }
  return result as Settings
}

function loadEnvSettings(): Settings {
  const result: Record<string, unknown> = {}
  for (const [envKey, settingPath] of Object.entries(ENV_MAP)) {
    const value = Deno.env.get(envKey)
    if (value !== undefined) setNested(result, settingPath, value)
  }
  return pickSettings(result)
}

function loadDefaults(): Settings {
  const rc = loadRuntime()
  return {
    project: rc.platform.project || undefined,
    region: rc.platform.region,
    runtime: rc.platform.runtime,
  }
}

let cached: Settings | null = null

async function load(settingsFlag?: string): Promise<Settings> {
  if (cached) return cached

  let merged: Record<string, unknown> = loadDefaults() as Record<
    string,
    unknown
  >

  const defaultDir = defaultSettingsDir()
  const defaultFile = await findSettingsFile(defaultDir)
  if (defaultFile) {
    try {
      const fileSettings = await readSettingsFile(defaultFile)
      merged = deepMerge(
        merged,
        pickSettings(fileSettings) as Record<string, unknown>,
      )
    } catch { /* ignore unreadable default settings */ }
  }

  if (!isProduction()) {
    const localPath = join(defaultDir, LOCAL_SETTINGS_FILENAME)
    if (await exists(localPath)) {
      try {
        const localSettings = await readSettingsFile(localPath)
        merged = deepMerge(
          merged,
          pickSettings(localSettings) as Record<string, unknown>,
        )
      } catch { /* ignore unreadable local settings */ }
    }
  }

  const envSettings = loadEnvSettings() as Record<string, unknown>
  merged = deepMerge(merged, envSettings)

  if (settingsFlag) {
    try {
      const flagSettings = await readSettingsFile(settingsFlag)
      merged = deepMerge(
        merged,
        pickSettings(flagSettings) as Record<string, unknown>,
      )
    } catch (err) {
      throw new Error(
        `Failed to read settings file '${settingsFlag}': ${
          (err as Error).message
        }`,
      )
    }
  }

  cached = Object.freeze(pickSettings(merged)) as Settings
  return cached
}

function reset(): void {
  cached = null
}

async function save(updates: Partial<Settings>): Promise<void> {
  const dir = defaultSettingsDir()
  const filename = isProduction() ? SETTINGS_FILENAME : LOCAL_SETTINGS_FILENAME
  const path = join(dir, filename)

  let existing: Record<string, unknown> = {}
  if (await exists(path)) {
    try {
      existing = await readSettingsFile(path)
    } catch { /* start fresh */ }
  }

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      existing[key] = value
    }
  }

  if (updates.controlPlaneUrl != null) {
    existing.lastControlPlaneUrl = updates.controlPlaneUrl
  }

  await Deno.mkdir(dir, { recursive: true })
  await Deno.writeTextFile(
    path,
    JSON.stringify(existing, null, 2) + '\n',
  )
  reset()
}

async function loadGcp(settingsFlag?: string): Promise<GcpSettings> {
  const s = await load(settingsFlag)
  return {
    project: s.project || '',
    region: s.region || '',
    runtimeAccount: s.runtimeAccount || '',
    workerAccount: s.workerAccount || '',
    vpcConnector: s.vpcConnector || undefined,
    runtime: s.runtime || loadRuntime().platform.runtime,
    controlPlaneUrl: s.controlPlaneUrl ?? null,
    agentDeployMode: s.agentDeployMode || undefined,
  }
}

async function discoverControlPlaneUrl(): Promise<string | undefined> {
  const settings = await load()
  const saved = settings.lastControlPlaneUrl ??
    settings.controlPlaneUrl ?? undefined
  if (saved) return saved

  const gcp = await loadGcp()
  if (!gcp.project || !gcp.region) return undefined

  const { gcloud: run } = await import('./utils/gcloud.ts')
  const result = await run([
    'run',
    'services',
    'describe',
    loadRuntime().controlPlane.serviceName,
    `--project=${gcp.project}`,
    `--region=${gcp.region}`,
    '--format=value(status.url)',
  ])
  return result.ok && result.stdout ? result.stdout : undefined
}

export {
  defaultSettingsDir,
  discoverControlPlaneUrl,
  FIELD_DEFAULTS,
  FIELD_MAP,
  findSettingsFile,
  getNested,
  load,
  loadGcp,
  readSettingsFile,
  reset,
  save,
  setNested,
  VALID_SET_OPTIONS,
}
export type { AgentDeployMode, AuthMethod, GcpSettings, Settings }

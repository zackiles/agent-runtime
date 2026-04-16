import { parse } from '@std/jsonc'
import { dirname, fromFileUrl, join } from '@std/path'

type ToolRef = {
  slug: string
  version: string
}

type AgentsConfig = {
  deployMode: 'source' | 'container'
  baseImage: string
  artifactRepo: string
}

type RuntimeConfig = {
  version: string
  registry: {
    path: string
  }
  data?: {
    path: string
  }
  agents?: AgentsConfig
  platform: {
    project?: string
    runtime: string
    region: string
    runtimeAccountPattern: string
    workerAccountPattern?: string
    vpcConnector?: string
    compileTarget: string
  }
  controlPlane: {
    serviceName: string
    port: number
    baseImage: string
    dbPath: string
    memory: string
    cpu: number
    timeout: number
    concurrency: number
    minInstances: number
    maxInstances: number
    sessionAffinity: boolean
    startupCpuBoost: boolean
    cpuThrottling: boolean
  }
  bot?: {
    name: string
    displayName?: string
  }
  secrets: Record<string, string>
  runtimeAccountRoles: string[]
  workerAccountRoles?: string[]
  tenants: {
    default: string
    bootstrapped: string[]
  }
  tools: ToolRef[]
  build: {
    defaultVersion: string
    defaultMode: string
    denoVersion: string
  }
}

let cached: RuntimeConfig | null = null
let resolvedDir: string | null = null

function tryRead(path: string): RuntimeConfig | null {
  try {
    const raw = Deno.readTextFileSync(path)
    return parse(raw) as unknown as RuntimeConfig
  } catch {
    return null
  }
}

// IMPORTANT: resolution order matters for different execution contexts:
//   1. AR_RUNTIME_CONFIG env var — explicit override for any context
//   2. Relative to this source file — works for `deno run` from source
//   3. Relative to CWD — works for Docker containers and test runners
//   4. Relative to CWD parent — works when CWD is a package dir (ar-cli/)
//
// For compiled binaries (deno compile), default-settings.jsonc is
// embedded via --include and Deno's virtual FS intercepts reads at
// the original relative path, so candidate (2) resolves from the
// embedded FS.
function load(): RuntimeConfig {
  if (cached) return cached

  const envPath = Deno.env.get('AR_RUNTIME_CONFIG')
  if (envPath) {
    const config = tryRead(envPath)
    if (config) {
      cached = config
      resolvedDir = dirname(envPath)
      return cached
    }
  }

  const candidates = [
    join(
      dirname(fromFileUrl(import.meta.url)),
      '..',
      '..',
      'default-settings.jsonc',
    ),
    join(Deno.cwd(), 'default-settings.jsonc'),
    join(Deno.cwd(), '..', 'default-settings.jsonc'),
  ]

  for (const path of candidates) {
    const config = tryRead(path)
    if (config) {
      cached = config
      resolvedDir = dirname(path)
      return cached
    }
  }

  throw new Error(
    'default-settings.jsonc not found. Set AR_RUNTIME_CONFIG or run from the repo root.',
  )
}

function configDir(): string {
  load()
  if (!resolvedDir) throw new Error('Runtime config not loaded')
  return resolvedDir
}

function registryDir(): string {
  return join(configDir(), load().registry.path)
}

function homeDir(): string {
  return Deno.env.get('AR_HOME') ||
    join(
      Deno.env.get('HOME') || Deno.env.get('USERPROFILE') || '.',
      '.ar',
    )
}

function dataDir(): string {
  const override = Deno.env.get('AR_DB_PATH')
  if (override) return override
  const segment = load().data?.path ?? 'data'
  const mode = Deno.env.get('AR_BUILD_MODE') || load().build.defaultMode
  if (mode === 'production') return join(homeDir(), segment)
  return join(configDir(), segment)
}

export default load
export { configDir, dataDir, homeDir, load, registryDir }
export type { AgentsConfig, RuntimeConfig, ToolRef }

import { exists } from '@std/fs'
import { join } from '@std/path'
import { parse as parseJsonc } from '@std/jsonc'
import { parseArgs } from '@std/cli'
import { configDir, homeDir } from './runtime.ts'
import { isProduction } from './build.ts'

type Mode = 'local' | 'remote' | 'server'

type AuthMethod = 'user' | 'adc'

type ModeInfo = {
  mode: Mode
  controlPlaneUrl?: string | undefined
  production?: boolean | undefined
  tenant?: string | undefined
  authMethod?: AuthMethod | undefined
}

async function detect(
  controlPlaneUrl?: string | null,
): Promise<ModeInfo> {
  if (Deno.env.get('AR_MODE') === 'server') {
    return { mode: 'server' }
  }

  const envUrl = Deno.env.get('AR_CONTROL_PLANE_URL')
  if (envUrl) {
    return { mode: 'remote', controlPlaneUrl: envUrl }
  }

  if (controlPlaneUrl) {
    return { mode: 'remote', controlPlaneUrl }
  }

  type SettingsShape = {
    controlPlaneUrl?: string | null
    auth?: { method?: string }
  }

  let fileAuthMethod: AuthMethod | undefined

  async function readSettings(
    path: string,
  ): Promise<SettingsShape | null> {
    if (!await exists(path)) return null
    try {
      const raw = await Deno.readTextFile(path)
      return (parseJsonc(raw) as SettingsShape) || null
    } catch {
      return null
    }
  }

  const dir = isProduction() ? homeDir() : configDir()
  const base = await readSettings(join(dir, 'settings.jsonc'))
  const local = isProduction()
    ? null
    : await readSettings(join(dir, 'settings.local.jsonc'))

  const cpUrl = local?.controlPlaneUrl || base?.controlPlaneUrl
  if (cpUrl) {
    return { mode: 'remote', controlPlaneUrl: cpUrl }
  }

  const method = local?.auth?.method || base?.auth?.method
  if (method === 'adc' || method === 'user') {
    fileAuthMethod = method
  }

  const envAuth = Deno.env.get('AR_AUTH_METHOD')
  const authMethod: AuthMethod | undefined =
    (envAuth === 'adc' || envAuth === 'user') ? envAuth : fileAuthMethod

  let production = false
  let tenant: string | undefined
  try {
    const args = parseArgs(Deno.args, {
      boolean: ['production'],
      string: ['tenant'],
    })
    production = args.production === true
    tenant = args.tenant as string | undefined
  } catch {
    // non-CLI context
  }
  if (Deno.env.get('AR_MODE_PRODUCTION') === 'true') production = true
  if (Deno.env.get('AR_TENANT')) tenant = Deno.env.get('AR_TENANT')

  return { mode: 'local', production, tenant, authMethod }
}

function label(mode: Mode): string {
  switch (mode) {
    case 'local':
      return '[local]'
    case 'remote':
      return '[remote]'
    case 'server':
      return '[server]'
  }
}

export { detect, label }
export type { AuthMethod, Mode, ModeInfo }

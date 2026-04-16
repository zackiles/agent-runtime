import type { AuthMethod } from './settings.ts'
import { load as loadSettings } from './settings.ts'
import { isInteractive } from './terminal/mod.ts'
import platform, { modeInfo } from '@ar/client/platform'
import { exec, gcloud, NOT_FOUND } from './utils/gcloud.ts'

type AuthSession = {
  method: AuthMethod
  account: string
  getAccessToken(): Promise<string>
  getIdentityToken(audience?: string): Promise<string>
}

async function adcAccount(): Promise<string> {
  try {
    const res = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/' +
        'instance/service-accounts/default/email',
      { headers: { 'Metadata-Flavor': 'Google' } },
    )
    if (res.ok) return await res.text()
  } catch { /* not on GCP compute */ }

  try {
    return await exec([
      'auth',
      'list',
      '--filter=status:ACTIVE',
      '--format=value(account)',
    ])
  } catch {
    return 'adc-service-account'
  }
}

async function userAccount(): Promise<string> {
  return await exec(['config', 'get-value', 'account'])
}

async function createSession(method?: AuthMethod): Promise<AuthSession> {
  const resolved = method || await resolveAuthMethod()

  if (resolved === 'adc') {
    const account = await adcAccount()
    return {
      method: 'adc',
      account,
      getAccessToken: () => platform.getAccessToken(),
      getIdentityToken: (audience?: string) =>
        platform.getIdentityToken(audience),
    }
  }

  const result = await exec(['auth', 'print-identity-token'])
  if (!result) {
    throw new Error(
      "Not authenticated. Run 'gcloud auth login' first.",
    )
  }
  const account = await userAccount()
  return {
    method: 'user',
    account: account || 'unknown',
    getAccessToken: () => exec(['auth', 'print-access-token']),
    getIdentityToken: (audience?: string) => {
      const args = ['auth', 'print-identity-token']
      if (audience) args.push(`--audiences=${audience}`)
      return exec(args)
    },
  }
}

async function resolveAuthMethod(): Promise<AuthMethod> {
  const envMethod = Deno.env.get('AR_AUTH_METHOD')
  if (envMethod === 'adc' || envMethod === 'user') return envMethod
  const settings = await loadSettings()
  if (settings.auth?.method) return settings.auth.method
  return isInteractive() ? 'user' : 'adc'
}

class GcloudNotFoundError extends Error {}

async function checkGcloud(args: string[]): Promise<void> {
  const result = await gcloud(args)
  if (result.stderr === NOT_FOUND) {
    throw new GcloudNotFoundError()
  }
  if (!result.ok) throw new Error(result.stderr)
}

const GCLOUD_INSTALL_MSG = 'gcloud CLI not found. Install it from' +
  ' https://cloud.google.com/sdk/docs/install'

async function requireAuth(): Promise<void> {
  if (modeInfo.mode !== 'local') return

  const method = await resolveAuthMethod()

  if (method === 'adc') {
    try {
      const res = await fetch(
        'http://metadata.google.internal/computeMetadata/v1/' +
          'instance/service-accounts/default/token',
        { headers: { 'Metadata-Flavor': 'Google' } },
      )
      if (res.ok) return
    } catch { /* not on GCP compute, fall through to gcloud ADC */ }

    try {
      await checkGcloud([
        'auth',
        'application-default',
        'print-access-token',
      ])
      return
    } catch (err) {
      if (err instanceof GcloudNotFoundError) {
        throw new Error(GCLOUD_INSTALL_MSG)
      }
      throw new Error(
        'Application Default Credentials are not configured.\n' +
          "Run 'gcloud auth application-default login' to" +
          ' authenticate.',
      )
    }
  }

  try {
    await checkGcloud(['auth', 'print-access-token'])
  } catch (err) {
    if (err instanceof GcloudNotFoundError) {
      throw new Error(GCLOUD_INSTALL_MSG)
    }
    throw new Error(
      'gcloud authentication has expired or is not configured.\n' +
        "Run 'gcloud auth login' to authenticate.",
    )
  }
}

export { createSession, requireAuth }
export type { AuthSession }

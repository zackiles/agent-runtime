import { parseArgs } from '@std/cli'
import { load as loadRuntime } from './runtime.ts'

type Tenant = { id: string; name: string }

const rc = loadRuntime()
const DEVELOPMENT: Tenant = {
  id: rc.tenants.default,
  name: rc.tenants.default,
}
const PRODUCTION: Tenant = {
  id: rc.tenants.bootstrapped.find((t) => t !== rc.tenants.default) ??
    'production',
  name: rc.tenants.bootstrapped.find((t) => t !== rc.tenants.default) ??
    'production',
}

function resolve(tenantName?: string): Tenant {
  if (tenantName) {
    return { id: tenantName, name: tenantName }
  }

  const envTenant = Deno.env.get('AR_TENANT')
  if (envTenant) return { id: envTenant, name: envTenant }

  if (Deno.env.get('AR_MODE_PRODUCTION') === 'true') return PRODUCTION

  try {
    const args = parseArgs(Deno.args, {
      boolean: ['production'],
      string: ['tenant'],
    })
    if (args.tenant) {
      return { id: args.tenant as string, name: args.tenant as string }
    }
    if (args.production) return PRODUCTION
  } catch {
    // non-CLI context
  }
  return DEVELOPMENT
}

export { DEVELOPMENT, PRODUCTION, resolve }
export type { Tenant }

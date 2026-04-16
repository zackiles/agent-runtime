import type { Context, Next } from '@hono/hono'
import type { Env } from '../types.ts'
import { open } from '@ar/client/db'
import { ensure, isAdmin as checkAdmin, setAdmin } from '@ar/client/db/users'
import { load as loadRuntime } from '@ar/client/runtime'

const TENANT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/

async function resolveTenant(
  c: Context<Env>,
  next: Next,
): Promise<Response | void> {
  if (c.get('tenantId')) return next()

  const header = c.req.header('X-Tenant')
  const query = new URL(c.req.url).searchParams.get('tenant')
  const cookie = c.req.raw.headers.get('cookie')
    ?.match(/ar_tenant=([^;]+)/)?.[1]
  const tenantId = header || query || cookie ||
    loadRuntime().tenants.bootstrapped[0]

  if (!tenantId) {
    return c.json({ error: 'Tenant identifier required' }, 400)
  }
  if (!TENANT_PATTERN.test(tenantId)) {
    return c.json({ error: 'Invalid tenant identifier' }, 400)
  }

  c.set('tenantId', tenantId)

  try {
    await open({ id: tenantId, name: tenantId }, 'server')
  } catch {
    return c.json({ error: 'Failed to open tenant database' }, 503)
  }

  const email = c.get('email')
  if (email) {
    const user = ensure(email)
    if (!user.isAdmin && checkAdmin(email)) {
      setAdmin(email, true)
      user.isAdmin = true
    }
    c.set('user', user)
  }

  return next()
}

export { resolveTenant }

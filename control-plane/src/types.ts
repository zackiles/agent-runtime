import type { Context } from '@hono/hono'

type Env = {
  Variables: {
    user: { id: string; name: string; isAdmin: boolean; createdAt: string }
    email: string
    tenantId: string
  }
}

type RequestContext = {
  tenantId: string
  email: string
  isAdmin: boolean
}

function context(c: Context<Env>): RequestContext {
  const tenantId = c.get('tenantId')
  if (!tenantId) throw new Error('Tenant not resolved')
  return {
    tenantId,
    email: c.get('email') || 'system@ar-cli',
    isAdmin: c.get('user')?.isAdmin ?? false,
  }
}

export { context }
export type { Env, RequestContext }

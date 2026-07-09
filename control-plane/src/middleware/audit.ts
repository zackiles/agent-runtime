import type { Context, Next } from '@hono/hono'
import { context } from '../types.ts'
import type { Env } from '../types.ts'
import { log } from '@ar/client/db/audit'

const MUTATION_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE']

const ENTITY_TYPES: Record<string, string> = {
  tools: 'tool',
  skills: 'skill',
  rules: 'rule',
  agents: 'agent',
  demos: 'demo',
  secrets: 'secret',
}

async function auditMiddleware(
  c: Context<Env>,
  next: Next,
): Promise<Response | void> {
  await next()

  if (!MUTATION_METHODS.includes(c.req.method)) return

  const path = new URL(c.req.url).pathname

  // Ingest is excluded to avoid flooding the audit table at telemetry volume;
  // client management is audited explicitly by its handlers with the correct
  // entity type and id.
  if (path === '/telemetry' || path.startsWith('/telemetry/')) return

  const { tenantId, email } = context(c)
  const parts = path.split('/').filter(Boolean)
  const rawType = parts[0] || 'unknown'
  const entityType = ENTITY_TYPES[rawType] ?? rawType
  let entityId = parts[1] || ''

  if (!entityId) {
    try {
      const body = await c.res.clone().json() as Record<string, unknown>
      entityId = String(body.slug ?? body.name ?? body.id ?? 'unknown')
    } catch {
      entityId = 'unknown'
    }
  }

  const action = c.req.method === 'DELETE'
    ? 'deleted'
    : (c.req.method === 'POST' && c.res.status === 201)
    ? 'created'
    : 'updated'

  try {
    log(tenantId, entityType, entityId, action, email, {
      method: c.req.method,
      path,
      status: c.res.status,
    })
  } catch {
    // audit logging is non-fatal
  }
}

export { auditMiddleware }

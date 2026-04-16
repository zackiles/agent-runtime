import { Hono } from '@hono/hono'
import { context } from '../types.ts'
import type { Env } from '../types.ts'
import { query } from '@ar/client/db/audit'

const app = new Hono<Env>()

app.get('/', (c) => {
  const { tenantId, isAdmin } = context(c)
  if (!isAdmin) return c.json({ error: 'Admin only' }, 403)

  const limit = Math.min(parseInt(c.req.query('limit') || '100', 10), 1000)
  const offset = Math.max(parseInt(c.req.query('offset') || '0', 10), 0)

  const filter: Parameters<typeof query>[0] = {
    tenantId,
    limit,
    offset,
  }
  const entityType = c.req.query('entityType')
  const entityId = c.req.query('entityId')
  const action = c.req.query('action')
  const actorId = c.req.query('actorId')
  if (entityType) filter.entityType = entityType
  if (entityId) filter.entityId = entityId
  if (action) filter.action = action
  if (actorId) filter.actorId = actorId

  const entries = query(filter)
  return c.json(entries)
})

export default app

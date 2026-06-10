import { Hono } from '@hono/hono'
import type { Context } from '@hono/hono'
import { context } from '../types.ts'
import type { Env } from '../types.ts'
import {
  create,
  get,
  list,
  remove,
  rotate,
} from '@ar/client/db/telemetry-clients'
import { log } from '@ar/client/db/audit'

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/

const app = new Hono<Env>()

app.use('*', async (c, next) => {
  if (!context(c).isAdmin) return c.json({ error: 'Admin only' }, 403)
  await next()
})

app.get('/', (c) => {
  return c.json(list(context(c).tenantId))
})

app.post('/', async (c) => {
  const { tenantId, email } = context(c)
  const body = await c.req.json().catch(() => ({})) as { name?: string }
  const name = (body.name || '').trim()
  if (!NAME_PATTERN.test(name)) {
    return c.json({ error: 'Invalid client name' }, 400)
  }

  let created
  try {
    created = await create({ tenantId, name, createdBy: email })
  } catch {
    return c.json({ error: 'A client with that name already exists' }, 409)
  }

  log(tenantId, 'telemetry-client', created.client.id, 'created', email, {
    name: created.client.name,
  })
  return c.json(created, 201)
})

app.post('/:id/rotate', async (c) => {
  const { tenantId, email } = context(c)
  const id = c.req.param('id')
  const rotated = await rotate(tenantId, id)
  if (!rotated) return c.json({ error: 'Client not found' }, 404)

  log(tenantId, 'telemetry-client', id, 'updated', email, { rotated: true })
  return c.json(rotated)
})

app.delete('/:id', (c: Context<Env>) => {
  const { tenantId, email } = context(c)
  const id = c.req.param('id') || ''
  if (!get(tenantId, id)) return c.json({ error: 'Client not found' }, 404)

  remove(tenantId, id)
  log(tenantId, 'telemetry-client', id, 'deleted', email)
  return c.json({ ok: true })
})

export default app

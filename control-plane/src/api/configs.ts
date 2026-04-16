import { Hono } from '@hono/hono'
import { context } from '../types.ts'
import type { Env } from '../types.ts'
import {
  createCron,
  createEvent,
  createFile,
  createWebhook,
  listByType,
  remove,
} from '@ar/client/db/configs'

const app = new Hono<Env>()

app.post('/:type', async (c) => {
  const { tenantId } = context(c)
  const type = c.req.param('type') as 'webhook' | 'cron' | 'event' | 'file'
  const body = await c.req.json()

  switch (type) {
    case 'webhook':
      return c.json(createWebhook(tenantId, body), 201)
    case 'cron':
      return c.json(
        createCron(tenantId, body.schedule, body.timezone),
        201,
      )
    case 'event':
      return c.json(
        createEvent(tenantId, body.topic, body.filter),
        201,
      )
    case 'file':
      return c.json(
        createFile(tenantId, body.agentId, body.path),
        201,
      )
    default:
      return c.json({ error: 'Invalid config type' }, 400)
  }
})

app.get('/:type', (c) => {
  const { tenantId } = context(c)
  const type = c.req.param('type') as 'webhook' | 'cron' | 'event' | 'file'
  return c.json(listByType(tenantId, type))
})

app.delete('/:type/:id', (c) => {
  const { tenantId } = context(c)
  const type = c.req.param('type') as 'webhook' | 'cron' | 'event' | 'file'
  remove(type, c.req.param('id'), tenantId)
  return c.json({ message: 'Deleted' })
})

export default app

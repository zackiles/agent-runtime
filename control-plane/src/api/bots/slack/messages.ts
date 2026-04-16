import { Hono } from '@hono/hono'
import { context } from '../../../types.ts'
import type { Env } from '../../../types.ts'
import { listMessages, logMessage } from '@ar/client/db/slack'
import { scheduleSync } from '@ar/client/db'

const app = new Hono<Env>()

app.post('/log', async (c) => {
  const { tenantId, email } = context(c)
  const body = await c.req.json() as {
    slackChannelId: string
    slackThreadTs?: string
    direction: string
    command?: string
    content?: string
    agentId?: string
    metadata?: string
  }
  logMessage({ tenantId, userId: email, ...body })
  scheduleSync(tenantId)
  return c.json({ ok: true })
})

app.get('/list', (c) => {
  const { tenantId, email } = context(c)
  const limit = parseInt(c.req.query('limit') || '50', 10)
  const offset = parseInt(c.req.query('offset') || '0', 10)
  const result = listMessages(tenantId, email, limit, offset)
  return c.json(result)
})

export default app

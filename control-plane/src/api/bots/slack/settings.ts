import { Hono } from '@hono/hono'
import { context } from '../../../types.ts'
import type { Env } from '../../../types.ts'
import { getSettings, setSettings } from '@ar/client/db/slack'
import { scheduleSync } from '@ar/client/db'

const app = new Hono<Env>()

app.get('/get', (c) => {
  const { tenantId, email } = context(c)
  const settings = getSettings(tenantId, email)
  return c.json(settings)
})

app.post('/set', async (c) => {
  const { tenantId, email } = context(c)
  const body = await c.req.json() as {
    defaultAgent?: string
    notifications?: boolean
    streamingMode?: boolean
  }
  setSettings(tenantId, email, body)
  scheduleSync(tenantId)
  return c.json({ ok: true })
})

export default app

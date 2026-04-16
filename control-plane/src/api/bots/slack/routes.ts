import { Hono } from '@hono/hono'
import type { Env } from '../../../types.ts'
import oauth from './oauth.ts'
import identity from './identity.ts'
import agents from './agents.ts'
import messages from './messages.ts'
import settings from './settings.ts'

const app = new Hono<Env>()

app.route('/oauth', oauth)
app.route('/identity', identity)
app.route('/settings', settings)
app.route('/agents', agents)
app.route('/messages', messages)

app.get('/config/get', (c) => {
  const botUrl = Deno.env.get('AR_BOT_SLACK_URL') || ''
  const authGroup = Deno.env.get('AR_BOT_SLACK_AUTH_GROUP') || ''
  return c.json({ botUrl, authGroup })
})

export default app

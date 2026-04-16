import { Hono } from '@hono/hono'
import { context } from '../../../types.ts'
import type { Env } from '../../../types.ts'
import { webAuth } from '../../../middleware/auth.ts'
import { decode as verifyState, encode as signState } from '../../../session.ts'
import { disableIdentity, upsertIdentity } from '@ar/client/db/slack'
import { scheduleSync } from '@ar/client/db'

const app = new Hono<Env>()

app.post('/start', webAuth, async (c) => {
  const { email } = context(c)
  const clientId = Deno.env.get('AR_BOT_SLACK_CLIENT_ID') ||
    Deno.env.get('SLACK_CLIENT_ID')
  if (!clientId) {
    return c.json({ error: 'Slack bot not configured' }, 503)
  }

  const reqUrl = new URL(c.req.url)
  const proto = c.req.header('x-forwarded-proto') ||
    reqUrl.protocol.replace(':', '')
  const base = `${proto}://${reqUrl.host}`
  const redirectUri = `${base}/api/bots/slack/oauth/callback`
  const state = await signState({ email })

  const url = 'https://slack.com/oauth/v2/authorize' +
    `?client_id=${clientId}` +
    '&user_scope=identity.basic,identity.email' +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${encodeURIComponent(state)}`

  return c.json({ url, state })
})

app.get('/callback', webAuth, async (c) => {
  const { tenantId, email } = context(c)
  const code = c.req.query('code')
  const state = c.req.query('state')

  if (!code || !state) {
    return c.text('Missing code or state', 400)
  }

  const payload = await verifyState(state)
  if (!payload || payload.email !== email) {
    return c.text('Invalid state parameter', 403)
  }

  const clientId = Deno.env.get('AR_BOT_SLACK_CLIENT_ID') ||
    Deno.env.get('SLACK_CLIENT_ID')
  const clientSecret = Deno.env.get('AR_BOT_SLACK_CLIENT_SECRET') ||
    Deno.env.get('SLACK_CLIENT_SECRET')
  if (!clientId || !clientSecret) {
    return c.text('Slack OAuth not configured', 500)
  }

  const cbUrl = new URL(c.req.url)
  const cbProto = c.req.header('x-forwarded-proto') ||
    cbUrl.protocol.replace(':', '')
  const cbBase = `${cbProto}://${cbUrl.host}`

  const tokenRes = await fetch(
    'https://slack.com/api/oauth.v2.access',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: `${cbBase}/api/bots/slack/oauth/callback`,
      }),
    },
  )

  const tokens = await tokenRes.json() as {
    ok: boolean
    authed_user?: {
      id: string
      access_token: string
    }
    team?: { id: string }
  }

  if (!tokens.ok || !tokens.authed_user) {
    return c.text('Slack authorization failed', 500)
  }

  let slackUserId = tokens.authed_user.id
  let slackTeamId = tokens.team?.id || ''

  let displayName = ''
  let slackEmail = ''

  if (tokens.authed_user.access_token) {
    const userRes = await fetch(
      'https://slack.com/api/users.identity',
      {
        headers: {
          Authorization: `Bearer ${tokens.authed_user.access_token}`,
        },
      },
    )
    const userData = await userRes.json() as {
      ok: boolean
      user?: { id: string; name?: string; email?: string }
      team?: { id: string; name?: string }
    }
    if (userData.ok) {
      if (userData.user?.id) slackUserId = userData.user.id
      if (userData.team?.id) slackTeamId = userData.team.id
      displayName = userData.user?.name || ''
      slackEmail = userData.user?.email || ''
    }
  }

  const sub = JSON.stringify({
    email: slackEmail || email,
    displayName,
  })

  upsertIdentity({
    tenantId,
    userId: email,
    workspaceSub: sub,
    slackUserId,
    slackTeamId,
  })
  scheduleSync(tenantId)

  return c.redirect('/web/me')
})

app.post('/revoke', webAuth, (c) => {
  const { tenantId, email } = context(c)
  disableIdentity(tenantId, email)
  scheduleSync(tenantId)
  return c.json({ ok: true })
})

export default app

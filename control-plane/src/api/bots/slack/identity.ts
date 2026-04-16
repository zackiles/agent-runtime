import { Hono } from '@hono/hono'
import { context } from '../../../types.ts'
import type { Env } from '../../../types.ts'
import { getIdentity } from '@ar/client/db/slack'

const app = new Hono<Env>()

app.post('/resolve', (c) => {
  const { tenantId, email } = context(c)
  if (!email) {
    return c.json({ error: 'Missing email' }, 400)
  }
  const identity = getIdentity(tenantId, email)
  if (!identity) {
    return c.json({ error: 'Identity not found' }, 404)
  }

  let displayName = ''
  let slackEmail = ''
  try {
    const sub = JSON.parse(identity.workspaceSub)
    displayName = sub.displayName || ''
    slackEmail = sub.email || ''
  } catch {
    // legacy format: workspace_sub is just an email string
    slackEmail = identity.workspaceSub
  }

  return c.json({
    email: identity.userId,
    slackUserId: identity.slackUserId,
    slackTeamId: identity.slackTeamId,
    displayName,
    slackEmail,
    enabled: identity.enabled,
  })
})

app.post('/verify', async (c) => {
  const { tenantId, email } = context(c)
  if (!email) {
    return c.json({ error: 'Missing email' }, 400)
  }

  const identity = getIdentity(tenantId, email)
  if (!identity?.enabled) {
    return c.json({ authorized: false, reason: 'not_enrolled' })
  }

  const groupEmail = Deno.env.get('AR_BOT_SLACK_AUTH_GROUP')
  if (!groupEmail) {
    return c.json({ authorized: true })
  }

  try {
    const tokenRes = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/' +
        'instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' } },
    )
    if (!tokenRes.ok) {
      return c.json({
        authorized: false,
        reason: 'group_check_unavailable',
      })
    }
    const { access_token } = await tokenRes.json() as {
      access_token: string
    }

    const groupLookup = await fetch(
      'https://cloudidentity.googleapis.com/v1/groups:lookup' +
        `?groupKey.id=${encodeURIComponent(groupEmail)}`,
      { headers: { Authorization: `Bearer ${access_token}` } },
    )
    if (!groupLookup.ok) {
      return c.json({
        authorized: false,
        reason: 'group_not_found',
      })
    }
    const groupData = await groupLookup.json() as {
      name?: string
    }
    if (!groupData.name) {
      return c.json({
        authorized: false,
        reason: 'group_not_found',
      })
    }

    const memberCheck = await fetch(
      `https://cloudidentity.googleapis.com/v1/${groupData.name}` +
        `/memberships:lookup?memberKey.id=${encodeURIComponent(email)}`,
      { headers: { Authorization: `Bearer ${access_token}` } },
    )
    if (memberCheck.ok) {
      return c.json({ authorized: true })
    }
    return c.json({
      authorized: false,
      reason: 'not_in_group',
    })
  } catch {
    return c.json({
      authorized: false,
      reason: 'group_check_failed',
    })
  }
})

export default app

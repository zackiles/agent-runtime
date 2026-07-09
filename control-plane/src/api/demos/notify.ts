import { getIdentity } from '@ar/client/db/slack'
import logger from '@ar/client/utils/logger'

// Best-effort DM to a newly-granted member. Non-blocking: if the member is not
// enrolled in the Slack bot or the DM fails, the share still succeeds.
async function notifyShare(opts: {
  tenantId: string
  member: string
  grantedBy: string
  ownerId: string
  slug: string
  role: string
}): Promise<void> {
  const token = Deno.env.get('SLACK_BOT_TOKEN')
  if (!token) return

  let identity
  try {
    identity = getIdentity(opts.tenantId, opts.member)
  } catch {
    return
  }
  if (!identity?.enabled) return

  const cpBase = (Deno.env.get('AR_AUDIENCE') ||
    Deno.env.get('AR_CONTROL_PLANE_URL') || '').replace(/\/+$/, '')
  const open = cpBase
    ? `\nOpen it: ${cpBase}/web/d/${opts.slug}?owner=${
      encodeURIComponent(opts.ownerId)
    }`
    : ''
  const text =
    `${opts.grantedBy} shared the demo *${opts.slug}* with you as *${opts.role}*.` +
    open

  try {
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel: identity.slackUserId, text }),
    })
  } catch (err) {
    logger.warn('Share DM notification failed', { error: String(err) })
  }
}

export { notifyShare }

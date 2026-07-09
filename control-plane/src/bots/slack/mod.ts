import bolt from 'npm:@slack/bolt@4'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { resolveEmail } from './auth.ts'
import { botName } from './utils.ts'
import { dispatch, parseCommand, routeCommand } from './dispatch.ts'
import { register as registerMention } from './events/mention.ts'
import { register as registerMessage } from './events/message.ts'
import { register as registerActions } from './actions/handlers.ts'

const { App } = bolt

function verifySlackRequest(
  signingSecret: string,
  timestamp: string,
  body: string,
  signature: string,
): boolean {
  const fiveMinutes = 5 * 60
  const now = Math.floor(Date.now() / 1000)
  const ts = parseInt(timestamp, 10)
  if (isNaN(ts) || Math.abs(now - ts) > fiveMinutes) {
    return false
  }

  const basestring = `v0:${timestamp}:${body}`
  const hmac = createHmac('sha256', signingSecret)
    .update(basestring)
    .digest('hex')
  const computed = `v0=${hmac}`

  try {
    return timingSafeEqual(
      Buffer.from(computed),
      Buffer.from(signature),
    )
  } catch {
    return false
  }
}

// deno-lint-ignore no-explicit-any
let boltApp: any = null

function initBot(): void {
  const signingSecret = Deno.env.get('SLACK_SIGNING_SECRET') || ''
  const token = Deno.env.get('SLACK_BOT_TOKEN') || ''

  if (!token || !signingSecret) return

  const receiver = {
    init: () => {},
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
  }

  const app = new App({
    token,
    signingSecret,
    receiver,
    processBeforeResponse: true,
  })

  registerMention(app)
  registerMessage(app)
  registerActions(app)

  app.command(`/${botName()}`, async ({ command, ack, client }) => {
    await ack()

    const channel = command.channel_id
    const slackUserId = command.user_id
    const text = command.text || ''

    const email = await resolveEmail(client, slackUserId)
    if (!email) {
      await client.chat.postEphemeral({
        channel,
        user: slackUserId,
        text: ':exclamation: Could not resolve your email. ' +
          'Ensure the bot has `users:read.email` scope.',
      })
      return
    }

    const { command: cmd, args } = parseCommand(text)
    try {
      await dispatch(
        cmd || 'help',
        args,
        client,
        channel,
        email,
        slackUserId,
      )
    } catch (err) {
      console.error('Slash command error:', err)
      await client.chat.postEphemeral({
        channel,
        user: slackUserId,
        text: `:exclamation: ${
          err instanceof Error ? err.message : 'An error occurred'
        }`,
      })
    }
  })

  boltApp = app
  console.log('Slack bot initialized')
}

function parseBody(
  raw: string,
  contentType: string,
): Record<string, unknown> {
  if (contentType.includes('application/json')) {
    return JSON.parse(raw)
  }
  const params = new URLSearchParams(raw)
  const obj: Record<string, unknown> = {}
  for (const [k, v] of params) {
    obj[k] = v
  }
  if (obj.payload) {
    try {
      return JSON.parse(obj.payload as string)
    } catch { /* not JSON */ }
  }
  return obj
}

async function handleSlackEvent(req: Request): Promise<Response> {
  const signingSecret = Deno.env.get('SLACK_SIGNING_SECRET') || ''
  const body = await req.text()
  const timestamp = req.headers.get('x-slack-request-timestamp') || ''
  const signature = req.headers.get('x-slack-signature') || ''

  if (
    !verifySlackRequest(signingSecret, timestamp, body, signature)
  ) {
    return new Response('Invalid signature', { status: 401 })
  }

  const contentType = req.headers.get('content-type') || ''
  const parsed = parseBody(body, contentType)

  if (parsed.type === 'url_verification') {
    return new Response(
      JSON.stringify({ challenge: parsed.challenge }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }

  if (!boltApp) {
    return new Response('Bot not initialized', { status: 503 })
  }

  boltApp.processEvent({
    body: parsed,
    ack: (response: unknown) => {
      void response
      return Promise.resolve()
    },
    retryNum: req.headers.get('x-slack-retry-num')
      ? parseInt(req.headers.get('x-slack-retry-num')!, 10)
      : undefined,
    retryReason: req.headers.get('x-slack-retry-reason') || undefined,
  }).catch((err: unknown) => {
    console.error('Bolt processEvent error:', err)
  })

  return new Response('', { status: 200 })
}

export { handleSlackEvent, initBot, routeCommand }

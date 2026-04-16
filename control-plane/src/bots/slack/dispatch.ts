import type { WebClient } from 'npm:@slack/web-api@7'
import { normalizeInput, threadOpts } from './utils.ts'
import { resolveEmail } from './auth.ts'
import { load as loadRuntime } from '@ar/client/runtime'
import { open } from '@ar/client/db'
import { ensure } from '@ar/client/db/users'
import { getIdentity, getSettings, logMessage } from '@ar/client/db/slack'
import { scheduleSync } from '@ar/client/db'
import { buildResponse } from './views/component.ts'
import * as help from './commands/help.ts'
import * as settings from './commands/settings.ts'
import * as run from './commands/run.ts'
import * as createAgent from './commands/create-agent.ts'
import * as list from './commands/list.ts'
import * as status from './commands/status.ts'
import * as demo from './commands/demo.ts'
import * as demos from './commands/demos.ts'

type SlackFile = {
  id: string
  name: string
  mimetype: string
  size: number
  url_private: string
  url_private_download: string
}

const COMMANDS: Record<string, string> = {
  help: 'help',
  list: 'list',
  status: 'status',
  settings: 'settings',
  run: 'run',
  'create-agent': 'create-agent',
  demo: 'demo',
  demos: 'demos',
}

function parseCommand(
  text: string,
): { command: string | null; args: string } {
  const normalized = normalizeInput(text)
  const first = normalized.split(/\s+/)[0].toLowerCase()
  if (COMMANDS[first]) {
    return {
      command: COMMANDS[first],
      args: normalized.slice(first.length).trim(),
    }
  }
  return { command: null, args: text.trim() }
}

function defaultTenantId(): string {
  return Deno.env.get('AR_TENANT') ||
    loadRuntime().tenants.bootstrapped[0] || ''
}

async function resolveTenant(email: string): Promise<string> {
  const fallback = defaultTenantId()
  if (!fallback) throw new Error('No tenant configured (set AR_TENANT)')
  await open({ id: fallback, name: fallback }, 'server')
  ensure(email)
  const s = getSettings(fallback, email)
  const tenant = s.tenant || fallback
  if (tenant !== fallback) {
    await open({ id: tenant, name: tenant }, 'server')
    ensure(email)
  }
  return tenant
}

function cpUrl(): string {
  return Deno.env.get('AR_AUDIENCE') ||
    Deno.env.get('AR_CONTROL_PLANE_URL') || ''
}

async function postSetupGuide(
  client: WebClient,
  channel: string,
  tenant: string,
  threadTs: string,
): Promise<void> {
  const base = cpUrl()
  const meLink = base ? `<${base}/web/me|Enable Slack Bot>` : '`/web/me`'
  await client.chat.postMessage({
    channel,
    ...threadOpts(threadTs),
    blocks: buildResponse({
      title: 'Setup Required',
      body: [
        `You haven't enabled the Slack bot for *${tenant}*.`,
        '',
        `1. Visit the dashboard and click ${meLink}`,
        `2. Click *Enable Slack Bot* for the \`${tenant}\` tenant`,
        '3. Come back here and try again',
        '',
        '_To switch tenants, type_ `settings`',
      ].join('\n'),
    }),
    text: `Slack bot not enabled for ${tenant}`,
  })
}

const NO_IDENTITY_REQUIRED = new Set(['help', 'settings'])

async function dispatch(
  cmd: string,
  args: string,
  client: WebClient,
  channel: string,
  email: string,
  slackUserId: string,
  threadTs?: string,
  files?: SlackFile[],
): Promise<void> {
  const tenant = await resolveTenant(email)

  if (!NO_IDENTITY_REQUIRED.has(cmd)) {
    const identity = getIdentity(tenant, email)
    if (!identity?.enabled) {
      await postSetupGuide(client, channel, tenant, threadTs || '')
      return
    }
  }

  switch (cmd) {
    case 'help':
      await help.handle(client, channel, threadTs)
      break
    case 'settings':
      await settings.handle(
        client,
        channel,
        email,
        slackUserId,
        tenant,
        threadTs,
      )
      break
    case 'run':
      await run.handle(
        client,
        channel,
        email,
        slackUserId,
        tenant,
        args,
        threadTs,
      )
      break
    case 'create-agent':
      await createAgent.handle(
        client,
        channel,
        email,
        slackUserId,
        tenant,
        args,
        threadTs,
      )
      break
    case 'list':
      await list.handle(
        client,
        channel,
        email,
        slackUserId,
        tenant,
        threadTs,
      )
      break
    case 'status':
      await status.handle(
        client,
        channel,
        email,
        slackUserId,
        tenant,
        threadTs,
      )
      break
    case 'demo':
      await demo.handle(
        client,
        channel,
        email,
        slackUserId,
        tenant,
        args,
        threadTs,
        files,
      )
      break
    case 'demos':
      await demos.handle(
        client,
        channel,
        email,
        slackUserId,
        tenant,
        threadTs,
      )
      break
    default:
      await run.handle(
        client,
        channel,
        email,
        slackUserId,
        tenant,
        `${cmd} ${args}`.trim(),
        threadTs,
      )
      break
  }
}

async function routeCommand(
  text: string,
  channel: string,
  slackUserId: string,
  threadTs: string,
  client: WebClient,
  files?: SlackFile[],
): Promise<void> {
  const email = await resolveEmail(client, slackUserId)
  if (!email) {
    await client.chat.postMessage({
      channel,
      ...threadOpts(threadTs),
      text: ':exclamation: Could not resolve your email. ' +
        'Ensure the bot has `users:read.email` scope.',
    })
    return
  }

  const { command: cmd, args } = parseCommand(text)
  const resolvedCmd = cmd || 'run'

  let tenant: string | undefined
  try {
    tenant = await resolveTenant(email)
  } catch { /* tenant resolution may fail for unconfigured users */ }

  if (tenant) {
    try {
      logMessage({
        tenantId: tenant,
        userId: email,
        slackChannelId: channel,
        ...(threadTs ? { slackThreadTs: threadTs } : {}),
        direction: 'inbound',
        command: resolvedCmd,
        content: text.trim(),
      })
    } catch { /* non-fatal */ }
  }

  try {
    await dispatch(
      resolvedCmd,
      cmd ? args : text.trim(),
      client,
      channel,
      email,
      slackUserId,
      threadTs,
      files,
    )

    await client.reactions.add({
      channel,
      timestamp: threadTs,
      name: 'white_check_mark',
    }).catch(() => {})

    if (tenant) {
      try {
        await open({ id: tenant, name: tenant }, 'server')
        logMessage({
          tenantId: tenant,
          userId: email,
          slackChannelId: channel,
          direction: 'outbound',
          command: resolvedCmd,
          content: `${resolvedCmd} completed`,
        })
        scheduleSync(tenant)
      } catch { /* non-fatal */ }
    }
  } catch (err) {
    console.error('Command error:', err)
    await client.reactions.add({
      channel,
      timestamp: threadTs,
      name: 'exclamation',
    }).catch(() => {})
    await client.chat.postMessage({
      channel,
      ...threadOpts(threadTs),
      text: `:exclamation: ${
        err instanceof Error ? err.message : 'An error occurred'
      }`,
    })
  }
}

export { dispatch, parseCommand, resolveTenant, routeCommand }
export type { SlackFile }

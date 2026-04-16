import type { WebClient } from 'npm:@slack/web-api@7'
import type { Action } from 'npm:@slack/types@2'
import { getIdentity, getSettings, setSettings } from '@ar/client/db/slack'
import { load as loadRuntime } from '@ar/client/runtime'
import { open } from '@ar/client/db'
import { ensure } from '@ar/client/db/users'
import { threadOpts } from '../utils.ts'
import { buildResponse } from '../views/component.ts'

function defaultTenantId(): string {
  return Deno.env.get('AR_TENANT') ||
    loadRuntime().tenants.bootstrapped[0] || ''
}

async function handle(
  client: WebClient,
  channel: string,
  email: string,
  _slackUserId: string,
  _tenantId: string,
  threadTs?: string,
): Promise<void> {
  const fallback = defaultTenantId()
  await open({ id: fallback, name: fallback }, 'server')
  ensure(email)
  const settings = getSettings(fallback, email)
  const tenants = loadRuntime().tenants.bootstrapped
  const currentTenant = settings.tenant || fallback

  await open({ id: currentTenant, name: currentTenant }, 'server')
  ensure(email)
  const identity = getIdentity(currentTenant, email)
  const enabled = !!identity?.enabled
  const cpUrl = Deno.env.get('AR_AUDIENCE') || ''
  const enableLink = cpUrl
    ? ` (<${cpUrl}/web/switch-tenant?tenant=${currentTenant}&redirect=/web/me|enable>)`
    : ''

  const lines = [
    `:house: *Active Tenant:* \`${currentTenant}\``,
    `*Slack Bot:* ${
      enabled ? ':white_check_mark: Enabled' : `:x: Not enabled${enableLink}`
    }`,
    '',
    `*Default Agent:* ${settings.defaultAgent || '_not set_'}`,
    `*Notifications:* ${settings.notifications !== false ? 'On' : 'Off'}`,
    `*Streaming Mode:* ${settings.streamingMode !== false ? 'On' : 'Off'}`,
  ]

  if (tenants.length > 1) {
    lines.push(
      '',
      '_Switch tenants using the buttons below:_',
    )
  }

  const actions: Action[] = []
  for (const t of tenants) {
    actions.push({
      type: 'button',
      text: {
        type: 'plain_text',
        text: t === currentTenant ? `${t} (active)` : t,
      },
      action_id: `set_tenant__${t}`,
      value: t,
      ...(t === currentTenant ? { style: 'primary' } : {}),
    } as unknown as Action)
  }

  await client.chat.postMessage({
    channel,
    ...threadOpts(threadTs),
    blocks: buildResponse({
      title: 'Settings',
      body: lines.join('\n'),
      ...(actions.length > 1 ? { actions } : {}),
    }),
    text: `Settings — tenant: ${currentTenant}`,
  })
}

async function switchTenant(
  email: string,
  newTenant: string,
): Promise<void> {
  const fallback = defaultTenantId()
  if (!fallback) return
  await open({ id: fallback, name: fallback }, 'server')
  ensure(email)
  const current = getSettings(fallback, email)
  setSettings(fallback, email, { ...current, tenant: newTenant })
}

export { handle, switchTenant }

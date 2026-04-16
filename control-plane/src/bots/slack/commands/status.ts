import type { WebClient } from 'npm:@slack/web-api@7'
import { getSettings } from '@ar/client/db/slack'
import { listByTenant } from '@ar/client/db/agents'
import { threadOpts } from '../utils.ts'
import { buildResponse } from '../views/component.ts'

async function handle(
  client: WebClient,
  channel: string,
  email: string,
  _slackUserId: string,
  tenantId: string,
  threadTs?: string,
): Promise<void> {
  const settings = getSettings(tenantId, email)
  const agents = listByTenant(tenantId)
  const visible = agents.filter(
    (a) => a.visibility === 'public' || a.createdBy === email,
  )

  await client.chat.postMessage({
    channel,
    ...threadOpts(threadTs),
    blocks: buildResponse({
      title: 'Status',
      body: [
        `:house: *Tenant:* \`${tenantId}\``,
        `:white_check_mark: *Enrolled:* Yes`,
        `*Email:* ${email}`,
        `*Default Agent:* ${settings.defaultAgent || '_not set_'}`,
        `*Accessible Agents:* ${visible.length}`,
        `*Bot Version:* ${Deno.env.get('AR_VERSION') || 'dev'}`,
        '',
        '_Type_ `settings` _to switch tenants or configure preferences._',
      ].join('\n'),
    }),
    text: 'Bot Status',
  })
}

export { handle }

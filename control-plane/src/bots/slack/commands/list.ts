import type { WebClient } from 'npm:@slack/web-api@7'
import { listByTenant } from '@ar/client/db/agents'
import { slash, threadOpts } from '../utils.ts'
import { buildResponse } from '../views/component.ts'

async function handle(
  client: WebClient,
  channel: string,
  email: string,
  _slackUserId: string,
  tenantId: string,
  threadTs?: string,
): Promise<void> {
  const all = listByTenant(tenantId)
  const agents = all.filter(
    (a) => a.visibility === 'public' || a.createdBy === email,
  )

  if (agents.length === 0) {
    await client.chat.postMessage({
      channel,
      ...threadOpts(threadTs),
      text: `No agents found. Create one with \`${slash('create-agent')}\`.`,
    })
    return
  }

  const lines = agents.map(
    (a) => `• *${a.name}* (\`${a.slug}@${a.version}\`) — ${a.visibility}`,
  )

  await client.chat.postMessage({
    channel,
    ...threadOpts(threadTs),
    blocks: buildResponse({
      title: 'Agents',
      body: lines.join('\n'),
    }),
    text: `${agents.length} agent(s) available`,
  })
}

export { handle }

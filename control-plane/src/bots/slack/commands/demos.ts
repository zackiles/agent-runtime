import type { WebClient } from 'npm:@slack/web-api@7'
import type { KnownBlock } from 'npm:@slack/types@2'
import { listDemos } from '@ar/client/operations/demos'
import { gcpConfig } from '../../../api/demos/deploy.ts'
import { slash, threadOpts } from '../utils.ts'
import { buildResponse } from '../views/component.ts'
import { statusIcon } from './demo.ts'

async function handle(
  client: WebClient,
  channel: string,
  email: string,
  _slackUserId: string,
  tenantId: string,
  threadTs?: string,
): Promise<void> {
  const { project } = gcpConfig()
  const all = await listDemos(project, tenantId, email)

  if (all.length === 0) {
    await client.chat.postMessage({
      channel,
      ...threadOpts(threadTs),
      text: `No demos yet. Create one with \`${slash('demo {prompt}')}\`.`,
    })
    return
  }

  const sections: KnownBlock[] = []
  for (const d of all) {
    const icon = statusIcon(d.status)
    const vis = d.visibility || 'private'
    const status = d.status || 'created'
    const lines = [`${icon} *${d.name}* (${status}, ${vis})`]
    if (d.url && d.status === 'running') lines.push(`<${d.url}>`)
    if (d.summary) lines.push(`_${d.summary}_`)

    sections.push({
      type: 'section',
      text: { type: 'mrkdwn', text: lines.join('\n') },
      accessory: d.status === 'running'
        ? {
          type: 'button',
          text: { type: 'plain_text', text: 'Stop' },
          action_id: 'demo_stop',
          value: JSON.stringify({ name: d.name }),
        }
        : {
          type: 'button',
          text: { type: 'plain_text', text: 'Deploy' },
          action_id: 'demo_deploy',
          style: 'primary',
          value: JSON.stringify({ name: d.name }),
        },
    } as unknown as KnownBlock)
  }

  const blocks = buildResponse({ title: 'Your Demos', body: sections })

  await client.chat.postMessage({
    channel,
    ...threadOpts(threadTs),
    blocks,
    text: `${all.length} demo(s)`,
  })
}

export { handle }

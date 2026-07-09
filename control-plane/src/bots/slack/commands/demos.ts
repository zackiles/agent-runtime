import type { WebClient } from 'npm:@slack/web-api@7'
import type { KnownBlock } from 'npm:@slack/types@2'
import { listDemos, loadMeta } from '@ar/client/operations/demos'
import type { DemoMeta } from '@ar/client/operations/demos'
import * as demoShares from '@ar/client/db/demo-shares'
import { gcpConfig } from '../../../api/demos/deploy.ts'
import { slash, threadOpts } from '../utils.ts'
import { buildResponse } from '../views/component.ts'
import { statusIcon } from './demo.ts'

type Entry = { meta: DemoMeta; role: string; ownerId: string }

async function handle(
  client: WebClient,
  channel: string,
  email: string,
  _slackUserId: string,
  tenantId: string,
  threadTs?: string,
): Promise<void> {
  const { project } = gcpConfig()
  const owned = await listDemos(project, tenantId, email)
  const all: Entry[] = owned.map((m) => ({
    meta: m,
    role: 'owner',
    ownerId: email,
  }))
  const seen = new Set(owned.map((m) => `${email}:${m.name}`))
  for (const s of demoShares.forMember(tenantId, email)) {
    const key = `${s.ownerId}:${s.slug}`
    if (seen.has(key)) continue
    const meta = await loadMeta(project, tenantId, s.ownerId, s.slug)
    if (!meta) continue
    seen.add(key)
    all.push({ meta, role: s.role, ownerId: s.ownerId })
  }

  if (all.length === 0) {
    await client.chat.postMessage({
      channel,
      ...threadOpts(threadTs),
      text: `No demos yet. Create one with \`${slash('demo {prompt}')}\`.`,
    })
    return
  }

  const sections: KnownBlock[] = []
  for (const { meta: d, role } of all) {
    const icon = statusIcon(d.status)
    const vis = d.visibility || 'private'
    const status = d.status || 'created'
    const suffix = role === 'owner' ? '' : ` — shared: ${role}`
    const lines = [`${icon} *${d.name}* (${status}, ${vis})${suffix}`]
    if (d.url && d.status === 'running') lines.push(`<${d.url}>`)
    if (d.summary) lines.push(`_${d.summary}_`)

    const section: Record<string, unknown> = {
      type: 'section',
      text: { type: 'mrkdwn', text: lines.join('\n') },
    }
    // Deploy/stop buttons act under the owner's scope, which the bot's action
    // handlers do not yet resolve; only offer them on demos the caller owns.
    if (role === 'owner') {
      section.accessory = d.status === 'running'
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
        }
    }
    sections.push(section as unknown as KnownBlock)
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

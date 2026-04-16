import type { WebClient } from 'npm:@slack/web-api@7'
import { create as createAgent } from '@ar/client/db/agents'
import { createAgentRef } from '@ar/client/db/slack'
import { scheduleSync } from '@ar/client/db'
import { slash, threadOpts } from '../utils.ts'
import { DEFAULT_SUBSYSTEM } from '@ar/client/subsystems'
import { buildResponse } from '../views/component.ts'

async function handle(
  client: WebClient,
  channel: string,
  _email: string,
  _slackUserId: string,
  _tenantId: string,
  prompt: string,
  threadTs?: string,
): Promise<void> {
  if (!prompt.trim()) {
    await client.chat.postMessage({
      channel,
      ...threadOpts(threadTs),
      text: `Usage: \`${slash('create-agent {description}')}\``,
    })
    return
  }

  const name = prompt
    .split(/\s+/)
    .slice(0, 3)
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')

  const blocks = buildResponse({
    title: 'Create Agent',
    summary: `Creating agent from: _${prompt}_`,
    body: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            `*Name:* \`${name}\`\n*Version:* \`0.0.1\`\n*Subsystem:* ${DEFAULT_SUBSYSTEM}`,
        },
      } as unknown as import('npm:@slack/types@2').KnownBlock,
    ],
    actions: [
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Create' },
        action_id: 'create_agent_submit',
        style: 'primary',
        value: JSON.stringify({ prompt, name }),
      } as unknown as import('npm:@slack/types@2').Action,
    ],
  })

  await client.chat.postMessage({
    channel,
    ...threadOpts(threadTs),
    blocks,
    text: 'Create Agent',
    metadata: {
      event_type: 'create_agent',
      event_payload: { prompt },
    },
  })
}

async function submit(
  client: WebClient,
  channel: string,
  email: string,
  _slackUserId: string,
  tenantId: string,
  name: string,
  prompt: string,
  version: string,
  threadTs?: string,
): Promise<void> {
  const slug = name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

  try {
    const agent = createAgent({
      tenantId,
      name,
      slug,
      version: version || '0.0.1',
      subsystem: DEFAULT_SUBSYSTEM,
      visibility: 'private',
      createdBy: email,
      sourceType: 'prompt',
      prompt,
    })

    createAgentRef({
      tenantId,
      userId: email,
      agentId: agent.id,
      cleanupUnused: true,
    })
    scheduleSync(tenantId)

    await client.chat.postMessage({
      channel,
      ...threadOpts(threadTs),
      blocks: buildResponse({
        title: 'Agent Created',
        body: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: [
                `*Name:* ${agent.name}`,
                `*Slug:* ${agent.slug}`,
                '*Visibility:* private',
              ].join('\n'),
            },
          },
        ],
      }),
      text: `Agent "${agent.name}" created`,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    await client.chat.postMessage({
      channel,
      ...threadOpts(threadTs),
      text: `:exclamation: Failed to create agent: ${msg}`,
    })
  }
}

export { handle, submit }

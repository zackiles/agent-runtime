import type { WebClient } from 'npm:@slack/web-api@7'
import { getSettings } from '@ar/client/db/slack'
import { get as getAgent } from '@ar/client/db/agents'
import platform from '@ar/client/platform'
import { slash, threadOpts } from '../utils.ts'
import { buildResponse } from '../views/component.ts'

async function handle(
  client: WebClient,
  channel: string,
  email: string,
  _slackUserId: string,
  tenantId: string,
  text: string,
  threadTs?: string,
): Promise<void> {
  const parts = text.split(/\s+/)
  let agentId: string | undefined
  let input: string

  if (parts.length > 1) {
    agentId = parts[0]
    input = parts.slice(1).join(' ')
  } else {
    input = text
  }

  if (!agentId) {
    const settings = getSettings(tenantId, email)
    agentId = settings.defaultAgent
  }

  if (!agentId) {
    await client.chat.postMessage({
      channel,
      ...threadOpts(threadTs),
      text: 'No agent specified and no default agent configured. ' +
        `Use \`${slash('run {agent} {input}')}\` or set a default ` +
        `with \`${slash('settings')}\`.`,
    })
    return
  }

  const agent = getAgent(agentId, tenantId)
  if (!agent) {
    await client.chat.postMessage({
      channel,
      ...threadOpts(threadTs),
      text: `:exclamation: Agent \`${agentId}\` not found.`,
    })
    return
  }

  const statusMsg = await client.chat.postMessage({
    channel,
    ...threadOpts(threadTs),
    blocks: buildResponse({
      title: `Running: ${agent.slug}`,
      status: ':hourglass_flowing_sand: Thinking...',
    }),
    text: `Running ${agent.slug}...`,
  })

  try {
    const project = Deno.env.get('GCP_PROJECT') || ''
    const region = Deno.env.get('GCP_REGION') || ''

    const uri = await platform.functionDescribeUri(
      agent.slug,
      region,
      project,
    )

    const token = await platform.getIdentityToken(uri)
    const agentRes = await fetch(uri, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input,
        tenant: tenantId,
        user: email,
      }),
    })

    let result: string
    try {
      const data = await agentRes.json()
      result = typeof data === 'string'
        ? data
        : (data as Record<string, unknown>).output as string ||
          JSON.stringify(data)
    } catch {
      result = await agentRes.text()
    }

    await client.chat.update({
      channel,
      ts: statusMsg.ts!,
      blocks: buildResponse({
        title: `Result: ${agent.slug}`,
        body: result || '_No output_',
      }),
      text: result || 'No output',
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    await client.chat.update({
      channel,
      ts: statusMsg.ts!,
      blocks: buildResponse({
        title: `Error: ${agent.slug}`,
        body: `:exclamation: ${message}`,
      }),
      text: `Error: ${message}`,
    })
  }
}

export { handle }

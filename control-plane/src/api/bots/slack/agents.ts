import { Hono } from '@hono/hono'
import { context } from '../../../types.ts'
import type { Env } from '../../../types.ts'
import platform from '@ar/client/platform'
import { DEFAULT_SUBSYSTEM } from '@ar/client/subsystems'
import { createAgentRef, logMessage } from '@ar/client/db/slack'
import {
  create as createAgent,
  get as getAgent,
  listByTenant,
} from '@ar/client/db/agents'
import { getDb, scheduleSync } from '@ar/client/db'

const app = new Hono<Env>()

app.post('/run', async (c) => {
  const { tenantId, email } = context(c)
  const { agentId, input } = await c.req.json() as {
    agentId: string
    input: string
  }

  const agent = getAgent(agentId, tenantId)
  if (!agent) return c.json({ error: 'Agent not found' }, 404)

  const project = Deno.env.get('GCP_PROJECT') || ''
  const region = Deno.env.get('GCP_REGION') || ''

  let uri: string
  try {
    uri = await platform.functionDescribeUri(
      agent.slug,
      region,
      project,
    )
  } catch {
    return c.json({ error: 'Agent function not found' }, 404)
  }

  const token = await platform.getIdentityToken(uri)
  const agentRes = await fetch(uri, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ input, tenant: tenantId, user: email }),
  })

  logMessage({
    tenantId,
    userId: email,
    slackChannelId: 'api',
    direction: 'inbound',
    command: '/run',
    content: input,
    agentId,
  })

  if (c.req.header('Accept') === 'text/event-stream') {
    if (!agentRes.body) {
      return c.json({ error: 'No stream' }, 500)
    }
    logMessage({
      tenantId,
      userId: email,
      slackChannelId: 'api',
      direction: 'outbound',
      command: '/run',
      content: '[streaming]',
      agentId,
    })
    scheduleSync(tenantId)
    return new Response(agentRes.body, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    })
  }

  let result: unknown
  try {
    result = await agentRes.json()
  } catch {
    const text = await agentRes.text().catch(() => '')
    return c.json({
      error: 'Agent returned non-JSON response',
      status: agentRes.status,
      body: text.slice(0, 500),
    }, 502)
  }

  logMessage({
    tenantId,
    userId: email,
    slackChannelId: 'api',
    direction: 'outbound',
    command: '/run',
    content: JSON.stringify(result),
    agentId,
  })
  scheduleSync(tenantId)

  return c.json(result)
})

app.post('/create', async (c) => {
  const { tenantId, email } = context(c)
  const body = await c.req.json() as {
    name: string
    prompt: string
    version?: string
    subsystem?: string
    cleanupUnused?: boolean
  }

  if (!body.name || !body.prompt) {
    return c.json(
      { error: 'name and prompt are required' },
      400,
    )
  }

  const slug = body.name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

  const agent = createAgent({
    tenantId,
    name: body.name,
    slug,
    version: body.version || '0.0.1',
    subsystem: body.subsystem || DEFAULT_SUBSYSTEM,
    visibility: 'private',
    createdBy: email,
    sourceType: 'prompt',
    prompt: body.prompt,
  })

  createAgentRef({
    tenantId,
    userId: email,
    agentId: agent.id,
    cleanupUnused: body.cleanupUnused !== false,
  })
  scheduleSync(tenantId)

  return c.json(agent, 201)
})

app.delete('/delete', async (c) => {
  const { tenantId, email } = context(c)
  const { agentId } = await c.req.json() as { agentId: string }
  const agent = getAgent(agentId, tenantId)
  if (!agent) return c.json({ error: 'Agent not found' }, 404)

  if (agent.createdBy !== email) {
    return c.json(
      { error: 'Not authorized to delete this agent' },
      403,
    )
  }

  const db = getDb()
  db.exec('DELETE FROM slack_agent_ref WHERE agent_id = ?', agentId)
  db.exec('DELETE FROM file_config WHERE agent_id = ?', agentId)
  db.exec('DELETE FROM agent_edge WHERE agent_id = ?', agentId)
  db.exec('DELETE FROM agent_owner WHERE agent_id = ?', agentId)
  db.exec('DELETE FROM agent WHERE id = ?', agentId)
  scheduleSync(tenantId)

  return c.json({ ok: true })
})

app.get('/list', (c) => {
  const { tenantId, email } = context(c)
  const agents = listByTenant(tenantId)
  const visible = agents.filter(
    (a) => a.visibility === 'public' || a.createdBy === email,
  )
  return c.json(visible)
})

export default app

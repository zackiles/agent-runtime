import { Hono } from '@hono/hono'
import type { Context } from '@hono/hono'
import { context } from '../types.ts'
import type { Env } from '../types.ts'
import { open } from '@ar/client/db'
import { get, ingest, type IngestEvent, query } from '@ar/client/db/telemetry'

const TENANT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/

function resolveTenant(c: Context<Env>): string {
  const explicit = c.req.param('tenant')
  if (explicit) {
    if (!TENANT_PATTERN.test(explicit)) throw new Error('Invalid tenant')
    return explicit
  }
  return context(c).tenantId
}

async function handleIngest(c: Context<Env>) {
  let tenantId: string
  try {
    tenantId = resolveTenant(c)
  } catch {
    return c.json({ error: 'Invalid tenant identifier' }, 400)
  }
  await open({ id: tenantId, name: tenantId }, 'server')

  const body = await c.req.json() as {
    events?: IngestEvent[]
  } & IngestEvent

  const events: IngestEvent[] = body.events ? body.events : [body]

  const clientName = c.get('telemetryClient')?.name
  for (const e of events) {
    if (clientName) e.client = clientName
    if (!e.client || !e.action || e.timestamp == null) {
      return c.json(
        { error: 'client, action, and timestamp are required' },
        400,
      )
    }
  }

  const results = ingest(tenantId, events)
  return c.json(results, 201)
}

async function handleQuery(c: Context<Env>) {
  if (!context(c).isAdmin) return c.json({ error: 'Admin only' }, 403)

  let tenantId: string
  try {
    tenantId = resolveTenant(c)
  } catch {
    return c.json({ error: 'Invalid tenant identifier' }, 400)
  }
  await open({ id: tenantId, name: tenantId }, 'server')

  const limit = parseInt(c.req.query('limit') || '100', 10)
  const offset = parseInt(c.req.query('offset') || '0', 10)

  const filter: Parameters<typeof query>[0] = {
    tenantId,
    limit,
    offset,
  }

  const traceId = c.req.query('traceId')
  const actor = c.req.query('actor')
  const session = c.req.query('session')
  const action = c.req.query('action')
  const client = c.req.query('client')
  const level = c.req.query('level')
  const from = c.req.query('from')
  const to = c.req.query('to')

  if (traceId) filter.traceId = traceId
  if (actor) filter.actor = actor
  if (session) filter.session = session
  if (action) filter.action = action
  if (client) filter.client = client
  if (level) filter.level = level
  if (from) filter.from = parseInt(from, 10)
  if (to) filter.to = parseInt(to, 10)

  return c.json(query(filter))
}

async function handleGet(c: Context<Env>) {
  if (!context(c).isAdmin) return c.json({ error: 'Admin only' }, 403)

  let tenantId: string
  try {
    tenantId = resolveTenant(c)
  } catch {
    return c.json({ error: 'Invalid tenant identifier' }, 400)
  }
  await open({ id: tenantId, name: tenantId }, 'server')

  const id = c.req.param('id') || ''
  if (!id) return c.json({ error: 'id required' }, 400)
  const event = get(id, tenantId)
  if (!event) return c.json({ error: 'Not found' }, 404)
  return c.json(event)
}

const app = new Hono<Env>()

app.post('/', handleIngest)
app.get('/', handleQuery)
app.get('/:id', handleGet)

app.post('/t/:tenant', handleIngest)
app.get('/t/:tenant', handleQuery)
app.get('/t/:tenant/:id', handleGet)

export default app

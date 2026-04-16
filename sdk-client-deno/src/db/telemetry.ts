import { getDb, scheduleSync } from './mod.ts'

type Event = {
  id: string
  tenantId: string
  traceId: string | null
  spanId: string | null
  parentSpanId: string | null
  timestamp: number
  client: string
  clientVersion: string | null
  fingerprint: Record<string, unknown> | null
  actor: string | null
  session: string | null
  action: string
  level: string
  context: Record<string, unknown> | null
  payload: string | null
  environment: Record<string, unknown> | null
  tags: Record<string, string> | null
  createdAt: string
}

type IngestEvent = {
  traceId?: string
  spanId?: string
  parentSpanId?: string
  timestamp: number
  client: string
  clientVersion?: string
  fingerprint?: Record<string, unknown>
  actor?: string
  session?: string
  action: string
  level?: string
  context?: Record<string, unknown>
  payload?: string
  environment?: Record<string, unknown>
  tags?: Record<string, string>
}

type Filter = {
  tenantId: string
  traceId?: string
  actor?: string
  session?: string
  action?: string
  client?: string
  level?: string
  from?: number
  to?: number
  limit?: number
  offset?: number
}

function mapRow(r: Record<string, unknown>): Event {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    traceId: (r.trace_id as string) || null,
    spanId: (r.span_id as string) || null,
    parentSpanId: (r.parent_span_id as string) || null,
    timestamp: r.timestamp as number,
    client: r.client as string,
    clientVersion: (r.client_version as string) || null,
    fingerprint: r.fingerprint ? JSON.parse(r.fingerprint as string) : null,
    actor: (r.actor as string) || null,
    session: (r.session as string) || null,
    action: r.action as string,
    level: r.level as string,
    context: r.context ? JSON.parse(r.context as string) : null,
    payload: (r.payload as string) || null,
    environment: r.environment ? JSON.parse(r.environment as string) : null,
    tags: r.tags ? JSON.parse(r.tags as string) : null,
    createdAt: (r.created_at as string).endsWith('Z')
      ? r.created_at as string
      : (r.created_at as string) + 'Z',
  }
}

function ingest(tenantId: string, events: IngestEvent[]): Event[] {
  const db = getDb()
  const stmt = db.prepare(
    `INSERT INTO telemetry
       (id, tenant_id, trace_id, span_id, parent_span_id,
        timestamp, client, client_version, fingerprint,
        actor, session, action, level,
        context, payload, environment, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  const results: Event[] = []

  for (const e of events) {
    const id = crypto.randomUUID()
    const level = e.level || 'info'

    stmt.run(
      id,
      tenantId,
      e.traceId ?? null,
      e.spanId ?? null,
      e.parentSpanId ?? null,
      e.timestamp,
      e.client,
      e.clientVersion ?? null,
      e.fingerprint ? JSON.stringify(e.fingerprint) : null,
      e.actor ?? null,
      e.session ?? null,
      e.action,
      level,
      e.context ? JSON.stringify(e.context) : null,
      e.payload ?? null,
      e.environment ? JSON.stringify(e.environment) : null,
      e.tags ? JSON.stringify(e.tags) : null,
    )

    const row = db.prepare(
      'SELECT * FROM telemetry WHERE id = ?',
    ).get(id) as Record<string, unknown>

    results.push(mapRow(row))
  }

  scheduleSync(tenantId)
  return results
}

function query(filter: Filter): Event[] {
  const db = getDb()
  const conditions = ['tenant_id = ?']
  const params: unknown[] = [filter.tenantId]

  if (filter.traceId) {
    conditions.push('trace_id = ?')
    params.push(filter.traceId)
  }
  if (filter.actor) {
    conditions.push('actor = ?')
    params.push(filter.actor)
  }
  if (filter.session) {
    conditions.push('session = ?')
    params.push(filter.session)
  }
  if (filter.action) {
    conditions.push('action = ?')
    params.push(filter.action)
  }
  if (filter.client) {
    conditions.push('client = ?')
    params.push(filter.client)
  }
  if (filter.level) {
    conditions.push('level = ?')
    params.push(filter.level)
  }
  if (filter.from !== undefined) {
    conditions.push('timestamp >= ?')
    params.push(filter.from)
  }
  if (filter.to !== undefined) {
    conditions.push('timestamp <= ?')
    params.push(filter.to)
  }

  const limit = filter.limit ?? 100
  const offset = filter.offset ?? 0
  params.push(limit, offset)

  const sql = `SELECT * FROM telemetry
    WHERE ${conditions.join(' AND ')}
    ORDER BY timestamp DESC
    LIMIT ? OFFSET ?`

  const rows = db.prepare(sql).all(
    ...(params as Array<string | number | null>),
  ) as Array<Record<string, unknown>>

  return rows.map(mapRow)
}

function get(id: string, tenantId: string): Event | null {
  const db = getDb()
  const row = db.prepare(
    'SELECT * FROM telemetry WHERE id = ? AND tenant_id = ?',
  ).get(id, tenantId) as Record<string, unknown> | undefined

  return row ? mapRow(row) : null
}

export { get, ingest, query }
export type { Event, Filter, IngestEvent }

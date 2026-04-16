import { getDb, scheduleSync, transaction } from './mod.ts'
import { createCron, createEvent, createWebhook } from './configs.ts'
import { log as auditLog } from './audit.ts'
import { ensure as ensureUser } from './users.ts'

type Agent = {
  id: string
  tenantId: string
  teamId: string
  name: string
  slug: string
  version: string
  activeVersion: string | null
  subsystem: string | null
  sourceType: string | null
  prompt: string | null
  uri: string | null
  visibility: string
  createdBy: string
  createdAt: string
  updatedAt: string
}

type AgentEdge = {
  id: number
  agentId: string
  direction: string
  refType: string
  refId: string
  createdAt: string
}

type EdgeInput = {
  direction: 'consumes' | 'publishes'
  type: string
  config?: Record<string, unknown> | undefined
}

type CreateAgent = {
  tenantId: string
  name: string
  slug: string
  version?: string | undefined
  subsystem?: string | undefined
  sourceType?: string | undefined
  prompt?: string | undefined
  visibility?: string | undefined
  createdBy: string
  teamId?: string | undefined
  edges?: EdgeInput[] | undefined
}

function create(opts: CreateAgent): Agent {
  const id = crypto.randomUUID()
  const version = opts.version ?? '0.0.1'
  const teamId = opts.teamId ?? `default-team-${opts.tenantId}`
  const visibility = opts.visibility ?? 'private'

  transaction(() => {
    const db = getDb()
    ensureUser(opts.createdBy)

    db.exec(
      `INSERT INTO agent
       (id, tenant_id, team_id, name, slug, version, subsystem,
        source_type, prompt, visibility, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      opts.tenantId,
      teamId,
      opts.name,
      opts.slug,
      version,
      opts.subsystem ?? null,
      opts.sourceType ?? null,
      opts.prompt ?? null,
      visibility,
      opts.createdBy,
    )

    db.exec(
      'INSERT INTO agent_owner (agent_id, owner_id) VALUES (?, ?)',
      id,
      opts.createdBy,
    )

    if (opts.edges !== undefined) {
      for (const edge of opts.edges) {
        let refId: string
        if (edge.type === 'webhook') {
          const wh = createWebhook(
            opts.tenantId,
            edge.config as {
              id?: string
              url?: string
              method?: string
              headers?: Record<string, string>
            },
          )
          refId = wh.id
        } else if (edge.type === 'cron') {
          const cfg = edge.config as
            | { schedule?: string; timezone?: string }
            | undefined
          const cron = createCron(
            opts.tenantId,
            cfg?.schedule || '0 * * * *',
            cfg?.timezone,
          )
          refId = cron.id
        } else if (edge.type === 'pubsub') {
          const cfg = edge.config as { topic?: string } | undefined
          const ev = createEvent(
            opts.tenantId,
            cfg?.topic || 'default',
          )
          refId = ev.id
        } else {
          refId = JSON.stringify(edge.config || {})
        }
        db.exec(
          `INSERT INTO agent_edge (agent_id, direction, ref_type, ref_id)
           VALUES (?, ?, ?, ?)`,
          id,
          edge.direction,
          edge.type,
          refId,
        )
      }
    } else {
      const inWebhook = createWebhook(opts.tenantId)
      const outWebhook = createWebhook(opts.tenantId)
      db.exec(
        `INSERT INTO agent_edge (agent_id, direction, ref_type, ref_id)
         VALUES (?, 'consumes', 'webhook', ?)`,
        id,
        inWebhook.id,
      )
      db.exec(
        `INSERT INTO agent_edge (agent_id, direction, ref_type, ref_id)
         VALUES (?, 'publishes', 'webhook', ?)`,
        id,
        outWebhook.id,
      )
    }

    auditLog(opts.tenantId, 'agent', id, 'created', opts.createdBy, {
      name: opts.name,
      slug: opts.slug,
      version,
    })
  })

  scheduleSync(opts.tenantId)

  return {
    id,
    tenantId: opts.tenantId,
    teamId,
    name: opts.name,
    slug: opts.slug,
    version,
    activeVersion: null,
    subsystem: opts.subsystem ?? null,
    sourceType: opts.sourceType ?? null,
    prompt: opts.prompt ?? null,
    uri: null,
    visibility,
    createdBy: opts.createdBy,
    createdAt: '',
    updatedAt: '',
  }
}

type UpdateAgent = {
  name?: string | undefined
  subsystem?: string | undefined
  prompt?: string | undefined
  teamId?: string | undefined
  visibility?: string | undefined
  uri?: string | undefined
}

function update(
  id: string,
  tenantId: string,
  opts: UpdateAgent,
): Agent | null {
  const db = getDb()
  const agent = get(id, tenantId)
  if (!agent) return null

  const sets: string[] = ["updated_at = datetime('now')"]
  const params: (string | null)[] = []

  if (opts.name !== undefined) {
    sets.push('name = ?')
    params.push(opts.name)
  }
  if (opts.subsystem !== undefined) {
    sets.push('subsystem = ?')
    params.push(opts.subsystem)
  }
  if (opts.prompt !== undefined) {
    sets.push('prompt = ?')
    params.push(opts.prompt)
  }
  if (opts.teamId !== undefined) {
    sets.push('team_id = ?')
    params.push(opts.teamId)
  }
  if (opts.visibility !== undefined) {
    sets.push('visibility = ?')
    params.push(opts.visibility)
  }
  if (opts.uri !== undefined) {
    sets.push('uri = ?')
    params.push(opts.uri)
  }

  params.push(id, tenantId)

  db.exec(
    `UPDATE agent SET ${sets.join(', ')}
     WHERE id = ? AND tenant_id = ?`,
    ...params,
  )

  auditLog(tenantId, 'agent', id, 'updated', undefined, opts)
  scheduleSync(tenantId)
  return get(id, tenantId)
}

function listVersions(
  tenantId: string,
  slug: string,
): Agent[] {
  const db = getDb()
  const rows = db.prepare(
    `SELECT * FROM agent WHERE tenant_id = ? AND slug = ?
     ORDER BY version DESC`,
  ).all(tenantId, slug) as Array<Record<string, unknown>>
  return rows.map(mapAgent)
}

function get(id: string, tenantId: string): Agent | null {
  const db = getDb()
  const row = db.prepare(
    'SELECT * FROM agent WHERE id = ? AND tenant_id = ?',
  ).get(id, tenantId) as
    | Record<string, unknown>
    | undefined
  return row ? mapAgent(row) : null
}

function getBySlug(
  tenantId: string,
  slug: string,
  version?: string,
): Agent | null {
  const db = getDb()
  if (version) {
    const row = db.prepare(
      'SELECT * FROM agent WHERE tenant_id = ? AND slug = ? AND version = ?',
    ).get(tenantId, slug, version) as Record<string, unknown> | undefined
    return row ? mapAgent(row) : null
  }
  return resolveVersion(slug, tenantId)
}

function resolveVersion(
  slug: string,
  tenantId: string,
  requestedVersion?: string,
): Agent | null {
  const db = getDb()

  if (requestedVersion) {
    const row = db.prepare(
      'SELECT * FROM agent WHERE tenant_id = ? AND slug = ? AND version = ?',
    ).get(tenantId, slug, requestedVersion) as
      | Record<string, unknown>
      | undefined
    return row ? mapAgent(row) : null
  }

  const activeRow = db.prepare(
    `SELECT * FROM agent
     WHERE tenant_id = ? AND slug = ? AND active_version IS NOT NULL
     LIMIT 1`,
  ).get(tenantId, slug) as Record<string, unknown> | undefined

  if (activeRow) {
    const activeVersion = activeRow.active_version as string
    const exact = db.prepare(
      'SELECT * FROM agent WHERE tenant_id = ? AND slug = ? AND version = ?',
    ).get(tenantId, slug, activeVersion) as
      | Record<string, unknown>
      | undefined
    if (exact) return mapAgent(exact)
  }

  const latest = db.prepare(
    `SELECT * FROM agent
     WHERE tenant_id = ? AND slug = ?
     ORDER BY version DESC LIMIT 1`,
  ).get(tenantId, slug) as Record<string, unknown> | undefined
  return latest ? mapAgent(latest) : null
}

function listByTenant(
  tenantId: string,
  opts?: { teamId?: string; visibility?: string; sourceType?: string },
): Agent[] {
  const db = getDb()
  const conditions = ['tenant_id = ?']
  const params: unknown[] = [tenantId]

  if (opts?.teamId) {
    conditions.push('team_id = ?')
    params.push(opts.teamId)
  }
  if (opts?.visibility) {
    conditions.push('visibility = ?')
    params.push(opts.visibility)
  }
  if (opts?.sourceType) {
    conditions.push('source_type = ?')
    params.push(opts.sourceType)
  }

  const rows = db.prepare(
    `SELECT * FROM agent WHERE ${conditions.join(' AND ')}
     ORDER BY slug, version`,
  ).all(...(params as Array<string | number | null>)) as Array<
    Record<string, unknown>
  >
  return rows.map(mapAgent)
}

function getEdges(agentId: string): AgentEdge[] {
  const db = getDb()
  const rows = db.prepare(
    'SELECT * FROM agent_edge WHERE agent_id = ?',
  ).all(agentId) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    id: r.id as number,
    agentId: r.agent_id as string,
    direction: r.direction as string,
    refType: r.ref_type as string,
    refId: r.ref_id as string,
    createdAt: r.created_at as string,
  }))
}

function isLead(edges: AgentEdge[]): boolean {
  return !edges.some((e) => e.direction === 'consumes' && e.refType === 'agent')
}

function addEdge(
  tenantId: string,
  agentId: string,
  direction: string,
  refType: string,
  refId: string,
): void {
  const db = getDb()
  db.exec(
    `INSERT INTO agent_edge (agent_id, direction, ref_type, ref_id)
     VALUES (?, ?, ?, ?)`,
    agentId,
    direction,
    refType,
    refId,
  )
  scheduleSync(tenantId)
}

function removeEdge(tenantId: string, edgeId: number): void {
  const db = getDb()
  db.exec(
    `DELETE FROM agent_edge WHERE id = ? AND agent_id IN (
       SELECT id FROM agent WHERE tenant_id = ?
     )`,
    edgeId,
    tenantId,
  )
  scheduleSync(tenantId)
}

type RichEdge = {
  id: number
  direction: string
  type: string
  config: Record<string, unknown>
}

function getEdgesWithConfig(
  agentId: string,
  tenantId: string,
): RichEdge[] {
  const edges = getEdges(agentId)
  const db = getDb()
  return edges.map((e) => {
    let config: Record<string, unknown> = {}
    if (e.refType === 'webhook') {
      const row = db.prepare(
        'SELECT * FROM webhook_config WHERE id = ? AND tenant_id = ?',
      ).get(e.refId, tenantId) as Record<string, unknown> | undefined
      if (row) {
        config = {
          id: row.id,
          url: row.url,
          method: row.method,
        }
      } else {
        config = { id: e.refId }
      }
    } else if (e.refType === 'cron') {
      const row = db.prepare(
        'SELECT * FROM cron_config WHERE id = ? AND tenant_id = ?',
      ).get(e.refId, tenantId) as Record<string, unknown> | undefined
      if (row) {
        config = {
          schedule: row.schedule,
          timezone: row.timezone,
        }
      }
    } else if (e.refType === 'pubsub') {
      const row = db.prepare(
        'SELECT * FROM event_config WHERE id = ? AND tenant_id = ?',
      ).get(e.refId, tenantId) as Record<string, unknown> | undefined
      if (row) {
        config = { topic: row.topic, filter: row.filter }
      }
    } else {
      try {
        config = JSON.parse(e.refId)
      } catch { /* noop */ }
    }
    return {
      id: e.id,
      direction: e.direction,
      type: e.refType,
      config,
    }
  })
}

function switchVersion(
  tenantId: string,
  slug: string,
  version: string,
): void {
  const db = getDb()
  db.exec(
    `UPDATE agent SET active_version = ?, updated_at = datetime('now')
     WHERE tenant_id = ? AND slug = ?`,
    version,
    tenantId,
    slug,
  )
  auditLog(tenantId, 'agent', slug, 'updated', undefined, {
    action: 'switch-version',
    version,
  })
  scheduleSync(tenantId)
}

function remove(id: string, tenantId: string, actorId?: string): void {
  transaction(() => {
    const db = getDb()
    db.exec('DELETE FROM agent_edge WHERE agent_id = ?', id)
    db.exec('DELETE FROM agent_owner WHERE agent_id = ?', id)
    db.exec(
      'DELETE FROM agent WHERE id = ? AND tenant_id = ?',
      id,
      tenantId,
    )
    auditLog(tenantId, 'agent', id, 'deleted', actorId)
  })
  scheduleSync(tenantId)
}

function getOwners(agentId: string): string[] {
  const db = getDb()
  const rows = db.prepare(
    'SELECT owner_id FROM agent_owner WHERE agent_id = ?',
  ).all(agentId) as Array<{ owner_id: string }>
  return rows.map((r) => r.owner_id)
}

function mapAgent(row: Record<string, unknown>): Agent {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    teamId: row.team_id as string,
    name: row.name as string,
    slug: row.slug as string,
    version: row.version as string,
    activeVersion: (row.active_version as string) ?? null,
    subsystem: (row.subsystem as string) ?? null,
    sourceType: (row.source_type as string) ?? null,
    prompt: (row.prompt as string) ?? null,
    uri: (row.uri as string) ?? null,
    visibility: row.visibility as string,
    createdBy: row.created_by as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

export {
  addEdge,
  create,
  get,
  getBySlug,
  getEdges,
  getEdgesWithConfig,
  getOwners,
  isLead,
  listByTenant,
  listVersions,
  remove,
  removeEdge,
  resolveVersion,
  switchVersion,
  update,
}
export type { Agent, AgentEdge, CreateAgent, EdgeInput, RichEdge, UpdateAgent }

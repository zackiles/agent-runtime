import { getDb } from './mod.ts'

type AuditEntry = {
  id: number
  tenantId: string
  entityType: string
  entityId: string
  action: string
  actorId: string | null
  metadata: Record<string, unknown> | null
  createdAt: string
}

type AuditFilter = {
  tenantId: string
  entityType?: string
  entityId?: string
  action?: string
  actorId?: string
  limit?: number
  offset?: number
}

function log(
  tenantId: string,
  entityType: string,
  entityId: string,
  action: string,
  actorId?: string,
  metadata?: Record<string, unknown>,
): void {
  const db = getDb()
  db.exec(
    `INSERT INTO audit (tenant_id, entity_type, entity_id, action, actor_id, metadata)
     VALUES (?, ?, ?, ?, ?, ?)`,
    tenantId,
    entityType,
    entityId,
    action,
    actorId ?? null,
    metadata ? JSON.stringify(metadata) : null,
  )
}

function query(filter: AuditFilter): AuditEntry[] {
  const db = getDb()
  const conditions = ['tenant_id = ?']
  const params: unknown[] = [filter.tenantId]

  if (filter.entityType) {
    conditions.push('entity_type = ?')
    params.push(filter.entityType)
  }
  if (filter.entityId) {
    conditions.push('entity_id = ?')
    params.push(filter.entityId)
  }
  if (filter.action) {
    conditions.push('action = ?')
    params.push(filter.action)
  }
  if (filter.actorId) {
    conditions.push('actor_id = ?')
    params.push(filter.actorId)
  }

  const limit = filter.limit ?? 100
  const offset = filter.offset ?? 0

  const sql = `SELECT * FROM audit
    WHERE ${conditions.join(' AND ')}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?`
  params.push(limit, offset)

  const rows = db.prepare(sql).all(
    ...(params as Array<string | number | null>),
  ) as Array<{
    id: number
    tenant_id: string
    entity_type: string
    entity_id: string
    action: string
    actor_id: string | null
    metadata: string | null
    created_at: string
  }>

  return rows.map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    entityType: r.entity_type,
    entityId: r.entity_id,
    action: r.action,
    actorId: r.actor_id,
    metadata: r.metadata ? JSON.parse(r.metadata) : null,
    createdAt: r.created_at.endsWith('Z') ? r.created_at : r.created_at + 'Z',
  }))
}

export { log, query }
export type { AuditEntry, AuditFilter }

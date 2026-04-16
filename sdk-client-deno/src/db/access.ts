import { getDb } from './mod.ts'
import { isAdmin } from './users.ts'

const VALID_TABLES = new Set([
  'agent',
  'tool',
  'skill',
  'rule',
  'team',
  'department',
  'webhook_config',
  'cron_config',
  'event_config',
  'file_config',
])

function assertValidTable(table: string): void {
  if (!VALID_TABLES.has(table)) {
    throw new Error(`Invalid table name: ${table}`)
  }
}

function isOwner(
  entityType: string,
  entityId: string,
  userId: string,
): boolean {
  const db = getDb()
  const row = db.prepare(
    `SELECT owner_id FROM entity_owner
     WHERE entity_type = ? AND entity_id = ? AND owner_id = ?`,
  ).get(entityType, entityId, userId)
  return !!row
}

function isEntityOwner(
  tenantId: string,
  entityTable: string,
  entityId: string,
  userId: string,
): boolean {
  assertValidTable(entityTable)
  const db = getDb()
  const row = db.prepare(
    `SELECT owner_id FROM ${entityTable} WHERE id = ? AND tenant_id = ?`,
  ).get(entityId, tenantId) as { owner_id: string } | undefined
  if (row?.owner_id === userId) return true
  return isOwner(entityTable, entityId, userId)
}

function canRead(
  tenantId: string,
  entityTable: string,
  entityId: string,
  userId: string,
): boolean {
  assertValidTable(entityTable)
  const db = getDb()
  const row = db.prepare(
    `SELECT visibility, owner_id FROM ${entityTable} WHERE id = ? AND tenant_id = ?`,
  ).get(entityId, tenantId) as
    | { visibility: string; owner_id: string }
    | undefined
  if (!row) return false
  if (row.visibility === 'public') return true
  if (row.owner_id === userId) return true
  if (isOwner(entityTable, entityId, userId)) return true
  if (isAdmin(userId)) return true
  return false
}

function canWrite(
  tenantId: string,
  entityTable: string,
  entityId: string,
  userId: string,
): boolean {
  assertValidTable(entityTable)
  const db = getDb()
  const row = db.prepare(
    `SELECT visibility, owner_id FROM ${entityTable} WHERE id = ? AND tenant_id = ?`,
  ).get(entityId, tenantId) as
    | { visibility: string; owner_id: string }
    | undefined
  if (!row) return false
  if (row.owner_id === userId) return true
  if (isOwner(entityTable, entityId, userId)) return true
  if (isAdmin(userId)) return true
  return false
}

function canPublish(
  tenantId: string,
  userId: string,
  visibility: string,
): boolean {
  if (visibility === 'private') return true
  if (isAdmin(userId)) return true
  const db = getDb()
  const tenant = db.prepare(
    'SELECT registry_protected FROM tenant WHERE id = ?',
  ).get(tenantId) as { registry_protected: number } | undefined
  if (!tenant || tenant.registry_protected === 0) return true
  return false
}

function canManageOwners(
  tenantId: string,
  entityTable: string,
  entityId: string,
  userId: string,
): boolean {
  if (isAdmin(userId)) return true
  return isEntityOwner(tenantId, entityTable, entityId, userId)
}

function canWriteAgent(
  tenantId: string,
  agentId: string,
  userId: string,
): boolean {
  const db = getDb()
  const agent = db.prepare(
    'SELECT created_by FROM agent WHERE id = ? AND tenant_id = ?',
  ).get(agentId, tenantId) as { created_by: string } | undefined
  if (!agent) return false
  if (agent.created_by === userId) return true

  const owner = db.prepare(
    'SELECT owner_id FROM agent_owner WHERE agent_id = ? AND owner_id = ?',
  ).get(agentId, userId)
  if (owner) return true

  if (isOwner('agent', agentId, userId)) return true

  return isAdmin(userId)
}

function addOwner(
  entityType: string,
  entityId: string,
  ownerId: string,
): void {
  const db = getDb()
  const exists = db.prepare(
    `SELECT owner_id FROM entity_owner
     WHERE entity_type = ? AND entity_id = ? AND owner_id = ?`,
  ).get(entityType, entityId, ownerId)
  if (!exists) {
    db.exec(
      `INSERT INTO entity_owner (entity_type, entity_id, owner_id)
       VALUES (?, ?, ?)`,
      entityType,
      entityId,
      ownerId,
    )
  }
}

function removeOwner(
  entityType: string,
  entityId: string,
  ownerId: string,
): void {
  const db = getDb()
  db.exec(
    `DELETE FROM entity_owner
     WHERE entity_type = ? AND entity_id = ? AND owner_id = ?`,
    entityType,
    entityId,
    ownerId,
  )
}

function getOwners(
  entityType: string,
  entityId: string,
): string[] {
  const db = getDb()
  const rows = db.prepare(
    `SELECT owner_id FROM entity_owner
     WHERE entity_type = ? AND entity_id = ?`,
  ).all(entityType, entityId) as Array<{ owner_id: string }>
  return rows.map((r) => r.owner_id)
}

function registryProtected(tenantId: string): boolean {
  const db = getDb()
  const row = db.prepare(
    'SELECT registry_protected FROM tenant WHERE id = ?',
  ).get(tenantId) as { registry_protected: number } | undefined
  return row?.registry_protected === 1
}

function setRegistryProtected(
  tenantId: string,
  value: boolean,
): void {
  const db = getDb()
  db.exec(
    'UPDATE tenant SET registry_protected = ? WHERE id = ?',
    value ? 1 : 0,
    tenantId,
  )
}

function enforceVisibilityUniqueness(
  table: string,
  tenantId: string,
  slug: string,
  version: string | null,
  targetVisibility: string,
): { conflict: boolean; message: string } {
  assertValidTable(table)
  const db = getDb()
  const oppositeVisibility = targetVisibility === 'public'
    ? 'private'
    : 'public'
  let sql: string
  const params: (string | null)[] = [tenantId, slug]

  if (version) {
    sql =
      `SELECT id, visibility FROM ${table} WHERE tenant_id = ? AND slug = ? AND version = ? AND visibility = ?`
    params.push(version, oppositeVisibility)
  } else {
    sql =
      `SELECT id, visibility FROM ${table} WHERE tenant_id = ? AND slug = ? AND visibility = ?`
    params.push(oppositeVisibility)
  }

  const existing = db.prepare(sql).get(
    ...(params as Array<string | number | null>),
  ) as { id: string; visibility: string } | undefined

  if (existing) {
    if (targetVisibility === 'private' && existing.visibility === 'public') {
      return {
        conflict: true,
        message:
          `A public version already exists for '${slug}'. Public takes precedence.`,
      }
    }
    return {
      conflict: true,
      message:
        `A ${existing.visibility} version of '${slug}' already exists. Remove it first or use a different version.`,
    }
  }
  return { conflict: false, message: '' }
}

export {
  addOwner,
  assertValidTable,
  canManageOwners,
  canPublish,
  canRead,
  canWrite,
  canWriteAgent,
  enforceVisibilityUniqueness,
  getOwners,
  registryProtected,
  removeOwner,
  setRegistryProtected,
}

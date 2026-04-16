import { getDb, scheduleSync, transaction } from './mod.ts'
import { log as auditLog } from './audit.ts'
import { addOwner as addEntityOwner, assertValidTable } from './access.ts'

type RegistryEntity = {
  id: string
  tenantId: string
  name: string
  slug: string
  version: string
  activeVersion: string | null
  visibility: string
  ownerId: string
  config: Record<string, unknown> | null
  content: string | null
  gcsPath: string | null
  template: boolean
  createdAt: string
}

type EntityTable = 'tool' | 'skill' | 'rule'

function createEntity(
  table: EntityTable,
  tenantId: string,
  name: string,
  slug: string,
  ownerId: string,
  opts?: {
    visibility?: string
    config?: Record<string, unknown>
    version?: string
    content?: string
    gcsPath?: string
  },
): RegistryEntity {
  assertValidTable(table)
  const id = crypto.randomUUID()
  const visibility = opts?.visibility ?? 'private'
  const version = opts?.version ?? '0.0.1'

  const hasActiveVersion = table === 'skill' || table === 'rule'

  transaction(() => {
    const db = getDb()
    if (hasActiveVersion) {
      db.exec(
        `INSERT INTO ${table}
         (id, tenant_id, name, slug, version, active_version,
          visibility, owner_id, config, content, gcs_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        tenantId,
        name,
        slug,
        version,
        version,
        visibility,
        ownerId,
        opts?.config ? JSON.stringify(opts.config) : null,
        opts?.content ?? null,
        opts?.gcsPath ?? null,
      )
    } else {
      db.exec(
        `INSERT INTO ${table}
         (id, tenant_id, name, slug, version, visibility, owner_id,
          config, gcs_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        tenantId,
        name,
        slug,
        version,
        visibility,
        ownerId,
        opts?.config ? JSON.stringify(opts.config) : null,
        opts?.gcsPath ?? null,
      )
    }
    addEntityOwner(table, id, ownerId)
    auditLog(tenantId, table, id, 'created', ownerId, { name, slug })
  })
  scheduleSync(tenantId)

  return {
    id,
    tenantId,
    name,
    slug,
    version,
    activeVersion: hasActiveVersion ? version : null,
    visibility,
    ownerId,
    config: opts?.config ?? null,
    content: opts?.content ?? null,
    gcsPath: opts?.gcsPath ?? null,
    template: false,
    createdAt: '',
  }
}

function updateGcsPath(
  table: EntityTable,
  id: string,
  tenantId: string,
  gcsPath: string,
): void {
  const db = getDb()
  db.exec(
    `UPDATE ${table} SET gcs_path = ? WHERE id = ? AND tenant_id = ?`,
    gcsPath,
    id,
    tenantId,
  )
  scheduleSync(tenantId)
}

function listEntities(
  table: EntityTable,
  tenantId: string,
  userId?: string,
): RegistryEntity[] {
  const db = getDb()
  let sql: string
  const params: unknown[] = [tenantId]

  if (userId) {
    sql =
      `SELECT * FROM ${table} WHERE tenant_id = ? AND (visibility = 'public' OR owner_id = ?) ORDER BY name`
    params.push(userId)
  } else {
    sql = `SELECT * FROM ${table} WHERE tenant_id = ? ORDER BY name`
  }

  const rows = db.prepare(sql).all(
    ...(params as Array<string | number | null>),
  ) as Array<
    Record<string, unknown>
  >
  return rows.map(mapEntity)
}

function listPublicEntities(
  table: EntityTable,
  tenantId: string,
): RegistryEntity[] {
  const db = getDb()
  const rows = db.prepare(
    `SELECT * FROM ${table} WHERE tenant_id = ? AND visibility = 'public' ORDER BY name`,
  ).all(tenantId) as Array<Record<string, unknown>>
  return rows.map(mapEntity)
}

function listPrivateEntities(
  table: EntityTable,
  tenantId: string,
  userId: string,
): RegistryEntity[] {
  const db = getDb()
  const rows = db.prepare(
    `SELECT * FROM ${table} WHERE tenant_id = ? AND visibility = 'private' AND owner_id = ? ORDER BY name`,
  ).all(tenantId, userId) as Array<Record<string, unknown>>
  return rows.map(mapEntity)
}

function getEntity(
  table: EntityTable,
  id: string,
  tenantId: string,
): RegistryEntity | null {
  const db = getDb()
  const row = db.prepare(
    `SELECT * FROM ${table} WHERE id = ? AND tenant_id = ?`,
  ).get(id, tenantId) as
    | Record<string, unknown>
    | undefined
  return row ? mapEntity(row) : null
}

function getEntityBySlug(
  table: EntityTable,
  tenantId: string,
  slug: string,
): RegistryEntity | null {
  const db = getDb()
  const pub = db.prepare(
    `SELECT * FROM ${table} WHERE tenant_id = ? AND slug = ? AND visibility = 'public'`,
  ).get(tenantId, slug) as Record<string, unknown> | undefined
  if (pub) return mapEntity(pub)

  const row = db.prepare(
    `SELECT * FROM ${table} WHERE tenant_id = ? AND slug = ?`,
  ).get(tenantId, slug) as Record<string, unknown> | undefined
  return row ? mapEntity(row) : null
}

function cloneEntity(
  table: EntityTable,
  sourceId: string,
  tenantId: string,
  ownerId: string,
  targetVisibility?: string,
): RegistryEntity {
  const source = getEntity(table, sourceId, tenantId)
  if (!source) throw new Error(`${table} not found: ${sourceId}`)

  const db = getDb()
  let slug = source.slug
  let suffix = 1
  while (
    db.prepare(
      `SELECT id FROM ${table} WHERE tenant_id = ? AND slug = ?`,
    ).get(tenantId, slug)
  ) {
    slug = `${source.slug}-copy-${suffix}`
    suffix++
  }

  const visibility = targetVisibility ?? 'private'
  const opts: {
    visibility: string
    config?: Record<string, unknown>
    version?: string
  } = { visibility, version: source.version }
  if (source.config) opts.config = source.config
  const name = slug !== source.slug
    ? `${source.name} (copy ${suffix - 1})`
    : source.name
  return createEntity(table, tenantId, name, slug, ownerId, opts)
}

function promoteToPublic(
  table: EntityTable,
  tenantId: string,
  slug: string,
  actorId: string,
): RegistryEntity | null {
  const db = getDb()
  const existing = db.prepare(
    `SELECT * FROM ${table} WHERE tenant_id = ? AND slug = ? AND visibility = 'private'`,
  ).get(tenantId, slug) as Record<string, unknown> | undefined
  if (!existing) return null

  const publicExists = db.prepare(
    `SELECT id FROM ${table} WHERE tenant_id = ? AND slug = ? AND visibility = 'public'`,
  ).get(tenantId, slug)
  if (publicExists) return null

  db.exec(
    `UPDATE ${table} SET visibility = 'public' WHERE id = ? AND tenant_id = ?`,
    existing.id as string,
    tenantId,
  )
  auditLog(
    tenantId,
    table,
    existing.id as string,
    'promoted',
    actorId,
    { slug },
  )
  scheduleSync(tenantId)
  return getEntity(table, existing.id as string, tenantId)
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}

type EntityUpdates = {
  name?: string
  config?: Record<string, unknown>
  visibility?: string
  content?: string
}

function updateEntity(
  table: EntityTable,
  id: string,
  tenantId: string,
  updates: EntityUpdates,
  actorId?: string,
): RegistryEntity | null {
  assertValidTable(table)
  const current = getEntity(table, id, tenantId)
  if (!current) return null

  const sets: string[] = []
  const params: (string | null)[] = []

  if (updates.name !== undefined && updates.name !== current.name) {
    sets.push('name = ?')
    params.push(updates.name)
  }
  if (
    updates.visibility !== undefined &&
    updates.visibility !== current.visibility
  ) {
    sets.push('visibility = ?')
    params.push(updates.visibility)
  }
  if (
    updates.content !== undefined &&
    updates.content !== current.content
  ) {
    sets.push('content = ?')
    params.push(updates.content)
  }
  if (updates.config !== undefined) {
    const next = JSON.stringify(updates.config)
    const prev = current.config ? JSON.stringify(current.config) : null
    if (next !== prev) {
      sets.push('config = ?')
      params.push(next)
    }
  }

  if (sets.length === 0) return current

  transaction(() => {
    const db = getDb()
    db.exec(
      `UPDATE ${table} SET ${sets.join(', ')}
       WHERE id = ? AND tenant_id = ?`,
      ...params,
      id,
      tenantId,
    )
    auditLog(tenantId, table, id, 'updated', actorId, updates)
  })
  scheduleSync(tenantId)
  return getEntity(table, id, tenantId)
}

function createVersion(
  table: EntityTable,
  tenantId: string,
  slug: string,
  version: string,
  ownerId: string,
  opts?: {
    content?: string
    config?: Record<string, unknown>
  },
): RegistryEntity {
  assertValidTable(table)
  const existing = getEntityBySlug(table, tenantId, slug)
  if (!existing) throw new Error(`${table} '${slug}' not found`)

  if (compareSemver(version, existing.version) <= 0) {
    throw new Error(
      `Version '${version}' must be greater than` +
        ` current version '${existing.version}'.`,
    )
  }

  const id = crypto.randomUUID()
  transaction(() => {
    const db = getDb()
    if (table === 'skill' || table === 'rule') {
      db.exec(
        `INSERT INTO ${table}
         (id, tenant_id, name, slug, version, active_version,
          visibility, owner_id, config, content, gcs_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        id,
        tenantId,
        existing.name,
        slug,
        version,
        version,
        existing.visibility,
        ownerId,
        opts?.config
          ? JSON.stringify(opts.config)
          : (existing.config ? JSON.stringify(existing.config) : null),
        opts?.content ?? existing.content ?? null,
      )
      db.exec(
        `UPDATE ${table} SET active_version = ?
         WHERE tenant_id = ? AND slug = ?`,
        version,
        tenantId,
        slug,
      )
    } else {
      db.exec(
        `INSERT INTO ${table}
         (id, tenant_id, name, slug, version,
          visibility, owner_id, config, gcs_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        id,
        tenantId,
        existing.name,
        slug,
        version,
        existing.visibility,
        ownerId,
        opts?.config
          ? JSON.stringify(opts.config)
          : (existing.config ? JSON.stringify(existing.config) : null),
      )
    }
    addEntityOwner(table, id, ownerId)
    auditLog(tenantId, table, id, 'version_created', ownerId, {
      slug,
      version,
    })
  })
  scheduleSync(tenantId)
  return getEntity(table, id, tenantId)!
}

function listVersions(
  table: EntityTable,
  tenantId: string,
  slug: string,
): RegistryEntity[] {
  assertValidTable(table)
  const db = getDb()
  const rows = db.prepare(
    `SELECT * FROM ${table}
     WHERE tenant_id = ? AND slug = ?
     ORDER BY version DESC`,
  ).all(tenantId, slug) as Array<Record<string, unknown>>
  return rows.map(mapEntity)
}

function switchVersion(
  table: EntityTable,
  tenantId: string,
  slug: string,
  version: string,
): void {
  assertValidTable(table)
  const db = getDb()
  if (table === 'skill' || table === 'rule') {
    db.exec(
      `UPDATE ${table} SET active_version = ?
       WHERE tenant_id = ? AND slug = ?`,
      version,
      tenantId,
      slug,
    )
  }
  scheduleSync(tenantId)
}

function removeVersion(
  table: EntityTable,
  tenantId: string,
  slug: string,
  version: string,
  actorId?: string,
): void {
  assertValidTable(table)
  transaction(() => {
    const db = getDb()
    const row = db.prepare(
      `SELECT id FROM ${table}
       WHERE tenant_id = ? AND slug = ? AND version = ?`,
    ).get(tenantId, slug, version) as
      | { id: string }
      | undefined
    if (!row) return

    db.exec(
      `DELETE FROM ${table}
       WHERE id = ? AND tenant_id = ?`,
      row.id,
      tenantId,
    )
    db.exec(
      `DELETE FROM entity_owner
       WHERE entity_type = ? AND entity_id = ?`,
      table,
      row.id,
    )
    auditLog(tenantId, table, row.id, 'version_deleted', actorId, {
      slug,
      version,
    })
  })
  scheduleSync(tenantId)
}

function removeEntity(
  table: EntityTable,
  id: string,
  tenantId: string,
  actorId?: string,
): void {
  assertValidTable(table)
  transaction(() => {
    const db = getDb()

    const row = db.prepare(
      `SELECT slug FROM ${table} WHERE id = ? AND tenant_id = ?`,
    ).get(id, tenantId) as { slug: string } | undefined

    if (row && (table === 'skill' || table === 'rule')) {
      const siblings = db.prepare(
        `SELECT id FROM ${table}
         WHERE tenant_id = ? AND slug = ?`,
      ).all(tenantId, row.slug) as Array<{ id: string }>
      for (const s of siblings) {
        db.exec(
          `DELETE FROM ${table} WHERE id = ? AND tenant_id = ?`,
          s.id,
          tenantId,
        )
        db.exec(
          `DELETE FROM entity_owner
           WHERE entity_type = ? AND entity_id = ?`,
          table,
          s.id,
        )
      }
    } else {
      db.exec(
        `DELETE FROM ${table} WHERE id = ? AND tenant_id = ?`,
        id,
        tenantId,
      )
      db.exec(
        `DELETE FROM entity_owner
         WHERE entity_type = ? AND entity_id = ?`,
        table,
        id,
      )
    }
    auditLog(tenantId, table, id, 'deleted', actorId)
  })
  scheduleSync(tenantId)
}

function listTemplates(
  table: EntityTable,
  tenantId: string,
): RegistryEntity[] {
  const db = getDb()
  const rows = db.prepare(
    `SELECT * FROM ${table} WHERE tenant_id = ? AND template = 1 ORDER BY name`,
  ).all(tenantId) as Array<Record<string, unknown>>
  return rows.map(mapEntity)
}

function mapEntity(row: Record<string, unknown>): RegistryEntity {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    name: row.name as string,
    slug: row.slug as string,
    version: (row.version as string) ?? '0.0.1',
    activeVersion: (row.active_version as string) ?? null,
    visibility: row.visibility as string,
    ownerId: row.owner_id as string,
    config: row.config ? JSON.parse(row.config as string) : null,
    content: (row.content as string) ?? null,
    gcsPath: (row.gcs_path as string) ?? null,
    template: (row.template as number) === 1,
    createdAt: row.created_at as string,
  }
}

export {
  cloneEntity,
  compareSemver,
  createEntity,
  createVersion,
  getEntity,
  getEntityBySlug,
  listEntities,
  listPrivateEntities,
  listPublicEntities,
  listTemplates,
  listVersions,
  promoteToPublic,
  removeEntity,
  removeVersion,
  switchVersion,
  updateEntity,
  updateGcsPath,
}
export type { EntityTable, EntityUpdates, RegistryEntity }

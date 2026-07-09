import { getDb, scheduleSync } from './mod.ts'

type DemoRole = 'viewer' | 'editor'

type DemoShare = {
  ownerId: string
  slug: string
  memberId: string
  role: DemoRole
  grantedBy: string
  createdAt: string
}

type DemoShareRow = {
  owner_id: string
  slug: string
  member_id: string
  role: DemoRole
  granted_by: string
  created_at: string
}

function map(row: DemoShareRow): DemoShare {
  return {
    ownerId: row.owner_id,
    slug: row.slug,
    memberId: row.member_id,
    role: row.role,
    grantedBy: row.granted_by,
    createdAt: row.created_at,
  }
}

function upsert(
  tenantId: string,
  share: Omit<DemoShare, 'createdAt'>,
): void {
  const db = getDb()
  db.exec(
    `INSERT INTO demo_share
     (tenant_id, owner_id, slug, member_id, role, granted_by)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, owner_id, slug, member_id)
     DO UPDATE SET role = excluded.role, granted_by = excluded.granted_by`,
    tenantId,
    share.ownerId,
    share.slug,
    share.memberId,
    share.role,
    share.grantedBy,
  )
  scheduleSync(tenantId)
}

function remove(
  tenantId: string,
  ownerId: string,
  slug: string,
  memberId?: string,
): void {
  const db = getDb()
  if (memberId) {
    db.exec(
      `DELETE FROM demo_share
       WHERE tenant_id = ? AND owner_id = ? AND slug = ? AND member_id = ?`,
      tenantId,
      ownerId,
      slug,
      memberId,
    )
    scheduleSync(tenantId)
    return
  }
  db.exec(
    `DELETE FROM demo_share
     WHERE tenant_id = ? AND owner_id = ? AND slug = ?`,
    tenantId,
    ownerId,
    slug,
  )
  scheduleSync(tenantId)
}

function forMember(tenantId: string, memberId: string): DemoShare[] {
  const db = getDb()
  const rows = db.prepare(
    `SELECT * FROM demo_share WHERE tenant_id = ? AND member_id = ?`,
  ).all(tenantId, memberId) as DemoShareRow[]
  return rows.map(map)
}

function forDemo(
  tenantId: string,
  ownerId: string,
  slug: string,
): DemoShare[] {
  const db = getDb()
  const rows = db.prepare(
    `SELECT * FROM demo_share
     WHERE tenant_id = ? AND owner_id = ? AND slug = ?
     ORDER BY created_at`,
  ).all(tenantId, ownerId, slug) as DemoShareRow[]
  return rows.map(map)
}

function role(
  tenantId: string,
  ownerId: string,
  slug: string,
  memberId: string,
): DemoRole | null {
  const db = getDb()
  const row = db.prepare(
    `SELECT role FROM demo_share
     WHERE tenant_id = ? AND owner_id = ? AND slug = ? AND member_id = ?`,
  ).get(tenantId, ownerId, slug, memberId) as { role: DemoRole } | undefined
  return row?.role ?? null
}

export { forDemo, forMember, remove, role, upsert }
export type { DemoRole, DemoShare }

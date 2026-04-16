import { getDb, scheduleSync, transaction } from './mod.ts'
import { log as auditLog } from './audit.ts'

type Team = {
  id: string
  tenantId: string
  departmentId: string
  name: string
  ownerId: string
  createdAt: string
}

type Department = {
  id: string
  tenantId: string
  name: string
  ownerId: string
  createdAt: string
}

function createTeam(
  tenantId: string,
  name: string,
  ownerId: string,
  departmentId?: string,
): Team {
  if (!departmentId) departmentId = `default-department-${tenantId}`
  const id = crypto.randomUUID()

  transaction(() => {
    const db = getDb()
    db.exec(
      `INSERT INTO team (id, tenant_id, department_id, name, owner_id)
       VALUES (?, ?, ?, ?, ?)`,
      id,
      tenantId,
      departmentId!,
      name,
      ownerId,
    )

    const defaults = ['development', 'production']
    if (defaults.includes(tenantId)) {
      const otherTenant = tenantId === 'development'
        ? 'production'
        : 'development'
      const existsOther = db.prepare(
        'SELECT id FROM team WHERE tenant_id = ? AND name = ?',
      ).get(otherTenant, name)

      if (!existsOther) {
        const otherId = crypto.randomUUID()
        const sourceDept = db.prepare(
          'SELECT name FROM department WHERE id = ? AND tenant_id = ?',
        ).get(departmentId!, tenantId) as { name: string } | undefined
        const deptName = sourceDept?.name ?? 'Default Department'

        const otherDeptId = db.prepare(
          'SELECT id FROM department WHERE tenant_id = ? AND name = ?',
        ).get(otherTenant, deptName) as { id: string } | undefined

        db.exec(
          `INSERT INTO team (id, tenant_id, department_id, name, owner_id)
           VALUES (?, ?, ?, ?, ?)`,
          otherId,
          otherTenant,
          otherDeptId?.id ?? `default-department-${otherTenant}`,
          name,
          ownerId,
        )
      }
    }

    auditLog(tenantId, 'team', id, 'created', ownerId, { name })
  })

  scheduleSync(tenantId)
  return { id, tenantId, departmentId, name, ownerId, createdAt: '' }
}

function listTeams(tenantId: string): Team[] {
  const db = getDb()
  const rows = db.prepare(
    'SELECT * FROM team WHERE tenant_id = ? ORDER BY name',
  ).all(tenantId) as Array<Record<string, unknown>>
  return rows.map(mapTeam)
}

function editTeam(
  id: string,
  tenantId: string,
  updates: { ownerId?: string },
): void {
  const db = getDb()
  if (updates.ownerId) {
    db.exec(
      'UPDATE team SET owner_id = ? WHERE id = ? AND tenant_id = ?',
      updates.ownerId,
      id,
      tenantId,
    )
  }
  auditLog(tenantId, 'team', id, 'updated', updates.ownerId)
  scheduleSync(tenantId)
}

function getTeamByName(tenantId: string, name: string): Team | null {
  const db = getDb()
  const row = db.prepare(
    'SELECT * FROM team WHERE tenant_id = ? AND name = ?',
  ).get(tenantId, name) as Record<string, unknown> | undefined
  return row ? mapTeam(row) : null
}

function createDepartment(
  tenantId: string,
  name: string,
  ownerId: string,
): Department {
  const id = crypto.randomUUID()

  transaction(() => {
    const db = getDb()
    db.exec(
      `INSERT INTO department (id, tenant_id, name, owner_id)
       VALUES (?, ?, ?, ?)`,
      id,
      tenantId,
      name,
      ownerId,
    )

    const defaults = ['development', 'production']
    if (defaults.includes(tenantId)) {
      const otherTenant = tenantId === 'development'
        ? 'production'
        : 'development'
      const existsOther = db.prepare(
        'SELECT id FROM department WHERE tenant_id = ? AND name = ?',
      ).get(otherTenant, name)

      if (!existsOther) {
        db.exec(
          `INSERT INTO department (id, tenant_id, name, owner_id)
           VALUES (?, ?, ?, ?)`,
          crypto.randomUUID(),
          otherTenant,
          name,
          ownerId,
        )
      }
    }

    auditLog(tenantId, 'department', id, 'created', ownerId, { name })
  })

  scheduleSync(tenantId)
  return { id, tenantId, name, ownerId, createdAt: '' }
}

function listDepartments(tenantId: string): Department[] {
  const db = getDb()
  const rows = db.prepare(
    'SELECT * FROM department WHERE tenant_id = ? ORDER BY name',
  ).all(tenantId) as Array<Record<string, unknown>>
  return rows.map(mapDepartment)
}

function editDepartment(
  id: string,
  tenantId: string,
  updates: { ownerId?: string },
): void {
  const db = getDb()
  if (updates.ownerId) {
    db.exec(
      'UPDATE department SET owner_id = ? WHERE id = ? AND tenant_id = ?',
      updates.ownerId,
      id,
      tenantId,
    )
  }
  auditLog(tenantId, 'department', id, 'updated', updates.ownerId)
  scheduleSync(tenantId)
}

function getDepartmentByName(
  tenantId: string,
  name: string,
): Department | null {
  const db = getDb()
  const row = db.prepare(
    'SELECT * FROM department WHERE tenant_id = ? AND name = ?',
  ).get(tenantId, name) as Record<string, unknown> | undefined
  return row ? mapDepartment(row) : null
}

function mapTeam(row: Record<string, unknown>): Team {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    departmentId: row.department_id as string,
    name: row.name as string,
    ownerId: row.owner_id as string,
    createdAt: row.created_at as string,
  }
}

function mapDepartment(row: Record<string, unknown>): Department {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    name: row.name as string,
    ownerId: row.owner_id as string,
    createdAt: row.created_at as string,
  }
}

export {
  createDepartment,
  createTeam,
  editDepartment,
  editTeam,
  getDepartmentByName,
  getTeamByName,
  listDepartments,
  listTeams,
}
export type { Department, Team }

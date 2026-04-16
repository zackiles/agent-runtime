import { getDb, scheduleSync } from './mod.ts'
import { log as auditLog } from './audit.ts'
import { TOOLS } from '../defaults/tools.ts'

type Tool = {
  id: string
  tenantId: string
  name: string
  slug: string
  version: string
  visibility: string
  ownerId: string
  gcsPath: string | null
  hasInstall: boolean
  createdAt: string
}

type CreateTool = {
  tenantId: string
  name: string
  slug: string
  version?: string
  visibility?: string
  ownerId: string
  gcsPath?: string
  hasInstall?: boolean
  config?: Record<string, unknown>
}

function create(opts: CreateTool): Tool {
  const db = getDb()
  const id = crypto.randomUUID()
  const version = opts.version ?? '0.0.1'
  const visibility = opts.visibility ?? 'private'

  db.exec(
    `INSERT OR REPLACE INTO tool
     (id, tenant_id, name, slug, version, visibility, owner_id,
      gcs_path, has_install, config)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    opts.tenantId,
    opts.name,
    opts.slug,
    version,
    visibility,
    opts.ownerId,
    opts.gcsPath ?? null,
    opts.hasInstall ? 1 : 0,
    opts.config ? JSON.stringify(opts.config) : null,
  )

  auditLog(opts.tenantId, 'tool', id, 'created', opts.ownerId, {
    name: opts.name,
    slug: opts.slug,
    version,
  })
  scheduleSync(opts.tenantId)

  return {
    id,
    tenantId: opts.tenantId,
    name: opts.name,
    slug: opts.slug,
    version,
    visibility,
    ownerId: opts.ownerId,
    gcsPath: opts.gcsPath ?? null,
    hasInstall: opts.hasInstall ?? false,
    createdAt: '',
  }
}

function getBySlug(
  tenantId: string,
  slug: string,
  version?: string,
): Tool | null {
  const db = getDb()
  if (version) {
    const row = db.prepare(
      'SELECT * FROM tool WHERE tenant_id = ? AND slug = ? AND version = ?',
    ).get(tenantId, slug, version) as Record<string, unknown> | undefined
    return row ? mapTool(row) : null
  }
  const row = db.prepare(
    'SELECT * FROM tool WHERE tenant_id = ? AND slug = ? ORDER BY version DESC LIMIT 1',
  ).get(tenantId, slug) as Record<string, unknown> | undefined
  return row ? mapTool(row) : null
}

function get(id: string, tenantId: string): Tool | null {
  const db = getDb()
  const row = db.prepare(
    'SELECT * FROM tool WHERE id = ? AND tenant_id = ?',
  ).get(id, tenantId) as
    | Record<string, unknown>
    | undefined
  return row ? mapTool(row) : null
}

function listByTenant(tenantId: string): Tool[] {
  const db = getDb()
  const rows = db.prepare(
    'SELECT * FROM tool WHERE tenant_id = ? ORDER BY slug, version DESC',
  ).all(tenantId) as Array<Record<string, unknown>>
  return rows.map(mapTool)
}

function remove(id: string, tenantId: string, actorId?: string): void {
  const db = getDb()
  db.exec('DELETE FROM tool WHERE id = ? AND tenant_id = ?', id, tenantId)
  auditLog(tenantId, 'tool', id, 'deleted', actorId)
  scheduleSync(tenantId)
}

function seedDefaults(tenantId: string, ownerId: string): void {
  const db = getDb()
  for (const tool of TOOLS()) {
    const exists = db.prepare(
      'SELECT id FROM tool WHERE tenant_id = ? AND slug = ?',
    ).get(tenantId, tool.slug)
    if (!exists) {
      create({
        tenantId,
        name: tool.name,
        slug: tool.slug,
        version: tool.version,
        visibility: 'public',
        ownerId,
        config: {
          description: tool.description,
          flags: tool.flags,
          env: tool.env,
        },
      })
    }
  }
}

function mapTool(row: Record<string, unknown>): Tool {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    name: row.name as string,
    slug: row.slug as string,
    version: (row.version as string) ?? '0.0.1',
    visibility: row.visibility as string,
    ownerId: row.owner_id as string,
    gcsPath: (row.gcs_path as string) ?? null,
    hasInstall: (row.has_install as number) === 1,
    createdAt: row.created_at as string,
  }
}

export { create, get, getBySlug, listByTenant, mapTool, remove, seedDefaults }
export type { CreateTool, Tool }

import { Database } from '@db/sqlite'
import { join } from '@std/path'
import { exists } from '@std/fs'
import { migrate, seed } from './schema.ts'
import type { Tenant } from '../tenant.ts'
import { dataDir as resolveDataDir } from '../runtime.ts'

type TenantDb = {
  db: Database
  path: string
  syncTimer: number | null
  pushFn: (() => Promise<void>) | null
}

const dbs = new Map<string, TenantDb>()
let activeTenantId: string | null = null

function getDb(): Database {
  if (!activeTenantId || !dbs.has(activeTenantId)) {
    throw new Error('Database not initialized. Call open() first.')
  }
  return dbs.get(activeTenantId)!.db
}

function dbPath(tenant: Tenant, mode: string): string {
  if (mode === 'server') {
    const base = Deno.env.get('AR_DB_PATH') || '/data'
    return join(base, `${tenant.id}.db`)
  }
  return join(resolveDataDir(), `${tenant.id}.db`)
}

async function open(
  tenant: Tenant,
  mode: string,
  userEmail = 'system@ar-cli',
): Promise<Database> {
  const existing = dbs.get(tenant.id)
  if (existing) {
    activeTenantId = tenant.id
    return existing.db
  }

  const path = dbPath(tenant, mode)
  const dir = path.substring(0, path.lastIndexOf('/'))
  if (!await exists(dir)) {
    await Deno.mkdir(dir, { recursive: true })
  }

  const db = new Database(path)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('PRAGMA foreign_keys=ON')

  const entry: TenantDb = { db, path, syncTimer: null, pushFn: null }
  if (syncFactory) {
    const id = tenant.id
    entry.pushFn = () => syncFactory!(id, path, db)
  }
  dbs.set(tenant.id, entry)
  activeTenantId = tenant.id

  migrate(db)
  seed(db, tenant.id, userEmail)

  return db
}

let syncFactory:
  | ((tenantId: string, path: string, db: Database) => Promise<void>)
  | null = null

function setSyncFn(
  fn: (tenantId: string, path: string, db: Database) => Promise<void>,
): void {
  syncFactory = fn
  for (const [tenantId, entry] of dbs) {
    entry.pushFn = () => fn(tenantId, entry.path, entry.db)
  }
}

function scheduleSync(tenantId: string): void {
  const entry = dbs.get(tenantId)
  if (!entry?.pushFn) return
  if (entry.syncTimer !== null) clearTimeout(entry.syncTimer)
  entry.syncTimer = setTimeout(async () => {
    try {
      await entry.pushFn!()
    } catch {
      // sync failures are non-fatal
    }
    entry.syncTimer = null
  }, 500) as unknown as number
}

function closeTenant(tenantId: string): string | null {
  const entry = dbs.get(tenantId)
  if (!entry) return null
  if (entry.syncTimer !== null) {
    clearTimeout(entry.syncTimer)
    entry.syncTimer = null
  }
  entry.db.close()
  const path = entry.path
  dbs.delete(tenantId)
  if (activeTenantId === tenantId) activeTenantId = null
  return path
}

async function close(): Promise<void> {
  for (const entry of dbs.values()) {
    if (entry.syncTimer !== null) {
      clearTimeout(entry.syncTimer)
      entry.syncTimer = null
    }
    if (entry.pushFn) {
      try {
        await entry.pushFn()
      } catch {
        // best-effort final sync
      }
    }
    entry.db.close()
  }
  dbs.clear()
  activeTenantId = null
}

function transaction<T>(fn: () => T): T {
  const db = getDb()
  db.exec('BEGIN')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export { close, closeTenant, getDb, open, scheduleSync, setSyncFn, transaction }

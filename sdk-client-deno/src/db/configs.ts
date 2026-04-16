import { getDb, scheduleSync } from './mod.ts'

type WebhookConfig = {
  id: string
  tenantId: string
  url: string | null
  method: string
  headers: Record<string, string> | null
  createdAt: string
}

type CronConfig = {
  id: string
  tenantId: string
  schedule: string
  timezone: string
  createdAt: string
}

type EventConfig = {
  id: string
  tenantId: string
  topic: string
  filter: Record<string, unknown> | null
  createdAt: string
}

type FileConfig = {
  id: string
  tenantId: string
  agentId: string
  path: string
  createdAt: string
}

function createWebhook(
  tenantId: string,
  opts?: {
    id?: string
    url?: string
    method?: string
    headers?: Record<string, string>
  },
): WebhookConfig {
  const db = getDb()
  const id = opts?.id || crypto.randomUUID()
  db.exec(
    `INSERT INTO webhook_config (id, tenant_id, url, method, headers)
     VALUES (?, ?, ?, ?, ?)`,
    id,
    tenantId,
    opts?.url ?? null,
    opts?.method ?? 'POST',
    opts?.headers ? JSON.stringify(opts.headers) : null,
  )
  scheduleSync(tenantId)
  return {
    id,
    tenantId,
    url: opts?.url ?? null,
    method: opts?.method ?? 'POST',
    headers: opts?.headers ?? null,
    createdAt: '',
  }
}

function createCron(
  tenantId: string,
  schedule: string,
  timezone = 'America/Toronto',
): CronConfig {
  const db = getDb()
  const id = crypto.randomUUID()
  db.exec(
    `INSERT INTO cron_config (id, tenant_id, schedule, timezone)
     VALUES (?, ?, ?, ?)`,
    id,
    tenantId,
    schedule,
    timezone,
  )
  scheduleSync(tenantId)
  return { id, tenantId, schedule, timezone, createdAt: '' }
}

function createEvent(
  tenantId: string,
  topic: string,
  filter?: Record<string, unknown>,
): EventConfig {
  const db = getDb()
  const id = crypto.randomUUID()
  db.exec(
    `INSERT INTO event_config (id, tenant_id, topic, filter)
     VALUES (?, ?, ?, ?)`,
    id,
    tenantId,
    topic,
    filter ? JSON.stringify(filter) : null,
  )
  scheduleSync(tenantId)
  return { id, tenantId, topic, filter: filter ?? null, createdAt: '' }
}

function createFile(
  tenantId: string,
  agentId: string,
  path: string,
): FileConfig {
  const db = getDb()
  const agent = db.prepare(
    'SELECT id FROM agent WHERE id = ? AND tenant_id = ?',
  ).get(agentId, tenantId)
  if (!agent) throw new Error('Agent not found in tenant')

  const id = crypto.randomUUID()
  db.exec(
    `INSERT INTO file_config (id, tenant_id, agent_id, path)
     VALUES (?, ?, ?, ?)`,
    id,
    tenantId,
    agentId,
    path,
  )
  scheduleSync(tenantId)
  return { id, tenantId, agentId, path, createdAt: '' }
}

function getWebhook(id: string, tenantId: string): WebhookConfig | null {
  const db = getDb()
  const row = db.prepare(
    'SELECT * FROM webhook_config WHERE id = ? AND tenant_id = ?',
  ).get(id, tenantId) as {
    id: string
    tenant_id: string
    url: string | null
    method: string
    headers: string | null
    created_at: string
  } | undefined
  if (!row) return null
  return {
    id: row.id,
    tenantId: row.tenant_id,
    url: row.url,
    method: row.method,
    headers: row.headers ? JSON.parse(row.headers) : null,
    createdAt: row.created_at,
  }
}

function listByType(
  tenantId: string,
  type: 'webhook' | 'cron' | 'event' | 'file',
): unknown[] {
  const db = getDb()
  const table = `${type}_config`
  return db.prepare(
    `SELECT * FROM ${table} WHERE tenant_id = ? ORDER BY created_at`,
  ).all(tenantId)
}

function remove(
  type: 'webhook' | 'cron' | 'event' | 'file',
  id: string,
  tenantId: string,
): void {
  const db = getDb()
  const table = `${type}_config`
  db.exec(
    `DELETE FROM ${table} WHERE id = ? AND tenant_id = ?`,
    id,
    tenantId,
  )
  scheduleSync(tenantId)
}

export {
  createCron,
  createEvent,
  createFile,
  createWebhook,
  getWebhook,
  listByType,
  remove,
}
export type { CronConfig, EventConfig, FileConfig, WebhookConfig }

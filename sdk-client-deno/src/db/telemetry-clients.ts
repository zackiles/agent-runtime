import { encodeBase64Url } from '@std/encoding/base64url'
import { getDb, scheduleSync } from './mod.ts'

const KEY_ENV = 'live'

type Client = {
  id: string
  tenantId: string
  name: string
  keyPrefix: string
  keyLastFour: string
  createdBy: string
  createdAt: string
  rotatedAt: string | null
  lastUsedAt: string | null
  revoked: boolean
}

type Created = { client: Client; key: string }

type Row = {
  id: string
  tenant_id: string
  name: string
  key_hash: string
  key_prefix: string
  key_last_four: string
  created_by: string
  created_at: string
  rotated_at: string | null
  last_used_at: string | null
  revoked: number
}

function mapRow(r: Row): Client {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    keyPrefix: r.key_prefix,
    keyLastFour: r.key_last_four,
    createdBy: r.created_by,
    createdAt: r.created_at.endsWith('Z') ? r.created_at : r.created_at + 'Z',
    rotatedAt: r.rotated_at,
    lastUsedAt: r.last_used_at,
    revoked: r.revoked === 1,
  }
}

function secret(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return encodeBase64Url(bytes)
}

async function hash(key: string): Promise<string> {
  const pepper = Deno.env.get('AR_TELEMETRY_KEY_PEPPER') || ''
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(pepper + key),
  )
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function newKey(
  tenantId: string,
): Promise<{ key: string; prefix: string; lastFour: string; keyHash: string }> {
  const sec = secret()
  const prefix = `artk.${KEY_ENV}.${tenantId}`
  const key = `${prefix}.${sec}`
  return {
    key,
    prefix,
    lastFour: sec.slice(-4),
    keyHash: await hash(key),
  }
}

async function create(opts: {
  tenantId: string
  name: string
  createdBy: string
}): Promise<Created> {
  const db = getDb()
  const id = crypto.randomUUID()
  const { key, prefix, lastFour, keyHash } = await newKey(opts.tenantId)
  db.exec(
    `INSERT INTO telemetry_client
       (id, tenant_id, name, key_hash, key_prefix, key_last_four, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    opts.tenantId,
    opts.name,
    keyHash,
    prefix,
    lastFour,
    opts.createdBy,
  )
  scheduleSync(opts.tenantId)
  return { client: get(opts.tenantId, id)!, key }
}

function list(tenantId: string): Client[] {
  const db = getDb()
  const rows = db.prepare(
    `SELECT * FROM telemetry_client
     WHERE tenant_id = ?
     ORDER BY created_at DESC`,
  ).all(tenantId) as Row[]
  return rows.map(mapRow)
}

function get(tenantId: string, id: string): Client | null {
  const db = getDb()
  const row = db.prepare(
    'SELECT * FROM telemetry_client WHERE id = ? AND tenant_id = ?',
  ).get(id, tenantId) as Row | undefined
  return row ? mapRow(row) : null
}

function getByHash(keyHash: string): Client | null {
  const db = getDb()
  const row = db.prepare(
    'SELECT * FROM telemetry_client WHERE key_hash = ?',
  ).get(keyHash) as Row | undefined
  return row ? mapRow(row) : null
}

async function rotate(
  tenantId: string,
  id: string,
): Promise<Created | null> {
  const db = getDb()
  if (!get(tenantId, id)) return null
  const { key, prefix, lastFour, keyHash } = await newKey(tenantId)
  db.exec(
    `UPDATE telemetry_client
     SET key_hash = ?, key_prefix = ?, key_last_four = ?,
         rotated_at = datetime('now'), revoked = 0
     WHERE id = ? AND tenant_id = ?`,
    keyHash,
    prefix,
    lastFour,
    id,
    tenantId,
  )
  scheduleSync(tenantId)
  return { client: get(tenantId, id)!, key }
}

function remove(tenantId: string, id: string): boolean {
  const db = getDb()
  const result = db.exec(
    'UPDATE telemetry_client SET revoked = 1 WHERE id = ? AND tenant_id = ?',
    id,
    tenantId,
  )
  scheduleSync(tenantId)
  return result > 0
}

function touch(tenantId: string, id: string): void {
  const db = getDb()
  db.exec(
    `UPDATE telemetry_client SET last_used_at = datetime('now')
     WHERE id = ? AND tenant_id = ?`,
    id,
    tenantId,
  )
}

export { create, get, getByHash, hash, list, remove, rotate, touch }
export type { Client, Created }

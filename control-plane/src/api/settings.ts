import { Hono } from '@hono/hono'
import { context } from '../types.ts'
import type { Env } from '../types.ts'
import {
  adminCount,
  ensure,
  list as listUsers,
  remove as removeUser,
  setAdmin,
} from '@ar/client/db/users'
import { query as auditQuery } from '@ar/client/db/audit'
import { query as telemetryQuery } from '@ar/client/db/telemetry'
import { load as loadRuntime } from '@ar/client/runtime'
import { getDb } from '@ar/client/db'
import platform from '@ar/client/platform'

const app = new Hono<Env>()

app.use('*', async (c, next) => {
  const { isAdmin } = context(c)
  if (!isAdmin) return c.json({ error: 'Admin only' }, 403)
  await next()
})

app.get('/users', (c) => {
  return c.json(listUsers())
})

app.post('/users', async (c) => {
  const body = await c.req.json() as {
    email: string
    role?: 'admin' | 'member'
  }
  if (!body.email) return c.json({ error: 'email required' }, 400)
  ensure(body.email)
  setAdmin(body.email, body.role === 'admin')
  return c.json({ ok: true })
})

const SYSTEM_USER = 'system@ar-cli'

app.put('/users/:email', async (c) => {
  const email = decodeURIComponent(c.req.param('email'))
  if (email === SYSTEM_USER) {
    return c.json({ error: 'Cannot modify the system user' }, 403)
  }
  const body = await c.req.json() as { role: 'admin' | 'member' }
  if (!body.role) return c.json({ error: 'role required' }, 400)

  if (body.role !== 'admin' && adminCount() <= 1) {
    const existing = listUsers().find((u) => u.id === email)
    if (existing?.isAdmin) {
      return c.json({ error: 'Cannot demote the last admin' }, 409)
    }
  }

  setAdmin(email, body.role === 'admin')
  return c.json({ ok: true })
})

app.delete('/users/:email', (c) => {
  const email = decodeURIComponent(c.req.param('email'))
  if (email === SYSTEM_USER) {
    return c.json({ error: 'Cannot remove the system user' }, 403)
  }
  const existing = listUsers().find((u) => u.id === email)
  if (!existing) return c.json({ error: 'User not found' }, 404)

  if (existing.isAdmin && adminCount() <= 1) {
    return c.json({ error: 'Cannot remove the last admin' }, 409)
  }

  removeUser(email)
  return c.json({ ok: true })
})

app.get('/tenants', async (c) => {
  const rc = loadRuntime()
  const tenants = rc.tenants.bootstrapped
  const project = Deno.env.get('GCP_PROJECT') ||
    Deno.env.get('GOOGLE_CLOUD_PROJECT') || ''
  const bucket = project ? `${project}-ar-registry` : ''

  const results = await Promise.all(tenants.map(async (id) => {
    let userCount = 0
    try {
      const db = getDb()
      const row = db.prepare(
        'SELECT COUNT(*) as cnt FROM user',
      ).get() as { cnt: number } | undefined
      userCount = row?.cnt ?? 0
    } catch { /* tenant DB might not be open */ }

    let files = 0
    let bytes = 0
    if (bucket) {
      try {
        const token = await platform.getAccessToken()
        let pageToken = ''
        do {
          const params = new URLSearchParams({
            prefix: `${id}/`,
            fields: 'items(size),nextPageToken',
            maxResults: '1000',
          })
          if (pageToken) params.set('pageToken', pageToken)
          const res = await fetch(
            `https://storage.googleapis.com/storage/v1/b/${bucket}/o?${params}`,
            { headers: { 'Authorization': `Bearer ${token}` } },
          )
          if (!res.ok) break
          const data = await res.json() as {
            items?: { size?: string }[]
            nextPageToken?: string
          }
          for (const item of data.items || []) {
            files++
            bytes += parseInt(item.size || '0', 10)
          }
          pageToken = data.nextPageToken || ''
        } while (pageToken)
      } catch { /* storage not available */ }
    }

    return { id, userCount, files, bytes }
  }))

  return c.json(results)
})

type GcsItem = {
  name: string
  size: string
  updated: string
}

app.get('/storage', async (c) => {
  const { tenantId } = context(c)
  const project = Deno.env.get('GCP_PROJECT') ||
    Deno.env.get('GOOGLE_CLOUD_PROJECT') || ''
  const bucket = project ? `${project}-ar-registry` : ''
  if (!bucket) return c.json({ error: 'Storage not configured' }, 500)

  const items: GcsItem[] = []
  let token: string
  try {
    token = await platform.getAccessToken()
  } catch {
    return c.json({ error: 'Cannot authenticate to GCS' }, 500)
  }

  let pageToken = ''
  do {
    const params = new URLSearchParams({
      prefix: `${tenantId}/`,
      fields: 'items(name,size,updated),nextPageToken',
      maxResults: '1000',
    })
    if (pageToken) params.set('pageToken', pageToken)
    const res = await fetch(
      `https://storage.googleapis.com/storage/v1/b/${bucket}/o?${params}`,
      { headers: { 'Authorization': `Bearer ${token}` } },
    )
    if (!res.ok) break
    const data = await res.json() as {
      items?: GcsItem[]
      nextPageToken?: string
    }
    items.push(...(data.items || []))
    pageToken = data.nextPageToken || ''
  } while (pageToken)

  const totalBytes = items.reduce(
    (sum, i) => sum + parseInt(i.size || '0', 10),
    0,
  )
  return c.json({ items, totalFiles: items.length, totalBytes })
})

app.get('/activity', (c) => {
  const { tenantId } = context(c)
  const now = Date.now()
  const day = 86_400_000
  const boundaries = [
    { label: '24h', from: now - day },
    { label: '7d', from: now - 7 * day },
    { label: '30d', from: now - 30 * day },
  ]

  const db = getDb()
  const telemetryCounts: Record<string, number> = {}
  const auditCounts: Record<string, number> = {}

  for (const b of boundaries) {
    const iso = new Date(b.from).toISOString()
    try {
      const tRow = db.prepare(
        `SELECT COUNT(*) as cnt FROM telemetry
         WHERE tenant_id = ? AND created_at >= ?`,
      ).get(tenantId, iso) as { cnt: number } | undefined
      telemetryCounts[b.label] = tRow?.cnt ?? 0
    } catch {
      telemetryCounts[b.label] = 0
    }
    try {
      const aRow = db.prepare(
        `SELECT COUNT(*) as cnt FROM audit
         WHERE tenant_id = ? AND created_at >= ?`,
      ).get(tenantId, iso) as { cnt: number } | undefined
      auditCounts[b.label] = aRow?.cnt ?? 0
    } catch {
      auditCounts[b.label] = 0
    }
  }

  const recentAudit = auditQuery({
    tenantId,
    limit: 20,
  })

  const recentTelemetry = telemetryQuery({
    tenantId,
    limit: 20,
  })

  return c.json({
    telemetry: telemetryCounts,
    audit: auditCounts,
    recentAudit,
    recentTelemetry,
  })
})

app.get('/backup', async (c) => {
  const { tenantId } = context(c)
  const dbBase = Deno.env.get('AR_DB_PATH') || '/data'
  const path = `${dbBase}/${tenantId}.db`

  try {
    const data = await Deno.readFile(path)
    const cs = new CompressionStream('gzip')
    const compressed = new Blob([data]).stream().pipeThrough(cs)
    const gzipped = await new Response(compressed).arrayBuffer()

    return new Response(gzipped, {
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${tenantId}.db.gz"`,
      },
    })
  } catch {
    return c.json({ error: 'Database file not found' }, 404)
  }
})

export default app

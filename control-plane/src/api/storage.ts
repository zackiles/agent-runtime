import { Hono } from '@hono/hono'
import { context } from '../types.ts'
import type { Env } from '../types.ts'
import platform from '@ar/client/platform'

const app = new Hono<Env>()

function tenantBucket(): string {
  const project = Deno.env.get('GCP_PROJECT') ||
    Deno.env.get('GOOGLE_CLOUD_PROJECT') || ''
  return project ? `${project}-ar-registry` : ''
}

function validatePath(
  tenantId: string,
  path: string,
): { ok: true } | { ok: false; error: string } {
  const normalized = path.replace(/\\/g, '/').replace(/\/+/g, '/')
  if (normalized.includes('..')) {
    return { ok: false, error: 'Path traversal not allowed' }
  }
  if (!normalized.startsWith(`${tenantId}/`)) {
    return { ok: false, error: 'Path must be within tenant scope' }
  }
  return { ok: true }
}

app.get('/list', async (c) => {
  const { tenantId } = context(c)
  const bucket = tenantBucket()
  if (!bucket) return c.json({ error: 'Storage not configured' }, 500)

  const prefix = c.req.query('prefix') || `${tenantId}/`
  if (!prefix.startsWith(`${tenantId}/`)) {
    return c.json({ error: 'Prefix must be within tenant scope' }, 403)
  }
  const items = await platform.storageList(bucket, prefix)
  return c.json(items)
})

app.get('/sign', async (c) => {
  const { tenantId } = context(c)
  const bucket = tenantBucket()
  if (!bucket) return c.json({ error: 'Storage not configured' }, 500)

  const path = c.req.query('path')
  const method = c.req.query('method') || 'GET'
  const contentType = c.req.query('contentType') || ''
  const rawTtl = parseInt(c.req.query('ttl') || '300')

  if (!path) return c.json({ error: 'path required' }, 400)
  if (method !== 'GET' && method !== 'PUT') {
    return c.json({ error: 'method must be GET or PUT' }, 400)
  }
  if (!Number.isFinite(rawTtl) || rawTtl < 1 || rawTtl > 3600) {
    return c.json({ error: 'ttl must be between 1 and 3600' }, 400)
  }
  const ttl = rawTtl

  const check = validatePath(tenantId, path)
  if (!check.ok) return c.json({ error: check.error }, 403)

  const url = await platform.storageSign(
    bucket,
    path,
    method,
    ttl,
    contentType,
  )
  const expires = new Date(Date.now() + ttl * 1000).toISOString()
  return c.json({ url, expires })
})

app.get('/exists', async (c) => {
  const { tenantId } = context(c)
  const bucket = tenantBucket()
  if (!bucket) return c.json({ error: 'Storage not configured' }, 500)

  const path = c.req.query('path')
  if (!path) return c.json({ error: 'path required' }, 400)

  const check = validatePath(tenantId, path)
  if (!check.ok) return c.json({ error: check.error }, 403)

  const result = await platform.storageExists(bucket, path)
  return c.json({ exists: result })
})

app.delete('/', async (c) => {
  const { tenantId } = context(c)
  const bucket = tenantBucket()
  if (!bucket) return c.json({ error: 'Storage not configured' }, 500)

  const path = c.req.query('path')
  if (!path) return c.json({ error: 'path required' }, 400)

  const check = validatePath(tenantId, path)
  if (!check.ok) return c.json({ error: check.error }, 403)

  await platform.storageDelete(bucket, path)
  return c.json({ message: 'Deleted' })
})

export default app

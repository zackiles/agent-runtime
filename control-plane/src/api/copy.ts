import { Hono } from '@hono/hono'
import { context } from '../types.ts'
import type { Env } from '../types.ts'
import { getDb } from '@ar/client/db'
import { execute, plan } from '@ar/client/db/copy'
import { isAdmin } from '@ar/client/db/users'

const app = new Hono<Env>()

// IMPORTANT: Cross-tenant copy is currently by design. There is no per-tenant
// authorization gate — any authenticated user can access any tenant by setting
// the header. This may change in the future. See docs/iam.md for details.

app.get('/options', (c) => {
  const { isAdmin: admin } = context(c)
  const db = getDb()

  const agents = db.prepare(
    admin
      ? 'SELECT DISTINCT slug, name, visibility, tenant_id as tenantId FROM agent ORDER BY name'
      : "SELECT DISTINCT slug, name, visibility, tenant_id as tenantId FROM agent WHERE visibility = 'public' ORDER BY name",
  ).all() as Array<{
    slug: string
    name: string
    visibility: string
    tenantId: string
  }>

  const tenants = db.prepare(
    'SELECT id, name FROM tenant ORDER BY name',
  ).all() as Array<{ id: string; name: string }>

  return c.json({ isAdmin: admin, agents, tenants })
})

app.post('/preview', async (c) => {
  const { tenantId, email } = context(c)
  const body = await c.req.json() as {
    slug: string
    targetTenant: string
    visibility?: string
  }
  const visibility = body.visibility ?? 'private'

  if (visibility === 'public' && !isAdmin(email)) {
    return c.json(
      { error: 'Only admins can copy to a public registry' },
      403,
    )
  }

  const copyPlan = plan(body.slug, tenantId, body.targetTenant)
  return c.json(copyPlan)
})

app.post('/', async (c) => {
  const { tenantId, email } = context(c)
  const body = await c.req.json() as {
    slug: string
    targetTenant: string
    visibility?: string
  }
  const visibility = body.visibility ?? 'private'

  if (visibility === 'public' && !isAdmin(email)) {
    return c.json(
      { error: 'Only admins can copy to a public registry' },
      403,
    )
  }

  const copyPlan = plan(body.slug, tenantId, body.targetTenant)
  const report = execute(copyPlan, email)
  return c.json(report)
})

export default app

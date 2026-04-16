import { Hono } from '@hono/hono'
import { context } from '../types.ts'
import type { Env } from '../types.ts'
import {
  set as runtimeSet,
  status as runtimeStatus,
} from '@ar/client/operations/runtime'
import { registryProtected, setRegistryProtected } from '@ar/client/db/access'
import { isAdmin } from '@ar/client/db/users'

const project = Deno.env.get('GCP_PROJECT') ||
  Deno.env.get('GOOGLE_CLOUD_PROJECT') || ''
const region = Deno.env.get('GCP_REGION') || ''

const app = new Hono<Env>()

app.get('/status', async (c) => {
  await runtimeStatus({ project, region })
  return c.json({ message: 'Status fetched' })
})

app.put('/settings', async (c) => {
  const body = await c.req.json() as { option: string; value: string }
  await runtimeSet({ ...body, force: true, project, region })
  return c.json({ message: 'Setting updated' })
})

app.get('/tenant', (c) => {
  const { tenantId } = context(c)
  return c.json({
    tenantId,
    registryProtected: registryProtected(tenantId),
  })
})

app.put('/tenant', async (c) => {
  const { tenantId, email } = context(c)
  if (!isAdmin(email)) {
    return c.json(
      { error: 'Only admins can change tenant settings' },
      403,
    )
  }
  const body = await c.req.json() as { registryProtected?: boolean }
  if (body.registryProtected !== undefined) {
    setRegistryProtected(tenantId, body.registryProtected)
  }
  return c.json({ message: 'Tenant settings updated' })
})

export default app

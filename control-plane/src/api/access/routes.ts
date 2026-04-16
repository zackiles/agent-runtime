import { Hono } from '@hono/hono'
import { context } from '../../types.ts'
import type { Env } from '../../types.ts'
import platform from '@ar/client/platform'
import { slugify } from '@ar/client/operations/demos'
import logger from '@ar/client/utils/logger'
import type { AccessGrant } from './grants.ts'
import {
  findAccessAgent,
  invokeAgent,
  loadGrant,
  storeGrant,
} from './grants.ts'

type AccessRequest = {
  resource: string
  description: string
  scope?: 'private' | 'public'
}

type AccessCallback = {
  context: string
}

function gcpProject(): string {
  return Deno.env.get('GCP_PROJECT') ||
    Deno.env.get('GOOGLE_CLOUD_PROJECT') || ''
}

function gcpRegion(): string {
  return Deno.env.get('GCP_REGION') || ''
}

const app = new Hono<Env>()

app.get('/', async (c) => {
  const { tenantId, email } = context(c)
  const project = gcpProject()
  const bucket = `${project}-ar-registry`
  const prefix = `${tenantId}/access/${email}`

  try {
    const paths = await platform.storageList(bucket, prefix)
    const metaPaths = paths.filter((p) => p.endsWith('/grant.json'))
    const grants: AccessGrant[] = []
    for (const p of metaPaths) {
      try {
        const data = await platform.storageDownload(bucket, p)
        grants.push(
          JSON.parse(new TextDecoder().decode(data)) as AccessGrant,
        )
      } catch {
        continue
      }
    }
    return c.json(grants)
  } catch {
    return c.json([])
  }
})

app.post('/', async (c) => {
  const { tenantId, email, isAdmin } = context(c)
  const body = await c.req.json() as AccessRequest

  if (!body.resource) {
    return c.json({ error: 'resource is required' }, 400)
  }

  const scope = body.scope || 'private'
  if (scope === 'public' && !isAdmin) {
    return c.json(
      { error: 'Admin privileges required for public scope' },
      403,
    )
  }

  const project = gcpProject()
  const bucket = `${project}-ar-registry`
  const resourceSlug = slugify(body.resource)
  const grantId = `${resourceSlug}-${Date.now()}`

  const found = await findAccessAgent(bucket, tenantId)
  if (!found) {
    return c.json({
      error: 'access-agent not deployed. Deploy it first.',
    }, 503)
  }

  const payload = {
    resource: body.resource,
    description: body.description || '',
    scope,
    grantId,
  }

  try {
    const result = await invokeAgent(found, payload)

    const grant: AccessGrant = {
      id: grantId,
      resource: body.resource,
      scope,
      status: 'pending',
      demoUrl: result.demoUrl || '',
      instructions: result.instructions || '',
      createdBy: email,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    await storeGrant(project, tenantId, email, grant)

    return c.json(grant, 201)
  } catch (err) {
    logger.error('Access request failed', err)
    return c.json({
      error: err instanceof Error ? err.message : 'Unknown error',
    }, 500)
  }
})

app.post('/callback', async (c) => {
  const { tenantId, email, isAdmin } = context(c)
  const body = await c.req.json() as AccessCallback

  if (!body.context) {
    return c.json({ error: 'context is required' }, 400)
  }

  let decoded: {
    type?: string
    resource?: string
    data?: Record<string, string>
    scope?: string
    grantId?: string
  }
  try {
    decoded = JSON.parse(atob(body.context))
  } catch {
    return c.json({ error: 'Invalid context string' }, 400)
  }

  if (decoded.grantId) {
    const existing = await loadGrant(
      gcpProject(),
      tenantId,
      email,
      decoded.grantId,
    )
    if (!existing || existing.status !== 'pending') {
      return c.json(
        { error: 'No matching pending grant for this callback' },
        403,
      )
    }
  }

  const scope = decoded.scope || 'private'
  if (scope === 'public' && !isAdmin) {
    return c.json(
      { error: 'Admin privileges required for public scope' },
      403,
    )
  }

  const project = gcpProject()
  const region = gcpRegion()
  const resource = slugify(decoded.resource || 'unknown')
  const data = decoded.data || {}
  const secretPrefix = `access-${resource}`
  const configured: string[] = []

  for (const [key, value] of Object.entries(data)) {
    const secretName = `${secretPrefix}-${slugify(key)}`
    try {
      await platform.secretCreate(secretName, project, region)
    } catch {
      // may already exist
    }
    try {
      await platform.secretAddVersion(
        secretName,
        project,
        typeof value === 'string' ? value : JSON.stringify(value),
      )
      configured.push(secretName)
      logger.info('Access secret configured', {
        name: secretName,
        scope,
        resource,
      })
    } catch (err) {
      logger.warn('Secret set failed', {
        name: secretName,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  if (decoded.grantId) {
    try {
      const grant = await loadGrant(
        project,
        tenantId,
        email,
        decoded.grantId,
      )
      if (grant) {
        grant.status = 'configured'
        grant.secrets = configured
        grant.updatedAt = new Date().toISOString()
        await storeGrant(project, tenantId, email, grant)
      }
    } catch {
      logger.warn('Grant update failed')
    }
  }

  return c.json({
    status: 'configured',
    resource,
    scope,
    secrets: configured,
  })
})

app.get('/:id', async (c) => {
  const { tenantId, email } = context(c)
  const project = gcpProject()
  const grant = await loadGrant(
    project,
    tenantId,
    email,
    c.req.param('id'),
  )
  if (!grant) return c.json({ error: 'Not found' }, 404)
  return c.json(grant)
})

app.delete('/:id', async (c) => {
  const { tenantId, email } = context(c)
  const project = gcpProject()
  const bucket = `${project}-ar-registry`
  const path = `${tenantId}/access/${email}/${c.req.param('id')}/grant.json`

  try {
    await platform.storageDelete(bucket, path)
    return c.json({ message: 'Deleted' })
  } catch (err) {
    return c.json({
      error: err instanceof Error ? err.message : 'Delete failed',
    }, 500)
  }
})

export default app

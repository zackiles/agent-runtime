import { Hono } from '@hono/hono'
import { context } from '../types.ts'
import type { Env } from '../types.ts'
import {
  cloneEntity,
  createEntity,
  createVersion,
  getEntity,
  getEntityBySlug,
  listEntities,
  listPrivateEntities,
  listPublicEntities,
  listVersions,
  promoteToPublic,
  removeEntity,
  removeVersion,
  switchVersion,
  updateEntity,
  updateGcsPath,
} from '@ar/client/db/registry'
import type { EntityTable } from '@ar/client/db/registry'
import {
  addOwner,
  canManageOwners,
  canPublish,
  canRead,
  canWrite,
  getOwners,
  removeOwner,
} from '@ar/client/db/access'
import { isAdmin } from '@ar/client/db/users'
import { MAX_DESCRIPTION_LENGTH } from '@ar/client/tool-schema'
import platform from '@ar/client/platform'

function registryRoutes(table: EntityTable): Hono<Env> {
  const app = new Hono<Env>()

  app.post('/', async (c) => {
    const { tenantId, email } = context(c)
    const body = await c.req.json() as {
      name: string
      slug?: string
      visibility?: string
      config?: Record<string, unknown>
    }
    const visibility = body.visibility ?? 'private'
    if (
      visibility === 'public' &&
      !canPublish(tenantId, email, 'public')
    ) {
      return c.json(
        { error: 'No permission to publish to public registry' },
        403,
      )
    }
    const slug = body.slug ||
      body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')

    if (table === 'tool' && body.config) {
      const desc = body.config.description as string | undefined
      if (desc && desc.length > MAX_DESCRIPTION_LENGTH) {
        return c.json({
          error: `Tool description must be ${MAX_DESCRIPTION_LENGTH}` +
            ` characters or fewer (currently ${desc.length}).`,
        }, 400)
      }
    }

    const existing = getEntityBySlug(table, tenantId, slug)
    if (existing) return c.json(existing, 200)

    const opts: {
      visibility?: string
      config?: Record<string, unknown>
    } = {}
    if (body.visibility) opts.visibility = body.visibility
    if (body.config) opts.config = body.config
    const entity = createEntity(
      table,
      tenantId,
      body.name,
      slug,
      email,
      opts,
    )
    return c.json(entity, 201)
  })

  app.get('/', (c) => {
    const { tenantId, email } = context(c)
    const visibility = c.req.query('visibility')
    if (visibility === 'public') {
      return c.json(listPublicEntities(table, tenantId))
    }
    if (visibility === 'private') {
      return c.json(listPrivateEntities(table, tenantId, email))
    }
    return c.json(listEntities(table, tenantId, email))
  })

  app.get('/:id', (c) => {
    const { tenantId, email } = context(c)
    const entityId = c.req.param('id')
    const entity = getEntityBySlug(table, tenantId, entityId) ||
      getEntity(table, entityId, tenantId)
    if (!entity) return c.json({ error: 'Not found' }, 404)
    if (!canRead(tenantId, table, entity.id, email)) {
      return c.json({ error: 'No permission' }, 403)
    }
    return c.json(entity)
  })

  app.put('/:id', async (c) => {
    const { tenantId, email } = context(c)
    const entityId = c.req.param('id')
    const entity = getEntityBySlug(table, tenantId, entityId) ||
      getEntity(table, entityId, tenantId)
    if (!entity) return c.json({ error: 'Not found' }, 404)
    if (!canWrite(tenantId, table, entity.id, email)) {
      return c.json({ error: 'No permission' }, 403)
    }
    const body = await c.req.json() as {
      name?: string
      config?: Record<string, unknown>
      visibility?: string
      content?: string
    }
    if (
      body.visibility === 'public' &&
      entity.visibility !== 'public' &&
      !canPublish(tenantId, email, 'public')
    ) {
      return c.json(
        { error: 'No permission to publish to public registry' },
        403,
      )
    }
    if (
      body.visibility === 'private' &&
      entity.visibility === 'public' &&
      !isAdmin(email)
    ) {
      return c.json(
        { error: 'Only admins can unpublish from public registry' },
        403,
      )
    }
    const updated = updateEntity(
      table,
      entity.id,
      tenantId,
      body,
      email,
    )
    return c.json(updated)
  })

  app.get('/:id/versions', (c) => {
    const { tenantId, email } = context(c)
    const entityId = c.req.param('id')
    const entity = getEntityBySlug(table, tenantId, entityId) ||
      getEntity(table, entityId, tenantId)
    if (!entity) return c.json({ error: 'Not found' }, 404)
    if (!canRead(tenantId, table, entity.id, email)) {
      return c.json({ error: 'No permission' }, 403)
    }
    return c.json(listVersions(table, tenantId, entity.slug))
  })

  app.post('/:id/versions', async (c) => {
    const { tenantId, email } = context(c)
    const entityId = c.req.param('id')
    const entity = getEntityBySlug(table, tenantId, entityId) ||
      getEntity(table, entityId, tenantId)
    if (!entity) return c.json({ error: 'Not found' }, 404)
    if (!canWrite(tenantId, table, entity.id, email)) {
      return c.json({ error: 'No permission' }, 403)
    }
    const body = await c.req.json() as {
      version: string
      content?: string
      config?: Record<string, unknown>
    }
    if (!body.version) {
      return c.json({ error: 'version is required' }, 400)
    }
    try {
      const created = createVersion(
        table,
        tenantId,
        entity.slug,
        body.version,
        email,
        {
          ...(body.content !== undefined ? { content: body.content } : {}),
          ...(body.config !== undefined ? { config: body.config } : {}),
        },
      )
      return c.json(created, 201)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed'
      return c.json({ error: msg }, 400)
    }
  })

  app.put('/:id/version', async (c) => {
    const { tenantId, email } = context(c)
    const entityId = c.req.param('id')
    const entity = getEntityBySlug(table, tenantId, entityId) ||
      getEntity(table, entityId, tenantId)
    if (!entity) return c.json({ error: 'Not found' }, 404)
    if (!canWrite(tenantId, table, entity.id, email)) {
      return c.json({ error: 'No permission' }, 403)
    }
    const body = await c.req.json() as { version: string }
    if (!body.version) {
      return c.json({ error: 'version is required' }, 400)
    }
    switchVersion(table, tenantId, entity.slug, body.version)
    return c.json({ message: 'Version switched', version: body.version })
  })

  app.delete('/:id/versions/:version', (c) => {
    const { tenantId, email } = context(c)
    const entityId = c.req.param('id')
    const entity = getEntityBySlug(table, tenantId, entityId) ||
      getEntity(table, entityId, tenantId)
    if (!entity) return c.json({ error: 'Not found' }, 404)
    if (!canWrite(tenantId, table, entity.id, email)) {
      return c.json({ error: 'No permission' }, 403)
    }
    removeVersion(
      table,
      tenantId,
      entity.slug,
      c.req.param('version'),
      email,
    )
    return c.json({ message: 'Version deleted' })
  })

  app.post('/:id/deploy', async (c) => {
    const { tenantId, email } = context(c)
    const entityId = c.req.param('id')

    const entity = getEntityBySlug(table, tenantId, entityId)
    if (!entity) {
      return c.json({ error: `${table} not found` }, 404)
    }

    if (!canWrite(tenantId, table, entity.id, email)) {
      return c.json(
        { error: 'No permission to deploy this entity' },
        403,
      )
    }

    const body = await c.req.arrayBuffer()
    const archive = new Uint8Array(body)
    const project = Deno.env.get('GCP_PROJECT') ||
      Deno.env.get('GOOGLE_CLOUD_PROJECT') || ''
    const bucket = `${project}-ar-registry`
    const version = entity.version || '0.0.1'
    const gcsPath =
      `${tenantId}/${table}s/${entity.slug}/${version}/archive.tar.gz`

    await platform.storageUpload(bucket, gcsPath, archive)
    updateGcsPath(table, entity.id, tenantId, gcsPath)

    return c.json({
      message: `${table} '${entity.slug}' deployed`,
      gcsPath,
    })
  })

  app.post('/:id/clone', (c) => {
    const { tenantId, email } = context(c)
    const entityId = c.req.param('id')
    if (!canRead(tenantId, table, entityId, email)) {
      return c.json(
        { error: 'No permission to clone this entity' },
        403,
      )
    }
    const entity = cloneEntity(table, entityId, tenantId, email)
    return c.json(entity, 201)
  })

  app.delete('/:id', (c) => {
    const { tenantId, email } = context(c)
    const entityId = c.req.param('id')
    const entity = getEntityBySlug(table, tenantId, entityId) ||
      getEntity(table, entityId, tenantId)
    if (!entity) return c.json({ error: 'Not found' }, 404)
    if (!canWrite(tenantId, table, entity.id, email)) {
      return c.json(
        { error: 'No permission to delete this entity' },
        403,
      )
    }
    removeEntity(table, entity.id, tenantId, email)
    return c.json({ message: 'Deleted' })
  })

  app.get('/:id/owners', (c) => {
    const { tenantId } = context(c)
    const entityId = c.req.param('id')
    const entity = getEntity(table, entityId, tenantId)
    if (!entity) return c.json({ error: 'Not found' }, 404)
    const owners = getOwners(table, entityId)
    return c.json({ owners })
  })

  app.post('/:id/owners', async (c) => {
    const { tenantId, email } = context(c)
    const entityId = c.req.param('id')
    if (!canManageOwners(tenantId, table, entityId, email)) {
      return c.json(
        { error: 'No permission to manage owners' },
        403,
      )
    }
    const body = await c.req.json() as { owner: string }
    addOwner(table, entityId, body.owner)
    return c.json({ message: 'Owner added' })
  })

  app.delete('/:id/owners/:ownerId', (c) => {
    const { tenantId, email } = context(c)
    const entityId = c.req.param('id')
    if (!canManageOwners(tenantId, table, entityId, email)) {
      return c.json(
        { error: 'No permission to manage owners' },
        403,
      )
    }
    removeOwner(table, entityId, c.req.param('ownerId'))
    return c.json({ message: 'Owner removed' })
  })

  app.get('/:id/files', async (c) => {
    const { tenantId, email } = context(c)
    const entityId = c.req.param('id')
    const entity = getEntityBySlug(table, tenantId, entityId) ||
      getEntity(table, entityId, tenantId)
    if (!entity) return c.json({ error: 'Not found' }, 404)
    if (!canRead(tenantId, table, entity.id, email)) {
      return c.json({ error: 'No permission' }, 403)
    }

    const project = Deno.env.get('GCP_PROJECT') ||
      Deno.env.get('GOOGLE_CLOUD_PROJECT') || ''
    const bucket = `${project}-ar-registry`
    const version = entity.version || '0.0.1'
    const prefix = `${tenantId}/${table}s/${entity.slug}/${version}/files/`
    const paths = await platform.storageList(bucket, prefix)
    const files = paths.map((p) => p.slice(prefix.length)).filter(Boolean)
    return c.json({ files, prefix })
  })

  app.post('/:id/files/sign', async (c) => {
    const { tenantId, email } = context(c)
    const entityId = c.req.param('id')
    const entity = getEntityBySlug(table, tenantId, entityId) ||
      getEntity(table, entityId, tenantId)
    if (!entity) return c.json({ error: 'Not found' }, 404)
    if (!canWrite(tenantId, table, entity.id, email)) {
      return c.json({ error: 'No permission' }, 403)
    }

    const body = await c.req.json() as {
      filename: string
      method?: string
      contentType?: string
    }
    if (!body.filename) return c.json({ error: 'filename required' }, 400)

    const project = Deno.env.get('GCP_PROJECT') ||
      Deno.env.get('GOOGLE_CLOUD_PROJECT') || ''
    const bucket = `${project}-ar-registry`
    const version = entity.version || '0.0.1'
    const method = body.method === 'GET' ? 'GET' : 'PUT'
    const gcsPath =
      `${tenantId}/${table}s/${entity.slug}/${version}/files/${body.filename}`
    const url = await platform.storageSign(
      bucket,
      gcsPath,
      method,
      600,
      body.contentType || '',
    )
    return c.json({ url, path: gcsPath })
  })

  app.post('/promote', async (c) => {
    const { tenantId, email } = context(c)
    if (!canPublish(tenantId, email, 'public')) {
      return c.json(
        { error: 'No permission to publish to public registry' },
        403,
      )
    }
    const body = await c.req.json() as { slug: string }
    if (!body.slug) {
      return c.json({ error: 'slug is required' }, 400)
    }
    const promoted = promoteToPublic(
      table,
      tenantId,
      body.slug,
      email,
    )
    if (!promoted) {
      return c.json(
        { error: 'Entity not found or already public' },
        404,
      )
    }
    return c.json(promoted)
  })

  return app
}

const tools = registryRoutes('tool')
const skills = registryRoutes('skill')
const rules = registryRoutes('rule')

skills.post('/import', async (c) => {
  const { tenantId, email } = context(c)
  const body = await c.req.json() as { url: string; name?: string }
  if (!body.url) {
    return c.json({ error: 'url is required' }, 400)
  }

  let repoUrl = body.url.trim()
  if (/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+$/.test(repoUrl)) {
    repoUrl = `https://github.com/${repoUrl}`
  }

  try {
    const rawBase = repoUrl.replace(/\.git$/, '')
      .replace('github.com', 'raw.githubusercontent.com')
    const mainRes = await fetch(`${rawBase}/main/SKILL.md`)
    let skillContent: string
    if (mainRes.ok) {
      skillContent = await mainRes.text()
    } else {
      const masterRes = await fetch(`${rawBase}/master/SKILL.md`)
      if (!masterRes.ok) {
        return c.json(
          { error: 'Could not fetch SKILL.md from repository' },
          400,
        )
      }
      skillContent = await masterRes.text()
    }

    const fmMatch = skillContent.match(/^---\n([\s\S]*?)\n---/)
    if (!fmMatch) {
      return c.json(
        { error: 'SKILL.md missing YAML frontmatter' },
        400,
      )
    }
    const block = fmMatch[1]
    const name = block.match(/^name:\s*(.+)$/m)?.[1]?.trim()
    const description = block.match(/^description:\s*(.+)$/m)?.[1]?.trim()
    if (!name || !description) {
      return c.json(
        { error: 'SKILL.md must have name and description' },
        400,
      )
    }

    const slug = name
    const skillBody = skillContent
      .slice(fmMatch[0].length)
      .replace(/^\n+/, '')

    const existing = getEntityBySlug('skill', tenantId, slug)
    if (existing) {
      return c.json(
        { error: `Skill '${slug}' already exists` },
        409,
      )
    }

    const entity = createEntity(
      'skill',
      tenantId,
      name,
      slug,
      email,
      {
        visibility: 'private',
        content: skillBody,
        config: { description, source: repoUrl },
      },
    )
    return c.json(entity, 201)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Import failed'
    return c.json({ error: msg }, 500)
  }
})

export { rules, skills, tools }

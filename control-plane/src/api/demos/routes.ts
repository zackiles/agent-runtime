import { Hono } from '@hono/hono'
import type { Context } from '@hono/hono'
import { context } from '../../types.ts'
import type { Env } from '../../types.ts'
import {
  deleteDemoStorage,
  downloadSource,
  listDemos,
  loadMeta,
  slugify,
  storeMeta,
} from '@ar/client/operations/demos'
import type { DemoMeta } from '@ar/client/operations/demos'
import platform from '@ar/client/platform'
import logger from '@ar/client/utils/logger'
import { DEFAULT_SUBSYSTEM } from '@ar/client/subsystems'
import { encodeBase64 } from '@std/encoding/base64'
import { ensure, list as listUsers } from '@ar/client/db/users'
import * as demoShares from '@ar/client/db/demo-shares'
import { log as auditLog } from '@ar/client/db/audit'
import { validateDomain } from '../../middleware/auth.ts'
import {
  deleteImage,
  deployContainer,
  destroyContainer,
  findDemoAgent,
  gcpConfig,
  invokeAgent,
  signFiles,
} from './deploy.ts'
import type { Visibility } from './deploy.ts'
import { can, isAmbiguous, resolveAccess } from './access.ts'
import type { Access, AccessRole, Action } from './access.ts'
import { notifyShare } from './notify.ts'

const DEFAULT_TTL_DAYS = 7

type FileRef = { name: string; path: string }

const app = new Hono<Env>()

function accessUrl(meta: DemoMeta, ownerId: string, role: AccessRole): string {
  if (meta.visibility !== 'private') return meta.url || `/web/d/${meta.name}`
  const base = `/web/d/${meta.name}`
  if (role === 'owner' || role === 'admin') return base
  return `${base}?owner=${encodeURIComponent(ownerId)}`
}

function decorate(
  meta: DemoMeta,
  ownerId: string,
  role: AccessRole,
): DemoMeta & { role: AccessRole; accessUrl: string } {
  return { ...meta, role, accessUrl: accessUrl(meta, ownerId, role) }
}

// Resolves the demo the caller is acting on and enforces the capability for the
// requested action. Returns a ready-to-send error Response on failure so route
// handlers stay flat.
async function gate(
  c: Context<Env>,
  action: Action,
): Promise<Access | Response> {
  const { tenantId, email, isAdmin } = context(c)
  const { project } = gcpConfig()
  const name = slugify(c.req.param('name') || '')
  const owner = c.req.query('owner') || undefined
  const access = await resolveAccess(
    project,
    tenantId,
    email,
    isAdmin,
    name,
    owner,
  )
  if (isAmbiguous(access)) {
    return c.json(
      { error: 'Ambiguous demo; specify ?owner=', owners: access.owners },
      409,
    )
  }
  if (!access) return c.json({ error: 'Demo not found' }, 404)
  if (!can(access.role, action)) return c.json({ error: 'Forbidden' }, 403)
  return access
}

app.get('/', async (c) => {
  const { tenantId, email, isAdmin } = context(c)
  const { project } = gcpConfig()
  const requestedUser = c.req.query('user')

  if (requestedUser && isAdmin && requestedUser !== email) {
    const demos = await listDemos(project, tenantId, requestedUser)
    return c.json(
      demos.map((d) => decorate(d, d.createdBy || requestedUser, 'admin')),
    )
  }

  const owned = await listDemos(project, tenantId, email)
  const result = owned.map((d) => decorate(d, email, 'owner'))
  const seen = new Set(owned.map((d) => `${email}:${d.name}`))

  for (const share of demoShares.forMember(tenantId, email)) {
    const key = `${share.ownerId}:${share.slug}`
    if (seen.has(key)) continue
    const meta = await loadMeta(project, tenantId, share.ownerId, share.slug)
    if (!meta) continue
    seen.add(key)
    result.push(decorate(meta, share.ownerId, share.role))
  }

  return c.json(result)
})

app.get('/members', (c) => {
  return c.json(
    listUsers().map((u) => ({ id: u.id, name: u.name, isAdmin: u.isAdmin })),
  )
})

app.get('/:name', async (c) => {
  const gated = await gate(c, 'view')
  if (gated instanceof Response) return gated
  return c.json(decorate(gated.meta, gated.ownerId, gated.role))
})

app.get('/:name/shares', async (c) => {
  const gated = await gate(c, 'manage-shares')
  if (gated instanceof Response) return gated
  const { tenantId } = context(c)
  const shares = demoShares.forDemo(tenantId, gated.ownerId, gated.meta.name)
  return c.json({ owner: gated.ownerId, shares })
})

app.post('/:name/shares', async (c) => {
  const gated = await gate(c, 'manage-shares')
  if (gated instanceof Response) return gated
  const { tenantId, email } = context(c)

  const body = await c.req.json().catch(() => ({})) as {
    member?: string
    role?: string
  }
  const member = (body.member || '').trim().toLowerCase()
  if (!member) return c.json({ error: 'member is required' }, 400)
  const role = body.role === 'editor' ? 'editor' : 'viewer'

  if (!validateDomain(member)) {
    return c.json({ error: 'Member domain not allowed' }, 403)
  }
  if (member === gated.ownerId.toLowerCase()) {
    return c.json({ error: 'Owner already has full access' }, 400)
  }
  if (member === email.toLowerCase()) {
    return c.json({ error: 'You cannot change your own access' }, 400)
  }

  ensure(member)
  demoShares.upsert(tenantId, {
    ownerId: gated.ownerId,
    slug: gated.meta.name,
    memberId: member,
    role,
    grantedBy: email,
  })
  auditLog(
    tenantId,
    'demo-share',
    `${gated.ownerId}/${gated.meta.name}`,
    'created',
    email,
    { member, role },
  )

  await notifyShare({
    tenantId,
    member,
    grantedBy: email,
    ownerId: gated.ownerId,
    slug: gated.meta.name,
    role,
  })

  return c.json({ ok: true, member, role })
})

app.delete('/:name/shares/:member', async (c) => {
  const gated = await gate(c, 'manage-shares')
  if (gated instanceof Response) return gated
  const { tenantId, email } = context(c)
  const member = decodeURIComponent(c.req.param('member')).toLowerCase()

  if (member === gated.ownerId.toLowerCase()) {
    return c.json({ error: 'Cannot remove the owner' }, 403)
  }

  demoShares.remove(tenantId, gated.ownerId, gated.meta.name, member)
  auditLog(
    tenantId,
    'demo-share',
    `${gated.ownerId}/${gated.meta.name}`,
    'deleted',
    email,
    { member },
  )
  return c.json({ ok: true })
})

function sseStream(
  steps: (emit: (phase: string, detail?: string) => void) => Promise<unknown>,
): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      function emit(phase: string, detail?: string) {
        const data = JSON.stringify({ phase, detail })
        controller.enqueue(encoder.encode(`data: ${data}\n\n`))
      }
      try {
        const result = await steps(emit)
        const data = JSON.stringify({ phase: 'done', result })
        controller.enqueue(encoder.encode(`data: ${data}\n\n`))
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error'
        const data = JSON.stringify({ phase: 'error', detail: msg })
        controller.enqueue(encoder.encode(`data: ${data}\n\n`))
      }
      controller.close()
    },
  })
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
}

app.post('/', async (c) => {
  const { tenantId, email } = context(c)
  const body = await c.req.json() as {
    prompt: string
    name?: string
    subsystem?: string
    version?: string
    files?: FileRef[]
  }

  if (!body.prompt) {
    return c.json({ error: 'prompt is required' }, 400)
  }

  const wantsStream = c.req.header('Accept') === 'text/event-stream'

  const cfg = gcpConfig()
  const bucket = `${cfg.project}-ar-registry`
  const subsystem = body.subsystem || DEFAULT_SUBSYSTEM
  const slug = slugify(body.name || body.prompt.slice(0, 48))

  async function run(
    emit: (phase: string, detail?: string) => void,
  ) {
    emit('validating', slug)

    const existing = await loadMeta(cfg.project, tenantId, email, slug)

    emit('resolving', 'Looking for demo-agent...')
    const found = await findDemoAgent(bucket, tenantId)
    if (!found) {
      throw new Error('demo-agent not deployed. Deploy it first.')
    }

    const signedFiles = body.files?.length
      ? await signFiles(bucket, body.files)
      : []

    emit('generating', 'Agent is generating the demo...')
    const result = await invokeAgent(found, {
      prompt: body.prompt,
      name: slug,
      subsystem,
      createdBy: email,
      storagePrefix: `${tenantId}/demos/${email}`,
      files: signedFiles,
      existingDemo: existing || undefined,
    })

    if (result.demo) {
      emit('saving', 'Storing demo metadata...')
      result.demo.name = slugify(result.demo.name || slug)
      result.demo.createdBy = email
      result.demo.status = 'created'
      await storeMeta(cfg.project, tenantId, email, result.demo)
    }

    return result
  }

  if (wantsStream) {
    return sseStream(run)
  }

  try {
    const noop = () => {}
    const result = await run(noop)
    return c.json(result, 201)
  } catch (err) {
    logger.error('Demo creation failed', err)
    return c.json({
      error: err instanceof Error ? err.message : 'Unknown error',
    }, 500)
  }
})

app.post('/:name/deploy', async (c) => {
  const gated = await gate(c, 'deploy')
  if (gated instanceof Response) return gated
  const { tenantId } = context(c)
  const cfg = gcpConfig()
  const { ownerId, meta } = gated

  let visibility: Visibility = meta.visibility === 'public'
    ? 'public'
    : 'private'
  try {
    const body = await c.req.json() as { visibility?: string }
    if (body.visibility === 'public') visibility = 'public'
    else if (body.visibility === 'private') visibility = 'private'
  } catch {
    // no body or not JSON — use stored or default
  }

  try {
    const serviceUrl = await deployContainer(
      cfg,
      tenantId,
      ownerId,
      meta,
      visibility,
    )
    meta.url = serviceUrl
    meta.status = 'running'
    // Editors can change visibility, so persist the resolved value back to
    // demo.json (the pre-RFC-010 deploy route dropped it).
    meta.visibility = visibility
    meta.updatedAt = new Date().toISOString()
    await storeMeta(cfg.project, tenantId, ownerId, meta)
    return c.json({ url: serviceUrl, status: 'deployed', visibility })
  } catch (err) {
    logger.error('Demo deploy failed', err)
    return c.json({
      error: err instanceof Error ? err.message : 'Deploy failed',
    }, 500)
  }
})

app.post('/:name/stop', async (c) => {
  const gated = await gate(c, 'stop')
  if (gated instanceof Response) return gated
  const { tenantId } = context(c)
  const cfg = gcpConfig()
  const { ownerId, meta } = gated

  try {
    await destroyContainer(cfg, tenantId, ownerId, meta.name)
    meta.status = 'stopped'
    meta.updatedAt = new Date().toISOString()
    await storeMeta(cfg.project, tenantId, ownerId, meta)
    return c.json({ status: 'stopped' })
  } catch (err) {
    logger.error('Demo stop failed', err)
    return c.json({
      error: err instanceof Error ? err.message : 'Stop failed',
    }, 500)
  }
})

app.delete('/:name', async (c) => {
  const gated = await gate(c, 'delete')
  if (gated instanceof Response) return gated
  const { tenantId } = context(c)
  const cfg = gcpConfig()
  const { ownerId, meta } = gated
  const name = meta.name

  if (meta.status === 'running') {
    try {
      await destroyContainer(cfg, tenantId, ownerId, name)
    } catch {
      logger.warn(`Failed to destroy container for demo ${name}`)
    }
  }

  try {
    await deleteImage(cfg, tenantId, ownerId, name)
  } catch {
    logger.warn(`Failed to delete image for demo ${name}`)
  }

  await deleteDemoStorage(cfg.project, tenantId, ownerId, name)
  demoShares.remove(tenantId, ownerId, name)
  return c.json({ message: 'Deleted' })
})

app.get('/:name/download', async (c) => {
  const gated = await gate(c, 'download')
  if (gated instanceof Response) return gated
  const { tenantId } = context(c)
  const { project } = gcpConfig()
  const { ownerId, meta } = gated

  try {
    const raw = await downloadSource(project, tenantId, ownerId, meta.name)
    const files: Record<string, string> = {}
    for (const [filename, data] of Object.entries(raw)) {
      files[filename] = encodeBase64(data)
    }
    return c.json({ files })
  } catch (err) {
    return c.json({
      error: err instanceof Error ? err.message : 'Download failed',
    }, 500)
  }
})

app.get('/:name/archive', async (c) => {
  const gated = await gate(c, 'download')
  if (gated instanceof Response) return gated
  const { tenantId } = context(c)
  const cfg = gcpConfig()
  const { ownerId, meta } = gated
  const name = meta.name

  const bucket = `${cfg.project}-ar-registry`
  const archivePath = `${tenantId}/demos/${ownerId}/${name}/source.tar.gz`

  try {
    const exists = await platform.storageExists(bucket, archivePath)
    if (exists) {
      const url = await platform.storageSign(
        bucket,
        archivePath,
        'GET',
        300,
      )
      return c.redirect(url, 302)
    }

    const raw = await downloadSource(cfg.project, tenantId, ownerId, name)
    const entries = Object.entries(raw)
    if (entries.length === 0) {
      return c.json({ error: 'No source files found' }, 404)
    }

    const { TarStream } = await import('@std/tar/tar-stream')
    const inputs = ReadableStream.from(
      entries.map(([filename, data]) => ({
        type: 'file' as const,
        path: filename,
        size: data.byteLength,
        readable: ReadableStream.from([data]),
      })),
    )
    const archive = inputs
      .pipeThrough(new TarStream())
      .pipeThrough(new CompressionStream('gzip'))

    return new Response(archive, {
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${name}.tar.gz"`,
      },
    })
  } catch (err) {
    return c.json({
      error: err instanceof Error ? err.message : 'Archive failed',
    }, 500)
  }
})

app.post('/:name/update', async (c) => {
  const gated = await gate(c, 'update')
  if (gated instanceof Response) return gated
  const { tenantId } = context(c)
  const cfg = gcpConfig()
  const { ownerId, meta } = gated
  const name = meta.name

  const body = await c.req.json() as {
    prompt: string
    files?: FileRef[]
  }

  if (!body.prompt) {
    return c.json({ error: 'prompt is required' }, 400)
  }

  const wantsStream = c.req.header('Accept') === 'text/event-stream'
  const current = meta
  const subsystem = DEFAULT_SUBSYSTEM

  async function run(
    emit: (phase: string, detail?: string) => void,
  ) {
    const bucket = `${cfg.project}-ar-registry`
    emit('resolving', 'Looking for demo-agent...')
    const found = await findDemoAgent(bucket, tenantId)
    if (!found) {
      throw new Error('demo-agent not deployed')
    }

    const signedFiles = body.files?.length
      ? await signFiles(bucket, body.files)
      : []

    emit('generating', 'Agent is applying your feedback...')
    const result = await invokeAgent(found, {
      prompt: body.prompt,
      name,
      subsystem,
      createdBy: ownerId,
      storagePrefix: `${tenantId}/demos/${ownerId}`,
      files: signedFiles,
      existingDemo: current,
    })

    if (result.demo) {
      emit('saving', 'Storing updated demo...')
      result.demo.name = name
      result.demo.createdBy = ownerId
      result.demo.status = current.status || 'created'
      result.demo.createdAt = current.createdAt
      result.demo.updatedAt = new Date().toISOString()
      await storeMeta(cfg.project, tenantId, ownerId, result.demo)

      if (current.status === 'running') {
        emit('building', 'Building container image...')
        try {
          await deployContainer(
            cfg,
            tenantId,
            ownerId,
            result.demo,
            current.visibility || 'private',
          )
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Build failed'
          logger.warn('Auto-redeploy after update failed', { error: msg })
        }
      }
    }

    return result
  }

  if (wantsStream) {
    return sseStream(run)
  }

  try {
    const noop = () => {}
    const result = await run(noop)
    return c.json(result)
  } catch (err) {
    return c.json({
      error: err instanceof Error ? err.message : 'Update failed',
    }, 500)
  }
})

app.post('/cleanup', async (c) => {
  const { tenantId, email, isAdmin } = context(c)
  if (!isAdmin) return c.json({ error: 'Admin only' }, 403)

  const cfg = gcpConfig()
  const allDemos = await listDemos(cfg.project, tenantId)

  const ttlMs = DEFAULT_TTL_DAYS * 24 * 60 * 60 * 1000
  const now = Date.now()
  let cleaned = 0

  for (const demo of allDemos) {
    if (demo.status !== 'running') continue
    const deployed = new Date(demo.updatedAt).getTime()
    if (now - deployed > ttlMs) {
      try {
        await destroyContainer(
          cfg,
          tenantId,
          demo.createdBy || email,
          demo.name,
        )
        demo.status = 'expired'
        demo.updatedAt = new Date().toISOString()
        await storeMeta(
          cfg.project,
          tenantId,
          demo.createdBy || email,
          demo,
        )
        cleaned++
      } catch {
        logger.warn(`Cleanup failed for demo ${demo.name}`)
      }
    }
  }

  return c.json({ cleaned, total: allDemos.length })
})

export default app

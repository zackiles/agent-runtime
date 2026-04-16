import { Hono } from '@hono/hono'
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
import platform from '@ar/client/platform'
import logger from '@ar/client/utils/logger'
import { DEFAULT_SUBSYSTEM } from '@ar/client/subsystems'
import { encodeBase64 } from '@std/encoding/base64'
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

const DEFAULT_TTL_DAYS = 7

type FileRef = { name: string; path: string }

const app = new Hono<Env>()

app.get('/', async (c) => {
  const { tenantId, email, isAdmin } = context(c)
  const { project } = gcpConfig()
  const requestedUser = c.req.query('user')
  const userId = (requestedUser && isAdmin) ? requestedUser : email
  const demos = await listDemos(project, tenantId, userId)
  return c.json(demos)
})

app.get('/:name', async (c) => {
  const { tenantId, email, isAdmin } = context(c)
  const { project } = gcpConfig()
  const name = slugify(c.req.param('name'))
  const requestedUser = c.req.query('user')
  const userId = (requestedUser && isAdmin) ? requestedUser : email
  const meta = await loadMeta(project, tenantId, userId, name)
  if (!meta) return c.json({ error: 'Demo not found' }, 404)
  return c.json(meta)
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
  const { tenantId, email } = context(c)
  const cfg = gcpConfig()
  const name = slugify(c.req.param('name'))
  const meta = await loadMeta(cfg.project, tenantId, email, name)
  if (!meta) return c.json({ error: 'Demo not found' }, 404)

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
      email,
      meta,
      visibility,
    )
    meta.url = serviceUrl
    meta.status = 'running'
    meta.updatedAt = new Date().toISOString()
    await storeMeta(cfg.project, tenantId, email, meta)
    return c.json({ url: serviceUrl, status: 'deployed', visibility })
  } catch (err) {
    logger.error('Demo deploy failed', err)
    return c.json({
      error: err instanceof Error ? err.message : 'Deploy failed',
    }, 500)
  }
})

app.post('/:name/stop', async (c) => {
  const { tenantId, email } = context(c)
  const cfg = gcpConfig()
  const name = slugify(c.req.param('name'))
  const meta = await loadMeta(cfg.project, tenantId, email, name)
  if (!meta) return c.json({ error: 'Demo not found' }, 404)

  try {
    await destroyContainer(cfg, tenantId, email, name)
    meta.status = 'stopped'
    meta.updatedAt = new Date().toISOString()
    await storeMeta(cfg.project, tenantId, email, meta)
    return c.json({ status: 'stopped' })
  } catch (err) {
    logger.error('Demo stop failed', err)
    return c.json({
      error: err instanceof Error ? err.message : 'Stop failed',
    }, 500)
  }
})

app.delete('/:name', async (c) => {
  const { tenantId, email } = context(c)
  const cfg = gcpConfig()
  const name = slugify(c.req.param('name'))
  const meta = await loadMeta(cfg.project, tenantId, email, name)
  if (!meta) return c.json({ error: 'Demo not found' }, 404)

  if (meta.status === 'running') {
    try {
      await destroyContainer(cfg, tenantId, email, name)
    } catch {
      logger.warn(`Failed to destroy container for demo ${name}`)
    }
  }

  try {
    await deleteImage(cfg, tenantId, email, name)
  } catch {
    logger.warn(`Failed to delete image for demo ${name}`)
  }

  await deleteDemoStorage(cfg.project, tenantId, email, name)
  return c.json({ message: 'Deleted' })
})

app.get('/:name/download', async (c) => {
  const { tenantId, email } = context(c)
  const { project } = gcpConfig()
  const name = slugify(c.req.param('name'))

  try {
    const raw = await downloadSource(project, tenantId, email, name)
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
  const { tenantId, email } = context(c)
  const cfg = gcpConfig()
  const name = slugify(c.req.param('name'))

  const bucket = `${cfg.project}-ar-registry`
  const archivePath = `${tenantId}/demos/${email}/${name}/source.tar.gz`

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

    const raw = await downloadSource(cfg.project, tenantId, email, name)
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
  const { tenantId, email } = context(c)
  const cfg = gcpConfig()
  const name = slugify(c.req.param('name'))
  const meta = await loadMeta(cfg.project, tenantId, email, name)
  if (!meta) return c.json({ error: 'Demo not found' }, 404)

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
      createdBy: email,
      storagePrefix: `${tenantId}/demos/${email}`,
      files: signedFiles,
      existingDemo: current,
    })

    if (result.demo) {
      emit('saving', 'Storing updated demo...')
      result.demo.name = name
      result.demo.createdBy = email
      result.demo.status = current.status || 'created'
      result.demo.createdAt = current.createdAt
      result.demo.updatedAt = new Date().toISOString()
      await storeMeta(cfg.project, tenantId, email, result.demo)

      if (current.status === 'running') {
        emit('building', 'Building container image...')
        try {
          await deployContainer(
            cfg,
            tenantId,
            email,
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

import { Hono } from '@hono/hono'
import { streamSSE } from '@hono/hono/streaming'
import { context } from '../types.ts'
import type { Env } from '../types.ts'
import platform from '@ar/client/platform'
import loadRuntime from '@ar/client/runtime'
import logger from '@ar/client/utils/logger'
import { log as auditLog } from '@ar/client/db/audit'

const AR_API = 'https://artifactregistry.googleapis.com/v1'
const BUILD_API = 'https://cloudbuild.googleapis.com/v1'

type DockerImage = {
  name: string
  uri: string
  tags?: string[]
  imageSizeBytes: string
  uploadTime: string
  mediaType: string
  buildTime: string
  updateTime: string
}

type Build = {
  id: string
  status: string
  createTime: string
  startTime: string
  finishTime: string
  images: string[]
  logUrl: string
  source: {
    storageSource?: { bucket: string; object: string }
  }
  results?: {
    images?: { name: string; digest: string }[]
    buildStepImages?: string[]
  }
  steps?: {
    name: string
    args: string[]
    timing?: { startTime: string; endTime: string }
  }[]
  timeout: string
}

function repoParent(project: string, region: string, repo: string): string {
  return `projects/${project}/locations/${region}/repositories/${repo}`
}

async function arFetch<T>(path: string): Promise<T> {
  const token = await platform.getAccessToken()
  const res = await fetch(`${AR_API}/${path}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Artifact Registry API ${res.status}: ${text}`)
  }
  return await res.json() as T
}

async function arDelete(path: string): Promise<void> {
  const token = await platform.getAccessToken()
  const res = await fetch(`${AR_API}/${path}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` },
  })
  if (!res.ok && res.status !== 404) {
    const text = await res.text()
    throw new Error(`Artifact Registry DELETE ${res.status}: ${text}`)
  }
}

async function buildFetch<T>(path: string): Promise<T> {
  const token = await platform.getAccessToken()
  const res = await fetch(`${BUILD_API}/${path}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Cloud Build API ${res.status}: ${text}`)
  }
  return await res.json() as T
}

function resolveConfig(): {
  project: string
  region: string
  repo: string
} {
  const project = Deno.env.get('GCP_PROJECT') ||
    Deno.env.get('GOOGLE_CLOUD_PROJECT') || ''
  const region = Deno.env.get('GCP_REGION') || ''
  const rc = loadRuntime()
  const repo = rc.agents?.artifactRepo || 'ar-agents'
  return { project, region, repo }
}

const app = new Hono<Env>()

app.get('/', async (c) => {
  const { isAdmin } = context(c)
  if (!isAdmin) return c.json({ error: 'Admin only' }, 403)

  const { project, region, repo } = resolveConfig()
  if (!project || !region) {
    return c.json({ error: 'GCP project/region not configured' }, 500)
  }

  const parent = repoParent(project, region, repo)
  const images: DockerImage[] = []
  let pageToken = ''

  do {
    const params = new URLSearchParams({ pageSize: '1000' })
    if (pageToken) params.set('pageToken', pageToken)
    try {
      const data = await arFetch<{
        dockerImages?: DockerImage[]
        nextPageToken?: string
      }>(`${parent}/dockerImages?${params}`)
      images.push(...(data.dockerImages || []))
      pageToken = data.nextPageToken || ''
    } catch (err) {
      logger.warn(`Failed to list docker images: ${err}`)
      break
    }
  } while (pageToken)

  const grouped = new Map<string, {
    name: string
    tags: string[]
    versions: {
      digest: string
      tags: string[]
      size: number
      uploadTime: string
      buildTime: string
      updateTime: string
      mediaType: string
    }[]
    totalSize: number
    latestUpload: string
  }>()

  for (const img of images) {
    const parts = img.uri.split('/')
    const shortName = parts.length >= 4 ? parts[3].split('@')[0] : img.uri

    const digest = img.uri.includes('@') ? img.uri.split('@')[1] : ''
    const size = parseInt(img.imageSizeBytes || '0', 10)

    let group = grouped.get(shortName)
    if (!group) {
      group = {
        name: shortName,
        tags: [],
        versions: [],
        totalSize: 0,
        latestUpload: '',
      }
      grouped.set(shortName, group)
    }

    for (const tag of img.tags || []) {
      if (!group.tags.includes(tag)) group.tags.push(tag)
    }

    group.versions.push({
      digest,
      tags: img.tags || [],
      size,
      uploadTime: img.uploadTime || '',
      buildTime: img.buildTime || '',
      updateTime: img.updateTime || '',
      mediaType: img.mediaType || '',
    })

    group.totalSize += size
    if (
      !group.latestUpload ||
      (img.uploadTime && img.uploadTime > group.latestUpload)
    ) {
      group.latestUpload = img.uploadTime || ''
    }
  }

  const packages = Array.from(grouped.values())
    .sort((a, b) => b.latestUpload.localeCompare(a.latestUpload))

  for (const pkg of packages) {
    pkg.versions.sort((a, b) => b.uploadTime.localeCompare(a.uploadTime))
  }

  return c.json({
    project,
    region,
    repo,
    totalImages: images.length,
    totalPackages: packages.length,
    totalSize: packages.reduce((s, p) => s + p.totalSize, 0),
    packages,
  })
})

app.get('/packages/:name/versions', async (c) => {
  const { isAdmin } = context(c)
  if (!isAdmin) return c.json({ error: 'Admin only' }, 403)

  const { project, region, repo } = resolveConfig()
  if (!project || !region) {
    return c.json({ error: 'GCP project/region not configured' }, 500)
  }

  const parent = repoParent(project, region, repo)
  const name = c.req.param('name')

  try {
    const data = await arFetch<{
      versions?: Record<string, unknown>[]
      nextPageToken?: string
    }>(
      `${parent}/packages/${encodeURIComponent(name)}` +
        '/versions?pageSize=100',
    )
    return c.json(data.versions || [])
  } catch (err) {
    return c.json({
      error: err instanceof Error ? err.message : 'Failed to list versions',
    }, 500)
  }
})

app.delete('/packages/:name', async (c) => {
  const { isAdmin } = context(c)
  if (!isAdmin) return c.json({ error: 'Admin only' }, 403)

  const { project, region, repo } = resolveConfig()
  const parent = repoParent(project, region, repo)
  const name = c.req.param('name')

  try {
    const pkg = encodeURIComponent(name)
    await arDelete(`${parent}/packages/${pkg}`)
    return c.json({ message: `Package ${name} deleted` })
  } catch (err) {
    return c.json({
      error: err instanceof Error ? err.message : 'Delete failed',
    }, 500)
  }
})

app.delete('/packages/:name/versions/:version', async (c) => {
  const { isAdmin } = context(c)
  if (!isAdmin) return c.json({ error: 'Admin only' }, 403)

  const { project, region, repo } = resolveConfig()
  const parent = repoParent(project, region, repo)
  const name = c.req.param('name')
  const version = c.req.param('version')

  try {
    const pkg = encodeURIComponent(name)
    const ver = encodeURIComponent(version)
    await arDelete(
      `${parent}/packages/${pkg}/versions/${ver}`,
    )
    return c.json({ message: `Version deleted` })
  } catch (err) {
    return c.json({
      error: err instanceof Error ? err.message : 'Delete failed',
    }, 500)
  }
})

async function deployedImage(
  project: string,
  region: string,
  slug: string,
): Promise<string | null> {
  try {
    const token = await platform.getAccessToken()
    const url = `https://run.googleapis.com/v2/projects/${project}` +
      `/locations/${region}/services/${slug}`
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
    })
    if (!res.ok) return null
    const svc = await res.json() as {
      template?: { containers?: { image?: string }[] }
    }
    return svc.template?.containers?.[0]?.image || null
  } catch {
    return null
  }
}

async function listPackageImages(
  parent: string,
  name: string,
): Promise<DockerImage[]> {
  const images: DockerImage[] = []
  let pageToken = ''
  do {
    const params = new URLSearchParams({ pageSize: '1000' })
    if (pageToken) params.set('pageToken', pageToken)
    try {
      const data = await arFetch<{
        dockerImages?: DockerImage[]
        nextPageToken?: string
      }>(`${parent}/dockerImages?${params}`)
      for (const img of data.dockerImages || []) {
        const parts = img.uri.split('/')
        const shortName = parts.length >= 4 ? parts[3].split('@')[0] : ''
        if (shortName === name) images.push(img)
      }
      pageToken = data.nextPageToken || ''
    } catch (err) {
      logger.warn(`Failed to list docker images: ${err}`)
      break
    }
  } while (pageToken)
  return images
}

app.delete('/packages/:name/builds', async (c) => {
  const { isAdmin, tenantId, email } = context(c)
  if (!isAdmin) return c.json({ error: 'Admin only' }, 403)

  const { project, region, repo } = resolveConfig()
  if (!project || !region) {
    return c.json({ error: 'GCP project/region not configured' }, 500)
  }

  const parent = repoParent(project, region, repo)
  const name = c.req.param('name')
  const pkg = encodeURIComponent(name)
  const useStream = c.req.header('Accept') === 'text/event-stream'

  function resolveActive(
    images: DockerImage[],
    liveImage: string | null,
  ): DockerImage {
    if (liveImage) {
      const liveDigest = liveImage.includes('@')
        ? liveImage.split('@')[1]
        : null
      const liveTag = liveImage.includes(':')
        ? liveImage.split(':').pop() || null
        : null
      const match = images.find((img) => {
        if (liveDigest) {
          const d = img.uri.includes('@') ? img.uri.split('@')[1] : ''
          if (d === liveDigest) return true
        }
        if (liveTag && (img.tags || []).includes(liveTag)) return true
        return false
      })
      if (match) return match
    }
    images.sort((a, b) =>
      (b.uploadTime || '').localeCompare(a.uploadTime || '')
    )
    return images[0]
  }

  if (!useStream) {
    try {
      const result = await clearPackageBuilds(
        parent,
        pkg,
        name,
        project,
        region,
        tenantId,
        email,
      )
      return c.json(result)
    } catch (err) {
      return c.json({
        error: err instanceof Error ? err.message : 'Failed to clear builds',
      }, 500)
    }
  }

  return streamSSE(c, async (stream) => {
    const send = (
      event: string,
      data: Record<string, unknown>,
    ) => stream.writeSSE({ event, data: JSON.stringify(data) })

    try {
      await send('status', { message: 'Listing images...' })
      const images = await listPackageImages(parent, name)

      if (images.length === 0) {
        await send('done', {
          message: 'No images found',
          deleted: [],
        })
        return
      }

      await send('status', {
        message: `Found ${images.length} image(s). ` +
          'Checking deployed version...',
      })
      const liveImage = await deployedImage(project, region, name)
      const active = resolveActive(images, liveImage)
      const stale = images.filter((img) => img !== active)

      if (stale.length === 0) {
        await send('done', {
          message: 'Only one version exists, nothing to clear',
          deleted: [],
        })
        return
      }

      const activeDigest = active.uri.includes('@')
        ? active.uri.split('@')[1]
        : ''

      await send('status', {
        message: `Retained: ${
          (active.tags || []).join(', ') || activeDigest.slice(0, 16)
        }`,
        total: stale.length,
      })

      await send('status', {
        message: 'Listing versions...',
      })
      const versions = await arFetch<{
        versions?: { name: string }[]
      }>(`${parent}/packages/${pkg}/versions?pageSize=1000`)

      const toDelete = (versions.versions || []).filter((ver) => {
        if (!activeDigest) return true
        return !ver.name.includes(
          activeDigest.replace('sha256:', ''),
        )
      })

      await send('status', {
        message: `Deleting ${toDelete.length} version(s)...`,
        total: toDelete.length,
      })

      const deleted: {
        digest: string
        tags: string[]
        size: number
        uploadTime: string
      }[] = []
      let failed = 0

      for (let i = 0; i < toDelete.length; i++) {
        const verName = toDelete[i].name
        const shortDigest = verName.split('/').pop() || verName
        try {
          await arDelete(verName)
          const matching = stale.find((img) => {
            const d = img.uri.includes('@') ? img.uri.split('@')[1] : ''
            return verName.includes(d.replace('sha256:', ''))
          })
          const entry = {
            digest: shortDigest,
            tags: matching?.tags || [],
            size: parseInt(matching?.imageSizeBytes || '0', 10),
            uploadTime: matching?.uploadTime || '',
          }
          deleted.push(entry)
          await send('progress', {
            current: i + 1,
            total: toDelete.length,
            deleted: entry,
          })
        } catch (err) {
          failed++
          const msg = err instanceof Error ? err.message : String(err)
          logger.warn(`Failed to delete ${verName}: ${msg}`)
          await send('progress', {
            current: i + 1,
            total: toDelete.length,
            error: shortDigest,
            message: msg.slice(0, 200),
          })
        }
      }

      await send('status', { message: 'Cleaning storage...' })
      const bucket = `${project}-ar-registry`
      const prefix = `${tenantId}/agents/${name}/`
      try {
        const objects = await platform.storageList(bucket, prefix)
        for (const objPath of objects) {
          if (!objPath) continue
          const isActiveSource = (active.tags || []).some(
            (tag) => objPath.includes(`/${tag}/`),
          )
          if (isActiveSource) continue
          try {
            await platform.storageDelete(bucket, objPath)
          } catch (err) {
            logger.warn(
              `Failed to delete GCS object ${objPath}: ${err}`,
            )
          }
        }
      } catch (err) {
        logger.warn(`Failed to clean GCS for ${name}: ${err}`)
      }

      try {
        auditLog(
          tenantId,
          'artifact',
          name,
          'builds_cleared',
          email,
          {
            package: name,
            deletedCount: deleted.length,
            failedCount: failed,
            deleted: deleted.map((d) => ({
              digest: d.digest,
              tags: d.tags,
              uploadTime: d.uploadTime,
            })),
            retained: {
              digest: activeDigest,
              tags: active.tags || [],
              uploadTime: active.uploadTime,
            },
          },
        )
      } catch {
        // audit is non-fatal
      }

      await send('done', {
        message: failed > 0
          ? `Cleared ${deleted.length} build(s), ` +
            `${failed} failed for ${name}`
          : `Cleared ${deleted.length} old build(s) for ${name}`,
        retained: {
          digest: activeDigest,
          tags: active.tags || [],
          uploadTime: active.uploadTime,
        },
        deleted,
        failed,
      })
    } catch (err) {
      await send('error', {
        error: err instanceof Error ? err.message : 'Failed to clear builds',
      })
    }
  })
})

async function clearPackageBuilds(
  parent: string,
  pkg: string,
  name: string,
  project: string,
  region: string,
  tenantId: string,
  email: string,
) {
  const images = await listPackageImages(parent, name)

  if (images.length === 0) {
    return { message: 'No images found', deleted: [] }
  }

  const liveImage = await deployedImage(project, region, name)

  let active: DockerImage | undefined
  if (liveImage) {
    const liveDigest = liveImage.includes('@') ? liveImage.split('@')[1] : null
    const liveTag = liveImage.includes(':')
      ? liveImage.split(':').pop() || null
      : null
    active = images.find((img) => {
      if (liveDigest) {
        const d = img.uri.includes('@') ? img.uri.split('@')[1] : ''
        if (d === liveDigest) return true
      }
      if (liveTag && (img.tags || []).includes(liveTag)) return true
      return false
    })
  }

  if (!active) {
    images.sort((a, b) =>
      (b.uploadTime || '').localeCompare(a.uploadTime || '')
    )
    active = images[0]
  }

  const stale = images.filter((img) => img !== active)
  if (stale.length === 0) {
    return {
      message: 'Only one version exists, nothing to clear',
      deleted: [],
    }
  }

  const activeDigest = active.uri.includes('@') ? active.uri.split('@')[1] : ''

  const deleted: {
    digest: string
    tags: string[]
    size: number
    uploadTime: string
  }[] = []
  let failed = 0

  const versions = await arFetch<{
    versions?: { name: string }[]
  }>(`${parent}/packages/${pkg}/versions?pageSize=1000`)

  for (const ver of versions.versions || []) {
    const verName = ver.name
    const isActive = activeDigest &&
      verName.includes(activeDigest.replace('sha256:', ''))
    if (isActive) continue

    try {
      await arDelete(verName)
      const matching = stale.find((img) => {
        const d = img.uri.includes('@') ? img.uri.split('@')[1] : ''
        return verName.includes(d.replace('sha256:', ''))
      })
      deleted.push({
        digest: verName.split('/').pop() || verName,
        tags: matching?.tags || [],
        size: parseInt(matching?.imageSizeBytes || '0', 10),
        uploadTime: matching?.uploadTime || '',
      })
    } catch (err) {
      failed++
      logger.warn(`Failed to delete version ${verName}: ${err}`)
    }
  }

  const bucket = `${project}-ar-registry`
  const prefix = `${tenantId}/agents/${name}/`
  try {
    const objects = await platform.storageList(bucket, prefix)
    for (const objPath of objects) {
      if (!objPath) continue
      const isActiveSource = (active!.tags || []).some((tag) =>
        objPath.includes(`/${tag}/`)
      )
      if (isActiveSource) continue
      try {
        await platform.storageDelete(bucket, objPath)
      } catch (err) {
        logger.warn(
          `Failed to delete GCS object ${objPath}: ${err}`,
        )
      }
    }
  } catch (err) {
    logger.warn(`Failed to clean GCS for ${name}: ${err}`)
  }

  try {
    auditLog(tenantId, 'artifact', name, 'builds_cleared', email, {
      package: name,
      deletedCount: deleted.length,
      failedCount: failed,
      deleted: deleted.map((d) => ({
        digest: d.digest,
        tags: d.tags,
        uploadTime: d.uploadTime,
      })),
      retained: {
        digest: activeDigest,
        tags: active!.tags || [],
        uploadTime: active!.uploadTime,
      },
    })
  } catch {
    // audit is non-fatal
  }

  const result: Record<string, unknown> = {
    message: failed > 0
      ? `Cleared ${deleted.length} build(s), ` +
        `${failed} failed for ${name}`
      : `Cleared ${deleted.length} old build(s) for ${name}`,
    retained: {
      digest: activeDigest,
      tags: active!.tags || [],
      uploadTime: active!.uploadTime,
    },
    deleted,
  }
  if (failed > 0) result.failed = failed
  return result
}

app.get('/builds', async (c) => {
  const { isAdmin } = context(c)
  if (!isAdmin) return c.json({ error: 'Admin only' }, 403)

  const { project } = resolveConfig()
  if (!project) {
    return c.json({ error: 'GCP project not configured' }, 500)
  }

  const limit = parseInt(c.req.query('limit') || '25', 10)

  try {
    const data = await buildFetch<{ builds?: Build[] }>(
      `projects/${project}/builds?pageSize=${limit}`,
    )
    return c.json(
      (data.builds || []).map((b) => ({
        id: b.id,
        status: b.status,
        createTime: b.createTime,
        startTime: b.startTime,
        finishTime: b.finishTime,
        images: b.images || [],
        logUrl: b.logUrl || '',
        source: b.source,
        results: b.results,
        steps: b.steps?.map((s) => ({
          name: s.name,
          args: s.args,
          timing: s.timing,
        })),
        duration: b.startTime && b.finishTime
          ? new Date(b.finishTime).getTime() -
            new Date(b.startTime).getTime()
          : null,
      })),
    )
  } catch (err) {
    return c.json({
      error: err instanceof Error ? err.message : 'Failed to list builds',
    }, 500)
  }
})

app.get('/builds/:id', async (c) => {
  const { isAdmin } = context(c)
  if (!isAdmin) return c.json({ error: 'Admin only' }, 403)

  const { project } = resolveConfig()
  const buildId = c.req.param('id')

  try {
    const b = await buildFetch<Build>(
      `projects/${project}/builds/${buildId}`,
    )
    return c.json({
      id: b.id,
      status: b.status,
      createTime: b.createTime,
      startTime: b.startTime,
      finishTime: b.finishTime,
      images: b.images || [],
      logUrl: b.logUrl || '',
      source: b.source,
      results: b.results,
      steps: b.steps,
      duration: b.startTime && b.finishTime
        ? new Date(b.finishTime).getTime() -
          new Date(b.startTime).getTime()
        : null,
    })
  } catch (err) {
    return c.json({
      error: err instanceof Error ? err.message : 'Failed to get build',
    }, 500)
  }
})

app.get('/builds/:id/logs', async (c) => {
  const { isAdmin } = context(c)
  if (!isAdmin) return c.json({ error: 'Admin only' }, 403)

  const { project } = resolveConfig()
  const buildId = c.req.param('id')

  try {
    const b = await buildFetch<Build>(
      `projects/${project}/builds/${buildId}`,
    )
    if (!b.logUrl) {
      return c.json({ logs: '', logUrl: '' })
    }

    const token = await platform.getAccessToken()
    const logRes = await fetch(`${b.logUrl}log-${buildId}.txt`, {
      headers: { 'Authorization': `Bearer ${token}` },
    })
    const logs = logRes.ok ? await logRes.text() : ''
    return c.json({ logs, logUrl: b.logUrl })
  } catch (err) {
    return c.json({
      error: err instanceof Error ? err.message : 'Failed to get logs',
    }, 500)
  }
})

export default app

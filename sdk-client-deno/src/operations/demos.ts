import platform from '../platform/mod.ts'
import logger from '../utils/logger.ts'

type DemoMeta = {
  name: string
  url: string
  path: string
  prompt: string
  summary: string
  visibility?: 'public' | 'private'
  createdAt: string
  updatedAt: string
  createdBy?: string
  status?: string
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
}

function demoBucket(project: string): string {
  return `${project}-ar-registry`
}

function demoPrefix(tenantId: string, userId: string): string {
  return `${tenantId}/demos/${userId}`
}

function demoPath(
  tenantId: string,
  userId: string,
  slug: string,
): string {
  return `${demoPrefix(tenantId, userId)}/${slug}`
}

async function storeMeta(
  project: string,
  tenantId: string,
  userId: string,
  meta: DemoMeta,
): Promise<void> {
  const bucket = demoBucket(project)
  const path = `${demoPath(tenantId, userId, meta.name)}/demo.json`
  const data = new TextEncoder().encode(JSON.stringify(meta, null, 2))
  await platform.storageUpload(bucket, path, data)
  logger.info(`Demo meta stored: ${path}`)
}

async function loadMeta(
  project: string,
  tenantId: string,
  userId: string,
  slug: string,
): Promise<DemoMeta | null> {
  const bucket = demoBucket(project)
  const path = `${demoPath(tenantId, userId, slug)}/demo.json`
  try {
    const exists = await platform.storageExists(bucket, path)
    if (!exists) return null
    const data = await platform.storageDownload(bucket, path)
    return JSON.parse(new TextDecoder().decode(data)) as DemoMeta
  } catch {
    return null
  }
}

async function listDemos(
  project: string,
  tenantId: string,
  userId?: string,
): Promise<DemoMeta[]> {
  const bucket = demoBucket(project)
  const prefix = userId ? demoPrefix(tenantId, userId) : `${tenantId}/demos/`

  try {
    const paths = await platform.storageList(bucket, prefix)
    const metaPaths = paths.filter((p) => p.endsWith('/demo.json'))
    const seen = new Map<string, DemoMeta>()
    for (const p of metaPaths) {
      try {
        const data = await platform.storageDownload(bucket, p)
        const meta = JSON.parse(
          new TextDecoder().decode(data),
        ) as DemoMeta
        const existing = seen.get(meta.name)
        if (
          !existing ||
          (meta.updatedAt || '') > (existing.updatedAt || '')
        ) {
          seen.set(meta.name, meta)
        }
      } catch {
        continue
      }
    }
    return [...seen.values()]
  } catch {
    return []
  }
}

async function downloadSource(
  project: string,
  tenantId: string,
  userId: string,
  slug: string,
): Promise<Record<string, Uint8Array>> {
  const bucket = demoBucket(project)
  const base = demoPath(tenantId, userId, slug)

  const archivePath = `${base}/source.tar.gz`
  const archiveExists = await platform.storageExists(bucket, archivePath)
  if (archiveExists) {
    const { UntarStream } = await import('@std/tar/untar-stream')
    const data = await platform.storageDownload(bucket, archivePath)
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(data)
        controller.close()
      },
    })
    const files: Record<string, Uint8Array> = {}
    const decompressed = stream.pipeThrough(new DecompressionStream('gzip'))
    for await (
      const entry of decompressed.pipeThrough(
        new UntarStream(),
      ) as ReadableStream<{
        header: { name: string; typeflag?: string }
        readable?: ReadableStream<Uint8Array>
      }>
    ) {
      if (entry.header.typeflag === 'file' || !entry.header.typeflag) {
        const chunks: Uint8Array[] = []
        if (entry.readable) {
          for await (const chunk of entry.readable) {
            chunks.push(chunk)
          }
        }
        const total = chunks.reduce((s, c) => s + c.byteLength, 0)
        const merged = new Uint8Array(total)
        let offset = 0
        for (const chunk of chunks) {
          merged.set(chunk, offset)
          offset += chunk.byteLength
        }
        let name = entry.header.name
        if (name.startsWith('./')) name = name.slice(2)
        if (name) files[name] = merged
      } else if (entry.readable) {
        await entry.readable.cancel()
      }
    }
    return files
  }

  const flat = `${base}/source`
  let paths = await platform.storageList(bucket, flat)
  let sourceBase = flat

  if (paths.length === 0) {
    const versioned = `${base}/0.0.1/source`
    paths = await platform.storageList(bucket, versioned)
    sourceBase = versioned
  }

  const files: Record<string, Uint8Array> = {}
  for (const p of paths) {
    const name = p.slice(sourceBase.length + 1)
    if (!name) continue
    try {
      files[name] = await platform.storageDownload(bucket, p)
    } catch {
      continue
    }
  }
  return files
}

async function deleteDemoStorage(
  project: string,
  tenantId: string,
  userId: string,
  slug: string,
): Promise<void> {
  const bucket = demoBucket(project)
  const base = demoPath(tenantId, userId, slug)

  const paths = await platform.storageList(bucket, base)
  for (const p of paths) {
    await platform.storageDelete(bucket, p)
  }
  logger.info(`Demo storage deleted: ${base}`)
}

export {
  deleteDemoStorage,
  downloadSource,
  listDemos,
  loadMeta,
  slugify,
  storeMeta,
}
export type { DemoMeta }

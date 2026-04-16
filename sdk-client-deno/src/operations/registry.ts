import { modeInfo } from '../platform/mod.ts'
import platform from '../platform/mod.ts'
import {
  cloneEntity as dbClone,
  createEntity as dbCreate,
  createVersion as dbCreateVersion,
  getEntity as dbGet,
  getEntityBySlug as dbGetBySlug,
  listEntities as dbList,
  listPublicEntities as dbListPublic,
  listVersions as dbListVersions,
  removeEntity as dbRemove,
  removeVersion as dbRemoveVersion,
  switchVersion as dbSwitchVersion,
  updateEntity as dbUpdate,
  updateGcsPath as dbUpdateGcsPath,
} from '../db/registry.ts'
import type {
  EntityTable,
  EntityUpdates,
  RegistryEntity,
} from '../db/registry.ts'

async function cpFetch<T>(
  path: string,
  opts?: { method?: string; body?: unknown },
): Promise<T> {
  const token = await platform.getIdentityToken()
  const init: RequestInit = {
    method: opts?.method || 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  }
  if (opts?.body !== undefined) {
    init.body = JSON.stringify(opts.body)
  }
  const url = modeInfo.controlPlaneUrl!
  const res = await fetch(`${url}${path}`, init)
  if (!res.ok) {
    const text = await res.text()
    throw new Error(
      `Control plane error ${res.status}: ${text}`,
    )
  }
  const text = await res.text()
  if (!text) return {} as T
  return JSON.parse(text) as T
}

async function cpFetchBinary<T>(
  path: string,
  data: Uint8Array,
): Promise<T> {
  const token = await platform.getIdentityToken()
  const url = modeInfo.controlPlaneUrl!
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
    },
    body: data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    ) as ArrayBuffer,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(
      `Control plane error ${res.status}: ${text}`,
    )
  }
  const text = await res.text()
  if (!text) return {} as T
  return JSON.parse(text) as T
}

function typePath(table: EntityTable): string {
  return `/${table}s`
}

async function createEntity(
  table: EntityTable,
  tenantId: string,
  name: string,
  slug: string,
  ownerId: string,
  opts?: {
    visibility?: string
    config?: Record<string, unknown>
    version?: string
    content?: string
  },
): Promise<RegistryEntity> {
  if (modeInfo.mode === 'remote') {
    const entity = await cpFetch<RegistryEntity>(typePath(table), {
      method: 'POST',
      body: { name, slug, visibility: opts?.visibility, config: opts?.config },
    })
    if (opts?.content) {
      await cpFetch(`${typePath(table)}/${entity.id}`, {
        method: 'PUT',
        body: { content: opts.content },
      })
    }
    return entity
  }
  return dbCreate(table, tenantId, name, slug, ownerId, opts)
}

async function listEntities(
  table: EntityTable,
  tenantId: string,
  userId?: string,
): Promise<RegistryEntity[]> {
  if (modeInfo.mode === 'remote') {
    return await cpFetch<RegistryEntity[]>(typePath(table))
  }
  return dbList(table, tenantId, userId)
}

async function listPublicEntities(
  table: EntityTable,
  tenantId: string,
): Promise<RegistryEntity[]> {
  if (modeInfo.mode === 'remote') {
    return await cpFetch<RegistryEntity[]>(
      `${typePath(table)}?visibility=public`,
    )
  }
  return dbListPublic(table, tenantId)
}

async function removeEntity(
  table: EntityTable,
  id: string,
  tenantId: string,
  actorId?: string,
): Promise<void> {
  if (modeInfo.mode === 'remote') {
    await cpFetch(`${typePath(table)}/${id}`, { method: 'DELETE' })
    return
  }
  dbRemove(table, id, tenantId, actorId)
}

async function getEntity(
  table: EntityTable,
  id: string,
  tenantId: string,
): Promise<RegistryEntity | null> {
  if (modeInfo.mode === 'remote') {
    try {
      return await cpFetch<RegistryEntity>(
        `${typePath(table)}/${id}`,
      )
    } catch {
      return null
    }
  }
  return dbGet(table, id, tenantId)
}

async function getEntityBySlug(
  table: EntityTable,
  tenantId: string,
  slug: string,
): Promise<RegistryEntity | null> {
  if (modeInfo.mode === 'remote') {
    const all = await cpFetch<RegistryEntity[]>(typePath(table))
    return all.find((e) => e.slug === slug) ?? null
  }
  return dbGetBySlug(table, tenantId, slug)
}

async function updateEntity(
  table: EntityTable,
  id: string,
  tenantId: string,
  updates: EntityUpdates,
  actorId?: string,
): Promise<RegistryEntity | null> {
  if (modeInfo.mode === 'remote') {
    return await cpFetch<RegistryEntity>(
      `${typePath(table)}/${id}`,
      { method: 'PUT', body: updates },
    )
  }
  return dbUpdate(table, id, tenantId, updates, actorId)
}

async function deployEntity(
  table: EntityTable,
  slug: string,
  tenantId: string,
  archive: Uint8Array,
  project: string,
): Promise<{ gcsPath: string }> {
  if (modeInfo.mode === 'remote') {
    return await cpFetchBinary<{ gcsPath: string }>(
      `${typePath(table)}/${slug}/deploy`,
      archive,
    )
  }

  const entity = dbGetBySlug(table, tenantId, slug)
  if (!entity) throw new Error(`${table} '${slug}' not found`)

  const bucket = `${project}-ar-registry`
  const version = entity.version || '0.0.1'
  const gcsPath = `${tenantId}/${table}s/${slug}/${version}/archive.tar.gz`

  await platform.storageUpload(bucket, gcsPath, archive)
  dbUpdateGcsPath(table, entity.id, tenantId, gcsPath)

  return { gcsPath }
}

async function cloneEntity(
  table: EntityTable,
  id: string,
  tenantId: string,
  ownerId: string,
): Promise<RegistryEntity> {
  if (modeInfo.mode === 'remote') {
    return await cpFetch<RegistryEntity>(
      `${typePath(table)}/${id}/clone`,
      { method: 'POST' },
    )
  }
  return dbClone(table, id, tenantId, ownerId)
}

async function listVersions(
  table: EntityTable,
  tenantId: string,
  slug: string,
): Promise<RegistryEntity[]> {
  if (modeInfo.mode === 'remote') {
    return await cpFetch<RegistryEntity[]>(
      `${typePath(table)}/${slug}/versions`,
    )
  }
  return dbListVersions(table, tenantId, slug)
}

async function createVersion(
  table: EntityTable,
  tenantId: string,
  slug: string,
  version: string,
  ownerId: string,
  opts?: { content?: string; config?: Record<string, unknown> },
): Promise<RegistryEntity> {
  if (modeInfo.mode === 'remote') {
    return await cpFetch<RegistryEntity>(
      `${typePath(table)}/${slug}/versions`,
      {
        method: 'POST',
        body: {
          version,
          content: opts?.content,
          config: opts?.config,
        },
      },
    )
  }
  return dbCreateVersion(
    table,
    tenantId,
    slug,
    version,
    ownerId,
    opts,
  )
}

async function switchVersion(
  table: EntityTable,
  tenantId: string,
  slug: string,
  version: string,
): Promise<void> {
  if (modeInfo.mode === 'remote') {
    await cpFetch(`${typePath(table)}/${slug}/version`, {
      method: 'PUT',
      body: { version },
    })
    return
  }
  dbSwitchVersion(table, tenantId, slug, version)
}

async function removeVersion(
  table: EntityTable,
  tenantId: string,
  slug: string,
  version: string,
  actorId?: string,
): Promise<void> {
  if (modeInfo.mode === 'remote') {
    await cpFetch(
      `${typePath(table)}/${slug}/versions/${version}`,
      { method: 'DELETE' },
    )
    return
  }
  dbRemoveVersion(table, tenantId, slug, version, actorId)
}

export {
  cloneEntity,
  createEntity,
  createVersion,
  deployEntity,
  getEntity,
  getEntityBySlug,
  listEntities,
  listPublicEntities,
  listVersions,
  removeEntity,
  removeVersion,
  switchVersion,
  updateEntity,
}

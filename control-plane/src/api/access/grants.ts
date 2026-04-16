import platform from '@ar/client/platform'
import logger from '@ar/client/utils/logger'

export type AccessGrant = {
  id: string
  resource: string
  scope: string
  status: 'pending' | 'configured' | 'error'
  demoUrl?: string
  instructions?: string
  secrets?: string[]
  createdBy: string
  createdAt: string
  updatedAt: string
}

export async function storeGrant(
  project: string,
  tenantId: string,
  userId: string,
  grant: AccessGrant,
): Promise<void> {
  const bucket = `${project}-ar-registry`
  const path = `${tenantId}/access/${userId}/${grant.id}/grant.json`
  const data = new TextEncoder().encode(JSON.stringify(grant, null, 2))
  await platform.storageUpload(bucket, path, data)
}

export async function loadGrant(
  project: string,
  tenantId: string,
  userId: string,
  grantId: string,
): Promise<AccessGrant | null> {
  const bucket = `${project}-ar-registry`
  const path = `${tenantId}/access/${userId}/${grantId}/grant.json`
  try {
    const exists = await platform.storageExists(bucket, path)
    if (!exists) return null
    const data = await platform.storageDownload(bucket, path)
    return JSON.parse(new TextDecoder().decode(data)) as AccessGrant
  } catch {
    return null
  }
}

export async function findAccessAgent(
  bucket: string,
  tenantId: string,
): Promise<string | null> {
  const path = `${tenantId}/agents/access-agent/0.0.1/source.tar.gz`
  try {
    const exists = await platform.storageExists(bucket, path)
    return exists ? 'access-agent' : null
  } catch {
    return null
  }
}

export function invokeAgent(
  _agentSlug: string,
  payload: Record<string, unknown>,
): Promise<{
  demoUrl?: string
  instructions?: string
  [key: string]: unknown
}> {
  const resource = (payload.resource as string) || 'resource'
  logger.info('Invoking access-agent', { resource })
  return Promise.resolve({
    demoUrl: '',
    instructions: `Complete the access setup for "${resource}" using the ` +
      'generated UI. Copy the context string and send it back ' +
      'to finalize configuration.',
    audit: { action: 'access-request', status: 'success' },
  })
}

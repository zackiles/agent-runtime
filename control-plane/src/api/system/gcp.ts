import platform from '@ar/client/platform'

export async function metadata(path: string): Promise<string> {
  try {
    const res = await fetch(
      `http://metadata.google.internal/computeMetadata/v1/${path}`,
      { headers: { 'Metadata-Flavor': 'Google' } },
    )
    return res.ok ? (await res.text()).trim() : ''
  } catch {
    return ''
  }
}

export async function gcpContext(): Promise<Record<string, string>> {
  const [projectId, zone, numericId] = await Promise.all([
    metadata('project/project-id'),
    metadata('instance/zone'),
    metadata('project/numeric-project-id'),
  ])
  const parts = zone.split('/')
  const zoneName = parts[parts.length - 1] || ''
  const region = zoneName.replace(/-[a-z]$/, '')
  return { projectId, zone: zoneName, region, numericId }
}

type GcsObject = { name: string; size?: string }

export async function storageSummary(
  bucket: string,
  prefix: string,
): Promise<{ files: number; bytes: number }> {
  let token: string
  try {
    token = await platform.getAccessToken()
  } catch {
    return { files: 0, bytes: 0 }
  }

  let files = 0
  let bytes = 0
  let pageToken = ''

  do {
    const params = new URLSearchParams({
      prefix,
      fields: 'items(name,size),nextPageToken',
      maxResults: '1000',
    })
    if (pageToken) params.set('pageToken', pageToken)

    try {
      const res = await fetch(
        `https://storage.googleapis.com/storage/v1/b/${bucket}/o?${params}`,
        { headers: { 'Authorization': `Bearer ${token}` } },
      )
      if (!res.ok) break
      const body = await res.json() as {
        items?: GcsObject[]
        nextPageToken?: string
      }
      for (const item of body.items || []) {
        files++
        bytes += parseInt(item.size || '0', 10)
      }
      pageToken = body.nextPageToken || ''
    } catch {
      break
    }
  } while (pageToken)

  return { files, bytes }
}

type CloudRunService = {
  template?: {
    containers?: Array<{
      resources?: { limits?: Record<string, string> }
    }>
    scaling?: {
      minInstanceCount?: number
      maxInstanceCount?: number
    }
    timeout?: string
    executionEnvironment?: string
    serviceAccount?: string
  }
  uri?: string
  latestReadyRevision?: string
  createTime?: string
  updateTime?: string
}

export async function cloudRunDetails(
  project: string,
  region: string,
  service: string,
): Promise<CloudRunService | null> {
  let token: string
  try {
    token = await platform.getAccessToken()
  } catch {
    return null
  }

  try {
    const url =
      `https://run.googleapis.com/v2/projects/${project}/locations/${region}/services/${service}`
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    })
    if (!res.ok) return null
    return await res.json() as CloudRunService
  } catch {
    return null
  }
}

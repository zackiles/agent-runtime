import platform from '@ar/client/platform'
import type { DemoMeta } from '@ar/client/operations/demos'
import logger from '@ar/client/utils/logger'
import { detectScript, generateDockerfileScript } from './build.ts'

type FileRef = { name: string; path: string }
type FileWithUrl = { name: string; url: string }

export function signFiles(
  bucket: string,
  files: FileRef[],
): Promise<FileWithUrl[]> {
  return Promise.all(files.map(async (f) => {
    const url = await platform.storageSign(bucket, f.path, 'GET', 3600)
    return { name: f.name, url }
  }))
}

export type GcpConfig = {
  project: string
  region: string
  runtimeAccount: string
}

export function gcpConfig(): GcpConfig {
  return {
    project: Deno.env.get('GCP_PROJECT') ||
      Deno.env.get('GOOGLE_CLOUD_PROJECT') || '',
    region: Deno.env.get('GCP_REGION') || '',
    runtimeAccount: Deno.env.get('AR_RUNTIME_ACCOUNT') || '',
  }
}

export async function findDemoAgent(
  bucket: string,
  tenantId: string,
): Promise<string | null> {
  const path = `${tenantId}/agents/demo-agent/0.0.1/source.tar.gz`
  try {
    const exists = await platform.storageExists(bucket, path)
    return exists ? 'demo-agent' : null
  } catch {
    return null
  }
}

let cachedAgentUri: string | null = null
let agentUriExpiry = 0
const AGENT_URI_TTL_MS = 300_000

async function resolveAgentUri(cfg: GcpConfig): Promise<string> {
  if (cachedAgentUri && Date.now() < agentUriExpiry) {
    return cachedAgentUri
  }
  const uri = await platform.functionDescribeUri(
    'demo-agent',
    cfg.region,
    cfg.project,
  )
  cachedAgentUri = uri
  agentUriExpiry = Date.now() + AGENT_URI_TTL_MS
  return uri
}

export async function invokeAgent(
  _agentSlug: string,
  payload: Record<string, unknown>,
): Promise<{ demo?: DemoMeta; [key: string]: unknown }> {
  const cfg = gcpConfig()
  logger.info('Invoking demo-agent', {
    prompt: (payload.prompt as string)?.slice(0, 100),
  })

  const uri = await resolveAgentUri(cfg)
  const token = await platform.getIdentityToken(uri)
  const res = await fetch(uri, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Agent invocation failed (${res.status}): ${text}`)
  }

  return await res.json() as { demo?: DemoMeta; [key: string]: unknown }
}

function serviceName(
  tenantId: string,
  userId: string,
  name: string,
): string {
  const hash = userId.replace(/[^a-z0-9]/gi, '').slice(0, 8)
  return `demo-${tenantId}-${hash}-${name}`
    .slice(0, 49)
    .replace(/-+$/, '')
}

function demoImage(
  cfg: GcpConfig,
  tenantId: string,
  userId: string,
  slug: string,
): string {
  const hash = userId.replace(/[^a-z0-9]/gi, '').slice(0, 8)
  return `${cfg.region}-docker.pkg.dev/${cfg.project}/ar-demos/${tenantId}/${hash}/${slug}:latest`
}

function runUrl(cfg: GcpConfig, ...segments: string[]): string {
  const base =
    `https://run.googleapis.com/v2/projects/${cfg.project}/locations/${cfg.region}`
  return segments.length ? `${base}/${segments.join('/')}` : base
}

export type Visibility = 'public' | 'private'

export type IamBinding = { role: string; members: string[] }

const INVOKER_ROLE = 'roles/run.invoker'
const PUBLIC_MEMBER = 'allUsers'

export function nextDemoBindings(
  visibility: Visibility,
  existing: readonly IamBinding[],
): IamBinding[] {
  const stripped = existing
    .map((b) => ({
      role: b.role,
      members: (b.members || []).filter((m) =>
        !(b.role === INVOKER_ROLE && m === PUBLIC_MEMBER)
      ),
    }))
    .filter((b) => b.members.length > 0)
  if (visibility === 'private') return stripped
  const invoker = stripped.find((b) => b.role === INVOKER_ROLE)
  if (invoker) invoker.members.push(PUBLIC_MEMBER)
  else stripped.push({ role: INVOKER_ROLE, members: [PUBLIC_MEMBER] })
  return stripped
}

async function setServiceAccess(
  cfg: GcpConfig,
  svc: string,
  visibility: Visibility,
  token: string,
): Promise<void> {
  const svcResource = runUrl(cfg, 'services', svc)
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 3000))
    }

    const policyRes = await fetch(
      `${svcResource}:getIamPolicy`,
      { headers },
    )
    if (!policyRes.ok) {
      logger.warn('getIamPolicy failed', {
        status: policyRes.status,
        attempt,
      })
      continue
    }

    const existing = await policyRes.json() as {
      bindings?: IamBinding[]
      etag?: string
    }
    const current = existing.bindings || []
    const hasPublic = current.some((b) =>
      b.role === INVOKER_ROLE && b.members?.includes(PUBLIC_MEMBER)
    )
    if (visibility === 'public' && hasPublic) return
    if (visibility === 'private' && !hasPublic) return

    const setRes = await fetch(`${svcResource}:setIamPolicy`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        policy: {
          bindings: nextDemoBindings(visibility, current),
          etag: existing.etag,
        },
      }),
    })

    if (setRes.ok) return

    logger.warn('setIamPolicy failed', {
      status: setRes.status,
      body: await setRes.text().catch(() => ''),
      attempt,
    })
  }

  logger.error('Failed to set service access after retries', {
    service: svc,
    visibility,
  })
}

let demoRepoCreated = false

async function ensureDemoRepo(cfg: GcpConfig): Promise<void> {
  if (demoRepoCreated) return
  const token = await platform.getAccessToken()
  const url =
    `https://artifactregistry.googleapis.com/v1/projects/${cfg.project}/locations/${cfg.region}/repositories/ar-demos`
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
  })
  if (res.ok) {
    demoRepoCreated = true
    return
  }
  if (res.status !== 404) return

  const createRes = await fetch(
    `https://artifactregistry.googleapis.com/v1/projects/${cfg.project}/locations/${cfg.region}/repositories?repositoryId=ar-demos`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ format: 'DOCKER' }),
    },
  )
  if (createRes.status === 409) {
    demoRepoCreated = true
    return
  }
  if (createRes.ok) {
    const op = await createRes.json() as { name?: string; done?: boolean }
    if (op.name && !op.done) {
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000))
        const t = await platform.getAccessToken()
        const poll = await fetch(
          `https://artifactregistry.googleapis.com/v1/${op.name}`,
          { headers: { 'Authorization': `Bearer ${t}` } },
        )
        if (!poll.ok) continue
        const status = await poll.json() as { done?: boolean }
        if (status.done) break
      }
    }
    demoRepoCreated = true
  }
}

async function buildDemo(
  cfg: GcpConfig,
  tenantId: string,
  userId: string,
  slug: string,
): Promise<string> {
  await ensureDemoRepo(cfg)

  const bucket = `${cfg.project}-ar-registry`
  const sourcePath = `${tenantId}/demos/${userId}/${slug}/source.tar.gz`
  const image = demoImage(cfg, tenantId, userId, slug)

  const buildId = await platform.cloudBuildSubmit({
    project: cfg.project,
    source: { bucket, object: sourcePath },
    steps: [
      {
        name: 'bash',
        entrypoint: 'bash',
        args: ['-c', detectScript()],
      },
      {
        name: 'bash',
        entrypoint: 'bash',
        args: ['-c', generateDockerfileScript()],
      },
      {
        name: 'gcr.io/cloud-builders/docker',
        args: ['build', '-t', image, '/workspace'],
      },
    ],
    images: [image],
    timeout: '300s',
  })

  logger.info('Cloud Build submitted for demo', { buildId, slug, image })
  await platform.waitForBuild(cfg.project, buildId, 300_000)
  return image
}

export async function deployContainer(
  cfg: GcpConfig,
  tenantId: string,
  userId: string,
  meta: DemoMeta,
  visibility: Visibility = 'private',
): Promise<string> {
  const svc = serviceName(tenantId, userId, meta.name)

  logger.info('Building demo container', {
    service: svc,
    slug: meta.name,
    visibility,
  })

  const image = await buildDemo(cfg, tenantId, userId, meta.name)

  try {
    const token = await platform.getAccessToken()

    const serviceBody = {
      template: {
        containers: [{
          image,
          ports: [{ containerPort: 8000 }],
          resources: { limits: { memory: '512Mi', cpu: '1' } },
          env: [{ name: 'DEMO_NAME', value: meta.name }],
        }],
        scaling: { minInstanceCount: 0, maxInstanceCount: 1 },
        serviceAccount: cfg.runtimeAccount,
      },
      ingress: 'INGRESS_TRAFFIC_ALL',
    }

    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    }
    const body = JSON.stringify(serviceBody)

    const createUrl = `${runUrl(cfg, 'services')}?serviceId=${svc}`
    const res = await fetch(createUrl, {
      method: 'POST',
      headers,
      body,
    })

    if (!res.ok && res.status !== 409) {
      const text = await res.text()
      throw new Error(`Cloud Run deploy failed: ${text}`)
    }

    let opName: string | undefined
    if (res.status === 409) {
      const updateRes = await fetch(runUrl(cfg, 'services', svc), {
        method: 'PATCH',
        headers,
        body,
      })
      if (!updateRes.ok) {
        const text = await updateRes.text()
        throw new Error(`Cloud Run update failed: ${text}`)
      }
      const opData = await updateRes.json() as { name?: string }
      opName = opData.name
    } else {
      const opData = await res.json() as { name?: string }
      opName = opData.name
    }

    if (opName) {
      const opUrl = `https://run.googleapis.com/v2/${opName}`
      const deadline = Date.now() + 120_000
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5000))
        const opRes = await fetch(opUrl, {
          headers: { 'Authorization': `Bearer ${token}` },
        })
        if (!opRes.ok) continue
        const op = await opRes.json() as {
          done?: boolean
          error?: { message: string }
        }
        if (op.done) {
          if (op.error) throw new Error(op.error.message)
          break
        }
      }
    }

    await setServiceAccess(cfg, svc, visibility, token)

    const svcResource = runUrl(cfg, 'services', svc)
    for (let attempt = 0; attempt < 10; attempt++) {
      const descRes = await fetch(svcResource, {
        headers: { 'Authorization': `Bearer ${token}` },
      })
      if (descRes.ok) {
        const data = await descRes.json() as { uri?: string }
        if (data.uri) return data.uri
      }
      await new Promise((r) => setTimeout(r, 3000))
    }

    throw new Error(
      `Demo service ${svc} created but URI not available after polling`,
    )
  } catch (err) {
    logger.error('Container deploy error', err)
    throw err
  }
}

export async function deleteImage(
  cfg: GcpConfig,
  tenantId: string,
  userId: string,
  slug: string,
): Promise<void> {
  const token = await platform.getAccessToken()
  const hash = userId.replace(/[^a-z0-9]/gi, '').slice(0, 8)
  const pkg = `${tenantId}/${hash}/${slug}`
  const encoded = encodeURIComponent(pkg)
  const url =
    `https://artifactregistry.googleapis.com/v1/projects/${cfg.project}/locations/${cfg.region}/repositories/ar-demos/packages/${encoded}`
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` },
  })
  if (!res.ok && res.status !== 404) {
    logger.warn('Failed to delete demo image', {
      slug,
      status: res.status,
    })
  }
}

export async function destroyContainer(
  cfg: GcpConfig,
  tenantId: string,
  userId: string,
  name: string,
): Promise<void> {
  const svc = serviceName(tenantId, userId, name)
  const token = await platform.getAccessToken()
  const res = await fetch(runUrl(cfg, 'services', svc), {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` },
  })

  if (!res.ok && res.status !== 404) {
    const text = await res.text()
    throw new Error(`Cloud Run delete failed: ${text}`)
  }

  logger.info('Demo container destroyed', { service: svc })
}

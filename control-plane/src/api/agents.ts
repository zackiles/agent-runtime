import { Hono } from '@hono/hono'
import { context } from '../types.ts'
import type { Env } from '../types.ts'
import {
  addEdge,
  create,
  get,
  getBySlug,
  getEdges,
  getEdgesWithConfig,
  isLead,
  listByTenant,
  listVersions,
  remove,
  removeEdge,
  switchVersion,
  update,
} from '@ar/client/db/agents'
import type { EdgeInput } from '@ar/client/db/agents'
import { canPublish, canWriteAgent } from '@ar/client/db/access'
import { createCron, createEvent, createWebhook } from '@ar/client/db/configs'
import loadRuntime, { registryDir } from '@ar/client/runtime'
import {
  createTeam,
  getTeamByName,
  listDepartments,
  listTeams,
} from '@ar/client/db/teams'
import platform from '@ar/client/platform'
import { SUBSYSTEMS } from '@ar/client/subsystems'
import { compileForDeploy } from '@ar/client/templates'

function resolve(idOrSlug: string, tenantId: string) {
  return get(idOrSlug, tenantId) || getBySlug(tenantId, idOrSlug)
}

type DeployStatus = {
  id: string
  agentId: string
  status: 'building' | 'deploying' | 'done' | 'failed'
  uri?: string
  image?: string
  error?: string
  startedAt: string
  updatedAt: string
}

const deploys = new Map<string, DeployStatus>()

type GroupedAgent = {
  id: string
  name: string
  slug: string
  subsystem: string | null
  sourceType: string | null
  status: string
  team: string | null
  department: string | null
  isLead: boolean
  versions: {
    version: string
    prompt: string | null
    createdAt: string
    active: boolean
  }[]
  updatedAt: string
}

const app = new Hono<Env>()

app.post('/', async (c) => {
  const { tenantId, email } = context(c)
  const body = await c.req.json() as {
    name: string
    slug?: string
    version?: string
    subsystem?: string
    sourceType?: string
    prompt?: string
    visibility?: string
    teamId?: string
    team?: string
    department?: string
    isLead?: boolean
    outputAgentId?: string
    edges?: EdgeInput[]
  }
  const visibility = body.visibility ?? 'private'

  if (visibility === 'public' && !canPublish(tenantId, email, 'public')) {
    return c.json(
      { error: 'No permission to publish to public registry' },
      403,
    )
  }

  if (body.sourceType === 'prompt') {
    if (!body.subsystem) {
      return c.json(
        {
          error: `Prompt agents require a subsystem (${SUBSYSTEMS.join(', ')})`,
        },
        400,
      )
    }
    if (!body.prompt) {
      return c.json({ error: 'Prompt agents require prompt content' }, 400)
    }
    if (visibility === 'public') {
      return c.json(
        { error: 'Prompt agents can only be created in private registry' },
        400,
      )
    }
  }

  let teamId = body.teamId
  if (!teamId && body.team) {
    const existing = getTeamByName(tenantId, body.team)
    if (existing) {
      teamId = existing.id
    } else {
      const created = createTeam(tenantId, body.team, email)
      teamId = created.id
    }
  }

  const slug = body.slug || body.name.toLowerCase().replace(
    /[^a-z0-9]+/g,
    '-',
  )

  const existing = getBySlug(tenantId, slug)
  if (existing) {
    const patch: Parameters<typeof update>[2] = {}
    if (visibility === 'public' && existing.visibility !== 'public') {
      patch.visibility = 'public'
    }
    if (body.subsystem && existing.subsystem !== body.subsystem) {
      patch.subsystem = body.subsystem
    }
    if (Object.keys(patch).length > 0) {
      update(existing.id, tenantId, patch)
      Object.assign(existing, patch)
    }
    const rawEdges = getEdges(existing.id)
    const richEdges = getEdgesWithConfig(existing.id, tenantId)
    return c.json({
      ...existing,
      isLead: isLead(rawEdges),
      edges: richEdges,
    }, 200)
  }

  const opts: Parameters<typeof create>[0] = {
    tenantId,
    name: body.name,
    slug,
    createdBy: email,
  }
  if (body.version) opts.version = body.version
  if (body.subsystem) opts.subsystem = body.subsystem
  if (body.sourceType) opts.sourceType = body.sourceType
  if (body.prompt !== undefined) opts.prompt = body.prompt
  if (body.visibility) opts.visibility = body.visibility
  if (teamId) opts.teamId = teamId
  if (body.edges !== undefined) opts.edges = body.edges
  const agent = create(opts)

  if (body.outputAgentId) {
    addEdge(tenantId, agent.id, 'publishes', 'agent', body.outputAgentId)
  }

  const rawEdges = getEdges(agent.id)
  const richEdges = getEdgesWithConfig(agent.id, tenantId)
  return c.json({
    ...agent,
    isLead: isLead(rawEdges),
    edges: richEdges,
  }, 201)
})

app.get('/', (c) => {
  const { tenantId } = context(c)
  const opts: {
    teamId?: string
    visibility?: string
    sourceType?: string
  } = {}
  const teamId = c.req.query('team')
  const visibility = c.req.query('visibility')
  const sourceType = c.req.query('sourceType')
  if (teamId) opts.teamId = teamId
  if (visibility) opts.visibility = visibility
  if (sourceType) opts.sourceType = sourceType

  const agents = listByTenant(tenantId, opts)
  const teams = listTeams(tenantId)
  const departments = listDepartments(tenantId)
  const teamMap = new Map(teams.map((t) => [t.id, t]))
  const deptMap = new Map(departments.map((d) => [d.id, d]))

  if (sourceType === 'prompt') {
    return c.json(groupBySlug(agents, teamMap, deptMap))
  }

  return c.json(agents.map((a) => {
    const rawEdges = getEdges(a.id)
    const richEdges = getEdgesWithConfig(a.id, tenantId)
    const team = teamMap.get(a.teamId)
    const dept = team ? deptMap.get(team.departmentId) : undefined
    return {
      ...a,
      status: a.uri ? 'deployed' : 'draft',
      team: team?.name ?? null,
      department: dept?.name ?? null,
      isLead: isLead(rawEdges),
      edges: richEdges,
    }
  }))
})

app.get('/:id', (c) => {
  const { tenantId } = context(c)
  const agent = resolve(c.req.param('id'), tenantId)
  if (!agent) return c.json({ error: 'Not found' }, 404)
  const edges = getEdgesWithConfig(agent.id, tenantId)
  return c.json({
    ...agent,
    status: agent.uri ? 'deployed' : 'draft',
    edges,
    isLead: isLead(getEdges(agent.id)),
  })
})

app.get('/:id/edges', (c) => {
  const { tenantId } = context(c)
  const agent = resolve(c.req.param('id'), tenantId)
  if (!agent) return c.json({ error: 'Not found' }, 404)
  return c.json(getEdgesWithConfig(agent.id, tenantId))
})

app.put('/:id', async (c) => {
  const { tenantId, email } = context(c)
  const agent = resolve(c.req.param('id'), tenantId)
  if (!agent) return c.json({ error: 'Not found' }, 404)
  if (!canWriteAgent(tenantId, agent.id, email)) {
    return c.json({ error: 'No permission to modify this agent' }, 403)
  }

  const body = await c.req.json() as {
    name?: string
    subsystem?: string
    prompt?: string
    team?: string
    department?: string
    outputAgentId?: string
    edges?: EdgeInput[]
  }

  let teamId: string | undefined
  if (body.team) {
    const existing = getTeamByName(tenantId, body.team)
    if (existing) {
      teamId = existing.id
    } else {
      const created = createTeam(tenantId, body.team, email)
      teamId = created.id
    }
  }

  const updated = update(agent.id, tenantId, {
    name: body.name,
    subsystem: body.subsystem,
    prompt: body.prompt,
    teamId,
  })

  if (body.edges !== undefined) {
    const oldEdges = getEdges(agent.id)
    for (const e of oldEdges) removeEdge(tenantId, e.id)
    for (const edge of body.edges) {
      let refId: string
      if (edge.type === 'webhook') {
        refId = createWebhook(
          tenantId,
          edge.config as {
            id?: string
            url?: string
          },
        ).id
      } else if (edge.type === 'cron') {
        const cfg = edge.config as
          | { schedule?: string; timezone?: string }
          | undefined
        refId = createCron(
          tenantId,
          cfg?.schedule || '0 * * * *',
          cfg?.timezone,
        ).id
      } else if (edge.type === 'pubsub') {
        const cfg = edge.config as { topic?: string } | undefined
        refId = createEvent(tenantId, cfg?.topic || 'default').id
      } else {
        refId = JSON.stringify(edge.config || {})
      }
      addEdge(tenantId, agent.id, edge.direction, edge.type, refId)
    }
  }

  if (body.outputAgentId && body.edges === undefined) {
    addEdge(tenantId, agent.id, 'publishes', 'agent', body.outputAgentId)
  }

  const agentId = updated?.id || agent.id
  const edges = getEdgesWithConfig(agentId, tenantId)
  return c.json({
    ...(updated || agent),
    edges,
    isLead: isLead(getEdges(agentId)),
  })
})

app.delete('/:id', async (c) => {
  const { tenantId, email } = context(c)
  const agent = resolve(c.req.param('id'), tenantId)
  if (!agent) return c.json({ error: 'Not found' }, 404)
  if (!canWriteAgent(tenantId, agent.id, email)) {
    return c.json({ error: 'No permission to delete this agent' }, 403)
  }

  const project = Deno.env.get('GCP_PROJECT') ||
    Deno.env.get('GOOGLE_CLOUD_PROJECT') || ''
  const region = Deno.env.get('GCP_REGION') || ''
  const rc = loadRuntime()
  const deployMode = rc.agents?.deployMode || 'container'

  if (project && region) {
    try {
      if (deployMode === 'container') {
        await platform.containerDelete(agent.slug, region, project)
      } else {
        await platform.functionDelete(agent.slug, region, project)
      }
    } catch {
      // infrastructure may already be gone
    }
  }

  remove(agent.id, tenantId, email)
  return c.json({ message: 'Deleted' })
})

app.post('/:id/source', async (c) => {
  const { tenantId, email } = context(c)
  const agentId = c.req.param('id')
  let agent = resolve(agentId, tenantId)
  if (!agent) {
    agent = create({
      tenantId,
      name: agentId,
      slug: agentId,
      createdBy: email,
    })
  } else if (!canWriteAgent(tenantId, agent.id, email)) {
    return c.json({ error: 'No permission to upload source' }, 403)
  }

  const project = Deno.env.get('GCP_PROJECT') ||
    Deno.env.get('GOOGLE_CLOUD_PROJECT') || ''
  const bucket = `${project}-ar-registry`
  const version = agent.version || '0.0.1'
  const gcsPath = `${tenantId}/agents/${agent.slug}/${version}/source.tar.gz`

  const body = await c.req.arrayBuffer()
  if (body.byteLength === 0) {
    return c.json({ error: 'Empty body' }, 400)
  }

  await platform.storageUpload(bucket, gcsPath, new Uint8Array(body))
  return c.json({ gcsPath })
})

app.get('/:id/files', async (c) => {
  const { tenantId, email } = context(c)
  const agent = resolve(c.req.param('id'), tenantId)
  if (!agent) return c.json({ error: 'Not found' }, 404)
  if (!canWriteAgent(tenantId, agent.id, email)) {
    return c.json({ error: 'No permission' }, 403)
  }

  const project = Deno.env.get('GCP_PROJECT') ||
    Deno.env.get('GOOGLE_CLOUD_PROJECT') || ''
  const bucket = `${project}-ar-registry`
  const version = agent.version || '0.0.1'
  const prefix = `${tenantId}/agents/${agent.slug}/${version}/files/`
  const paths = await platform.storageList(bucket, prefix)
  const files = paths.map((p) => p.slice(prefix.length)).filter(Boolean)
  return c.json({ files, prefix })
})

app.post('/:id/files/sign', async (c) => {
  const { tenantId, email } = context(c)
  const agent = resolve(c.req.param('id'), tenantId)
  if (!agent) return c.json({ error: 'Not found' }, 404)
  if (!canWriteAgent(tenantId, agent.id, email)) {
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
  const version = agent.version || '0.0.1'
  const method = body.method === 'GET' ? 'GET' : 'PUT'
  const gcsPath =
    `${tenantId}/agents/${agent.slug}/${version}/files/${body.filename}`
  const url = await platform.storageSign(
    bucket,
    gcsPath,
    method,
    600,
    body.contentType || '',
  )
  return c.json({ url, path: gcsPath })
})

type DeployContext = {
  project: string
  region: string
  runtimeAccount: string
  workerAccount: string
  bucket: string
  rc: ReturnType<typeof loadRuntime>
  version: string
  gcsPath: string
}

function deployContext(
  agent: ReturnType<typeof resolve> & Record<string, unknown>,
  tenantId: string,
): DeployContext {
  const project = Deno.env.get('GCP_PROJECT') ||
    Deno.env.get('GOOGLE_CLOUD_PROJECT') || ''
  const region = Deno.env.get('GCP_REGION') || ''
  const runtimeAccount = Deno.env.get('AR_RUNTIME_ACCOUNT') || ''
  const workerAccount = Deno.env.get('AR_WORKER_ACCOUNT') ||
    runtimeAccount
  const bucket = `${project}-ar-registry`
  const rc = loadRuntime()
  const version = (agent.version as string) || '0.0.1'
  const gcsPath = `${tenantId}/agents/${agent.slug}/${version}/source.tar.gz`
  return {
    project,
    region,
    runtimeAccount,
    workerAccount,
    bucket,
    rc,
    version,
    gcsPath,
  }
}

async function resolveSecrets(
  ctx: DeployContext,
): Promise<Record<string, string>> {
  const secrets: Record<string, string> = {}
  const existing = await platform.secretList(ctx.project)
  const names = new Set(existing.map((s) => s.name))
  for (
    const [secretName, envVar] of Object.entries(ctx.rc.secrets || {})
  ) {
    if (names.has(secretName)) {
      secrets[envVar] = secretName
    }
  }
  return secrets
}

function baseEnv(
  ctx: DeployContext,
  tenantId: string,
  slug: string,
): Record<string, string> {
  return {
    AR_CONTROL_PLANE_URL: Deno.env.get('AR_AUDIENCE') || '',
    AR_BUCKET: ctx.bucket,
    AR_TENANT_ID: tenantId,
    AR_AGENT_SLUG: slug,
  }
}

function finalizeDeploy(
  ds: DeployStatus,
  agent: ReturnType<typeof resolve> & Record<string, unknown>,
  tenantId: string,
  uri: string,
): void {
  if (uri) {
    update(agent.id, tenantId, { uri })
  }
  ds.status = 'done'
  ds.uri = uri
  ds.updatedAt = new Date().toISOString()
}

async function wrapDeploy(
  ds: DeployStatus,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn()
  } catch (err) {
    ds.status = 'failed'
    ds.error = err instanceof Error ? err.message : String(err)
    ds.updatedAt = new Date().toISOString()
  }
}

async function runContainerDeploy(
  ds: DeployStatus,
  agent: ReturnType<typeof resolve> & Record<string, unknown>,
  tenantId: string,
): Promise<void> {
  await wrapDeploy(ds, async () => {
    const ctx = deployContext(agent, tenantId)
    const { project, region, bucket, rc, version } = ctx
    const repo = rc.agents?.artifactRepo || 'ar-agents'
    const baseTag =
      `${region}-docker.pkg.dev/${project}/${repo}/base:${rc.version}`
    const agentTag =
      `${region}-docker.pkg.dev/${project}/${repo}/${agent.slug}:${version}`

    ds.status = 'building'
    ds.updatedAt = new Date().toISOString()

    const token = await platform.getAccessToken()
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    }

    const dockerfile = [
      `FROM ${baseTag}`,
      'COPY . /app/agent/',
      'RUN ln -sf /app/runtime/_runtime.cjs /app/agent/_runtime.cjs',
      `ENV AR_AGENT_SLUG=${agent.slug}`,
      `ENV AR_AGENT_VERSION=${version}`,
      'CMD ["node", "/app/runtime/agent-host.js"]',
    ].join('\n')

    const buildBody = {
      source: {
        storageSource: { bucket, object: ctx.gcsPath },
      },
      steps: [
        {
          name: 'ubuntu',
          args: [
            'bash',
            '-c',
            `echo '${dockerfile.replace(/'/g, "'\\''")}' > Dockerfile`,
          ],
        },
        {
          name: 'gcr.io/cloud-builders/docker',
          args: ['build', '-t', agentTag, '.'],
        },
      ],
      images: [agentTag],
    }

    const buildUrl =
      `https://cloudbuild.googleapis.com/v1/projects/${project}/builds`
    const buildRes = await fetch(buildUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildBody),
    })

    if (!buildRes.ok) {
      const text = await buildRes.text()
      throw new Error(`Cloud Build submit failed: ${text}`)
    }

    const buildData = await buildRes.json() as {
      metadata?: { build?: { id?: string } }
    }
    const buildId = buildData.metadata?.build?.id

    if (buildId) {
      const pollUrl = `${buildUrl}/${buildId}`
      let done = false
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 5000))
        const pollRes = await fetch(pollUrl, { headers })
        if (!pollRes.ok) continue
        const poll = await pollRes.json() as { status?: string }
        if (poll.status === 'SUCCESS') {
          done = true
          break
        }
        if (
          poll.status === 'FAILURE' || poll.status === 'TIMEOUT' ||
          poll.status === 'CANCELLED'
        ) {
          throw new Error(
            `Cloud Build ${poll.status.toLowerCase()}`,
          )
        }
      }
      if (!done) {
        throw new Error('Cloud Build timed out after 5 minutes')
      }
    }

    ds.status = 'deploying'
    ds.image = agentTag
    ds.updatedAt = new Date().toISOString()

    const env = {
      ...baseEnv(ctx, tenantId, agent.slug),
      AR_TOOLS_DIR: '/app/tools',
    }
    const secrets = await resolveSecrets(ctx)

    await platform.containerDeploy({
      agentId: agent.slug,
      region,
      project,
      image: agentTag,
      runtimeAccount: ctx.runtimeAccount,
      workerAccount: ctx.workerAccount,
      env,
      secrets,
      fuseBucket: bucket,
      memory: '2Gi',
      cpu: '1',
    })

    let uri = ''
    try {
      const svcToken = await platform.getAccessToken()
      const svcUrl =
        `https://run.googleapis.com/v2/projects/${project}/locations/${region}/services/${agent.slug}`
      const svcRes = await fetch(svcUrl, {
        headers: { 'Authorization': `Bearer ${svcToken}` },
      })
      if (svcRes.ok) {
        const svcData = await svcRes.json() as { uri?: string }
        uri = svcData.uri || ''
      }
    } catch { /* URI will be empty */ }

    finalizeDeploy(ds, agent, tenantId, uri)
  })
}

async function runSourceDeploy(
  ds: DeployStatus,
  agent: ReturnType<typeof resolve> & Record<string, unknown>,
  tenantId: string,
): Promise<void> {
  await wrapDeploy(ds, async () => {
    const ctx = deployContext(agent, tenantId)
    const { project, region, bucket, rc } = ctx

    ds.status = 'building'
    ds.updatedAt = new Date().toISOString()

    const tmpDir = await Deno.makeTempDir()
    try {
      const archiveBytes = await platform.storageDownload(
        bucket,
        ctx.gcsPath,
      )
      const archivePath = `${tmpDir}/source.tar.gz`
      await Deno.writeFile(archivePath, archiveBytes)

      const extractDir = `${tmpDir}/source`
      await Deno.mkdir(extractDir, { recursive: true })
      const tar = new Deno.Command('tar', {
        args: ['-xzf', archivePath, '-C', extractDir],
        stdout: 'piped',
        stderr: 'piped',
      })
      const tarOut = await tar.output()
      if (!tarOut.success) {
        throw new Error('Failed to extract source archive')
      }

      try {
        const runtimeBytes = await platform.storageDownload(
          bucket,
          `runtime/_runtime.cjs`,
        )
        await Deno.writeFile(
          `${extractDir}/_runtime.cjs`,
          runtimeBytes,
        )
      } catch {
        // _runtime.cjs may already be in the source archive
      }

      const filesPrefix =
        `${tenantId}/agents/${agent.slug}/${ctx.version}/files/`
      const filePaths = await platform.storageList(bucket, filesPrefix)
      if (filePaths.length > 0) {
        const filesDest = `${extractDir}/files`
        await Deno.mkdir(filesDest, { recursive: true })
        for (const p of filePaths) {
          const name = p.slice(filesPrefix.length)
          if (!name) continue
          try {
            const data = await platform.storageDownload(bucket, p)
            await Deno.writeFile(`${filesDest}/${name}`, data)
          } catch { /* best-effort */ }
        }
      }

      const toolsDest = `${extractDir}/tools`
      await Deno.mkdir(toolsDest, { recursive: true })
      let registry: string | undefined
      try {
        registry = registryDir()
      } catch { /* no registry */ }
      if (registry) {
        for (const tool of rc.tools || []) {
          const src = `${registry}/tools/${tool.slug}/${tool.version}`
          const dest = `${toolsDest}/${tool.slug}`
          await Deno.mkdir(dest, { recursive: true })

          const toolFilesPrefix =
            `${tenantId}/tools/${tool.slug}/${tool.version}/files/`
          const toolFilePaths = await platform.storageList(
            bucket,
            toolFilesPrefix,
          )
          for (const p of toolFilePaths) {
            const name = p.slice(toolFilesPrefix.length)
            if (!name) continue
            try {
              const data = await platform.storageDownload(bucket, p)
              await Deno.writeFile(`${dest}/${name}`, data)
            } catch { /* best-effort */ }
          }

          try {
            for await (const entry of Deno.readDir(src)) {
              if (!entry.isFile) continue
              if (entry.name === 'README.md') continue
              await Deno.copyFile(
                `${src}/${entry.name}`,
                `${dest}/${entry.name}`,
              )
            }
          } catch { /* source dir may not exist */ }
        }
      }

      ds.status = 'deploying'
      ds.updatedAt = new Date().toISOString()

      const env = baseEnv(ctx, tenantId, agent.slug)
      const secrets = await resolveSecrets(ctx)

      await platform.functionDeploy({
        agentId: agent.slug,
        region,
        project,
        runtime: rc.platform?.runtime || 'nodejs22',
        entryPoint: 'handler',
        runtimeAccount: ctx.runtimeAccount,
        workerAccount: ctx.workerAccount,
        source: extractDir,
        secrets,
        env,
        memory: '2Gi',
        cpu: '1',
      })

      let uri = ''
      try {
        uri = await platform.functionDescribeUri(
          agent.slug,
          region,
          project,
        )
      } catch { /* URI will be empty */ }

      finalizeDeploy(ds, agent, tenantId, uri)
    } finally {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {})
    }
  })
}

app.get('/:id/deploy/status', (c) => {
  const agentId = c.req.param('id')
  const { tenantId } = context(c)
  const key = `${tenantId}/${agentId}`
  const ds = deploys.get(key)
  if (!ds) return c.json({ error: 'No deploy in progress' }, 404)
  return c.json(ds)
})

app.post('/:id/deploy', async (c) => {
  const { tenantId, email } = context(c)
  const agentId = c.req.param('id')
  let agent = resolve(agentId, tenantId)
  if (!agent) {
    agent = create({
      tenantId,
      name: agentId,
      slug: agentId,
      createdBy: email,
    })
  } else if (!canWriteAgent(tenantId, agent.id, email)) {
    return c.json({ error: 'No permission to deploy this agent' }, 403)
  }

  const project = Deno.env.get('GCP_PROJECT') ||
    Deno.env.get('GOOGLE_CLOUD_PROJECT') || ''
  const bucket = `${project}-ar-registry`
  const version = agent.version || '0.0.1'
  const gcsPath = `${tenantId}/agents/${agent.slug}/${version}/source.tar.gz`

  if (agent.sourceType === 'prompt') {
    if (!agent.prompt) {
      return c.json({ error: 'Agent has no prompt content' }, 400)
    }
    if (!agent.subsystem) {
      return c.json({ error: 'Agent has no subsystem configured' }, 400)
    }
    const compiled = compileForDeploy(agent.prompt, agent.subsystem)
    return c.json({
      message: `Deploy triggered for prompt agent ${agentId}`,
      gcsPath,
      compiled: {
        files: Object.keys(compiled),
        subsystem: agent.subsystem,
      },
    })
  }

  const rc = loadRuntime()
  const deployMode = rc.agents?.deployMode || 'container'

  if (deployMode === 'container') {
    const deployId = crypto.randomUUID()
    const key = `${tenantId}/${agent.slug}`
    const ds: DeployStatus = {
      id: deployId,
      agentId: agent.slug,
      status: 'building',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    deploys.set(key, ds)

    runContainerDeploy(
      ds,
      agent as ReturnType<typeof resolve> & Record<string, unknown>,
      tenantId,
    )

    return c.json({
      deployId,
      status: 'building',
      message: `Deploy started for ${agentId}`,
      statusUrl: `/agents/${agent.slug}/deploy/status`,
    }, 202)
  }

  const body = await c.req.arrayBuffer()
  if (body.byteLength > 0) {
    const archive = new Uint8Array(body)
    await platform.storageUpload(bucket, gcsPath, archive)
  }

  const deployId = crypto.randomUUID()
  const key = `${tenantId}/${agent.slug}`
  const ds: DeployStatus = {
    id: deployId,
    agentId: agent.slug,
    status: 'building',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  deploys.set(key, ds)

  runSourceDeploy(
    ds,
    agent as ReturnType<typeof resolve> & Record<string, unknown>,
    tenantId,
  )

  return c.json({
    deployId,
    status: 'building',
    message: `Source deploy started for ${agentId}`,
    statusUrl: `/agents/${agent.slug}/deploy/status`,
  }, 202)
})

app.post('/:id/invoke', (c) => {
  return c.json({ message: `Invoked ${c.req.param('id')}` })
})

app.get('/:id/logs', (c) => {
  return c.json({ logs: '' })
})

app.put('/:id/version', async (c) => {
  const { tenantId, email } = context(c)
  const body = await c.req.json() as { version: string }
  const agent = resolve(c.req.param('id'), tenantId)
  if (!agent) return c.json({ error: 'Not found' }, 404)
  if (!canWriteAgent(tenantId, agent.id, email)) {
    return c.json({ error: 'No permission to modify this agent' }, 403)
  }
  switchVersion(tenantId, agent.slug, body.version)
  return c.json({ message: `Version switched to ${body.version}` })
})

app.get('/:id/versions', (c) => {
  const { tenantId } = context(c)
  const agent = resolve(c.req.param('id'), tenantId)
  if (!agent) return c.json({ error: 'Not found' }, 404)
  const versions = listVersions(tenantId, agent.slug)
  return c.json(versions.map((v) => ({
    version: v.version,
    prompt: v.prompt,
    createdAt: v.createdAt,
    active: v.activeVersion === v.version,
  })))
})

app.post('/:id/versions', async (c) => {
  const { tenantId, email } = context(c)
  const agent = resolve(c.req.param('id'), tenantId)
  if (!agent) return c.json({ error: 'Not found' }, 404)
  if (!canWriteAgent(tenantId, agent.id, email)) {
    return c.json({ error: 'No permission to modify this agent' }, 403)
  }

  const body = await c.req.json() as {
    version: string
    prompt?: string
  }

  const newAgent = create({
    tenantId,
    name: agent.name,
    slug: agent.slug,
    version: body.version,
    subsystem: agent.subsystem ?? undefined,
    sourceType: agent.sourceType ?? undefined,
    prompt: body.prompt,
    createdBy: email,
  })

  switchVersion(tenantId, agent.slug, body.version)

  return c.json(newAgent, 201)
})

app.delete('/:id/versions/:version', (c) => {
  const { tenantId, email } = context(c)
  const agent = resolve(c.req.param('id'), tenantId)
  if (!agent) return c.json({ error: 'Not found' }, 404)

  const versions = listVersions(tenantId, agent.slug)
  const target = versions.find((v) => v.version === c.req.param('version'))
  if (!target) return c.json({ error: 'Version not found' }, 404)

  if (!canWriteAgent(tenantId, target.id, email)) {
    return c.json({ error: 'No permission to modify this agent' }, 403)
  }

  remove(target.id, tenantId, email)
  return c.json({ message: `Version ${c.req.param('version')} deleted` })
})

function groupBySlug(
  agents: ReturnType<typeof listByTenant>,
  teamMap: Map<string, { name: string; departmentId: string }>,
  deptMap: Map<string, { name: string }>,
): GroupedAgent[] {
  const groups = new Map<string, typeof agents>()
  for (const agent of agents) {
    const existing = groups.get(agent.slug) || []
    existing.push(agent)
    groups.set(agent.slug, existing)
  }

  const result: GroupedAgent[] = []
  for (const [, versions] of groups) {
    const latest = versions[versions.length - 1]
    const edges = getEdges(latest.id)
    const team = teamMap.get(latest.teamId)
    const dept = team ? deptMap.get(team.departmentId) : undefined
    result.push({
      id: latest.id,
      name: latest.name,
      slug: latest.slug,
      subsystem: latest.subsystem,
      sourceType: latest.sourceType,
      status: 'draft',
      team: team?.name ?? null,
      department: dept?.name ?? null,
      isLead: isLead(edges),
      versions: versions.map((v) => ({
        version: v.version,
        prompt: v.prompt,
        createdAt: v.createdAt,
        active: v.activeVersion === v.version ||
          (v.activeVersion === null &&
            v.version === latest.version),
      })),
      updatedAt: latest.updatedAt,
    })
  }
  return result
}

export default app

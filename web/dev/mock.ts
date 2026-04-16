import type { Connect, Plugin } from 'vite'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Buffer } from 'node:buffer'

const DEV_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(DEV_DIR, '..', '..')

function loadFixture(name: string): unknown {
  const path = join(DEV_DIR, 'fixtures', `${name}.json`)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf-8'))
}

type Route = {
  method: string
  pattern: RegExp
  fixture: string
}

const routes: Route[] = [
  { method: 'GET', pattern: /^\/system\/?$/, fixture: 'system' },
  { method: 'GET', pattern: /^\/audit\/?$/, fixture: 'audit' },
  {
    method: 'GET',
    pattern: /^\/api\/user\/permissions\/?$/,
    fixture: 'permissions',
  },
  { method: 'POST', pattern: /^\/copy\/preview\/?$/, fixture: 'copy-preview' },
  { method: 'GET', pattern: /^\/copy\/options\/?$/, fixture: 'copy-options' },
  { method: 'POST', pattern: /^\/copy\/?$/, fixture: 'copy' },
  {
    method: 'POST',
    pattern: /^\/(agents|tools|skills|rules)\/promote\/?$/,
    fixture: 'promote',
  },
  { method: 'GET', pattern: /^\/api\/teams\/?$/, fixture: 'teams' },
  {
    method: 'GET',
    pattern: /^\/api\/departments\/?$/,
    fixture: 'departments',
  },
]

function stubJson(
  res: Connect.ServerResponse,
  data: unknown,
  status = 200,
) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(data))
}

function readBody(
  req: Connect.IncomingMessage,
): Promise<string> {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk))
    req.on('end', () => resolve(body))
  })
}

function mockUuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(
    /[xy]/g,
    (c) => {
      const r = (Math.random() * 16) | 0
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
    },
  )
}

type MockEdge = {
  direction: string
  type: string
  config?: Record<string, unknown>
}

function parseUrl(raw: string): { path: string; params: URLSearchParams } {
  const idx = raw.indexOf('?')
  if (idx < 0) return { path: raw, params: new URLSearchParams() }
  return {
    path: raw.slice(0, idx),
    params: new URLSearchParams(raw.slice(idx + 1)),
  }
}

async function handleAgentRoutes(
  req: Connect.IncomingMessage,
  res: Connect.ServerResponse,
): Promise<boolean> {
  const { path, params } = parseUrl(req.url || '')
  const method = req.method || 'GET'

  if (method === 'GET' && /^\/api\/agents\/?$/.test(path)) {
    const sourceType = params.get('sourceType')
    const visibility = params.get('visibility')
    if (sourceType === 'prompt') {
      stubJson(res, loadFixture('prompt-agents') ?? [])
    } else if (visibility === 'private') {
      stubJson(res, loadFixture('agents-private') ?? [])
    } else if (visibility === 'public') {
      stubJson(res, loadFixture('agents-public') ?? [])
    } else {
      stubJson(res, loadFixture('agents') ?? [])
    }
    return true
  }

  if (method === 'POST' && /^\/api\/agents\/?$/.test(path)) {
    const raw = await readBody(req)
    const data = JSON.parse(raw || '{}')
    const id = `pa-${Date.now()}`
    const slug = (data.name || 'agent')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')

    const inputEdges = (data.edges as MockEdge[] | undefined) || [
      { direction: 'consumes', type: 'webhook' },
      { direction: 'publishes', type: 'webhook' },
    ]
    const edges = inputEdges.map((e: MockEdge, i: number) => ({
      ...e,
      id: i + 1,
      config: {
        ...(e.config || {}),
        ...(e.type === 'webhook' && !e.config?.id ? { id: mockUuid() } : {}),
      },
    }))

    stubJson(res, {
      id,
      name: data.name,
      slug,
      subsystem: data.subsystem || 'claude',
      sourceType: data.sourceType || 'prompt',
      prompt: data.prompt || '',
      status: 'draft',
      team: data.team || null,
      department: data.department || null,
      isLead: data.isLead ?? true,
      version: data.version || '0.0.1',
      edges,
      updatedAt: new Date().toISOString(),
    }, 201)
    return true
  }

  if (
    method === 'GET' &&
    /^\/api\/agents\/[^/]+\/edges\/?$/.test(path)
  ) {
    stubJson(res, [
      {
        id: 1,
        direction: 'consumes',
        type: 'webhook',
        config: { id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d' },
      },
      {
        id: 2,
        direction: 'publishes',
        type: 'webhook',
        config: { id: 'f6e5d4c3-b2a1-4f6e-5d4c-3b2a1f6e5d4c' },
      },
    ])
    return true
  }

  if (
    method === 'POST' &&
    /^\/webhook\/[^/]+\/?$/.test(path)
  ) {
    stubJson(res, {
      accepted: true,
      agentId: 'mock-agent',
      webhookId: path.split('/').pop(),
      receivedAt: new Date().toISOString(),
    })
    return true
  }

  if (method === 'PUT' && /^\/api\/agents\/[^/]+\/?$/.test(path)) {
    const raw = await readBody(req)
    const data = JSON.parse(raw || '{}')
    const agentId = path.split('/').filter(Boolean).pop() || 'unknown'
    const inputEdges = data.edges as MockEdge[] | undefined
    const edges = inputEdges?.map((e: MockEdge, i: number) => ({
      ...e,
      id: i + 1,
      config: {
        ...(e.config || {}),
        ...(e.type === 'webhook' && !e.config?.id ? { id: mockUuid() } : {}),
      },
    }))
    stubJson(res, {
      id: agentId,
      name: data.name,
      subsystem: data.subsystem,
      prompt: data.prompt,
      team: data.team || null,
      department: data.department || null,
      isLead: true,
      status: 'draft',
      updatedAt: new Date().toISOString(),
      ...(edges !== undefined ? { edges } : {}),
    })
    return true
  }

  if (method === 'DELETE' && /^\/api\/agents\/[^/]+\/?$/.test(path)) {
    stubJson(res, { message: 'Deleted' })
    return true
  }

  if (
    method === 'POST' &&
    /^\/api\/agents\/[^/]+\/deploy\/?$/.test(path)
  ) {
    stubJson(res, { message: 'Deploy triggered' })
    return true
  }

  if (
    method === 'GET' &&
    /^\/api\/agents\/[^/]+\/versions\/?$/.test(path)
  ) {
    stubJson(res, [])
    return true
  }

  if (
    method === 'POST' &&
    /^\/api\/agents\/[^/]+\/versions\/?$/.test(path)
  ) {
    const raw = await readBody(req)
    const data = JSON.parse(raw || '{}')
    stubJson(res, {
      id: `pa-${Date.now()}`,
      version: data.version || '0.0.1',
      prompt: data.prompt || '',
      createdAt: new Date().toISOString(),
    }, 201)
    return true
  }

  if (
    method === 'DELETE' &&
    /^\/api\/agents\/[^/]+\/versions\/[^/]+\/?$/.test(path)
  ) {
    stubJson(res, { message: 'Version deleted' })
    return true
  }

  if (method === 'POST' && /^\/api\/teams\/?$/.test(path)) {
    const raw = await readBody(req)
    const data = JSON.parse(raw || '{}')
    stubJson(res, {
      id: `team-${Date.now()}`,
      name: data.name,
    }, 201)
    return true
  }

  if (method === 'POST' && /^\/api\/departments\/?$/.test(path)) {
    const raw = await readBody(req)
    const data = JSON.parse(raw || '{}')
    stubJson(res, {
      id: `dept-${Date.now()}`,
      name: data.name,
    }, 201)
    return true
  }

  return false
}

async function handleDemoRoutes(
  req: Connect.IncomingMessage,
  res: Connect.ServerResponse,
): Promise<boolean> {
  const { path } = parseUrl(req.url || '')
  const method = req.method || 'GET'

  if (method === 'GET' && /^\/api\/demos\/?$/.test(path)) {
    stubJson(
      res,
      loadFixture('demos') ?? [
        {
          name: 'sample-dashboard',
          url: 'https://demo-dev-sample-dashboard.run.app',
          path: '/tmp/demos/sample-dashboard',
          prompt: 'Build a real-time analytics dashboard',
          summary:
            'Interactive analytics dashboard with live charts and data filtering.',
          createdAt: '2025-06-01T10:00:00Z',
          updatedAt: '2025-06-02T14:30:00Z',
          createdBy: 'dev@local',
          status: 'running',
          visibility: 'public',
        },
        {
          name: 'landing-page',
          url: '',
          path: '/tmp/demos/landing-page',
          prompt: 'Create a SaaS landing page with pricing',
          summary: 'Modern SaaS landing page with hero, features, and pricing.',
          createdAt: '2025-06-03T08:00:00Z',
          updatedAt: '2025-06-03T08:00:00Z',
          createdBy: 'dev@local',
          status: 'created',
          visibility: 'private',
        },
      ],
    )
    return true
  }

  if (method === 'POST' && /^\/api\/demos\/?$/.test(path)) {
    const raw = await readBody(req)
    const data = JSON.parse(raw || '{}')
    const slug = (data.name || data.prompt || 'demo')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 48)
    stubJson(res, {
      demo: {
        name: slug,
        url: '',
        path: `/tmp/demos/${slug}`,
        prompt: data.prompt || '',
        summary: 'Demo created from prompt.',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        createdBy: 'dev@local',
        status: 'created',
        visibility: 'private',
      },
      audit: { action: 'create', status: 'success' },
    }, 201)
    return true
  }

  if (
    method === 'POST' &&
    /^\/api\/demos\/[^/]+\/deploy\/?$/.test(path)
  ) {
    const raw = await readBody(req)
    let visibility = 'private'
    try {
      const data = JSON.parse(raw || '{}')
      if (data.visibility === 'public') visibility = 'public'
    } catch { /* no body */ }
    stubJson(res, {
      url: 'https://demo-dev-example.run.app',
      status: 'deployed',
      visibility,
    })
    return true
  }

  if (
    method === 'POST' &&
    /^\/api\/demos\/[^/]+\/stop\/?$/.test(path)
  ) {
    stubJson(res, { status: 'stopped' })
    return true
  }

  if (
    method === 'POST' &&
    /^\/api\/demos\/[^/]+\/update\/?$/.test(path)
  ) {
    stubJson(res, {
      demo: { name: 'updated', status: 'created' },
      audit: { action: 'update', status: 'success' },
    })
    return true
  }

  if (
    method === 'DELETE' &&
    /^\/api\/demos\/[^/]+\/?$/.test(path)
  ) {
    stubJson(res, { message: 'Deleted' })
    return true
  }

  if (
    method === 'GET' &&
    /^\/api\/demos\/[^/]+\/download\/?$/.test(path)
  ) {
    stubJson(res, {
      files: {
        'index.html': btoa('<html><body>Demo</body></html>'),
        'main.js': btoa("console.log('demo')"),
      },
    })
    return true
  }

  return false
}

function handleSlackBotRoutes(
  req: Connect.IncomingMessage,
  res: Connect.ServerResponse,
): boolean {
  const { path } = parseUrl(req.url || '')
  const method = req.method || 'GET'

  if (
    method === 'GET' &&
    /^\/api\/bots\/slack\/messages\/list\/?$/.test(path)
  ) {
    stubJson(res, loadFixture('slack-messages') ?? { messages: [], total: 0 })
    return true
  }

  if (
    method === 'POST' &&
    /^\/api\/bots\/slack\/identity\/resolve\/?$/.test(path)
  ) {
    stubJson(res, {
      email: 'user@example.com',
      slackUserId: 'U01ABC123',
      slackTeamId: 'T01XYZ',
      displayName: 'Jane Developer',
      slackEmail: 'jane@example.com',
      enabled: true,
    })
    return true
  }

  if (
    method === 'POST' &&
    /^\/api\/bots\/slack\/oauth\/start\/?$/.test(path)
  ) {
    stubJson(res, {
      url: '#slack-oauth-mock',
      state: 'mock-state',
    })
    return true
  }

  if (
    method === 'POST' &&
    /^\/api\/bots\/slack\/oauth\/revoke\/?$/.test(path)
  ) {
    stubJson(res, { ok: true })
    return true
  }

  return false
}

async function handleAccessRoutes(
  req: Connect.IncomingMessage,
  res: Connect.ServerResponse,
): Promise<boolean> {
  const { path } = parseUrl(req.url || '')
  const method = req.method || 'GET'

  if (method === 'GET' && /^\/api\/access\/?$/.test(path)) {
    stubJson(res, [
      {
        id: 'google-drive-1717200000000',
        resource: 'google-drive',
        scope: 'private',
        status: 'configured',
        instructions: 'Google Drive access configured successfully.',
        secrets: [
          'access-google-drive-token',
          'access-google-drive-refresh-token',
        ],
        createdBy: 'user@example.com',
        createdAt: '2025-06-01T10:00:00Z',
        updatedAt: '2025-06-01T10:05:00Z',
      },
      {
        id: 'openai-1717300000000',
        resource: 'openai',
        scope: 'private',
        status: 'pending',
        instructions:
          'Complete the access setup for "openai" using the generated UI.',
        createdBy: 'user@example.com',
        createdAt: '2025-06-02T08:00:00Z',
        updatedAt: '2025-06-02T08:00:00Z',
      },
    ])
    return true
  }

  if (method === 'POST' && /^\/api\/access\/?$/.test(path)) {
    const raw = await readBody(req)
    const data = JSON.parse(raw || '{}')
    const slug = (data.resource || 'resource')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
    stubJson(res, {
      id: `${slug}-${Date.now()}`,
      resource: data.resource || 'resource',
      scope: data.scope || 'private',
      status: 'pending',
      demoUrl: '',
      instructions:
        `Complete the access setup for "${data.resource}" using the generated UI. ` +
        'Copy the context string and send it back to finalize configuration.',
      createdBy: 'user@example.com',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, 201)
    return true
  }

  if (method === 'POST' && /^\/api\/access\/callback\/?$/.test(path)) {
    stubJson(res, {
      status: 'configured',
      resource: 'resource',
      scope: 'private',
      secrets: ['access-resource-token'],
    })
    return true
  }

  if (
    method === 'DELETE' &&
    /^\/api\/access\/[^/]+\/?$/.test(path)
  ) {
    stubJson(res, { message: 'Deleted' })
    return true
  }

  return false
}

function handleArtifactRoutes(
  req: Connect.IncomingMessage,
  res: Connect.ServerResponse,
): boolean {
  const { path } = parseUrl(req.url || '')
  const method = req.method || 'GET'

  if (method === 'GET' && /^\/api\/artifacts\/?$/.test(path)) {
    const ago = (h: number) => new Date(Date.now() - h * 3600000).toISOString()
    stubJson(res, {
      project: 'my-project',
      region: 'us-central1',
      repo: 'ar-agents',
      totalImages: 8,
      totalPackages: 3,
      totalSize: 524288000,
      packages: [
        {
          name: 'base',
          tags: ['0.3.0', '0.2.9', 'latest'],
          versions: [
            {
              digest: 'sha256:a1b2c3d4e5f6a1b2c3d4e5f6',
              tags: ['0.3.0', 'latest'],
              size: 204800000,
              uploadTime: ago(2),
              buildTime: ago(2),
              updateTime: ago(2),
              mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
            },
            {
              digest: 'sha256:f6e5d4c3b2a1f6e5d4c3b2a1',
              tags: ['0.2.9'],
              size: 198000000,
              uploadTime: ago(48),
              buildTime: ago(48),
              updateTime: ago(48),
              mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
            },
          ],
          totalSize: 402800000,
          latestUpload: ago(2),
        },
        {
          name: 'hello-world',
          tags: ['0.0.1'],
          versions: [
            {
              digest: 'sha256:1234abcd5678ef901234abcd',
              tags: ['0.0.1'],
              size: 85000000,
              uploadTime: ago(6),
              buildTime: ago(6),
              updateTime: ago(6),
              mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
            },
          ],
          totalSize: 85000000,
          latestUpload: ago(6),
        },
        {
          name: 'code-reviewer',
          tags: ['0.0.1', '0.0.2'],
          versions: [
            {
              digest: 'sha256:abcdef1234567890abcdef12',
              tags: ['0.0.2'],
              size: 22000000,
              uploadTime: ago(12),
              buildTime: ago(12),
              updateTime: ago(12),
              mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
            },
            {
              digest: 'sha256:9876543210fedcba98765432',
              tags: ['0.0.1'],
              size: 14488000,
              uploadTime: ago(72),
              buildTime: ago(72),
              updateTime: ago(72),
              mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
            },
          ],
          totalSize: 36488000,
          latestUpload: ago(12),
        },
      ],
    })
    return true
  }

  if (
    method === 'GET' &&
    /^\/api\/artifacts\/builds\/?$/.test(path)
  ) {
    const ago = (h: number) => new Date(Date.now() - h * 3600000).toISOString()
    stubJson(res, [
      {
        id: 'b1a2c3d4-e5f6-7890-abcd-ef1234567890',
        status: 'SUCCESS',
        createTime: ago(2),
        startTime: ago(2),
        finishTime: new Date(
          Date.now() - 2 * 3600000 + 95000,
        ).toISOString(),
        images: [
          'us-central1-docker.pkg.dev/my-project/ar-agents/base:0.3.0',
        ],
        logUrl: 'https://storage.cloud.google.com/my-project_cloudbuild/logs/',
        duration: 95000,
        results: {
          images: [{
            name: 'us-central1-docker.pkg.dev/my-project/ar-agents/base:0.3.0',
            digest: 'sha256:a1b2c3d4e5f6a1b2c3d4e5f6',
          }],
        },
      },
      {
        id: 'c2d3e4f5-a6b7-8901-cdef-234567890abc',
        status: 'SUCCESS',
        createTime: ago(6),
        startTime: ago(6),
        finishTime: new Date(
          Date.now() - 6 * 3600000 + 42000,
        ).toISOString(),
        images: [
          'us-central1-docker.pkg.dev/my-project/ar-agents/hello-world:0.0.1',
        ],
        logUrl: 'https://storage.cloud.google.com/my-project_cloudbuild/logs/',
        duration: 42000,
        results: {
          images: [{
            name:
              'us-central1-docker.pkg.dev/my-project/ar-agents/hello-world:0.0.1',
            digest: 'sha256:1234abcd5678ef901234abcd',
          }],
        },
      },
      {
        id: 'd3e4f5a6-b7c8-9012-defa-34567890bcde',
        status: 'FAILURE',
        createTime: ago(24),
        startTime: ago(24),
        finishTime: new Date(
          Date.now() - 24 * 3600000 + 18000,
        ).toISOString(),
        images: [
          'us-central1-docker.pkg.dev/my-project/ar-agents/data-pipeline:0.0.1',
        ],
        logUrl: 'https://storage.cloud.google.com/my-project_cloudbuild/logs/',
        duration: 18000,
        results: null,
      },
    ])
    return true
  }

  if (
    method === 'GET' &&
    /^\/api\/artifacts\/builds\/[^/]+\/logs\/?$/.test(path)
  ) {
    stubJson(res, {
      logs: [
        'starting build "b1a2c3d4-e5f6-7890-abcd-ef1234567890"',
        '',
        'FETCHSOURCE',
        'Fetching storage object: gs://my-project-ar-registry/...',
        'Copying gs://my-project-ar-registry/source.tar.gz...',
        '',
        'BUILD',
        'Step #0: Already have image (with digest): ubuntu',
        "Step #0: + echo 'FROM us-central1-docker.pkg.dev/...'",
        'Step #0: Finished',
        'Step #1: Pulling image: gcr.io/cloud-builders/docker',
        'Step #1: Sending build context to Docker daemon  42.5kB',
        'Step #1: Step 1/6 : FROM base:0.3.0',
        'Step #1: Step 2/6 : COPY . /app/agent/',
        'Step #1: Step 3/6 : RUN ln -sf ...',
        'Step #1: Step 4/6 : ENV AR_AGENT_SLUG=hello-world',
        'Step #1: Step 5/6 : ENV AR_AGENT_VERSION=0.0.1',
        'Step #1: Step 6/6 : CMD ["node", "agent-host.js"]',
        'Step #1: Successfully built a1b2c3d4e5f6',
        'Step #1: Successfully tagged hello-world:0.0.1',
        'Step #1: Finished',
        '',
        'PUSH',
        'Pushing us-central1-docker.pkg.dev/.../hello-world:0.0.1',
        'The push refers to repository [us-central1-docker.pkg.dev/...]',
        '0.0.1: digest: sha256:1234abcd5678... size: 2200',
        '',
        'DONE',
        'Build successful',
      ].join('\n'),
      logUrl: 'https://storage.cloud.google.com/my-project_cloudbuild/logs/',
    })
    return true
  }

  if (
    method === 'DELETE' &&
    /^\/api\/artifacts\/packages\/[^/]+\/builds\/?$/.test(path)
  ) {
    const parts = path.split('/').filter(Boolean)
    const name = decodeURIComponent(parts[3] || '')
    stubJson(res, {
      message: `Cleared 1 old build(s) for ${name}`,
      retained: {
        digest: 'sha256:a1b2c3d4e5f6',
        tags: ['latest', '0.3.0'],
        uploadTime: new Date().toISOString(),
      },
      deleted: [
        {
          digest: 'sha256:f6e5d4c3b2a1',
          tags: ['0.2.9'],
          size: 198000000,
          uploadTime: new Date(Date.now() - 48 * 3600000).toISOString(),
        },
      ],
    })
    return true
  }

  if (
    method === 'DELETE' &&
    /^\/api\/artifacts\/packages\/[^/]+\/?$/.test(path)
  ) {
    const name = path.split('/').filter(Boolean).pop() || ''
    stubJson(res, {
      message: `Package ${decodeURIComponent(name)} deleted`,
    })
    return true
  }

  if (
    method === 'DELETE' &&
    /^\/api\/artifacts\/packages\/[^/]+\/versions\/[^/]+\/?$/
      .test(path)
  ) {
    stubJson(res, { message: 'Version deleted' })
    return true
  }

  return false
}

type DocNode = { label: string; path: string; children?: DocNode[] }

function labelFromFile(name: string): string {
  return name
    .replace(/\.md$/i, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function buildDocTree(): DocNode[] {
  const docsDir = join(REPO_ROOT, 'docs')
  if (!existsSync(docsDir)) return []

  const tree: DocNode[] = [{ label: 'README', path: 'README' }]
  const dirs = new Map<string, DocNode>()

  const entries = readdirSync(docsDir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const node: DocNode = {
        label: labelFromFile(entry.name),
        path: '',
        children: [],
      }
      dirs.set(entry.name, node)
      tree.push(node)
      const subEntries = readdirSync(join(docsDir, entry.name), {
        withFileTypes: true,
      }).sort((a, b) => a.name.localeCompare(b.name))
      for (const sub of subEntries) {
        if (sub.isFile() && sub.name.endsWith('.md')) {
          node.children!.push({
            label: labelFromFile(sub.name),
            path: `${entry.name}/${sub.name.replace(/\.md$/i, '')}`,
          })
        }
      }
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      tree.push({
        label: labelFromFile(entry.name),
        path: entry.name.replace(/\.md$/i, ''),
      })
    }
  }

  return tree
}

function handleDocRoutes(
  req: Connect.IncomingMessage,
  res: Connect.ServerResponse,
): boolean {
  const url = req.url || ''
  const method = req.method || 'GET'

  if (method === 'GET' && /^\/api\/docs\/tree\/?$/.test(url)) {
    stubJson(res, buildDocTree())
    return true
  }

  const renderMatch = url.match(/^\/api\/docs\/render\/(.+)$/)
  if (method === 'GET' && renderMatch) {
    const docPath = decodeURIComponent(renderMatch[1])
    if (docPath.includes('..')) {
      res.writeHead(404)
      res.end('Not found')
      return true
    }
    let filePath: string
    if (docPath === 'README') {
      filePath = join(REPO_ROOT, 'README.md')
    } else {
      filePath = join(REPO_ROOT, 'docs', `${docPath}.md`)
    }
    if (!existsSync(filePath)) {
      res.writeHead(404)
      res.end('Not found')
      return true
    }
    const content = readFileSync(filePath, 'utf-8')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<div class="prose prose-sm max-w-none">${content}</div>`)
    return true
  }

  const assetMatch = url.match(/^\/api\/docs\/assets\/(.+)$/)
  if (method === 'GET' && assetMatch) {
    const assetName = decodeURIComponent(assetMatch[1])
    if (assetName.includes('..')) {
      res.writeHead(404)
      res.end('Not found')
      return true
    }
    const filePath = join(REPO_ROOT, 'docs', 'assets', assetName)
    if (!existsSync(filePath)) {
      res.writeHead(404)
      res.end('Not found')
      return true
    }
    const ext = assetName.split('.').pop()?.toLowerCase() || ''
    const mimeMap: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      svg: 'image/svg+xml',
      webp: 'image/webp',
    }
    const data = readFileSync(filePath)
    res.writeHead(200, {
      'Content-Type': mimeMap[ext] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=86400',
    })
    res.end(data)
    return true
  }

  return false
}

export function mockApi(): Plugin {
  return {
    name: 'ar-mock-api',
    configureServer(server) {
      server.middlewares.use(
        (async (
          req: Connect.IncomingMessage,
          res: Connect.ServerResponse,
          next: () => void,
        ) => {
          if (await handleAgentRoutes(req, res)) return
          if (await handleDemoRoutes(req, res)) return
          if (await handleSlackBotRoutes(req, res)) return
          if (await handleAccessRoutes(req, res)) return
          if (handleArtifactRoutes(req, res)) return
          if (handleDocRoutes(req, res)) return

          const raw = req.url || ''
          const method = req.method || 'GET'
          const { path: routePath, params: routeParams } = parseUrl(raw)

          if (
            method === 'GET' &&
            /^\/api\/registry\/status\/?$/.test(routePath)
          ) {
            const full = loadFixture('registry-status') as
              | Record<
                string,
                unknown
              >
              | null
            if (full) {
              const scope = routeParams.get('scope')
              if (scope === 'public') {
                const { private: _priv, promotable: _prom, ...rest } =
                  full as Record<string, unknown>
                stubJson(res, { ...rest, promotable: [] })
              } else {
                stubJson(res, full)
              }
              return
            }
          }

          if (
            method === 'POST' &&
            /^\/skills\/import\/?$/.test(routePath)
          ) {
            const raw = await readBody(req)
            const body = JSON.parse(raw || '{}')
            const slug = 'imported-skill'
            stubJson(res, {
              id: crypto.randomUUID(),
              name: slug,
              slug,
              version: '0.0.1',
              visibility: 'private',
              ownerId: 'dev@ar.local',
              config: { description: 'Imported', source: body.url },
              content: '# Imported Skill\n\nMock imported content.',
              gcsPath: null,
              template: false,
              createdAt: new Date().toISOString(),
            }, 201)
            return
          }

          const entityMatch = routePath.match(
            /^\/(tools|skills|rules)\/([^/]+)\/?$/,
          )
          if (entityMatch) {
            const [, , entityId] = entityMatch
            if (method === 'GET') {
              stubJson(res, {
                id: entityId,
                name: entityId,
                slug: entityId,
                version: '0.0.1',
                activeVersion: '0.0.1',
                visibility: 'private',
                ownerId: 'dev@ar.local',
                config: null,
                content: `# ${entityId}\n\nSample content.`,
                gcsPath: null,
                template: false,
                createdAt: new Date().toISOString(),
              })
              return
            }
            if (method === 'PUT') {
              const raw = await readBody(req)
              const body = JSON.parse(raw || '{}')
              stubJson(res, {
                id: entityId,
                name: body.name || entityId,
                slug: entityId,
                version: '0.0.1',
                visibility: body.visibility || 'private',
                ownerId: 'dev@ar.local',
                config: body.config || null,
                content: body.content || '',
                gcsPath: null,
                template: false,
                createdAt: new Date().toISOString(),
              })
              return
            }
            if (method === 'DELETE') {
              stubJson(res, { message: 'Deleted' })
              return
            }
          }

          const versionsMatch = routePath.match(
            /^\/(tools|skills|rules)\/([^/]+)\/versions\/?$/,
          )
          if (versionsMatch) {
            const [, , slug] = versionsMatch
            if (method === 'GET') {
              stubJson(res, [
                {
                  id: `${slug}-v1`,
                  slug,
                  version: '0.0.1',
                  activeVersion: '0.0.1',
                  visibility: 'private',
                },
              ])
              return
            }
            if (method === 'POST') {
              const raw = await readBody(req)
              const body = JSON.parse(raw || '{}')
              stubJson(res, {
                id: crypto.randomUUID(),
                slug,
                version: body.version || '0.0.2',
                visibility: 'private',
              }, 201)
              return
            }
          }

          if (
            method === 'GET' &&
            /^\/api\/user\/tenants\/?$/.test(routePath)
          ) {
            stubJson(res, ['development', 'staging', 'local'])
            return
          }

          if (
            method === 'POST' &&
            /^\/api\/user\/tenant\/?$/.test(routePath)
          ) {
            const raw = await readBody(req)
            const data = JSON.parse(raw || '{}')
            stubJson(res, { ok: true, tenantId: data.tenantId })
            return
          }

          if (
            method === 'POST' &&
            /^\/api\/user\/preferences\/?$/.test(routePath)
          ) {
            stubJson(res, { ok: true })
            return
          }

          if (
            method === 'GET' &&
            /^\/storage\/list\/?$/.test(routePath)
          ) {
            stubJson(res, [
              'local/agents/hello-world/output/report-2026-03.json',
              'local/agents/hello-world/output/report-2026-04.json',
              'local/agents/hello-world/output/daily/summary.csv',
              'local/agents/code-reviewer/output/reviews/pr-142.json',
              'local/agents/code-reviewer/output/reviews/pr-143.json',
              'local/agents/data-pipeline/output/pipeline/batch-001.json',
              'local/demos/sample-dashboard/index.html',
              'local/demos/sample-dashboard/main.js',
              'local/demos/sample-dashboard/styles.css',
              'local/demos/landing-page/index.html',
            ])
            return
          }

          if (
            method === 'GET' &&
            /^\/telemetry\/?$/.test(routePath)
          ) {
            const now = Date.now()
            const ev = (
              id: string,
              ts: number,
              action: string,
              client: string,
              level: string,
              traceId: string | null,
              spanId: string | null,
              parentSpanId: string | null,
              actor: string,
              payload: string | null,
              tags: Record<string, string> | null,
            ) => ({
              id,
              traceId,
              spanId,
              parentSpanId,
              timestamp: ts,
              client,
              clientVersion: client === 'ar-cli' ? '0.3.0' : '0.0.1',
              actor,
              session: null,
              action,
              level,
              context: null,
              payload,
              environment: null,
              tags,
              createdAt: new Date(ts).toISOString(),
            })
            stubJson(res, [
              ev(
                't01',
                now - 600000,
                'agent.deploy',
                'ar-cli',
                'info',
                'tr-deploy-1',
                'sp-d1',
                null,
                'dev@local',
                '{"agent":"hello-world","version":"1.0.0","region":"northamerica-northeast1"}',
                { agent: 'hello-world', op: 'deploy' },
              ),
              ev(
                't02',
                now - 598000,
                'gcs.upload',
                'ar-cli',
                'info',
                'tr-deploy-1',
                'sp-d2',
                'sp-d1',
                'dev@local',
                '{"path":"local/agents/hello-world/1.0.0/source.tar.gz","bytes":42510}',
                null,
              ),
              ev(
                't03',
                now - 595000,
                'function.create',
                'ar-cli',
                'info',
                'tr-deploy-1',
                'sp-d3',
                'sp-d1',
                'dev@local',
                '{"function":"hello-world","runtime":"nodejs22","memory":"256Mi"}',
                null,
              ),
              ev(
                't04',
                now - 1800000,
                'agent.invoke',
                'webhook',
                'info',
                'tr-invoke-1',
                'sp-i1',
                null,
                'system',
                '{"agent":"hello-world","trigger":"webhook","durationMs":340}',
                { agent: 'hello-world' },
              ),
              ev(
                't05',
                now - 1799600,
                'llm.call',
                'agent-runtime',
                'info',
                'tr-invoke-1',
                'sp-i2',
                'sp-i1',
                'system',
                '{"subsystem":"claude","tokens":{"input":820,"output":245},"durationMs":290}',
                null,
              ),
              ev(
                't06',
                now - 3600000,
                'agent.create',
                'web',
                'info',
                null,
                null,
                null,
                'dev@local',
                '{"name":"code-reviewer","subsystem":"cursor"}',
                { agent: 'code-reviewer' },
              ),
              ev(
                't07',
                now - 7200000,
                'agent.invoke',
                'cron',
                'error',
                'tr-cron-1',
                'sp-c1',
                null,
                'system',
                '{"error":"Function not deployed","agent":"data-pipeline","schedule":"0 */6 * * *"}',
                { agent: 'data-pipeline', op: 'invoke' },
              ),
              ev(
                't08',
                now - 14400000,
                'bot.command.run',
                'slack-bot',
                'info',
                'tr-slack-1',
                'sp-s1',
                null,
                'jane@example.com',
                '{"command":"run","agent":"hello-world","channel":"#dev"}',
                null,
              ),
              ev(
                't09',
                now - 14399500,
                'agent.invoke',
                'slack-bot',
                'info',
                'tr-slack-1',
                'sp-s2',
                'sp-s1',
                'jane@example.com',
                '{"agent":"hello-world","durationMs":520}',
                null,
              ),
              ev(
                't10',
                now - 14399000,
                'llm.call',
                'agent-runtime',
                'warn',
                'tr-slack-1',
                'sp-s3',
                'sp-s2',
                'jane@example.com',
                '{"subsystem":"claude","tokens":{"input":1200,"output":0},"warning":"rate_limited","retryAfterMs":2000}',
                null,
              ),
              ev(
                't11',
                now - 86400000,
                'demo.deploy',
                'web',
                'info',
                null,
                null,
                null,
                'dev@local',
                '{"demo":"sample-dashboard","visibility":"public"}',
                { demo: 'sample-dashboard' },
              ),
              ev(
                't12',
                now - 172800000,
                'tenant.switch',
                'web',
                'debug',
                null,
                null,
                null,
                'dev@local',
                '{"from":"development","to":"staging"}',
                null,
              ),
            ])
            return
          }

          if (
            method === 'GET' &&
            /^\/api\/settings\/users\/?$/.test(routePath)
          ) {
            stubJson(res, loadFixture('settings-users') ?? [])
            return
          }

          if (
            method === 'GET' &&
            /^\/api\/settings\/tenants\/?$/.test(routePath)
          ) {
            stubJson(res, loadFixture('settings-tenants') ?? [])
            return
          }

          if (
            method === 'GET' &&
            /^\/api\/settings\/storage\/?$/.test(routePath)
          ) {
            stubJson(
              res,
              loadFixture('settings-storage') ?? {
                totalFiles: 0,
                totalBytes: 0,
                items: [],
              },
            )
            return
          }

          if (
            method === 'GET' &&
            /^\/api\/settings\/activity\/?$/.test(routePath)
          ) {
            stubJson(
              res,
              loadFixture('settings-activity') ?? {
                telemetry: {},
                audit: {},
                recentAudit: [],
                recentTelemetry: [],
              },
            )
            return
          }

          if (
            method === 'GET' &&
            /^\/secrets\/?$/.test(routePath)
          ) {
            stubJson(res, loadFixture('settings-secrets') ?? [])
            return
          }

          for (const route of routes) {
            if (
              route.method === method && route.pattern.test(routePath)
            ) {
              const data = loadFixture(route.fixture)
              if (data !== null) {
                stubJson(res, data)
                return
              }
            }
          }

          next()
        }) as Connect.NextHandleFunction,
      )
    },
  }
}

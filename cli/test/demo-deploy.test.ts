import { assertEquals, assertStringIncludes } from '@std/assert'
import { join, toFileUrl } from '@std/path'

const ROOT = join(Deno.cwd(), '..')

const deployModule = await import(
  toFileUrl(join(ROOT, 'control-plane/src/api/demos/deploy.ts')).href
) as typeof import('../../control-plane/src/api/demos/deploy.ts')

Deno.test('deploy.ts includes userId in serviceName', async () => {
  const deploy = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/api/demos/deploy.ts'),
  )

  assertStringIncludes(deploy, 'function serviceName(')
  assertStringIncludes(deploy, 'userId')
  assertStringIncludes(deploy, '.slice(0, 49)')
})

Deno.test('deploy.ts generates correct image tags', async () => {
  const deploy = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/api/demos/deploy.ts'),
  )

  assertStringIncludes(deploy, 'function demoImage(')
  assertStringIncludes(deploy, 'ar-demos')
  assertStringIncludes(deploy, ':latest')
})

Deno.test('deploy.ts uses Cloud Build instead of FUSE', async () => {
  const deploy = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/api/demos/deploy.ts'),
  )

  assertStringIncludes(deploy, 'buildDemo')
  assertStringIncludes(deploy, 'cloudBuildSubmit')
  assertStringIncludes(deploy, 'waitForBuild')

  assertEquals(
    deploy.includes('fuseBucket'),
    false,
    'deploy.ts must not reference fuseBucket',
  )
  assertEquals(
    deploy.includes('NODE_PATH'),
    false,
    'deploy.ts must not set NODE_PATH',
  )
  assertEquals(
    deploy.includes("image: 'node:22-slim'"),
    false,
    'deploy.ts must not use stock node image',
  )
  assertEquals(
    deploy.includes("image: 'denoland/deno"),
    false,
    'deploy.ts must not use stock deno image',
  )
})

Deno.test('deploy.ts ensures ar-demos repo exists', async () => {
  const deploy = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/api/demos/deploy.ts'),
  )

  assertStringIncludes(deploy, 'ensureDemoRepo')
  assertStringIncludes(deploy, 'ar-demos')
  assertStringIncludes(deploy, 'demoRepoCreated')
})

Deno.test('deploy.ts exports deleteImage', async () => {
  const deploy = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/api/demos/deploy.ts'),
  )

  assertStringIncludes(deploy, 'export async function deleteImage(')
  assertStringIncludes(deploy, 'artifactregistry.googleapis.com')
})

Deno.test('deploy.ts waits for Cloud Run LRO', async () => {
  const deploy = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/api/demos/deploy.ts'),
  )

  assertStringIncludes(deploy, 'opName')
  assertStringIncludes(deploy, 'op.done')
})

Deno.test('destroyContainer accepts userId parameter', async () => {
  const deploy = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/api/demos/deploy.ts'),
  )

  const sig = deploy.match(
    /export async function destroyContainer\([^)]+\)/,
  )
  assertEquals(sig !== null, true, 'destroyContainer must be exported')
  assertStringIncludes(sig![0], 'userId')
})

Deno.test('routes.ts scopes destroyContainer to the resolved demo owner', async () => {
  const routes = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/api/demos/routes.ts'),
  )

  // Shared editors act under the owner's storage/service scope, so the
  // resolved ownerId — not the caller's email — is passed as the userId.
  assertEquals(
    routes.includes('destroyContainer(cfg, tenantId, ownerId,'),
    true,
    'routes.ts must pass the resolved owner as userId to destroyContainer',
  )
})

Deno.test('routes.ts imports deleteImage', async () => {
  const routes = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/api/demos/routes.ts'),
  )

  assertStringIncludes(routes, 'deleteImage')
})

Deno.test('private demos are not bound to allUsers', () => {
  const next = deployModule.nextDemoBindings('private', [
    { role: 'roles/run.invoker', members: ['allUsers'] },
    { role: 'roles/run.viewer', members: ['user:owner@example.com'] },
  ])

  assertEquals(
    next.some((b) =>
      b.role === 'roles/run.invoker' && b.members.includes('allUsers')
    ),
    false,
    'private demos must strip allUsers from roles/run.invoker',
  )
  assertEquals(
    next.find((b) => b.role === 'roles/run.viewer')?.members,
    ['user:owner@example.com'],
    'unrelated role bindings must be preserved',
  )
})

Deno.test('private demos preserve other invokers', () => {
  const next = deployModule.nextDemoBindings('private', [
    {
      role: 'roles/run.invoker',
      members: [
        'allUsers',
        'serviceAccount:bot@example.iam.gserviceaccount.com',
      ],
    },
  ])

  const invoker = next.find((b) => b.role === 'roles/run.invoker')
  assertEquals(
    invoker?.members,
    ['serviceAccount:bot@example.iam.gserviceaccount.com'],
    'private mode must keep non-public invokers (e.g. control plane SA)',
  )
})

Deno.test('public demos add allUsers to invoker', () => {
  const next = deployModule.nextDemoBindings('public', [
    {
      role: 'roles/run.invoker',
      members: ['serviceAccount:bot@example.iam.gserviceaccount.com'],
    },
  ])

  const invoker = next.find((b) => b.role === 'roles/run.invoker')
  assertEquals(
    invoker?.members.includes('allUsers'),
    true,
    'public mode must include allUsers',
  )
  assertEquals(
    invoker?.members.includes(
      'serviceAccount:bot@example.iam.gserviceaccount.com',
    ),
    true,
    'public mode must keep existing invoker members',
  )
})

Deno.test('public demos seed a binding when none exists', () => {
  const next = deployModule.nextDemoBindings('public', [])
  assertEquals(next, [{ role: 'roles/run.invoker', members: ['allUsers'] }])
})

Deno.test('conditional invoker bindings are preserved untouched', () => {
  const conditional = {
    role: 'roles/run.invoker',
    members: ['user:contractor@example.com'],
    condition: {
      expression: 'request.time < timestamp("2099-01-01T00:00:00Z")',
      title: 'time-bound',
    },
  }

  const priv = deployModule.nextDemoBindings('private', [
    conditional,
    { role: 'roles/run.invoker', members: ['allUsers'] },
  ])
  assertEquals(
    priv.find((b) => b.condition?.title === 'time-bound'),
    conditional,
    'private mode must leave conditional bindings (object identity) intact',
  )
  assertEquals(
    priv.some((b) =>
      b.role === 'roles/run.invoker' && !b.condition &&
      b.members.includes('allUsers')
    ),
    false,
    'private mode must still strip allUsers from the unconditional binding',
  )

  const pub = deployModule.nextDemoBindings('public', [conditional])
  assertEquals(
    pub.find((b) => b.condition?.title === 'time-bound'),
    conditional,
    'public mode must not graft allUsers onto a conditional invoker binding',
  )
  assertEquals(
    pub.some((b) =>
      b.role === 'roles/run.invoker' && !b.condition &&
      b.members.includes('allUsers')
    ),
    true,
    'public mode must seed an unconditional invoker binding when only ' +
      'conditional ones exist',
  )
})

Deno.test('non-invoker binding fields are preserved', () => {
  const viewer = {
    role: 'roles/run.viewer',
    members: ['user:owner@example.com'],
    condition: {
      expression: 'resource.name.startsWith("projects/p/")',
      title: 'scoped',
    },
  }
  const next = deployModule.nextDemoBindings('private', [
    viewer,
    { role: 'roles/run.invoker', members: ['allUsers'] },
  ])
  assertEquals(
    next.find((b) => b.role === 'roles/run.viewer'),
    viewer,
    'unrelated bindings must pass through untouched (with their condition)',
  )
})

const PROXY_SA = 'serviceAccount:cp@nesto.iam.gserviceaccount.com'

Deno.test('private demos grant the control-plane SA invoker, not allUsers', () => {
  const next = deployModule.nextDemoBindings(
    'private',
    [{ role: 'roles/run.invoker', members: ['allUsers'] }],
    PROXY_SA,
  )
  const invoker = next.find((b) => b.role === 'roles/run.invoker')
  assertEquals(
    invoker?.members.includes('allUsers'),
    false,
    'private demos must not be bound to allUsers',
  )
  assertEquals(
    invoker?.members.includes(PROXY_SA),
    true,
    'private demos must let the control-plane SA invoke (for the proxy)',
  )
})

Deno.test('private demos seed an invoker binding for the proxy SA', () => {
  const next = deployModule.nextDemoBindings('private', [], PROXY_SA)
  assertEquals(next, [{ role: 'roles/run.invoker', members: [PROXY_SA] }])
})

Deno.test('public demos keep allUsers and the proxy SA', () => {
  const next = deployModule.nextDemoBindings('public', [], PROXY_SA)
  const invoker = next.find((b) => b.role === 'roles/run.invoker')
  assertEquals(invoker?.members.includes('allUsers'), true)
  assertEquals(invoker?.members.includes(PROXY_SA), true)
})

Deno.test('proxy SA is not duplicated when already present', () => {
  const next = deployModule.nextDemoBindings(
    'private',
    [{ role: 'roles/run.invoker', members: [PROXY_SA] }],
    PROXY_SA,
  )
  const invoker = next.find((b) => b.role === 'roles/run.invoker')
  assertEquals(
    invoker?.members.filter((m) => m === PROXY_SA).length,
    1,
    'proxy SA must appear exactly once',
  )
})

Deno.test('demoAccessUrl routes private demos through the control plane', () => {
  const priv = deployModule.demoAccessUrl(
    { name: 'my-demo', url: 'https://demo-x.run.app', visibility: 'private' },
    'https://cp.example.com/',
  )
  assertEquals(priv, 'https://cp.example.com/web/d/my-demo')

  const pub = deployModule.demoAccessUrl(
    { name: 'my-demo', url: 'https://demo-x.run.app', visibility: 'public' },
    'https://cp.example.com',
  )
  assertEquals(
    pub,
    'https://demo-x.run.app',
    'public demos link directly to the Cloud Run URL',
  )

  const noBase = deployModule.demoAccessUrl(
    { name: 'my-demo', url: 'https://demo-x.run.app', visibility: 'private' },
    '',
  )
  assertEquals(
    noBase,
    'https://demo-x.run.app',
    'falls back to the raw URL when no control-plane base is configured',
  )
})

Deno.test('setServiceAccess honors visibility (no orphaned void)', async () => {
  const deploy = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/api/demos/deploy.ts'),
  )

  assertEquals(
    deploy.includes('void visibility'),
    false,
    'deploy.ts must not discard the visibility argument',
  )
  assertStringIncludes(deploy, 'nextDemoBindings(visibility')
})

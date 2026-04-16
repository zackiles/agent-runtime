import { assertEquals, assertStringIncludes } from '@std/assert'
import { join } from '@std/path'

const ROOT = join(Deno.cwd(), '..')

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

Deno.test('routes.ts passes userId to destroyContainer', async () => {
  const routes = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/api/demos/routes.ts'),
  )

  assertEquals(
    routes.includes('destroyContainer(cfg, tenantId, email, name)'),
    true,
    'routes.ts must pass email as userId to destroyContainer',
  )
})

Deno.test('routes.ts imports deleteImage', async () => {
  const routes = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/api/demos/routes.ts'),
  )

  assertStringIncludes(routes, 'deleteImage')
})

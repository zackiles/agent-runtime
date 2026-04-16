import { assertEquals, assertStringIncludes } from '@std/assert'
import { join } from '@std/path'

const ROOT = join(Deno.cwd(), '..')

Deno.test('build.ts exports detection and generation scripts', async () => {
  const build = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/api/demos/build.ts'),
  )

  assertStringIncludes(build, 'function detectScript()')
  assertStringIncludes(build, 'function generateDockerfileScript()')
  assertStringIncludes(build, 'NODE_DOCKERFILE')
  assertStringIncludes(build, 'STATIC_DOCKERFILE')
  assertStringIncludes(build, 'DENO_DOCKERFILE')
  assertStringIncludes(build, 'VANILLA_NODE_DOCKERFILE')
})

Deno.test('detectScript checks ar-build.json first', async () => {
  const build = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/api/demos/build.ts'),
  )

  const detectFn = build.slice(
    build.indexOf('function detectScript()'),
    build.indexOf('function generateDockerfileScript()'),
  )
  const arBuildIdx = detectFn.indexOf('ar-build.json')
  const dockerfileIdx = detectFn.indexOf('Dockerfile')
  const packageIdx = detectFn.indexOf('package.json')

  assertEquals(
    arBuildIdx < dockerfileIdx,
    true,
    'ar-build.json must be checked before Dockerfile',
  )
  assertEquals(
    dockerfileIdx < packageIdx,
    true,
    'Dockerfile must be checked before package.json',
  )
})

Deno.test('generateDockerfileScript handles all stack types', async () => {
  const build = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/api/demos/build.ts'),
  )

  for (const type of ['node', 'static', 'deno', 'custom']) {
    assertStringIncludes(
      build,
      type,
      `generateDockerfileScript must handle type=${type}`,
    )
  }
})

Deno.test('NODE_DOCKERFILE uses multi-stage build', async () => {
  const build = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/api/demos/build.ts'),
  )

  assertStringIncludes(build, 'FROM node:22-slim AS build')
  assertStringIncludes(build, 'npm ci --production=false')
  assertStringIncludes(build, 'npm prune --production')
  assertStringIncludes(build, 'ENV PORT=8000')
})

Deno.test('STATIC_DOCKERFILE uses nginx', async () => {
  const build = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/api/demos/build.ts'),
  )

  assertStringIncludes(build, 'nginx:alpine')
  assertStringIncludes(build, 'try_files')
  assertStringIncludes(build, 'listen 8000')
})

Deno.test('generateDockerfileScript skips when Dockerfile exists', async () => {
  const build = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/api/demos/build.ts'),
  )

  assertStringIncludes(build, 'if [ -f Dockerfile ]; then')
  assertStringIncludes(build, 'Using existing Dockerfile')
})

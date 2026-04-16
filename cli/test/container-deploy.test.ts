import { assertEquals, assertExists } from '@std/assert'
import { exists } from '@std/fs'
import { join } from '@std/path'
import { compress } from '../src/utils/archive.ts'

Deno.test('compress excludes tools, _runtime.cjs, node_modules', async () => {
  const tmp = await Deno.makeTempDir()
  try {
    await Deno.writeTextFile(
      join(tmp, 'index.js'),
      'exports.handler = () => {}',
    )
    await Deno.writeTextFile(join(tmp, 'agent.json'), '{}')
    await Deno.writeTextFile(join(tmp, '_runtime.cjs'), 'big file')
    await Deno.mkdir(join(tmp, 'tools', 'cursor'), { recursive: true })
    await Deno.writeTextFile(join(tmp, 'tools', 'cursor', 'tool'), 'binary')
    await Deno.mkdir(join(tmp, 'node_modules', 'foo'), { recursive: true })
    await Deno.writeTextFile(join(tmp, 'node_modules', 'foo', 'index.js'), 'x')

    const archive = await compress(tmp, {
      exclude: ['tools', '_runtime.cjs', 'node_modules'],
    })

    const extractDir = await Deno.makeTempDir()
    const { extract } = await import('../src/utils/archive.ts')
    await extract(archive, extractDir)

    assertEquals(await exists(join(extractDir, 'index.js')), true)
    assertEquals(await exists(join(extractDir, 'agent.json')), true)
    assertEquals(await exists(join(extractDir, '_runtime.cjs')), false)
    assertEquals(await exists(join(extractDir, 'tools')), false)
    assertEquals(await exists(join(extractDir, 'node_modules')), false)

    await Deno.remove(extractDir, { recursive: true })
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test('compress without exclude includes everything', async () => {
  const tmp = await Deno.makeTempDir()
  try {
    await Deno.writeTextFile(join(tmp, 'index.js'), 'handler')
    await Deno.writeTextFile(join(tmp, '_runtime.cjs'), 'runtime')

    const archive = await compress(tmp)

    const extractDir = await Deno.makeTempDir()
    const { extract } = await import('../src/utils/archive.ts')
    await extract(archive, extractDir)

    assertEquals(await exists(join(extractDir, 'index.js')), true)
    assertEquals(await exists(join(extractDir, '_runtime.cjs')), true)

    await Deno.remove(extractDir, { recursive: true })
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test('settings includes agentDeployMode', async () => {
  const { load, reset } = await import('../src/settings.ts')
  reset()
  const settings = await load()
  assertEquals(
    settings.agentDeployMode === undefined ||
      settings.agentDeployMode === 'container' ||
      settings.agentDeployMode === 'source',
    true,
  )
})

Deno.test('RuntimeConfig includes agents field', async () => {
  const { load } = await import('@ar/client/runtime')
  const rc = load()
  assertExists(rc.agents)
  assertEquals(rc.agents.deployMode, 'container')
})

Deno.test('agent-host.js is valid CJS (no ESM imports)', async () => {
  const hostPath = join(Deno.cwd(), '..', 'sdk-agent-nodejs', 'agent-host.js')
  const content = await Deno.readTextFile(hostPath)
  assertEquals(
    content.includes('import '),
    false,
    'agent-host.js must not use ESM import',
  )
  assertEquals(
    content.includes('require('),
    true,
    'agent-host.js must use require()',
  )
})

Deno.test('Dockerfile.agent-base has curl install', async () => {
  const dockerfilePath = join(Deno.cwd(), '..', 'Dockerfile.agent-base')
  const content = await Deno.readTextFile(dockerfilePath)
  assertEquals(content.includes('apt-get'), true, 'must install curl via apt')
  assertEquals(content.includes('curl'), true, 'must install curl')
})

Deno.test('Dockerfile.agent-base slug extraction is correct', async () => {
  const dockerfilePath = join(Deno.cwd(), '..', 'Dockerfile.agent-base')
  const content = await Deno.readTextFile(dockerfilePath)
  assertEquals(
    content.includes('basename $slug_dir'),
    true,
    'slug must be extracted from slug_dir',
  )
  assertEquals(
    content.includes('sort -V'),
    true,
    'versions must be sorted with semver-aware sort',
  )
  assertEquals(
    content.includes('^[0-9]+\\.[0-9]+\\.[0-9]+$'),
    true,
    'versions must filter to stable semver only (no prereleases)',
  )
})

Deno.test('ContainerDeployOptions includes fuseBucket and secrets', async () => {
  const typesPath = join(
    Deno.cwd(),
    '..',
    'sdk-client-deno',
    'src',
    'platform',
    'types.ts',
  )
  const content = await Deno.readTextFile(typesPath)
  assertEquals(content.includes('fuseBucket'), true)
  assertEquals(content.includes('containerDeploy'), true)
  assertEquals(content.includes('containerDelete'), true)
})

Deno.test('gcp.ts containerDeploy handles fuseBucket', async () => {
  const gcpPath = join(
    Deno.cwd(),
    '..',
    'sdk-client-deno',
    'src',
    'platform',
    'gcp.ts',
  )
  const content = await Deno.readTextFile(gcpPath)
  assertEquals(
    content.includes('add-volume') && content.includes('fuseBucket'),
    true,
    'gcp.ts must pass FUSE volume flags when fuseBucket is set',
  )
})

Deno.test('gcp-rest.ts volumeMounts has no readOnly field', async () => {
  const restPath = join(
    Deno.cwd(),
    '..',
    'sdk-client-deno',
    'src',
    'platform',
    'gcp-rest.ts',
  )
  const content = await Deno.readTextFile(restPath)
  const mountSection = content.slice(
    content.indexOf('volumeMounts.push'),
    content.indexOf('volumeMounts.push') + 200,
  )
  assertEquals(
    mountSection.includes('readOnly'),
    false,
    'volumeMounts must not include readOnly (Cloud Run v2 API rejects it)',
  )
})

Deno.test('agents.ts deploy sets AR_TOOLS_DIR and secrets', async () => {
  const agentsPath = join(
    Deno.cwd(),
    '..',
    'control-plane',
    'src',
    'api',
    'agents.ts',
  )
  const content = await Deno.readTextFile(agentsPath)
  assertEquals(
    content.includes("AR_TOOLS_DIR: '/app/tools'"),
    true,
    'deploy must set AR_TOOLS_DIR for container mode',
  )
  assertEquals(
    content.includes('secrets,') || content.includes('secrets:'),
    true,
    'deploy must pass secrets to containerDeploy',
  )
})

Deno.test('default-settings.jsonc has container mode IAM roles', async () => {
  const settingsPath = join(Deno.cwd(), '..', 'default-settings.jsonc')
  const content = await Deno.readTextFile(settingsPath)
  assertEquals(content.includes('artifactregistry.repoAdmin'), true)
  assertEquals(content.includes('cloudbuild.builds.editor'), true)
  assertEquals(content.includes('secretmanager.secretAccessor'), true)
  assertEquals(content.includes('artifactregistry.reader'), true)
  assertEquals(content.includes('"deployMode": "container"'), true)
})

Deno.test('default agents conform to spec', async () => {
  const registryPath = join(Deno.cwd(), '..', 'default-registry', 'agents')

  for await (const entry of Deno.readDir(registryPath)) {
    if (!entry.isDirectory || entry.name.startsWith('.')) continue
    const slug = entry.name
    const agentDir = join(registryPath, slug)

    const versions: string[] = []
    for await (const v of Deno.readDir(agentDir)) {
      if (v.isDirectory && /^\d+\.\d+\.\d+$/.test(v.name)) {
        versions.push(v.name)
      }
    }
    assertExists(
      versions.length > 0 ? versions[0] : undefined,
      `${slug} must have at least one semver version directory`,
    )

    for (const version of versions) {
      const versionDir = join(agentDir, version)
      const manifestPath = join(versionDir, 'agent.json')

      assertEquals(
        await exists(manifestPath),
        true,
        `${slug}/${version}/agent.json must exist`,
      )

      const manifest = JSON.parse(
        await Deno.readTextFile(manifestPath),
      ) as {
        name?: string
        slug?: string
        version?: string
        entryPoint?: string
        secrets?: string[]
        sourceType?: string
        triggers?: unknown[]
      }

      assertExists(manifest.name, `${slug}/${version} must have name`)
      assertEquals(
        manifest.slug,
        slug,
        `${slug}/${version} slug must match folder name`,
      )
      assertEquals(
        manifest.version,
        version,
        `${slug}/${version} version must match folder name`,
      )
      assertExists(
        manifest.entryPoint,
        `${slug}/${version} must have entryPoint`,
      )
      assertEquals(
        Array.isArray(manifest.secrets),
        true,
        `${slug}/${version} secrets must be an array`,
      )
      assertEquals(
        Array.isArray(manifest.triggers),
        true,
        `${slug}/${version} triggers must be an array`,
      )

      const isPrompt = manifest.sourceType === 'prompt'
      if (isPrompt) {
        assertEquals(
          await exists(join(versionDir, 'prompt.md')) ||
            await exists(join(versionDir, 'prompt.compiled.md')),
          true,
          `${slug}/${version} prompt agent must have a prompt file`,
        )
      } else {
        assertEquals(
          await exists(join(versionDir, 'index.js')),
          true,
          `${slug}/${version} function agent must have index.js`,
        )
        const handler = await Deno.readTextFile(
          join(versionDir, 'index.js'),
        )
        assertEquals(
          handler.includes('exports.handler'),
          true,
          `${slug}/${version} index.js must export a handler`,
        )
      }
    }
  }
})

Deno.test('sdk-agent-nodejs bin has /app/tools path', async () => {
  const binPath = join(Deno.cwd(), '..', 'sdk-agent-nodejs', 'bin', 'index.cjs')
  const content = await Deno.readTextFile(binPath)
  assertEquals(
    content.includes('/app/tools'),
    true,
    'compiled SDK must include container tool path',
  )
})

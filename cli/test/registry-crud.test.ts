import { assertEquals } from '@std/assert'
import { join } from '@std/path'

Deno.test('CP registry.ts has GET /:id route', async () => {
  const path = join(
    Deno.cwd(),
    '..',
    'control-plane',
    'src',
    'api',
    'registry.ts',
  )
  const content = await Deno.readTextFile(path)
  assertEquals(
    content.includes("app.get('/:id'"),
    true,
    'registry routes must include GET /:id',
  )
})

Deno.test('CP registry.ts has PUT /:id route', async () => {
  const path = join(
    Deno.cwd(),
    '..',
    'control-plane',
    'src',
    'api',
    'registry.ts',
  )
  const content = await Deno.readTextFile(path)
  assertEquals(
    content.includes("app.put('/:id'"),
    true,
    'registry routes must include PUT /:id',
  )
})

Deno.test('CP registry.ts has version endpoints', async () => {
  const path = join(
    Deno.cwd(),
    '..',
    'control-plane',
    'src',
    'api',
    'registry.ts',
  )
  const content = await Deno.readTextFile(path)
  assertEquals(
    content.includes("app.get('/:id/versions'"),
    true,
    'registry routes must include GET /:id/versions',
  )
  assertEquals(
    content.includes("app.post('/:id/versions'"),
    true,
    'registry routes must include POST /:id/versions',
  )
  assertEquals(
    content.includes("app.delete('/:id/versions/:version'"),
    true,
    'registry routes must include DELETE /:id/versions/:version',
  )
})

Deno.test('CP registry.ts imports updateEntity', async () => {
  const path = join(
    Deno.cwd(),
    '..',
    'control-plane',
    'src',
    'api',
    'registry.ts',
  )
  const content = await Deno.readTextFile(path)
  assertEquals(
    content.includes('updateEntity'),
    true,
    'registry routes must import updateEntity',
  )
  assertEquals(
    content.includes('createVersion'),
    true,
    'registry routes must import createVersion',
  )
})

Deno.test('DB registry.ts exports updateEntity', async () => {
  const path = join(
    Deno.cwd(),
    '..',
    'sdk-client-deno',
    'src',
    'db',
    'registry.ts',
  )
  const content = await Deno.readTextFile(path)
  assertEquals(
    content.includes('export') && content.includes('updateEntity'),
    true,
    'DB registry must export updateEntity',
  )
  assertEquals(
    content.includes('createVersion'),
    true,
    'DB registry must export createVersion',
  )
  assertEquals(
    content.includes('listVersions'),
    true,
    'DB registry must export listVersions',
  )
  assertEquals(
    content.includes('switchVersion'),
    true,
    'DB registry must export switchVersion',
  )
  assertEquals(
    content.includes('removeVersion'),
    true,
    'DB registry must export removeVersion',
  )
})

Deno.test('DB schema has migration 8 for skill/rule versioning', async () => {
  const path = join(
    Deno.cwd(),
    '..',
    'sdk-client-deno',
    'src',
    'db',
    'schema.ts',
  )
  const content = await Deno.readTextFile(path)
  assertEquals(
    content.includes('SCHEMA_VERSION = 9'),
    true,
    'schema version must be 9',
  )
  assertEquals(
    content.includes('skill_new'),
    true,
    'migration must recreate skill table',
  )
  assertEquals(
    content.includes('rule_new'),
    true,
    'migration must recreate rule table',
  )
  assertEquals(
    content.includes('active_version'),
    true,
    'migration must add active_version column',
  )
  assertEquals(
    content.includes('content TEXT'),
    true,
    'migration must add content column',
  )
})

Deno.test('RegistryEntity type has content and activeVersion', async () => {
  const path = join(
    Deno.cwd(),
    '..',
    'sdk-client-deno',
    'src',
    'db',
    'registry.ts',
  )
  const content = await Deno.readTextFile(path)
  assertEquals(
    content.includes('activeVersion:'),
    true,
    'RegistryEntity must include activeVersion',
  )
  assertEquals(
    content.includes('content:'),
    true,
    'RegistryEntity must include content',
  )
})

Deno.test('operations/registry.ts exports full CRUD + versions', async () => {
  const path = join(
    Deno.cwd(),
    '..',
    'sdk-client-deno',
    'src',
    'operations',
    'registry.ts',
  )
  const content = await Deno.readTextFile(path)
  for (
    const name of [
      'getEntity',
      'updateEntity',
      'cloneEntity',
      'listVersions',
      'createVersion',
      'switchVersion',
      'removeVersion',
    ]
  ) {
    assertEquals(
      content.includes(name),
      true,
      `operations must export ${name}`,
    )
  }
})

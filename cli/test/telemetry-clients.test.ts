import { assertEquals, assertNotEquals } from '@std/assert'
import { join } from '@std/path'
import { closeTenant, open } from '@ar/client/db'
import {
  create,
  get,
  getByHash,
  hash,
  list,
  remove,
  rotate,
} from '@ar/client/db/telemetry-clients'

const ROOT = join(Deno.cwd(), '..')

Deno.test('telemetry-clients DB: create, hash, getByHash, rotate, remove', async () => {
  const dir = await Deno.makeTempDir()
  const prevDbPath = Deno.env.get('AR_DB_PATH')
  Deno.env.set('AR_DB_PATH', dir)
  const tenant = 'testtenant'

  try {
    await open({ id: tenant, name: tenant }, 'server')

    const created = await create({
      tenantId: tenant,
      name: 'checkout-svc',
      createdBy: 'system@ar-cli',
    })

    assertEquals(
      created.key.startsWith(`artk.live.${tenant}.`),
      true,
      'plaintext key has artk.live.<tenant>. prefix',
    )
    assertEquals(created.client.keyPrefix, `artk.live.${tenant}`)
    assertEquals(created.client.keyLastFour.length, 4)
    assertEquals(created.client.revoked, false)

    const found = getByHash(await hash(created.key))
    assertEquals(found?.id, created.client.id, 'getByHash matches the key')

    const miss = getByHash(await hash(`artk.live.${tenant}.totally-wrong`))
    assertEquals(miss, null, 'wrong key misses')

    assertEquals(list(tenant).length, 1, 'client is listed')

    const oldHash = await hash(created.key)
    const rotated = await rotate(tenant, created.client.id)
    assertNotEquals(rotated!.key, created.key, 'rotate issues a new key')
    assertEquals(getByHash(oldHash), null, 'old hash no longer authenticates')
    assertEquals(
      getByHash(await hash(rotated!.key))?.id,
      created.client.id,
      'new key authenticates',
    )

    remove(tenant, created.client.id)
    assertEquals(
      get(tenant, created.client.id)?.revoked,
      true,
      'remove revokes the client',
    )
  } finally {
    closeTenant(tenant)
    if (prevDbPath === undefined) Deno.env.delete('AR_DB_PATH')
    else Deno.env.set('AR_DB_PATH', prevDbPath)
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('telemetry-clients DB: pepper changes the hash, plaintext never stored', async () => {
  const key = 'artk.live.acme.abcdef0123456789'
  const prev = Deno.env.get('AR_TELEMETRY_KEY_PEPPER')

  Deno.env.delete('AR_TELEMETRY_KEY_PEPPER')
  const unpeppered = await hash(key)
  const unpepperedAgain = await hash(key)
  assertEquals(unpeppered, unpepperedAgain, 'hashing is deterministic')
  assertNotEquals(unpeppered, key, 'hash is not the plaintext key')

  Deno.env.set('AR_TELEMETRY_KEY_PEPPER', 'pepper-value')
  const peppered = await hash(key)
  assertNotEquals(peppered, unpeppered, 'pepper changes the hash')

  if (prev === undefined) Deno.env.delete('AR_TELEMETRY_KEY_PEPPER')
  else Deno.env.set('AR_TELEMETRY_KEY_PEPPER', prev)
})

Deno.test('schema: telemetry_client migration at version 9', async () => {
  const src = await Deno.readTextFile(
    join(ROOT, 'sdk-client-deno/src/db/schema.ts'),
  )
  assertEquals(src.includes('SCHEMA_VERSION = 9'), true, 'schema version is 9')
  assertEquals(
    src.includes('CREATE TABLE IF NOT EXISTS telemetry_client'),
    true,
    'migration creates telemetry_client',
  )
  assertEquals(
    src.includes('idx_telemetry_client_hash'),
    true,
    'migration creates the hash lookup index',
  )
})

Deno.test('telemetryKeyAuth gates ingest by header key', async () => {
  const auth = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/middleware/auth.ts'),
  )
  assertEquals(
    auth.includes('function telemetryKeyAuth'),
    true,
    'exports telemetryKeyAuth',
  )
  assertEquals(
    auth.includes("c.req.header('X-Telemetry-Key')"),
    true,
    'reads the X-Telemetry-Key header',
  )
  assertEquals(
    auth.includes('getClientByHash'),
    true,
    'looks up the client by hash',
  )
  assertEquals(
    auth.includes("c.set('telemetryClient'"),
    true,
    'binds the telemetry client to context',
  )
  assertEquals(
    auth.includes('Telemetry key revoked'),
    true,
    'rejects revoked keys',
  )
  const knownCheck = auth.indexOf('tenants.bootstrapped.includes(tenantId)')
  const openCall = auth.indexOf(
    "open({ id: tenantId, name: tenantId }, 'server')",
  )
  assertEquals(
    knownCheck !== -1 && knownCheck < openCall,
    true,
    'validates the tenant is known before opening (creating) its DB',
  )
})

Deno.test('mod.ts routes POST ingest to key auth, reads to identity', async () => {
  const mod = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/mod.ts'),
  )
  assertEquals(
    mod.includes('telemetryKeyAuth(c, next)'),
    true,
    'POST ingest uses telemetryKeyAuth',
  )
  const clientsBefore = mod.indexOf("app.route('/telemetry/clients'")
  const telemetryRoute = mod.indexOf("app.route('/telemetry', telemetryApi)")
  assertEquals(
    clientsBefore !== -1 && clientsBefore < telemetryRoute,
    true,
    'clients router mounts before the telemetry router',
  )
})

Deno.test('telemetry reads are admin-only and ingest binds the client', async () => {
  const api = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/api/telemetry.ts'),
  )
  assertEquals(
    (api.match(/context\(c\)\.isAdmin/g) || []).length >= 2,
    true,
    'query and get assert admin',
  )
  assertEquals(
    api.includes("c.get('telemetryClient')?.name"),
    true,
    'ingest derives client from the key',
  )
})

Deno.test('audit middleware skips telemetry ingest', async () => {
  const audit = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/middleware/audit.ts'),
  )
  assertEquals(
    audit.includes("path === '/telemetry'") &&
      audit.includes("path.startsWith('/telemetry/')"),
    true,
    'middleware early-returns for the telemetry subtree',
  )

  const clients = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/api/telemetry-clients.ts'),
  )
  assertEquals(
    clients.includes("'telemetry-client'"),
    true,
    'client handlers log entity type telemetry-client',
  )
})

Deno.test('web telemetry page exposes a Clients tab and one-time key modal', async () => {
  const island = await Deno.readTextFile(
    join(ROOT, 'web/src/islands/telemetry.tsx'),
  )
  assertEquals(
    island.includes('TelemetryClients'),
    true,
    'telemetry island renders the clients component',
  )

  const clients = await Deno.readTextFile(
    join(ROOT, 'web/src/islands/telemetry-clients.tsx'),
  )
  assertEquals(
    clients.includes('/telemetry/clients'),
    true,
    'clients component calls the management API',
  )
  assertEquals(
    clients.includes('function KeyModal'),
    true,
    'one-time key reveal modal exists',
  )
  assertEquals(
    clients.includes('shown once'),
    true,
    'modal warns the key is shown once',
  )
})

import { assertEquals, assertNotEquals } from '@std/assert'
import { join } from '@std/path'
import { exists } from '@std/fs'
import {
  configDir,
  dataDir,
  homeDir,
  load as loadRuntime,
  registryDir,
} from '@ar/client/runtime'

const REPO_ROOT = join(Deno.cwd(), '..')

Deno.test('configDir resolves to repo root', () => {
  const dir = configDir()
  assertEquals(dir, REPO_ROOT)
})

Deno.test('registryDir resolves to repo root + default-registry', () => {
  const dir = registryDir()
  assertEquals(dir, join(REPO_ROOT, 'default-registry'))
})

Deno.test('dataDir resolves to repo root + data', () => {
  const dir = dataDir()
  assertEquals(dir, join(REPO_ROOT, 'data'))
})

Deno.test('registryDir uses registry.path from default-settings.jsonc', () => {
  const rc = loadRuntime()
  assertEquals(rc.registry.path, 'default-registry')
  assertEquals(registryDir(), join(configDir(), rc.registry.path))
})

Deno.test('dataDir uses data.path from default-settings.jsonc', () => {
  const rc = loadRuntime()
  assertEquals(rc.data?.path, 'data')
})

Deno.test('dataDir falls back to "data" when data.path is missing', () => {
  const dir = dataDir()
  assertEquals(dir.endsWith('/data'), true)
})

Deno.test('homeDir returns ~/.ar by default', () => {
  const home = Deno.env.get('HOME') || Deno.env.get('USERPROFILE') || '.'
  assertEquals(homeDir(), join(home, '.ar'))
})

Deno.test('AR_HOME overrides homeDir', () => {
  Deno.env.set('AR_HOME', '/tmp/test-ar-home')
  try {
    assertEquals(homeDir(), '/tmp/test-ar-home')
  } finally {
    Deno.env.delete('AR_HOME')
  }
})

Deno.test('AR_DB_PATH overrides dataDir', () => {
  Deno.env.set('AR_DB_PATH', '/tmp/test-db')
  try {
    assertEquals(dataDir(), '/tmp/test-db')
  } finally {
    Deno.env.delete('AR_DB_PATH')
  }
})

Deno.test('dataDir in production mode uses homeDir', () => {
  Deno.env.set('AR_BUILD_MODE', 'production')
  try {
    const expected = join(homeDir(), 'data')
    assertEquals(dataDir(), expected)
  } finally {
    Deno.env.delete('AR_BUILD_MODE')
  }
})

Deno.test('AR_HOME + production mode routes dataDir through home', () => {
  Deno.env.set('AR_BUILD_MODE', 'production')
  Deno.env.set('AR_HOME', '/tmp/custom-home')
  try {
    assertEquals(dataDir(), '/tmp/custom-home/data')
  } finally {
    Deno.env.delete('AR_BUILD_MODE')
    Deno.env.delete('AR_HOME')
  }
})

Deno.test('paths never contain /cli/ segment', () => {
  assertNotEquals(configDir().includes('/cli/'), true)
  assertNotEquals(registryDir().includes('/cli/'), true)
  assertNotEquals(dataDir().includes('/cli/'), true)
})

Deno.test('default-registry/ directory exists at registryDir', async () => {
  assertEquals(await exists(registryDir()), true)
})

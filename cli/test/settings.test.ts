import { assertEquals } from '@std/assert'
import { join } from '@std/path'
import { exists } from '@std/fs'
import { configDir } from '@ar/client/runtime'
import { isProduction } from '@ar/client/build'
import { load, reset, save } from '../src/settings.ts'

const SETTINGS_PATH = join(configDir(), 'settings.jsonc')
const LOCAL_PATH = join(configDir(), 'settings.local.jsonc')

Deno.test('dev mode does not modify settings.jsonc on save', async () => {
  assertEquals(isProduction(), false)

  const existed = await exists(SETTINGS_PATH)
  const before = existed ? await Deno.readTextFile(SETTINGS_PATH) : null

  reset()
  await save({ project: 'test-save-isolation' })

  if (before !== null) {
    const after = await Deno.readTextFile(SETTINGS_PATH)
    assertEquals(before, after, 'settings.jsonc should not be modified in dev')
  } else {
    assertEquals(
      await exists(SETTINGS_PATH),
      false,
      'settings.jsonc should not be created in dev',
    )
  }

  assertEquals(await exists(LOCAL_PATH), true)

  const local = JSON.parse(await Deno.readTextFile(LOCAL_PATH))
  assertEquals(local.project, 'test-save-isolation')

  await Deno.remove(LOCAL_PATH)
  reset()
})

Deno.test('load merges settings.local.jsonc over defaults', async () => {
  reset()
  await save({ project: 'test-merge-project', region: 'us-east1' })

  reset()
  const settings = await load()
  assertEquals(settings.project, 'test-merge-project')
  assertEquals(settings.region, 'us-east1')

  await Deno.remove(LOCAL_PATH)
  reset()
})

Deno.test('load falls back to defaults when no local settings', async () => {
  if (await exists(LOCAL_PATH)) await Deno.remove(LOCAL_PATH)

  const hasSettings = await exists(SETTINGS_PATH)
  let fileProject: string | undefined
  if (hasSettings) {
    const { parse } = await import('@std/jsonc')
    const raw = parse(await Deno.readTextFile(SETTINGS_PATH)) as Record<
      string,
      unknown
    >
    fileProject = raw.project as string | undefined
  }

  reset()
  const settings = await load()
  assertEquals(settings.project, fileProject ?? undefined)

  reset()
})

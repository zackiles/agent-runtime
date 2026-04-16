import { assertEquals } from '@std/assert'
import { join } from '@std/path'
import { normalizeInput } from '../../control-plane/src/bots/slack/utils.ts'

const ROOT = join(import.meta.dirname!, '..', '..')

Deno.test('normalizeInput strips leading slash', () => {
  assertEquals(normalizeInput('/help'), 'help')
})

Deno.test('normalizeInput preserves plain text', () => {
  assertEquals(normalizeInput('help'), 'help')
})

Deno.test('normalizeInput trims whitespace', () => {
  assertEquals(normalizeInput('   help   '), 'help')
  assertEquals(normalizeInput('   /help   '), 'help')
})

Deno.test('normalizeInput handles slash with inner whitespace', () => {
  assertEquals(normalizeInput('/   help'), 'help')
})

Deno.test('normalizeInput preserves args after command', () => {
  assertEquals(normalizeInput('/deploy staging'), 'deploy staging')
  assertEquals(normalizeInput('deploy staging'), 'deploy staging')
})

Deno.test('normalizeInput strips only one leading slash', () => {
  assertEquals(normalizeInput('//help'), '/help')
})

Deno.test('normalizeInput handles bare slash', () => {
  assertEquals(normalizeInput('/'), '')
  assertEquals(normalizeInput('/   '), '')
})

Deno.test('normalizeInput handles empty string', () => {
  assertEquals(normalizeInput(''), '')
})

Deno.test('dispatch.ts uses normalizeInput in parseCommand', async () => {
  const dispatch = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/bots/slack/dispatch.ts'),
  )
  assertEquals(
    dispatch.includes('normalizeInput'),
    true,
    'parseCommand must use normalizeInput for slash normalization',
  )
  assertEquals(
    dispatch.includes('import { normalizeInput'),
    true,
    'dispatch must import normalizeInput from utils',
  )
})

Deno.test('utils.ts exports normalizeInput', async () => {
  const utils = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/bots/slack/utils.ts'),
  )
  assertEquals(
    utils.includes('normalizeInput'),
    true,
    'utils must define normalizeInput',
  )
  assertEquals(
    utils.includes('export { botName, normalizeInput, slash, threadOpts }'),
    true,
    'utils must export normalizeInput',
  )
})

Deno.test('help text mentions /command DM syntax', async () => {
  const help = await Deno.readTextFile(
    join(ROOT, 'control-plane/src/bots/slack/commands/help.ts'),
  )
  assertEquals(
    help.includes('with or without'),
    true,
    'help must describe optional slash prefix in DMs',
  )
  assertEquals(
    help.includes('`/help`'),
    true,
    'help must show /help as an example',
  )
})

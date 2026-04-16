import { assertEquals } from '@std/assert'
import { exists } from '@std/fs'
import { join } from '@std/path'

Deno.test('shared MarkdownEditor component exists', async () => {
  const path = join(
    Deno.cwd(),
    '..',
    'web',
    'src',
    'components',
    'editor.tsx',
  )
  assertEquals(
    await exists(path),
    true,
    'components/editor.tsx must exist',
  )
  const content = await Deno.readTextFile(path)
  assertEquals(
    content.includes('export function MarkdownEditor'),
    true,
    'editor.tsx must export MarkdownEditor',
  )
})

Deno.test('EntityForm component exists with version bump', async () => {
  const path = join(
    Deno.cwd(),
    '..',
    'web',
    'src',
    'components',
    'entity-form.tsx',
  )
  assertEquals(
    await exists(path),
    true,
    'components/entity-form.tsx must exist',
  )
  const content = await Deno.readTextFile(path)
  assertEquals(
    content.includes('export function EntityForm'),
    true,
    'entity-form.tsx must export EntityForm',
  )
  assertEquals(
    content.includes('bumpPatch'),
    true,
    'entity-form.tsx must contain version bump logic',
  )
  assertEquals(
    content.includes('bumpPrompt'),
    true,
    'entity-form.tsx must contain bump prompt state',
  )
})

Deno.test('EntityForm has visibility toggle with admin check', async () => {
  const path = join(
    Deno.cwd(),
    '..',
    'web',
    'src',
    'components',
    'entity-form.tsx',
  )
  const content = await Deno.readTextFile(path)
  assertEquals(
    content.includes('isAdmin'),
    true,
    'entity-form.tsx must check isAdmin for visibility',
  )
  assertEquals(
    content.includes("'private'") && content.includes("'public'"),
    true,
    'entity-form.tsx must support both visibility options',
  )
})

Deno.test('registry-status.tsx has edit and delete buttons', async () => {
  const path = join(
    Deno.cwd(),
    '..',
    'web',
    'src',
    'islands',
    'registry-status.tsx',
  )
  const content = await Deno.readTextFile(path)
  assertEquals(
    content.includes('onEdit'),
    true,
    'registry-status.tsx must have onEdit handler',
  )
  assertEquals(
    content.includes('onDelete'),
    true,
    'registry-status.tsx must have onDelete handler',
  )
  assertEquals(
    content.includes('EntityForm'),
    true,
    'registry-status.tsx must use EntityForm',
  )
})

Deno.test('registry-status.tsx has create buttons', async () => {
  const path = join(
    Deno.cwd(),
    '..',
    'web',
    'src',
    'islands',
    'registry-status.tsx',
  )
  const content = await Deno.readTextFile(path)
  assertEquals(
    content.includes('startCreate'),
    true,
    'registry-status.tsx must have create handler',
  )
})

Deno.test('agents.tsx imports from shared editor', async () => {
  const path = join(
    Deno.cwd(),
    '..',
    'web',
    'src',
    'islands',
    'agents.tsx',
  )
  const content = await Deno.readTextFile(path)
  assertEquals(
    content.includes("from '../components/editor.tsx'"),
    true,
    'agents.tsx must import MarkdownEditor from shared component',
  )
})

Deno.test('EntityForm has dirty tracking', async () => {
  const path = join(
    Deno.cwd(),
    '..',
    'web',
    'src',
    'components',
    'entity-form.tsx',
  )
  const content = await Deno.readTextFile(path)
  assertEquals(
    content.includes('fingerprint'),
    true,
    'entity-form.tsx must use fingerprint for dirty tracking',
  )
  assertEquals(
    content.includes('dirty'),
    true,
    'entity-form.tsx must compute dirty state',
  )
  assertEquals(
    content.includes('No changes'),
    true,
    'entity-form.tsx must show "No changes" when not dirty',
  )
})

Deno.test('EntityForm prevents version regression', async () => {
  const path = join(
    Deno.cwd(),
    '..',
    'web',
    'src',
    'components',
    'entity-form.tsx',
  )
  const content = await Deno.readTextFile(path)
  assertEquals(
    content.includes('compareSemver'),
    true,
    'entity-form.tsx must use compareSemver',
  )
  assertEquals(
    content.includes('versionRegressed'),
    true,
    'entity-form.tsx must detect version regression',
  )
})

Deno.test('registry-status.tsx has import UI for skills', async () => {
  const path = join(
    Deno.cwd(),
    '..',
    'web',
    'src',
    'islands',
    'registry-status.tsx',
  )
  const content = await Deno.readTextFile(path)
  assertEquals(
    content.includes('importing'),
    true,
    'registry-status.tsx must have import state',
  )
  assertEquals(
    content.includes('handleImport'),
    true,
    'registry-status.tsx must have import handler',
  )
  assertEquals(
    content.includes('/skills/import'),
    true,
    'registry-status.tsx must call /skills/import endpoint',
  )
})

Deno.test('mock API has entity CRUD routes', async () => {
  const path = join(
    Deno.cwd(),
    '..',
    'web',
    'dev',
    'mock.ts',
  )
  const content = await Deno.readTextFile(path)
  assertEquals(
    content.includes('tools|skills|rules'),
    true,
    'mock.ts must handle entity routes',
  )
  assertEquals(
    content.includes("method === 'PUT'") ||
      content.includes("=== 'PUT'"),
    true,
    'mock.ts must handle PUT for entities',
  )
  assertEquals(
    content.includes("method === 'DELETE'") ||
      content.includes("=== 'DELETE'"),
    true,
    'mock.ts must handle DELETE for entities',
  )
})

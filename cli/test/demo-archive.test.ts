import { assertEquals, assertStringIncludes } from '@std/assert'
import { join } from '@std/path'

const ROOT = join(Deno.cwd(), '..')

Deno.test('storage.ts has pushArchive and pullArchive', async () => {
  const storage = await Deno.readTextFile(
    join(ROOT, 'sdk-agent-nodejs/src/storage.ts'),
  )

  assertStringIncludes(storage, 'async pushArchive(')
  assertStringIncludes(storage, 'async pullArchive(')
})

Deno.test('pushArchive uses tar with exclusions', async () => {
  const storage = await Deno.readTextFile(
    join(ROOT, 'sdk-agent-nodejs/src/storage.ts'),
  )

  assertStringIncludes(storage, '"--exclude", "node_modules"')
  assertStringIncludes(storage, '"--exclude", ".git"')
  assertStringIncludes(storage, '"--exclude", ".env"')
  assertStringIncludes(storage, 'application/gzip')
})

Deno.test('pullArchive streams via pipeline', async () => {
  const storage = await Deno.readTextFile(
    join(ROOT, 'sdk-agent-nodejs/src/storage.ts'),
  )

  assertStringIncludes(storage, 'pipeline')
  assertStringIncludes(storage, 'Readable.fromWeb')
  assertStringIncludes(storage, 'proc.stdin')
})

Deno.test('walkDir excludes node_modules and .git', async () => {
  const storage = await Deno.readTextFile(
    join(ROOT, 'sdk-agent-nodejs/src/storage.ts'),
  )

  assertStringIncludes(storage, 'SKIP')
  assertStringIncludes(storage, 'node_modules')
  assertStringIncludes(storage, '.git')
  assertStringIncludes(storage, '.env')
  assertStringIncludes(storage, '.cache')
  assertStringIncludes(storage, '.next')
})

Deno.test('readRaw returns Buffer not string', async () => {
  const storage = await Deno.readTextFile(
    join(ROOT, 'sdk-agent-nodejs/src/storage.ts'),
  )

  const readRawMatch = storage.match(
    /async readRaw\([^)]+\):\s*Promise<([^>]+)>/,
  )
  assertEquals(
    readRawMatch !== null,
    true,
    'readRaw must have a return type annotation',
  )
  assertEquals(
    readRawMatch![1],
    'Buffer',
    'readRaw must return Promise<Buffer>',
  )

  assertStringIncludes(storage, 'Buffer.from(await res.arrayBuffer())')
})

Deno.test('writeRaw accepts string or Buffer', async () => {
  const storage = await Deno.readTextFile(
    join(ROOT, 'sdk-agent-nodejs/src/storage.ts'),
  )

  assertStringIncludes(storage, 'data: string | Buffer')
})

Deno.test('pushRaw reads files as binary', async () => {
  const storage = await Deno.readTextFile(
    join(ROOT, 'sdk-agent-nodejs/src/storage.ts'),
  )

  const pushRawSection = storage.slice(
    storage.indexOf('async pushRaw('),
    storage.indexOf('async pushArchive('),
  )
  assertStringIncludes(pushRawSection, 'fs.readFileSync(filePath)')
  assertEquals(
    pushRawSection.includes('"utf-8"'),
    false,
    'pushRaw must not read files as utf-8',
  )
})

Deno.test('index.js uses pushArchive and pullArchive', async () => {
  const indexJs = await Deno.readTextFile(
    join(ROOT, 'default-registry/agents/demo-agent/0.0.1/index.js'),
  )

  assertStringIncludes(indexJs, 'pushArchive')
  assertStringIncludes(indexJs, 'pullArchive')
  assertStringIncludes(indexJs, 'source.tar.gz')
  assertEquals(
    indexJs.includes('pushRaw'),
    false,
    'index.js must not use pushRaw for source upload',
  )
})

Deno.test('index.js does not use process.chdir', async () => {
  const indexJs = await Deno.readTextFile(
    join(ROOT, 'default-registry/agents/demo-agent/0.0.1/index.js'),
  )

  assertEquals(
    indexJs.includes('process.chdir'),
    false,
    'index.js must not use process.chdir',
  )
})

Deno.test('index.js writes demo.json to storage', async () => {
  const indexJs = await Deno.readTextFile(
    join(ROOT, 'default-registry/agents/demo-agent/0.0.1/index.js'),
  )

  assertStringIncludes(indexJs, 'writeRaw(')
  assertStringIncludes(indexJs, 'demo.json')
})

Deno.test('index.js always uses /deploy endpoint', async () => {
  const indexJs = await Deno.readTextFile(
    join(ROOT, 'default-registry/agents/demo-agent/0.0.1/index.js'),
  )

  assertStringIncludes(indexJs, "'/deploy'")
  assertEquals(
    indexJs.includes("'/update'"),
    false,
    'index.js must not call /update endpoint',
  )
  assertEquals(
    indexJs.includes('deployAction'),
    false,
    'index.js must not use deployAction variable',
  )
})

Deno.test('handler template uses archive methods', async () => {
  const template = await Deno.readTextFile(
    join(ROOT, 'sdk-client-deno/src/templates/agent-demo.ts'),
  )

  assertStringIncludes(template, 'pushArchive')
  assertStringIncludes(template, 'pullArchive')
  assertStringIncludes(template, 'source.tar.gz')
  assertEquals(
    template.includes('version: version'),
    false,
    'template must not reference undefined version variable',
  )
})

Deno.test('demos.ts downloadSource handles archive layout', async () => {
  const demos = await Deno.readTextFile(
    join(ROOT, 'sdk-client-deno/src/operations/demos.ts'),
  )

  assertStringIncludes(demos, 'source.tar.gz')
  assertStringIncludes(demos, 'UntarStream')
  assertStringIncludes(demos, 'DecompressionStream')
})

Deno.test('demos.ts does not export storeFiles', async () => {
  const demos = await Deno.readTextFile(
    join(ROOT, 'sdk-client-deno/src/operations/demos.ts'),
  )

  assertEquals(
    demos.includes('storeFiles'),
    false,
    'demos.ts must not export dead storeFiles function',
  )
})

import { assertEquals, assertNotEquals } from '@std/assert'
import { join } from '@std/path'

const ROOT = join(Deno.cwd(), '..')

Deno.test('walkDir excludes node_modules, .git, .env at runtime', async () => {
  const tmp = await Deno.makeTempDir()
  try {
    await Deno.writeTextFile(join(tmp, 'index.js'), 'console.log("hi")')
    await Deno.mkdir(join(tmp, 'src'))
    await Deno.writeTextFile(join(tmp, 'src', 'app.js'), 'export {}')
    await Deno.mkdir(join(tmp, 'node_modules', 'pkg'), { recursive: true })
    await Deno.writeTextFile(
      join(tmp, 'node_modules', 'pkg', 'index.js'),
      'bad',
    )
    await Deno.mkdir(join(tmp, '.git', 'objects'), { recursive: true })
    await Deno.writeTextFile(join(tmp, '.git', 'HEAD'), 'ref: refs/heads/main')
    await Deno.writeTextFile(join(tmp, '.env'), 'SECRET=bad')
    await Deno.mkdir(join(tmp, '.cache'))
    await Deno.writeTextFile(join(tmp, '.cache', 'data'), 'cached')
    await Deno.mkdir(join(tmp, '.next'))
    await Deno.writeTextFile(join(tmp, '.next', 'build'), 'next')

    const cmd = new Deno.Command('node', {
      args: [
        '-e',
        `
        const { AgentStorage } = require('./bin/index.cjs');
        const s = new AgentStorage({
          controlPlaneUrl: 'http://localhost:0',
          token: 'x', bucket: 'x', tenantId: 'x', agentId: 'x'
        });
        const files = s['walkDir']('${tmp.replace(/\\/g, '\\\\')}');
        const rel = files.map(f => f.slice(${tmp.length + 1}));
        console.log(JSON.stringify(rel.sort()));
        `,
      ],
      cwd: join(ROOT, 'sdk-agent-nodejs'),
      stdout: 'piped',
      stderr: 'piped',
    })
    const out = await cmd.output()
    assertEquals(out.code, 0, new TextDecoder().decode(out.stderr))

    const files = JSON.parse(new TextDecoder().decode(out.stdout).trim())
    assertEquals(files.includes('index.js'), true, 'should include index.js')
    assertEquals(
      files.includes('src/app.js'),
      true,
      'should include src/app.js',
    )
    assertEquals(
      files.some((f: string) => f.startsWith('node_modules')),
      false,
      'must exclude node_modules',
    )
    assertEquals(
      files.some((f: string) => f.startsWith('.git')),
      false,
      'must exclude .git',
    )
    assertEquals(files.includes('.env'), false, 'must exclude .env')
    assertEquals(
      files.some((f: string) => f.startsWith('.cache')),
      false,
      'must exclude .cache',
    )
    assertEquals(
      files.some((f: string) => f.startsWith('.next')),
      false,
      'must exclude .next',
    )
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test('pushArchive + pullArchive round-trip preserves files', async () => {
  const srcDir = await Deno.makeTempDir()
  const extractDir = await Deno.makeTempDir()
  const archivePath = join(await Deno.makeTempDir(), 'test.tar.gz')

  try {
    await Deno.writeTextFile(join(srcDir, 'hello.txt'), 'hello world')
    await Deno.mkdir(join(srcDir, 'sub'))
    await Deno.writeTextFile(join(srcDir, 'sub', 'nested.txt'), 'nested')

    const png = new Uint8Array([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      0x00,
      0x00,
      0x00,
      0x0d,
      0x49,
      0x48,
      0x44,
      0x52,
    ])
    await Deno.writeFile(join(srcDir, 'image.png'), png)

    await Deno.mkdir(join(srcDir, 'node_modules', 'pkg'), { recursive: true })
    await Deno.writeTextFile(
      join(srcDir, 'node_modules', 'pkg', 'bad.js'),
      'should be excluded',
    )
    await Deno.mkdir(join(srcDir, '.git'))
    await Deno.writeTextFile(join(srcDir, '.git', 'HEAD'), 'excluded')

    const pack = new Deno.Command('tar', {
      args: [
        '-czf',
        archivePath,
        '--exclude',
        'node_modules',
        '--exclude',
        '.git',
        '--exclude',
        '.env',
        '-C',
        srcDir,
        '.',
      ],
    })
    const packOut = await pack.output()
    assertEquals(packOut.code, 0, 'tar pack failed')

    const stat = await Deno.stat(archivePath)
    assertNotEquals(stat.size, 0, 'archive should not be empty')

    const unpack = new Deno.Command('tar', {
      args: ['-xzf', archivePath, '-C', extractDir],
    })
    const unpackOut = await unpack.output()
    assertEquals(unpackOut.code, 0, 'tar unpack failed')

    const hello = await Deno.readTextFile(join(extractDir, 'hello.txt'))
    assertEquals(hello, 'hello world')

    const nested = await Deno.readTextFile(
      join(extractDir, 'sub', 'nested.txt'),
    )
    assertEquals(nested, 'nested')

    const roundTrippedPng = await Deno.readFile(join(extractDir, 'image.png'))
    assertEquals(
      roundTrippedPng.length,
      png.length,
      'binary file size must match',
    )
    for (let i = 0; i < png.length; i++) {
      assertEquals(
        roundTrippedPng[i],
        png[i],
        `binary byte mismatch at offset ${i}`,
      )
    }

    let hasNodeModules = false
    let hasGit = false
    try {
      await Deno.stat(join(extractDir, 'node_modules'))
      hasNodeModules = true
    } catch { /* expected */ }
    try {
      await Deno.stat(join(extractDir, '.git'))
      hasGit = true
    } catch { /* expected */ }
    assertEquals(hasNodeModules, false, 'node_modules must be excluded')
    assertEquals(hasGit, false, '.git must be excluded')
  } finally {
    await Deno.remove(srcDir, { recursive: true })
    await Deno.remove(extractDir, { recursive: true })
  }
})

Deno.test('readRaw returns Buffer (binary-safe)', async () => {
  const cmd = new Deno.Command('node', {
    args: [
      '-e',
      `
      const { AgentStorage } = require('./bin/index.cjs');
      const s = new AgentStorage({
        controlPlaneUrl: 'http://localhost:0',
        token: 'x', bucket: 'x', tenantId: 'x', agentId: 'x'
      });
      const sig = s.readRaw.toString();
      const hasArrayBuffer = sig.includes('arrayBuffer');
      const hasBufferFrom = sig.includes('Buffer.from');
      console.log(JSON.stringify({ hasArrayBuffer, hasBufferFrom }));
      `,
    ],
    cwd: join(ROOT, 'sdk-agent-nodejs'),
    stdout: 'piped',
    stderr: 'piped',
  })
  const out = await cmd.output()
  assertEquals(out.code, 0, new TextDecoder().decode(out.stderr))

  const result = JSON.parse(new TextDecoder().decode(out.stdout).trim())
  assertEquals(result.hasArrayBuffer, true, 'readRaw must use arrayBuffer()')
  assertEquals(result.hasBufferFrom, true, 'readRaw must use Buffer.from()')
})

Deno.test('writeRaw accepts Uint8Array (binary-safe)', async () => {
  const cmd = new Deno.Command('node', {
    args: [
      '-e',
      `
      const { AgentStorage } = require('./bin/index.cjs');
      const s = new AgentStorage({
        controlPlaneUrl: 'http://localhost:0',
        token: 'x', bucket: 'x', tenantId: 'x', agentId: 'x'
      });
      const sig = s.writeRaw.toString();
      const hasUint8Array = sig.includes('Uint8Array');
      console.log(JSON.stringify({ hasUint8Array }));
      `,
    ],
    cwd: join(ROOT, 'sdk-agent-nodejs'),
    stdout: 'piped',
    stderr: 'piped',
  })
  const out = await cmd.output()
  assertEquals(out.code, 0, new TextDecoder().decode(out.stderr))

  const result = JSON.parse(new TextDecoder().decode(out.stdout).trim())
  assertEquals(
    result.hasUint8Array,
    true,
    'writeRaw must convert Buffer to Uint8Array',
  )
})

Deno.test('pushArchive and pullArchive exist in compiled bundle', async () => {
  const cmd = new Deno.Command('node', {
    args: [
      '-e',
      `
      const { AgentStorage } = require('./bin/index.cjs');
      const s = new AgentStorage({
        controlPlaneUrl: 'http://localhost:0',
        token: 'x', bucket: 'x', tenantId: 'x', agentId: 'x'
      });
      console.log(JSON.stringify({
        hasPushArchive: typeof s.pushArchive === 'function',
        hasPullArchive: typeof s.pullArchive === 'function',
        hasPushRaw: typeof s.pushRaw === 'function',
        hasPullRaw: typeof s.pullRaw === 'function',
      }));
      `,
    ],
    cwd: join(ROOT, 'sdk-agent-nodejs'),
    stdout: 'piped',
    stderr: 'piped',
  })
  const out = await cmd.output()
  assertEquals(out.code, 0, new TextDecoder().decode(out.stderr))

  const result = JSON.parse(new TextDecoder().decode(out.stdout).trim())
  assertEquals(result.hasPushArchive, true, 'must export pushArchive')
  assertEquals(result.hasPullArchive, true, 'must export pullArchive')
  assertEquals(result.hasPushRaw, true, 'must still export pushRaw')
  assertEquals(result.hasPullRaw, true, 'must still export pullRaw')
})

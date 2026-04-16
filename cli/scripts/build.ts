#!/usr/bin/env -S deno run -A
import { exists } from '@std/fs'
import { basename, join } from '@std/path'
import { TarStream, type TarStreamInput } from '@std/tar/tar-stream'

interface Target {
  deno: string
  suffix: string
}

const CROSS_TARGETS: Target[] = [
  { deno: 'x86_64-unknown-linux-gnu', suffix: 'linux-x64' },
  { deno: 'aarch64-unknown-linux-gnu', suffix: 'linux-arm64' },
  { deno: 'x86_64-apple-darwin', suffix: 'darwin-x64' },
  { deno: 'aarch64-apple-darwin', suffix: 'darwin-arm64' },
]

const positional = Deno.args.filter((a) => !a.startsWith('--'))
const flags = new Set(Deno.args.filter((a) => a.startsWith('--')))
const VERSION = positional[0] || '0.1.0'
const CROSS = flags.has('--cross')

const ROOT = new URL('..', import.meta.url).pathname
const REPO_ROOT = new URL('../..', import.meta.url).pathname
const DIST = join(ROOT, 'dist')
const CP_BINARY = join(DIST, 'ar-control-plane')
const CP_ARCHIVE = join(DIST, 'ar-control-plane.tar.gz')
const RUNTIME_CONFIG = join(REPO_ROOT, 'default-settings.jsonc')
const REGISTRY_DIR = join(REPO_ROOT, 'default-registry')
const WEB_DIR = join(REPO_ROOT, 'web')
const WEB_DIST = join(WEB_DIR, 'dist')

async function gitInfo(): Promise<Record<string, string>> {
  const get = async (args: string[]): Promise<string> => {
    try {
      const proc = new Deno.Command('git', {
        args,
        stdout: 'piped',
        stderr: 'piped',
        cwd: ROOT,
      })
      const out = await proc.output()
      return out.success
        ? new TextDecoder().decode(out.stdout).trim()
        : 'unknown'
    } catch {
      return 'unknown'
    }
  }
  return {
    AR_BUILD_COMMIT: await get(['rev-parse', '--short', 'HEAD']),
    AR_BUILD_AUTHOR: await get(['log', '-1', '--format=%an']),
    AR_BUILD_DATE: await get(['log', '-1', '--format=%ci']),
    AR_BUILD_BRANCH: await get(['rev-parse', '--abbrev-ref', 'HEAD']),
  }
}

async function run(
  cmd: string,
  args: string[],
  cwd = ROOT,
): Promise<void> {
  console.log(`> ${cmd} ${args.join(' ')}`)
  const proc = new Deno.Command(cmd, {
    args,
    stdout: 'inherit',
    stderr: 'inherit',
    cwd,
  })
  const output = await proc.output()
  if (!output.success) {
    throw new Error(`Command failed: ${cmd} ${args.join(' ')}`)
  }
}

async function clean(): Promise<void> {
  if (await exists(DIST)) {
    await Deno.remove(DIST, { recursive: true })
  }
  await Deno.mkdir(DIST, { recursive: true })
}

async function writeEnvFile(
  path: string,
  vars: Record<string, string>,
): Promise<void> {
  const content = Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n') + '\n'
  await Deno.writeTextFile(path, content)
}

async function buildWeb(): Promise<void> {
  console.log('\n--- Building web assets ---')
  const pkgJson = join(WEB_DIR, 'package.json')
  if (await exists(pkgJson)) {
    await run('npm', ['ci'], WEB_DIR)
    await run('npx', ['vite', 'build'], WEB_DIR)
  } else {
    console.log('  No web/package.json found, skipping web build')
  }
}

async function compressFile(
  srcPath: string,
  destPath: string,
): Promise<void> {
  const stat = await Deno.stat(srcPath)
  const name = basename(srcPath)
  const file = await Deno.open(srcPath, { read: true })

  const entry: TarStreamInput = {
    type: 'file',
    path: name,
    size: stat.size,
    readable: file.readable,
  }

  const dest = await Deno.open(destPath, {
    write: true,
    create: true,
    truncate: true,
  })

  await ReadableStream.from([entry])
    .pipeThrough(new TarStream())
    .pipeThrough(new CompressionStream('gzip'))
    .pipeTo(dest.writable)
}

async function compileControlPlane(): Promise<void> {
  console.log('\n--- Compiling control plane (linux x86_64) ---')
  const envFile = join(DIST, '.env.cp-build')
  const git = await gitInfo()
  await writeEnvFile(envFile, {
    AR_MODE: 'server',
    AR_BUILD_MODE: 'production',
    AR_BUILD_VERSION: VERSION,
    ...git,
  })

  const cpEntry = join(REPO_ROOT, 'control-plane', 'src', 'mod.ts')

  const docsDir = join(REPO_ROOT, 'docs')
  const readmePath = join(REPO_ROOT, 'README.md')
  await run('deno', [
    'compile',
    '--allow-all',
    '--target=x86_64-unknown-linux-gnu',
    `--include=${RUNTIME_CONFIG}`,
    `--include=${REGISTRY_DIR}`,
    `--include=${WEB_DIST}`,
    `--include=${docsDir}`,
    `--include=${readmePath}`,
    `--output=${CP_BINARY}`,
    `--env-file=${envFile}`,
    cpEntry,
  ])

  await Deno.remove(envFile)

  console.log('Compressing control plane binary...')
  await compressFile(CP_BINARY, CP_ARCHIVE)
  const rawStat = await Deno.stat(CP_BINARY)
  const gzStat = await Deno.stat(CP_ARCHIVE)
  const mb = (b: number) => (b / 1024 / 1024).toFixed(1)
  console.log(
    `  ${mb(rawStat.size)}MB -> ${mb(gzStat.size)}MB` +
      ` (${((1 - gzStat.size / rawStat.size) * 100).toFixed(0)}% reduction)`,
  )

  await Deno.remove(CP_BINARY)
}

async function compileCli(target?: Target): Promise<string> {
  const label = target ? target.suffix : 'host platform'
  const output = target ? `ar-${target.suffix}` : 'ar'
  console.log(`\n--- Compiling CLI (${label}) ---`)

  const envFile = join(DIST, '.env.cli-build')
  const git = await gitInfo()
  await writeEnvFile(envFile, {
    AR_BUILD_MODE: 'production',
    AR_BUILD_VERSION: VERSION,
    ...git,
  })

  const args = [
    'compile',
    '--allow-all',
    `--include=${CP_ARCHIVE}`,
    `--include=${RUNTIME_CONFIG}`,
    `--include=${REGISTRY_DIR}`,
    `--output=${DIST}/${output}`,
    `--env-file=${envFile}`,
  ]
  if (target) args.push(`--target=${target.deno}`)
  args.push('src/cli.ts')

  await run('deno', args)
  await Deno.remove(envFile)
  return join(DIST, output)
}

async function build(): Promise<void> {
  console.log(
    `Building ar-cli v${VERSION}${CROSS ? ' (cross-compile)' : ''}`,
  )
  await clean()
  await buildWeb()
  await compileControlPlane()

  const binaries: string[] = []
  if (CROSS) {
    for (const target of CROSS_TARGETS) {
      binaries.push(await compileCli(target))
    }
  } else {
    binaries.push(await compileCli())
  }

  const archiveStat = await Deno.stat(CP_ARCHIVE)
  const mb = (b: number) => (b / 1024 / 1024).toFixed(1)

  console.log(`\nBuild complete. Artifacts in ${DIST}/`)
  for (const bin of binaries) {
    const stat = await Deno.stat(bin)
    console.log(`  ${basename(bin).padEnd(25)} ${mb(stat.size)}MB`)
  }
  console.log(
    `  ${'ar-control-plane.tar.gz'.padEnd(25)} ` +
      `${mb(archiveStat.size)}MB (compressed linux x86_64)`,
  )
}

build()

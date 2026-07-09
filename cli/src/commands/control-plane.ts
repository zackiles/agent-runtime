import { parseArgs } from '@std/cli'
import { exists } from '@std/fs'
import { join, resolve } from '@std/path'
import { parse as parseJsonc } from '@std/jsonc'
import { UntarStream } from '@std/tar/untar-stream'
import type {
  CommandRouteDefinition,
  CommandRouteOptions,
} from '../utils/command-router.ts'
import logger from '@ar/client/utils/logger'
import * as terminal from '../terminal/mod.ts'
import { confirm, select, spinner, text } from '../terminal/mod.ts'
import { createSession } from '../auth.ts'
import { defaultSettingsDir, loadGcp, save } from '../settings.ts'
import type { AgentDeployMode, GcpSettings } from '../settings.ts'
import { BUILD_VERSION, isProduction } from '@ar/client/build'
import { configDir, load as loadRuntime, registryDir } from '@ar/client/runtime'
import { exec, gcloud, gcloudWrite } from '../utils/gcloud.ts'

const rc = loadRuntime()
const SERVICE_NAME = rc.controlPlane.serviceName

async function validateProject(project: string): Promise<void> {
  const result = await gcloud([
    'projects',
    'describe',
    project,
    '--format=value(projectId)',
  ])
  if (!result.ok) {
    if (result.stderr.includes('PERMISSION_DENIED')) {
      throw new Error(
        `No access to project '${project}'.` +
          ` Ensure your account has the correct IAM roles.`,
      )
    }
    throw new Error(
      `Project '${project}' not found or not accessible.` +
        ` Verify the project ID and try again.`,
    )
  }
}

const REQUIRED_APIS = [
  'cloudbuild.googleapis.com',
  'run.googleapis.com',
  'secretmanager.googleapis.com',
  'cloudfunctions.googleapis.com',
  'cloudscheduler.googleapis.com',
  'aiplatform.googleapis.com',
]

async function checkApis(project: string): Promise<void> {
  terminal.info('Checking required GCP APIs...')
  const result = await gcloud([
    'services',
    'list',
    '--enabled',
    `--project=${project}`,
    '--format=value(config.name)',
  ])
  if (!result.ok) {
    logger.warn(
      'Could not verify enabled APIs. Proceeding anyway.',
    )
    return
  }

  const enabled = new Set(
    result.stdout.split('\n').map((s) => s.trim()),
  )
  const missing = REQUIRED_APIS.filter((api) => !enabled.has(api))

  if (missing.length === 0) {
    terminal.step('All required APIs enabled.')
    return
  }

  terminal.step(`Missing APIs: ${missing.join(', ')}`)
  if (!await confirm('Enable these APIs now?')) {
    throw new Error(
      'Required APIs are not enabled.' +
        ' Enable them manually or re-run.',
    )
  }

  for (const api of missing) {
    terminal.step(`Enabling ${api}...`)
    const enable = await gcloud([
      'services',
      'enable',
      api,
      `--project=${project}`,
    ], 120_000)
    if (!enable.ok) {
      throw new Error(`Failed to enable ${api}: ${enable.stderr}`)
    }
  }
  terminal.step('All APIs enabled.')
}

async function ensureSettings(): Promise<GcpSettings> {
  const reg = await loadGcp()
  if (reg.project && reg.region && reg.runtimeAccount) {
    return reg
  }

  terminal.info(
    'Settings missing required fields.' +
      ' Updating interactively...',
  )

  const project = reg.project ||
    await text('GCP Project ID', { flag: 'project' })
  if (!project) throw new Error('Project ID is required.')

  terminal.info(`Validating project '${project}'...`)
  await validateProject(project)
  terminal.step(`Project '${project}' confirmed.`)

  const defaultRegion = reg.region || rc.platform.region
  const region = await text('Region', {
    default: defaultRegion,
    flag: 'region',
  })

  const defaultSa = reg.runtimeAccount ||
    rc.platform.runtimeAccountPattern.replace('${project}', project)
  const runtimeAccount = await text('Runtime account', {
    default: defaultSa,
    flag: 'runtime-account',
  })

  const defaultWorker = reg.workerAccount ||
    (rc.platform.workerAccountPattern || '')
      .replace('${project}', project)
  const workerAccount = defaultWorker || runtimeAccount

  await save({ project, region, runtimeAccount, workerAccount })
  terminal.success('Settings saved.')
  return await loadGcp()
}

const DOCKERFILE = `FROM ${rc.controlPlane.baseImage}
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
COPY ar-control-plane /usr/local/bin/ar-control-plane
RUN chmod +x /usr/local/bin/ar-control-plane
RUN mkdir -p ${rc.controlPlane.dbPath}
VOLUME ["${rc.controlPlane.dbPath}"]
ENV AR_MODE=server
ENV PORT=${rc.controlPlane.port}
ENV AR_DB_PATH=${rc.controlPlane.dbPath}
EXPOSE ${rc.controlPlane.port}
CMD ["/usr/local/bin/ar-control-plane"]
`

async function extractEmbeddedArchive(dest: string): Promise<void> {
  const candidates = [
    join(
      import.meta.dirname!,
      '..',
      '..',
      'dist',
      'ar-control-plane.tar.gz',
    ),
    join(
      import.meta.dirname!,
      '..',
      'dist',
      'ar-control-plane.tar.gz',
    ),
    join(
      import.meta.dirname!,
      'dist',
      'ar-control-plane.tar.gz',
    ),
  ]

  for (const path of candidates) {
    try {
      const file = await Deno.open(path, { read: true })
      const destDir = dest.replace(/\/[^/]+$/, '')
      const destRoot = resolve(destDir)

      for await (
        const entry of file.readable
          .pipeThrough(new DecompressionStream('gzip'))
          .pipeThrough(new UntarStream())
      ) {
        const outPath = join(destDir, entry.path)
        if (!resolve(outPath).startsWith(destRoot + '/')) {
          throw new Error(`Refusing to extract outside dest: ${entry.path}`)
        }
        if (entry.header.typeflag === 'directory') {
          await Deno.mkdir(outPath, { recursive: true })
        } else {
          const out = await Deno.open(outPath, {
            write: true,
            create: true,
            truncate: true,
          })
          await entry.readable?.pipeTo(out.writable)
        }
      }

      return
    } catch {
      continue
    }
  }

  throw new Error(
    'Embedded control plane archive not found.' +
      ' Run the production build first: deno task build',
  )
}

async function compileFromSource(dest: string): Promise<void> {
  const repoRoot = join(import.meta.dirname!, '..', '..', '..')
  const cpEntry = join(repoRoot, 'control-plane', 'src', 'mod.ts')
  const runtimeConfig = join(repoRoot, 'default-settings.jsonc')
  const webDir = join(repoRoot, 'web')
  const webDist = join(webDir, 'dist')

  const webPkg = join(webDir, 'package.json')
  if (await exists(webPkg)) {
    terminal.step('Building web assets...')
    const hasModules = await exists(join(webDir, 'node_modules'))
    if (!hasModules) {
      const npmCi = new Deno.Command('npm', {
        args: ['ci'],
        cwd: webDir,
        stdout: 'inherit',
        stderr: 'inherit',
      })
      const ciOut = await npmCi.output()
      if (!ciOut.success) throw new Error('npm ci failed for web/')
    }

    const vite = new Deno.Command('npx', {
      args: ['vite', 'build'],
      cwd: webDir,
      stdout: 'inherit',
      stderr: 'inherit',
    })
    const viteOut = await vite.output()
    if (!viteOut.success) throw new Error('vite build failed')
  }

  terminal.step(
    'Compiling control plane from source (linux x86_64)...',
  )
  const docsDir = join(repoRoot, 'docs')
  const readmePath = join(repoRoot, 'README.md')
  const compileArgs = [
    'compile',
    '--allow-all',
    '--target=x86_64-unknown-linux-gnu',
    `--include=${runtimeConfig}`,
    `--include=${webDist}`,
    `--include=${docsDir}`,
    `--include=${readmePath}`,
    `--output=${dest}`,
    cpEntry,
  ]

  const proc = new Deno.Command('deno', {
    args: compileArgs,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const output = await proc.output()
  if (!output.success) {
    throw new Error('Failed to compile control plane binary.')
  }
}

async function prepareStagingDir(): Promise<string> {
  const staging = await Deno.makeTempDir({
    prefix: 'ar-control-plane-',
  })
  const binaryPath = join(staging, 'ar-control-plane')

  if (isProduction()) {
    terminal.step('Extracting embedded control plane archive...')
    await extractEmbeddedArchive(binaryPath)
  } else {
    await compileFromSource(binaryPath)
  }

  await Deno.writeTextFile(join(staging, 'Dockerfile'), DOCKERFILE)

  const repoRoot = join(import.meta.dirname!, '..', '..', '..')
  const gcloudIgnoreSrc = join(repoRoot, '.gcloudignore')
  if (await exists(gcloudIgnoreSrc)) {
    await Deno.copyFile(gcloudIgnoreSrc, join(staging, '.gcloudignore'))
  }

  return staging
}

type DestroyOptions = {
  force: boolean
  all?: boolean
  keepSecrets?: boolean
  keepIam?: boolean
}

type ResetOptions = {
  force: boolean
  tenant?: string | undefined
  all?: boolean
}

async function grantRoles(
  project: string,
  account: string,
  roles: string[],
): Promise<void> {
  const result = await gcloud([
    'projects',
    'get-iam-policy',
    project,
    '--flatten=bindings[].members',
    `--filter=bindings.members:serviceAccount:${account}`,
    '--format=value(bindings.role)',
  ])

  const existing = new Set(
    result.ok
      ? result.stdout.split('\n').map((r) => r.trim())
        .filter(Boolean)
      : [],
  )
  const missing = roles.filter((r) => !existing.has(r))

  if (missing.length === 0) {
    terminal.step(`All roles present for ${account}.`)
    return
  }

  terminal.step(`Missing roles: ${missing.join(', ')}`)
  terminal.step(`Granting roles to ${account}...`)

  for (const role of missing) {
    const grant = await gcloud([
      'projects',
      'add-iam-policy-binding',
      project,
      `--member=serviceAccount:${account}`,
      `--role=${role}`,
      '--condition=None',
      '--format=none',
    ])
    if (!grant.ok) {
      throw new Error(
        `Failed to grant ${role} to ${account}:` +
          ` ${grant.stderr}`,
      )
    }
    terminal.step(`Granted ${role}`)
  }
}

async function ensureServiceAccount(
  project: string,
  email: string,
  displayName: string,
): Promise<void> {
  const check = await gcloud([
    'iam',
    'service-accounts',
    'describe',
    email,
    `--project=${project}`,
  ])
  if (check.ok) return

  terminal.step(`Creating service account ${email}...`)
  const accountId = email.split('@')[0]
  await exec([
    'iam',
    'service-accounts',
    'create',
    accountId,
    `--project=${project}`,
    `--display-name=${displayName}`,
  ])
}

async function ensureRoles(
  project: string,
  runtimeAccount: string,
  workerAccount?: string,
): Promise<void> {
  terminal.info('Verifying service account IAM roles...')

  await ensureServiceAccount(
    project,
    runtimeAccount,
    'Agent Runtime Service Principal',
  )
  const roles = rc.runtimeAccountRoles
  if (roles?.length) {
    await grantRoles(project, runtimeAccount, roles)
  }

  if (workerAccount && workerAccount !== runtimeAccount) {
    await ensureServiceAccount(
      project,
      workerAccount,
      'Agent Worker Service Principal',
    )
    const workerRoles = rc.workerAccountRoles || []
    if (workerRoles.length) {
      await grantRoles(project, workerAccount, workerRoles)
    }
  }
}

async function loadSecrets(): Promise<Record<string, string>> {
  const secretMap = rc.secrets
  if (!secretMap || Object.keys(secretMap).length === 0) return {}

  const dir = defaultSettingsDir()
  const path = join(dir, 'secrets.jsonc')
  let fileValues: Record<string, string> = {}

  if (await exists(path)) {
    try {
      const raw = await Deno.readTextFile(path)
      fileValues = (parseJsonc(raw) as Record<string, string>) || {}
    } catch {
      logger.warn(`Could not read ${path}, using env vars only.`)
    }
  }

  const resolved: Record<string, string> = {}
  for (const [secretName, envVar] of Object.entries(secretMap)) {
    const value = Deno.env.get(envVar) || fileValues[envVar]
    if (value) resolved[secretName] = value
  }

  if (!resolved['ar-session-secret'] && secretMap['ar-session-secret']) {
    const buf = new Uint8Array(32)
    crypto.getRandomValues(buf)
    const generated = btoa(String.fromCharCode(...buf))
    resolved['ar-session-secret'] = generated
    terminal.info('Generated AR_SESSION_SECRET (none was set).')

    if (await exists(path)) {
      try {
        const raw = await Deno.readTextFile(path)
        const updated = raw.replace(
          /("AR_SESSION_SECRET"\s*:\s*)"[^"]*"/,
          `$1"${generated}"`,
        )
        if (updated !== raw) {
          await Deno.writeTextFile(path, updated)
          terminal.step(`Saved to ${path}`)
        }
      } catch { /* best-effort persist */ }
    }
  }

  return resolved
}

async function syncSecrets(
  secrets: Record<string, string>,
  project: string,
  region: string,
  runtimeAccount: string,
  workerAccount?: string,
): Promise<void> {
  const entries = Object.entries(secrets)
  if (entries.length === 0) return

  terminal.info(
    `Syncing ${entries.length} secret(s) to Secret Manager...`,
  )
  for (const [name, value] of entries) {
    const check = await gcloud([
      'secrets',
      'describe',
      name,
      `--project=${project}`,
    ])

    if (!check.ok) {
      await exec([
        'secrets',
        'create',
        name,
        `--project=${project}`,
        '--replication-policy=user-managed',
        `--locations=${region}`,
      ])
    }

    const addResult = await gcloudWrite([
      'secrets',
      'versions',
      'add',
      name,
      `--project=${project}`,
      '--data-file=-',
    ], value)
    if (!addResult.ok) {
      throw new Error(
        `Failed to set secret '${name}': ${addResult.stderr}`,
      )
    }

    await gcloud([
      'secrets',
      'add-iam-policy-binding',
      name,
      `--project=${project}`,
      `--member=serviceAccount:${runtimeAccount}`,
      '--role=roles/secretmanager.secretAccessor',
    ])

    if (workerAccount && workerAccount !== runtimeAccount) {
      await gcloud([
        'secrets',
        'add-iam-policy-binding',
        name,
        `--project=${project}`,
        `--member=serviceAccount:${workerAccount}`,
        '--role=roles/secretmanager.secretAccessor',
      ])
    }

    terminal.step(name)
  }
}

async function checkExistingService(
  project: string,
  region: string,
): Promise<boolean> {
  const result = await gcloud([
    'run',
    'services',
    'describe',
    SERVICE_NAME,
    `--project=${project}`,
    `--region=${region}`,
    '--format=value(status.url)',
  ])
  return result.ok && !!result.stdout
}

async function buildBaseImage(reg: GcpSettings): Promise<void> {
  const repo = rc.agents?.artifactRepo || 'ar-agents'
  const tag =
    `${reg.region}-docker.pkg.dev/${reg.project}/${repo}/base:${rc.version}`

  const spin = spinner('Preparing Artifact Registry...')

  const descResult = await gcloud([
    'artifacts',
    'repositories',
    'describe',
    repo,
    `--project=${reg.project}`,
    `--location=${reg.region}`,
  ])

  if (!descResult.ok) {
    spin.update(`Creating Artifact Registry repo '${repo}'...`)
    await exec([
      'artifacts',
      'repositories',
      'create',
      repo,
      `--repository-format=docker`,
      `--location=${reg.region}`,
      `--project=${reg.project}`,
    ])
  }

  spin.update('Building base agent image...')

  const hasDocker = await (async () => {
    try {
      const cmd = new Deno.Command('docker', {
        args: ['version'],
        stdout: 'piped',
        stderr: 'piped',
      })
      return (await cmd.output()).success
    } catch {
      return false
    }
  })()

  const repoRoot = configDir()
  const dockerfile = join(repoRoot, 'Dockerfile.agent-base')

  if (hasDocker) {
    const build = new Deno.Command('docker', {
      args: [
        'build',
        '-f',
        dockerfile,
        '-t',
        tag,
        repoRoot,
      ],
      stdout: 'piped',
      stderr: 'piped',
    })
    const buildOut = await build.output()
    if (!buildOut.success) {
      const stderr = new TextDecoder().decode(buildOut.stderr)
      spin.fail(`Base image build failed: ${stderr.slice(0, 200)}`)
      return
    }

    spin.update('Pushing base agent image...')
    const push = new Deno.Command('docker', {
      args: ['push', tag],
      stdout: 'piped',
      stderr: 'piped',
    })
    const pushOut = await push.output()
    if (!pushOut.success) {
      const stderr = new TextDecoder().decode(pushOut.stderr)
      spin.fail(`Image push failed: ${stderr.slice(0, 200)}`)
      return
    }
  } else {
    spin.update(
      'Docker not available. Submitting to Cloud Build...',
    )
    const tmpBuild = await Deno.makeTempDir({ prefix: 'ar-base-' })
    await Deno.copyFile(dockerfile, join(tmpBuild, 'Dockerfile'))
    const sdkBin = join(repoRoot, 'sdk-agent-nodejs', 'bin')
    const toolsSrc = join(repoRoot, 'default-registry', 'tools')
    const serverSrc = join(repoRoot, 'sdk-agent-nodejs', 'agent-host.js')
    const cpDest = async (src: string, dest: string) => {
      await Deno.mkdir(dest, { recursive: true })
      for await (const e of Deno.readDir(src)) {
        const s = join(src, e.name)
        const d = join(dest, e.name)
        if (e.isDirectory) await cpDest(s, d)
        else await Deno.copyFile(s, d)
      }
    }
    await cpDest(sdkBin, join(tmpBuild, 'sdk-agent-nodejs', 'bin'))
    await cpDest(
      toolsSrc,
      join(
        tmpBuild,
        'default-registry',
        'tools',
      ),
    )
    await Deno.mkdir(join(tmpBuild, 'sdk-agent-nodejs'), { recursive: true })
    await Deno.copyFile(
      serverSrc,
      join(tmpBuild, 'sdk-agent-nodejs', 'agent-host.js'),
    )

    try {
      await exec(
        [
          'builds',
          'submit',
          tmpBuild,
          '--tag',
          tag,
          `--project=${reg.project}`,
          `--region=${reg.region}`,
        ],
        600_000,
      )
    } finally {
      await Deno.remove(tmpBuild, { recursive: true }).catch(
        () => {},
      )
    }
  }

  spin.succeed(`Base image built: ${tag}`)
}

async function syncRegistry(controlPlaneUrl: string): Promise<void> {
  let registry: string
  try {
    registry = registryDir()
  } catch {
    return
  }

  const types = ['tools', 'skills', 'rules', 'agents']
  const slugs: { type: string; slug: string }[] = []

  for (const type of types) {
    const base = join(registry, type)
    try {
      for await (const entry of Deno.readDir(base)) {
        if (entry.isDirectory) {
          slugs.push({ type: type.replace(/s$/, ''), slug: entry.name })
        }
      }
    } catch {
      // directory doesn't exist
    }
  }

  if (slugs.length === 0) return

  const tenants = rc.tenants.bootstrapped
  const total = slugs.length * tenants.length
  const spin = spinner(
    `Syncing ${slugs.length} registry item(s)` +
      ` to ${tenants.length} tenant(s)...`,
  )

  async function getToken(): Promise<string> {
    try {
      const res = await fetch(
        'http://metadata.google.internal/computeMetadata/v1/' +
          'instance/service-accounts/default/identity?audience=' +
          encodeURIComponent(controlPlaneUrl),
        { headers: { 'Metadata-Flavor': 'Google' } },
      )
      if (res.ok) return await res.text()
    } catch { /* not on GCP */ }

    for (
      const args of [
        [
          'auth',
          'print-identity-token',
          `--audiences=${controlPlaneUrl}`,
        ],
        ['auth', 'print-identity-token'],
      ]
    ) {
      const cmd = new Deno.Command('gcloud', {
        args,
        stdout: 'piped',
        stderr: 'piped',
      })
      const out = await cmd.output()
      if (out.success) {
        return new TextDecoder().decode(out.stdout).trim()
      }
    }
    throw new Error('Failed to get identity token')
  }

  async function cpFetch(
    path: string,
    opts?: {
      method?: string
      body?: unknown
      rawBody?: Uint8Array
      tenant?: string
    },
  ): Promise<Response> {
    const token = await getToken()
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
    }
    if (opts?.tenant) {
      headers['X-Tenant'] = opts.tenant
    }

    const init: RequestInit = {
      method: opts?.method || 'GET',
      headers,
    }

    if (opts?.rawBody) {
      headers['Content-Type'] = 'application/octet-stream'
      init.body = opts.rawBody as unknown as BodyInit
    } else if (opts?.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(opts.body)
    }

    return await fetch(`${controlPlaneUrl}${path}`, init)
  }

  const { compress } = await import('../utils/archive.ts')

  const MAX_CONSECUTIVE_FAILURES = 3
  let succeeded = 0
  let consecutive = 0

  for (const tenant of tenants) {
    for (const { type, slug } of slugs) {
      spin.update(
        `[${tenant}] ${type} '${slug}' (${succeeded}/${total})...`,
      )
      try {
        if (type === 'agent') {
          const agentBase = join(registry, 'agents', slug)
          let version = '0.0.1'
          try {
            for await (const e of Deno.readDir(agentBase)) {
              if (e.isDirectory && /^\d+\.\d+\.\d+/.test(e.name)) {
                version = e.name
              }
            }
          } catch { /* no version dirs */ }

          const sourceDir = join(agentBase, version)
          const manifestPath = join(sourceDir, 'agent.json')
          let manifest: Record<string, unknown> = {}
          try {
            manifest = JSON.parse(
              await Deno.readTextFile(manifestPath),
            )
          } catch { /* no manifest */ }

          await cpFetch(`/agents`, {
            method: 'POST',
            body: {
              name: (manifest.name as string) || slug,
              slug,
              version: (manifest.version as string) || version,
              subsystem: (manifest.subsystem as string) || undefined,
              sourceType: (manifest.sourceType as string) || undefined,
              visibility: 'public',
            },
            tenant,
          })
          if (await exists(sourceDir)) {
            const archive = await compress(sourceDir)
            await cpFetch(`/agents/${slug}/source`, {
              method: 'POST',
              rawBody: archive,
              tenant,
            })
            await cpFetch(`/agents/${slug}/deploy`, {
              method: 'POST',
              tenant,
            })
          }
        } else {
          const manifestPath = join(
            registry,
            `${type}s`,
            slug,
            `${type}.json`,
          )
          let manifest: Record<string, unknown> = {}
          try {
            manifest = JSON.parse(
              await Deno.readTextFile(manifestPath),
            )
          } catch { /* no manifest */ }

          await cpFetch(`/${type}s`, {
            method: 'POST',
            body: {
              name: (manifest.name as string) || slug,
              slug,
              visibility: 'public',
              ...manifest,
            },
            tenant,
          })
        }

        succeeded++
        consecutive = 0
      } catch (err) {
        consecutive++
        const msg = err instanceof Error ? err.message : String(err)
        logger.warn(`[${tenant}] ${type} '${slug}': ${msg}`)
        if (consecutive >= MAX_CONSECUTIVE_FAILURES) {
          spin.fail(
            `Aborted after ${consecutive} consecutive failures.` +
              ` Last: ${msg}`,
          )
          return
        }
      }
    }
  }

  if (succeeded > 0) {
    spin.succeed(
      `Synced ${succeeded}/${total} registry item(s).`,
    )
  } else {
    spin.fail(`All ${total} registry item(s) failed to sync.`)
  }
}

async function deploy(): Promise<void> {
  const session = await createSession()
  terminal.info(`Authenticated as ${session.account}`)

  const reg = await ensureSettings()

  const serviceExists = await checkExistingService(
    reg.project,
    reg.region,
  )
  if (serviceExists) {
    terminal.info(
      `Control plane '${SERVICE_NAME}' already exists in` +
        ` project '${reg.project}'.`,
    )
    if (
      !await confirm(
        'Update and restart control plane?' +
          ' (Secrets, data, and IAM are preserved.)',
      )
    ) {
      terminal.info('Aborted.')
      return
    }
  }

  terminal.blank()
  terminal.keyValue([
    ['Project', reg.project],
    ['Region', reg.region],
    ['Runtime account', reg.runtimeAccount],
    ['Worker account', reg.workerAccount || reg.runtimeAccount],
    ['Service name', SERVICE_NAME],
  ])
  terminal.blank()

  if (!await confirm('Deploy control plane with these settings?')) {
    terminal.info('Aborted.')
    return
  }

  let deployMode: AgentDeployMode = reg.agentDeployMode || 'container'
  const envMode = Deno.env.get('AR_AGENT_DEPLOY_MODE') as
    | AgentDeployMode
    | undefined
  if (envMode) {
    deployMode = envMode
  } else if (!reg.agentDeployMode) {
    deployMode = await select<AgentDeployMode>(
      'Agent deploy mode',
      [
        {
          label: 'Container (recommended)',
          value: 'container',
          description: 'Cloud Run via Artifact Registry. ~10s deploys.',
        },
        {
          label: 'Source',
          value: 'source',
          description: 'Cloud Functions via Cloud Build. 2-5 min deploys.',
        },
      ],
    )
    await save({ agentDeployMode: deployMode })
  }

  await checkApis(reg.project)
  await ensureRoles(reg.project, reg.runtimeAccount, reg.workerAccount)

  const registryBucket = `${reg.project}-ar-registry`
  if (!await bucketExists(registryBucket)) {
    terminal.info('Creating registry bucket...')
    await exec([
      'storage',
      'buckets',
      'create',
      `gs://${registryBucket}`,
      `--project=${reg.project}`,
      `--location=${reg.region}`,
    ])
  }

  const secrets = await loadSecrets()
  const secretCount = Object.keys(secrets).length
  if (
    secretCount > 0 &&
    await confirm(`Sync ${secretCount} secret(s) to Secret Manager?`)
  ) {
    await syncSecrets(
      secrets,
      reg.project,
      reg.region,
      reg.runtimeAccount,
      reg.workerAccount,
    )
  }

  const spin = spinner('Preparing control plane for deployment...')
  const staging = await prepareStagingDir()

  spin.update(`Deploying to Cloud Run as '${SERVICE_NAME}'...`)

  const cp = rc.controlPlane

  const git = async (args: string[]): Promise<string> => {
    try {
      const p = new Deno.Command('git', {
        args,
        stdout: 'piped',
        stderr: 'piped',
      })
      const o = await p.output()
      return o.success ? new TextDecoder().decode(o.stdout).trim() : ''
    } catch {
      return ''
    }
  }

  const [commit, branch, author] = await Promise.all([
    git(['rev-parse', '--short', 'HEAD']),
    git(['rev-parse', '--abbrev-ref', 'HEAD']),
    git(['log', '-1', '--format=%an']),
  ])

  const envMap: Record<string, string> = {
    AR_MODE: 'server',
    AR_DB_PATH: cp.dbPath,
    GCP_PROJECT: reg.project,
    GCP_REGION: reg.region,
    AR_RUNTIME_ACCOUNT: reg.runtimeAccount,
    AR_WORKER_ACCOUNT: reg.workerAccount || reg.runtimeAccount,
    AR_BUILD_VERSION: BUILD_VERSION,
    AR_BUILD_COMMIT: commit || 'unknown',
    AR_BUILD_BRANCH: branch || 'unknown',
    AR_BUILD_AUTHOR: author || 'unknown',
    AR_BUILD_DATE: new Date().toISOString(),
  }
  if (reg.vpcConnector) {
    envMap.GCP_VPC_CONNECTOR = reg.vpcConnector
  }
  for (const [secretName, envVar] of Object.entries(rc.secrets)) {
    const value = secrets[secretName]
    if (value) {
      envMap[envVar] = value
      if (envVar === 'SLACK_CLIENT_ID') {
        envMap['AR_BOT_SLACK_CLIENT_ID'] = value
      }
      if (envVar === 'SLACK_CLIENT_SECRET') {
        envMap['AR_BOT_SLACK_CLIENT_SECRET'] = value
      }
    }
  }

  const envFilePath = join(staging, 'env.yaml')
  await Deno.writeTextFile(
    envFilePath,
    Object.entries(envMap)
      .map(([k, v]) => `${k}: '${v.replace(/'/g, "''")}'`)
      .join('\n') + '\n',
  )

  const deployArgs = [
    'run',
    'deploy',
    SERVICE_NAME,
    `--source=${staging}`,
    `--project=${reg.project}`,
    `--region=${reg.region}`,
    '--platform=managed',
    '--allow-unauthenticated',
    `--service-account=${reg.runtimeAccount}`,
    `--env-vars-file=${envFilePath}`,
    '--execution-environment=gen2',
    `--port=${cp.port}`,
    `--memory=${cp.memory}`,
    `--cpu=${cp.cpu}`,
    `--timeout=${cp.timeout}`,
    `--concurrency=${cp.concurrency}`,
    `--min-instances=${cp.minInstances}`,
    `--max-instances=${cp.maxInstances}`,
    cp.sessionAffinity ? '--session-affinity' : '--no-session-affinity',
    cp.startupCpuBoost ? '--cpu-boost' : '--no-cpu-boost',
    cp.cpuThrottling ? '--cpu-throttling' : '--no-cpu-throttling',
  ]

  try {
    await exec(deployArgs, 300_000)

    spin.update('Fetching service URL...')
    const url = await exec([
      'run',
      'services',
      'describe',
      SERVICE_NAME,
      `--project=${reg.project}`,
      `--region=${reg.region}`,
      '--format=value(status.url)',
    ])

    if (!url) {
      spin.fail('Deploy succeeded but could not retrieve URL.')
      throw new Error(
        'Deploy succeeded but could not retrieve service URL.',
      )
    }

    spin.succeed(`Control plane deployed at: ${url}`)

    spin.update('Setting AR_AUDIENCE...')
    await gcloud([
      'run',
      'services',
      'update',
      SERVICE_NAME,
      `--project=${reg.project}`,
      `--region=${reg.region}`,
      `--update-env-vars=AR_AUDIENCE=${url}`,
    ])

    const previousUrl = reg.controlPlaneUrl
    await save({ controlPlaneUrl: url })

    terminal.success('Settings updated. Mode is now [remote].')
    terminal.info(
      `All subsequent commands will route through ${url}`,
    )

    if (deployMode === 'container') {
      await buildBaseImage(reg)
    }

    terminal.blank()
    if (
      await confirm(
        'Deploy default registry (agents, tools, skills, rules)?' +
          ' This builds and launches all agents.',
      )
    ) {
      await syncRegistry(url)
    } else {
      terminal.hint(
        'Skipped. You can sync later with: ar cp sync',
      )
    }

    if (previousUrl && previousUrl !== url) {
      terminal.blank()
      terminal.info(
        'Control plane URL changed from:',
      )
      terminal.info(`  ${previousUrl}`)
      terminal.info('to:')
      terminal.info(`  ${url}`)
      terminal.blank()
      terminal.info(
        'If the Slack bot is enabled, run `ar bot enable` to ' +
          'update the Slack app manifest with the new URL.',
      )
      terminal.info(
        'The Slack Event Subscriptions, Interactivity, and ' +
          'OAuth Redirect URLs must point to the new URL.',
      )
    }
  } catch (err) {
    spin.fail('Deployment failed.')
    throw err
  } finally {
    await Deno.remove(staging, { recursive: true }).catch(() => {})
  }
}

async function destroy(opts: DestroyOptions): Promise<void> {
  if (opts.all) return await destroyAll(opts)

  const session = await createSession()
  terminal.info(`Authenticated as ${session.account}`)
  const reg = await loadGcp()

  if (!reg.project) {
    throw new Error(
      'No project configured in settings.' +
        ' Run `ar init` first.',
    )
  }

  if (
    !opts.force &&
    !await confirm(
      `Destroy control plane '${SERVICE_NAME}' in project` +
        ` '${reg.project}' and reset to local mode?`,
    )
  ) {
    terminal.info('Aborted.')
    return
  }

  const check = await gcloud([
    'run',
    'services',
    'describe',
    SERVICE_NAME,
    `--project=${reg.project}`,
    `--region=${reg.region}`,
    '--format=value(status.url)',
  ])
  if (!check.ok) {
    throw new Error(
      `Control plane service '${SERVICE_NAME}' not found` +
        ` in project '${reg.project}' region '${reg.region}'.`,
    )
  }

  const spin = spinner(
    `Deleting Cloud Run service '${SERVICE_NAME}'...`,
  )

  try {
    await exec([
      'run',
      'services',
      'delete',
      SERVICE_NAME,
      `--project=${reg.project}`,
      `--region=${reg.region}`,
      '--quiet',
    ])

    spin.succeed('Service deleted.')
  } catch (err) {
    spin.fail('Failed to delete service.')
    throw err
  }

  if (reg.controlPlaneUrl) {
    await save({ controlPlaneUrl: null })
    terminal.success('Settings reset to [local] mode.')
  }
}

async function listFunctions(
  project: string,
  region: string,
  runtimeAccount: string,
  workerAccount?: string,
): Promise<string[]> {
  const result = await gcloud([
    'functions',
    'list',
    `--project=${project}`,
    `--region=${region}`,
    '--gen2',
    '--format=json(name,serviceConfig.serviceAccountEmail)',
  ])
  if (!result.ok || !result.stdout) return []
  try {
    const accounts = new Set([runtimeAccount])
    if (workerAccount) accounts.add(workerAccount)
    const fns = JSON.parse(result.stdout) as {
      name: string
      serviceConfig?: { serviceAccountEmail?: string }
    }[]
    return fns
      .filter(
        (f) =>
          f.serviceConfig?.serviceAccountEmail != null &&
          accounts.has(f.serviceConfig.serviceAccountEmail),
      )
      .map((f) => f.name.split('/').pop()!)
  } catch {
    return []
  }
}

async function listSchedulerJobs(
  project: string,
  region: string,
  functions: string[],
): Promise<string[]> {
  const result = await gcloud([
    'scheduler',
    'jobs',
    'list',
    `--project=${project}`,
    `--location=${region}`,
    '--format=value(name)',
  ])
  if (!result.ok || !result.stdout) return []
  const all = result.stdout.split('\n')
    .map((n) => n.trim().split('/').pop()!)
    .filter(Boolean)
  return all.filter((name) =>
    functions.some(
      (fn) => name === fn || name.startsWith(`${fn}-`),
    )
  )
}

async function listEventarcTriggers(
  project: string,
  region: string,
  functions: string[],
): Promise<string[]> {
  const result = await gcloud([
    'eventarc',
    'triggers',
    'list',
    `--project=${project}`,
    `--location=${region}`,
    '--format=value(name)',
  ])
  if (!result.ok || !result.stdout) return []
  const all = result.stdout.split('\n')
    .map((n) => n.trim().split('/').pop()!)
    .filter(Boolean)
  return all.filter((name) =>
    functions.some(
      (fn) => name === fn || name.startsWith(`${fn}-`),
    )
  )
}

async function listManagedSecrets(
  project: string,
  functions: string[],
): Promise<string[]> {
  const configNames = new Set(Object.keys(rc.secrets || {}))
  const agentPrefixes = functions.map((fn) => `${fn}--`)

  const result = await gcloud([
    'secrets',
    'list',
    `--project=${project}`,
    '--format=value(name)',
  ])
  if (!result.ok || !result.stdout) return []

  return result.stdout.split('\n').map((n) => n.trim()).filter(
    (name) => {
      if (!name) return false
      if (configNames.has(name)) return true
      if (agentPrefixes.some((p) => name.startsWith(p))) {
        return true
      }
      return false
    },
  )
}

async function bucketExists(bucket: string): Promise<boolean> {
  const result = await gcloud([
    'storage',
    'buckets',
    'describe',
    `gs://${bucket}`,
  ])
  return result.ok
}

async function revokeRoles(
  project: string,
  account: string,
  roles: string[],
): Promise<void> {
  if (!roles.length) return

  const result = await gcloud([
    'projects',
    'get-iam-policy',
    project,
    '--flatten=bindings[].members',
    `--filter=bindings.members:serviceAccount:${account}`,
    '--format=value(bindings.role)',
  ])
  if (!result.ok) return

  const bound = new Set(
    result.stdout.split('\n').map((r) => r.trim())
      .filter(Boolean),
  )
  const toRemove = roles.filter((r) => bound.has(r))

  for (const role of toRemove) {
    await gcloud([
      'projects',
      'remove-iam-policy-binding',
      project,
      `--member=serviceAccount:${account}`,
      `--role=${role}`,
      '--condition=None',
      '--format=none',
    ])
    terminal.step(`Revoked ${role} from ${account}`)
  }
}

async function removeIamRoles(
  project: string,
  runtimeAccount: string,
  workerAccount?: string,
): Promise<void> {
  await revokeRoles(
    project,
    runtimeAccount,
    rc.runtimeAccountRoles || [],
  )
  if (workerAccount && workerAccount !== runtimeAccount) {
    await revokeRoles(
      project,
      workerAccount,
      rc.workerAccountRoles || [],
    )
  }
}

async function listDemoServices(
  project: string,
  region: string,
): Promise<string[]> {
  const result = await gcloud([
    'run',
    'services',
    'list',
    `--project=${project}`,
    `--region=${region}`,
    '--format=value(metadata.name)',
    '--filter=metadata.name~^demo-',
  ])
  if (!result.ok || !result.stdout) return []
  return result.stdout.split('\n')
    .map((n) => n.trim())
    .filter(Boolean)
}

async function scaleService(
  project: string,
  region: string,
  service: string,
  min: number,
  max: number,
): Promise<boolean> {
  const result = await gcloud([
    'run',
    'services',
    'update',
    service,
    `--project=${project}`,
    `--region=${region}`,
    `--min-instances=${min}`,
    `--max-instances=${max}`,
    '--quiet',
  ])
  return result.ok
}

async function destroyAll(opts: DestroyOptions): Promise<void> {
  const session = await createSession()
  terminal.info(`Authenticated as ${session.account}`)
  const reg = await loadGcp()

  if (!reg.project) {
    throw new Error(
      'No project configured in settings.' +
        ' Run `ar init` first.',
    )
  }

  terminal.blank()
  terminal.info('Discovering Agent Runtime resources...')

  const functions = await listFunctions(
    reg.project,
    reg.region,
    reg.runtimeAccount,
    reg.workerAccount,
  )
  const jobs = await listSchedulerJobs(
    reg.project,
    reg.region,
    functions,
  )
  const triggers = await listEventarcTriggers(
    reg.project,
    reg.region,
    functions,
  )
  const secrets = opts.keepSecrets
    ? []
    : await listManagedSecrets(reg.project, functions)
  const demos = await listDemoServices(reg.project, reg.region)
  const bucket = `${reg.project}-ar-registry`
  const hasBucket = await bucketExists(bucket)
  const hasCp = await checkExistingService(
    reg.project,
    reg.region,
  )

  terminal.blank()
  terminal.heading('Resources to destroy')
  terminal.keyValue([
    [
      'Cloud Functions',
      `${functions.length}` +
      (functions.length ? ` (${functions.join(', ')})` : ''),
    ],
    [
      'Scheduler jobs',
      `${jobs.length}` +
      (jobs.length ? ` (${jobs.join(', ')})` : ''),
    ],
    [
      'Eventarc triggers',
      `${triggers.length}` +
      (triggers.length ? ` (${triggers.join(', ')})` : ''),
    ],
    [
      'Secrets',
      opts.keepSecrets ? '(skipped: --keep-secrets)' : `${secrets.length}` +
        (secrets.length ? ` (${secrets.join(', ')})` : ''),
    ],
    [
      'Demo services',
      `${demos.length}` +
      (demos.length ? ` (${demos.join(', ')})` : ''),
    ],
    [
      'GCS bucket',
      hasBucket ? bucket : '(none)',
    ],
    [
      'Control plane',
      hasCp ? SERVICE_NAME : '(none)',
    ],
    [
      'IAM roles',
      opts.keepIam
        ? '(skipped: --keep-iam)'
        : `${rc.runtimeAccountRoles?.length || 0}` +
          ` on ${reg.runtimeAccount}`,
    ],
  ])
  terminal.blank()

  if (
    !opts.force &&
    !await confirm(
      'Destroy ALL Agent Runtime resources?' +
        ' This cannot be undone.',
    )
  ) {
    terminal.info('Aborted.')
    return
  }

  const spin = spinner('Destroying resources...')

  if (hasCp) {
    spin.update(
      `Scaling '${SERVICE_NAME}' to 0 instances...`,
    )
    await scaleService(
      reg.project,
      reg.region,
      SERVICE_NAME,
      0,
      0,
    )
  }

  for (const name of jobs) {
    spin.update(`Deleting scheduler job '${name}'...`)
    await gcloud([
      'scheduler',
      'jobs',
      'delete',
      name,
      `--project=${reg.project}`,
      `--location=${reg.region}`,
      '--quiet',
    ])
  }

  for (const name of triggers) {
    spin.update(`Deleting eventarc trigger '${name}'...`)
    await gcloud([
      'eventarc',
      'triggers',
      'delete',
      name,
      `--project=${reg.project}`,
      `--location=${reg.region}`,
      '--quiet',
    ])
  }

  for (const name of functions) {
    spin.update(`Deleting function '${name}'...`)
    await gcloud([
      'functions',
      'delete',
      name,
      `--project=${reg.project}`,
      `--region=${reg.region}`,
      '--gen2',
      '--quiet',
    ])
  }

  for (const name of demos) {
    spin.update(`Deleting demo service '${name}'...`)
    await gcloud([
      'run',
      'services',
      'delete',
      name,
      `--project=${reg.project}`,
      `--region=${reg.region}`,
      '--quiet',
    ])
  }

  if (!opts.keepSecrets) {
    for (const name of secrets) {
      spin.update(`Deleting secret '${name}'...`)
      await gcloud([
        'secrets',
        'delete',
        name,
        `--project=${reg.project}`,
        '--quiet',
      ])
    }
  }

  if (hasBucket) {
    spin.update(`Deleting bucket 'gs://${bucket}'...`)
    await gcloud([
      'storage',
      'rm',
      '-r',
      `gs://${bucket}`,
    ])
  }

  if (hasCp) {
    spin.update(
      `Deleting Cloud Run service '${SERVICE_NAME}'...`,
    )
    await exec([
      'run',
      'services',
      'delete',
      SERVICE_NAME,
      `--project=${reg.project}`,
      `--region=${reg.region}`,
      '--quiet',
    ])
  }

  if (!opts.keepIam) {
    spin.update('Revoking IAM roles...')
    await removeIamRoles(
      reg.project,
      reg.runtimeAccount,
      reg.workerAccount,
    )
  }

  if (hasCp && reg.controlPlaneUrl) {
    spin.update('Verifying control plane is gone...')
    try {
      const res = await fetch(`${reg.controlPlaneUrl}/health`)
      if (res.ok) {
        spin.stop()
        logger.warn(
          'Control plane still responding. It may take a' +
            ' moment to fully shut down.',
        )
      } else {
        spin.succeed('Resources destroyed.')
      }
    } catch {
      spin.stop()
      terminal.step('Confirmed: control plane is unreachable.')
    }
  } else {
    spin.succeed('Resources destroyed.')
  }

  await save({ controlPlaneUrl: null })
  terminal.blank()
  terminal.success(
    'All Agent Runtime resources destroyed.' +
      ' Settings reset to [local] mode.',
  )
}

async function reset(opts: ResetOptions): Promise<void> {
  const session = await createSession()
  terminal.info(`Authenticated as ${session.account}`)
  const reg = await loadGcp()

  if (!reg.controlPlaneUrl) {
    throw new Error(
      'No control plane URL configured.' +
        ' Reset requires a running control plane.' +
        ' Run `ar cp deploy` first.',
    )
  }

  const tenants = opts.all
    ? rc.tenants.bootstrapped
    : [opts.tenant || rc.tenants.default || 'development']

  const label = opts.all
    ? `all tenants (${tenants.join(', ')})`
    : `tenant '${tenants[0]}'`

  if (
    !opts.force &&
    !await confirm(
      `Reset ${label}? This will delete all tenant data` +
        ' (databases, storage, demos) but keep' +
        ' infrastructure intact.',
    )
  ) {
    terminal.info('Aborted.')
    return
  }

  let token: string
  try {
    token = await session.getIdentityToken(reg.controlPlaneUrl)
  } catch {
    token = await session.getIdentityToken()
  }

  for (const tenantId of tenants) {
    const spin = spinner(
      `Resetting tenant '${tenantId}'...`,
    )
    try {
      const res = await fetch(
        `${reg.controlPlaneUrl}/system/reset`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'X-Tenant': tenantId,
          },
          body: JSON.stringify({ tenantId }),
        },
      )
      if (!res.ok) {
        const body = await res.text()
        spin.fail(`Failed to reset '${tenantId}'.`)
        throw new Error(
          `Reset failed for tenant '${tenantId}':` +
            ` ${res.status} ${body}`,
        )
      }
      const result = await res.json() as {
        demos?: number
        storage?: number
        database?: boolean
      }
      const parts: string[] = []
      if (result.demos) parts.push(`${result.demos} demo(s)`)
      if (result.storage) {
        parts.push(`${result.storage} storage file(s)`)
      }
      if (result.database) parts.push('database')
      spin.succeed(
        `Tenant '${tenantId}' reset` +
          (parts.length ? `: ${parts.join(', ')} cleared` : ''),
      )
    } catch (err) {
      spin.fail(`Failed to reset '${tenantId}'.`)
      throw err
    }
  }

  terminal.blank()
  terminal.success(`Reset complete for ${label}.`)
}

const commandRouteDefinition: CommandRouteDefinition = {
  name: 'control-plane',
  command: command,
  description: 'Deploy, destroy, sync, or reset the control plane',
  options: {
    boolean: [
      'force',
      'all',
      'keep-secrets',
      'keep-iam',
    ],
    string: ['registry', 'tenant'],
    alias: { r: 'registry' },
  },
}

async function sync(): Promise<void> {
  const reg = await loadGcp()
  if (!reg.controlPlaneUrl) {
    throw new Error(
      'No control plane URL configured.' +
        " Deploy one with 'ar cp deploy' or connect with" +
        " 'ar connect <url>'.",
    )
  }
  await syncRegistry(reg.controlPlaneUrl)
}

async function command(
  { args }: CommandRouteOptions,
): Promise<void> {
  const subcommand = args._[0] as string | undefined
  const force = args.force as boolean

  switch (subcommand) {
    case 'deploy':
      return await deploy()
    case 'destroy':
      return await destroy({
        force,
        all: args.all as boolean,
        keepSecrets: args['keep-secrets'] as boolean,
        keepIam: args['keep-iam'] as boolean,
      })
    case 'destroy-all':
      logger.warn(
        "'destroy-all' is deprecated. Use 'destroy --all' instead.",
      )
      return await destroy({
        force,
        all: true,
        keepSecrets: args['keep-secrets'] as boolean,
        keepIam: args['keep-iam'] as boolean,
      })
    case 'sync':
      return await sync()
    case 'reset':
      return await reset({
        force,
        tenant: args.tenant as string | undefined,
        all: args.all as boolean,
      })
    default:
      throw new Error(
        'Usage: ar control-plane <deploy|destroy|sync|reset>.' +
          " Run 'ar help' for details.",
      )
  }
}

if (import.meta.main) {
  const args = parseArgs(
    Deno.args,
    commandRouteDefinition.options,
  )
  await commandRouteDefinition.command({
    args,
    routes: [commandRouteDefinition],
  })
}

export {
  command,
  commandRouteDefinition,
  deploy,
  destroy,
  destroyAll,
  reset,
  sync,
}
export type { DestroyOptions, ResetOptions }
export default commandRouteDefinition

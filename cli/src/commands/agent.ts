import { parseArgs } from '@std/cli'
import { exists } from '@std/fs'
import { join } from '@std/path'
import type {
  CommandRouteDefinition,
  CommandRouteOptions,
} from '../utils/command-router.ts'
import * as terminal from '../terminal/mod.ts'
import { CliError, confirm, spinner, text } from '../terminal/mod.ts'
import loadConfig from '@ar/client/config'
import platform from '@ar/client/platform'
import { isSubsystem, SUBSYSTEMS } from '@ar/client/subsystems'
import type { Subsystem } from '@ar/client/subsystems'
import {
  agentDir,
  agentDirExists,
  parseAgentRef,
  readAgent,
  resolveAgentDir,
  secretEnvVar,
  validateId,
  writeAgent,
} from '@ar/client/registry'
import { load as loadSettings, loadGcp, save } from '../settings.ts'
import { requireAuth } from '../auth.ts'
import type { AgentManifest, AgentRef } from '@ar/client/registry'
import { resolve as resolveTenant } from '@ar/client/tenant'
import { open } from '@ar/client/db'
import { detect } from '@ar/client/mode'
import {
  create as dbCreateAgent,
  getBySlug,
  switchVersion,
} from '@ar/client/db/agents'
import { compile, compileForDeploy } from '@ar/client/templates'
import { load as loadRuntime } from '@ar/client/runtime'
import { compress } from '../utils/archive.ts'

const config = await loadConfig()

type CreateOptions = {
  input: string
  registry: string
  withSa?: boolean | undefined
  prompt?: boolean | undefined
  subsystem?: string | undefined
}
type DeployOptions = {
  input: string
  registry: string
  public?: boolean | undefined
}
type DestroyOptions = {
  input: string
  registry: string
  force: boolean
  keepSecrets: boolean
}
type RunOptions = {
  input: string
  registry: string
  data?: string | undefined
  inline?: string | undefined
}
type ListOptions = { registry: string }
type LogsOptions = { input: string; registry: string; tail: number }

function refLabel(ref: AgentRef): string {
  return ref.version ? `${ref.id}@${ref.version}` : ref.id
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(
    /^-|-$/g,
    '',
  )
}

async function create(opts: CreateOptions): Promise<void> {
  const ref = parseAgentRef(opts.input)
  validateId(ref.id, 'agent ID')

  const dir = agentDir(opts.registry, ref)
  if (await exists(dir)) {
    throw new CliError(
      `Folder '${
        refLabel(ref)
      }' already exists. Choose a different agent ID or version.`,
    )
  }

  if (opts.prompt && !opts.subsystem) {
    throw new CliError(
      'Prompt-based agents require a subsystem. ' +
        `Use --subsystem <${SUBSYSTEMS.join('|')}>.`,
    )
  }
  if (opts.subsystem && !isSubsystem(opts.subsystem)) {
    throw new CliError(
      `Invalid subsystem '${opts.subsystem}'. ` +
        `Must be one of: ${SUBSYSTEMS.join(', ')}.`,
    )
  }
  const subsystem = opts.subsystem as Subsystem | undefined

  await Deno.mkdir(dir, { recursive: true })

  const slug = slugify(ref.id)
  const version = ref.version || '0.0.1'
  const templateId = opts.prompt ? 'agent-prompt' : 'agent-default'
  const ctx: Parameters<typeof compile>[1] = {
    name: ref.id,
    slug,
    version,
  }
  if (subsystem) ctx.subsystem = subsystem
  const files = compile(templateId, ctx)

  for (const [path, content] of Object.entries(files)) {
    await Deno.writeTextFile(join(dir, path), content)
  }

  const manifest: AgentManifest = {
    name: ref.id,
    slug,
    version,
    entryPoint: 'handler',
    secrets: [],
    triggers: [],
  }

  if (opts.prompt) {
    manifest.sourceType = 'prompt'
    if (subsystem) manifest.subsystem = subsystem
  }

  const tenant = resolveTenant()
  const modeInfo = await detect((await loadSettings()).controlPlaneUrl)
  await open(tenant, modeInfo.mode)

  dbCreateAgent({
    tenantId: tenant.id,
    name: ref.id,
    slug,
    version,
    subsystem,
    createdBy: 'cli-user@ar-cli',
  })

  if (opts.withSa) {
    const reg = await loadGcp()
    const accountId = `${ref.id}-fn`
    const email = `${accountId}@${reg.project}.iam.gserviceaccount.com`

    const saExists = await platform.serviceAccountExists(
      reg.project,
      email,
    )
    if (!saExists) {
      await platform.serviceAccountCreate(
        reg.project,
        accountId,
        `Agent SA for ${ref.id}`,
      )
      terminal.success(`Service account created: ${email}`)
    }
    manifest.runtimeAccount = email
  }

  await writeAgent(opts.registry, ref, manifest)

  if (opts.prompt) {
    terminal.success(
      `Prompt agent '${refLabel(ref)}' scaffolded at ${dir}`,
    )
    terminal.hint(
      "Edit prompt.md to define your agent's behavior.",
    )
    terminal.hint(
      'Use {{request.body.field}} dot notation for ' +
        'dynamic request values.',
    )
  } else {
    terminal.success(
      `Agent '${refLabel(ref)}' scaffolded at ${dir}`,
    )
  }
}

async function ensureBootstrapped(_registry: string): Promise<void> {
  const settings = await loadSettings()
  if (settings.project && settings.region && settings.runtimeAccount) {
    return
  }

  terminal.info(
    'No settings found. Setting up for the first time...',
  )

  const rc = loadRuntime()
  const project = await text('GCP Project ID', { flag: 'project' })
  if (!project) throw new CliError('Project ID is required.')

  const defaultRegion = rc.platform.region
  const region = await text('Region', {
    default: defaultRegion,
    flag: 'region',
  })

  const defaultSa = rc.platform.runtimeAccountPattern.replace(
    '${project}',
    project,
  )
  const runtimeAccount = await text('Runtime account', {
    default: defaultSa,
    flag: 'runtime-account',
  })

  await save({ project, region, runtimeAccount })
  terminal.success('Settings saved.')

  const s = await loadSettings()
  const modeInfo = await detect(s.controlPlaneUrl)
  if (modeInfo.mode === 'local') {
    if (await confirm('Deploy the control plane now?')) {
      const { deploy: cpDeploy } = await import('./control-plane.ts')
      await cpDeploy()
    }
  }
}

async function bundleRuntime(
  dir: string,
  _manifest: AgentManifest,
  _reg: { project: string; region: string; runtimeAccount: string },
): Promise<void> {
  const sdkSrc = join(
    Deno.cwd(),
    '..',
    'sdk-agent-nodejs',
    'bin',
    'index.cjs',
  )
  if (!await exists(sdkSrc)) return
  await Deno.copyFile(sdkSrc, join(dir, '_runtime.cjs'))
}

async function bundleTools(
  dir: string,
  registry: string,
): Promise<void> {
  const rc = loadRuntime()
  const toolsDir = join(dir, 'tools')
  await Deno.mkdir(toolsDir, { recursive: true })

  const target = rc.platform.compileTarget || 'x86_64-unknown-linux-gnu'
  const targetOs = target.includes('linux') ? 'linux' : 'darwin'
  const targetArch = target.includes('x86_64') ? 'x64' : 'arm64'

  for (const tool of rc.tools) {
    const toolSrc = join(
      registry,
      'tools',
      tool.slug,
      tool.version,
    )
    const toolDest = join(toolsDir, tool.slug)
    await Deno.mkdir(toolDest, { recursive: true })

    const toolJson = join(toolSrc, 'tool.json')
    if (await exists(toolJson)) {
      await Deno.copyFile(toolJson, join(toolDest, 'tool.json'))
    }

    for (const name of ['tool', 'tool.sh', 'tool.js']) {
      const src = join(toolSrc, name)
      if (await exists(src)) {
        await Deno.copyFile(src, join(toolDest, name))
        await Deno.chmod(join(toolDest, name), 0o755)
      }
    }

    if (!await exists(join(toolDest, 'tool'))) {
      const installSh = join(toolSrc, 'install.sh')
      if (await exists(installSh)) {
        await Deno.copyFile(
          installSh,
          join(toolDest, 'install.sh'),
        )
        await Deno.chmod(join(toolDest, 'install.sh'), 0o755)
        try {
          const cmd = new Deno.Command('sh', {
            args: [join(toolDest, 'install.sh')],
            cwd: toolDest,
            env: {
              ...Deno.env.toObject(),
              TOOLS_DIR: toolDest,
              TARGET_OS: targetOs,
              TARGET_ARCH: targetArch,
            },
            stdout: 'piped',
            stderr: 'piped',
          })
          const out = await cmd.output()
          if (out.code === 0) {
            terminal.step(`Installed tool: ${tool.slug}`)
          } else {
            const stderr = new TextDecoder().decode(out.stderr)
            terminal.warn(`Tool install failed: ${tool.slug}`)
            if (stderr) {
              terminal.warn(`  ${stderr.slice(0, 200)}`)
            }
          }
        } catch {
          terminal.warn(`Tool install skipped: ${tool.slug}`)
        }
      }
    }
  }
}

async function deploy(opts: DeployOptions): Promise<void> {
  const ref = parseAgentRef(opts.input)
  validateId(ref.id, 'agent ID')

  await ensureBootstrapped(opts.registry)

  if (!await agentDirExists(opts.registry, ref)) {
    terminal.info(
      `Agent '${refLabel(ref)}' not found. Creating...`,
    )
    await create({ input: opts.input, registry: opts.registry })
  }

  const manifest = await readAgent(opts.registry, ref)
  const slug = manifest.slug || ref.id
  const version = manifest.version || ref.version || '0.0.1'
  const visibility = opts.public ? 'public' : 'private'

  const tenant = resolveTenant()
  const modeInfo = await detect((await loadSettings()).controlPlaneUrl)
  await open(tenant, modeInfo.mode)

  if (!getBySlug(tenant.id, slug, version)) {
    dbCreateAgent({
      tenantId: tenant.id,
      name: manifest.name || ref.id,
      slug,
      version,
      subsystem: manifest.subsystem,
      sourceType: manifest.sourceType,
      visibility,
      createdBy: 'cli-user@ar-cli',
    })
  }

  const reg = await loadGcp()

  const secrets: Record<string, string> = {}
  for (const s of manifest.secrets) {
    secrets[secretEnvVar(s, ref.id)] = s
  }

  const spin = spinner(`Deploying '${refLabel(ref)}'...`)

  const runtimeAccount = manifest.runtimeAccount || reg.runtimeAccount
  const resolvedDir = await resolveAgentDir(opts.registry, ref)

  if (manifest.sourceType === 'prompt') {
    const promptPath = join(resolvedDir, 'prompt.md')
    if (!await exists(promptPath)) {
      spin.fail('Deploy failed')
      throw new CliError(
        `Prompt file not found at ${promptPath}. ` +
          'Prompt-based agents require a prompt.md file.',
        { suggestion: 'ar agent create --prompt <name>' },
      )
    }
    const subsystem = manifest.subsystem
    if (!subsystem) {
      spin.fail('Deploy failed')
      throw new CliError(
        'Prompt-based agents require a subsystem in ' +
          `agent.json. Set "subsystem" to one of: ${SUBSYSTEMS.join(', ')}.`,
      )
    }
    const userPrompt = await Deno.readTextFile(promptPath)
    const compiled = compileForDeploy(userPrompt, subsystem)
    for (const [file, content] of Object.entries(compiled)) {
      await Deno.writeTextFile(join(resolvedDir, file), content)
    }
    spin.update('Compiling prompt...')
  }

  if (
    manifest.template &&
    !await exists(join(resolvedDir, 'index.js'))
  ) {
    const templateId = `agent-${slug.replace(/-agent$/, '')}`
    const ctx: Parameters<typeof compile>[1] = {
      name: manifest.name || ref.id,
      slug,
      version,
    }
    if (manifest.subsystem) ctx.subsystem = manifest.subsystem
    const files = compile(templateId, ctx)
    for (const [file, content] of Object.entries(files)) {
      await Deno.writeTextFile(join(resolvedDir, file), content)
    }
    spin.update('Compiling template...')
  }

  const deployMode = reg.agentDeployMode || 'container'

  if (reg.controlPlaneUrl) {
    spin.update('Uploading agent source...')
    const archive = await compress(resolvedDir, {
      exclude: ['tools', '_runtime.cjs', 'node_modules'],
    })
    const cpUrl = reg.controlPlaneUrl
    const token = await platform.getIdentityToken(cpUrl)
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
    }

    const sourceRes = await fetch(
      `${cpUrl}/agents/${ref.id}/source`,
      { method: 'POST', headers, body: archive as unknown as BodyInit },
    )
    if (!sourceRes.ok) {
      const text = await sourceRes.text()
      spin.fail('Source upload failed')
      throw new CliError(`Source upload failed: ${text}`)
    }

    spin.update('Deploying...')
    const deployHeaders = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    }
    const deployRes = await fetch(
      `${cpUrl}/agents/${ref.id}/deploy`,
      { method: 'POST', headers: deployHeaders },
    )
    if (!deployRes.ok && deployRes.status !== 202) {
      const text = await deployRes.text()
      spin.fail('Deploy failed')
      throw new CliError(`Deploy failed: ${text}`)
    }

    const deployResult = await deployRes.json() as {
      deployId?: string
      statusUrl?: string
      uri?: string
    }

    if (deployResult.statusUrl) {
      const statusUrl = `${cpUrl}${deployResult.statusUrl}`
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 3000))
        const freshToken = await platform.getIdentityToken(cpUrl)
        const pollRes = await fetch(statusUrl, {
          headers: { 'Authorization': `Bearer ${freshToken}` },
        })
        if (!pollRes.ok) continue
        const status = await pollRes.json() as {
          status: string
          uri?: string
          error?: string
        }
        spin.update(
          `Deploying... (${status.status})`,
        )
        if (status.status === 'done') {
          spin.succeed(`Deployed at ${status.uri}`)
          return
        }
        if (status.status === 'failed') {
          spin.fail('Deploy failed')
          throw new CliError(
            `Deploy failed: ${status.error || 'unknown'}`,
          )
        }
      }
      spin.fail('Deploy timed out')
      throw new CliError('Deploy timed out after 6 minutes')
    }

    const uri = deployResult.uri || ''
    spin.succeed(`Deployed at ${uri}`)
    return
  }

  if (deployMode === 'source') {
    await bundleRuntime(resolvedDir, manifest, reg)
    await bundleTools(resolvedDir, opts.registry)
  }

  const env: Record<string, string> = {}
  if (reg.controlPlaneUrl) {
    env.AR_CONTROL_PLANE_URL = reg.controlPlaneUrl
    env.AR_BUCKET = `${reg.project}-ar-registry`
    const runtime = loadRuntime()
    env.AR_TENANT_ID = runtime.tenants?.default || 'development'
  }

  if (deployMode === 'container') {
    const runtime = loadRuntime()
    const repo = runtime.agents?.artifactRepo || 'ar-agents'
    const image =
      `${reg.region}-docker.pkg.dev/${reg.project}/${repo}/${slug}:${version}`

    const deployOpts = {
      agentId: ref.id,
      region: reg.region,
      project: reg.project,
      image,
      runtimeAccount,
      workerAccount: reg.workerAccount || undefined,
      env,
      fuseBucket: `${reg.project}-ar-registry`,
      memory: manifest.memory,
      cpu: manifest.cpu,
      timeout: manifest.timeout,
    }
    await platform.containerDeploy(deployOpts)
  } else {
    const deployOpts: Parameters<typeof platform.functionDeploy>[0] = {
      agentId: ref.id,
      region: reg.region,
      project: reg.project,
      runtime: reg.runtime,
      entryPoint: manifest.entryPoint,
      runtimeAccount,
      workerAccount: reg.workerAccount || undefined,
      vpcConnector: reg.vpcConnector,
      source: resolvedDir,
      secrets,
      memory: manifest.memory,
      cpu: manifest.cpu,
      timeout: manifest.timeout,
    }
    if (Object.keys(env).length > 0) deployOpts.env = env
    await platform.functionDeploy(deployOpts)
  }

  let uri: string
  if (deployMode === 'container') {
    const descCmd = new Deno.Command('gcloud', {
      args: [
        'run',
        'services',
        'describe',
        ref.id,
        `--region=${reg.region}`,
        `--project=${reg.project}`,
        '--format=value(status.url)',
      ],
      stdout: 'piped',
      stderr: 'piped',
    })
    const descOut = await descCmd.output()
    uri = new TextDecoder().decode(descOut.stdout).trim()
  } else {
    uri = await platform.functionDescribeUri(
      ref.id,
      reg.region,
      reg.project,
    )
  }

  try {
    const bucket = `${reg.project}-ar-registry`
    const gcsPath = `${tenant.id}/agents/${slug}/${version}/source.tar.gz`
    const archive = await compress(resolvedDir)
    await platform.storageUpload(bucket, gcsPath, archive)
  } catch {
    // source archive backup is best-effort
  }

  spin.succeed(`Deployed at ${uri}`)
}

async function destroy(opts: DestroyOptions): Promise<void> {
  const ref = parseAgentRef(opts.input)
  const reg = await loadGcp()
  const deployMode = reg.agentDeployMode || 'container'

  try {
    if (deployMode === 'container') {
      const cmd = new Deno.Command('gcloud', {
        args: [
          'run',
          'services',
          'describe',
          ref.id,
          `--region=${reg.region}`,
          `--project=${reg.project}`,
          '--format=value(status.url)',
        ],
        stdout: 'piped',
        stderr: 'piped',
      })
      const out = await cmd.output()
      if (!out.success) throw new Error('not found')
    } else {
      await platform.functionDescribeState(
        ref.id,
        reg.region,
        reg.project,
      )
    }
  } catch {
    throw new CliError(
      `Agent '${ref.id}' not found in project ` +
        `'${reg.project}'.`,
      { hint: 'Check deployed agents with: ar list' },
    )
  }

  if (
    !opts.force &&
    !await confirm(
      `Destroy agent '${ref.id}' and all its triggers?`,
    )
  ) {
    terminal.info('Aborted.')
    return
  }

  terminal.step(`Deleting triggers for '${ref.id}'...`)

  const jobs = await platform.schedulerList(
    reg.project,
    reg.region,
    `name~${ref.id}`,
  )
  for (const job of jobs) {
    await platform.schedulerDelete(
      job.name,
      reg.region,
      reg.project,
    )
    terminal.step(`Deleted scheduler job: ${job.name}`)
  }

  const triggers = await platform.eventarcList(
    reg.project,
    reg.region,
    `name~${ref.id}`,
  )
  for (const trigger of triggers) {
    await platform.eventarcDelete(
      trigger.name,
      reg.region,
      reg.project,
    )
    terminal.step(`Deleted eventarc trigger: ${trigger.name}`)
  }

  if (deployMode === 'container') {
    terminal.step(`Deleting service '${ref.id}'...`)
    await platform.containerDelete(ref.id, reg.region, reg.project)
    terminal.success('Service deleted')
  } else {
    terminal.step(`Deleting function '${ref.id}'...`)
    await platform.functionDelete(ref.id, reg.region, reg.project)
    terminal.success('Function deleted')
  }

  const secretsList = await platform.secretList(reg.project)
  const agentSecrets = secretsList.filter((s) =>
    s.name.startsWith(`${ref.id}--`)
  )

  if (agentSecrets.length > 0 && !opts.keepSecrets) {
    for (const s of agentSecrets) {
      await platform.secretDelete(s.name, reg.project)
      terminal.step(`Secret '${s.name}' deleted`)
    }
  }
}

async function runInline(opts: RunOptions): Promise<void> {
  const code = opts.inline!
  const id = `ar-inline-${Date.now()}`
  const reg = await loadGcp()
  const dir = agentDir(opts.registry, { id })

  await Deno.mkdir(dir, { recursive: true })

  const handler = `exports.handler = async (req, res) => {
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {})
  const result = await (async () => { ${code} })()
  res.json(result ?? { ok: true })
}
`
  await Deno.writeTextFile(join(dir, 'index.js'), handler)
  await Deno.writeTextFile(
    join(dir, 'agent.json'),
    JSON.stringify({
      name: id,
      slug: id,
      version: '0.0.1',
      entryPoint: 'handler',
      secrets: [],
      triggers: [],
    }) + '\n',
  )

  const spin = spinner(`Deploying inline agent '${id}'...`)
  try {
    await platform.functionDeploy({
      agentId: id,
      region: reg.region,
      project: reg.project,
      runtime: reg.runtime,
      entryPoint: 'handler',
      runtimeAccount: reg.runtimeAccount,
      workerAccount: reg.workerAccount || undefined,
      vpcConnector: reg.vpcConnector,
      source: dir,
      secrets: {},
    })

    const uri = await platform.functionDescribeUri(
      id,
      reg.region,
      reg.project,
    )
    const token = await platform.getIdentityToken(uri)
    const fetchOpts: RequestInit = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: opts.data || '{}',
    }

    spin.update('Invoking...')
    const response = await fetch(uri, fetchOpts)
    const body = await response.text()
    spin.succeed('Invocation complete')
    terminal.print(body)
  } finally {
    terminal.step(`Cleaning up '${id}'...`)
    await platform.functionDelete(id, reg.region, reg.project)
      .catch(() => {})
    await Deno.remove(dir, { recursive: true }).catch(() => {})
  }
}

async function run(opts: RunOptions): Promise<void> {
  if (opts.inline) return await runInline(opts)

  const ref = parseAgentRef(opts.input)
  const reg = await loadGcp()

  try {
    await platform.functionDescribeState(
      ref.id,
      reg.region,
      reg.project,
    )
  } catch {
    throw new CliError(
      `Agent '${ref.id}' is not deployed.`,
      { suggestion: `ar deploy ${refLabel(ref)}` },
    )
  }

  const uri = await platform.functionDescribeUri(
    ref.id,
    reg.region,
    reg.project,
  )

  let token: string
  try {
    token = await platform.getIdentityToken(uri)
  } catch {
    throw new CliError(
      'Not authenticated.',
      { suggestion: 'gcloud auth login' },
    )
  }

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
  }

  const fetchOpts: RequestInit = { headers }

  if (opts.data) {
    fetchOpts.method = 'POST'
    headers['Content-Type'] = 'application/json'
    fetchOpts.body = opts.data
  }

  const response = await fetch(uri, fetchOpts)
  const body = await response.text()
  terminal.print(body)
}

async function list(_opts: ListOptions): Promise<void> {
  const reg = await loadGcp()
  const functions = await platform.functionList(
    reg.project,
    reg.region,
  )

  if (terminal.isJsonMode()) {
    terminal.json(functions)
    return
  }

  if (functions.length === 0) {
    terminal.info('No agents deployed.')
    return
  }

  terminal.table(
    ['AGENT', 'STATE', 'URI'],
    functions.map((f) => [
      f.name,
      f.state || '',
      f.uri || '',
    ]),
  )
}

type ClearResult = {
  message: string
  deleted: { digest: string; tags: string[] }[]
  retained?: { digest: string; tags: string[] }
}

type ArtifactPackage = {
  name: string
  versions: { digest: string; tags: string[] }[]
}

async function cpFetchJson<T>(
  cpUrl: string,
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; data: T }> {
  const token = await platform.getIdentityToken(cpUrl)
  const res = await fetch(`${cpUrl}${path}`, {
    ...init,
    headers: {
      'Authorization': `Bearer ${token}`,
      ...(init?.headers || {}),
    },
  })
  const data = await res.json().catch(() => ({})) as T
  return { ok: res.ok, status: res.status, data }
}

async function clearOneBuild(
  cpUrl: string,
  slug: string,
): Promise<ClearResult> {
  const { ok, data } = await cpFetchJson<
    ClearResult & { error?: string }
  >(
    cpUrl,
    `/api/artifacts/packages/${encodeURIComponent(slug)}/builds`,
    { method: 'DELETE' },
  )
  if (!ok) {
    throw new CliError(
      data.error || 'Failed to clear builds',
    )
  }
  return data
}

async function clearBuilds(
  slug: string | undefined,
  force: boolean,
): Promise<void> {
  const settings = await loadSettings()
  if (!settings.controlPlaneUrl) {
    throw new CliError(
      'clear-builds requires a control plane connection.',
      { suggestion: 'ar connect <url>' },
    )
  }
  const cpUrl = settings.controlPlaneUrl

  if (slug) {
    if (!force) {
      const ok = await confirm(
        `Clear all old builds for '${slug}'? ` +
          'Only the latest deployed version will be kept.',
      )
      if (!ok) {
        terminal.info('Aborted.')
        return
      }
    }

    const spin = spinner(`Clearing builds for '${slug}'...`)
    try {
      const result = await clearOneBuild(cpUrl, slug)
      spin.succeed(result.message)
      if (result.retained) {
        terminal.step(
          `Retained: ${
            result.retained.tags.join(', ') || result.retained.digest
          }`,
        )
      }
      for (const d of result.deleted) {
        terminal.step(
          `Deleted: ${d.tags.join(', ') || d.digest}`,
        )
      }
    } catch (err) {
      spin.fail('Failed to clear builds')
      throw err
    }
    return
  }

  if (!terminal.isInteractive() && !force) {
    throw new CliError(
      'Clearing all builds requires --force in ' +
        'non-interactive mode.',
      {
        suggestion: 'ar agent clear-builds --force',
      },
    )
  }

  const spin = spinner('Fetching artifact packages...')
  const { ok, data: artifacts } = await cpFetchJson<{
    packages?: ArtifactPackage[]
    error?: string
  }>(cpUrl, '/api/artifacts')

  if (!ok) {
    spin.fail('Failed to list artifacts')
    throw new CliError(
      artifacts.error || 'Failed to list artifacts',
    )
  }

  const packages = artifacts.packages || []
  const stale = packages.filter((p) => p.versions.length > 1)

  if (stale.length === 0) {
    spin.succeed('No old builds to clear.')
    return
  }

  const totalStale = stale.reduce(
    (n, p) => n + p.versions.length - 1,
    0,
  )
  spin.succeed(
    `Found ${totalStale} old build(s) across ` +
      `${stale.length} package(s).`,
  )

  for (const pkg of stale) {
    terminal.step(
      `${pkg.name}: ${pkg.versions.length - 1} old ` +
        `build(s) to remove`,
    )
  }

  if (!force) {
    const ok = await confirm(
      `Clear ${totalStale} old build(s) across ` +
        `${stale.length} package(s)?`,
    )
    if (!ok) {
      terminal.info('Aborted.')
      return
    }
  }

  let cleared = 0
  let failed = 0
  for (const pkg of stale) {
    const pkgSpin = spinner(
      `[${cleared + failed + 1}/${stale.length}] ` +
        `Clearing ${pkg.name}...`,
    )
    try {
      const result = await clearOneBuild(cpUrl, pkg.name)
      cleared++
      pkgSpin.succeed(
        `[${cleared + failed}/${stale.length}] ` +
          result.message,
      )
    } catch {
      failed++
      pkgSpin.fail(
        `[${cleared + failed}/${stale.length}] ` +
          `Failed: ${pkg.name}`,
      )
    }
  }

  if (failed > 0) {
    terminal.warn(
      `Done. Cleared ${cleared} package(s), ` +
        `${failed} failed.`,
    )
  } else {
    terminal.success(
      `Cleared old builds from ${cleared} package(s).`,
    )
  }
}

async function logs(opts: LogsOptions): Promise<void> {
  const ref = parseAgentRef(opts.input)
  const reg = await loadGcp()

  const output = await platform.functionLogs(
    ref.id,
    reg.region,
    reg.project,
    opts.tail,
  )

  if (terminal.isJsonMode()) {
    terminal.json({ output })
    return
  }

  terminal.print(output)
}

const AGENT_OPTIONS = {
  boolean: [
    'force',
    'json',
    'follow',
    'keep-secrets',
    'with-sa',
    'public',
    'prompt',
  ],
  string: [
    'registry',
    'data',
    'tail',
    'tenant',
    'inline',
    'subsystem',
  ],
  alias: { r: 'registry', f: 'follow', d: 'data', s: 'subsystem' },
  default: { tail: '50' },
}

function resolveRegistry(
  args: ReturnType<typeof parseArgs>,
): string {
  return (args.registry as string) || config.registry
}

const commandRouteDefinition: CommandRouteDefinition = {
  name: 'agent',
  command: agentCommand,
  description:
    'Manage agents (create, deploy, destroy, run, list, logs, clear-builds)',
  options: AGENT_OPTIONS,
}

async function agentCommand(
  { args }: CommandRouteOptions,
): Promise<void> {
  await requireAuth()
  terminal.setJsonMode(!!args.json)
  const subcommand = args._[0] as string | undefined
  const registry = resolveRegistry(args)

  switch (subcommand) {
    case 'create': {
      const input = args._[1] as string | undefined
      if (!input) {
        throw new CliError('Usage: ar create <id>[@version]')
      }
      return await create({
        input,
        registry,
        withSa: args['with-sa'] as boolean | undefined,
        prompt: args['prompt'] as boolean | undefined,
        subsystem: args['subsystem'] as string | undefined,
      })
    }
    case 'deploy': {
      const input = args._[1] as string | undefined
      if (!input) {
        throw new CliError('Usage: ar deploy <id>[@version]')
      }
      return await deploy({
        input,
        registry,
        public: args.public as boolean | undefined,
      })
    }
    case 'destroy': {
      const input = args._[1] as string | undefined
      if (!input) {
        throw new CliError('Usage: ar destroy <id>')
      }
      return await destroy({
        input,
        registry,
        force: args.force as boolean,
        keepSecrets: args['keep-secrets'] as boolean,
      })
    }
    case 'run': {
      const inlineCode = args.inline as string | undefined
      const input = args._[1] as string | undefined
      if (!input && !inlineCode) {
        throw new CliError(
          'Usage: ar run <id> [--data <json>] or' +
            ' ar run --inline <code>',
        )
      }
      return await run({
        input: input || 'inline',
        registry,
        data: args.data as string | undefined,
        inline: inlineCode,
      })
    }
    case 'list':
      return await list({ registry })
    case 'logs': {
      const input = args._[1] as string | undefined
      if (!input) {
        throw new CliError('Usage: ar logs <id>')
      }
      return await logs({
        input,
        registry,
        tail: parseInt(args.tail as string, 10) || 50,
      })
    }
    case 'clear-builds': {
      return await clearBuilds(
        args._[1] as string | undefined,
        args.force as boolean,
      )
    }
    case 'switch': {
      const slug = args._[1] as string | undefined
      const ver = args._[2] as string | undefined
      if (!slug || !ver) {
        throw new CliError(
          'Usage: ar agent switch <slug> <version>',
        )
      }
      const tenant = resolveTenant()
      const modeInfo = await detect(
        (await loadSettings()).controlPlaneUrl,
      )
      await open(tenant, modeInfo.mode)
      switchVersion(tenant.id, slug, ver)
      terminal.success(
        `Active version for '${slug}' set to ${ver}`,
      )
      return
    }
    default:
      throw new CliError(
        'Usage: ar agent <create|deploy|destroy|run|list|logs' +
          '|clear-builds|switch>. Use --prompt --subsystem' +
          ` <${SUBSYSTEMS.join('|')}> for prompt agents.` +
          " Run 'ar help' for details.",
      )
  }
}

function topLevel(
  name: string,
  description: string,
  handler: (opts: CommandRouteOptions) => Promise<void>,
): CommandRouteDefinition {
  return {
    name,
    command: async (opts: CommandRouteOptions) => {
      await requireAuth()
      terminal.setJsonMode(!!opts.args.json)
      return handler(opts)
    },
    description,
    options: AGENT_OPTIONS,
  }
}

const deployRouteDefinition = topLevel(
  'deploy',
  'Deploy an agent (creates if needed)',
  async ({ args }) => {
    const input = args._[0] as string | undefined
    if (!input) {
      throw new CliError('Usage: ar deploy <id>[@version]')
    }
    await deploy({ input, registry: resolveRegistry(args) })
  },
)

const createRouteDefinition = topLevel(
  'create',
  'Scaffold a new agent (use --prompt --subsystem' +
    ` <${SUBSYSTEMS.join('|')}> for prompt-based)`,
  async ({ args }) => {
    const input = args._[0] as string | undefined
    if (!input) {
      throw new CliError('Usage: ar create <id>[@version]')
    }
    await create({
      input,
      registry: resolveRegistry(args),
      withSa: args['with-sa'] as boolean | undefined,
      prompt: args['prompt'] as boolean | undefined,
      subsystem: args['subsystem'] as string | undefined,
    })
  },
)

const runRouteDefinition = topLevel(
  'run',
  'Invoke a deployed agent',
  async ({ args }) => {
    const inlineCode = args.inline as string | undefined
    const input = args._[0] as string | undefined
    if (!input && !inlineCode) {
      throw new CliError(
        'Usage: ar run <id> [--data <json>] or' +
          ' ar run --inline <code>',
      )
    }
    await run({
      input: input || 'inline',
      registry: resolveRegistry(args),
      data: args.data as string | undefined,
      inline: inlineCode,
    })
  },
)

const logsRouteDefinition = topLevel(
  'logs',
  'Fetch agent logs',
  async ({ args }) => {
    const input = args._[0] as string | undefined
    if (!input) throw new CliError('Usage: ar logs <id>')
    await logs({
      input,
      registry: resolveRegistry(args),
      tail: parseInt(args.tail as string, 10) || 50,
    })
  },
)

const listRouteDefinition = topLevel(
  'list',
  'List deployed agents',
  async ({ args }) => {
    await list({ registry: resolveRegistry(args) })
  },
)

const clearBuildsRouteDefinition = topLevel(
  'clear-builds',
  'Remove old builds, keeping only the latest deployed',
  async ({ args }) => {
    await clearBuilds(
      args._[0] as string | undefined,
      args.force as boolean,
    )
  },
)

const destroyRouteDefinition = topLevel(
  'destroy',
  'Destroy an agent',
  async ({ args }) => {
    const input = args._[0] as string | undefined
    if (!input) throw new CliError('Usage: ar destroy <id>')
    await destroy({
      input,
      registry: resolveRegistry(args),
      force: args.force as boolean,
      keepSecrets: args['keep-secrets'] as boolean,
    })
  },
)

if (import.meta.main) {
  const args = parseArgs(Deno.args, AGENT_OPTIONS)
  await commandRouteDefinition.command({
    args,
    routes: [commandRouteDefinition],
  })
}

export {
  agentCommand,
  clearBuilds,
  clearBuildsRouteDefinition,
  commandRouteDefinition,
  create,
  createRouteDefinition,
  deploy,
  deployRouteDefinition,
  destroy,
  destroyRouteDefinition,
  list,
  listRouteDefinition,
  logs,
  logsRouteDefinition,
  run,
  runRouteDefinition,
}
export type {
  CreateOptions,
  DeployOptions,
  DestroyOptions,
  ListOptions,
  LogsOptions,
  RunOptions,
}
export default commandRouteDefinition

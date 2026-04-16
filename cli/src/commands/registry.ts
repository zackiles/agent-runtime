import { parseArgs } from '@std/cli'
import { join } from '@std/path'
import type {
  CommandRouteDefinition,
  CommandRouteOptions,
} from '../utils/command-router.ts'
import * as terminal from '../terminal/mod.ts'
import { confirm, text } from '../terminal/mod.ts'
import loadConfig from '@ar/client/config'
import { isProduction } from '@ar/client/build'
import { dataDir, load as loadRuntime } from '@ar/client/runtime'
import platform from '@ar/client/platform'
import { requireAuth } from '../auth.ts'
import {
  defaultSettingsDir,
  FIELD_DEFAULTS,
  FIELD_MAP,
  findSettingsFile,
  load as loadSettings,
  readSettingsFile,
  save,
  VALID_SET_OPTIONS,
} from '../settings.ts'
import { configGet } from '../utils/gcloud.ts'

const config = await loadConfig()

type InitOptions = {
  path: string
  force: boolean
  project: string
  region: string
  runtimeAccount: string
  vpcConnector?: string | undefined
  runtime: string
}
type SetOptions = {
  option: string
  value?: string | undefined
}
type GetOptions = Record<string, never>

async function detectDefaults(): Promise<{
  project: string
  region: string
  runtimeAccount: string
}> {
  const rc = loadRuntime()
  const settings = await loadSettings()
  const project = settings.project || await configGet('project')
  const region = await configGet('compute/region') || rc.platform.region
  const sa = rc.platform.runtimeAccountPattern.replace(
    '${project}',
    project || 'PROJECT',
  )
  return {
    project,
    region,
    runtimeAccount: project ? sa : '',
  }
}

async function init(opts: InitOptions): Promise<void> {
  const settingsDir = defaultSettingsDir()
  const filename = isProduction() ? 'settings.jsonc' : 'settings.local.jsonc'
  const settingsPath = join(settingsDir, filename)

  if (!opts.project || !opts.region || !opts.runtimeAccount) {
    throw new Error(
      'Project, region, and service account are required.',
    )
  }

  await platform.validateProject(opts.project)

  try {
    await Deno.mkdir(opts.path, { recursive: true })
    await Deno.mkdir(dataDir(), { recursive: true })
  } catch (err) {
    throw new Error(
      `Could not create registry at '${opts.path}': ${(err as Error).message}`,
    )
  }

  await save({
    project: opts.project,
    region: opts.region,
    runtimeAccount: opts.runtimeAccount,
    vpcConnector: opts.vpcConnector,
    runtime: opts.runtime,
  })

  terminal.success(`Settings saved to ${settingsPath}`)
  terminal.success(`Registry initialized at '${opts.path}'.`)
}

async function set(opts: SetOptions): Promise<void> {
  if (!opts.option || !VALID_SET_OPTIONS.includes(opts.option)) {
    throw new Error(
      `Unknown option '${opts.option}'. Valid options: ${
        VALID_SET_OPTIONS.join(', ')
      }`,
    )
  }

  const field = FIELD_MAP[opts.option]
  const value = opts.value === undefined
    ? (FIELD_DEFAULTS[opts.option] ?? null)
    : opts.value

  await save({ [field]: value })
  terminal.success(`Set '${opts.option}' to ${JSON.stringify(value)}.`)
}

async function get(_opts: GetOptions): Promise<void> {
  const settings = await loadSettings()
  terminal.json(settings)
}

const REGISTRY_OPTIONS = {
  boolean: ['force', 'json'],
  string: [
    'registry',
    'project',
    'region',
    'runtime-account',
    'vpc-connector',
    'runtime',
  ],
  alias: { r: 'registry' },
}

const commandRouteDefinition: CommandRouteDefinition = {
  name: 'registry',
  command: registryCommand,
  description: 'Manage agent registry (init, set, get)',
  options: REGISTRY_OPTIONS,
}

const initRouteDefinition: CommandRouteDefinition = {
  name: 'init',
  command: initCommand,
  description: 'Initialize the agent registry',
  options: REGISTRY_OPTIONS,
}

async function initCommand(
  { args }: CommandRouteOptions,
): Promise<void> {
  await requireAuth()

  const registry = (args.registry as string) || config.registry
  const targetPath = args._[0] ? String(args._[0]) : registry
  const force = args.force as boolean

  const hasAllFlags = args.project && args.region &&
    args['runtime-account']

  if (!hasAllFlags) {
    const reused = await reuseSettings(targetPath, force)
    if (reused) return
  }

  const defaults = await detectDefaults()

  const project = (args.project as string) ||
    await text('Project ID', {
      default: defaults.project,
      flag: 'project',
    })
  const region = (args.region as string) ||
    await text('Region', {
      default: defaults.region,
      flag: 'region',
    })
  const runtimeAccount = (args['runtime-account'] as string) ||
    await text('Runtime account email', {
      default: defaults.runtimeAccount,
      flag: 'runtime-account',
    })
  const vpcConnector = args['vpc-connector'] as string | undefined
  const runtime = (args.runtime as string) ||
    await text('Runtime', {
      default: loadRuntime().platform.runtime,
      flag: 'runtime',
    })

  return await init({
    path: targetPath,
    force,
    project,
    region,
    runtimeAccount,
    vpcConnector,
    runtime,
  })
}

async function reuseSettings(
  targetPath: string,
  force: boolean,
): Promise<boolean> {
  const file = await findSettingsFile(defaultSettingsDir())
  if (!file) return false

  let saved: Record<string, unknown>
  try {
    saved = await readSettingsFile(file)
  } catch {
    return false
  }

  const project = saved.project as string | undefined
  const region = saved.region as string | undefined
  const runtimeAccount = saved.runtimeAccount as string | undefined
  const vpcConnector = saved.vpcConnector as string | undefined
  if (!project || !region || !runtimeAccount) return false

  const runtime = (saved.runtime as string) ||
    loadRuntime().platform.runtime

  const rows: [string, string][] = [
    ['Project', project],
    ['Region', region],
    ['Runtime account', runtimeAccount],
    ['Runtime', runtime],
  ]
  if (vpcConnector) rows.push(['VPC connector', vpcConnector])

  terminal.print(`Existing settings found in ${file}:`)
  terminal.keyValue(rows)

  if (!await confirm('Use these settings?')) return false

  await init({
    path: targetPath,
    force,
    project,
    region,
    runtimeAccount,
    vpcConnector,
    runtime,
  })
  return true
}

async function registryCommand(
  { args }: CommandRouteOptions,
): Promise<void> {
  terminal.setJsonMode(!!args.json)
  const subcommand = args._[0] as string | undefined

  switch (subcommand) {
    case 'init':
      return await initCommand({
        args: { ...args, _: args._.slice(1) },
        routes: [],
      })
    case 'set': {
      const option = args._[1] as string | undefined
      if (!option) {
        throw new Error(
          `Usage: ar registry set <option> [value]. Valid options: ${
            VALID_SET_OPTIONS.join(', ')
          }`,
        )
      }
      return await set({
        option,
        value: args._[2] !== undefined ? String(args._[2]) : undefined,
      })
    }
    case 'get':
      return await get({})
    default:
      throw new Error(
        'Usage: ar registry <init|set|get>.' +
          " Run 'ar help' for details.",
      )
  }
}

if (import.meta.main) {
  const args = parseArgs(Deno.args, REGISTRY_OPTIONS)
  await commandRouteDefinition.command({
    args,
    routes: [commandRouteDefinition],
  })
}

export {
  commandRouteDefinition,
  get,
  init,
  initRouteDefinition,
  registryCommand,
  set,
}
export type { GetOptions, InitOptions, SetOptions }
export default commandRouteDefinition

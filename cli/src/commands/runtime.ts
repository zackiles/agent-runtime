import { parseArgs } from '@std/cli'
import type {
  CommandRouteDefinition,
  CommandRouteOptions,
} from '../utils/command-router.ts'
import * as terminal from '../terminal/mod.ts'
import { confirm, spinner } from '../terminal/mod.ts'
import loadConfig from '@ar/client/config'
import platform from '@ar/client/platform'
import { loadGcp } from '../settings.ts'
import { requireAuth } from '../auth.ts'

const config = await loadConfig()

const VALID_OPTIONS = [
  'memory',
  'timeout',
  'max-instances',
  'min-instances',
  'concurrency',
]

const VALUE_PATTERNS: Record<string, RegExp> = {
  'memory': /^\d+[MG]$/,
  'timeout': /^\d+s$/,
  'max-instances': /^\d+$/,
  'min-instances': /^\d+$/,
  'concurrency': /^\d+$/,
}

type StatusOptions = { registry: string }
type SetOptions = {
  option: string
  value: string
  force: boolean
  registry: string
}

async function status(_opts: StatusOptions): Promise<void> {
  const reg = await loadGcp()

  if (terminal.isJsonMode()) {
    const functions = await platform.functionListDetailed(
      reg.project,
      reg.region,
    )
    const jobs = await platform.schedulerList(reg.project, reg.region)
    const triggers = await platform.eventarcList(
      reg.project,
      reg.region,
    )
    terminal.json({
      project: reg.project,
      region: reg.region,
      functions,
      jobs,
      triggers,
    })
    return
  }

  terminal.keyValue([
    ['Project', reg.project],
    ['Region', reg.region],
  ])
  terminal.blank()

  const functions = await platform.functionListDetailed(
    reg.project,
    reg.region,
  )

  if (functions.length === 0) {
    terminal.info('No agents deployed.')
    return
  }

  terminal.table(
    ['AGENT', 'STATE', 'MEMORY', 'CPU', 'TIMEOUT', 'URI'],
    functions.map((f) => [
      f.name || '',
      f.state || '',
      f.memory || '',
      f.cpu || '',
      f.timeout || '',
      f.uri || '',
    ]),
  )

  const jobs = await platform.schedulerList(reg.project, reg.region)
  const triggers = await platform.eventarcList(reg.project, reg.region)

  if (jobs.length > 0 || triggers.length > 0) {
    terminal.blank()
    terminal.heading('TRIGGERS')

    const rows: string[][] = []

    for (const j of jobs) {
      const agentName = j.name.replace(/-cron$/, '')
      rows.push([j.name, 'cron', agentName, j.schedule || ''])
    }

    for (const t of triggers) {
      rows.push([
        t.name,
        'pubsub',
        t.service || '',
        `topic: ${t.topic || ''}`,
      ])
    }

    terminal.table(
      ['TRIGGER', 'TYPE', 'AGENT', 'DETAILS'],
      rows,
    )
  }
}

async function set(opts: SetOptions): Promise<void> {
  if (!VALID_OPTIONS.includes(opts.option)) {
    throw new Error(
      `Unknown option '${opts.option}'. Valid options: ${
        VALID_OPTIONS.join(', ')
      }`,
    )
  }

  const pattern = VALUE_PATTERNS[opts.option]
  if (pattern && !pattern.test(opts.value)) {
    throw new Error(
      `Invalid value '${opts.value}' for option '${opts.option}'.`,
    )
  }

  const reg = await loadGcp()

  const functions = await platform.functionList(reg.project, reg.region)
  if (functions.length === 0) {
    terminal.info('No agents deployed.')
    return
  }

  if (
    !opts.force &&
    !await confirm(
      `Update '${opts.option}' to '${opts.value}' across ${functions.length} agents?`,
    )
  ) {
    terminal.info('Aborted.')
    return
  }

  const spin = spinner(
    `Updating '${opts.option}' to '${opts.value}' across ${functions.length} agents...`,
  )

  for (const f of functions) {
    spin.update(`Updating ${f.name}...`)
    await platform.functionUpdate({
      agentId: f.name,
      region: reg.region,
      project: reg.project,
      option: opts.option,
      value: opts.value,
    })
  }

  spin.succeed(
    `Updated '${opts.option}' to '${opts.value}' across ${functions.length} agents.`,
  )
}

const commandRouteDefinition: CommandRouteDefinition = {
  name: 'runtime',
  command: command,
  description: 'Manage runtime (status, set)',
  options: {
    boolean: ['force', 'json'],
    string: ['registry'],
    alias: { r: 'registry' },
  },
}

async function command({ args }: CommandRouteOptions): Promise<void> {
  await requireAuth()
  terminal.setJsonMode(!!args.json)
  const subcommand = args._[0] as string | undefined
  const registry = (args.registry as string) || config.registry

  switch (subcommand) {
    case 'status':
      return await status({ registry })
    case 'set': {
      const option = args._[1] as string | undefined
      const value = args._[2] as string | undefined
      if (!option || !value) {
        throw new Error(
          'Usage: ar runtime set <option> <value> [--force]',
        )
      }
      return await set({
        option,
        value,
        force: args.force as boolean,
        registry,
      })
    }
    default:
      throw new Error(
        "Usage: ar runtime <status|set>. Run 'ar help' for details.",
      )
  }
}

if (import.meta.main) {
  const args = parseArgs(Deno.args, commandRouteDefinition.options)
  await commandRouteDefinition.command({
    args,
    routes: [commandRouteDefinition],
  })
}

const statusRouteDefinition: CommandRouteDefinition = {
  name: 'status',
  command: async ({ args }: CommandRouteOptions) => {
    await requireAuth()
    const registry = (args.registry as string) || config.registry
    await status({ registry })
  },
  description: 'Show runtime status',
  options: {
    string: ['registry'],
    alias: { r: 'registry' },
  },
}

export { command, commandRouteDefinition, set, status, statusRouteDefinition }
export type { SetOptions, StatusOptions }
export default commandRouteDefinition

import { parseArgs } from '@std/cli'
import type {
  CommandRouteDefinition,
  CommandRouteOptions,
} from '../utils/command-router.ts'
import * as terminal from '../terminal/mod.ts'
import { confirm, text } from '../terminal/mod.ts'
import loadConfig from '@ar/client/config'
import platform from '@ar/client/platform'
import {
  agentDirExists,
  parseAgentRef,
  readAgent,
  validateId,
  writeAgent,
} from '@ar/client/registry'
import type { TriggerDescriptor } from '@ar/client/registry'
import { loadGcp } from '../settings.ts'
import { requireAuth } from '../auth.ts'

const config = await loadConfig()

type CreateOptions = {
  agentId: string
  registry: string
  type: 'cron' | 'pubsub'
  schedule?: string | undefined
  timezone?: string | undefined
  name?: string | undefined
  topic?: string | undefined
}
type RemoveOptions = {
  agentId: string
  triggerName: string
  force: boolean
  registry: string
}
type ListOptions = { agentId: string; registry: string }

async function create(opts: CreateOptions): Promise<void> {
  validateId(opts.agentId, 'agent ID')

  const reg = await loadGcp()

  try {
    await platform.functionDescribeState(
      opts.agentId,
      reg.region,
      reg.project,
    )
  } catch {
    throw new Error(
      `Agent '${opts.agentId}' is not deployed. Deploy it first with 'ar agent deploy ${opts.agentId}'.`,
    )
  }

  await platform.grantRunInvoker(
    opts.agentId,
    reg.region,
    reg.project,
    reg.runtimeAccount,
  )
  if (reg.workerAccount && reg.workerAccount !== reg.runtimeAccount) {
    await platform.grantRunInvoker(
      opts.agentId,
      reg.region,
      reg.project,
      reg.workerAccount,
    )
  }

  let descriptor: TriggerDescriptor

  if (opts.type === 'cron') {
    const schedule = opts.schedule
    const timezone = opts.timezone || 'Etc/UTC'
    const name = opts.name || `${opts.agentId}-cron`

    if (!schedule) {
      throw new Error('--schedule is required for cron triggers.')
    }

    const uri = await platform.functionDescribeUri(
      opts.agentId,
      reg.region,
      reg.project,
    )

    await platform.schedulerCreate({
      name,
      region: reg.region,
      project: reg.project,
      schedule,
      timezone,
      uri,
      runtimeAccount: reg.runtimeAccount,
    })

    descriptor = { type: 'cron', name, schedule, timezone }
  } else {
    const topic = opts.topic
    if (!topic) throw new Error('--topic is required for pubsub triggers.')

    const triggerName = opts.name || `${opts.agentId}-${topic}`

    await platform.eventarcCreate({
      name: triggerName,
      region: reg.region,
      project: reg.project,
      agentId: opts.agentId,
      topic,
      runtimeAccount: reg.runtimeAccount,
    })

    descriptor = { type: 'pubsub', name: triggerName, topic }
  }

  const ref = parseAgentRef(opts.agentId)
  if (await agentDirExists(opts.registry, ref)) {
    try {
      const manifest = await readAgent(opts.registry, ref)
      manifest.triggers = manifest.triggers || []
      manifest.triggers.push(descriptor)
      await writeAgent(opts.registry, ref, manifest)
      terminal.step('agent.json updated.')
    } catch {
      // agent.json may not exist
    }
  }

  terminal.success(
    `Trigger '${descriptor.name}' created (type: ${descriptor.type}).`,
  )
}

async function remove(opts: RemoveOptions): Promise<void> {
  const reg = await loadGcp()

  if (
    !opts.triggerName.startsWith(`${opts.agentId}-`) &&
    opts.triggerName !== opts.agentId
  ) {
    throw new Error(
      `Trigger '${opts.triggerName}' does not belong to agent` +
        ` '${opts.agentId}'.`,
    )
  }

  if (
    !opts.force &&
    !await confirm(`Remove trigger '${opts.triggerName}'?`)
  ) {
    terminal.info('Aborted.')
    return
  }

  const isScheduler = await platform.schedulerDescribe(
    opts.triggerName,
    reg.region,
    reg.project,
  )

  if (isScheduler) {
    await platform.schedulerDelete(
      opts.triggerName,
      reg.region,
      reg.project,
    )
  } else {
    const isEventarc = await platform.eventarcDescribe(
      opts.triggerName,
      reg.region,
      reg.project,
    )
    if (isEventarc) {
      await platform.eventarcDelete(
        opts.triggerName,
        reg.region,
        reg.project,
      )
    } else {
      throw new Error(`Trigger '${opts.triggerName}' not found.`)
    }
  }

  const removeRef = parseAgentRef(opts.agentId)
  if (await agentDirExists(opts.registry, removeRef)) {
    try {
      const manifest = await readAgent(opts.registry, removeRef)
      manifest.triggers = (manifest.triggers || []).filter(
        (t) => t.name !== opts.triggerName,
      )
      await writeAgent(opts.registry, removeRef, manifest)
      terminal.step('agent.json updated.')
    } catch {
      // agent.json may not exist
    }
  }

  terminal.success(`Trigger '${opts.triggerName}' removed.`)
}

async function list(opts: ListOptions): Promise<void> {
  const reg = await loadGcp()

  const jobs = await platform.schedulerList(
    reg.project,
    reg.region,
    `name~${opts.agentId}`,
  )

  const triggers = await platform.eventarcList(
    reg.project,
    reg.region,
    `destination.cloudRun.service=${opts.agentId}`,
  )

  if (terminal.isJsonMode()) {
    terminal.json({ jobs, triggers })
    return
  }

  if (jobs.length === 0 && triggers.length === 0) {
    terminal.info(`No triggers found for '${opts.agentId}'.`)
    return
  }

  const rows: string[][] = []

  for (const j of jobs) {
    rows.push([
      j.name,
      'cron',
      `${j.schedule || ''} (${j.timezone || 'Etc/UTC'})`,
    ])
  }

  for (const t of triggers) {
    rows.push([t.name, 'pubsub', `topic: ${t.topic || ''}`])
  }

  terminal.table(['TRIGGER', 'TYPE', 'DETAILS'], rows)
}

const commandRouteDefinition: CommandRouteDefinition = {
  name: 'trigger',
  command: command,
  description: 'Manage triggers (create, remove, list)',
  options: {
    boolean: ['force', 'json'],
    string: [
      'registry',
      'type',
      'schedule',
      'timezone',
      'name',
      'topic',
    ],
    alias: { r: 'registry' },
    default: { timezone: 'Etc/UTC' },
  },
}

async function command({ args }: CommandRouteOptions): Promise<void> {
  await requireAuth()
  terminal.setJsonMode(!!args.json)
  const subcommand = args._[0] as string | undefined
  const registry = (args.registry as string) || config.registry

  switch (subcommand) {
    case 'create': {
      const agentId = args._[1] as string | undefined
      if (!agentId) {
        throw new Error(
          'Usage: ar trigger create <agent-id> --type <cron|pubsub>',
        )
      }
      let triggerType = args.type as string | undefined
      if (!triggerType) {
        triggerType = await text('Trigger type (cron/pubsub)', {
          flag: 'type',
        })
      }
      if (triggerType !== 'cron' && triggerType !== 'pubsub') {
        throw new Error("--type must be 'cron' or 'pubsub'.")
      }
      let schedule = args.schedule as string | undefined
      if (triggerType === 'cron' && !schedule) {
        schedule = await text('Cron schedule', { flag: 'schedule' }) ||
          undefined
      }
      let topic = args.topic as string | undefined
      if (triggerType === 'pubsub' && !topic) {
        topic = await text('Pub/Sub topic name', { flag: 'topic' }) || undefined
      }
      return await create({
        agentId,
        registry,
        type: triggerType,
        schedule,
        timezone: args.timezone as string | undefined,
        name: args.name as string | undefined,
        topic,
      })
    }
    case 'remove': {
      const agentId = args._[1] as string | undefined
      const triggerName = args._[2] as string | undefined
      if (!agentId || !triggerName) {
        throw new Error(
          'Usage: ar trigger remove <agent-id> <trigger-name>' +
            ' [--force]',
        )
      }
      return await remove({
        agentId,
        triggerName,
        force: args.force as boolean,
        registry,
      })
    }
    case 'list': {
      const agentId = args._[1] as string | undefined
      if (!agentId) {
        throw new Error('Usage: ar trigger list <agent-id>')
      }
      return await list({ agentId, registry })
    }
    default:
      throw new Error(
        'Usage: ar trigger <create|remove|list>.' +
          " Run 'ar help' for details.",
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

export { command, commandRouteDefinition, create, list, remove }
export type { CreateOptions, ListOptions, RemoveOptions }
export default commandRouteDefinition

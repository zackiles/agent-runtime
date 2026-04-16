import { parseArgs } from '@std/cli'
import type {
  CommandRouteDefinition,
  CommandRouteOptions,
} from '../utils/command-router.ts'
import logger from '@ar/client/utils/logger'
import * as terminal from '../terminal/mod.ts'
import { confirm } from '../terminal/mod.ts'
import loadConfig from '@ar/client/config'
import platform from '@ar/client/platform'
import {
  agentDirExists,
  parseAgentRef,
  resolveSecretName,
  validateId,
} from '@ar/client/registry'
import { loadGcp } from '../settings.ts'
import { requireAuth } from '../auth.ts'

const config = await loadConfig()

type SetOptions = {
  name: string
  value: string
  agent?: string | undefined
  registry: string
}
type RemoveOptions = {
  name: string
  agent?: string | undefined
  force: boolean
  registry: string
}
type ListOptions = {
  agent?: string | undefined
  registry: string
}

async function set(opts: SetOptions): Promise<void> {
  validateId(opts.name, 'secret name')
  if (opts.agent) validateId(opts.agent, 'agent ID')

  const reg = await loadGcp()
  const secretName = resolveSecretName(opts.name, opts.agent)

  if (
    opts.agent &&
    !await agentDirExists(opts.registry, parseAgentRef(opts.agent))
  ) {
    logger.warn(
      `Agent folder '${opts.agent}' not found locally. Secret will still be created.`,
    )
  }

  const secretExists = await platform.secretDescribe(secretName, reg.project)
  let versionNum = 1

  if (!secretExists) {
    await platform.secretCreate(secretName, reg.project, reg.region)
  } else {
    versionNum = 0
  }

  await platform.secretAddVersion(secretName, reg.project, opts.value)
  await platform.secretGrantAccess(
    secretName,
    reg.project,
    reg.runtimeAccount,
  )
  if (reg.workerAccount && reg.workerAccount !== reg.runtimeAccount) {
    await platform.secretGrantAccess(
      secretName,
      reg.project,
      reg.workerAccount,
    )
  }

  if (versionNum === 1) {
    terminal.success(`Secret '${secretName}' created. Version 1 added.`)
  } else {
    terminal.success(`Secret '${secretName}' updated. New version added.`)
  }
  const accounts = [reg.runtimeAccount]
  if (reg.workerAccount && reg.workerAccount !== reg.runtimeAccount) {
    accounts.push(reg.workerAccount)
  }
  terminal.print(
    `IAM: ${accounts.join(', ')} granted secretmanager.secretAccessor.`,
  )

  if (versionNum !== 1) {
    try {
      const consumers = await platform.functionSecretConsumers(
        secretName,
        reg.project,
        reg.region,
      )
      if (consumers.length > 0) {
        terminal.info(
          `Refreshing ${consumers.length} function(s)` +
            ` that reference '${secretName}'...`,
        )
        for (const fn of consumers) {
          try {
            await platform.functionRefreshSecret(
              fn,
              reg.region,
              reg.project,
            )
            terminal.step(fn)
          } catch (err) {
            terminal.warn(
              `Failed to refresh ${fn}: ${(err as Error).message}`,
            )
          }
        }
      }
    } catch {
      logger.debug('Could not check for secret consumers')
    }
  }
}

async function remove(opts: RemoveOptions): Promise<void> {
  const reg = await loadGcp()
  const secretName = resolveSecretName(opts.name, opts.agent)

  const secretExists = await platform.secretDescribe(secretName, reg.project)
  if (!secretExists) {
    throw new Error(`Secret '${secretName}' not found.`)
  }

  if (!opts.force && !await confirm(`Delete secret '${secretName}'?`)) {
    terminal.info('Aborted.')
    return
  }

  await platform.secretDelete(secretName, reg.project)
  terminal.success(`Secret '${secretName}' and all versions deleted.`)
}

async function list(opts: ListOptions): Promise<void> {
  const reg = await loadGcp()
  const secrets = await platform.secretList(reg.project)

  if (terminal.isJsonMode()) {
    if (opts.agent) {
      const prefix = `${opts.agent}--`
      const filtered = secrets.filter((s) => s.name.startsWith(prefix))
      terminal.json(filtered)
    } else {
      terminal.json(secrets)
    }
    return
  }

  if (opts.agent) {
    const prefix = `${opts.agent}--`
    const filtered = secrets.filter((s) => s.name.startsWith(prefix))
    if (filtered.length === 0) {
      terminal.info(`No secrets found for agent '${opts.agent}'.`)
      return
    }
    terminal.heading(`Agent secrets (${opts.agent})`)
    terminal.list(filtered.map((s) => s.name))
    return
  }

  const global = secrets.filter((s) => !s.name.includes('--'))
  const agentScoped = secrets.filter((s) => s.name.includes('--'))

  if (global.length === 0 && agentScoped.length === 0) {
    terminal.info('No secrets found.')
    return
  }

  if (global.length > 0) {
    terminal.heading('Global secrets')
    terminal.list(global.map((s) => s.name))
  }

  if (agentScoped.length > 0) {
    if (global.length > 0) terminal.blank()
    terminal.heading('Agent secrets')
    terminal.list(agentScoped.map((s) => s.name))
  }
}

const commandRouteDefinition: CommandRouteDefinition = {
  name: 'secret',
  command: command,
  description: 'Manage secrets (set, remove, list)',
  options: {
    boolean: ['force', 'json'],
    string: ['agent', 'registry'],
    alias: { r: 'registry' },
  },
}

async function command({ args }: CommandRouteOptions): Promise<void> {
  await requireAuth()
  terminal.setJsonMode(!!args.json)
  const subcommand = args._[0] as string | undefined
  const registry = (args.registry as string) || config.registry

  switch (subcommand) {
    case 'set': {
      const name = args._[1] as string | undefined
      const value = args._[2] as string | undefined
      if (!name || !value) {
        throw new Error(
          'Usage: ar secret set <name> <value> [--agent <agent-id>]',
        )
      }
      return await set({
        name,
        value,
        agent: args.agent as string | undefined,
        registry,
      })
    }
    case 'remove': {
      const name = args._[1] as string | undefined
      if (!name) {
        throw new Error(
          'Usage: ar secret remove <name> [--agent <agent-id>] [--force]',
        )
      }
      return await remove({
        name,
        agent: args.agent as string | undefined,
        force: args.force as boolean,
        registry,
      })
    }
    case 'list':
      return await list({
        agent: args.agent as string | undefined,
        registry,
      })
    default:
      throw new Error(
        "Usage: ar secret <set|remove|list>. Run 'ar help' for details.",
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

export { command, commandRouteDefinition, list, remove, set }
export type { ListOptions, RemoveOptions, SetOptions }
export default commandRouteDefinition

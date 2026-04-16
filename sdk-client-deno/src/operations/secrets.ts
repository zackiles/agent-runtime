import logger from '../utils/logger.ts'
import platform from '../platform/mod.ts'
import {
  agentDirExists,
  parseAgentRef,
  resolveSecretName,
  validateId,
} from '../registry.ts'

type SetOptions = {
  name: string
  value: string
  agent?: string | undefined
  project: string
  region: string
  runtimeAccount: string
  registry: string
}

type RemoveOptions = {
  name: string
  agent?: string | undefined
  force: boolean
  project: string
}

type ListOptions = {
  agent?: string | undefined
  project: string
}

async function set(opts: SetOptions): Promise<void> {
  validateId(opts.name, 'secret name')
  if (opts.agent) validateId(opts.agent, 'agent ID')

  const secretName = resolveSecretName(opts.name, opts.agent)

  if (
    opts.agent &&
    !await agentDirExists(opts.registry, parseAgentRef(opts.agent))
  ) {
    logger.warn(
      `Agent folder '${opts.agent}' not found locally.` +
        ' Secret will still be created.',
    )
  }

  const secretExists = await platform.secretDescribe(
    secretName,
    opts.project,
  )
  let versionNum = 1

  if (!secretExists) {
    await platform.secretCreate(
      secretName,
      opts.project,
      opts.region,
    )
  } else {
    versionNum = 0
  }

  await platform.secretAddVersion(
    secretName,
    opts.project,
    opts.value,
  )
  await platform.secretGrantAccess(
    secretName,
    opts.project,
    opts.runtimeAccount,
  )

  if (versionNum === 1) {
    logger.print(`Secret '${secretName}' created. Version 1 added.`)
  } else {
    logger.print(
      `Secret '${secretName}' updated. New version added.`,
    )
  }
  logger.print(
    `IAM: ${opts.runtimeAccount} granted` +
      ' secretmanager.secretAccessor.',
  )
}

async function remove(opts: RemoveOptions): Promise<void> {
  const secretName = resolveSecretName(opts.name, opts.agent)

  const secretExists = await platform.secretDescribe(
    secretName,
    opts.project,
  )
  if (!secretExists) {
    throw new Error(`Secret '${secretName}' not found.`)
  }

  await platform.secretDelete(secretName, opts.project)
  logger.print(`Secret '${secretName}' and all versions deleted.`)
}

async function list(opts: ListOptions): Promise<void> {
  const secrets = await platform.secretList(opts.project)

  if (opts.agent) {
    const prefix = `${opts.agent}--`
    const filtered = secrets.filter((s) => s.name.startsWith(prefix))
    if (filtered.length === 0) {
      logger.print(`No secrets found for agent '${opts.agent}'.`)
      return
    }
    logger.print(`Agent secrets (${opts.agent}):`)
    for (const s of filtered) {
      logger.print(`  ${s.name}`)
    }
    return
  }

  const global = secrets.filter((s) => !s.name.includes('--'))
  const agentScoped = secrets.filter((s) => s.name.includes('--'))

  if (global.length === 0 && agentScoped.length === 0) {
    logger.print('No secrets found.')
    return
  }

  if (global.length > 0) {
    logger.print('Global secrets:')
    for (const s of global) {
      logger.print(`  ${s.name}`)
    }
  }

  if (agentScoped.length > 0) {
    logger.print('\nAgent secrets:')
    for (const s of agentScoped) {
      logger.print(`  ${s.name}`)
    }
  }
}

export { list, remove, set }
export type { ListOptions, RemoveOptions, SetOptions }

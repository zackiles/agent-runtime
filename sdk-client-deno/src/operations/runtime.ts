import logger from '../utils/logger.ts'
import platform from '../platform/mod.ts'

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

type StatusOptions = { project: string; region: string }
type SetOptions = {
  option: string
  value: string
  force: boolean
  project: string
  region: string
}

async function status(opts: StatusOptions): Promise<void> {
  logger.print(`Project:  ${opts.project}`)
  logger.print(`Region:   ${opts.region}`)
  logger.print('')

  const functions = await platform.functionListDetailed(
    opts.project,
    opts.region,
  )

  if (functions.length === 0) {
    logger.print('No agents deployed.')
    return
  }

  const header = `${'AGENT'.padEnd(18)} ${'STATE'.padEnd(10)} ${
    'MEMORY'.padEnd(8)
  } ${'CPU'.padEnd(8)} ${'TIMEOUT'.padEnd(10)} URI`
  logger.print(header)

  for (const f of functions) {
    logger.print(
      `${(f.name || '').padEnd(18)} ${(f.state || '').padEnd(10)} ${
        (f.memory || '').padEnd(8)
      } ${(f.cpu || '').padEnd(8)} ${(f.timeout || '').padEnd(10)} ${
        f.uri || ''
      }`,
    )
  }

  const jobs = await platform.schedulerList(opts.project, opts.region)
  const triggers = await platform.eventarcList(
    opts.project,
    opts.region,
  )

  if (jobs.length > 0 || triggers.length > 0) {
    logger.print('')
    logger.print('TRIGGERS')

    for (const j of jobs) {
      const agentName = j.name.replace(/-cron$/, '')
      logger.print(
        `${j.name.padEnd(25)} ${'cron'.padEnd(8)} ${agentName.padEnd(18)} ${
          j.schedule || ''
        }`,
      )
    }

    for (const t of triggers) {
      logger.print(
        `${t.name.padEnd(25)} ${'pubsub'.padEnd(8)} ${
          (t.service || '').padEnd(18)
        } topic: ${t.topic || ''}`,
      )
    }
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

  const functions = await platform.functionList(
    opts.project,
    opts.region,
  )
  if (functions.length === 0) {
    logger.print('No agents deployed.')
    return
  }

  logger.print(
    `Updating '${opts.option}' to '${opts.value}' across ${functions.length} agents...`,
  )

  for (const f of functions) {
    await platform.functionUpdate({
      agentId: f.name,
      region: opts.region,
      project: opts.project,
      option: opts.option,
      value: opts.value,
    })
    logger.print(`  ${f.name} updated`)
  }
}

export { set, status }
export type { SetOptions, StatusOptions }

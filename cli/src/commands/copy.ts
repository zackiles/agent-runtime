import { parseArgs } from '@std/cli'
import type {
  CommandRouteDefinition,
  CommandRouteOptions,
} from '../utils/command-router.ts'
import * as terminal from '../terminal/mod.ts'
import { resolve as resolveTenant } from '@ar/client/tenant'
import { open } from '@ar/client/db'
import { execute, plan } from '@ar/client/db/copy'
import { isAdmin } from '@ar/client/db/users'
import { ensure } from '@ar/client/db/users'
import { canPublish } from '@ar/client/db/access'
import { detect } from '@ar/client/mode'
import { load as loadSettings } from '../settings.ts'

const OPTIONS = {
  boolean: ['force', 'production', 'public'],
  string: ['to', 'tenant'],
}

const commandRouteDefinition: CommandRouteDefinition = {
  name: 'copy',
  command: copyCommand,
  description: 'Copy an agent and its dependencies across tenants',
  options: OPTIONS,
}

async function copyCommand({ args }: CommandRouteOptions): Promise<void> {
  const slug = args._[0] as string | undefined
  if (!slug) {
    throw new Error('Usage: ar copy <slug> --to <tenant>')
  }

  const to = args.to as string | undefined
  if (!to) {
    throw new Error(
      '--to is required. Specify any tenant name (e.g. --to production, --to staging)',
    )
  }

  const visibility = (args.public as boolean) ? 'public' : 'private'

  const tenant = resolveTenant(args.tenant as string | undefined)
  const modeInfo = await detect((await loadSettings()).controlPlaneUrl)
  await open(tenant, modeInfo.mode)

  const user = ensure('cli-user@ar-cli')

  if (visibility === 'public' && !canPublish(to, user.id, 'public')) {
    throw new Error(
      'Only admins can copy to a public registry. Use --public=false or omit --public.',
    )
  }

  if (visibility === 'public' && !isAdmin(user.id)) {
    throw new Error('Only admins can copy to a public registry.')
  }

  const copyPlan = plan(slug, tenant.id, to)

  terminal.heading(`Copy Report: ${slug} → ${to} (${visibility})`)
  terminal.blank()
  terminal.print('Agents to copy:')
  for (const item of copyPlan.items.filter((i) => i.type === 'agent')) {
    if (item.isConflict) {
      terminal.warn(item.label)
    } else {
      terminal.success(item.label)
    }
  }

  const configs = copyPlan.items.filter((i) => i.type !== 'agent')
  if (configs.length > 0) {
    terminal.blank()
    terminal.print('Dependencies to copy:')
    for (const item of configs) {
      terminal.success(item.label)
    }
  }

  const conflicts = copyPlan.items.filter((i) => i.isConflict)
  if (conflicts.length > 0) {
    terminal.blank()
    terminal.print('Conflicts (will be overwritten):')
    for (const item of conflicts) {
      terminal.warn(`${item.label} already exists in ${to}`)
    }
  }

  if (copyPlan.warnings && copyPlan.warnings.length > 0) {
    terminal.blank()
    terminal.print('Warnings (require manual action):')
    for (const warning of copyPlan.warnings) {
      terminal.warn(warning)
    }
  }

  terminal.blank()

  if (!args.force && !(await terminal.confirm('Proceed?'))) {
    terminal.info('Aborted.')
    return
  }

  const report = execute(copyPlan, user.id)

  terminal.blank()
  terminal.heading('Copy Complete')
  terminal.success(`${report.copied} items copied`)
  terminal.warn(`${report.overwritten} agents overwritten`)
  terminal.error(`${report.failures} failures`)

  if (report.warnings.length > 0) {
    terminal.blank()
    terminal.print('Follow-up warnings:')
    for (const w of report.warnings) {
      terminal.warn(w)
    }
  }
}

if (import.meta.main) {
  const args = parseArgs(Deno.args, OPTIONS)
  await commandRouteDefinition.command({
    args,
    routes: [commandRouteDefinition],
  })
}

export { commandRouteDefinition, copyCommand }
export default commandRouteDefinition

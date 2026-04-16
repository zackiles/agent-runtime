import { parseArgs } from '@std/cli'
import type {
  CommandRouteDefinition,
  CommandRouteOptions,
} from '../utils/command-router.ts'
import * as terminal from '../terminal/mod.ts'
import { resolve as resolveTenant } from '@ar/client/tenant'
import { open } from '@ar/client/db'
import {
  createTeam,
  editTeam,
  getTeamByName,
  listTeams,
} from '@ar/client/db/teams'
import { ensure } from '@ar/client/db/users'
import { detect } from '@ar/client/mode'
import { load as loadSettings } from '../settings.ts'

const OPTIONS = {
  boolean: ['production'],
  string: ['department', 'owner'],
}

const commandRouteDefinition: CommandRouteDefinition = {
  name: 'team',
  command: teamCommand,
  description: 'Manage teams (create, list, edit)',
  options: OPTIONS,
}

async function teamCommand({ args }: CommandRouteOptions): Promise<void> {
  const sub = args._[0] as string | undefined
  const tenant = resolveTenant()
  const modeInfo = await detect((await loadSettings()).controlPlaneUrl)
  await open(tenant, modeInfo.mode)
  const user = ensure('cli-user@ar-cli')

  switch (sub) {
    case 'create': {
      const name = args._[1] as string | undefined
      if (!name) throw new Error('Usage: ar team create <name>')
      const dept = (args.department as string) || undefined
      createTeam(tenant.id, name, user.id, dept)
      terminal.success(`Team '${name}' created.`)
      break
    }
    case 'list': {
      const teams = listTeams(tenant.id)
      if (teams.length === 0) {
        terminal.info('No teams found.')
        return
      }
      terminal.table(
        ['NAME', 'OWNER', 'DEPARTMENT'],
        teams.map((t) => [t.name, t.ownerId, t.departmentId]),
      )
      break
    }
    case 'edit': {
      const name = args._[1] as string | undefined
      if (!name) throw new Error('Usage: ar team edit <name> --owner <email>')
      const team = getTeamByName(tenant.id, name)
      if (!team) throw new Error(`Team '${name}' not found.`)
      const owner = args.owner as string | undefined
      if (owner) editTeam(team.id, tenant.id, { ownerId: owner })
      terminal.success(`Team '${name}' updated.`)
      break
    }
    default:
      throw new Error("Usage: ar team <create|list|edit>. Run 'ar help'.")
  }
}

if (import.meta.main) {
  const args = parseArgs(Deno.args, OPTIONS)
  await commandRouteDefinition.command({
    args,
    routes: [commandRouteDefinition],
  })
}

export { commandRouteDefinition, teamCommand }
export default commandRouteDefinition

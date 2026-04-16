import { parseArgs } from '@std/cli'
import type {
  CommandRouteDefinition,
  CommandRouteOptions,
} from '../utils/command-router.ts'
import * as terminal from '../terminal/mod.ts'
import { resolve as resolveTenant } from '@ar/client/tenant'
import { open } from '@ar/client/db'
import {
  createDepartment,
  editDepartment,
  getDepartmentByName,
  listDepartments,
} from '@ar/client/db/teams'
import { ensure } from '@ar/client/db/users'
import { detect } from '@ar/client/mode'
import { load as loadSettings } from '../settings.ts'

const OPTIONS = {
  boolean: ['production'],
  string: ['owner'],
}

const commandRouteDefinition: CommandRouteDefinition = {
  name: 'department',
  command: departmentCommand,
  description: 'Manage departments (create, list, edit)',
  options: OPTIONS,
}

async function departmentCommand(
  { args }: CommandRouteOptions,
): Promise<void> {
  const sub = args._[0] as string | undefined
  const tenant = resolveTenant()
  const modeInfo = await detect((await loadSettings()).controlPlaneUrl)
  await open(tenant, modeInfo.mode)
  const user = ensure('cli-user@ar-cli')

  switch (sub) {
    case 'create': {
      const name = args._[1] as string | undefined
      if (!name) throw new Error('Usage: ar department create <name>')
      createDepartment(tenant.id, name, user.id)
      terminal.success(`Department '${name}' created.`)
      break
    }
    case 'list': {
      const depts = listDepartments(tenant.id)
      if (depts.length === 0) {
        terminal.info('No departments found.')
        return
      }
      terminal.table(
        ['NAME', 'OWNER'],
        depts.map((d) => [d.name, d.ownerId]),
      )
      break
    }
    case 'edit': {
      const name = args._[1] as string | undefined
      if (!name) {
        throw new Error(
          'Usage: ar department edit <name> --owner <email>',
        )
      }
      const dept = getDepartmentByName(tenant.id, name)
      if (!dept) throw new Error(`Department '${name}' not found.`)
      const owner = args.owner as string | undefined
      if (owner) editDepartment(dept.id, tenant.id, { ownerId: owner })
      terminal.success(`Department '${name}' updated.`)
      break
    }
    default:
      throw new Error(
        "Usage: ar department <create|list|edit>. Run 'ar help'.",
      )
  }
}

if (import.meta.main) {
  const args = parseArgs(Deno.args, OPTIONS)
  await commandRouteDefinition.command({
    args,
    routes: [commandRouteDefinition],
  })
}

export { commandRouteDefinition, departmentCommand }
export default commandRouteDefinition

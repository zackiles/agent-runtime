import { parseArgs } from '@std/cli'
import { dim } from '@std/fmt/colors'
import type {
  CommandRouteDefinition,
  CommandRouteOptions,
} from '../utils/command-router.ts'
import * as terminal from '../terminal/mod.ts'
import { detect, label } from '@ar/client/mode'
import { resolve as resolveTenant } from '@ar/client/tenant'
import { discoverControlPlaneUrl, load as loadSettings } from '../settings.ts'
import { load as loadRuntime } from '@ar/client/runtime'
import { isAdmin } from '@ar/client/db/users'
import { open } from '@ar/client/db'
import { listPrivateEntities, listPublicEntities } from '@ar/client/db/registry'
import type { EntityTable, RegistryEntity } from '@ar/client/db/registry'
import { listByTenant } from '@ar/client/db/agents'
import type { Agent } from '@ar/client/db/agents'

const commandRouteDefinition: CommandRouteDefinition = {
  name: 'status',
  command: command,
  description: 'Show current status (role, registry, tenant)',
  options: {
    string: ['registry', 'tenant'],
    alias: { r: 'registry' },
  },
}

async function command({ args }: CommandRouteOptions): Promise<void> {
  const settings = await loadSettings()
  const info = await detect(settings.controlPlaneUrl)
  const tenant = resolveTenant(args.tenant as string | undefined)
  const rc = loadRuntime()

  terminal.heading('Status')
  terminal.keyValue([
    ['Mode', `${label(info.mode)} ${info.mode}`],
    ['Tenant', tenant.id],
  ])

  terminal.blank()
  terminal.heading('Endpoints')

  const localUrl = `http://localhost:${rc.controlPlane.port}`

  if (info.mode === 'remote') {
    terminal.keyValue([
      ['Active', info.controlPlaneUrl ?? ''],
      ['Local', dim(localUrl)],
    ])
  } else {
    const remoteUrl = await discoverControlPlaneUrl()
    const pairs: [string, string][] = [
      ['Local', localUrl],
    ]
    if (remoteUrl) {
      pairs.push(['Remote', `${remoteUrl} ${dim('(disconnected)')}`])
    }
    terminal.keyValue(pairs)
    terminal.blank()
    terminal.print(
      remoteUrl
        ? 'Reconnect or override: ar connect [url]'
        : 'Connect to a control plane: ar connect <url>',
    )
  }

  try {
    await open(tenant, info.mode)
  } catch {
    return
  }

  const userEmail = Deno.env.get('AR_USER') || 'cli-user@ar-cli'
  const userIsAdmin = isAdmin(userEmail) || info.mode === 'local'
  const role = userIsAdmin ? 'admin' : 'user'

  const registryDisplay = userIsAdmin
    ? `{${tenant.id}:public}`
    : `{${tenant.id}:private:${userEmail}}`
  terminal.keyValue([
    ['Role', role],
    ['Registry', registryDisplay],
  ])

  const publicAgents = listByTenant(tenant.id, { visibility: 'public' })
  const privateAgents = listByTenant(tenant.id, { visibility: 'private' })
  const userPrivateAgents = privateAgents.filter(
    (a) => a.createdBy === userEmail,
  )

  const entityTypes: EntityTable[] = ['tool', 'skill', 'rule']
  const publicItems: Record<string, RegistryEntity[]> = {}
  const privateItems: Record<string, RegistryEntity[]> = {}
  for (const t of entityTypes) {
    publicItems[t] = listPublicEntities(t, tenant.id)
    privateItems[t] = listPrivateEntities(t, tenant.id, userEmail)
  }

  terminal.blank()
  terminal.heading('Public Registry')
  printAgentSection(publicAgents, 'Agents')
  for (const t of entityTypes) {
    printEntitySection(publicItems[t], `${t[0].toUpperCase()}${t.slice(1)}s`)
  }

  if (
    userPrivateAgents.length > 0 ||
    entityTypes.some((t) => privateItems[t].length > 0)
  ) {
    terminal.blank()
    terminal.heading(`Private Registry (${userEmail})`)
    printAgentSection(userPrivateAgents, 'Agents')
    for (const t of entityTypes) {
      printEntitySection(privateItems[t], `${t[0].toUpperCase()}${t.slice(1)}s`)
    }

    const publicAgentSlugs = new Set(publicAgents.map((a) => a.slug))
    const promotable: Array<{ type: string; slug: string }> = []
    for (const a of userPrivateAgents) {
      if (!publicAgentSlugs.has(a.slug)) {
        promotable.push({ type: 'agent', slug: a.slug })
      }
    }
    for (const t of entityTypes) {
      const publicSlugs = new Set(publicItems[t].map((e) => e.slug))
      for (const e of privateItems[t]) {
        if (!publicSlugs.has(e.slug)) {
          promotable.push({ type: t, slug: e.slug })
        }
      }
    }

    if (promotable.length > 0) {
      terminal.blank()
      if (userIsAdmin) {
        terminal.print('Eligible to publish to public registry:')
      } else {
        terminal.print('Not in public (requires admin to publish):')
      }
      for (const p of promotable) {
        const tag = userIsAdmin ? '→ publishable' : '  private-only'
        terminal.print(`  ${p.type.padEnd(8)} ${p.slug.padEnd(24)} ${tag}`)
      }
    }
  }
}

function printAgentSection(agents: Agent[], heading: string): void {
  terminal.print(`  ${heading}: ${agents.length}`)
  if (agents.length === 0) return
  terminal.table(
    ['Slug', 'Version', 'Visibility'],
    agents.map((a) => [
      a.slug,
      `v${a.version}`,
      a.visibility,
    ]),
  )
}

function printEntitySection(
  items: RegistryEntity[],
  heading: string,
): void {
  terminal.print(`  ${heading}: ${items.length}`)
  if (items.length === 0) return
  terminal.table(
    ['Slug', 'Visibility', 'Owner'],
    items.map((e) => [e.slug, e.visibility, e.ownerId]),
  )
}

if (import.meta.main) {
  const args = parseArgs(Deno.args, commandRouteDefinition.options)
  await commandRouteDefinition.command({
    args,
    routes: [commandRouteDefinition],
  })
}

export { command, commandRouteDefinition }
export default commandRouteDefinition

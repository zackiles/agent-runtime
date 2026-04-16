import { parseArgs } from '@std/cli'
import { exists } from '@std/fs'
import { join } from '@std/path'
import type {
  CommandRouteDefinition,
  CommandRouteOptions,
} from '../utils/command-router.ts'
import * as terminal from '../terminal/mod.ts'
import { confirm, spinner } from '../terminal/mod.ts'
import loadConfig from '@ar/client/config'
import { resolve as resolveTenant } from '@ar/client/tenant'
import { open } from '@ar/client/db'
import {
  cloneEntity as opsClone,
  createEntity,
  deployEntity,
  getEntityBySlug,
  listEntities,
  listPublicEntities,
  listVersions,
  removeEntity,
  updateEntity,
} from '@ar/client/operations/registry'
import { ensure } from '@ar/client/db/users'
import { canPublish } from '@ar/client/db/access'
import { detect } from '@ar/client/mode'
import { load as loadSettings, loadGcp } from '../settings.ts'
import { resolveRuleDir, ruleDir, validateId } from '@ar/client/registry'
import { validate as validateRule } from '@ar/client/rule-schema'
import { compile } from '@ar/client/templates'
import { compress } from '../utils/archive.ts'
import { requireAuth } from '../auth.ts'

const config = await loadConfig()

const OPTIONS = {
  boolean: ['production', 'public', 'force'],
  string: ['registry', 'tenant', 'visibility'],
  alias: { r: 'registry' },
}

function registry(args: ReturnType<typeof parseArgs>): string {
  return (args.registry as string) || config.registry
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(
    /^-|-$/g,
    '',
  )
}

const commandRouteDefinition: CommandRouteDefinition = {
  name: 'rule',
  command: ruleCommand,
  description: 'Manage rules (create, update, deploy, destroy, list, clone)',
  options: OPTIONS,
}

async function ruleCommand(
  { args }: CommandRouteOptions,
): Promise<void> {
  await requireAuth()
  const sub = args._[0] as string | undefined
  const reg = registry(args)
  const tenant = resolveTenant(args.tenant as string | undefined)
  const modeInfo = await detect((await loadSettings()).controlPlaneUrl)
  await open(tenant, modeInfo.mode)
  const user = ensure('cli-user@ar-cli')
  const isPublic = args.public as boolean
  const visibility = isPublic ? 'public' : 'private'

  switch (sub) {
    case 'create': {
      const name = args._[1] as string | undefined
      if (!name) {
        throw new Error('Usage: ar rule create <name> [--public]')
      }
      const slug = slugify(name)
      validateId(slug, 'rule name')
      if (isPublic && !canPublish(tenant.id, user.id, 'public')) {
        throw new Error(
          'You do not have permission to publish to the' +
            ' public registry.',
        )
      }
      const version = '0.0.1'
      const dir = ruleDir(reg, slug, version)

      if (await exists(dir)) {
        throw new Error(
          `Folder '${slug}/${version}' already exists.` +
            ' Choose a different name.',
        )
      }

      await Deno.mkdir(dir, { recursive: true })
      const files = compile('rule-default', { name, slug, version })
      for (const [path, content] of Object.entries(files)) {
        await Deno.writeTextFile(join(dir, path), content)
      }

      const opts: {
        visibility: string
        config?: Record<string, unknown>
        version?: string
        content?: string
      } = { visibility, version }
      try {
        const result = await validateRule(dir)
        opts.config = {
          ...result.manifest,
          description: result.frontmatter.description,
        }
        if (result.body) opts.content = result.body
      } catch {
        // validation may fail for scaffold stubs
      }
      await createEntity(
        'rule',
        tenant.id,
        name,
        slug,
        user.id,
        opts,
      )
      terminal.success(
        `Rule '${name}' scaffolded at ${dir} (${visibility}).`,
      )
      break
    }
    case 'deploy': {
      const name = args._[1] as string | undefined
      if (!name) throw new Error('Usage: ar rule deploy <slug>')
      const slug = slugify(name)
      const dir = await resolveRuleDir(reg, slug)
      const result = await validateRule(dir)
      const version = result.manifest.version

      const existing = await getEntityBySlug('rule', tenant.id, slug)
      if (!existing) {
        const opts: {
          visibility: string
          config?: Record<string, unknown>
          version?: string
        } = { visibility, version }
        try {
          opts.config = {
            ...result.manifest,
            description: result.frontmatter.description,
          }
        } catch { /* validation may fail for stubs */ }
        await createEntity(
          'rule',
          tenant.id,
          name,
          slug,
          user.id,
          opts,
        )
      }

      const spin = spinner(`Deploying rule '${slug}@${version}'...`)
      const archive = await compress(dir)
      const gcp = await loadGcp()
      await deployEntity(
        'rule',
        slug,
        tenant.id,
        archive,
        gcp.project,
      )
      spin.succeed(`Rule '${slug}@${version}' deployed.`)
      break
    }
    case 'update': {
      const name = args._[1] as string | undefined
      if (!name) {
        throw new Error(
          'Usage: ar rule update <slug>' +
            ' [-r <registry>] [--visibility public|private]',
        )
      }
      const slug = slugify(name)
      const entity = await getEntityBySlug('rule', tenant.id, slug)
      if (!entity) throw new Error(`Rule '${slug}' not found.`)

      const updates: Record<string, unknown> = {}
      const vis = args.visibility as string | undefined
      if (vis) updates.visibility = vis

      try {
        const dir = await resolveRuleDir(reg, slug)
        const result = await validateRule(dir)
        updates.config = {
          ...result.manifest,
          description: result.frontmatter.description,
        }
        if (result.body) updates.content = result.body
      } catch {
        if (!vis) {
          throw new Error(
            `Rule '${slug}' not found in registry '${reg}'.` +
              ' Pass --visibility to update metadata only.',
          )
        }
      }

      await updateEntity(
        'rule',
        entity.id,
        tenant.id,
        updates,
        user.id,
      )
      terminal.success(`Rule '${slug}' updated.`)
      break
    }
    case 'destroy': {
      const slug = args._[1] as string | undefined
      if (!slug) throw new Error('Usage: ar rule destroy <slug>')
      const entity = await getEntityBySlug('rule', tenant.id, slug)
      if (!entity) throw new Error(`Rule '${slug}' not found.`)
      if (!args.force) {
        const ok = await confirm(
          `Delete rule '${slug}'? This cannot be undone.`,
        )
        if (!ok) {
          terminal.info('Cancelled.')
          return
        }
      }
      await removeEntity('rule', entity.id, tenant.id, user.id)
      terminal.success(`Rule '${slug}' removed from registry.`)
      break
    }
    case 'list': {
      const items = isPublic
        ? await listPublicEntities('rule', tenant.id)
        : await listEntities('rule', tenant.id, user.id)
      if (items.length === 0) {
        terminal.info('No rules found.')
        return
      }
      terminal.table(
        ['NAME', 'SLUG', 'VISIBILITY', 'OWNER'],
        items.map((t) => [t.name, t.slug, t.visibility, t.ownerId]),
      )
      break
    }
    case 'show': {
      const slug = args._[1] as string | undefined
      if (!slug) throw new Error('Usage: ar rule show <slug>')
      const entity = await getEntityBySlug('rule', tenant.id, slug)
      if (!entity) throw new Error(`Rule '${slug}' not found.`)
      terminal.table(
        ['FIELD', 'VALUE'],
        [
          ['Name', entity.name],
          ['Slug', entity.slug],
          ['Version', entity.version],
          ['Visibility', entity.visibility],
          ['Owner', entity.ownerId],
          ['Created', entity.createdAt || '\u2014'],
        ],
      )
      break
    }
    case 'versions': {
      const slug = args._[1] as string | undefined
      if (!slug) throw new Error('Usage: ar rule versions <slug>')
      const items = await listVersions('rule', tenant.id, slug)
      if (items.length === 0) {
        terminal.info(`No versions for rule '${slug}'.`)
        return
      }
      terminal.table(
        ['VERSION', 'VISIBILITY', 'OWNER', 'CREATED'],
        items.map((v) => [
          v.version,
          v.visibility,
          v.ownerId,
          v.createdAt || '\u2014',
        ]),
      )
      break
    }
    case 'clone': {
      const slug = args._[1] as string | undefined
      if (!slug) throw new Error('Usage: ar rule clone <slug>')
      const source = await getEntityBySlug('rule', tenant.id, slug)
      if (!source) throw new Error(`Rule '${slug}' not found.`)
      await opsClone('rule', source.id, tenant.id, user.id)
      terminal.success(`Rule '${slug}' cloned to private registry.`)
      break
    }
    default:
      throw new Error(
        'Usage: ar rule <create|update|deploy|destroy' +
          '|list|show|versions|clone>' +
          " [--public]. Run 'ar help'.",
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

export { commandRouteDefinition, ruleCommand }
export default commandRouteDefinition

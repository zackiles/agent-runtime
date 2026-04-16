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
import { resolveToolDir, toolDir, validateId } from '@ar/client/registry'
import { validate as validateTool } from '@ar/client/tool-schema'
import { compile } from '@ar/client/templates'
import { compress } from '../utils/archive.ts'
import { requireAuth } from '../auth.ts'

const config = await loadConfig()

const OPTIONS = {
  boolean: ['production', 'public', 'force', 'mcp'],
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
  name: 'tool',
  command: toolCommand,
  description: 'Manage tools (create, update, deploy, destroy, list, clone)',
  options: OPTIONS,
}

async function toolCommand(
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
        throw new Error(
          'Usage: ar tool create <name> [--public] [--mcp]',
        )
      }
      validateId(slugify(name), 'tool name')
      if (isPublic && !canPublish(tenant.id, user.id, 'public')) {
        throw new Error(
          'You do not have permission to publish to the' +
            ' public registry.',
        )
      }
      const slug = slugify(name)
      const version = '0.0.1'
      const dir = toolDir(reg, slug, version)

      if (await exists(dir)) {
        throw new Error(
          `Folder '${slug}/${version}' already exists.` +
            ' Choose a different name.',
        )
      }

      await Deno.mkdir(dir, { recursive: true })
      const templateId = args.mcp ? 'tool-mcp' : 'tool-default'
      const files = compile(templateId, { name, slug, version })
      for (const [path, content] of Object.entries(files)) {
        await Deno.writeTextFile(join(dir, path), content)
      }

      const opts: {
        visibility: string
        config?: Record<string, unknown>
        version?: string
      } = { visibility, version }
      try {
        const result = await validateTool(dir)
        opts.config = {
          ...result.manifest,
          description: result.frontmatter.description,
        }
      } catch {
        // validation may fail for scaffold stubs
      }
      await createEntity(
        'tool',
        tenant.id,
        name,
        slug,
        user.id,
        opts,
      )
      terminal.success(
        `Tool '${name}' scaffolded at ${dir} (${visibility}).`,
      )
      break
    }
    case 'deploy': {
      const name = args._[1] as string | undefined
      if (!name) throw new Error('Usage: ar tool deploy <slug>')
      const slug = slugify(name)
      const dir = await resolveToolDir(reg, slug)
      const result = await validateTool(dir)
      const version = result.manifest.version

      const existing = await getEntityBySlug('tool', tenant.id, slug)
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
          'tool',
          tenant.id,
          name,
          slug,
          user.id,
          opts,
        )
      }

      const spin = spinner(`Deploying tool '${slug}@${version}'...`)
      const archive = await compress(dir)
      const gcp = await loadGcp()
      await deployEntity(
        'tool',
        slug,
        tenant.id,
        archive,
        gcp.project,
      )
      spin.succeed(`Tool '${slug}@${version}' deployed.`)
      break
    }
    case 'update': {
      const name = args._[1] as string | undefined
      if (!name) {
        throw new Error(
          'Usage: ar tool update <slug>' +
            ' [-r <registry>] [--visibility public|private]',
        )
      }
      const slug = slugify(name)
      const entity = await getEntityBySlug('tool', tenant.id, slug)
      if (!entity) throw new Error(`Tool '${slug}' not found.`)

      const updates: Record<string, unknown> = {}
      const vis = args.visibility as string | undefined
      if (vis) updates.visibility = vis

      try {
        const dir = await resolveToolDir(reg, slug)
        const result = await validateTool(dir)
        updates.config = {
          ...result.manifest,
          description: result.frontmatter.description,
        }
      } catch {
        if (!vis) {
          throw new Error(
            `Tool '${slug}' not found in registry '${reg}'.` +
              ' Pass --visibility to update metadata only.',
          )
        }
      }

      await updateEntity(
        'tool',
        entity.id,
        tenant.id,
        updates,
        user.id,
      )
      terminal.success(`Tool '${slug}' updated.`)
      break
    }
    case 'destroy': {
      const slug = args._[1] as string | undefined
      if (!slug) throw new Error('Usage: ar tool destroy <slug>')
      const entity = await getEntityBySlug('tool', tenant.id, slug)
      if (!entity) throw new Error(`Tool '${slug}' not found.`)
      if (!args.force) {
        const ok = await confirm(
          `Delete tool '${slug}'? This cannot be undone.`,
        )
        if (!ok) {
          terminal.info('Cancelled.')
          return
        }
      }
      await removeEntity('tool', entity.id, tenant.id, user.id)
      terminal.success(`Tool '${slug}' removed from registry.`)
      break
    }
    case 'list': {
      const items = isPublic
        ? await listPublicEntities('tool', tenant.id)
        : await listEntities('tool', tenant.id, user.id)
      if (items.length === 0) {
        terminal.info('No tools found.')
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
      if (!slug) throw new Error('Usage: ar tool show <slug>')
      const entity = await getEntityBySlug('tool', tenant.id, slug)
      if (!entity) throw new Error(`Tool '${slug}' not found.`)
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
      if (!slug) throw new Error('Usage: ar tool versions <slug>')
      const items = await listVersions('tool', tenant.id, slug)
      if (items.length === 0) {
        terminal.info(`No versions for tool '${slug}'.`)
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
      if (!slug) throw new Error('Usage: ar tool clone <slug>')
      const source = await getEntityBySlug('tool', tenant.id, slug)
      if (!source) throw new Error(`Tool '${slug}' not found.`)
      await opsClone('tool', source.id, tenant.id, user.id)
      terminal.success(`Tool '${slug}' cloned to private registry.`)
      break
    }
    default:
      throw new Error(
        'Usage: ar tool <create|update|deploy|destroy' +
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

export { commandRouteDefinition, toolCommand }
export default commandRouteDefinition

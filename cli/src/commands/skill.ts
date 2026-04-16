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
import { resolveSkillDir, skillDir, validateId } from '@ar/client/registry'
import { validate as validateSkill } from '@ar/client/skill-schema'
import { compile } from '@ar/client/templates'
import { compress } from '../utils/archive.ts'
import { requireAuth } from '../auth.ts'

async function copyDir(src: string, dest: string): Promise<void> {
  await Deno.mkdir(dest, { recursive: true })
  for await (const entry of Deno.readDir(src)) {
    const s = join(src, entry.name)
    const d = join(dest, entry.name)
    if (entry.isDirectory) {
      await copyDir(s, d)
    } else {
      await Deno.copyFile(s, d)
    }
  }
}

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
  name: 'skill',
  command: skillCommand,
  description:
    'Manage skills (create, import, update, deploy, destroy, list, clone)',
  options: OPTIONS,
}

async function skillCommand(
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
        throw new Error('Usage: ar skill create <name> [--public]')
      }
      const slug = slugify(name)
      validateId(slug, 'skill name')
      if (isPublic && !canPublish(tenant.id, user.id, 'public')) {
        throw new Error(
          'You do not have permission to publish to the' +
            ' public registry.',
        )
      }
      const version = '0.0.1'
      const dir = skillDir(reg, slug, version)

      if (await exists(dir)) {
        throw new Error(
          `Folder '${slug}/${version}' already exists.` +
            ' Choose a different name.',
        )
      }

      await Deno.mkdir(dir, { recursive: true })
      const files = compile('skill-default', {
        name,
        slug,
        version,
      })
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
        const result = await validateSkill(dir)
        opts.config = {
          ...result.manifest,
          description: result.frontmatter.description,
        }
        if (result.body) opts.content = result.body
      } catch {
        // validation may fail for scaffold stubs
      }
      await createEntity(
        'skill',
        tenant.id,
        name,
        slug,
        user.id,
        opts,
      )
      terminal.success(
        `Skill '${name}' scaffolded at ${dir} (${visibility}).`,
      )
      break
    }
    case 'deploy': {
      const name = args._[1] as string | undefined
      if (!name) throw new Error('Usage: ar skill deploy <slug>')
      const slug = slugify(name)
      const dir = await resolveSkillDir(reg, slug)
      const result = await validateSkill(dir)
      const version = result.manifest.version

      const existing = await getEntityBySlug('skill', tenant.id, slug)
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
          'skill',
          tenant.id,
          name,
          slug,
          user.id,
          opts,
        )
      }

      const spin = spinner(`Deploying skill '${slug}@${version}'...`)
      const archive = await compress(dir)
      const gcp = await loadGcp()
      await deployEntity(
        'skill',
        slug,
        tenant.id,
        archive,
        gcp.project,
      )
      spin.succeed(`Skill '${slug}@${version}' deployed.`)
      break
    }
    case 'update': {
      const name = args._[1] as string | undefined
      if (!name) {
        throw new Error(
          'Usage: ar skill update <slug>' +
            ' [-r <registry>] [--visibility public|private]',
        )
      }
      const slug = slugify(name)
      const entity = await getEntityBySlug('skill', tenant.id, slug)
      if (!entity) throw new Error(`Skill '${slug}' not found.`)

      const updates: Record<string, unknown> = {}
      const vis = args.visibility as string | undefined
      if (vis) updates.visibility = vis

      try {
        const dir = await resolveSkillDir(reg, slug)
        const result = await validateSkill(dir)
        updates.config = {
          ...result.manifest,
          description: result.frontmatter.description,
        }
        if (result.body) updates.content = result.body
      } catch {
        if (!vis) {
          throw new Error(
            `Skill '${slug}' not found in registry '${reg}'.` +
              ' Pass --visibility to update metadata only.',
          )
        }
      }

      await updateEntity(
        'skill',
        entity.id,
        tenant.id,
        updates,
        user.id,
      )
      terminal.success(`Skill '${slug}' updated.`)
      break
    }
    case 'destroy': {
      const slug = args._[1] as string | undefined
      if (!slug) throw new Error('Usage: ar skill destroy <slug>')
      const entity = await getEntityBySlug(
        'skill',
        tenant.id,
        slug,
      )
      if (!entity) throw new Error(`Skill '${slug}' not found.`)
      if (!args.force) {
        const ok = await confirm(
          `Delete skill '${slug}'? This cannot be undone.`,
        )
        if (!ok) {
          terminal.info('Cancelled.')
          return
        }
      }
      await removeEntity('skill', entity.id, tenant.id, user.id)
      terminal.success(`Skill '${slug}' removed from registry.`)
      break
    }
    case 'list': {
      const items = isPublic
        ? await listPublicEntities('skill', tenant.id)
        : await listEntities('skill', tenant.id, user.id)
      if (items.length === 0) {
        terminal.info('No skills found.')
        return
      }
      terminal.table(
        ['NAME', 'SLUG', 'VISIBILITY', 'OWNER'],
        items.map((t) => [t.name, t.slug, t.visibility, t.ownerId]),
      )
      break
    }
    case 'import': {
      const source = args._[1] as string | undefined
      if (!source) {
        throw new Error(
          'Usage: ar skill import <github-url|owner/repo>' +
            ' [skill-name]',
        )
      }

      const skillName = args._[2] as string | undefined
      let repoUrl = source
      if (/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+$/.test(source)) {
        repoUrl = `https://github.com/${source}.git`
      } else if (!repoUrl.endsWith('.git')) {
        repoUrl = repoUrl.replace(/\/$/, '') + '.git'
      }

      const spin = spinner(`Cloning ${repoUrl}...`)
      const tmp = await Deno.makeTempDir()
      try {
        const clone = new Deno.Command('git', {
          args: ['clone', '--depth', '1', repoUrl, tmp + '/repo'],
          stdout: 'null',
          stderr: 'piped',
        })
        const cloneResult = await clone.output()
        if (!cloneResult.success) {
          const err = new TextDecoder().decode(cloneResult.stderr)
          throw new Error(`Git clone failed: ${err.trim()}`)
        }

        const repoDir = join(tmp, 'repo')
        let skillDir: string | null = null

        if (skillName) {
          const candidate = join(repoDir, skillName)
          if (await exists(join(candidate, 'SKILL.md'))) {
            skillDir = candidate
          } else {
            for (const sub of ['skills', '.claude/skills', '.agents/skills']) {
              const nested = join(repoDir, sub, skillName)
              if (await exists(join(nested, 'SKILL.md'))) {
                skillDir = nested
                break
              }
            }
          }
        }

        if (!skillDir) {
          if (await exists(join(repoDir, 'SKILL.md'))) {
            skillDir = repoDir
          } else {
            for (const sub of ['skills', '.claude/skills', '.agents/skills']) {
              const subDir = join(repoDir, sub)
              if (!await exists(subDir)) continue
              for await (const entry of Deno.readDir(subDir)) {
                if (!entry.isDirectory) continue
                if (await exists(join(subDir, entry.name, 'SKILL.md'))) {
                  skillDir = join(subDir, entry.name)
                  break
                }
              }
              if (skillDir) break
            }
          }
        }

        if (!skillDir) {
          throw new Error(
            'No SKILL.md found in repository. Provide the' +
              ' skill name: ar skill import <repo> <skill-name>',
          )
        }

        const result = await validateSkill(skillDir)
        const slug = result.manifest.slug
        const version = result.manifest.version
        const targetDir = join(
          reg,
          'skills',
          slug,
          version,
        )

        if (await exists(targetDir)) {
          throw new Error(
            `Skill '${slug}/${version}' already exists in` +
              ` registry. Remove it first or bump the version.`,
          )
        }

        await Deno.mkdir(targetDir, { recursive: true })
        for await (const entry of Deno.readDir(skillDir)) {
          const src = join(skillDir, entry.name)
          const dest = join(targetDir, entry.name)
          if (entry.isDirectory) {
            await copyDir(src, dest)
          } else {
            await Deno.copyFile(src, dest)
          }
        }

        const opts: {
          visibility: string
          config?: Record<string, unknown>
          version?: string
          content?: string
        } = {
          visibility,
          version,
          config: {
            ...result.manifest,
            description: result.frontmatter.description,
          },
          content: result.body,
        }
        await createEntity(
          'skill',
          tenant.id,
          result.manifest.name,
          slug,
          user.id,
          opts,
        )
        spin.succeed(
          `Skill '${slug}@${version}' imported to ${targetDir}`,
        )
      } finally {
        await Deno.remove(tmp, { recursive: true }).catch(() => {})
      }
      break
    }
    case 'show': {
      const slug = args._[1] as string | undefined
      if (!slug) throw new Error('Usage: ar skill show <slug>')
      const entity = await getEntityBySlug('skill', tenant.id, slug)
      if (!entity) throw new Error(`Skill '${slug}' not found.`)
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
      if (!slug) throw new Error('Usage: ar skill versions <slug>')
      const items = await listVersions('skill', tenant.id, slug)
      if (items.length === 0) {
        terminal.info(`No versions for skill '${slug}'.`)
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
      if (!slug) throw new Error('Usage: ar skill clone <slug>')
      const source = await getEntityBySlug('skill', tenant.id, slug)
      if (!source) throw new Error(`Skill '${slug}' not found.`)
      await opsClone('skill', source.id, tenant.id, user.id)
      terminal.success(`Skill '${slug}' cloned to private registry.`)
      break
    }
    default:
      throw new Error(
        'Usage: ar skill <create|import|update|deploy' +
          '|destroy|list|show|versions|clone>' +
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

export { commandRouteDefinition, skillCommand }
export default commandRouteDefinition

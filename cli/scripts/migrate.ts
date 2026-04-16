#!/usr/bin/env -S deno run -A
import { exists } from '@std/fs'
import { join } from '@std/path'
import { close, open } from '@ar/client/db'
import { create as createAgent } from '@ar/client/db/agents'
import { DEVELOPMENT } from '@ar/client/tenant'

const registry = Deno.args[0] || join(Deno.cwd(), 'default-registry')

async function migrate(): Promise<void> {
  console.log(`Migrating agent.json files from ${registry}`)

  if (!await exists(registry)) {
    console.log('Registry directory not found.')
    return
  }

  await open(DEVELOPMENT, 'admin')

  let count = 0
  for await (const entry of Deno.readDir(registry)) {
    if (!entry.isDirectory) continue
    const configPath = join(registry, entry.name, 'agent.json')
    if (!await exists(configPath)) continue

    try {
      const raw = await Deno.readTextFile(configPath)
      const config = JSON.parse(raw) as {
        id: string
        version: string
        entryPoint: string
        secrets: string[]
        triggers: Array<{
          type: string
          name: string
          schedule?: string
          timezone?: string
          topic?: string
        }>
      }

      createAgent({
        tenantId: 'development',
        name: config.id,
        slug: config.id,
        version: config.version || '0.0.1',
        createdBy: 'migration@ar-cli',
      })

      count++
      console.log(`  Migrated: ${config.id}`)
    } catch (err) {
      console.error(
        `  Failed to migrate ${entry.name}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }

  await close()
  console.log(`\nMigration complete. ${count} agents imported.`)
}

migrate()

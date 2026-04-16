import type { Plugin, ViteDevServer } from 'vite'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import type { WebSocket } from 'ws'

const LOCK = join(
  dirname(fileURLToPath(import.meta.url)),
  '.vite-dev.pid',
)

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function killExisting(): void {
  if (!existsSync(LOCK)) return
  const pid = Number(readFileSync(LOCK, 'utf-8').trim())
  if (!pid || pid === process.pid) return
  if (!alive(pid)) {
    unlinkSync(LOCK)
    return
  }
  console.log(`[singleton] killing stale dev server (pid ${pid})`)
  try {
    process.kill(pid, 'SIGTERM')
  } catch { /* already gone */ }
  unlinkSync(LOCK)
}

function writeLock(): void {
  writeFileSync(LOCK, String(process.pid), 'utf-8')
}

function removeLock(): void {
  try {
    if (
      existsSync(LOCK) &&
      readFileSync(LOCK, 'utf-8').trim() === String(process.pid)
    ) {
      unlinkSync(LOCK)
    }
  } catch { /* best-effort */ }
}

function closeClients(server: ViteDevServer): void {
  try {
    server.ws.send({ type: 'custom', event: 'ar:shutdown', data: {} })
  } catch { /* best-effort */ }

  setTimeout(() => {
    try {
      const wss = (server.ws as unknown as { clients: Set<WebSocket> }).clients
      for (const client of wss) client.close()
    } catch { /* best-effort */ }
  }, 200)
}

export function singleton(): Plugin {
  let server: ViteDevServer | undefined

  return {
    name: 'ar-singleton',
    configureServer(s) {
      server = s
      killExisting()
      writeLock()

      const cleanup = () => {
        if (server) closeClients(server)
        removeLock()
      }
      process.on('exit', cleanup)
      process.on('SIGINT', () => {
        cleanup()
        process.exit(0)
      })
      process.on('SIGTERM', () => {
        cleanup()
        process.exit(0)
      })
    },

    transformIndexHtml() {
      return [{
        tag: 'script',
        attrs: { type: 'module' },
        children: `
if (import.meta.hot) {
  import.meta.hot.on('ar:shutdown', () => window.close())
}`,
        injectTo: 'head',
      }]
    },
  }
}

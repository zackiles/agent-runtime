const encoder = new TextEncoder()
const SHOW_CURSOR = '\x1b[?25h'
const RESET_STYLE = '\x1b[0m'

let registered = false
let inRawMode = false

function restore(): void {
  try {
    if (inRawMode && Deno.stdin.isTerminal()) {
      Deno.stdin.setRaw(false)
      inRawMode = false
    }
  } catch { /* already restored */ }
  try {
    Deno.stdout.writeSync(encoder.encode(SHOW_CURSOR + RESET_STYLE))
  } catch { /* pipe closed */ }
}

function registerCleanup(): void {
  if (registered) return
  registered = true

  const onSignal = () => {
    restore()
    Deno.exit(130)
  }

  try {
    Deno.addSignalListener('SIGINT', onSignal)
    Deno.addSignalListener('SIGTERM', onSignal)
  } catch { /* Windows: only SIGINT supported */ }

  globalThis.addEventListener('unhandledrejection', () => restore())
  globalThis.addEventListener('error', () => restore())
}

async function withRawMode<T>(fn: () => Promise<T>): Promise<T> {
  if (!Deno.stdin.isTerminal()) {
    return await fn()
  }
  Deno.stdin.setRaw(true)
  inRawMode = true
  try {
    return await fn()
  } finally {
    if (inRawMode) {
      Deno.stdin.setRaw(false)
      inRawMode = false
    }
  }
}

export { registerCleanup, restore, withRawMode }

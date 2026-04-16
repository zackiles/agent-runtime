import { cyan, dim, green, red } from '@std/fmt/colors'
import { isJsonMode, width, write, writeln } from './output.ts'

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const INTERVAL_MS = 80
const CLEAR_LINE = '\x1b[2K\r'

interface Spinner {
  update: (msg: string) => void
  succeed: (msg: string) => void
  fail: (msg: string) => void
  stop: () => void
}

function isTTY(): boolean {
  try {
    return Deno.stdout.isTerminal()
  } catch {
    return false
  }
}

function spinner(message: string): Spinner {
  if (isJsonMode()) {
    return { update() {}, succeed() {}, fail() {}, stop() {} }
  }

  if (!isTTY()) {
    writeln(`${dim('→')} ${dim(message)}`)
    return {
      update(msg: string) {
        writeln(`${dim('→')} ${dim(msg)}`)
      },
      succeed(msg: string) {
        writeln(`${green('✓')} ${msg}`)
      },
      fail(msg: string) {
        writeln(`${red('✗')} ${msg}`)
      },
      stop() {},
    }
  }

  let frame = 0
  let text = message

  const timer = setInterval(() => {
    const symbol = cyan(FRAMES[frame % FRAMES.length])
    const maxText = width() - 3
    const display = text.length > maxText
      ? text.slice(0, Math.max(0, maxText - 1)) + '…'
      : text
    write(`${CLEAR_LINE}${symbol} ${display}`)
    frame++
  }, INTERVAL_MS)

  return {
    update(msg: string) {
      text = msg
    },
    succeed(msg: string) {
      clearInterval(timer)
      writeln(`${CLEAR_LINE}${green('✓')} ${msg}`)
    },
    fail(msg: string) {
      clearInterval(timer)
      writeln(`${CLEAR_LINE}${red('✗')} ${msg}`)
    },
    stop() {
      clearInterval(timer)
      write(CLEAR_LINE)
    },
  }
}

export { spinner }
export type { Spinner }

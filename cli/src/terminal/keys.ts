const ANSI_KEY_MAP: Record<string, string> = {
  '\x1b[A': 'ArrowUp',
  '\x1b[B': 'ArrowDown',
  '\x1b[C': 'ArrowRight',
  '\x1b[D': 'ArrowLeft',
  '\x1b[H': 'Home',
  '\x1b[F': 'End',
  '\x1b[1~': 'Home',
  '\x1b[4~': 'End',
  '\x1b[3~': 'Delete',
  '\x1b[5~': 'PageUp',
  '\x1b[6~': 'PageDown',
  '\x7f': 'Backspace',
  '\x08': 'Backspace',
  '\x1b': 'Escape',
  '\t': 'Tab',
  '\r': 'Enter',
  '\n': 'Enter',
} as const

interface KeyEvent {
  key: string
  ctrl: boolean
  shift: boolean
}

const decoder = new TextDecoder()

async function readKey(): Promise<KeyEvent> {
  const buf = new Uint8Array(16)
  const n = await Deno.stdin.read(buf)
  if (n === null) return { key: '', ctrl: false, shift: false }

  const raw = decoder.decode(buf.subarray(0, n))

  if (raw === '\x03') {
    return { key: 'c', ctrl: true, shift: false }
  }

  for (const [seq, name] of Object.entries(ANSI_KEY_MAP)) {
    if (raw.startsWith(seq)) {
      return { key: name, ctrl: false, shift: false }
    }
  }

  if (raw.length === 1) {
    const code = raw.charCodeAt(0)
    if (code >= 1 && code <= 26) {
      return {
        key: String.fromCharCode(code + 96),
        ctrl: true,
        shift: false,
      }
    }
    return { key: raw, ctrl: false, shift: false }
  }

  return { key: raw, ctrl: false, shift: false }
}

export { ANSI_KEY_MAP, readKey }
export type { KeyEvent }

import { bold, cyan, dim, green } from '@std/fmt/colors'
import { readKey } from './keys.ts'
import { restore, withRawMode } from './cleanup.ts'
import { visibleWidth, width as termWidth, write, writeln } from './output.ts'

let interactive = true

function setInteractive(value: boolean): void {
  interactive = value
}

function isInteractive(): boolean {
  return interactive
}

const HIDE_CURSOR = '\x1b[?25l'
const SHOW_CURSOR = '\x1b[?25h'

function clearLines(text: string): void {
  const cols = termWidth()
  const lines = Math.max(1, Math.ceil(visibleWidth(text) / cols))
  if (lines > 1) write(`\x1b[${lines - 1}A`)
  write('\r\x1b[0J')
}

interface ConfirmOptions {
  default?: boolean
  quiet?: boolean
}

async function confirm(
  message: string,
  opts?: ConfirmOptions,
): Promise<boolean> {
  const defaultValue = opts?.default ?? true
  if (!interactive) return defaultValue

  if (!Deno.stdin.isTerminal()) return defaultValue

  write(HIDE_CURSOR)

  let value = defaultValue
  let lastOutput = ''

  function render(): void {
    if (lastOutput) clearLines(lastOutput)
    const yes = value ? cyan(bold('● Yes')) : dim('○ Yes')
    const no = !value ? cyan(bold('● No')) : dim('○ No')
    lastOutput = `${green('?')} ${bold(message)}  ${yes}  ${no}`
    write(lastOutput)
  }

  try {
    const result = await withRawMode(async () => {
      render()
      while (true) {
        const event = await readKey()

        if (event.ctrl && event.key === 'c') {
          if (lastOutput) clearLines(lastOutput)
          write(SHOW_CURSOR)
          restore()
          Deno.exit(130)
        }

        switch (event.key) {
          case 'y':
          case 'Y':
            value = true
            render()
            break
          case 'n':
          case 'N':
            value = false
            render()
            break
          case 'ArrowLeft':
          case 'ArrowRight':
          case 'Tab':
            value = !value
            render()
            break
          case 'Enter':
            return value
          case 'Escape':
            return false
        }
      }
    })

    if (lastOutput) clearLines(lastOutput)
    if (opts?.quiet) {
      write(SHOW_CURSOR)
    } else {
      const display = result ? green('Yes') : dim('No')
      write(`${green('✓')} ${message} ${display}\n`)
      write(SHOW_CURSOR)
    }
    return result
  } catch {
    if (lastOutput) clearLines(lastOutput)
    write(SHOW_CURSOR)
    return defaultValue
  }
}

interface TextOptions {
  default?: string
  flag?: string
  validate?: (value: string) => string | true
  mask?: boolean
  quiet?: boolean
}

async function text(
  message: string,
  opts?: TextOptions,
): Promise<string> {
  if (!interactive) {
    if (opts?.default !== undefined) return opts.default
    const flagHint = opts?.flag ? ` Provide --${opts.flag} instead.` : ''
    throw new Error(
      `Cannot prompt for "${message}" in non-interactive mode.${flagHint}`,
    )
  }

  if (!Deno.stdin.isTerminal()) {
    if (opts?.default !== undefined) return opts.default
    throw new Error(`Cannot prompt for "${message}" without a TTY.`)
  }

  let value = opts?.default ?? ''
  let cursor = value.length
  let errorMsg = ''
  let lastOutput = ''

  function render(): void {
    if (lastOutput) clearLines(lastOutput)
    const suffix = opts?.default && !value ? dim(` (${opts.default})`) : ''
    const display = opts?.mask ? '•'.repeat(value.length) : value
    const before = display.slice(0, cursor)
    const cursorChar = cursor < display.length ? display[cursor] : ' '
    const after = cursor < display.length ? display.slice(cursor + 1) : ''
    const cursorDisplay = `\x1b[7m${cursorChar}\x1b[27m`
    const errDisplay = errorMsg ? `  ${dim(`(${errorMsg})`)}` : ''
    lastOutput = `${green('?')} ${bold(message)}${suffix}: ` +
      `${before}${cursorDisplay}${after}${errDisplay}`
    write(lastOutput)
  }

  try {
    const result = await withRawMode(async () => {
      render()
      while (true) {
        const event = await readKey()
        errorMsg = ''

        if (event.ctrl && event.key === 'c') {
          if (lastOutput) clearLines(lastOutput)
          write(SHOW_CURSOR)
          restore()
          Deno.exit(130)
        }

        switch (event.key) {
          case 'Enter': {
            const final = value || opts?.default || ''
            if (opts?.validate) {
              const result = opts.validate(final)
              if (result !== true) {
                errorMsg = result
                render()
                continue
              }
            }
            return final
          }
          case 'Escape':
            return opts?.default || ''
          case 'Backspace':
            if (cursor > 0) {
              value = value.slice(0, cursor - 1) + value.slice(cursor)
              cursor--
            }
            break
          case 'Delete':
            if (cursor < value.length) {
              value = value.slice(0, cursor) + value.slice(cursor + 1)
            }
            break
          case 'ArrowLeft':
            if (cursor > 0) cursor--
            break
          case 'ArrowRight':
            if (cursor < value.length) cursor++
            break
          case 'Home':
            cursor = 0
            break
          case 'End':
            cursor = value.length
            break
          default:
            if (event.key.length === 1 && !event.ctrl) {
              const code = event.key.charCodeAt(0)
              if (code >= 32) {
                value = value.slice(0, cursor) + event.key +
                  value.slice(cursor)
                cursor++
              }
            }
        }
        render()
      }
    })

    if (lastOutput) clearLines(lastOutput)
    if (opts?.quiet) {
      write(SHOW_CURSOR)
    } else {
      const display = opts?.mask ? '•'.repeat(result.length) : result
      writeln(
        `${green('✓')} ${message}: ${display || dim('(empty)')}`,
      )
    }
    return result
  } catch {
    if (lastOutput) clearLines(lastOutput)
    write(SHOW_CURSOR)
    return opts?.default || ''
  }
}

interface SelectOption<T> {
  label: string
  value: T
  description?: string
}

interface SelectConfig {
  quiet?: boolean
}

async function select<T>(
  message: string,
  options: SelectOption<T>[],
  config?: SelectConfig,
): Promise<T> {
  if (!interactive || !Deno.stdin.isTerminal()) {
    return options[0].value
  }

  if (options.length === 0) {
    throw new Error('select() requires at least one option.')
  }

  let selected = 0

  function pageSize(): number {
    try {
      return Math.max(3, Deno.consoleSize().rows - 4)
    } catch {
      return 10
    }
  }

  function physicalLines(text: string): number {
    const cols = termWidth()
    let count = 0
    for (const line of text.split('\n')) {
      count += Math.max(1, Math.ceil(visibleWidth(line) / cols))
    }
    return count
  }

  function render(): void {
    const ps = pageSize()
    const start = Math.max(
      0,
      Math.min(selected - Math.floor(ps / 2), options.length - ps),
    )
    const end = Math.min(start + ps, options.length)

    const lines: string[] = []
    lines.push(`${green('?')} ${bold(message)}`)
    for (let i = start; i < end; i++) {
      const opt = options[i]
      let line = i === selected
        ? `  ${cyan('›')} ${cyan(opt.label)}`
        : `    ${dim(opt.label)}`
      if (opt.description) line += dim(` — ${opt.description}`)
      lines.push(line)
    }
    if (options.length > ps) {
      lines.push(dim(`  ${start + 1}–${end} of ${options.length}`))
    }

    const output = lines.join('\n') + '\n'
    const physical = physicalLines(lines.join('\n'))

    write(HIDE_CURSOR)
    if (lastPhysicalLines > 0) {
      write(`\x1b[${lastPhysicalLines}A`)
    }
    write('\x1b[0J')
    write(output)
    lastPhysicalLines = physical
  }

  const initialLines = Math.min(options.length, pageSize()) + 3
  let lastPhysicalLines = initialLines
  for (let i = 0; i < initialLines; i++) writeln('')

  try {
    const result = await withRawMode(async () => {
      render()
      while (true) {
        const event = await readKey()

        if (event.ctrl && event.key === 'c') {
          write(SHOW_CURSOR)
          restore()
          Deno.exit(130)
        }

        switch (event.key) {
          case 'ArrowUp':
            selected = selected > 0 ? selected - 1 : options.length - 1
            render()
            break
          case 'ArrowDown':
            selected = selected < options.length - 1 ? selected + 1 : 0
            render()
            break
          case 'Home':
            selected = 0
            render()
            break
          case 'End':
            selected = options.length - 1
            render()
            break
          case 'Enter':
            return options[selected].value
          case 'Escape':
            return options[0].value
        }
      }
    })

    write(SHOW_CURSOR)
    if (lastPhysicalLines > 0) {
      write(`\x1b[${lastPhysicalLines}A`)
    }
    write('\x1b[0J')
    if (!config?.quiet) {
      const label = options.find((o) => o.value === result)?.label ?? ''
      writeln(`${green('✓')} ${message}: ${cyan(label)}`)
    }
    return result
  } catch {
    write(SHOW_CURSOR)
    if (lastPhysicalLines > 0) {
      write(`\x1b[${lastPhysicalLines}A`)
    }
    write('\x1b[0J')
    return options[0].value
  }
}

export { confirm, isInteractive, select, setInteractive, text }
export type { ConfirmOptions, SelectConfig, SelectOption, TextOptions }

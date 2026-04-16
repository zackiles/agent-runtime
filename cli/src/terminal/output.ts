import {
  bold,
  cyan,
  dim,
  green,
  red,
  stripAnsiCode,
  yellow,
} from '@std/fmt/colors'
import { unicodeWidth } from '@std/cli'

const encoder = new TextEncoder()

let jsonMode = false

function setJsonMode(enabled: boolean): void {
  jsonMode = enabled
}

function isJsonMode(): boolean {
  return jsonMode
}

function width(): number {
  try {
    return Deno.consoleSize().columns
  } catch {
    return 80
  }
}

function write(msg: string): void {
  Deno.stdout.writeSync(encoder.encode(msg))
}

function writeln(msg: string): void {
  write(`${msg}\n`)
}

function print(msg: string): void {
  writeln(msg)
}

function blank(): void {
  writeln('')
}

function success(msg: string): void {
  writeln(`${green('✓')} ${msg}`)
}

function error(msg: string): void {
  writeln(`${red('✗')} ${msg}`)
}

function warn(msg: string): void {
  writeln(`${yellow('⚠')} ${msg}`)
}

function info(msg: string): void {
  writeln(`${cyan('ℹ')} ${msg}`)
}

function step(msg: string): void {
  writeln(`${dim('→')} ${dim(msg)}`)
}

function hint(msg: string): void {
  writeln(dim(`  ${msg}`))
}

function heading(text: string): void {
  writeln(bold(text))
  rule()
}

function rule(char = '─'): void {
  const w = Math.min(width(), 60)
  writeln(dim(char.repeat(w)))
}

function keyValue(pairs: [string, string][]): void {
  if (pairs.length === 0) return
  const maxLabel = Math.max(...pairs.map(([k]) => visibleWidth(k)))
  for (const [k, v] of pairs) {
    const pad = ' '.repeat(maxLabel - visibleWidth(k))
    writeln(`  ${dim(k + ':')}${pad} ${v}`)
  }
}

function table(headers: string[], rows: string[][]): void {
  if (rows.length === 0) return

  const colCount = headers.length
  const widths = headers.map((h) => visibleWidth(h))

  for (const row of rows) {
    for (let i = 0; i < colCount; i++) {
      const w = visibleWidth(row[i] ?? '')
      if (w > widths[i]) widths[i] = w
    }
  }

  const maxWidth = width() - 2
  const totalWidth = widths.reduce((a, b) => a + b, 0) + (colCount - 1) * 2
  if (totalWidth > maxWidth) {
    const lastIdx = colCount - 1
    const otherWidth = widths.slice(0, lastIdx).reduce((a, b) => a + b, 0) +
      (colCount - 1) * 2
    widths[lastIdx] = Math.max(10, maxWidth - otherWidth)
  }

  const headerLine = headers
    .map((h, i) => padRight(h, widths[i]))
    .join('  ')
  writeln(bold(headerLine))

  for (const row of rows) {
    const line = row
      .map((cell, i) => {
        const val = cell ?? ''
        return i < colCount - 1
          ? padRight(val, widths[i])
          : truncate(val, widths[i])
      })
      .join('  ')
    writeln(line)
  }
}

function list(items: string[], bullet = '•'): void {
  for (const item of items) {
    writeln(`  ${dim(bullet)} ${item}`)
  }
}

function json(data: unknown): void {
  writeln(JSON.stringify(data, null, 2))
}

function visibleWidth(text: string): number {
  return unicodeWidth(stripAnsiCode(text))
}

function padRight(text: string, targetWidth: number): string {
  const w = visibleWidth(text)
  if (w >= targetWidth) return text
  return text + ' '.repeat(targetWidth - w)
}

function truncate(text: string, maxWidth: number): string {
  if (visibleWidth(text) <= maxWidth) return text
  const plain = stripAnsiCode(text)
  let result = ''
  let currentWidth = 0
  for (const char of plain) {
    const charWidth = unicodeWidth(char)
    if (currentWidth + charWidth > maxWidth - 1) break
    result += char
    currentWidth += charWidth
  }
  return result + '…'
}

export {
  blank,
  error,
  heading,
  hint,
  info,
  isJsonMode,
  json,
  keyValue,
  list,
  padRight,
  print,
  rule,
  setJsonMode,
  step,
  success,
  table,
  visibleWidth,
  warn,
  width,
  write,
  writeln,
}

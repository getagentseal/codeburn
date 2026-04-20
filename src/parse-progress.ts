import type { SourceProgressReporter } from './parser.js'

export function createTerminalProgressReporter(
  enabled: boolean,
  stream: NodeJS.WriteStream = process.stderr,
): SourceProgressReporter | null {
  if (!enabled || !stream.isTTY) return null

  let total = 0
  let current = 0
  let lastLineLength = 0
  let active = false

  function writeLine(line: string, done = false) {
    const pad = lastLineLength > line.length ? ' '.repeat(lastLineLength - line.length) : ''
    lastLineLength = Math.max(lastLineLength, line.length)
    stream.write(`${line}${pad}${done ? '\n' : '\r'}`)
  }

  return {
    start(label: string, nextTotal: number) {
      total = nextTotal
      current = 0
      lastLineLength = 0
      active = nextTotal > 0
      if (active) writeLine(`${label} 0/${total}`)
    },
    advance(itemLabel: string) {
      if (!active) return
      current += 1
      writeLine(`Updating cache ${current}/${total}${itemLabel ? ` ${itemLabel}` : ''}`)
    },
    finish() {
      if (!active) return
      writeLine(`Updating cache ${current}/${total}`, true)
      active = false
      total = 0
      current = 0
      lastLineLength = 0
    },
  }
}

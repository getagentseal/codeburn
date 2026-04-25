import { basename } from 'path'

import { stripAnsi } from './ansi.js'

function stripQuotedStrings(command: string): string {
  return command.replace(/"[^"]*"|'[^']*'/g, match => ' '.repeat(match.length))
}

export function extractBashCommands(rawCommand: string): string[] {
  if (!rawCommand || !rawCommand.trim()) return []

  // Bash inputs in session JSONL can carry ANSI escape sequences (terminal pastes,
  // colorized command-line snippets). Stripping here keeps `bashBreakdown` keys
  // and any other downstream display free of raw escape codes.
  const command = stripAnsi(rawCommand)
  const stripped = stripQuotedStrings(command)

  const separatorRegex = /\s*(?:&&|;|\|)\s*/g
  const separators: Array<{ start: number; end: number }> = []
  let match: RegExpExecArray | null

  while ((match = separatorRegex.exec(stripped)) !== null) {
    separators.push({ start: match.index, end: match.index + match[0].length })
  }

  const ranges: Array<[number, number]> = []
  let cursor = 0
  for (const sep of separators) {
    ranges.push([cursor, sep.start])
    cursor = sep.end
  }
  ranges.push([cursor, command.length])

  const commands: string[] = []
  for (const [start, end] of ranges) {
    const segment = command.slice(start, end).trim()
    if (!segment) continue

    const tokens = segment.split(/\s+/)
    let i = 0
    while (i < tokens.length && /^\w+=/.test(tokens[i]!)) i++
    const base = i < tokens.length ? basename(tokens[i]!) : ''

    if (base && base !== 'cd' && base !== 'true' && base !== 'false') {
      commands.push(base)
    }
  }

  return commands
}

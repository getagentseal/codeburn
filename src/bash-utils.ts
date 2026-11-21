import { basename } from 'path'
import stripAnsi from 'strip-ansi'

const WHITESPACE = /\s/

function stripQuotedStrings(command: string): string {
  return command.replace(/"[^"]*"|'[^']*'/g, match => ' '.repeat(match.length))
}

const HEREDOC_START = /<<(?!<)-?[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|\\?(\w+))/y

// A newline separates commands like ';' does. A command with more than one line
// is scanned once: quoted text, comments and heredoc bodies are blanked, and an
// unquoted newline becomes ';' unless an odd run of backslashes continues the
// line. The result keeps the input's length, because callers slice the original
// string with indices taken from it. A single-line command is masked as before.
function maskForSplitting(command: string): string {
  if (!command.includes('\n')) return stripQuotedStrings(command)
  let out = ''
  const delimiters: string[] = []
  let i = 0
  while (i < command.length) {
    const ch = command[i]!
    if (ch === '"' || ch === "'") {
      const close = command.indexOf(ch, i + 1)
      if (close !== -1) {
        out += ' '.repeat(close + 1 - i)
        i = close + 1
        continue
      }
    } else if (ch === '#' && (i === 0 || /[\s;&|()]/.test(command[i - 1]!))) {
      let lineEnd = command.indexOf('\n', i)
      if (lineEnd === -1) lineEnd = command.length
      out += ' '.repeat(lineEnd - i)
      i = lineEnd
      continue
    } else if (ch === '<' && command[i - 1] !== '<') {
      HEREDOC_START.lastIndex = i
      const match = HEREDOC_START.exec(command)
      if (match) delimiters.push(match[1] ?? match[2] ?? match[3]!)
    } else if (ch === '\n') {
      let backslashes = 0
      let j = command[i - 1] === '\r' ? i - 2 : i - 1
      while (j >= 0 && command[j] === '\\') { backslashes++; j-- }
      if (backslashes % 2 === 1) {
        out += ch
        i++
        continue
      }
      out += ';'
      i++
      // Heredoc bodies start on the next line, one after another, each up to
      // its closing delimiter line. An unclosed body runs to the end.
      let end = i
      for (let d = 0; d < delimiters.length && end < command.length; d++) {
        let lineStart = d === 0 ? end : end + 1
        end = command.length
        while (lineStart < command.length) {
          let lineEnd = command.indexOf('\n', lineStart)
          if (lineEnd === -1) lineEnd = command.length
          if (command.slice(lineStart, lineEnd).trim() === delimiters[d]) {
            end = lineEnd
            break
          }
          lineStart = lineEnd + 1
        }
      }
      delimiters.length = 0
      out += ' '.repeat(end - i)
      i = end
      continue
    }
    out += ch
    i++
  }
  return out
}

const COMMAND_PREFIXES = new Set([
  'sudo', 'doas',
  'npx', 'bunx',
  'time',
  'nice', 'nohup', 'stdbuf',
  'rtk',
])

export function extractBashCommands(rawCommand: string): string[] {
  if (!rawCommand || !rawCommand.trim()) return []

  const command = stripAnsi(rawCommand)
  const stripped = maskForSplitting(command)

  // Match the separator alone, then widen over surrounding whitespace by hand.
  // /\s*(?:&&|;|\|)\s*/ retried its leading \s* from every offset, quadratic on
  // long whitespace-heavy commands. Widening is required (not cosmetic): stripQuotedStrings
  // blanks quoted text, and segments are sliced from the original string.
  const separatorRegex = /(?:&&|;|\|)/g
  const separators: Array<{ start: number; end: number }> = []
  let match: RegExpExecArray | null

  while ((match = separatorRegex.exec(stripped)) !== null) {
    let start = match.index
    while (start > 0 && WHITESPACE.test(stripped[start - 1]!)) start--
    let end = match.index + match[0].length
    while (end < stripped.length && WHITESPACE.test(stripped[end]!)) end++
    const prevEnd = separators[separators.length - 1]?.end ?? 0
    separators.push({ start: Math.max(start, prevEnd), end })
    separatorRegex.lastIndex = end
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
    while (i < tokens.length) {
      if (/^\w+=/.test(tokens[i]!)) { i++; continue }
      const next = tokens[i + 1]
      if (
        next !== undefined &&
        COMMAND_PREFIXES.has(basename(tokens[i]!)) &&
        !next.startsWith('-') &&
        !/["']/.test(next)
      ) { i++; continue }
      break
    }
    const base = i < tokens.length ? basename(tokens[i]!) : ''

    if (base && base !== 'cd' && base !== 'true' && base !== 'false') {
      commands.push(base)
    }
  }

  return commands
}

// Read-shaped shell commands: they inspect state and cannot modify the
// worktree, so (1) the read-edit-ratio detector counts them as reads and
// (2) retry detection does NOT treat them as a verification step between two
// edits of the same file (#941 — both detectors previously disagreed about
// the same Bash call, scoring rg-first workflows as reckless AND reworked).
const READ_ONLY_BASH = new Set([
  'rg', 'grep', 'egrep', 'fgrep', 'ag',
  'cat', 'head', 'tail', 'less', 'more',
  'ls', 'find', 'fd', 'tree',
  'wc', 'stat', 'file', 'du', 'df',
  'which', 'type', 'pwd', 'printenv', 'env',
  'readlink', 'realpath', 'basename', 'dirname',
  'jq', 'diff',
])

// git subcommands that only inspect history/state. Deliberately excludes
// anything that can create or mutate under any flag (branch, tag, stash,
// remote), so a mutation is never misread as a read.
const GIT_READ_SUBCOMMANDS = new Set([
  'log', 'diff', 'status', 'show', 'blame', 'grep',
  'shortlog', 'describe', 'rev-parse', 'ls-files',
])

/// True when EVERY segment of the raw command line (split on &&, ;, |) is a
/// read-only inspection command. A single mutating segment makes the whole
/// call non-read (`cat x && sed -i ...` edits). Unknown commands are
/// non-read: the conservative default both call sites want.
export function isReadShapedBashCommand(rawCommand: string): boolean {
  if (!rawCommand || !rawCommand.trim()) return false
  const stripped = maskForSplitting(stripAnsi(rawCommand))
  const segments = stripped.split(/(?:&&|;|\|)/)
  let sawCommand = false
  for (const segment of segments) {
    const trimmed = segment.trim()
    if (!trimmed) continue
    const tokens = trimmed.split(/\s+/)
    let i = 0
    while (i < tokens.length && (/^\w+=/.test(tokens[i]!) || COMMAND_PREFIXES.has(basename(tokens[i]!)))) i++
    const base = i < tokens.length ? basename(tokens[i]!) : ''
    if (!base) continue
    sawCommand = true
    if (base === 'git') {
      const sub = tokens[i + 1]
      if (!sub || !GIT_READ_SUBCOMMANDS.has(sub)) return false
      continue
    }
    if (!READ_ONLY_BASH.has(base)) return false
  }
  return sawCommand
}

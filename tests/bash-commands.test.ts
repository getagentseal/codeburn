import { describe, it, expect } from 'vitest'
import { basename } from 'path'
import stripAnsi from 'strip-ansi'
import { extractBashCommands, isReadShapedBashCommand } from '../src/bash-utils.js'
import { BASH_TOOLS } from '../src/classifier.js'

describe('extractBashCommands', () => {
  it('extracts single command', () => {
    expect(extractBashCommands('git status')).toEqual(['git'])
  })

  it('extracts chained commands with &&', () => {
    expect(extractBashCommands('git add . && git commit -m "x"')).toEqual(['git', 'git'])
  })

  it('extracts chained commands with ;', () => {
    expect(extractBashCommands('ls; pwd')).toEqual(['ls', 'pwd'])
  })

  it('extracts piped commands', () => {
    expect(extractBashCommands('cat file | grep pattern')).toEqual(['cat', 'grep'])
  })

  it('filters out cd', () => {
    expect(extractBashCommands('cd /path && git status')).toEqual(['git'])
  })

  it('returns empty for cd only', () => {
    expect(extractBashCommands('cd /path')).toEqual([])
  })

  it('returns empty for empty string', () => {
    expect(extractBashCommands('')).toEqual([])
  })

  it('returns empty for whitespace only', () => {
    expect(extractBashCommands('   ')).toEqual([])
  })

  it('extracts basename from full path binary', () => {
    expect(extractBashCommands('/usr/bin/git status')).toEqual(['git'])
  })

  it('handles mixed separators', () => {
    expect(extractBashCommands('cd /x && npm install; npm run build | tee log')).toEqual(['npm', 'npm', 'tee'])
  })

  it('handles extra whitespace', () => {
    expect(extractBashCommands('  git   status  ')).toEqual(['git'])
  })

  it('handles command with quotes containing separators', () => {
    expect(extractBashCommands('echo "hello && world"')).toEqual(['echo'])
  })

  it('handles quoted separators followed by real separator', () => {
    expect(extractBashCommands('echo "hello && world" && git status')).toEqual(['echo', 'git'])
  })

  it('handles single-quoted separators', () => {
    expect(extractBashCommands("echo 'hello && world'")).toEqual(['echo'])
  })

  it('skips leading env var assignments', () => {
    expect(extractBashCommands('NODE_ENV=prod npm test')).toEqual(['npm'])
    expect(extractBashCommands('FOO=bar BAZ=qux ls -la')).toEqual(['ls'])
  })

  it('skips standalone true/false', () => {
    expect(extractBashCommands('true && git status')).toEqual(['git'])
    expect(extractBashCommands('false || echo done')).toEqual(['echo'])
    expect(extractBashCommands('true')).toEqual([])
  })

  it('handles env vars combined with chained commands', () => {
    expect(extractBashCommands('NODE_ENV=test npm test && git push')).toEqual(['npm', 'git'])
  })

  it('skips command wrapper prefixes', () => {
    expect(extractBashCommands('rtk git status')).toEqual(['git'])
    expect(extractBashCommands('sudo npm install')).toEqual(['npm'])
    expect(extractBashCommands('npx vitest --run')).toEqual(['vitest'])
  })

  it('skips prefix combined with env var assignment', () => {
    expect(extractBashCommands('DEBUG=1 rtk git status')).toEqual(['git'])
  })

  it('skips nested wrapper prefixes', () => {
    expect(extractBashCommands('sudo npx vitest --run')).toEqual(['vitest'])
  })

  it('skips prefix across chained commands', () => {
    expect(extractBashCommands('rtk git add . && rtk git commit -m "msg"')).toEqual(['git', 'git'])
  })

  it('keeps a standalone prefix with no following command', () => {
    expect(extractBashCommands('rtk')).toEqual(['rtk'])
    expect(extractBashCommands('sudo')).toEqual(['sudo'])
  })

  it('keeps prefix when the next token is a flag', () => {
    expect(extractBashCommands('nice -n 10 git push')).toEqual(['nice'])
  })

  it('skips env assignment that follows a wrapper prefix', () => {
    expect(extractBashCommands('sudo NODE_ENV=production node server.js')).toEqual(['node'])
    expect(extractBashCommands('time FOO=1 make build')).toEqual(['make'])
  })

  it('keeps prefix when the next token is quoted', () => {
    expect(extractBashCommands('npx "@angular/cli" new app')).toEqual(['npx'])
    expect(extractBashCommands("npx 'ts-node' script.ts")).toEqual(['npx'])
  })

  it('treats an unquoted newline as a command separator', () => {
    expect(extractBashCommands('git status\nnpm test')).toEqual(['git', 'npm'])
    expect(extractBashCommands('cd /tmp\nnpm test\nls')).toEqual(['npm', 'ls'])
    expect(extractBashCommands('ls\r\nwc -l')).toEqual(['ls', 'wc'])
    expect(extractBashCommands('echo a &&\n  echo b')).toEqual(['echo', 'echo'])
  })

  it('does not split on a newline inside quotes, a continuation or a heredoc body', () => {
    expect(extractBashCommands('git commit -m "a\nb"\nnpm test')).toEqual(['git', 'npm'])
    expect(extractBashCommands('ls \\\n -la')).toEqual(['ls'])
    expect(extractBashCommands('cat <<EOF\nrm -rf x\nEOF\nls')).toEqual(['cat', 'ls'])
    expect(extractBashCommands("cat <<-'EOF'\n\trm x\n\tEOF\npwd")).toEqual(['cat', 'pwd'])
    expect(extractBashCommands("cat <<EOF\nit's here\nEOF\nrm 'x'")).toEqual(['cat', 'rm'])
    expect(extractBashCommands('cat <<A <<B\na\nA\nrm x\nB\nls')).toEqual(['cat', 'ls'])
    expect(extractBashCommands('ls \\\r\n -la')).toEqual(['ls'])
  })

  it('splits after an escaped backslash and skips comment lines', () => {
    expect(extractBashCommands('echo a \\\\\nrm x')).toEqual(['echo', 'rm'])
    expect(extractBashCommands("# don't skip\ngit status\nnpm test # it's")).toEqual(['git', 'npm'])
  })
})

describe('BASH_TOOLS', () => {
  it('recognizes Bash', () => { expect(BASH_TOOLS.has('Bash')).toBe(true) })
  it('recognizes BashTool', () => { expect(BASH_TOOLS.has('BashTool')).toBe(true) })
  it('rejects unknown tools', () => { expect(BASH_TOOLS.has('Read')).toBe(false) })
})

// Regression coverage for the quadratic -> linear separator-matching rewrite.
// The old regex (/\s*(?:&&|;|\|)\s*/g, and the equivalent split form) is kept
// here verbatim as a reference so new/old output can be diffed on tricky inputs.
describe('separator regex fix: parity with pre-fix implementation', () => {
  function stripQuotedStringsRef(command: string): string {
    return command.replace(/"[^"]*"|'[^']*'/g, match => ' '.repeat(match.length))
  }

  const COMMAND_PREFIXES_REF = new Set([
    'sudo', 'doas',
    'npx', 'bunx',
    'time',
    'nice', 'nohup', 'stdbuf',
    'rtk',
  ])

  const READ_ONLY_BASH_REF = new Set([
    'rg', 'grep', 'egrep', 'fgrep', 'ag',
    'cat', 'head', 'tail', 'less', 'more',
    'ls', 'find', 'fd', 'tree',
    'wc', 'stat', 'file', 'du', 'df',
    'which', 'type', 'pwd', 'printenv', 'env',
    'readlink', 'realpath', 'basename', 'dirname',
    'jq', 'diff',
  ])

  const GIT_READ_SUBCOMMANDS_REF = new Set([
    'log', 'diff', 'status', 'show', 'blame', 'grep',
    'shortlog', 'describe', 'rev-parse', 'ls-files',
  ])

  function extractBashCommandsOld(rawCommand: string): string[] {
    if (!rawCommand || !rawCommand.trim()) return []

    const command = stripAnsi(rawCommand)
    const stripped = stripQuotedStringsRef(command)

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
      while (i < tokens.length) {
        if (/^\w+=/.test(tokens[i]!)) { i++; continue }
        const next = tokens[i + 1]
        if (
          next !== undefined &&
          COMMAND_PREFIXES_REF.has(basename(tokens[i]!)) &&
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

  function isReadShapedBashCommandOld(rawCommand: string): boolean {
    if (!rawCommand || !rawCommand.trim()) return false
    const stripped = stripQuotedStringsRef(stripAnsi(rawCommand))
    const segments = stripped.split(/\s*(?:&&|;|\|)\s*/)
    let sawCommand = false
    for (const segment of segments) {
      const trimmed = segment.trim()
      if (!trimmed) continue
      const tokens = trimmed.split(/\s+/)
      let i = 0
      while (i < tokens.length && (/^\w+=/.test(tokens[i]!) || COMMAND_PREFIXES_REF.has(basename(tokens[i]!)))) i++
      const base = i < tokens.length ? basename(tokens[i]!) : ''
      if (!base) continue
      sawCommand = true
      if (base === 'git') {
        const sub = tokens[i + 1]
        if (!sub || !GIT_READ_SUBCOMMANDS_REF.has(sub)) return false
        continue
      }
      if (!READ_ONLY_BASH_REF.has(base)) return false
    }
    return sawCommand
  }

  function buildWhitespaceHeavyCommand(): string {
    const parts: string[] = []
    for (let i = 0; i < 10; i++) parts.push('git' + ' '.repeat(2000) + 'status')
    return parts.join(' && ')
  }

  const TRICKY_INPUTS: string[] = [
    'echo "a && b" && ls',
    "foo 'x;y';bar",
    'cat <<EOF\n   some     text   with     lots   of   whitespace   \n\n\nEOF\n   &&   ls -la',
    'echo a\r\n&&\tls',
    'foo\t;\tbar',
    'a ; ; b',
    'a|b',
    '&& ls',
    'ls &&',
    '; ls ;',
    buildWhitespaceHeavyCommand(),
    'echo a && ls',
    'foo ; bar',
    '',
    '   ',
    '[31mls[0m && [32mpwd[0m',
    '[31mgit[0m status',
  ]

  it('extractBashCommands matches the old implementation across tricky separator inputs', () => {
    for (const input of TRICKY_INPUTS) {
      expect(extractBashCommands(input)).toEqual(extractBashCommandsOld(input))
    }
  })

  it('isReadShapedBashCommand matches the old implementation across tricky separator inputs', () => {
    for (const input of TRICKY_INPUTS) {
      expect(isReadShapedBashCommand(input)).toBe(isReadShapedBashCommandOld(input))
    }
  })

  it('runs the whitespace-heavy command in well under 50ms (old form is quadratic)', () => {
    const big = buildWhitespaceHeavyCommand()
    const t0 = Date.now()
    extractBashCommands(big)
    expect(Date.now() - t0).toBeLessThan(50)
  })
})

describe('isReadShapedBashCommand (#941)', () => {
  it('accepts single read commands and read-only git subcommands', () => {
    expect(isReadShapedBashCommand('rg -n "x" src/')).toBe(true)
    expect(isReadShapedBashCommand('cat file.ts')).toBe(true)
    expect(isReadShapedBashCommand('git log --oneline -5')).toBe(true)
    expect(isReadShapedBashCommand('git diff HEAD~1')).toBe(true)
    expect(isReadShapedBashCommand('VAR=1 sudo head -c 100 f')).toBe(true)
  })

  it('accepts pipelines where every segment reads', () => {
    expect(isReadShapedBashCommand('grep -r "x" src | head -20')).toBe(true)
    expect(isReadShapedBashCommand('git log --oneline && git status')).toBe(true)
  })

  it('rejects any mutating or unknown segment', () => {
    expect(isReadShapedBashCommand('npm test')).toBe(false)
    expect(isReadShapedBashCommand('sed -i s/a/b/ x.ts')).toBe(false)
    expect(isReadShapedBashCommand('cat x && rm -rf dist')).toBe(false)
    expect(isReadShapedBashCommand('git commit -m "x"')).toBe(false)
    expect(isReadShapedBashCommand('git branch new-branch')).toBe(false)
    expect(isReadShapedBashCommand('git')).toBe(false)
    expect(isReadShapedBashCommand('')).toBe(false)
    expect(isReadShapedBashCommand('   ')).toBe(false)
  })

  it('is not fooled by read-command names inside quoted strings', () => {
    expect(isReadShapedBashCommand('echo "cat file"')).toBe(false)
  })

  it('sees a mutation on a later line', () => {
    expect(isReadShapedBashCommand('cat x\nsed -i s/a/b/ f.ts')).toBe(false)
    expect(isReadShapedBashCommand('ls\nrm -rf dist')).toBe(false)
    expect(isReadShapedBashCommand('git log\ngit commit -m "x"')).toBe(false)
  })

  it('accepts several read lines and ignores a heredoc body', () => {
    expect(isReadShapedBashCommand('ls\npwd\n')).toBe(true)
    expect(isReadShapedBashCommand('cat <<EOF\nrm -rf x\nEOF')).toBe(true)
    expect(isReadShapedBashCommand('cat <<< "x"\nrm -rf y')).toBe(false)
    expect(isReadShapedBashCommand('cat x \\\n  y')).toBe(true)
    expect(isReadShapedBashCommand('ls\n# then\npwd')).toBe(true)
  })
})

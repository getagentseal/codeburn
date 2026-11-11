import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import { FACTS_VERSION } from '../src/scan-facts.js'

// The rules whose output scan-facts stores. A change to any of them must bump
// FACTS_VERSION and record the new digest here; old facts would otherwise keep
// answering under the new rule.
const RULES: Array<{ file: string; names: string[] }> = [
  { file: 'src/compare-stats.ts', names: ['function scanFileCorrections', 'function extractText', 'const SELF_CORRECTION_PATTERNS'] },
  {
    file: 'src/optimize.ts',
    names: [
      'function scanFileRecord', 'function compactOptimizeInput', 'function commandNames', 'function toSessionOpener',
      'function normalizeOpener', 'function isMachineWrittenPrompt', 'function skipTimestampOf', 'type StoredScan',
      'function storeScan', 'function loadScan', 'const COMMAND_PATTERN', 'const OPTIMIZE_TEXT_CAP', 'const OPTIMIZE_FIELD_CAP',
      'const RECURRING_CONTEXT_MIN_CHARS', 'const RECURRING_CONTEXT_NORMALIZE_SLACK', 'const RECURRING_CONTEXT_PREVIEW_CHARS',
      'function isReadTool', 'const BASH_TOOL_NAMES', 'function cappedString',
    ],
  },
  {
    file: 'src/bash-utils.ts',
    names: ['function isReadShapedBashCommand', 'function maskForSplitting', 'const HEREDOC_START', 'function stripQuotedStrings', 'const COMMAND_PREFIXES', 'const READ_ONLY_BASH', 'const GIT_READ_SUBCOMMANDS'],
  },
  { file: 'src/fs-utils.ts', names: ['type ReadSessionLinesOptions', 'function readSessionLines', 'function foldParsedLine'] },
  { file: 'src/parser.ts', names: ['function parseJsonlLine', 'function parseLargeJsonl', 'const LARGE_JSONL_LINE_BYTES'] },
]

const DIGEST_BY_VERSION: Record<number, string> = {
  1: '77acc4ce0a481dd68d44e48d10f51ea91567a9c9898bde727dbaf9e7947ab6b1',
  2: 'f668c0185a1b654b7743d0b7345058e999edb98124271942f48415b2155a8f8c',
  3: 'cef8fe1f6fe6686c824cbd2feaee78a4877e3da55399ccb4cd92704ac8eef4a4',
  4: '56ede88f85d216ba318d96d56f2116ff58bbf8f517bee5cca72be821099a7a23',
}

/// A top-level declaration, from its name to the column-0 bracket closing it,
/// or to the end of its line when it opens no block.
function declaration(source: string, name: string): string {
  const start = source.indexOf(name)
  if (start === -1) throw new Error(`${name} not found`)
  const lineEnd = source.indexOf('\n', start)
  const opener = source[lineEnd - 1]
  if (name.startsWith('const') && opener !== '[' && opener !== '{') return source.slice(start, lineEnd)
  const end = source.indexOf(opener === '[' ? '\n]' : '\n}', start)
  return source.slice(start, end + 2)
}

describe('FACTS_VERSION', () => {
  it('is bumped whenever a rule that produces stored facts changes', () => {
    const hash = createHash('sha256')
    for (const { file, names } of RULES) {
      const source = readFileSync(join(__dirname, '..', file), 'utf-8').replace(/\r\n/g, '\n')
      for (const name of names) hash.update(declaration(source, name)).update('\0')
    }
    expect(hash.digest('hex'), 'a stored-facts rule changed: bump FACTS_VERSION in src/scan-facts.ts and record this digest').toBe(DIGEST_BY_VERSION[FACTS_VERSION])
  })
})

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
]

const DIGEST_BY_VERSION: Record<number, string> = {
  1: '23419dc6b5b8451482850ae8580158c74db215f3d73a97f84f8766f5071c4d39',
}

/// A top-level declaration, from its name to the column-0 bracket closing it.
function declaration(source: string, name: string): string {
  const start = source.indexOf(name)
  if (start === -1) throw new Error(`${name} not found`)
  const end = source.indexOf(name.startsWith('const') ? '\n]' : '\n}', start)
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

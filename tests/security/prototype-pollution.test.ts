import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, mkdir, cp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { parseAllSessions } from '../../src/parser.js'
import type { DateRange } from '../../src/types.js'

// Fixtures carry timestamp 2026-04-16T00:00:00Z. The range below must stay
// wide enough to include that date; if the fixtures move, move FIXTURE_DAY too.
const FIXTURE_DAY = Date.UTC(2026, 3, 16) // month index 3 = April (Date.UTC is 0-indexed)
const RANGE_BEFORE_MS = FIXTURE_DAY - 24 * 60 * 60 * 1000
const RANGE_AFTER_MS = FIXTURE_DAY + 24 * 60 * 60 * 1000
const PROJECT_NAME = 'codeburn-poc-testing'

function makeRange(offsetMs: number): DateRange {
  return {
    start: new Date(RANGE_BEFORE_MS + offsetMs),
    end: new Date(RANGE_AFTER_MS + offsetMs),
  }
}

// Hermeticity note: the Claude provider also scans a fixed Desktop sessions
// dir independent of CLAUDE_CONFIG_DIR. The narrow dateRange above excludes
// any real sessions in practice, but these tests are not strictly isolated
// on a machine with April 2026 Claude Desktop activity. A stricter fix
// belongs in a follow-up to discoverSessions itself.

describe('HIGH-1 prototype pollution via unchecked bracket-assign', () => {
  const tmpDirs: string[] = []

  afterEach(async () => {
    delete (Object.prototype as Record<string, unknown>).calls
    while (tmpDirs.length > 0) {
      const d = tmpDirs.pop()
      if (d) await rm(d, { recursive: true, force: true })
    }
  })

  async function setupPoc(fixture: string): Promise<string> {
    const base = await mkdtemp(join(tmpdir(), 'codeburn-sec-'))
    tmpDirs.push(base)
    const projectDir = join(base, 'projects', PROJECT_NAME)
    await mkdir(projectDir, { recursive: true })
    await cp(join(__dirname, '..', 'fixtures', 'security', fixture), join(projectDir, 'pwn.jsonl'))
    process.env['CLAUDE_CONFIG_DIR'] = base
    return base
  }

  it('does not pollute Object.prototype when session contains tool_use name "__proto__"', async () => {
    await setupPoc('proto-tool.jsonl')
    await expect(parseAllSessions(makeRange(0), 'claude')).resolves.not.toThrow()
    expect(({} as Record<string, unknown>).calls).toBeUndefined()
  })

  it('does not pollute Object.prototype when bash command basename is "__proto__"', async () => {
    await setupPoc('proto-bash.jsonl')
    await expect(parseAllSessions(makeRange(1), 'claude')).resolves.not.toThrow()
    expect(({} as Record<string, unknown>).calls).toBeUndefined()
  })

  it('does not pollute Object.prototype when model name is "__proto__"', async () => {
    await setupPoc('proto-model.jsonl')
    await expect(parseAllSessions(makeRange(2), 'claude')).resolves.not.toThrow()
    expect(({} as Record<string, unknown>).calls).toBeUndefined()
  })
})

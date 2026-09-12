import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

// Counts how many times the parse pipeline actually runs. A scope hit must
// serve from an earlier run rather than starting another one.
let discoveries = 0
vi.mock('../src/providers/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/index.js')>()
  return {
    ...actual,
    discoverAllSessionsWithFailures: (...args: Parameters<typeof actual.discoverAllSessionsWithFailures>) => {
      discoveries++
      return actual.discoverAllSessionsWithFailures(...args)
    },
  }
})

import { parseAllSessions, clearSessionCache, withSinglePassParse } from '../src/parser.js'
import type { DateRange, ProjectSummary } from '../src/types.js'

const CWD = '/tmp/single-pass-proj'
let tmpDir: string

const userLine = (ts: string, text: string) => JSON.stringify({
  type: 'user', sessionId: 'sess-1', timestamp: ts, cwd: CWD,
  message: { role: 'user', content: text },
})
const asstLine = (id: string, ts: string, outputTokens: number) => JSON.stringify({
  type: 'assistant', sessionId: 'sess-1', timestamp: ts, cwd: CWD,
  message: { id, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], usage: { input_tokens: 100, output_tokens: outputTokens } },
})

// Three turns on the same day: 09:00, 12:00 and 21:00 UTC. A range that ends at
// midday must keep the first two and drop the third, whether it was applied
// during the parse or as a slice afterwards.
const DAY = '2026-08-20'
const range = (startIso: string, endIso: string): DateRange => ({ start: new Date(startIso), end: new Date(endIso) })
const DAY_START = `${DAY}T00:00:00.000Z`
const DAY_END = `${DAY}T23:59:59.999Z`
const MIDDAY = `${DAY}T12:30:00.000Z`

const shape = (projects: ProjectSummary[]) => projects.map(p => ({
  project: p.project,
  cost: p.totalCostUSD,
  calls: p.totalApiCalls,
  turns: p.sessions.flatMap(s => s.turns.map(t => t.timestamp)).sort(),
}))

beforeEach(async () => {
  clearSessionCache()
  discoveries = 0
  tmpDir = await mkdtemp(join(tmpdir(), 'single-pass-'))
  const projectDir = join(tmpDir, 'projects', 'single-pass-proj')
  await mkdir(projectDir, { recursive: true })
  await writeFile(join(projectDir, 'sess-1.jsonl'), [
    userLine(`${DAY}T09:00:00.000Z`, 'morning task'),
    asstLine('msg-a', `${DAY}T09:00:01.000Z`, 20),
    userLine(`${DAY}T12:00:00.000Z`, 'noon task'),
    asstLine('msg-b', `${DAY}T12:00:01.000Z`, 30),
    userLine(`${DAY}T21:00:00.000Z`, 'evening task'),
    asstLine('msg-c', `${DAY}T21:00:01.000Z`, 40),
  ].join('\n') + '\n')
  process.env['CLAUDE_CONFIG_DIR'] = tmpDir
  process.env['CODEBURN_CACHE_DIR'] = join(tmpDir, 'cache')
  process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] = join(tmpDir, 'desktop-sessions')
})

afterEach(async () => {
  clearSessionCache()
  delete process.env['CLAUDE_CONFIG_DIR']
  delete process.env['CODEBURN_CACHE_DIR']
  delete process.env['CODEBURN_DESKTOP_SESSIONS_DIR']
  await rm(tmpDir, { recursive: true, force: true })
})

describe('withSinglePassParse', () => {
  it('serves a narrower end from the declared parse, matching an unscoped parse of that range', async () => {
    const unscoped = shape(await parseAllSessions(range(DAY_START, MIDDAY)))
    clearSessionCache()
    discoveries = 0

    const { wide, narrow } = await withSinglePassParse(range(DAY_START, DAY_END), async () => ({
      wide: shape(await parseAllSessions(range(DAY_START, DAY_END))),
      narrow: shape(await parseAllSessions(range(DAY_START, MIDDAY))),
    }))

    expect(discoveries).toBe(1)
    expect(narrow).toEqual(unscoped)
    // Non-vacuous: the narrow view really is a strict subset of the wide one.
    expect(narrow[0]!.turns).toEqual([`${DAY}T09:00:00.000Z`, `${DAY}T12:00:00.000Z`])
    expect(wide[0]!.turns).toHaveLength(3)
    expect(narrow[0]!.cost).toBeLessThan(wide[0]!.cost)
  })

  it('re-parses when the start differs, because a start also decides which files are read', async () => {
    await withSinglePassParse(range(DAY_START, DAY_END), async () => {
      await parseAllSessions(range(DAY_START, DAY_END))
      await parseAllSessions(range(`${DAY}T10:00:00.000Z`, MIDDAY))
    })
    expect(discoveries).toBe(2)
  })

  it('re-parses when the declared end lands in a later month than the request', async () => {
    // Local end-of-day on the last of a month is next month in UTC, which is
    // what monthScopeForRange keys on: the two loads would read different shards.
    const start = '2026-08-31T00:00:00.000Z'
    await withSinglePassParse(range(start, '2026-09-01T00:30:00.000Z'), async () => {
      await parseAllSessions(range(start, '2026-09-01T00:30:00.000Z'))
      await parseAllSessions(range(start, '2026-08-31T23:00:00.000Z'))
    })
    expect(discoveries).toBe(2)
  })

  it('leaves a request that reaches past the declared end alone', async () => {
    await withSinglePassParse(range(DAY_START, MIDDAY), async () => {
      await parseAllSessions(range(DAY_START, MIDDAY))
      await parseAllSessions(range(DAY_START, DAY_END))
    })
    expect(discoveries).toBe(2)
  })

  it('scopes nothing outside the callback', async () => {
    await withSinglePassParse(range(DAY_START, DAY_END), async () => {
      await parseAllSessions(range(DAY_START, DAY_END))
    })
    clearSessionCache()
    discoveries = 0
    await parseAllSessions(range(DAY_START, MIDDAY))
    expect(discoveries).toBe(1)
  })
})

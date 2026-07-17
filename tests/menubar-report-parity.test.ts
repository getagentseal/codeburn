import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { loadPricing, setLocalModelSavings, setModelAliases } from '../src/models.js'
import { buildMenubarPayloadForRange, buildPeriodData } from '../src/usage-aggregator.js'
import { parseAllSessions, filterProjectsByName, clearSessionCache } from '../src/parser.js'
import type { DateRange } from '../src/types.js'

// A fixed HISTORICAL day so the range never overlaps "today": the app parses
// today separately on every build, and on a live machine today's own sessions
// change between calls — anchoring in the past keeps the corpus immutable and
// the payload deterministic.
const FIXTURE_DAY = Date.UTC(2026, 3, 16)
const RANGE: DateRange = {
  start: new Date(FIXTURE_DAY - 24 * 60 * 60 * 1000),
  end: new Date(FIXTURE_DAY + 24 * 60 * 60 * 1000),
}
const PERIOD = { range: RANGE, label: 'Fixture window' }

let tmpDirs: string[] = []

beforeAll(async () => {
  await loadPricing()
})

beforeEach(() => {
  // Runs AFTER the global env-isolation beforeEach, so these win for the test body.
  setLocalModelSavings({})
  setModelAliases({})
})

afterEach(async () => {
  clearSessionCache()
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop()
    if (d) await rm(d, { recursive: true, force: true })
  }
})

/** Seed one priced Claude session on the fixture day and point discovery + the
 *  cache dir at isolated temp dirs. Returns the range's expected corpus root. */
async function seedFixture(): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'codeburn-parity-src-'))
  const cacheDir = await mkdtemp(join(tmpdir(), 'codeburn-parity-cache-'))
  tmpDirs.push(base, cacheDir)

  const projectDir = join(base, 'projects', 'p')
  await mkdir(projectDir, { recursive: true })
  const line = (id: string, ts: string): string => JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    sessionId: 's1',
    message: {
      type: 'message', role: 'assistant', model: 'claude-3-5-sonnet-20241022', id,
      content: [],
      usage: { input_tokens: 120000, output_tokens: 24000, cache_creation_input_tokens: 0, cache_read_input_tokens: 500000 },
    },
  })
  await writeFile(
    join(projectDir, 's1.jsonl'),
    [line('msg-1', '2026-04-16T10:00:00.000Z'), line('msg-2', '2026-04-16T11:30:00.000Z')].join('\n') + '\n',
    'utf-8',
  )

  process.env['CLAUDE_CONFIG_DIR'] = base
  process.env['CODEBURN_CACHE_DIR'] = cacheDir
}

/** Everything but the per-call wall-clock `generated` stamp. */
function stableShape(payload: unknown): unknown {
  const clone = structuredClone(payload) as { generated?: string }
  clone.generated = ''
  return clone
}

describe('app payload ↔ CLI report parity', () => {
  it('emits byte-identical totals on repeated builds over the same warm cache', async () => {
    await seedFixture()

    // Warm the versioned session cache once, then build the overview payload
    // twice. clearSessionCache() between builds drops only the in-memory TTL, so
    // each build re-runs the full emitter pipeline over the SAME warm disk cache.
    clearSessionCache()
    await parseAllSessions(RANGE, 'all')

    clearSessionCache()
    const first = await buildMenubarPayloadForRange(PERIOD, { provider: 'all', optimize: false, timeline: false })
    clearSessionCache()
    const second = await buildMenubarPayloadForRange(PERIOD, { provider: 'all', optimize: false, timeline: false })

    expect(first.current.calls).toBeGreaterThan(0)
    // Identical output => the emitters are deterministic on a warm cache (no
    // ordering / floating drift between the app's repeated polls).
    expect(stableShape(first)).toEqual(stableShape(second))
  })

  it('matches the CLI report path (buildPeriodData) for the same period + provider', async () => {
    await seedFixture()

    clearSessionCache()
    const payload = await buildMenubarPayloadForRange(PERIOD, { provider: 'all', optimize: false, timeline: false })

    // The CLI report / status --format json path: parse the same range, aggregate
    // via buildPeriodData. The app's current block is the same function over the
    // same projects, so the headline cost must be bit-for-bit equal.
    clearSessionCache()
    const reportProjects = filterProjectsByName(await parseAllSessions(RANGE, 'all'), [], [])
    const report = buildPeriodData(PERIOD.label, reportProjects)

    expect(report.cost).toBeGreaterThan(0)
    expect(payload.current.cost).toBe(report.cost)
    expect(payload.current.calls).toBe(report.calls)
    expect(payload.current.inputTokens).toBe(report.inputTokens)
    expect(payload.current.outputTokens).toBe(report.outputTokens)
  })
})

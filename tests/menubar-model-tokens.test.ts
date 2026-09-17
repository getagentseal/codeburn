import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getShortModelName, loadPricing, setModelAliases } from '../src/models.js'
import { buildMenubarPayloadForRange } from '../src/usage-aggregator.js'
import { clearSessionCache } from '../src/parser.js'
import type { DateRange } from '../src/types.js'

// Per-model token counts through the menubar payload, exercised against a real
// parsed fixture (not arithmetic helpers): two priced models with unequal
// input/output/cache-read/cache-write mixes, a cache-read-only model, an
// unpriced model, the durable-day path after the sources expire, and a
// provider-scoped build.

const FIXTURE_DAY = Date.UTC(2026, 3, 16)
const RANGE: DateRange = {
  start: new Date(FIXTURE_DAY - 24 * 60 * 60 * 1000),
  end: new Date(FIXTURE_DAY + 24 * 60 * 60 * 1000),
}
const PERIOD = { range: RANGE, label: 'Fixture window' }

const SONNET = 'claude-3-7-sonnet-20250219'
const HAIKU = 'claude-3-haiku-20240307'
const OPUS = 'claude-3-opus-20240229'
const UNPRICED = 'totally-unknown-model-xyz'

let base: string
let cacheDir: string
const tmpDirs: string[] = []

beforeAll(async () => {
  await loadPricing()
})

beforeEach(() => {
  // Runs AFTER the global env-isolation beforeEach, so these win for the test body.
  setModelAliases({})
})

afterEach(async () => {
  clearSessionCache()
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop()
    if (d) await rm(d, { recursive: true, force: true })
  }
})

function claudeLine(id: string, model: string, ts: string, usage: {
  input: number
  output: number
  cacheW: number
  cacheR: number
}): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    sessionId: `s-${id}`,
    message: {
      type: 'message', role: 'assistant', model, id,
      content: [],
      usage: {
        input_tokens: usage.input,
        output_tokens: usage.output,
        cache_creation_input_tokens: usage.cacheW,
        cache_read_input_tokens: usage.cacheR,
      },
    },
  })
}

/** Four sessions, one model each, with deliberately unequal token mixes. */
async function seedFixture(): Promise<void> {
  base = await mkdtemp(join(tmpdir(), 'codeburn-model-tokens-src-'))
  cacheDir = await mkdtemp(join(tmpdir(), 'codeburn-model-tokens-cache-'))
  tmpDirs.push(base, cacheDir)

  const projectDir = join(base, 'projects', 'p')
  await mkdir(projectDir, { recursive: true })
  const t = (h: number): string => new Date(FIXTURE_DAY + h * 60 * 60 * 1000).toISOString()
  const sessions: Array<{ id: string; model: string; usage: { input: number; output: number; cacheW: number; cacheR: number } }> = [
    // Two assistant turns → the counts must sum across calls of one session.
    { id: 'sonnet', model: SONNET, usage: { input: 100_000, output: 20_000, cacheW: 30_000, cacheR: 400_000 } },
    { id: 'sonnet-2', model: SONNET, usage: { input: 100_000, output: 20_000, cacheW: 30_000, cacheR: 400_000 } },
    { id: 'haiku', model: HAIKU, usage: { input: 50_000, output: 10_000, cacheW: 5_000, cacheR: 100_000 } },
    // Cache-read-only: zero fresh input/output, all reused input.
    { id: 'opus', model: OPUS, usage: { input: 0, output: 0, cacheW: 0, cacheR: 900_000 } },
    // Unpriced: tokens observed, pricing lookup fails → $0 attributed cost.
    { id: 'unknown', model: UNPRICED, usage: { input: 7_000, output: 2_000, cacheW: 0, cacheR: 0 } },
  ]
  for (const s of sessions) {
    await writeFile(
      join(projectDir, `${s.id}.jsonl`),
      claudeLine(`msg-${s.id}`, s.model, t(1), s.usage) + '\n',
      'utf-8',
    )
  }

  process.env['CLAUDE_CONFIG_DIR'] = base
  process.env['CODEBURN_CACHE_DIR'] = cacheDir
}

function rowFor(payload: { current: { topModels: Array<{ name: string }> } }, model: string): {
  name: string
  cost: number
  calls: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
} {
  const row = payload.current.topModels.find(m => m.name === getShortModelName(model))
  expect(row, `topModels row for ${model}`).toBeDefined()
  return row!
}

describe('per-model token counts in the menubar payload', () => {
  it('carries unequal per-model counts through the fresh parse, reconciling with the headline totals', async () => {
    await seedFixture()

    clearSessionCache()
    const payload = await buildMenubarPayloadForRange(PERIOD, { provider: 'all', optimize: false, timeline: false })

    const sonnet = rowFor(payload, SONNET)
    expect(sonnet.calls).toBe(2)
    expect(sonnet.inputTokens).toBe(200_000)
    expect(sonnet.outputTokens).toBe(40_000)
    expect(sonnet.cacheReadTokens).toBe(800_000)
    expect(sonnet.cacheWriteTokens).toBe(60_000)

    const haiku = rowFor(payload, HAIKU)
    expect(haiku.inputTokens).toBe(50_000)
    expect(haiku.outputTokens).toBe(10_000)
    expect(haiku.cacheReadTokens).toBe(100_000)
    expect(haiku.cacheWriteTokens).toBe(5_000)

    // Cache-only model: a known zero in every non-cache column, real reused
    // input in the cache column — never folded into input, never dropped.
    const opus = rowFor(payload, OPUS)
    expect(opus.inputTokens).toBe(0)
    expect(opus.outputTokens).toBe(0)
    expect(opus.cacheReadTokens).toBe(900_000)
    expect(opus.cacheWriteTokens).toBe(0)

    // Unpriced model: counts are observed usage and must survive even though
    // its attributed cost is $0.
    const unpriced = rowFor(payload, UNPRICED)
    expect(unpriced.cost).toBe(0)
    expect(unpriced.inputTokens).toBe(7_000)
    expect(unpriced.outputTokens).toBe(2_000)

    // Per-model rows reconcile with the period headline on a single-provider
    // fixture (claude folds reasoning into output, so billable == raw here).
    const models = payload.current.topModels
    expect(models.reduce((s, m) => s + (m.inputTokens ?? 0), 0)).toBe(payload.current.inputTokens)
    expect(models.reduce((s, m) => s + (m.outputTokens ?? 0), 0)).toBe(payload.current.outputTokens)
    expect(models.reduce((s, m) => s + (m.cacheReadTokens ?? 0), 0)).toBe(payload.current.cacheReadTokens)
    expect(models.reduce((s, m) => s + (m.cacheWriteTokens ?? 0), 0)).toBe(payload.current.cacheWriteTokens)
  })

  it('carries the same counts through the durable-day path after the session files are gone', async () => {
    await seedFixture()

    // Warm the daily cache, then expire the sources: the headline and the
    // per-model counts must both survive off the sealed day entries.
    clearSessionCache()
    await buildMenubarPayloadForRange(PERIOD, { provider: 'all', optimize: false, timeline: false })
    await rm(base, { recursive: true, force: true })

    clearSessionCache()
    const payload = await buildMenubarPayloadForRange(PERIOD, { provider: 'all', optimize: false, timeline: false })

    const sonnet = rowFor(payload, SONNET)
    expect(sonnet.calls).toBe(2)
    expect(sonnet.inputTokens).toBe(200_000)
    expect(sonnet.outputTokens).toBe(40_000)
    expect(sonnet.cacheReadTokens).toBe(800_000)
    expect(sonnet.cacheWriteTokens).toBe(60_000)

    const opus = rowFor(payload, OPUS)
    expect(opus.cacheReadTokens).toBe(900_000)
    expect(opus.inputTokens).toBe(0)
  })

  it('emits the same counts on the provider-scoped build', async () => {
    await seedFixture()

    clearSessionCache()
    const payload = await buildMenubarPayloadForRange(PERIOD, { provider: 'claude', optimize: false, timeline: false })

    const sonnet = rowFor(payload, SONNET)
    expect(sonnet.inputTokens).toBe(200_000)
    expect(sonnet.cacheReadTokens).toBe(800_000)
    const haiku = rowFor(payload, HAIKU)
    expect(haiku.outputTokens).toBe(10_000)
    expect(haiku.cacheWriteTokens).toBe(5_000)
  })

  it('returns no models for a range the fixture day is outside of', async () => {
    await seedFixture()

    clearSessionCache()
    const before = {
      range: {
        start: new Date(FIXTURE_DAY - 96 * 60 * 60 * 1000),
        end: new Date(FIXTURE_DAY - 72 * 60 * 60 * 1000),
      },
      label: 'Before fixture',
    }
    const payload = await buildMenubarPayloadForRange(before, { provider: 'all', optimize: false, timeline: false })
    expect(payload.current.topModels).toEqual([])
  })

  it('merges aliased raw ids into one row whose counts sum like the cost does', async () => {
    await seedFixture()
    // Route haiku through sonnet: pricing, display name and now token counts
    // must all land in the sonnet row.
    setModelAliases({ [HAIKU]: SONNET })

    clearSessionCache()
    const payload = await buildMenubarPayloadForRange(PERIOD, { provider: 'all', optimize: false, timeline: false })

    const sonnet = rowFor(payload, SONNET)
    expect(sonnet.calls).toBe(3)
    expect(sonnet.inputTokens).toBe(250_000)
    expect(sonnet.outputTokens).toBe(50_000)
    expect(sonnet.cacheReadTokens).toBe(900_000)
    expect(sonnet.cacheWriteTokens).toBe(65_000)
    // Four fixture models, one folded away by the alias.
    expect(payload.current.topModels).toHaveLength(3)
  })
})

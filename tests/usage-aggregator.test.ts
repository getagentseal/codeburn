import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildMenubarPayloadForRange } from '../src/usage-aggregator.js'
import { getDateRange } from '../src/cli-date.js'
import { loadPricing } from '../src/models.js'

describe('buildMenubarPayloadForRange', () => {
  // Point HOME / config at an empty temp dir so the payload is built from an
  // empty dataset. This keeps the test deterministic and fast regardless of how
  // much real session data the developer's machine has for "today" (parsing a
  // heavy day previously pushed this past its timeout).
  const saved: Record<string, string | undefined> = {}
  let tmp: string

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'codeburn-agg-test-'))
    for (const key of ['HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'CODEBURN_CACHE_DIR']) {
      saved[key] = process.env[key]
    }
    process.env['HOME'] = tmp
    process.env['CLAUDE_CONFIG_DIR'] = join(tmp, '.claude')
    process.env['XDG_CONFIG_HOME'] = join(tmp, '.config')
    process.env['CODEBURN_CACHE_DIR'] = join(tmp, 'cache')
    await loadPricing()
  })

  afterAll(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(tmp, { recursive: true, force: true })
  })

  it('returns a valid payload and skips optimize findings when optimize:false', async () => {
    const payload = await buildMenubarPayloadForRange(getDateRange('today'), { provider: 'all', optimize: false })
    expect(typeof payload.current.label).toBe('string')
    expect(payload.current.cost).toBeGreaterThanOrEqual(0)
    expect(Array.isArray(payload.current.topProjects)).toBe(true)
    expect(Array.isArray(payload.current.topModels)).toBe(true)
    expect(Array.isArray(payload.history.daily)).toBe(true)
    expect(payload.current.retryTax.totalUSD).toBeGreaterThanOrEqual(0)
    // Codex credits are always present in the payload (display gates them); 0 with no data.
    expect(typeof payload.current.codexCredits).toBe('number')
    expect(payload.current.codexCredits).toBeGreaterThanOrEqual(0)
    // optimize:false => scanAndDetect skipped => empty optimize block regardless of data
    expect(payload.optimize).toEqual({ findingCount: 0, savingsUSD: 0, topFindings: [] })
  })
})

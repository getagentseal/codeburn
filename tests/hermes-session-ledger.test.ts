import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  applyHermesSnapshot,
  HERMES_SESSION_LEDGER_VERSION,
  hermesBaselineKey,
  hermesObservationKey,
  hermesSessionLedgerPath,
  isHermesLedgerPublicationError,
  isHermesObservationKey,
  loadHermesSessionLedger,
  parseHermesDedupKey,
  persistHermesSessionLedger,
  recordHermesSnapshot,
  resetHermesSessionLedgerForTests,
  seedHermesCursorsFromProviderSection,
  setHermesLedgerNow,
  type HermesSnapshot,
} from '../src/hermes-session-ledger.js'
import type { CachedCall, ProviderSection } from '../src/session-cache.js'

let cacheDir: string
let originalCacheDir: string | undefined

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'hermes-ledger-unit-'))
  originalCacheDir = process.env['CODEBURN_CACHE_DIR']
  process.env['CODEBURN_CACHE_DIR'] = cacheDir
  resetHermesSessionLedgerForTests()
})

afterEach(async () => {
  resetHermesSessionLedgerForTests()
  if (originalCacheDir === undefined) delete process.env['CODEBURN_CACHE_DIR']
  else process.env['CODEBURN_CACHE_DIR'] = originalCacheDir
  await rm(cacheDir, { recursive: true, force: true })
})

function snap(overrides: Partial<HermesSnapshot> = {}): HermesSnapshot {
  const { tokens: tokenOverrides, ...rest } = overrides
  return {
    profile: 'default',
    sessionId: 's1',
    startedAt: '2026-08-21T10:00:00.000Z',
    observedAt: '2026-08-22T10:00:00.000Z',
    costUSD: 0.10,
    costBasis: 'actual',
    ...rest,
    tokens: {
      inputTokens: 100,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      ...tokenOverrides,
    },
  }
}

describe('hermes session ledger unit', () => {
  it('parses baseline and observation keys', () => {
    expect(parseHermesDedupKey('hermes:default:abc')).toEqual({ profile: 'default', sessionId: 'abc' })
    expect(parseHermesDedupKey('hermes:coder:abc:obs:1')).toEqual({
      profile: 'coder',
      sessionId: 'abc',
      observationIndex: 1,
    })
    expect(isHermesObservationKey('hermes:default:abc')).toBe(false)
    expect(isHermesObservationKey('hermes:default:abc:obs:2')).toBe(true)
    expect(hermesBaselineKey('default', 'abc')).toBe('hermes:default:abc')
    expect(hermesObservationKey('default', 'abc', 1)).toBe('hermes:default:abc:obs:1')
  })

  it('first observation is behavioral lifetime at started_at', () => {
    const { cursor, dirty } = applyHermesSnapshot(undefined, snap())
    expect(dirty).toBe(true)
    expect(cursor.observations).toHaveLength(1)
    expect(cursor.observations[0]).toMatchObject({
      index: 0,
      timestamp: '2026-08-21T10:00:00.000Z',
      inputTokens: 100,
      costUSD: 0.10,
      supplementaryAccounting: false,
    })
    expect(cursor.lastSeen.inputTokens).toBe(100)
  })

  it('growth emits a positive delta only', () => {
    const first = applyHermesSnapshot(undefined, snap()).cursor
    const { cursor, dirty } = applyHermesSnapshot(first, snap({
      tokens: { inputTokens: 150, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      costUSD: 0.15,
    }))
    expect(dirty).toBe(true)
    expect(cursor.observations).toHaveLength(2)
    expect(cursor.observations[1]!.index).toBe(1)
    expect(cursor.observations[1]!.timestamp).toBe('2026-08-22T10:00:00.000Z')
    expect(cursor.observations[1]!.inputTokens).toBe(50)
    expect(cursor.observations[1]!.costUSD).toBeCloseTo(0.05)
    expect(cursor.observations[1]!.supplementaryAccounting).toBe(true)
    expect(cursor.lastSeen).toMatchObject({ inputTokens: 150, costUSD: 0.15 })
  })

  it('equal totals re-emit stored observations with no new row', () => {
    const first = applyHermesSnapshot(undefined, snap()).cursor
    const { cursor, dirty } = applyHermesSnapshot(first, snap())
    expect(dirty).toBe(false)
    expect(cursor.observations).toHaveLength(1)
    expect(cursor).toBe(first)
  })

  it('150 → 0 advances last-seen to zero and emits no observation', () => {
    const first = applyHermesSnapshot(undefined, snap({
      tokens: { inputTokens: 150, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      costUSD: 0.15,
    })).cursor
    const { cursor, dirty } = applyHermesSnapshot(first, snap({
      tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      costUSD: 0,
    }))
    expect(dirty).toBe(true)
    expect(cursor.observations).toHaveLength(1)
    expect(cursor.lastSeen.inputTokens).toBe(0)
    expect(cursor.lastSeen.costUSD).toBe(0)
  })

  it('0 → 40 after a zero reset emits one +40 weight-0 observation', () => {
    const first = applyHermesSnapshot(undefined, snap({
      tokens: { inputTokens: 150, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
    })).cursor
    const zeroed = applyHermesSnapshot(first, snap({
      tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      costUSD: 0,
    })).cursor
    const { cursor } = applyHermesSnapshot(zeroed, snap({
      tokens: { inputTokens: 40, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      costUSD: 0.04,
    }))
    expect(cursor.observations).toHaveLength(2)
    expect(cursor.observations[1]).toMatchObject({
      index: 1,
      inputTokens: 40,
      costUSD: 0.04,
      supplementaryAccounting: true,
    })
    expect(cursor.observations.some(o => o.inputTokens < 0 || o.costUSD < 0)).toBe(false)
  })

  it('a cost-basis shrink is a cost reset without a negative', () => {
    const first = applyHermesSnapshot(undefined, snap()).cursor
    const { cursor } = applyHermesSnapshot(first, snap({
      tokens: { inputTokens: 150, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      costUSD: 0.05,
      costBasis: 'estimated',
    }))
    expect(cursor.observations).toHaveLength(2)
    expect(cursor.observations[1]).toMatchObject({
      inputTokens: 50,
      costUSD: 0,
      supplementaryAccounting: true,
    })
    expect(cursor.lastSeen.costUSD).toBe(0.05)
    expect(cursor.lastSeen.costBasis).toBe('estimated')
  })

  it('does not relabel a genuine multi-observation history on a basis-only change', () => {
    const first = applyHermesSnapshot(undefined, snap({ costUSD: 0 })).cursor
    const grown = applyHermesSnapshot(first, snap({
      tokens: { inputTokens: 150, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      costUSD: 0,
      costBasis: 'actual',
    })).cursor
    const corrected = applyHermesSnapshot(grown, snap({
      tokens: { inputTokens: 150, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      costUSD: 0,
      costBasis: 'included',
    })).cursor

    expect(corrected.observations.map(observation => observation.costBasis)).toEqual(['actual', 'actual'])
    expect(corrected.lastSeen.costBasis).toBe('included')
  })

  it('clock is injectable for observation timestamps', async () => {
    setHermesLedgerNow(() => new Date('2026-08-22T15:30:00.000Z'))
    const cursor = await recordHermesSnapshot(snap({
      observedAt: new Date('2026-08-22T15:30:00.000Z').toISOString(),
    }))
    const grown = await recordHermesSnapshot(snap({
      tokens: { inputTokens: 120, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      costUSD: 0.12,
      observedAt: new Date('2026-08-22T15:30:00.000Z').toISOString(),
    }))
    expect(grown.observations[1]!.timestamp).toBe('2026-08-22T15:30:00.000Z')
    expect(cursor.observations[0]!.timestamp).toBe('2026-08-21T10:00:00.000Z')
  })

  it('seed writes one behavioral observation and does not overwrite existing keys', async () => {
    const call: CachedCall = {
      provider: 'hermes',
      model: 'gpt-5.5',
      usage: {
        inputTokens: 100,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        webSearchRequests: 0,
        cacheCreationOneHourTokens: 0,
      },
      costUSD: 0.10,
      speed: 'standard',
      timestamp: '2026-08-21T10:00:00.000Z',
      tools: ['Read'],
      bashCommands: [],
      skills: [],
      subagentTypes: [],
      deduplicationKey: 'hermes:default:seeded',
    }
    const section: ProviderSection = {
      envFingerprint: 'test',
      files: {
        '/tmp/state.db#hermes-session=seeded': {
          fingerprint: { dev: 1, ino: 1, mtimeMs: 1, sizeBytes: 1 },
          mcpInventory: [],
          turns: [{ timestamp: call.timestamp, sessionId: 'seeded', userMessage: 'hi', calls: [call] }],
        },
      },
    }
    await seedHermesCursorsFromProviderSection(section)
    const first = loadHermesSessionLedger()
    expect(first.cursors['default']!['seeded']!.observations).toHaveLength(1)
    expect(first.cursors['default']!['seeded']!.observations[0]).toMatchObject({
      index: 0,
      timestamp: '2026-08-21T10:00:00.000Z',
      inputTokens: 100,
      supplementaryAccounting: false,
    })

    section.files['/tmp/state.db#hermes-session=seeded']!.turns[0]!.calls[0] = {
      ...call,
      usage: { ...call.usage, inputTokens: 999 },
      timestamp: '2026-08-22T10:00:00.000Z',
    }
    await seedHermesCursorsFromProviderSection(section)
    const second = loadHermesSessionLedger()
    expect(second.cursors['default']!['seeded']!.observations).toHaveLength(1)
    expect(second.cursors['default']!['seeded']!.lastSeen.inputTokens).toBe(100)
  })

  it('seeds cached subscription billing as included, not actual', async () => {
    const call: CachedCall = {
      provider: 'hermes',
      model: 'gpt-5.6-sol',
      usage: {
        inputTokens: 100,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        webSearchRequests: 0,
        cacheCreationOneHourTokens: 0,
      },
      costUSD: 0,
      isEstimated: false,
      billing: 'subscription',
      speed: 'standard',
      timestamp: '2026-08-21T10:00:00.000Z',
      tools: [],
      bashCommands: [],
      skills: [],
      subagentTypes: [],
      deduplicationKey: 'hermes:default:subscription-seed',
    }
    const section: ProviderSection = {
      envFingerprint: 'test',
      files: {
        '/tmp/state.db#hermes-session=subscription-seed': {
          fingerprint: { dev: 1, ino: 1, mtimeMs: 1, sizeBytes: 1 },
          mcpInventory: [],
          turns: [{ timestamp: call.timestamp, sessionId: 'subscription-seed', userMessage: 'hi', calls: [call] }],
        },
      },
    }

    await seedHermesCursorsFromProviderSection(section)

    const observation = loadHermesSessionLedger().cursors['default']!['subscription-seed']!.observations[0]!
    expect(observation.costBasis).toBe('included')
  })

  it('publication failure is a typed retryable error', async () => {
    await mkdir(hermesSessionLedgerPath())
    let caught: unknown
    try {
      await persistHermesSessionLedger({ version: HERMES_SESSION_LEDGER_VERSION, cursors: {} })
    } catch (err) {
      caught = err
    }
    expect(isHermesLedgerPublicationError(caught)).toBe(true)
  })

  it('ignores a superseded v1 ledger and removes it from the cache dir', async () => {
    const v1Path = join(cacheDir, 'hermes-session-ledger.v1.json')
    await writeFile(v1Path, JSON.stringify({
      version: 1,
      cursors: {
        default: {
          historical: {
            profile: 'default',
            sessionId: 'historical',
            lastSeen: {
              inputTokens: 1,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              reasoningTokens: 0,
              costUSD: 4603,
              costBasis: 'calculated',
            },
            observations: [],
          },
        },
      },
    }))
    expect(existsSync(v1Path)).toBe(true)

    // No v3 file: the loader starts empty, and the v1 file it can never read
    // again must not survive the load.
    expect(loadHermesSessionLedger().cursors).toEqual({})
    expect(existsSync(v1Path)).toBe(false)
  })
})

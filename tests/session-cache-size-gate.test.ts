// Size-gate parity: shards at or under SHARD_STREAM_GATE_BYTES take the plain
// JSON.parse path; larger ones stream. Both paths must serve byte-identical
// results (and identical nulls) for whole and range-filtered loads, or the
// fast path would silently change reports on every machine whose shards fit
// under the gate. The gate override forces each path on the same bytes.
import { mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  __setShardStreamGateForTests,
  clearShardMemo,
  loadShardFiltered,
  loadShardMemoized,
  sessionCacheDir,
  type CachedFile,
} from '../src/session-cache.js'

type Turn = CachedFile['turns'][number]

function callAt(timestamp: string, key: string): Turn['calls'][number] {
  return {
    provider: 'omp',
    model: 'm',
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      cacheCreationOneHourTokens: 0,
    },
    speed: 'standard',
    timestamp,
    tools: [],
    bashCommands: [],
    skills: [],
    subagentTypes: [],
    deduplicationKey: key,
  }
}

function turnAt(timestamp: string, key: string): Turn {
  return {
    timestamp,
    sessionId: 'sess-1',
    userMessage: 'do the thing',
    calls: [callAt(timestamp, key)],
  }
}

function cachedFile(overrides: Partial<CachedFile> = {}): CachedFile {
  return {
    fingerprint: { dev: 1, ino: 2, mtimeMs: 3, sizeBytes: 4 },
    lastCompleteLineOffset: 128,
    mcpInventory: [],
    turns: [turnAt('2026-07-15T10:00:00Z', 'day15-1')],
    ...overrides,
  }
}

const DAY = { start: new Date('2026-07-15T00:00:00Z'), end: new Date('2026-07-15T23:59:59.999Z') }

function keepDay(turn: Turn): boolean {
  return turn.calls.some(c => {
    const ts = new Date(c.timestamp).getTime()
    return !Number.isNaN(ts) && ts >= DAY.start.getTime() && ts <= DAY.end.getTime()
  })
}
function mixedCorpus(): Record<string, CachedFile> {
  return {
    '/live/kept.jsonl': cachedFile({
      turns: [turnAt('2026-07-15T10:00:00Z', 'k-1'), turnAt('2026-07-15T11:00:00Z', 'k-2')],
    }),
    '/live/sliced.jsonl': cachedFile({
      turns: [
        turnAt('2026-07-10T10:00:00Z', 'd-1'),
        { ...turnAt('2026-07-15T10:00:00Z', 'k-3'), gitBranch: 'main' },
      ],
    }),
    '/live/pr.jsonl': cachedFile({
      prLinks: ['https://example.com/x/1'],
      turns: [turnAt('2026-07-10T10:00:00Z', 'p-1'), turnAt('2026-07-15T10:00:00Z', 'p-2')],
    }),
    '/live/overlap.jsonl': cachedFile({
      turns: [turnAt('2026-07-10T10:00:00Z', 'same'), turnAt('2026-07-15T10:00:00Z', 'same')],
    }),
    '/live/dropped.jsonl': cachedFile({
      turns: [turnAt('2026-07-10T10:00:00Z', 'x-1')],
    }),
  }
}

let dir: string

beforeEach(async () => {
  dir = join(tmpdir(), `codeburn-sizegate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  await mkdir(dir, { recursive: true })
  clearShardMemo()
})

afterEach(async () => {
  __setShardStreamGateForTests(null)
  clearShardMemo()
  await rm(dir, { recursive: true, force: true })
})

describe('shard size gate parity', () => {
  it('serves identical filtered loads from the parse and stream paths', async () => {
    const name = 'omp.2026-07.gate.json'
    await writeFile(join(dir, name), JSON.stringify(mixedCorpus()))
    __setShardStreamGateForTests(Number.POSITIVE_INFINITY)
    const parsed = await loadShardFiltered(dir, name, keepDay)
    __setShardStreamGateForTests(0)
    const streamed = await loadShardFiltered(dir, name, keepDay)
    expect(streamed).toEqual(parsed)
    expect(Object.keys(parsed!)).toHaveLength(5)
    // Spot-check the shapes survived both paths, not just equally.
    expect(parsed!['/live/sliced.jsonl']!.turns).toHaveLength(1)
    expect(parsed!['/live/sliced.jsonl']!.rangeFiltered).toBeDefined()
    expect(parsed!['/live/pr.jsonl']!.rangeFiltered).toBeUndefined()
    expect(parsed!['/live/pr.jsonl']!.turns).toHaveLength(2)
  })

  it('serves identical whole loads from the parse and stream paths', async () => {
    const corpus = mixedCorpus()
    await writeFile(join(dir, 'gate-parse.json'), JSON.stringify(corpus))
    await writeFile(join(dir, 'gate-stream.json'), JSON.stringify(corpus))
    __setShardStreamGateForTests(Number.POSITIVE_INFINITY)
    const parsed = await loadShardMemoized(dir, 'gate-parse.json')
    __setShardStreamGateForTests(0)
    const streamed = await loadShardMemoized(dir, 'gate-stream.json')
    expect(streamed).toEqual(parsed)
  })

  it('drops the shard on both paths for an invalid record', async () => {
    const bad = { ...mixedCorpus(), '/live/bad.jsonl': cachedFile({ turns: 'nope' as unknown as [] }) }
    await writeFile(join(dir, 'gate-bad.json'), JSON.stringify(bad))
    __setShardStreamGateForTests(Number.POSITIVE_INFINITY)
    expect(await loadShardFiltered(dir, 'gate-bad.json', keepDay)).toBeNull()
    __setShardStreamGateForTests(0)
    expect(await loadShardFiltered(dir, 'gate-bad.json', keepDay)).toBeNull()
  })
})

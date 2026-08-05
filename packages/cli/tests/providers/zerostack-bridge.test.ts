import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { describe, it, expect } from 'vitest'

import { createZerostackProvider } from '../../src/providers/zerostack.js'
import { priceProviderCall } from '../../src/pricing-pass.js'
import { getHostPrivacyKey } from '../../src/privacy-key.js'
import { sourceRefFingerprint } from '@codeburn/core'
import type { ParsedProviderCall, SessionSource } from '../../src/providers/types.js'

// Byte-identical parity gate for the zerostack bridge migration (phase 8).
// Zerostack is not in the frozen corpus, so a committed fixture golden is THE
// parity gate: the bridged provider (discovery + JSON I/O CLI-side, pure decode
// delegated to @codeburn/core/providers/zerostack) must reproduce exactly what
// the pre-migration in-CLI decode produced. The dedup key threads a FINGERPRINT
// of the source path (`zerostack:<fp>:<timestamp>:<sessionId>`) — dedupKey
// ships on the envelope, so the raw path is the defect and must never appear;
// the expected value is DERIVED from the discovered source via the same
// sourceRefFingerprint the decoder uses rather than hard-coded. Covers:
// cumulative session totals, the zero-token skip (elsewhere), the OpenRouter
// model passing through raw, the empty-model + string-array userMessage +
// `basename(path)` sessionId fallbacks, updated_at-then-created_at timestamp
// precedence, and the discovered project / recorded working_dir carried onto
// the call.
const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = resolve(here, '../fixtures/zerostack')

function golden(dir: string): ParsedProviderCall[] {
  const abcPath = join(dir, 'sess-abc.json')
  const arrayPath = join(dir, 'sess-array.json')
  // The bridge threads the HOST privacy key into the rich decode
  // (getHostPrivacyKey, per-install stable), so the decoder keys the source ref
  // under that key — derive the expected keys the same way instead of pasting
  // what the code emits.
  const abcRef = sourceRefFingerprint(getHostPrivacyKey(), abcPath)
  const arrayRef = sourceRefFingerprint(getHostPrivacyKey(), arrayPath)
  return [
    {
      provider: 'zerostack',
      model: 'deepseek/deepseek-v4-pro',
      inputTokens: 34119,
      outputTokens: 961,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costBasis: 'estimated',
      tools: [],
      bashCommands: [],
      timestamp: '2026-06-19T11:34:14.140631+00:00',
      speed: 'standard',
      deduplicationKey: `zerostack:${abcRef}:2026-06-19T11:34:14.140631+00:00:sess-abc`,
      userMessage: 'hello, what is this repo about?',
      sessionId: 'sess-abc',
      project: 'myproject',
      projectPath: '/Users/test/myproject',
    },
    {
      provider: 'zerostack',
      model: '',
      inputTokens: 500,
      outputTokens: 200,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costBasis: 'estimated',
      tools: [],
      bashCommands: [],
      timestamp: '2026-06-20T09:00:00.000000+00:00',
      speed: 'standard',
      deduplicationKey: `zerostack:${arrayRef}:2026-06-20T09:00:00.000000+00:00:sess-array`,
      userMessage: 'part one part two',
      sessionId: 'sess-array',
      project: 'another',
      projectPath: '/Users/test/another',
    },
  ]
}

async function collect(seen = new Set<string>()): Promise<ParsedProviderCall[]> {
  const provider = createZerostackProvider(FIXTURE_DIR)
  const sources: SessionSource[] = await provider.discoverSessions()
  sources.sort((a, b) => a.path.localeCompare(b.path))
  const calls: ParsedProviderCall[] = []
  for (const source of sources) {
    for await (const call of provider.createSessionParser(source, seen).parse()) calls.push(call)
  }
  return calls
}

describe('zerostack bridge — fixture parity', () => {
  it('the bridged provider reproduces the pre-migration decode byte-for-byte', async () => {
    expect(await collect()).toEqual(golden(FIXTURE_DIR))
  })

  it('the priced output survives the pricing pass with only costUSD added', async () => {
    const raw = await collect()
    raw.map(priceProviderCall).forEach((call, i) => {
      expect(typeof call.costUSD).toBe('number')
      expect(Number.isFinite(call.costUSD)).toBe(true)
      expect(call.costBasis).toBe('estimated')
      const { costUSD, ...rest } = call
      expect(rest).toEqual(raw[i])
    })
  })

  it('the shared seenKeys set dedups a repeat scan', async () => {
    const seen = new Set<string>()
    const first = await collect(seen)
    const second = await collect(seen)
    expect(first).toEqual(golden(FIXTURE_DIR))
    expect(second).toEqual([])
  })
})

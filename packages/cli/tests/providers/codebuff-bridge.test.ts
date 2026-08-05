import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

import { describe, it, expect } from 'vitest'

import { createCodebuffProvider } from '../../src/providers/codebuff.js'
import { priceProviderCall } from '../../src/pricing-pass.js'
import { getHostPrivacyKey } from '../../src/privacy-key.js'
import { sourceRefFingerprint } from '@codeburn/core'
import type { ParsedProviderCall, SessionSource } from '../../src/providers/types.js'

// Byte-identical parity gate for the codebuff bridge migration. The GOLDEN below
// was captured from the legacy in-CLI decode before the migration; the bridged
// provider (discovery + I/O CLI-side, pure decode in @codeburn/core/providers/codebuff)
// must reproduce it exactly. Dedup keys thread a FINGERPRINT of the source path
// (dedupKey ships on the envelope, so the raw path must never appear there), so
// the expected values are DERIVED from the source at runtime via the same
// sourceRefFingerprint the decoder uses — never the raw path, and never a
// hard-coded literal. The bridge threads the HOST privacy key (getHostPrivacyKey,
// per-install stable), so the golden derives with the same key.

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = resolve(here, '../fixtures/codebuff-parity/manicode')

function expectedGolden(sourcePath: string): ParsedProviderCall[] {
  const chatDir = sourcePath
  // The CLI bridge threads the host privacy key into the rich decode, so the
  // decoder keys the source ref under getHostPrivacyKey() — derive the
  // expected key the same way instead of pasting what the code emits.
  const chatRef = sourceRefFingerprint(getHostPrivacyKey(), chatDir)
  return [
    {
      provider: 'codebuff',
      model: 'codebuff-base2',
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costBasis: 'estimated',
      fallbackCostUSD: 0.42,
      tools: ['Read', 'Edit', 'Bash', 'Read', 'Bash'],
      bashCommands: ['npm', 'npm'],
      timestamp: '2026-04-14T10:00:30.000Z',
      speed: 'standard',
      deduplicationKey: `codebuff:${chatRef}:a1`,
      userMessage: 'implement the feature',
      sessionId: 'manicode/2026-04-14T10-00-00.000Z',
    },
    {
      provider: 'codebuff',
      model: 'claude-haiku-4-5-20251001',
      inputTokens: 5000,
      outputTokens: 2000,
      cacheCreationInputTokens: 1000,
      cacheReadInputTokens: 500,
      cachedInputTokens: 500,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costBasis: 'estimated',
      fallbackCostUSD: 0.1,
      tools: [],
      bashCommands: [],
      timestamp: '2026-04-14T10:01:30.000Z',
      speed: 'standard',
      deduplicationKey: `codebuff:${chatRef}:a2`,
      userMessage: 'fix the bug',
      sessionId: 'manicode/2026-04-14T10-00-00.000Z',
    },
    {
      provider: 'codebuff',
      model: 'openai/gpt-4o',
      inputTokens: 2000,
      outputTokens: 800,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 400,
      cachedInputTokens: 400,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costBasis: 'estimated',
      fallbackCostUSD: 0.07,
      tools: [],
      bashCommands: [],
      timestamp: '2026-04-14T10:02:00.000Z',
      speed: 'standard',
      deduplicationKey: `codebuff:${chatRef}:a3`,
      userMessage: '',
      sessionId: 'manicode/2026-04-14T10-00-00.000Z',
    },
  ]
}

async function collect(): Promise<{ calls: ParsedProviderCall[]; sourcePath: string }> {
  const provider = createCodebuffProvider(FIXTURE_DIR)
  const sources: SessionSource[] = await provider.discoverSessions()
  expect(sources).toHaveLength(1)
  const sourcePath = sources[0]!.path
  const seen = new Set<string>()
  const calls: ParsedProviderCall[] = []
  for await (const call of provider.createSessionParser(sources[0]!, seen).parse()) {
    calls.push(call)
  }
  return { calls, sourcePath }
}

describe('codebuff bridge — fixture parity', () => {
  it('the bridged provider reproduces the pre-migration decode byte-for-byte', async () => {
    const { calls, sourcePath } = await collect()
    expect(calls).toEqual(expectedGolden(sourcePath))
  })

  it('the priced output survives the pricing pass; credit fallback is used when table price is zero', async () => {
    const { calls } = await collect()
    const priced = calls.map(priceProviderCall)
    priced.forEach((call, i) => {
      expect(typeof call.costUSD).toBe('number')
      expect(Number.isFinite(call.costUSD)).toBe(true)
      const raw = calls[i]!
      expect(call.costBasis).toBe(raw.costBasis)
      // Every field except the added costUSD must stay byte-identical.
      const { costUSD, ...rest } = call
      expect(rest).toEqual(raw)
    })
    // The token-less codebuff-base2 call has no table price, so the credit
    // fallback becomes the final cost.
    expect(priced[0]!.costUSD).toBeCloseTo(0.42, 6)
    // The Claude/GPT calls have known table prices that beat their credit fallback.
    expect(priced[1]!.costUSD).not.toBeCloseTo(0.1, 6)
    expect(priced[2]!.costUSD).not.toBeCloseTo(0.07, 6)
  })

  it('discovery, I/O, and dedup stay CLI-side; the shared seenKeys set dedups', async () => {
    const provider = createCodebuffProvider(FIXTURE_DIR)
    const sources = await provider.discoverSessions()
    const seen = new Set<string>()
    const first: ParsedProviderCall[] = []
    for (const source of sources) {
      for await (const call of provider.createSessionParser(source, seen).parse()) first.push(call)
    }
    const second: ParsedProviderCall[] = []
    for (const source of sources) {
      for await (const call of provider.createSessionParser(source, seen).parse()) second.push(call)
    }
    expect(first.length).toBe(3)
    expect(second).toEqual([])
  })
})

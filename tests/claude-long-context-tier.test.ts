import { beforeAll, describe, expect, it } from 'vitest'

import { calculateCost, loadPricing } from '../src/models.js'
import { parseApiCall } from '../src/parser.js'
import type { JournalEntry } from '../src/types.js'

// Anthropic list rates for Haiku 5.5, per token: base and above 100k prompt tokens.
const BASE = { input: 0.1e-6, output: 0.5e-6, write5m: 0.125e-6, write1h: 0.2e-6, read: 0.01e-6 }
const LONG = { input: 0.5e-6, output: 2.5e-6, write5m: 0.625e-6, write1h: 1e-6, read: 0.05e-6 }

function entry(usage: Record<string, unknown>): JournalEntry {
  return {
    type: 'assistant',
    timestamp: '2026-10-08T10:00:00.000Z',
    sessionId: 's1',
    message: { type: 'message', role: 'assistant', model: 'claude-haiku-5-5', id: 'msg-1', content: [], usage },
  } as unknown as JournalEntry
}

describe('Claude long-context tier', () => {
  beforeAll(async () => {
    await loadPricing()
  })

  it('prices a Haiku 5.5 request over 100k prompt tokens at the long-context rates', () => {
    // 1 input + 90,000 cache read + 10,000 cache write (1h) = 100,001 prompt tokens.
    const over = calculateCost('claude-haiku-5-5', 1, 1_000, 10_000, 90_000, 0, 'standard', 10_000, 'claude')
    expect(over).toBeCloseTo(1 * LONG.input + 1_000 * LONG.output + 10_000 * LONG.write1h + 90_000 * LONG.read, 12)
    const at = calculateCost('claude-haiku-5-5', 0, 1_000, 10_000, 90_000, 0, 'standard', 0, 'claude')
    expect(at).toBeCloseTo(1_000 * BASE.output + 10_000 * BASE.write5m + 90_000 * BASE.read, 12)
  })

  it('applies the tier to Claude transcript calls', () => {
    const call = parseApiCall(entry({ input_tokens: 10, output_tokens: 500, cache_creation_input_tokens: 2_000, cache_read_input_tokens: 150_000 }))
    expect(call!.costUSD).toBeCloseTo(10 * LONG.input + 500 * LONG.output + 2_000 * LONG.write5m + 150_000 * LONG.read, 12)
    const small = parseApiCall(entry({ input_tokens: 10, output_tokens: 500, cache_creation_input_tokens: 2_000, cache_read_input_tokens: 50_000 }))
    expect(small!.costUSD).toBeCloseTo(10 * BASE.input + 500 * BASE.output + 2_000 * BASE.write5m + 50_000 * BASE.read, 12)
  })
})

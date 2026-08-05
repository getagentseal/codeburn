import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

import { describe, it, expect } from 'vitest'

import { createGrokProvider } from '../../src/providers/grok.js'
import { priceProviderCall } from '../../src/pricing-pass.js'
import { getHostPrivacyKey } from '../../src/privacy-key.js'
import { sourceRefFingerprint } from '@codeburn/core'
import type { ParsedProviderCall, SessionSource } from '../../src/providers/types.js'

// Byte-identical parity gate for the grok bridge migration (phase 8). The
// GOLDEN below was captured from the legacy in-CLI decode before the migration.

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = resolve(here, '../fixtures/grok-parity')
// The dedup key threads a FINGERPRINT of the session dir — the raw path is the
// defect and must never appear (dedupKey ships on the envelope), so the
// expected value is DERIVED via the same sourceRefFingerprint the decoder
// uses. The bridge threads the HOST privacy key (getHostPrivacyKey, per-install
// stable), so the golden derives with the same key.
const SESSION_DIR = resolve(FIXTURE_DIR, '%2FUsers%2Ftest/019edf9c-0000-7000-8000-000000000001')
const SESSION_REF = sourceRefFingerprint(getHostPrivacyKey(), SESSION_DIR)

const GOLDEN: ParsedProviderCall[] = [
  {
    provider: 'grok',
    model: 'grok-build',
    inputTokens: 45000,
    outputTokens: 15000,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 45000,
    cachedInputTokens: 45000,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costBasis: 'estimated',
    costIsEstimated: true,
    // Grok dedups nothing: Bash appears twice (two run_terminal_command calls)
    // and 'git' repeats across `git status && git log` + `git diff`.
    tools: ['Read', 'Grep', 'Bash', 'Bash', 'Agent'],
    bashCommands: ['git', 'git', 'git'],
    subagentTypes: ['general-purpose'],
    timestamp: '2026-06-19T11:31:12.282793Z',
    speed: 'standard',
    // The key embeds a fingerprint of the session dir's absolute path —
    // derived from FIXTURE_DIR so the golden is portable across checkouts, and
    // never the raw path itself.
    deduplicationKey: `grok:${SESSION_REF}:2026-06-19T11:31:12.282793Z:019edf9c-0000-7000-8000-000000000001`,
    userMessage: 'User asks about the repo',
    sessionId: '019edf9c-0000-7000-8000-000000000001',
    project: 'myproject',
    projectPath: '/Users/test/myproject',
  },
]

async function collect(): Promise<ParsedProviderCall[]> {
  const provider = createGrokProvider(FIXTURE_DIR)
  const sources: SessionSource[] = await provider.discoverSessions()
  sources.sort((a, b) => a.path.localeCompare(b.path))
  const seen = new Set<string>()
  const calls: ParsedProviderCall[] = []
  for (const source of sources) {
    for await (const call of provider.createSessionParser(source, seen).parse()) {
      calls.push(call)
    }
  }
  return calls
}

describe('grok bridge — fixture parity', () => {
  it('the bridged provider reproduces the pre-migration decode byte-for-byte', async () => {
    expect(await collect()).toEqual(GOLDEN)
  })

  it('the priced output survives the pricing pass with only costUSD added', async () => {
    const raw = await collect()
    const priced = raw.map(priceProviderCall)
    priced.forEach((call, i) => {
      expect(typeof call.costUSD).toBe('number')
      expect(Number.isFinite(call.costUSD)).toBe(true)
      expect(call.costBasis).toBe('estimated')
      const { costUSD, ...rest } = call
      expect(rest).toEqual(raw[i])
    })
  })

  it('dedup threads through the host-owned seenKeys set', async () => {
    const provider = createGrokProvider(FIXTURE_DIR)
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
    expect(first.length).toBe(1)
    expect(second).toEqual([])
  })
})

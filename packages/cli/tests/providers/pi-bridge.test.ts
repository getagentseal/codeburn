import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

import { describe, it, expect } from 'vitest'

import { createPiProvider, createOmpProvider } from '../../src/providers/pi.js'
import { priceProviderCall } from '../../src/pricing-pass.js'
import { getHostPrivacyKey } from '../../src/privacy-key.js'
import { sourceRefFingerprint } from '@codeburn/core'
import type { ParsedProviderCall, SessionSource } from '../../src/providers/types.js'

// Byte-identical parity gate for the pi/omp bridge migration (phase 8). One core
// decode serves both providers; the GOLDENs were captured from the legacy in-CLI
// decode (git show origin/feat/core-extraction:packages/cli/src/providers/pi.ts)
// run over the committed fixtures. Covers: the
// `<provider>:<sourceRefFingerprint>:<id>` dedup key — the raw session file
// path is the defect and must never appear (dedupKey ships on the envelope), so
// the expected values are DERIVED from the session file path via the same
// sourceRefFingerprint the decoder uses — plus its
// responseId||entryId||timestamp||lineIdx fallback chain; sessionId from the
// session entry `id` vs the basename-of-path fallback (omp entry omits id ->
// 'ofile'); SKILL.md and skill:// reads reclassified as the `Skill` tool with
// their names in `skills`; FLAT un-deduped tools/bash (the repeated `git` base
// name appears four times); and the responseId dedup skip (fixture line 4 repeats
// resp-1).

const here = dirname(fileURLToPath(import.meta.url))
const PI_DIR = resolve(here, '../fixtures/pi-parity/pi-sessions')
const OMP_DIR = resolve(here, '../fixtures/pi-parity/omp-sessions')

const PI_PATH = resolve(PI_DIR, 'proj1/sess-file.jsonl')
const OMP_PATH = resolve(OMP_DIR, 'projO/ofile.jsonl')
// The bridge threads the HOST privacy key into the rich decode
// (getHostPrivacyKey, per-install stable), so the decoder keys the source ref
// under that key — derive the expected keys the same way instead of pasting
// what the code emits.
const PI_REF = sourceRefFingerprint(getHostPrivacyKey(), PI_PATH)
const OMP_REF = sourceRefFingerprint(getHostPrivacyKey(), OMP_PATH)

async function collect(provider: {
  discoverSessions: () => Promise<SessionSource[]>
  createSessionParser: (s: SessionSource, seen: Set<string>) => { parse: () => AsyncGenerator<ParsedProviderCall> }
}): Promise<ParsedProviderCall[]> {
  const sources = await provider.discoverSessions()
  sources.sort((a, b) => a.path.localeCompare(b.path))
  const seen = new Set<string>()
  const calls: ParsedProviderCall[] = []
  for (const source of sources) {
    for await (const call of provider.createSessionParser(source, seen).parse()) calls.push(call)
  }
  return calls
}

const PI_GOLDEN: ParsedProviderCall[] = [
  {
    provider: 'pi',
    model: 'gpt-5.5',
    inputTokens: 100,
    outputTokens: 40,
    cacheCreationInputTokens: 5,
    cacheReadInputTokens: 10,
    cachedInputTokens: 10,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costBasis: 'estimated',
    tools: ['Bash', 'Bash', 'Skill', 'Skill', 'Read', 'Agent'],
    bashCommands: ['git', 'git', 'git', 'git'],
    skills: ['my-skill', 'web-search'],
    timestamp: '2026-06-10T10:00:02.000Z',
    speed: 'standard',
    deduplicationKey: `pi:${PI_REF}:resp-1`,
    userMessage: 'do stuff',
    sessionId: 'pi-sess-1',
  },
]

const OMP_GOLDEN: ParsedProviderCall[] = [
  {
    provider: 'omp',
    model: 'gpt-4o',
    inputTokens: 10,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costBasis: 'estimated',
    tools: [],
    bashCommands: [],
    skills: [],
    timestamp: '2026-06-11T10:00:00.000Z',
    speed: 'standard',
    // responseId '' -> entry.id absent -> entry.timestamp; sessionId falls back
    // to basename-of-path because the session entry carries no id. The dedup key
    // threads a fingerprint of the file path (never the raw path).
    deduplicationKey: `omp:${OMP_REF}:2026-06-11T10:00:00.000Z`,
    userMessage: '',
    sessionId: 'ofile',
  },
]

describe('pi/omp bridge — fixture parity', () => {
  it('pi reproduces the pre-migration decode byte-for-byte', async () => {
    expect(await collect(createPiProvider(PI_DIR))).toEqual(PI_GOLDEN)
  })

  it('omp reuses the same decode with the omp provider id and path fallback', async () => {
    expect(await collect(createOmpProvider(OMP_DIR))).toEqual(OMP_GOLDEN)
  })

  it('the priced output survives the pricing pass with only costUSD added', async () => {
    const raw = await collect(createPiProvider(PI_DIR))
    const priced = raw.map(priceProviderCall)
    priced.forEach((call, i) => {
      expect(typeof call.costUSD).toBe('number')
      expect(Number.isFinite(call.costUSD)).toBe(true)
      const { costUSD, ...rest } = call
      expect(rest).toEqual(raw[i])
    })
  })

  it('dedup threads through the host-owned seenKeys set', async () => {
    const provider = createPiProvider(PI_DIR)
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
    expect(first).toHaveLength(1)
    expect(second).toEqual([])
  })
})

import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { describe, it, expect } from 'vitest'

import { createLingTaiTuiProvider } from '../../src/providers/lingtai-tui.js'
import { priceProviderCall } from '../../src/pricing-pass.js'
import { getHostPrivacyKey } from '../../src/privacy-key.js'
import { sourceRefFingerprint } from '@codeburn/core'
import type { ParsedProviderCall, SessionSource } from '../../src/providers/types.js'

// Byte-identical parity gate for the lingtai-tui bridge migration (phase 8).
// Not in the frozen corpus, so a committed fixture golden is THE parity gate:
// the bridged provider (discovery + manifest/ledger I/O CLI-side, pure decode
// delegated to @codeburn/core/providers/lingtai-tui) must reproduce exactly what
// the pre-migration in-CLI decode produced. Covers: cached-input separation,
// per-source-label activity synthesis (main / tc_wake / daemon => userMessage +
// tools + subagentTypes), model/endpoint fallback from the manifest when a
// ledger row omits them, run_id vs `${agentId}:${label}` session ids, the
// composite dedup key threaded on a FINGERPRINT of the source path (never the
// raw path — dedupKey ships on the envelope; the raw ledger model is normalized
// in the key), turnId, and the manifest-derived project / projectPath carried
// onto the call.
const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = resolve(here, '../fixtures/lingtai-parity')

function dedup(
  sourcePath: string,
  lineNo: number,
  ts: string,
  model: string,
  endpoint: string,
  label: string,
  emId: string,
  runId: string,
  input: number,
  output: number,
  thinking: number,
  cached: number,
): string {
  // The bridge threads the HOST privacy key into the rich decode
  // (getHostPrivacyKey, per-install stable), so the decoder keys the source ref
  // under that key — derive the expected key the same way instead of pasting
  // what the code emits.
  return ['lingtai-tui', sourceRefFingerprint(getHostPrivacyKey(), sourcePath), lineNo, ts, model, endpoint, label, emId, runId, input, output, thinking, cached].join(':')
}

function golden(sourcePath: string, agentDir: string): ParsedProviderCall[] {
  return [
    {
      provider: 'lingtai-tui',
      model: 'gpt-5.5',
      inputTokens: 90,
      outputTokens: 20,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 10,
      cachedInputTokens: 10,
      reasoningTokens: 5,
      webSearchRequests: 0,
      costBasis: 'estimated',
      tools: [],
      bashCommands: [],
      subagentTypes: [],
      timestamp: '2026-06-04T01:25:09.000Z',
      speed: 'standard',
      deduplicationKey: dedup(sourcePath, 1, '2026-06-04T01:25:09.000Z', 'gpt-5.5', 'example-endpoint', 'main', '', '', 100, 20, 5, 10),
      turnId: 'agent-001:main:line:1',
      userMessage: 'LingTai main conversation',
      sessionId: 'agent-001:main',
      projectPath: agentDir,
      project: 'Operator',
    },
    {
      provider: 'lingtai-tui',
      model: 'gpt-5.5',
      inputTokens: 15,
      outputTokens: 5,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 10,
      cachedInputTokens: 10,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costBasis: 'estimated',
      tools: ['Agent'],
      bashCommands: [],
      subagentTypes: ['lingtai-task-coordinator'],
      timestamp: '2026-06-04T01:28:24.000Z',
      speed: 'standard',
      deduplicationKey: dedup(sourcePath, 2, '2026-06-04T01:28:24.000Z', 'gpt-5.5', 'example-endpoint', 'tc_wake', '', '', 25, 5, 0, 10),
      turnId: 'agent-001:tc_wake:line:2',
      userMessage: 'LingTai task coordinator wake',
      sessionId: 'agent-001:tc_wake',
      projectPath: agentDir,
      project: 'Operator',
    },
    {
      provider: 'lingtai-tui',
      model: 'gpt-5.5',
      inputTokens: 0,
      outputTokens: 10,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 50,
      cachedInputTokens: 50,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costBasis: 'estimated',
      tools: ['Agent'],
      bashCommands: [],
      subagentTypes: ['lingtai-daemon'],
      timestamp: '2026-06-04T01:30:24.000Z',
      speed: 'standard',
      deduplicationKey: dedup(sourcePath, 3, '2026-06-04T01:30:24.000Z', 'gpt-5.5', 'example-endpoint', 'daemon', 'em-1', 'run-1', 50, 10, 0, 50),
      turnId: 'run-1:line:3',
      userMessage: 'LingTai daemon task',
      sessionId: 'run-1',
      projectPath: agentDir,
      project: 'Operator',
    },
  ]
}

async function sourceAndCalls(seen = new Set<string>()): Promise<{ source: SessionSource; calls: ParsedProviderCall[] }> {
  const provider = createLingTaiTuiProvider(FIXTURE_DIR)
  const sources = await provider.discoverSessions()
  expect(sources).toHaveLength(1)
  const source = sources[0]!
  const calls: ParsedProviderCall[] = []
  for await (const call of provider.createSessionParser(source, seen).parse()) calls.push(call)
  return { source, calls }
}

describe('lingtai-tui bridge — fixture parity', () => {
  it('the bridged provider reproduces the pre-migration decode byte-for-byte', async () => {
    const { source, calls } = await sourceAndCalls()
    const agentDir = dirname(dirname(source.path))
    expect(calls).toEqual(golden(source.path, agentDir))
  })

  it('the priced output survives the pricing pass with only costUSD added', async () => {
    const { calls } = await sourceAndCalls()
    calls.map(priceProviderCall).forEach((call, i) => {
      expect(typeof call.costUSD).toBe('number')
      expect(Number.isFinite(call.costUSD)).toBe(true)
      expect(call.costBasis).toBe('estimated')
      const { costUSD, ...rest } = call
      expect(rest).toEqual(calls[i])
    })
  })
})

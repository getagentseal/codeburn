import { it, expect, vi } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCodexProvider } from '../src/providers/codex.js'

vi.mock('../src/codex-cache.js', async (original) => ({
  ...await original<typeof import('../src/codex-cache.js')>(),
  readCachedCodexResults: async () => null,
  readCodexResume: async () => null,
  writeCachedCodexResults: async () => {},
}))

// Real-data basis (codeset-ai/codeset-release-evals, 53 sessions / 1313
// token_count events): 603 events are byte-identical repeats of their
// predecessor -- Codex re-emits token_count snapshots unchanged within a
// response -- while 54 events carry no total_token_usage at all. Both
// behaviors must be handled: identical repeats collapse (#257), distinct
// payloads without cumulative stay distinct.
for (const total of [undefined, null, {}]) {
  it(`collapses byte-identical re-emitted records with cumulative ${JSON.stringify(total)}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeburn-missing-total-'))
    try {
      const path = join(dir, 'rollout-reemit.jsonl')
      const identical = { last_token_usage: { input_tokens: 100, output_tokens: 20 }, total_token_usage: total }
      const lines = [
        { type: 'session_meta', timestamp: '2026-09-01T10:00:00Z', payload: { session_id: 's', model: 'gpt-5.3-codex' } },
        ...[1, 2, 3].map(n => ({ type: 'event_msg', timestamp: `2026-09-01T10:00:0${n}Z`, payload: { type: 'token_count', info: identical } })),
      ]
      await writeFile(path, lines.map(line => JSON.stringify(line)).join('\n') + '\n')
      const parser = createCodexProvider(dir).createSessionParser({ path, project: 'test', provider: 'codex' }, new Set())
      const calls = []
      for await (const call of parser.parse()) calls.push(call)
      expect(calls).toHaveLength(1)
      expect(calls[0].outputTokens).toBe(20)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it(`preserves distinct records with differing payloads when cumulative is ${JSON.stringify(total)}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeburn-missing-total-'))
    try {
      const path = join(dir, 'rollout-distinct.jsonl')
      const lines = [
        { type: 'session_meta', timestamp: '2026-09-01T10:00:00Z', payload: { session_id: 's', model: 'gpt-5.3-codex' } },
        ...[0, 1, 2].map(n => ({ type: 'event_msg', timestamp: `2026-09-01T10:00:0${n + 1}Z`, payload: {
          type: 'token_count', info: { last_token_usage: { input_tokens: 100 + n, output_tokens: 20 + n }, total_token_usage: total },
        } })),
      ]
      await writeFile(path, lines.map(line => JSON.stringify(line)).join('\n') + '\n')
      const parser = createCodexProvider(dir).createSessionParser({ path, project: 'test', provider: 'codex' }, new Set())
      const calls = []
      for await (const call of parser.parse()) calls.push(call)
      expect(calls).toHaveLength(3)
      expect(calls.reduce((sum, call) => sum + call.outputTokens, 0)).toBe(63)
      expect(new Set(calls.map(call => call.deduplicationKey)).size).toBe(3)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
}

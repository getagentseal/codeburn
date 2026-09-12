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

for (const total of [undefined, null, {}]) {
  it(`preserves distinct equal-usage records with cumulative ${JSON.stringify(total)}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeburn-missing-total-'))
    try {
      const path = join(dir, 'rollout-synthetic.jsonl')
      const lines = [
        { type: 'session_meta', timestamp: '2026-09-01T10:00:00Z', payload: { session_id: 's', model: 'gpt-5.3-codex' } },
        ...[1, 2, 3].map(n => ({ type: 'event_msg', timestamp: `2026-09-01T10:00:0${n}Z`, payload: {
          type: 'token_count', info: { last_token_usage: { input_tokens: 100, output_tokens: 20 }, total_token_usage: total },
        } })),
      ]
      await writeFile(path, lines.map(line => JSON.stringify(line)).join('\n') + '\n')
      const parser = createCodexProvider(dir).createSessionParser({ path, project: 'test', provider: 'codex' }, new Set())
      const calls = []
      for await (const call of parser.parse()) calls.push(call)
      expect(calls).toHaveLength(3)
      expect(calls.reduce((sum, call) => sum + call.outputTokens, 0)).toBe(60)
      expect(new Set(calls.map(call => call.deduplicationKey)).size).toBe(3)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
}

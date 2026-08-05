import { describe, expect, it } from 'vitest'

import { decodeClineCli, toObservations } from '../../src/providers/cline-cli/index.js'
import { ObservationEnvelope } from '../../src/observations.js'
import { OBSERVATION_SCHEMA_VERSION } from '../../src/schema.js'
import type { DecodeContext } from '../../src/contracts.js'

const context: DecodeContext = { privacyKey: 'k', providerId: 'cline-cli', sourceRef: 'ref' }

type MessageSpec = {
  id?: string
  role: 'user' | 'assistant'
  text?: string
  metrics?: Record<string, number>
  model?: string
  ts?: number
  toolUse?: { name: string; input: Record<string, unknown> }
}

function session(meta: Record<string, unknown>, messages: MessageSpec[]): unknown[] {
  return [{
    meta,
    messages: messages.map((spec, index) => {
      const content: unknown[] = []
      if (spec.text) content.push({ type: 'text', text: spec.text })
      if (spec.toolUse) content.push({ type: 'tool_use', id: `call_${index}`, ...spec.toolUse })
      const message: Record<string, unknown> = {
        id: spec.id ?? `msg_${index}`,
        role: spec.role,
        content,
        ts: spec.ts ?? 1785701064304 + index * 1000,
      }
      if (spec.metrics) message['metrics'] = spec.metrics
      if (spec.model) message['modelInfo'] = { id: spec.model, provider: 'cline-pass' }
      return message
    }),
  }]
}

const DEFAULT_META: Record<string, unknown> = {
  version: 1,
  session_id: 'sess-a',
  source: 'cli',
  status: 'completed',
  provider: 'cline-pass',
  model: 'z-ai/glm-5.2',
  cwd: '/Users/dev/work/my-repo',
  workspace_root: '/Users/dev/work/my-repo',
  started_at: '2026-08-02T20:04:18.628Z',
  ended_at: '2026-08-02T20:08:27.768Z',
  metadata: {},
  project: 'my-repo',
}

describe('cline-cli rich decode (moved to @codeburn/core)', () => {
  it('decodes metered assistant messages into rich, cost-free calls', () => {
    const records = session(DEFAULT_META, [
      { role: 'user', text: 'do the thing' },
      { role: 'assistant', text: 'ok', metrics: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 2, cost: 0.01 } },
      { role: 'assistant', text: 'done', metrics: { inputTokens: 200, outputTokens: 20, cost: 0.02 } },
    ])
    const { calls } = decodeClineCli({ records, context })

    expect(calls).toHaveLength(2)
    // No pricing crosses into the decode layer.
    expect(calls[0]).not.toHaveProperty('costUSD')
    expect(calls[0]).not.toHaveProperty('costBasis')

    expect(calls[0]!.inputTokens).toBe(100)
    expect(calls[0]!.outputTokens).toBe(10)
    expect(calls[0]!.cacheReadInputTokens).toBe(5)
    expect(calls[0]!.cacheCreationInputTokens).toBe(2)
    expect(calls[0]!.reportedCost).toBe(0.01)
    expect(calls[0]!.sessionId).toBe('sess-a')
    expect(calls[0]!.project).toBe('my-repo')
    expect(calls[0]!.projectPath).toBe('/Users/dev/work/my-repo')
    expect(calls[0]!.workingDirectory).toBe('/Users/dev/work/my-repo')
    expect(calls[0]!.deduplicationKey).toBe('cline-cli:sess-a:msg_1')
    expect(calls[0]!.turnId).toBe('sess-a:msg_1')
    expect(calls[0]!.userMessage).toBe('do the thing')
    expect(calls[1]!.reportedCost).toBe(0.02)
  })

  it('keeps a metered $0 reported and treats a negative cost as absent', () => {
    const records = session(DEFAULT_META, [
      { role: 'assistant', text: 'zero', metrics: { inputTokens: 10, outputTokens: 10, cost: 0 } },
      { role: 'assistant', text: 'negative', metrics: { inputTokens: 10, outputTokens: 10, cost: -5 } },
    ])
    const { calls } = decodeClineCli({ records, context })

    expect(calls).toHaveLength(2)
    expect(calls[0]!.reportedCost).toBe(0)
    expect(calls[1]!.reportedCost).toBeUndefined()
  })

  it('maps tools to canonical names and carries raw bash commands host-side', () => {
    const records = session(DEFAULT_META, [{
      role: 'assistant', text: 'running',
      metrics: { inputTokens: 1, outputTokens: 1, cost: 0.1 },
      toolUse: { name: 'run_commands', input: { commands: JSON.stringify(['git status', 'ls -la']) } },
    }])
    const { calls } = decodeClineCli({ records, context })

    expect(calls[0]!.tools).toEqual(['Bash'])
    // Raw command strings survive host-side; base-name extraction is the CLI's job.
    expect(calls[0]!.rawBashCommands).toEqual(['git status', 'ls -la'])
    expect(calls[0]!.toolSequence?.[0]?.[0]).toEqual({ tool: 'Bash', command: 'git status' })
  })

  it('threads a live seenKeys set so a repeated message id across passes drops', () => {
    const records = session(DEFAULT_META, [
      { role: 'assistant', text: 'a', metrics: { inputTokens: 1, outputTokens: 1, cost: 0.1 } },
    ])
    const seen = new Set<string>()
    expect(decodeClineCli({ records, context, seenKeys: seen }).calls).toHaveLength(1)
    // Re-decoding the same records with the shared set yields nothing.
    expect(decodeClineCli({ records, context, seenKeys: seen }).calls).toEqual([])
  })

  it('promotes a seconds-resolution timestamp instead of landing in 1970', () => {
    const seconds = Math.floor(Date.parse('2026-08-02T20:04:18.000Z') / 1000)
    const records = session(DEFAULT_META, [
      { role: 'assistant', text: 'a', ts: seconds, metrics: { inputTokens: 1, outputTokens: 1, cost: 0.1 } },
    ])
    const { calls } = decodeClineCli({ records, context })
    expect(calls[0]!.timestamp).toBe('2026-08-02T20:04:18.000Z')
  })

  it('falls back to the session rollup when no message carries metrics', () => {
    const meta = { ...DEFAULT_META, metadata: { usage: { inputTokens: 5483, outputTokens: 133, cacheReadTokens: 50, cacheWriteTokens: 0, totalCost: 0.0081984 } } }
    const records = session(meta, [])
    const { calls } = decodeClineCli({ records, context })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens).toBe(5483)
    expect(calls[0]!.reportedCost).toBeCloseTo(0.0081984, 7)
    expect(calls[0]!.deduplicationKey).toBe('cline-cli:sess-a:rollup')
  })

  it('declines the rollup when per-message calls were all deduped (hadMetrics gate)', () => {
    // A duplicated session directory: the shared dedup already owns the message
    // id, so every per-message call is suppressed — the rollup must not then
    // fire and double-count the session (regression for #894).
    const meta = { ...DEFAULT_META, session_id: 'shared', metadata: { usage: { inputTokens: 100, outputTokens: 10, totalCost: 0.01 } } }
    const records = session(meta, [
      { id: 'msg_0', role: 'assistant', text: 'a', metrics: { inputTokens: 100, outputTokens: 10, cost: 0.01 } },
    ])
    const seen = new Set<string>(['cline-cli:shared:msg_0'])
    const { calls } = decodeClineCli({ records, context, seenKeys: seen })

    expect(calls).toEqual([])
  })

  it('toObservations produces a schema-valid, content-free envelope', () => {
    const records = session(DEFAULT_META, [
      { role: 'user', text: 'read the file' },
      {
        role: 'assistant', text: 'ok', metrics: { inputTokens: 100, outputTokens: 10, cost: 0.01 },
        toolUse: { name: 'read_files', input: { path: '/Users/dev/work/my-repo/src/a.ts' } },
      },
    ])
    const { calls } = decodeClineCli({ records, context })
    const { sessions } = toObservations(
      { sessionId: 'sess-a', projectPath: '/Users/dev/work/my-repo', calls },
      { privacyKey: 'test-privacy-key', provider: 'cline-cli' },
    )
    const envelope = {
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      generator: { name: '@codeburn/core', version: '0.0.0-test' },
      sessions,
    }
    expect(ObservationEnvelope.safeParse(envelope).success).toBe(true)
    // The metered cost crosses as measuredCostUSD (the observation carries the
    // provider-reported figure the host would otherwise re-price).
    expect(sessions[0]!.calls[0]!.costBasis).toBe('measured')
    expect(sessions[0]!.calls[0]!.measuredCostUSD).toBe(0.01)
    // The read_file path is fingerprinted into a resourceRead, never emitted raw.
    const reads = sessions.flatMap(s => s.calls.flatMap(c => c.resourceReads ?? []))
    expect(reads.length).toBeGreaterThan(0)
    for (const ref of reads) expect(ref.resourceId).toMatch(/^[0-9a-f]{16}$/)
  })
})

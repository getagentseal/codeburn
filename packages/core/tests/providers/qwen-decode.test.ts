import { describe, expect, it } from 'vitest'

import { decodeQwen, toObservations } from '../../src/providers/qwen/index.js'
import { ObservationEnvelope } from '../../src/observations.js'
import { OBSERVATION_SCHEMA_VERSION } from '../../src/schema.js'
import type { DecodeContext } from '../../src/contracts.js'

const context: DecodeContext = { privacyKey: 'k', providerId: 'qwen', sourceRef: 'ref' }

function userMessage(uuid: string, ts: string, parts: unknown[]) {
  return JSON.stringify({ uuid, sessionId: 'sess-a', timestamp: ts, type: 'user', message: { role: 'user', parts } })
}
function assistant(uuid: string, ts: string, opts: { model?: string; parts?: unknown[]; prompt?: number; candidates?: number; thoughts?: number; cached?: number }) {
  return JSON.stringify({
    uuid,
    sessionId: 'sess-a',
    timestamp: ts,
    type: 'assistant',
    ...(opts.model ? { model: opts.model } : {}),
    message: { role: 'assistant', parts: opts.parts ?? [] },
    usageMetadata: {
      promptTokenCount: opts.prompt ?? 0,
      candidatesTokenCount: opts.candidates ?? 0,
      thoughtsTokenCount: opts.thoughts ?? 0,
      totalTokenCount: (opts.prompt ?? 0) + (opts.candidates ?? 0),
      cachedContentTokenCount: opts.cached ?? 0,
    },
  })
}

const RECORDS: string[] = [
  userMessage('u-1', '2026-05-16T10:00:00Z', [
    { text: 'fix the parser' },
    { text: 'and run tests', thought: false },
    { text: 'secret reasoning', thought: true },
  ]),
  assistant('a-1', '2026-05-16T10:00:05Z', {
    model: 'qwen3-coder-plus',
    prompt: 1200, candidates: 340, thoughts: 90, cached: 800,
    parts: [
      { functionCall: { name: 'read_file', args: { path: 'src/parser.ts' } } },
      { functionCall: { name: 'execute_command', args: { command: 'npm test && npx vitest run' } } },
      { text: 'done' },
    ],
  }),
  // Same uuid replayed with different content: must drop (dedup).
  assistant('a-1', '2026-05-16T10:00:06Z', { model: 'qwen3-coder-plus', prompt: 10, candidates: 10 }),
  // Zero-token assistant: must skip.
  assistant('a-zero', '2026-05-16T10:00:07Z', { model: 'qwen3-coder-plus' }),
  // No model on the entry: falls back to 'qwen-auto'.
  assistant('a-2', '2026-05-16T10:01:05Z', {
    prompt: 500, candidates: 120,
    parts: [{ functionCall: { name: 'some_native_tool', args: {} } }],
  }),
]

describe('qwen rich decode (moved to @codeburn/core)', () => {
  it('decodes assistant calls into cost-free rich calls, deduped and zero-skipped', () => {
    const { calls } = decodeQwen({ records: RECORDS, context })
    expect(calls).toHaveLength(2)

    const [first, second] = calls
    // No pricing crosses into the decode layer.
    expect(first).not.toHaveProperty('costUSD')
    expect(first).not.toHaveProperty('costBasis')

    expect(first!.model).toBe('qwen3-coder-plus')
    expect(first!.inputTokens).toBe(1200)
    expect(first!.outputTokens).toBe(340)
    expect(first!.reasoningTokens).toBe(90)
    expect(first!.cacheReadInputTokens).toBe(800)
    expect(first!.cachedInputTokens).toBe(800)
    expect(first!.tools).toEqual(['Read', 'Bash'])
    // Raw command strings survive host-side; base-name extraction is the CLI's job.
    expect(first!.rawBashCommands).toEqual(['npm test && npx vitest run'])
    // The thought part is filtered out of the pending user message.
    expect(first!.userMessage).toBe('fix the parser and run tests')
    expect(first!.deduplicationKey).toBe('qwen:sess-a:a-1')

    // Unknown model -> 'qwen-auto'; unknown tool id passes through unchanged.
    expect(second!.model).toBe('qwen-auto')
    expect(second!.tools).toEqual(['some_native_tool'])
  })

  it('threads a live seenKeys set so a repeated uuid across passes drops', () => {
    const seen = new Set<string>()
    const first = decodeQwen({ records: RECORDS.slice(0, 2), context, seenKeys: seen }).calls
    expect(first).toHaveLength(1)
    // Re-decoding the same records with the shared set yields nothing.
    const again = decodeQwen({ records: RECORDS.slice(0, 2), context, seenKeys: seen }).calls
    expect(again).toEqual([])
  })

  it('pins the dedup-key shape for records missing sessionId/uuid — no "undefined" spelling', () => {
    // The pre-extraction decoder interpolated the raw fields
    // (`qwen:${entry.sessionId}:${entry.uuid}`), so a record missing sessionId
    // produced the literal 'qwen:undefined:<uuid>'. That spelling was a
    // template-string artifact of JS coercion, NOT a contract: no test, fixture,
    // or golden ever pinned it (the CLI parity golden uses fully-formed records,
    // where both shapes are byte-identical), and the sibling core decoders
    // (kiro, openclaw, goose) resolve missing identifiers to real fallbacks
    // rather than interpolating 'undefined'. The extraction deliberately
    // coalesces to '' instead: the key keeps the uuid's entropy for dedup, never
    // fabricates a fake value in a key persisted to the session cache, and
    // matches the shape the CLI parity golden pins for well-formed records.
    // Restoring the old spelling would be a behavior change with no contract
    // behind it — this test exists so nobody flips it by accident.
    const noSessionId = JSON.stringify({
      uuid: 'a-orphan',
      timestamp: '2026-05-16T10:02:05Z',
      type: 'assistant',
      message: { role: 'assistant', parts: [] },
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    })
    const noUuid = JSON.stringify({
      sessionId: 'sess-b',
      timestamp: '2026-05-16T10:02:06Z',
      type: 'assistant',
      message: { role: 'assistant', parts: [] },
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    })

    const { calls } = decodeQwen({ records: [noSessionId, noUuid], context })
    expect(calls).toHaveLength(2)
    expect(calls[0]!.deduplicationKey).toBe('qwen::a-orphan')
    expect(calls[0]!.sessionId).toBe('')
    expect(calls[1]!.deduplicationKey).toBe('qwen:sess-b:')
    expect(calls[1]!.sessionId).toBe('sess-b')

    // The pinned key must round-trip through the dedup set: two records that
    // share a uuid and lack a sessionId still collapse to ONE call, exactly as
    // the old key did for the same input.
    const dup = decodeQwen({ records: [noSessionId, noSessionId], context })
    expect(dup.calls).toHaveLength(1)
  })

  it('toObservations produces a schema-valid, content-free envelope', () => {
    const { calls } = decodeQwen({ records: RECORDS, context })
    const { sessions } = toObservations(
      { sessionId: 'sess-a', projectPath: '/Users/t/alpha', calls },
      { privacyKey: 'test-privacy-key', provider: 'qwen' },
    )
    const envelope = {
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      generator: { name: '@codeburn/core', version: '0.0.0-test' },
      sessions,
    }
    expect(ObservationEnvelope.safeParse(envelope).success).toBe(true)
    // The read_file path is fingerprinted into a resourceRead, never emitted raw.
    const reads = sessions.flatMap(s => s.calls.flatMap(c => c.resourceReads ?? []))
    expect(reads.length).toBeGreaterThan(0)
    for (const ref of reads) expect(ref.resourceId).toMatch(/^[0-9a-f]{16}$/)
  })
})

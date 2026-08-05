import { describe, expect, it } from 'vitest'

import { decodeVscodeCline, toObservations } from '../../src/providers/vscode-cline/index.js'
import { ObservationEnvelope } from '../../src/observations.js'
import { OBSERVATION_SCHEMA_VERSION } from '../../src/schema.js'
import type { DecodeContext } from '../../src/contracts.js'
import type { ClineRecordEnvelope } from '../../src/providers/vscode-cline/index.js'

const context: DecodeContext = { privacyKey: 'k', providerId: 'cline', sourceRef: 'ref' }

function envelope(overrides: Partial<ClineRecordEnvelope> = {}): ClineRecordEnvelope {
  return {
    kind: 'cline-task',
    taskId: 'task-a',
    uiRaw: JSON.stringify([]),
    historyRaw: null,
    ...overrides,
  }
}

function uiMessage(overrides: { type?: string; say?: string; text?: string; ts?: number } = {}): unknown {
  return { type: 'say', say: 'api_req_started', text: JSON.stringify({ tokensIn: 10, tokensOut: 5 }), ts: 1_700_000_000_000, ...overrides }
}

function historyWithModel(model: string, workspace?: string): string {
  const workspaceLine = workspace ? `Current Workspace Directory (${workspace})` : ''
  return JSON.stringify([
    {
      role: 'user',
      content: [{ type: 'text', text: `<environment_details>\n<model>${model}</model>\n${workspaceLine}\n</environment_details>` }],
    },
  ])
}

describe('vscode-cline rich decode (moved to @codeburn/core)', () => {
  it('extracts and slash-strips the model from history', () => {
    const { calls } = decodeVscodeCline({
      records: [envelope({ historyRaw: historyWithModel('anthropic/claude-sonnet-4-6', '/home/user/acme'), uiRaw: JSON.stringify([uiMessage()]) })],
      context,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.model).toBe('claude-sonnet-4-6')
  })

  it('uses the fallback model when no <model> tag is present', () => {
    const { calls } = decodeVscodeCline({
      records: [envelope({ historyRaw: JSON.stringify([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]), uiRaw: JSON.stringify([uiMessage()]) })],
      context,
    })
    expect(calls[0]!.model).toBe('cline-auto')
  })

  it('honors the fallbackModel knob', () => {
    const { calls } = decodeVscodeCline({
      records: [envelope({ uiRaw: JSON.stringify([uiMessage()]) })],
      context: { ...context, providerId: 'ibm-bob' },
      fallbackModel: 'ibm-bob-auto',
    })
    expect(calls[0]!.model).toBe('ibm-bob-auto')
  })

  it('derives project / projectPath from the workspace marker', () => {
    const { calls } = decodeVscodeCline({
      records: [envelope({ historyRaw: historyWithModel('claude-3', '/home/user/projects/acme-corp'), uiRaw: JSON.stringify([uiMessage()]) })],
      context,
    })
    expect(calls[0]!.project).toBe('acme-corp')
    expect(calls[0]!.projectPath).toBe('/home/user/projects/acme-corp')
  })

  it('leaves project / projectPath undefined when there is no workspace marker', () => {
    const { calls } = decodeVscodeCline({
      records: [envelope({ historyRaw: historyWithModel('claude-3'), uiRaw: JSON.stringify([uiMessage()]) })],
      context,
    })
    expect(calls[0]!.project).toBeUndefined()
    expect(calls[0]!.projectPath).toBeUndefined()
  })

  it('falls back to the default model when history is missing', () => {
    const { calls } = decodeVscodeCline({ records: [envelope({ historyRaw: null, uiRaw: JSON.stringify([uiMessage()]) })], context })
    expect(calls[0]!.model).toBe('cline-auto')
    expect(calls[0]!.project).toBeUndefined()
  })

  it('falls back to the default model when history is malformed JSON', () => {
    const { calls } = decodeVscodeCline({ records: [envelope({ historyRaw: 'not json', uiRaw: JSON.stringify([uiMessage()]) })], context })
    expect(calls[0]!.model).toBe('cline-auto')
  })

  it('falls back to the default model when history parses to a non-array', () => {
    const { calls } = decodeVscodeCline({ records: [envelope({ historyRaw: JSON.stringify({ not: 'array' }), uiRaw: JSON.stringify([uiMessage()]) })], context })
    expect(calls[0]!.model).toBe('cline-auto')
  })

  it('emits measuredCostUSD when cost is present', () => {
    const { calls } = decodeVscodeCline({
      records: [envelope({ uiRaw: JSON.stringify([uiMessage({ text: JSON.stringify({ tokensIn: 10, tokensOut: 5, cost: 0.042 }) })]) })],
      context,
    })
    expect(calls[0]).toHaveProperty('measuredCostUSD', 0.042)
  })

  it('omits measuredCostUSD when cost is absent', () => {
    const { calls } = decodeVscodeCline({
      records: [envelope({ uiRaw: JSON.stringify([uiMessage()]) })],
      context,
    })
    expect(calls[0]).not.toHaveProperty('measuredCostUSD')
  })

  it('omits measuredCostUSD when cost is null', () => {
    const { calls } = decodeVscodeCline({
      records: [envelope({ uiRaw: JSON.stringify([uiMessage({ text: JSON.stringify({ tokensIn: 10, tokensOut: 5, cost: null }) })]) })],
      context,
    })
    expect(calls[0]).not.toHaveProperty('measuredCostUSD')
  })

  it('skips zero-token entries even when cache buckets are non-zero', () => {
    const { calls } = decodeVscodeCline({
      records: [envelope({ uiRaw: JSON.stringify([uiMessage({ text: JSON.stringify({ tokensIn: 0, tokensOut: 0, cacheReads: 7, cacheWrites: 3 }) })]) })],
      context,
    })
    expect(calls).toEqual([])
  })

  it('burns the dedup key for a skipped zero-token entry (G17)', () => {
    const seenKeys = new Set<string>()
    decodeVscodeCline({
      records: [envelope({ uiRaw: JSON.stringify([uiMessage({ text: JSON.stringify({ tokensIn: 0, tokensOut: 0 }) })]) })],
      context,
      seenKeys,
    })
    expect(seenKeys.has('cline:task-a:0')).toBe(true)
  })

  it('uses the apiReqEntries index, not the uiMessages index, for dedup keys', () => {
    const seenKeys = new Set<string>()
    const { calls } = decodeVscodeCline({
      records: [envelope({
        uiRaw: JSON.stringify([
          { type: 'say', say: 'text', text: 'interleaved' },
          uiMessage({ text: JSON.stringify({ tokensIn: 10, tokensOut: 5 }) }),
          { type: 'say', say: 'text', text: 'interleaved again' },
          uiMessage({ text: JSON.stringify({ tokensIn: 20, tokensOut: 10 }) }),
        ]),
      })],
      context,
      seenKeys,
    })
    expect(calls).toHaveLength(2)
    expect(calls[0]!.deduplicationKey).toBe('cline:task-a:0')
    expect(calls[1]!.deduplicationKey).toBe('cline:task-a:1')
  })

  it('carries userMessage only on the first api_req entry', () => {
    const { calls } = decodeVscodeCline({
      records: [envelope({
        uiRaw: JSON.stringify([
          { type: 'say', say: 'text', text: 'first user message' },
          uiMessage({ text: JSON.stringify({ tokensIn: 10, tokensOut: 5 }) }),
          uiMessage({ text: JSON.stringify({ tokensIn: 20, tokensOut: 10 }) }),
        ]),
      })],
      context,
    })
    expect(calls[0]!.userMessage).toBe('first user message')
    expect(calls[1]!.userMessage).toBe('')
  })

  it('slices userMessage to 500 characters', () => {
    const longMessage = 'x'.repeat(600)
    const { calls } = decodeVscodeCline({
      records: [envelope({
        uiRaw: JSON.stringify([
          { type: 'say', say: 'text', text: longMessage },
          uiMessage(),
        ]),
      })],
      context,
    })
    expect(calls[0]!.userMessage).toHaveLength(500)
  })

  it('uses an empty timestamp when ts is absent', () => {
    const { calls } = decodeVscodeCline({
      records: [envelope({ uiRaw: JSON.stringify([uiMessage({ ts: undefined })]) })],
      context,
    })
    expect(calls[0]!.timestamp).toBe('')
  })

  it('returns no calls and a malformed-json diagnostic when uiRaw is invalid JSON', () => {
    const { calls, diagnostics } = decodeVscodeCline({ records: [envelope({ uiRaw: 'not json' })], context })
    expect(calls).toEqual([])
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]!.code).toBe('malformed-json')
    expect(diagnostics[0]!.index).toBe(0)
    // The sanitiser is wired into the parse-failure path: detail is a keyed
    // fingerprint of the error, never its message.
    expect(diagnostics[0]!.detail).toMatch(/^[0-9a-f]{16}$/)
  })

  it('D1 regression: with the bridge\'s empty privacy key, malformed JSON emits no detail — never an unkeyed digest', () => {
    // The CLI bridge (packages/cli/src/providers/bridge.ts) decodes every
    // bridged provider with `privacyKey: ''`. A JSON.parse error message
    // embeds a fragment of the offending input, so an unkeyed digest of it
    // would be dictionary-attackable. The keyless path must omit detail
    // entirely, matching the pre-fingerprint diagnostic shape.
    const { calls, diagnostics } = decodeVscodeCline({
      records: [envelope({ uiRaw: 'not json' })],
      context: { ...context, privacyKey: '' },
    })
    expect(calls).toEqual([])
    expect(diagnostics).toEqual([{ index: 0, code: 'malformed-json' }])
  })

  it('returns no calls and an unknown-shape diagnostic when uiRaw parses to a non-array', () => {
    const { calls, diagnostics } = decodeVscodeCline({ records: [envelope({ uiRaw: JSON.stringify({ not: 'array' }) })], context })
    expect(calls).toEqual([])
    expect(diagnostics).toEqual([{ index: 0, code: 'unknown-shape' }])
  })

  it('returns no calls and an unknown-shape diagnostic when a record is not a cline-task envelope', () => {
    const { calls, diagnostics } = decodeVscodeCline({ records: [{ kind: 'other' }], context })
    expect(calls).toEqual([])
    expect(diagnostics).toEqual([{ index: 0, code: 'unknown-shape' }])
  })

  it('derives providerName from context.providerId', () => {
    const rooContext: DecodeContext = { ...context, providerId: 'roo-code' }
    const seenKeys = new Set<string>()
    const { calls } = decodeVscodeCline({
      records: [envelope({ uiRaw: JSON.stringify([uiMessage()]) })],
      context: rooContext,
      seenKeys,
    })
    expect(calls[0]!.provider).toBe('roo-code')
    expect(seenKeys.has('roo-code:task-a:0')).toBe(true)
    expect(seenKeys.has('cline:task-a:0')).toBe(false)
  })

  it('toObservations produces a schema-valid envelope', () => {
    const { calls } = decodeVscodeCline({
      records: [envelope({ historyRaw: historyWithModel('claude-3', '/home/user/acme'), uiRaw: JSON.stringify([uiMessage()]) })],
      context,
    })
    const { sessions } = toObservations(
      { sessionId: 'task-a', projectPath: '/home/user/acme', calls },
      { privacyKey: 'test-privacy-key', provider: 'cline' },
    )
    const env = {
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      generator: { name: '@codeburn/core', version: '0.0.0-test' },
      sessions,
    }
    expect(ObservationEnvelope.safeParse(env).success).toBe(true)
  })
})

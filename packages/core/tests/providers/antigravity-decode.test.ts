import { describe, expect, it } from 'vitest'

import {
  decodeAntigravityGenMetadata,
  decodeAntigravityGeneratorMetadata,
  decodeAntigravityStatusLine,
  parseAntigravityStatusLinePayload,
  toObservations,
} from '../../src/providers/antigravity/index.js'
import { ObservationEnvelope } from '../../src/observations.js'
import { OBSERVATION_SCHEMA_VERSION } from '../../src/schema.js'
import type { DecodeContext } from '../../src/contracts.js'

const context: DecodeContext = { privacyKey: 'k', providerId: 'antigravity', sourceRef: 'ref' }

function varint(n: number): number[] {
  const out: number[] = []
  let v = n
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80)
    v = Math.floor(v / 128)
  }
  out.push(v)
  return out
}

function tag(field: number, wire: number): number[] {
  return varint(field * 8 + wire)
}

function varintField(field: number, n: number): number[] {
  return [...tag(field, 0), ...varint(n)]
}

function lenField(field: number, bytes: number[]): number[] {
  return [...tag(field, 2), ...varint(bytes.length), ...bytes]
}

function textField(field: number, text: string): number[] {
  const bytes = [...new TextEncoder().encode(text)]
  return lenField(field, bytes)
}

function attrField(key: string, value: string): number[] {
  return lenField(20, [...textField(1, key), ...textField(2, value)])
}

function sqliteRow(idx: number, hex: string): { idx: number; data: Uint8Array } {
  return { idx, data: Buffer.from(hex, 'hex') }
}

describe('antigravity rich decode (moved to @codeburn/core)', () => {
  it('G2: per-cascade seenResponseIds deduplicates identical response ids', () => {
    const usage = lenField(4, [...varintField(2, 100), ...varintField(3, 10), ...textField(11, 'dup-response')])
    const chatModel = [...usage, ...textField(19, 'gemini-pro-default'), ...textField(21, 'Gemini 3.1 Pro (High)')]
    const hex = Buffer.from(lenField(1, chatModel)).toString('hex')

    const { calls } = decodeAntigravityGenMetadata({
      records: [sqliteRow(0, hex), sqliteRow(1, hex)],
      context,
      cascadeId: 'g2-dedup',
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      provider: 'antigravity',
      model: 'gemini-3.1-pro-high',
      inputTokens: 100,
      outputTokens: 10,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      timestamp: '',
      speed: 'standard',
      deduplicationKey: 'antigravity:g2-dedup:dup-response',
      sessionId: 'g2-dedup',
    })
  })

  it('G3: responseTokens falls back to totalOutputTokens when split fields are absent', () => {
    const usage = lenField(4, [...varintField(2, 50), ...varintField(3, 500)])
    const chatModel = [...usage, ...textField(19, 'gemini-pro-default'), ...textField(21, 'Gemini 3.1 Pro (High)')]
    const hex = Buffer.from(lenField(1, chatModel)).toString('hex')

    const { calls } = decodeAntigravityGenMetadata({
      records: [sqliteRow(0, hex)],
      context,
      cascadeId: 'g3-total-output',
    })

    expect(calls[0]).toMatchObject({ outputTokens: 500, reasoningTokens: 0 })
  })

  it('G4: output split adjust arm reconciles response + thinking to total', () => {
    const usage = lenField(4, [
      ...varintField(2, 80),
      ...varintField(3, 100),
      ...varintField(9, 10),
      ...varintField(10, 30),
    ])
    const chatModel = [...usage, ...textField(19, 'gemini-pro-default'), ...textField(21, 'Gemini 3.1 Pro (High)')]
    const hex = Buffer.from(lenField(1, chatModel)).toString('hex')

    const { calls } = decodeAntigravityGenMetadata({
      records: [sqliteRow(0, hex)],
      context,
      cascadeId: 'g4-adjust',
    })

    expect(calls[0]).toMatchObject({ outputTokens: 70, reasoningTokens: 30 })
  })

  it('G5: inputTokens falls back to field #1 when field #2 is absent', () => {
    const usage = lenField(4, [...varintField(1, 777), ...varintField(3, 5)])
    const chatModel = [...usage, ...textField(19, 'gemini-pro-default'), ...textField(21, 'Gemini 3.1 Pro (High)')]
    const hex = Buffer.from(lenField(1, chatModel)).toString('hex')

    const { calls } = decodeAntigravityGenMetadata({
      records: [sqliteRow(0, hex)],
      context,
      cascadeId: 'g5-input-fallback',
    })

    expect(calls[0]).toMatchObject({ inputTokens: 777 })
  })

  it('G6: responseId falls back to row idx when field #11 is absent', () => {
    const usage = lenField(4, [...varintField(2, 33), ...varintField(3, 3)])
    const chatModel = [...usage, ...textField(19, 'gemini-pro-default'), ...textField(21, 'Gemini 3.1 Pro (High)')]
    const hex = Buffer.from(lenField(1, chatModel)).toString('hex')

    const { calls } = decodeAntigravityGenMetadata({
      records: [sqliteRow(3, hex)],
      context,
      cascadeId: 'g6-response-id-fallback',
    })

    expect(calls[0]).toMatchObject({ deduplicationKey: 'antigravity:g6-response-id-fallback:3' })
  })

  it('G7: model precedence and placeholder guard produce distinct canonical models', () => {
    const baseUsage = lenField(4, [...varintField(2, 10), ...varintField(3, 1)])

    const aChat = [...baseUsage, ...textField(19, 'gemini-3.1-pro-high')]
    const bChat = [...baseUsage, ...attrField('model_enum', 'gemini-3.5-flash-agent')]
    const cChat = [...baseUsage, ...textField(21, 'Gemini 3 Flash')]
    const dChat = [...baseUsage]
    const eChat = [...baseUsage, ...textField(19, 'MODEL_PLACEHOLDER_M99')]

    const { calls } = decodeAntigravityGenMetadata({
      records: [
        sqliteRow(0, Buffer.from(lenField(1, aChat)).toString('hex')),
        sqliteRow(1, Buffer.from(lenField(1, bChat)).toString('hex')),
        sqliteRow(2, Buffer.from(lenField(1, cChat)).toString('hex')),
        sqliteRow(3, Buffer.from(lenField(1, dChat)).toString('hex')),
        sqliteRow(4, Buffer.from(lenField(1, eChat)).toString('hex')),
      ],
      context,
      cascadeId: 'g7-model-precedence',
    })

    expect(calls.map(c => c.model)).toEqual([
      'gemini-3.1-pro-high',
      'gemini-3.5-flash-agent',
      'gemini-3-flash',
      'unknown',
      'unknown',
    ])
  })

  it('G8: chatStartMetadata.created_at beats any host mtime', () => {
    const seconds = 1783326234
    const nanos = 724675400
    const timestamp = [...varintField(1, seconds), ...varintField(2, nanos)]
    const chatStartMetadata = lenField(4, timestamp)
    const usage = lenField(4, [...varintField(2, 100), ...varintField(3, 50)])
    const chatModel = [...usage, ...lenField(9, chatStartMetadata)]
    const hex = Buffer.from(lenField(1, chatModel)).toString('hex')

    const { calls } = decodeAntigravityGenMetadata({
      records: [sqliteRow(0, hex)],
      context,
      cascadeId: 'g8-created-at',
    })

    expect(calls[0]).toMatchObject({ timestamp: '2026-07-06T08:23:54.724Z' })
  })

  it('G9: zero input and output tokens skip the row', () => {
    const usage = lenField(4, [...varintField(2, 0), ...varintField(3, 0)])
    const chatModel = [...usage, ...textField(19, 'gemini-pro-default'), ...textField(21, 'Gemini 3.1 Pro (High)')]
    const hex = Buffer.from(lenField(1, chatModel)).toString('hex')

    const { calls } = decodeAntigravityGenMetadata({
      records: [sqliteRow(0, hex)],
      context,
      cascadeId: 'g9-zero',
    })

    expect(calls).toEqual([])
  })

  it('G14: RPC generator metadata decode handles skips, fallbacks, model map, and timestamps', () => {
    const modelMap = {
      'raw-model-a': 'gemini-3-pro',
      'placeholder-key': 'MODEL_PLACEHOLDER_7',
    }

    const metadata = [
      { chatModel: { model: 'no-usage' } },
      {
        chatModel: {
          model: 'zero',
          usage: {
            model: 'zero',
            inputTokens: '0',
            outputTokens: '0',
            apiProvider: 'google',
          },
        },
      },
      {
        chatModel: {
          model: 'unmapped-model-a',
          usage: {
            model: 'unmapped-model-a',
            inputTokens: '100',
            outputTokens: '20',
            responseOutputTokens: '15',
            thinkingOutputTokens: '5',
            apiProvider: 'google',
          },
        },
      },
      {
        chatModel: {
          model: 'raw-model-a',
          usage: {
            model: 'raw-model-a',
            inputTokens: '50',
            outputTokens: '10',
            responseOutputTokens: '8',
            thinkingOutputTokens: '2',
            apiProvider: 'google',
            responseId: 'mapped-call',
          },
        },
      },
      {
        chatModel: {
          model: 'unmapped-model-b',
          usage: {
            model: 'unmapped-model-b',
            inputTokens: '77',
            outputTokens: '7',
            responseOutputTokens: '6',
            thinkingOutputTokens: '1',
            apiProvider: 'google',
            responseId: 'raw-passthrough-call',
          },
        },
      },
      {
        chatModel: {
          model: 'placeholder-key',
          usage: {
            model: 'placeholder-key',
            inputTokens: '25',
            outputTokens: '5',
            responseOutputTokens: '4',
            thinkingOutputTokens: '1',
            apiProvider: 'google',
            responseId: 'placeholder-call',
          },
        },
      },
      {
        chatModel: {
          model: 'with-timestamp',
          usage: {
            model: 'with-timestamp',
            inputTokens: '99',
            outputTokens: '9',
            responseOutputTokens: '9',
            apiProvider: 'google',
            responseId: 'timestamp-call',
          },
          chatStartMetadata: { createdAt: '2026-03-15T09:30:00.000Z' },
        },
      },
      {
        chatModel: {
          model: 'no-timestamp',
          usage: {
            model: 'no-timestamp',
            inputTokens: '11',
            outputTokens: '2',
            responseOutputTokens: '2',
            apiProvider: 'google',
            responseId: 'no-timestamp-call',
          },
        },
      },
    ]

    const { calls } = decodeAntigravityGeneratorMetadata({
      records: metadata as unknown[],
      context,
      cascadeId: 'g14-rpc',
      modelMap,
    })

    expect(calls).toHaveLength(6)
    expect(calls.map(c => c.deduplicationKey)).toEqual([
      'antigravity:g14-rpc:2',
      'antigravity:g14-rpc:mapped-call',
      'antigravity:g14-rpc:raw-passthrough-call',
      'antigravity:g14-rpc:placeholder-call',
      'antigravity:g14-rpc:timestamp-call',
      'antigravity:g14-rpc:no-timestamp-call',
    ])
    expect(calls.map(c => ({ model: c.model, inputTokens: c.inputTokens, outputTokens: c.outputTokens, reasoningTokens: c.reasoningTokens, timestamp: c.timestamp }))).toEqual([
      { model: 'unmapped-model-a', inputTokens: 100, outputTokens: 15, reasoningTokens: 5, timestamp: '' },
      { model: 'gemini-3-pro', inputTokens: 50, outputTokens: 8, reasoningTokens: 2, timestamp: '' },
      { model: 'unmapped-model-b', inputTokens: 77, outputTokens: 6, reasoningTokens: 1, timestamp: '' },
      { model: 'unknown', inputTokens: 25, outputTokens: 4, reasoningTokens: 1, timestamp: '' },
      { model: 'with-timestamp', inputTokens: 99, outputTokens: 9, reasoningTokens: 0, timestamp: '2026-03-15T09:30:00.000Z' },
      { model: 'no-timestamp', inputTokens: 11, outputTokens: 2, reasoningTokens: 0, timestamp: '' },
    ])
  })

  it('statusline: run collapse, monotonic delta, and seenKeys respect', () => {
    const lines = [
      JSON.stringify({ at: '2026-01-01T00:00:01.000Z', conversationId: 's1', model: 'm', usage: { inputTokens: 100, outputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } }),
      JSON.stringify({ at: '2026-01-01T00:00:02.000Z', conversationId: 's1', model: 'm', usage: { inputTokens: 200, outputTokens: 20, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } }),
      JSON.stringify({ at: '2026-01-01T00:00:03.000Z', conversationId: 's1', model: 'm', usage: { inputTokens: 200, outputTokens: 20, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } }),
      JSON.stringify({ at: '2026-01-01T00:00:04.000Z', conversationId: 's1', model: 'm', usage: { inputTokens: 300, outputTokens: 30, cacheCreationInputTokens: 0, cacheReadInputTokens: 50 } }),
    ]

    const { calls } = decodeAntigravityStatusLine({ records: lines, context, seenKeys: new Set() })

    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ inputTokens: 200, outputTokens: 20, cacheReadInputTokens: 0 })
    expect(calls[1]).toMatchObject({ inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 50 })
  })

  it('acceptance: a display-name model read from payload.model.display_name is normalized at the observation boundary', () => {
    // The status-line decoder reads payload.model.display_name verbatim when no
    // id is present (e.g. "Gemini 3.5 Flash (High)"). The observation boundary
    // must normalize it to 'unknown' instead of rejecting the whole envelope.
    const payload = {
      conversation_id: 'accept-1',
      model: { display_name: 'Gemini 3.5 Flash (High)' },
      context_window: {
        current_usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    }
    const event = parseAntigravityStatusLinePayload(payload, '2026-05-05T05:05:05.005Z')
    expect(event).not.toBeNull()
    expect(event!.model).toBe('Gemini 3.5 Flash (High)')

    const { calls } = decodeAntigravityStatusLine({
      records: [JSON.stringify(event)],
      context,
      seenKeys: new Set(),
    })
    expect(calls[0]!.model).toBe('Gemini 3.5 Flash (High)')

    const { sessions } = toObservations(
      { sessionId: 'accept-1', projectPath: '/Users/t/project', calls },
      { privacyKey: 'test-privacy-key', provider: 'antigravity' },
    )
    const envelope = {
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      generator: { name: '@codeburn/core', version: '0.0.0-test' },
      sessions,
    }
    expect(ObservationEnvelope.safeParse(envelope).success).toBe(true)
    expect(sessions[0]!.calls[0]!.model).toBe('unknown')
    expect(JSON.stringify(envelope)).not.toContain('Gemini 3.5 Flash')
  })

  it('parseAntigravityStatusLinePayload uses the injected at value and never captures cwd', () => {
    const fixedAt = '2026-05-05T05:05:05.005Z'
    const payload = {
      conversation_id: 'parse-test',
      session_id: 'session-secret',
      cwd: '/Users/victim/secret-project',
      model: { id: 'gemini-3-pro', display_name: 'Gemini 3 Pro' },
      context_window: {
        current_usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }

    const event = parseAntigravityStatusLinePayload(payload, fixedAt)
    expect(event).not.toBeNull()
    expect(event!.at).toBe(fixedAt)
    expect(event).not.toHaveProperty('cwd')
    expect(JSON.stringify(event)).not.toContain('/Users/victim/secret-project')
  })

  it('toObservations produces a schema-valid, secret-free envelope', () => {
    const chatStartMetadata = textField(4, '2026-07-17T10:00:00.000Z')
    const usage = lenField(4, [...varintField(2, 100), ...varintField(3, 10)])
    const chatModel = [...usage, ...lenField(9, chatStartMetadata), ...textField(19, 'gemini-3.1-pro-high')]
    const hex = Buffer.from(lenField(1, chatModel)).toString('hex')

    const { calls } = decodeAntigravityGenMetadata({
      records: [sqliteRow(0, hex)],
      context,
      cascadeId: 'obs-test',
    })

    const { sessions } = toObservations(
      { sessionId: 'obs-test', projectPath: '/Users/t/secret-project', calls },
      { privacyKey: 'test-privacy-key', provider: 'antigravity' },
    )

    const envelope = {
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      generator: { name: '@codeburn/core', version: '0.0.0-test' },
      sessions,
    }

    expect(ObservationEnvelope.safeParse(envelope).success).toBe(true)
    expect(sessions[0]?.calls[0]?.toolNames).toEqual([])
    expect(JSON.stringify(envelope)).not.toContain('/Users/t/secret-project')
  })
})

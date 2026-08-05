import { describe, expect, it } from 'vitest'

import { decodeWarp, toObservations } from '../../src/providers/warp/index.js'
import { ObservationEnvelope } from '../../src/observations.js'
import { OBSERVATION_SCHEMA_VERSION } from '../../src/schema.js'
import type { DecodeContext } from '../../src/contracts.js'
import type { WarpBlockRow, WarpConversationRow, WarpQueryRow } from '../../src/providers/warp/types.js'

const context: DecodeContext = { privacyKey: 'k', providerId: 'warp', sourceRef: 'ref' }

function makeComposite(
  conversationId: string,
  conversation: WarpConversationRow,
  exchanges: WarpQueryRow[],
  blocks: WarpBlockRow[] = [],
  sourceProject = 'warp',
) {
  return { conversationId, conversation, exchanges, blocks, sourceProject }
}

const BASE_CONVERSATION: WarpConversationRow = {
  conversation_id: 'conv-a',
  conversation_data: JSON.stringify({
    conversation_usage_metadata: {
      token_usage: [
        {
          model_id: 'GPT-5.3 Codex (medium reasoning)',
          warp_tokens: 300,
          byok_tokens: 0,
          warp_token_usage_by_category: { primary_agent: 300 },
          byok_token_usage_by_category: {},
        },
      ],
    },
  }),
  last_modified_at: '2026-05-18 10:10:00',
}

function makeExchange(id: string, overrides: Partial<WarpQueryRow> = {}): WarpQueryRow {
  return {
    exchange_id: id,
    conversation_id: 'conv-a',
    start_ts: '2026-05-18 10:00:00.000000',
    input: JSON.stringify([{ Query: { text: 'hello warp' } }]),
    working_directory: '/Users/me/projects/codeburn',
    output_status: '"Completed"',
    model_id: 'auto-efficient',
    planning_model_id: '',
    coding_model_id: '',
    ...overrides,
  }
}

describe('warp rich decode (moved to @codeburn/core)', () => {
  it('decodes a conversation + exchanges into cost-free rich calls', () => {
    const exchanges: WarpQueryRow[] = [
      makeExchange('ex-1'),
      makeExchange('ex-2', { input: JSON.stringify([{ Query: { text: 'a much longer prompt for weighting purposes' } }]) }),
    ]
    const { calls } = decodeWarp({ records: [makeComposite('conv-a', BASE_CONVERSATION, exchanges)], context })
    expect(calls).toHaveLength(2)
    expect(calls[0]!.provider).toBe('warp')
    expect(calls[0]!.sessionId).toBe('conv-a')
    expect(calls[0]!.model).toBe('gpt-5.3-codex')
    expect(calls[0]!.inputTokens + calls[1]!.inputTokens).toBe(300)
    expect(calls[0]!.userMessage).toBe('hello warp')
    expect(calls[0]!.deduplicationKey).toBe('warp:conv-a:ex-1')
    expect(calls[0]!.project).toBe('Users-me-projects-codeburn')
    expect(calls[0]!.projectPath).toBe('/Users/me/projects/codeburn')
    expect(calls[0]!).not.toHaveProperty('costBasis')
    expect(calls[0]!).not.toHaveProperty('costUSD')
  })

  it('threads a live seenKeys set so a repeated exchange drops', () => {
    const exchanges: WarpQueryRow[] = [makeExchange('ex-1')]
    const seen = new Set<string>()
    const first = decodeWarp({
      records: [makeComposite('conv-a', BASE_CONVERSATION, exchanges)],
      context,
      seenKeys: seen,
    }).calls
    expect(first).toHaveLength(1)
    const again = decodeWarp({
      records: [makeComposite('conv-a', BASE_CONVERSATION, exchanges)],
      context,
      seenKeys: seen,
    }).calls
    expect(again).toEqual([])
  })

  it('skips non-final exchanges', () => {
    const exchanges: WarpQueryRow[] = [
      makeExchange('ex-final'),
      makeExchange('ex-pending', { output_status: '"Pending"' }),
    ]
    const { calls } = decodeWarp({ records: [makeComposite('conv-a', BASE_CONVERSATION, exchanges)], context })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.deduplicationKey).toBe('warp:conv-a:ex-final')
  })

  it('skips exchanges with invalid timestamps and does not poison seenKeys', () => {
    const exchanges: WarpQueryRow[] = [
      makeExchange('ex-bad-ts', { start_ts: 'not-a-timestamp' }),
      makeExchange('ex-ok'),
    ]
    const seen = new Set<string>()
    const { calls } = decodeWarp({
      records: [makeComposite('conv-a', BASE_CONVERSATION, exchanges)],
      context,
      seenKeys: seen,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.deduplicationKey).toBe('warp:conv-a:ex-ok')
    expect(seen.has('warp:conv-a:ex-bad-ts')).toBe(false)
  })

  it('allocates tokens proportionally by estimated weight', () => {
    const exchanges: WarpQueryRow[] = [
      makeExchange('ex-short', { input: JSON.stringify([{ Query: { text: 'hi' } }]) }),
      makeExchange('ex-long', { input: JSON.stringify([{ Query: { text: 'this is a substantially longer user prompt for weighting' } }]) }),
    ]
    const { calls } = decodeWarp({ records: [makeComposite('conv-a', BASE_CONVERSATION, exchanges)], context })
    expect(calls).toHaveLength(2)
    expect(calls[0]!.inputTokens + calls[1]!.inputTokens).toBe(300)
    expect(calls[1]!.inputTokens).toBeGreaterThan(calls[0]!.inputTokens)
  })

  it('attributes command blocks to the nearest preceding exchange and emits raw commands', () => {
    const exchanges: WarpQueryRow[] = [
      makeExchange('ex-a', { start_ts: '2026-05-18 11:00:00.000000' }),
      makeExchange('ex-b', { start_ts: '2026-05-18 11:05:00.000000' }),
    ]
    const blocks: WarpBlockRow[] = [
      { block_id: 'block-1', start_ts: '2026-05-18 11:01:00.000000', stylized_command: 'npm test && git status' },
    ]
    const { calls } = decodeWarp({ records: [makeComposite('conv-a', BASE_CONVERSATION, exchanges, blocks)], context })
    const callA = calls.find(c => c.deduplicationKey === 'warp:conv-a:ex-a')
    const callB = calls.find(c => c.deduplicationKey === 'warp:conv-a:ex-b')
    expect(callA).toBeDefined()
    expect(callA!.tools).toEqual(['Bash'])
    expect(callA!.rawBashCommands).toEqual(['npm test && git status'])
    expect(callB!.tools).toEqual([])
    expect(callB!.rawBashCommands).toEqual([])
  })

  it('maps run_command blocks to the canonical Bash tool name', () => {
    const exchanges: WarpQueryRow[] = [makeExchange('ex-a')]
    const blocks: WarpBlockRow[] = [
      { block_id: 'block-1', start_ts: '2026-05-18 10:00:01.000000', stylized_command: 'ls -la' },
    ]
    const { calls } = decodeWarp({ records: [makeComposite('conv-a', BASE_CONVERSATION, exchanges, blocks)], context })
    expect(calls[0]!.tools).toEqual(['Bash'])
  })

  it('falls back to warp-auto-efficient when no model is available', () => {
    const conversation: WarpConversationRow = {
      ...BASE_CONVERSATION,
      conversation_data: JSON.stringify({ conversation_usage_metadata: { token_usage: [] } }),
    }
    const exchanges: WarpQueryRow[] = [
      makeExchange('ex-1', { model_id: '', input: JSON.stringify([{ Query: { text: 'hello' } }]) }),
    ]
    const { calls } = decodeWarp({ records: [makeComposite('conv-a', conversation, exchanges)], context })
    expect(calls[0]!.model).toBe('warp-auto-efficient')
  })

  it('resolves auto-efficient to the dominant model when present', () => {
    const exchanges: WarpQueryRow[] = [makeExchange('ex-1', { model_id: 'auto-efficient' })]
    const { calls } = decodeWarp({ records: [makeComposite('conv-a', BASE_CONVERSATION, exchanges)], context })
    expect(calls[0]!.model).toBe('gpt-5.3-codex')
  })

  it('acceptance: a display-name model the alias map does not cover is normalized at the observation boundary', () => {
    // Warp's alias map is closed, so any NEW model id arrives verbatim (spaces
    // and all) — e.g. "GPT-5.4 Codex (medium reasoning)" or "Claude Sonnet
    // 4.7". The decode passes it through; the observation boundary must
    // normalize it to 'unknown' instead of rejecting the whole envelope.
    const exchanges: WarpQueryRow[] = [makeExchange('ex-1', { model_id: 'GPT-5.4 Codex (medium reasoning)' })]
    const { calls } = decodeWarp({ records: [makeComposite('conv-a', BASE_CONVERSATION, exchanges)], context })
    expect(calls[0]!.model).toBe('GPT-5.4 Codex (medium reasoning)')

    const { sessions } = toObservations(
      { sessionId: 'conv-a', projectPath: '/Users/me/projects/codeburn', calls },
      { privacyKey: 'test-privacy-key', provider: 'warp' },
    )
    const envelope = {
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      generator: { name: '@codeburn/core', version: '0.0.0-test' },
      sessions,
    }
    expect(ObservationEnvelope.safeParse(envelope).success).toBe(true)
    expect(sessions[0]!.calls[0]!.model).toBe('unknown')
    expect(JSON.stringify(envelope)).not.toContain('GPT-5.4 Codex')
  })

  it('uses the fallback token budget when conversation usage is absent', () => {
    const conversation: WarpConversationRow = {
      ...BASE_CONVERSATION,
      conversation_data: JSON.stringify({ conversation_usage_metadata: { token_usage: [] } }),
    }
    const exchanges: WarpQueryRow[] = [makeExchange('ex-1')]
    const { calls } = decodeWarp({ records: [makeComposite('conv-a', conversation, exchanges)], context })
    expect(calls[0]!.inputTokens).toBeGreaterThan(0)
  })

  it('toObservations produces a schema-valid, content-free envelope', () => {
    const exchanges: WarpQueryRow[] = [makeExchange('ex-1')]
    const blocks: WarpBlockRow[] = [
      { block_id: 'block-1', start_ts: '2026-05-18 10:00:01.000000', stylized_command: 'npm test' },
    ]
    const { calls } = decodeWarp({ records: [makeComposite('conv-a', BASE_CONVERSATION, exchanges, blocks)], context })
    const { sessions } = toObservations(
      { sessionId: 'conv-a', projectPath: '/Users/me/projects/codeburn', calls },
      { privacyKey: 'test-privacy-key', provider: 'warp' },
    )
    const envelope = {
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      generator: { name: '@codeburn/core', version: '0.0.0-test' },
      sessions,
    }
    expect(ObservationEnvelope.safeParse(envelope).success).toBe(true)
    expect(sessions[0]!.calls[0]!.toolNames).toEqual(['Bash'])
  })
})

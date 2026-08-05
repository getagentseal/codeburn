import { describe, expect, it } from 'vitest'

import { decodeCodex } from '../../src/providers/codex/index.js'
import type { CodexDecodeState } from '../../src/providers/codex/index.js'
import type { DecodeContext } from '../../src/contracts.js'

const context: DecodeContext = { privacyKey: 'k', providerId: 'codex', sourceRef: 'ref' }

function sessionMeta(opts: { session_id: string; model?: string; forked_from_id?: string; timestamp?: string; cwd?: string }) {
  return JSON.stringify({
    type: 'session_meta',
    timestamp: opts.timestamp ?? '2026-04-14T10:00:00Z',
    payload: {
      cwd: opts.cwd ?? '/Users/t/p',
      originator: 'codex-cli',
      session_id: opts.session_id,
      model: opts.model ?? 'gpt-5.3-codex',
      ...(opts.forked_from_id ? { forked_from_id: opts.forked_from_id } : {}),
    },
  })
}
function userMessage(text: string, timestamp: string) {
  return JSON.stringify({ type: 'response_item', timestamp, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
}
function assistantMessage(text: string, timestamp: string) {
  return JSON.stringify({ type: 'response_item', timestamp, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } })
}
function functionCall(name: string, timestamp: string) {
  return JSON.stringify({ type: 'response_item', timestamp, payload: { type: 'function_call', name } })
}
function tokenCount(opts: { timestamp: string; last?: { input?: number; cached?: number; output?: number; reasoning?: number }; total?: { input?: number; cached?: number; output?: number; reasoning?: number; total?: number }; noInfo?: boolean }) {
  const info = opts.noInfo ? undefined : {
    last_token_usage: opts.last ? { input_tokens: opts.last.input ?? 0, cached_input_tokens: opts.last.cached ?? 0, output_tokens: opts.last.output ?? 0, reasoning_output_tokens: opts.last.reasoning ?? 0, total_tokens: (opts.last.input ?? 0) + (opts.last.output ?? 0) } : undefined,
    total_token_usage: opts.total ? { input_tokens: opts.total.input ?? 0, cached_input_tokens: opts.total.cached ?? 0, output_tokens: opts.total.output ?? 0, reasoning_output_tokens: opts.total.reasoning ?? 0, total_tokens: opts.total.total ?? 0 } : undefined,
  }
  return JSON.stringify({ type: 'event_msg', timestamp: opts.timestamp, payload: { type: 'token_count', ...(opts.noInfo ? {} : { info }) } })
}

// A corpus spanning THREE sessions, including a forked session that replays the
// parent's history and a session whose token_count carries no info (char-estimate
// branch). Session boundaries (session_meta) exercise the per-session reset while
// the fork boundary exercises cross-session dedup memory in the threaded state.
const CORPUS: string[] = [
  // Session A (parent): 1100 tokens of real work across two turns.
  sessionMeta({ session_id: 'sess-parent', timestamp: '2026-04-14T10:00:00Z' }),
  userMessage('fix the parser', '2026-04-14T10:00:01Z'),
  functionCall('exec_command', '2026-04-14T10:00:02Z'),
  tokenCount({ timestamp: '2026-04-14T10:00:03Z', last: { input: 700 }, total: { input: 700, total: 700 } }),
  userMessage('now the tests', '2026-04-14T10:00:04Z'),
  functionCall('read_file', '2026-04-14T10:00:05Z'),
  tokenCount({ timestamp: '2026-04-14T10:00:06Z', last: { input: 400 }, total: { input: 1100, total: 1100 } }),
  // Session B (fork of A): replays A's two events past the 5s cutoff, then +400.
  sessionMeta({ session_id: 'sess-fork', forked_from_id: 'sess-parent', timestamp: '2026-04-14T10:05:00Z' }),
  tokenCount({ timestamp: '2026-04-14T10:05:20Z', last: { input: 700 }, total: { input: 700, total: 700 } }),
  tokenCount({ timestamp: '2026-04-14T10:05:21Z', last: { input: 400 }, total: { input: 1100, total: 1100 } }),
  functionCall('spawn_agent', '2026-04-14T10:05:22Z'),
  tokenCount({ timestamp: '2026-04-14T10:05:23Z', last: { input: 400 }, total: { input: 1500, total: 1500 } }),
  // Session C: char-estimate branch (token_count with no info).
  sessionMeta({ session_id: 'sess-est', model: 'gpt-5.5', timestamp: '2026-04-14T11:00:00Z' }),
  userMessage('hello there estimate branch', '2026-04-14T11:00:01Z'),
  assistantMessage('a fairly long assistant reply that should estimate some output tokens here', '2026-04-14T11:00:02Z'),
  tokenCount({ timestamp: '2026-04-14T11:00:03Z', noInfo: true }),
]

const FORK_BOUNDARY_INDEX = 7 // the fork's session_meta
const MID_PARENT_INDEX = 4    // between A's two turns

function decodeCold(records: string[]) {
  return decodeCodex({ records, context }).calls
}

function decodeTwoPass(records: string[], split: number) {
  const first = decodeCodex({ records: records.slice(0, split), context })
  // Serialize state to JSON and back between passes (the resume invariant).
  const serialized: CodexDecodeState = JSON.parse(JSON.stringify(first.state))
  const second = decodeCodex({ records: records.slice(split), context, state: serialized })
  return [...first.calls, ...second.calls]
}

describe('codex decoder — round-trip resume invariant', () => {
  it('cold single pass produces the expected number of calls', () => {
    const cold = decodeCold(CORPUS)
    // A: 2 real turns; fork: replays dropped, 1 genuine; C: 1 estimate = 4.
    expect(cold).toHaveLength(4)
    // The fork's genuine event survives (input 400 at cumulative 1500).
    const tokensTotal = cold.reduce((n, c) => n + c.inputTokens + c.outputTokens + c.cachedInputTokens + c.reasoningTokens, 0)
    // A: 700 + 400; fork: +400; C: estimate input+output.
    expect(tokensTotal).toBeGreaterThan(1500)
  })

  it('two-pass split at EVERY index deep-equals the cold pass', () => {
    const cold = decodeCold(CORPUS)
    for (let split = 0; split <= CORPUS.length; split++) {
      const twoPass = decodeTwoPass(CORPUS, split)
      expect(twoPass, `split at index ${split}`).toEqual(cold)
    }
  })

  it('mid-session split (between two turns of the same session) matches cold', () => {
    expect(decodeTwoPass(CORPUS, MID_PARENT_INDEX)).toEqual(decodeCold(CORPUS))
  })

  it('split across the forked-session boundary matches cold (dedup memory threads)', () => {
    expect(decodeTwoPass(CORPUS, FORK_BOUNDARY_INDEX)).toEqual(decodeCold(CORPUS))
  })

  it('serialized state is plain JSON (no Map/Set/undefined-only loss)', () => {
    const { state } = decodeCodex({ records: CORPUS.slice(0, FORK_BOUNDARY_INDEX), context })
    const round = JSON.parse(JSON.stringify(state)) as CodexDecodeState
    // seenKeys survives as an array carrying the parent's dedup fingerprints.
    expect(Array.isArray(round.seenKeys)).toBe(true)
    expect(round.seenKeys.length).toBeGreaterThan(0)
    // prevCumulativeTotal is a JSON-safe null|number.
    expect(round.prevCumulativeTotal === null || typeof round.prevCumulativeTotal === 'number').toBe(true)
  })

  it('a fork replay is dropped only because seenKeys threaded across the split', () => {
    // Splitting exactly at the fork boundary, WITHOUT threading state, would let
    // the fork replay its parent's events (double count). With threaded state the
    // replay collides and drops — proving the dedup memory is in the state.
    const threaded = decodeTwoPass(CORPUS, FORK_BOUNDARY_INDEX)
    const parentAndForkFresh = [
      ...decodeCodex({ records: CORPUS.slice(0, FORK_BOUNDARY_INDEX), context }).calls,
      // second pass with NO state: the fork can't see the parent's keys.
      ...decodeCodex({ records: CORPUS.slice(FORK_BOUNDARY_INDEX), context }).calls,
    ]
    expect(parentAndForkFresh.length).toBeGreaterThan(threaded.length)
  })
})

// Structural discovery (issue #873/#626) admits rollouts from third-party
// frontends whose schema conformance is unverified, so payload fields can hold
// anything JSON can express. The decoder must not trust the declared types:
// an unparseable timestamp used to throw RangeError out of the fork-cutoff
// `new Date(NaN).toISOString()`, and a non-string model reached the host's
// pricing pass, which calls `.replace()` on it. Either sank the session's
// usage to zero instead of counting it.
describe('codex decoder — untrusted fields from structurally-valid rollouts', () => {
  const forkedMeta = (timestamp: unknown) => JSON.stringify({
    type: 'session_meta',
    ...(timestamp !== undefined ? { timestamp } : {}),
    payload: {
      cwd: '/Users/t/fork',
      session_id: 'sess-fork',
      model: 'gpt-5.5',
      originator: 't3code_desktop',
      forked_from_id: 'parent-1',
    },
  })

  it('counts a forked rollout whose timestamp is unparseable instead of throwing it to zero', () => {
    const records = [
      forkedMeta('not-a-real-timestamp'),
      tokenCount({ timestamp: '2026-04-14T10:01:00Z', last: { input: 100, output: 50 }, total: { total: 150 } }),
    ]
    // Pre-guard this threw RangeError out of toISOString() and zeroed the session.
    const calls = decodeCold(records)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens + calls[0]!.outputTokens).toBe(150)
  })

  it('counts a forked rollout with a numeric or missing timestamp instead of throwing', () => {
    for (const timestamp of [12345, undefined]) {
      const calls = decodeCold([
        forkedMeta(timestamp),
        tokenCount({ timestamp: '2026-04-14T10:01:00Z', last: { input: 100, output: 50 }, total: { total: 150 } }),
      ])
      expect(calls).toHaveLength(1)
      expect(calls[0]!.inputTokens + calls[0]!.outputTokens).toBe(150)
    }
  })

  it('counts a rollout with a non-string model via the fallback instead of throwing', () => {
    const records = [
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-04-14T10:00:00Z',
        payload: { cwd: '/Users/t/m', session_id: 'sess-badmodel', model: { name: 'gpt-5.5' }, originator: 't3code_desktop' },
      }),
      userMessage('fix the bug', '2026-04-14T10:00:01Z'),
      tokenCount({ timestamp: '2026-04-14T10:00:03Z', last: { input: 100 }, total: { input: 100, total: 100 } }),
    ]
    // Pre-guard the object model rode into the pricing pass ("model.replace is
    // not a function"); it must fall back to a real model and be counted.
    const calls = decodeCold(records)
    expect(calls).toHaveLength(1)
    expect(typeof calls[0]!.model).toBe('string')
  })

  it('ignores a non-string model on turn_context instead of overriding the session model', () => {
    const records = [
      sessionMeta({ session_id: 'sess-tc', model: 'gpt-5.3-codex' }),
      JSON.stringify({
        type: 'turn_context',
        timestamp: '2026-04-14T10:00:02Z',
        payload: { model: { name: 'gpt-5.5' }, cwd: '/x' },
      }),
      userMessage('fix the bug', '2026-04-14T10:00:03Z'),
      tokenCount({ timestamp: '2026-04-14T10:00:05Z', last: { input: 100 }, total: { input: 100, total: 100 } }),
    ]
    const calls = decodeCold(records)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.model).toBe('gpt-5.3-codex')
  })

  it('does not leak a non-string cwd into projectPath/workingDirectory', () => {
    const records = [
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-04-14T10:00:00Z',
        payload: { cwd: 123, session_id: 'sess-badcwd', model: 'gpt-5.5', originator: 't3code_desktop' },
      }),
      userMessage('fix the bug', '2026-04-14T10:00:01Z'),
      tokenCount({ timestamp: '2026-04-14T10:00:03Z', last: { input: 100 }, total: { input: 100, total: 100 } }),
    ]
    const calls = decodeCold(records)
    expect(calls).toHaveLength(1)
    // A numeric cwd must not ride into the call (downstream path helpers call
    // string methods on projectPath/workingDirectory).
    expect(calls[0]!.projectPath).toBeUndefined()
    expect(calls[0]!.workingDirectory).toBeUndefined()
  })

  it('drops a token_count whose timestamp is not a parseable string and records a diagnostic', () => {
    // `timestamp` is declared `string` but arrives off the unchecked cast. A
    // number/object/bool — or garbage text — riding into call.timestamp would
    // make the host's day aggregator bucket the call under 'NaN-NaN-NaN'
    // (Invalid Date), a day the daily cache keeps for ten years. The event is
    // dropped instead of emitted with the unparseable value.
    for (const ts of [12345, { t: '2026-04-14T10:01:00Z' }, ['2026-04-14T10:01:00Z'], true, 'not-a-real-timestamp']) {
      const { calls, diagnostics } = decodeCodex({
        records: [
          sessionMeta({ session_id: 'sess-ts' }),
          userMessage('fix the bug', '2026-04-14T10:00:01Z'),
          tokenCount({ timestamp: ts as unknown as string, last: { input: 100, output: 50 }, total: { total: 150 } }),
        ],
        context,
      })
      expect(calls, `timestamp ${JSON.stringify(ts)}`).toHaveLength(0)
      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]!.code).toBe('invalid-value')
    }
  })

  it('keeps pending content across a dropped token_count so the next flush still counts it', () => {
    // Dropping the bad-timestamp event must not lose the turn: pending user
    // content stays pending, so the next well-formed token_count flushes it.
    const { calls, diagnostics } = decodeCodex({
      records: [
        sessionMeta({ session_id: 'sess-est-keep' }),
        userMessage('estimate this turn', '2026-04-14T10:00:01Z'),
        tokenCount({ timestamp: 12345 as unknown as string, noInfo: true }),
        tokenCount({ timestamp: '2026-04-14T10:00:03Z', noInfo: true }),
      ],
      context,
    })
    expect(diagnostics).toHaveLength(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens + calls[0]!.outputTokens).toBeGreaterThan(0)
  })

  it('turns non-finite token counts into zero instead of letting NaN reach the call', () => {
    // A garbage string/object/bool mixed with real numbers used to turn the
    // totals into a string or NaN (e.g. Math.max(0, 100 - 'oops')), which
    // slipped past the `=== 0` skip and rode into the pricing pass as NaN
    // cost. Non-finite fields now count as zero — the same default as a
    // missing field — so the valid input count still lands.
    const { calls } = decodeCodex({
      records: [
        sessionMeta({ session_id: 'sess-toks' }),
        userMessage('fix the bug', '2026-04-14T10:00:01Z'),
        JSON.stringify({
          type: 'event_msg',
          timestamp: '2026-04-14T10:00:03Z',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                input_tokens: 100,
                cached_input_tokens: 'oops',
                output_tokens: { n: 50 },
                reasoning_output_tokens: true,
                total_tokens: 9999,
              },
              total_token_usage: {
                input_tokens: 100,
                cached_input_tokens: 'oops',
                output_tokens: { n: 50 },
                reasoning_output_tokens: true,
                total_tokens: 9999,
              },
            },
          },
        }),
      ],
      context,
    })
    expect(calls).toHaveLength(1)
    const c = calls[0]!
    expect(c.inputTokens).toBe(100)
    expect(c.cachedInputTokens).toBe(0)
    expect(c.cacheReadInputTokens).toBe(0)
    expect(c.outputTokens).toBe(0)
    expect(c.reasoningTokens).toBe(0)
    for (const n of [c.inputTokens, c.outputTokens, c.cachedInputTokens, c.cacheReadInputTokens, c.reasoningTokens]) {
      expect(Number.isFinite(n)).toBe(true)
    }
  })

  it('skips a token_count whose every count is non-finite instead of emitting NaN tokens', () => {
    const { calls } = decodeCodex({
      records: [
        sessionMeta({ session_id: 'sess-zerotoks' }),
        userMessage('fix the bug', '2026-04-14T10:00:01Z'),
        JSON.stringify({
          type: 'event_msg',
          timestamp: '2026-04-14T10:00:03Z',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: { input_tokens: 'abc', cached_input_tokens: {}, output_tokens: [], reasoning_output_tokens: true, total_tokens: 'zzz' },
              total_token_usage: { input_tokens: 'abc', cached_input_tokens: {}, output_tokens: [], reasoning_output_tokens: true, total_tokens: 'zzz' },
            },
          },
        }),
      ],
      context,
    })
    // All garbage counts as zero, so the existing totalTokens === 0 skip
    // applies — no call, and no NaN anywhere.
    expect(calls).toHaveLength(0)
  })

  it('falls back cleanly instead of coercing a non-string session_id or forked_from_id to [object Object]', () => {
    // An object session_id used to stringify to '[object Object]' inside
    // session ids and dedup keys, silently corrupting both.
    const { calls } = decodeCodex({
      records: [
        JSON.stringify({
          type: 'session_meta',
          timestamp: '2026-04-14T10:00:00Z',
          payload: { cwd: '/Users/t/p', session_id: { nested: 'sess-obj' }, forked_from_id: ['parent-1'], model: 'gpt-5.5', originator: 't3code_desktop' },
        }),
        userMessage('fix the bug', '2026-04-14T10:00:01Z'),
        tokenCount({ timestamp: '2026-04-14T10:00:03Z', last: { input: 100 }, total: { input: 100, total: 100 } }),
      ],
      context,
      sessionIdFallback: 'rollout-fallback',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.sessionId).toBe('rollout-fallback')
    expect(calls[0]!.sessionId).not.toContain('object')
    expect(calls[0]!.deduplicationKey).not.toContain('object')
  })
})

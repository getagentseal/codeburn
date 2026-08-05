import { describe, expect, it } from 'vitest'

import { decodeCodex, applyCodexTimingPatches } from '../../src/providers/codex/index.js'
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

// A single task (task_started -> tool call -> token_count -> task_complete)
// whose active timing must survive ANY split of the decode: a parse that ends
// mid-task (watch mode, refresh during a live run) strands the emitted calls
// without timing unless the window threads through the serialized state and the
// resumed pass hands the host a patch for the earlier-pass calls.
const TIMING_CORPUS: string[] = [
  sessionMeta({ session_id: 'sess-timing', timestamp: '2026-04-14T10:00:00Z' }),
  JSON.stringify({ type: 'event_msg', timestamp: '2026-04-14T10:00:00Z', payload: { type: 'task_started', turn_id: 'turn-1' } }),
  userMessage('run the tool', '2026-04-14T10:00:01Z'),
  JSON.stringify({ type: 'response_item', timestamp: '2026-04-14T10:00:02Z', payload: { type: 'custom_tool_call', call_id: 'call-1', name: 'exec' } }),
  JSON.stringify({ type: 'response_item', timestamp: '2026-04-14T10:00:05Z', payload: { type: 'custom_tool_call_output', call_id: 'call-1', output: 'done' } }),
  tokenCount({ timestamp: '2026-04-14T10:01:10Z', last: { input: 100, output: 100, reasoning: 20 }, total: { total: 220 } }),
  JSON.stringify({ type: 'event_msg', timestamp: '2026-04-14T10:01:11Z', payload: { type: 'task_complete', duration_ms: 10_000 } }),
]

function decodeCold(records: string[]) {
  return decodeCodex({ records, context }).calls
}

function decodeTwoPass(records: string[], split: number) {
  const first = decodeCodex({ records: records.slice(0, split), context })
  // Serialize state to JSON and back between passes (the resume invariant).
  const serialized: CodexDecodeState = JSON.parse(JSON.stringify(first.state))
  const second = decodeCodex({ records: records.slice(split), context, state: serialized, priorCallCount: first.calls.length })
  // The host concatenates the passes' calls and applies any straddling-task
  // timing patches, exactly as the CLI's codex provider does.
  const combined = [...first.calls, ...second.calls]
  applyCodexTimingPatches(combined, [...first.timingPatches, ...second.timingPatches])
  return combined
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

  it('task timing attributes across ANY split — the append-resume window is threaded', () => {
    // The mid-task-cut case: a parse that ends between token_count and
    // task_complete must not strand the call without its timing. Every split
    // (including exactly the straddle) must equal the cold pass, so an
    // append-resume that closes a carried-over task re-attributes the
    // earlier-pass calls via the timing patch.
    const cold = decodeCold(TIMING_CORPUS)
    expect(cold).toHaveLength(1)
    expect(cold[0]).toMatchObject({ activeDurationMs: 7000, activeGeneratedTokens: 120, toolWaitMs: 3000 })
    for (let split = 0; split <= TIMING_CORPUS.length; split++) {
      expect(decodeTwoPass(TIMING_CORPUS, split), `split at index ${split}`).toEqual(cold)
    }
  })

  it('an open task window is carried in the serialized state', () => {
    // Split right after the token_count: pass 1 ends mid-task. The serialized
    // state must expose the window so the resumed pass can close it.
    const split = TIMING_CORPUS.length - 1
    const first = decodeCodex({ records: TIMING_CORPUS.slice(0, split), context })
    expect(first.calls).toHaveLength(1)
    expect(first.calls[0]!.activeDurationMs).toBeUndefined()
    const serialized: CodexDecodeState = JSON.parse(JSON.stringify(first.state))
    expect(serialized.taskResultStart).toBe(0)
    expect(serialized.taskGeneratedTokens).toBe(120)
    expect(serialized.taskToolIntervals).toEqual([[Date.parse('2026-04-14T10:00:02Z'), Date.parse('2026-04-14T10:00:05Z')]])
    // Resuming with the carried window closes the task and patches the earlier
    // pass's call.
    const second = decodeCodex({ records: TIMING_CORPUS.slice(split), context, state: serialized, priorCallCount: first.calls.length })
    expect(second.timingPatches).toHaveLength(1)
    const combined = [...first.calls, ...second.calls]
    applyCodexTimingPatches(combined, second.timingPatches)
    expect(combined[0]).toMatchObject({ activeDurationMs: 7000, activeGeneratedTokens: 120, toolWaitMs: 3000 })
  })
})

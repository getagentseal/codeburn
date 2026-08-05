import { describe, expect, it } from 'vitest'

import { codexToolNameMap, decodeCodex, parseCodexLine } from '../../src/providers/codex/index.js'
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
function customToolCall(name: string, timestamp: string) {
  return JSON.stringify({ type: 'response_item', timestamp, payload: { type: 'custom_tool_call', name } })
}
function patchApplyEnd(opts: { success: boolean; added: number; file: string; timestamp: string }) {
  return JSON.stringify({
    type: 'event_msg',
    timestamp: opts.timestamp,
    payload: {
      type: 'patch_apply_end',
      success: opts.success,
      changes: { [opts.file]: { unified_diff: '+a\n'.repeat(opts.added) } },
    },
  })
}
function mcpToolCallEnd(server: string, tool: string, timestamp: string) {
  return JSON.stringify({ type: 'event_msg', timestamp, payload: { type: 'mcp_tool_call_end', invocation: { server, tool } } })
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

function decodeCold(records: (string | Buffer)[]) {
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

describe('codex decoder — decode fidelity restoration (GAP 1-4)', () => {
  it('GAP 1: custom_tool_call events feed the turn tools and tool sequence', () => {
    const calls = decodeCold([
      sessionMeta({ session_id: 'sess-custom' }),
      userMessage('use the custom tool', '2026-04-14T12:00:01Z'),
      customToolCall('my_custom_tool', '2026-04-14T12:00:02Z'),
      tokenCount({ timestamp: '2026-04-14T12:00:03Z', last: { input: 100 }, total: { input: 100, total: 100 } }),
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.tools).toEqual(['my_custom_tool'])
    expect(calls[0]!.toolSequence).toEqual([[{ tool: 'my_custom_tool' }]])
  })

  it("GAP 2: fork replay does not leak the parent's tool/patch/MCP events into the child turn", () => {
    // Parent: one turn with a FAILED edit alongside Bash + MCP. The child
    // replays that history verbatim inside the 5s fork window, then does its
    // own genuine work (a read + a successful edit on a different file). The
    // child's turn must carry exactly its own tools/sequence/LOC — none of the
    // replayed Bash, failed edit or MCP end. The child fixture has real tool
    // events of its own so the test bites in BOTH directions: an
    // over-aggressive skip that eats everything empties the child turn (child
    // asserts fail); a neutralized skip leaks the parent's replay into it
    // (parent asserts still pass, child asserts fail).
    const calls = decodeCold([
      // Parent session: one turn with a Bash call, a FAILED edit and an MCP call.
      sessionMeta({ session_id: 'sess-parent', timestamp: '2026-04-14T10:00:00Z' }),
      userMessage('parent turn', '2026-04-14T10:00:01Z'),
      functionCall('exec_command', '2026-04-14T10:00:02Z'),
      patchApplyEnd({ success: false, added: 2, file: 'src/a.ts', timestamp: '2026-04-14T10:00:03Z' }),
      mcpToolCallEnd('srv', 't1', '2026-04-14T10:00:04Z'),
      tokenCount({ timestamp: '2026-04-14T10:00:05Z', last: { input: 500 }, total: { input: 500, total: 500 } }),
      // Fork created at 10:05:00 → cutoff 10:05:05. The parent's history is
      // replayed clustered inside the window (10:05:01-04) and must be skipped
      // wholesale — a replayed FAILED patch and MCP end must not leak into the
      // child's turn (which would inflate tools, locAdded and editFailed).
      sessionMeta({ session_id: 'sess-fork', forked_from_id: 'sess-parent', timestamp: '2026-04-14T10:05:00Z' }),
      functionCall('exec_command', '2026-04-14T10:05:01Z'),
      patchApplyEnd({ success: false, added: 2, file: 'src/a.ts', timestamp: '2026-04-14T10:05:02Z' }),
      mcpToolCallEnd('srv', 't1', '2026-04-14T10:05:03Z'),
      tokenCount({ timestamp: '2026-04-14T10:05:04Z', last: { input: 500 }, total: { input: 500, total: 500 } }),
      // Child's own turn, past the cutoff: genuine tool events of its own.
      userMessage('child turn', '2026-04-14T10:05:20Z'),
      functionCall('read_file', '2026-04-14T10:05:20Z'),
      patchApplyEnd({ success: true, added: 3, file: 'src/b.ts', timestamp: '2026-04-14T10:05:20Z' }),
      tokenCount({ timestamp: '2026-04-14T10:05:21Z', last: { input: 300 }, total: { input: 800, total: 800 } }),
    ])
    expect(calls).toHaveLength(2)
    // The parent's turn keeps its own tools, failed-edit flag and LOC.
    expect(calls[0]!.inputTokens).toBe(500)
    expect(calls[0]!.tools).toEqual(['Bash', 'Edit', 'mcp__srv__t1'])
    expect(calls[0]!.toolSequence).toEqual([
      [{ tool: 'Bash' }],
      [{ tool: 'Edit', file: 'src/a.ts' }],
      [{ tool: 'mcp__srv__t1' }],
    ])
    expect(calls[0]!.locAdded).toBe(2)
    expect(calls[0]!.editFailed).toBe(1)
    // The child's turn sees NONE of the replayed events: exactly its own read +
    // successful edit, no leaked Bash / failed edit / MCP end.
    expect(calls[1]!.inputTokens).toBe(300)
    expect(calls[1]!.tools).toEqual(['Read', 'Edit'])
    expect(calls[1]!.toolSequence).toEqual([
      [{ tool: 'Read' }],
      [{ tool: 'Edit', file: 'src/b.ts' }],
    ])
    expect(calls[1]!.locAdded).toBe(3)
    expect(calls[1]!.locRemoved).toBeUndefined()
    expect(calls[1]!.editFailed).toBeUndefined()
  })

  it('GAP 3: Buffer path synthesizes payload.info and payload.invocation', () => {
    // info on the Buffer path is a latent gap: a token_count line is a handful
    // of numbers and never exceeds LARGE_STREAM_LINE_BYTES (32KB), so it always
    // arrives as a string. The Buffer branch must still preserve it if hit.
    const tokenLine = JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-04-14T13:00:00Z',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 111, output_tokens: 7, total_tokens: 118 },
          total_token_usage: { input_tokens: 111, total_tokens: 118 },
        },
      },
    })
    const tokenEntry = parseCodexLine(Buffer.from(tokenLine))
    expect(tokenEntry?.payload?.info?.last_token_usage?.input_tokens).toBe(111)
    expect(tokenEntry?.payload?.info?.total_token_usage?.total_tokens).toBe(118)

    // invocation is LIVE: an mcp_tool_call_end carrying a huge
    // invocation.arguments object exceeds the 32KB threshold, routes to the
    // Buffer path, and without invocation extraction the mcp__server__tool
    // name is lost from the turn.
    const bigArgs = 'y'.repeat(40 * 1024)
    const mcpLine = JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-04-14T13:00:01Z',
      payload: { type: 'mcp_tool_call_end', invocation: { server: 'srv', tool: 'big', arguments: { blob: bigArgs } } },
    })
    expect(Buffer.byteLength(mcpLine)).toBeGreaterThan(32 * 1024)
    const mcpEntry = parseCodexLine(Buffer.from(mcpLine))
    expect(mcpEntry?.payload?.invocation).toEqual({ server: 'srv', tool: 'big' })

    // Decode-level: the large MCP record is attributed as mcp__srv__big.
    const calls = decodeCold([
      sessionMeta({ session_id: 'sess-big' }),
      userMessage('big mcp', '2026-04-14T13:00:10Z'),
      Buffer.from(mcpLine),
      tokenCount({ timestamp: '2026-04-14T13:00:11Z', last: { input: 50 }, total: { input: 50, total: 50 } }),
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.tools).toEqual(['mcp__srv__big'])
  })

  it("GAP 4: 'exec' maps to 'Bash' for the Codex Desktop custom-tool transport", () => {
    expect(codexToolNameMap['exec']).toBe('Bash')
    const calls = decodeCold([
      sessionMeta({ session_id: 'sess-exec' }),
      userMessage('run it', '2026-04-14T14:00:01Z'),
      functionCall('exec_command', '2026-04-14T14:00:02Z'),
      customToolCall('exec', '2026-04-14T14:00:03Z'),
      tokenCount({ timestamp: '2026-04-14T14:00:04Z', last: { input: 50 }, total: { input: 50, total: 50 } }),
    ])
    expect(calls[0]!.tools).toEqual(['Bash', 'Bash'])
  })
})

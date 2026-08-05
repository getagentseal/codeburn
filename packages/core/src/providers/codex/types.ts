// Raw record + rich-decode types for the Codex provider.
//
// The record types (CodexEntry, CodexTokenUsage) describe the shape of a Codex
// CLI rollout JSONL line. The Decoded* types are the rich decode layer's output:
// pure over supplied records, carrying content in-memory but NO pricing (the
// host prices them). The CLI adapter maps CodexDecodedCall into its own
// ParsedProviderCall by adding `costBasis: 'estimated'` and running the pricing
// pass.

export type CodexTokenUsage = {
  input_tokens?: number
  cached_input_tokens?: number
  output_tokens?: number
  reasoning_output_tokens?: number
  total_tokens?: number
}

export type CodexEntry = {
  type: string
  timestamp?: string
  payload?: {
    type?: string
    role?: string
    cwd?: string
    model_provider?: string
    originator?: string
    session_id?: string
    forked_from_id?: string
    model?: string
    name?: string
    turn_id?: string
    call_id?: string
    started_at?: number
    duration_ms?: number
    duration?: { secs?: number; nanos?: number } | string
    invocation?: { server?: string; tool?: string }
    content?: Array<{ type?: string; text?: string }>
    info?: {
      model?: string
      model_name?: string
      last_token_usage?: CodexTokenUsage
      total_token_usage?: CodexTokenUsage
    }
  }
}

// A single tool invocation captured in a turn's tool sequence. Mirrors the
// CLI's ToolCall so the host can consume it without a shape conversion.
export type CodexToolCall = {
  tool: string
  file?: string
  command?: string
}

// The rich decode of one Codex call (one flushed turn), pre-pricing. Mirrors the
// host's ParsedProviderCall minus `costUSD`/`costBasis`/`bashCommands` (the host
// adds those): cost leaves the decoder. `costIsEstimated` flags a call whose
// TOKENS were estimated from character counts (a turn with no token_count.info),
// orthogonal to pricing.
export type CodexDecodedCall = {
  provider: 'codex'
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
  webSearchRequests: number
  tools: string[]
  timestamp: string
  speed: 'standard' | 'fast'
  deduplicationKey: string
  turnId: string
  toolSequence?: CodexToolCall[][]
  userMessage: string
  sessionId: string
  projectPath?: string
  workingDirectory?: string
  locAdded?: number
  locRemoved?: number
  editFailed?: number
  costIsEstimated?: boolean
  // Tool-excluded active timing, attributed from the enclosing task's
  // task_started/task_complete window (see decode.ts). `activeDurationMs` is
  // the task duration minus recorded tool-wait intervals, split across the
  // task's calls proportionally to their generated tokens; `toolWaitMs` is the
  // excluded wait share. Present only when the task recorded both timing and
  // generated tokens.
  activeDurationMs?: number
  activeGeneratedTokens?: number
  toolWaitMs?: number
}

/**
 * All cross-record memory the Codex decoder keeps, as a plain JSON-serializable
 * object so a decode can be paused, persisted, and resumed byte-identically.
 *
 * Two kinds of memory live here:
 *
 *  - Per-session streaming locals (everything except `seenKeys`): the running
 *    token counters used to turn cumulative totals into per-event deltas, the
 *    fork-replay cutoff, the mid-turn accumulators (pending tools / user message
 *    / output chars / edit LOC), and the id/counter bookkeeping. These are what
 *    a mid-session resume needs. A `session_meta` record updates the id / cwd /
 *    fork / model fields IN PLACE without resetting the counters — a single
 *    rollout file can carry more than one session_meta and the pre-phase-4
 *    decoder treated the whole file as one continuous session. Per-file
 *    freshness comes from the host starting a new decode (state: undefined) per
 *    file, one file being one logical session.
 *
 *  - `seenKeys`: the cross-file/cross-run dedup memory. A forked session (a
 *    separate rollout file) replays its parent's token history; those replays are
 *    dropped by colliding with the parent's already-emitted keys, so the dedup
 *    memory must thread across files — which is why a split across a forked
 *    session round-trips only when it threads through the serialized state.
 *
 * When the host supplies a live `seenKeys` Set on the decode input (a
 * performance fast-path so the CLI's shared dedup set is mutated in place rather
 * than snapshotted per file), `state.seenKeys` is left empty and the live Set is
 * canonical; the round-trip contract instead threads `seenKeys` through this
 * serialized array.
 */
export type CodexDecodeState = {
  sessionModel?: string
  sessionId: string
  sessionCwd?: string
  forkedFromId: string
  forkCutoff: string
  // Null sentinel (not 0) so the FIRST event is never mistaken for a duplicate:
  // a session that only emits last_token_usage reports cumulativeTotal=0 on every
  // event, and a 0-initialized prev would drop its opening turn.
  prevCumulativeTotal: number | null
  prevInput: number
  prevCached: number
  prevOutput: number
  prevReasoning: number
  pendingTools: string[]
  pendingToolSequence: CodexToolCall[][]
  pendingUserMessage: string
  pendingOutputChars: number
  pendingLocAdded: number
  pendingLocRemoved: number
  pendingEditFailed: number
  estCounter: number
  turnCounter: number
  currentTurnId: string
  seenKeys: string[]
  // Tool-excluded active-timing window (see decode.ts). Threaded through the
  // state so a task whose task_started / token_counts land in one decode pass
  // and its task_complete in a later (append-resume) pass still attributes
  // activeDurationMs / activeGeneratedTokens / toolWaitMs to the calls emitted
  // in the earlier pass. `taskResultStart` is an ABSOLUTE index into the
  // concatenated prior+current call list (the host's `priorCallCount` offsets
  // it on resume). `openToolStarts` is the JSON-serializable form of the
  // call_id -> startedAt map. Absent on states written before the field
  // existed (read as a fresh window).
  taskResultStart?: number
  taskGeneratedTokens?: number
  taskToolIntervals?: Array<[number, number]>
  taskStartedAt?: number
  openToolStarts?: Record<string, number>
}

// A task that straddled a decode boundary: its task_started / token_counts were
// emitted in an EARLIER pass than its task_complete. The decoder attributes the
// in-pass calls directly; this patch carries the same proportional attribution
// for the earlier-pass calls, which the host applies to its CONCATENATED
// prior+new call list (both indices are absolute into that list). Emitted only
// when a task_complete closes a window opened in a prior pass.
export type CodexTimingPatch = {
  resultStart: number
  resultEnd: number
  activeDurationMs: number
  taskGeneratedTokens: number
  toolWaitMs: number
}

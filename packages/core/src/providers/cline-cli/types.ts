// Raw record + rich-decode types for the Cline CLI provider.
//
// The Cline CLI (npm `cline`, 3.x) stores sessions as
// <sessions>/<sessionId>/<sessionId>.json (metadata + rolled-up usage) plus a
// co-located <sessionId>.messages.json (per-message metrics). This is a
// different layout from the VS Code extension's tasks/ui_messages.json tree the
// `cline` provider reads, so it is kept as its own provider.
//
// The host reads + JSON-parses both files (I/O stays CLI-side, like codewhale)
// and hands ONE composite record to the pure decoder. The Decoded* types are
// the rich decode layer's output: pure over supplied records, carrying content
// in-memory but NO pricing (the host prices them). The CLI adapter maps
// ClineCliDecodedCall into its own ParsedProviderCall by adding
// `costBasis`/`costUSD` (measured when the CLI reported a cost, estimated
// otherwise) and running the pricing pass.

export type ClineCliMetrics = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

// One tool invocation captured in a message's tool sequence. Mirrors the CLI's
// ToolCall so the host can consume it without a shape conversion; `file` and
// `command` are host-side only (fingerprinted before they can reach an
// observation).
export type ClineCliToolCall = {
  tool: string
  file?: string
  command?: string
}

/**
 * The composite record the host hands the core decoder for one session: the
 * parsed metadata file plus the parsed messages array.
 *
 * The CLI injects two host-side conveniences into `meta` before handing it
 * over so the decoder stays path-free:
 *  - `session_id` when the file omits it (the session directory name, i.e. the
 *    metadata file's basename without `.json`);
 *  - `project` (the discovered source's project label).
 */
export type ClineCliSessionRecords = {
  meta: Record<string, unknown>
  messages: unknown[]
}

// The rich decode of one Cline CLI call (one assistant message with a metrics
// block, or the session rollup fallback), pre-pricing. Mirrors the host's
// ParsedProviderCall minus cost fields (the host adds those): cost leaves the
// decoder. `reportedCost` carries the CLI's own metered dollar figure when one
// was actually present and non-negative (a metered $0 stays reported); when
// absent the host prices from the token buckets. `rawBashCommands` are the
// un-split shell command strings from Bash-mapped tool calls; the CLI adapter
// runs its own base-name extraction on them to build the `bashCommands` field.
export type ClineCliDecodedCall = {
  provider: 'cline-cli'
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
  webSearchRequests: number
  /** CLI-reported dollar cost, present only when actually metered (incl. $0). */
  reportedCost?: number
  tools: string[]
  rawBashCommands: string[]
  skills: string[]
  subagentTypes: string[]
  toolSequence?: ClineCliToolCall[][]
  timestamp: string
  speed: 'standard'
  deduplicationKey: string
  turnId: string
  userMessage: string
  sessionId: string
  project: string
  projectPath?: string
  workingDirectory?: string
}

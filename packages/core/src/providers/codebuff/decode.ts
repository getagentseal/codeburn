// @codeburn/core Codebuff decoder: pure decode over a host-supplied chat-messages
// record array. No fs / env / clock — the host reads the JSON file and hands the
// parsed array straight through. The rich output carries token buckets but NO
// pricing (cost leaves the decoder; the host prices via its estimated-cost seam)
// and NO bash base-name extraction (that stays host-side with strip-ansi).

import type { DecodeContext } from '../../contracts.js'
import type { RecordDiagnostic } from '../../diagnostics.js'
import { sourceRefFingerprint } from '../../fingerprint.js'
import type {
  CodebuffBlock,
  CodebuffChatMessage,
  CodebuffDecodedCall,
  CodebuffMetadata,
  CodebuffUsage,
} from './types.js'

// Codebuff's native tool names mapped to codeburn's canonical vocabulary.
export const codebuffToolNameMap: Record<string, string> = {
  read_files: 'Read',
  read_file: 'Read',
  code_search: 'Grep',
  glob: 'Glob',
  find_files: 'Glob',
  str_replace: 'Edit',
  edit_file: 'Edit',
  write_file: 'Write',
  run_terminal_command: 'Bash',
  terminal: 'Bash',
  spawn_agents: 'Agent',
  spawn_agent: 'Agent',
  write_todos: 'TodoWrite',
  create_plan: 'TodoWrite',
  browser_logs: 'WebFetch',
  web_search: 'WebSearch',
  fetch_url: 'WebFetch',
}

// Tool names ignored for classification.
const IGNORED_TOOLS = new Set(['suggest_followups', 'end_turn'])

function pickNumber(...vals: Array<number | undefined>): number | undefined {
  for (const v of vals) {
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return undefined
}

function normalizeUsage(u: CodebuffUsage | undefined): {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
} {
  if (!u) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  return {
    input: pickNumber(u.inputTokens, u.input_tokens, u.promptTokens, u.prompt_tokens) ?? 0,
    output: pickNumber(u.outputTokens, u.output_tokens, u.completionTokens, u.completion_tokens) ?? 0,
    cacheRead:
      pickNumber(
        u.cacheReadInputTokens,
        u.cache_read_input_tokens,
        u.promptTokensDetails?.cachedTokens,
        u.prompt_tokens_details?.cached_tokens,
      ) ?? 0,
    cacheWrite: pickNumber(u.cacheCreationInputTokens, u.cache_creation_input_tokens) ?? 0,
  }
}

function coerceTimestamp(value: string | number | undefined): string {
  if (value == null) return ''
  if (typeof value === 'number') {
    return Number.isFinite(value) ? new Date(value).toISOString() : ''
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value
}

function parseChatIdToIso(chatId: string): string {
  const iso = chatId.replace(/(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})/, '$1:$2:$3')
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : ''
}

function extractAgentType(meta: CodebuffMetadata | undefined): string | null {
  return meta?.runState?.sessionState?.mainAgentState?.agentType ?? null
}

function collectBlockTools(
  blocks: CodebuffBlock[] | undefined,
  acc: { tools: string[]; rawBashCommands: string[] },
): void {
  if (!Array.isArray(blocks)) return
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'tool' && typeof block.toolName === 'string') {
      const raw = block.toolName
      if (!IGNORED_TOOLS.has(raw)) {
        acc.tools.push(codebuffToolNameMap[raw] ?? raw)
      }
      if ((raw === 'run_terminal_command' || raw === 'terminal') && block.input) {
        const cmd = block.input['command']
        if (typeof cmd === 'string') {
          acc.rawBashCommands.push(cmd)
        }
      }
    }
    if (block.type === 'agent' && Array.isArray(block.blocks)) {
      collectBlockTools(block.blocks, acc)
    }
  }
}

function resolveModel(meta: CodebuffMetadata | undefined, stashedModel: string | null): string {
  const direct = meta?.model ?? meta?.modelId ?? meta?.codebuff?.model
  if (direct) return direct
  if (stashedModel) return stashedModel
  const agentType = extractAgentType(meta)
  if (agentType) return `codebuff-${agentType}`
  return 'codebuff'
}

function usageFromHistory(meta: CodebuffMetadata | undefined): {
  model: string | null
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
} {
  const hist = meta?.runState?.sessionState?.mainAgentState?.messageHistory
  if (!Array.isArray(hist)) return { model: null, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  for (let i = hist.length - 1; i >= 0; i--) {
    const entry = hist[i]
    if (!entry || entry.role !== 'assistant' || !entry.providerOptions) continue
    const u = normalizeUsage(entry.providerOptions.usage ?? entry.providerOptions.codebuff?.usage)
    if (u.input > 0 || u.output > 0 || u.cacheRead > 0 || u.cacheWrite > 0) {
      return { model: entry.providerOptions.codebuff?.model ?? null, ...u }
    }
  }
  return { model: null, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

function extractChannelFromChatDir(chatDir: string): string | null {
  const parts = chatDir.split(/[/\\]/)
  if (parts.length < 5) return null
  if (parts[parts.length - 2] !== 'chats') return null
  if (parts[parts.length - 4] !== 'projects') return null
  return parts[parts.length - 5] ?? null
}

export type CodebuffDecodeInput = {
  records: unknown[]
  context: DecodeContext
  seenKeys?: Set<string>
}

export type CodebuffDecodeResult = {
  calls: CodebuffDecodedCall[]
  diagnostics: RecordDiagnostic[]
}

/**
 * Decode a Codebuff chat-messages.json array into rich, cost-free calls. A single
 * pass: user messages set the pending prompt for the next assistant call; assistant
 * messages that carry credits or token usage flush into a call. Dedup is keyed on
 * `codebuff:<sourceRefFingerprint>:<id>` against the live `seenKeys` set (host-owned);
 * the source path is fingerprinted, never emitted raw.
 */
export function decodeCodebuff({ records, context, seenKeys: liveSeen }: CodebuffDecodeInput): CodebuffDecodeResult {
  const seen = liveSeen ?? new Set<string>()
  const calls: CodebuffDecodedCall[] = []
  const diagnostics: RecordDiagnostic[] = []

  const chatDir = context.sourceRef
  const chatId = chatDir.split(/[/\\]/).pop() ?? ''
  const fallbackTs = parseChatIdToIso(chatId)

  let pendingUserMessage = ''

  for (const [idx, rawMsg] of records.entries()) {
    const msg = rawMsg as CodebuffChatMessage | null
    if (!msg || typeof msg !== 'object') continue

    const variant = msg.variant ?? msg.role
    if (variant === 'user') {
      if (typeof msg.content === 'string' && msg.content.length > 0) {
        pendingUserMessage = msg.content
      }
      continue
    }

    if (variant !== 'ai' && variant !== 'agent' && variant !== 'assistant') continue

    const credits = typeof msg.credits === 'number' && Number.isFinite(msg.credits) ? msg.credits : 0
    const directUsage = normalizeUsage(msg.metadata?.usage ?? msg.metadata?.codebuff?.usage)
    const stashedUsage = usageFromHistory(msg.metadata)

    const hasDirect =
      directUsage.input > 0 ||
      directUsage.output > 0 ||
      directUsage.cacheRead > 0 ||
      directUsage.cacheWrite > 0
    const usage = hasDirect ? directUsage : stashedUsage
    const stashedModel = stashedUsage.model

    if (credits === 0 && usage.input === 0 && usage.output === 0 && usage.cacheRead === 0 && usage.cacheWrite === 0) {
      continue
    }

    const model = resolveModel(msg.metadata, stashedModel)
    const timestamp = coerceTimestamp(msg.timestamp ?? msg.metadata?.timestamp) || fallbackTs

    const dedupId = msg.id ?? String(idx)
    // The dedup key threads a FINGERPRINT of the chat directory (source path),
    // never the raw path — dedupKey ships on the envelope.
    const dedupKey = `codebuff:${sourceRefFingerprint(context.privacyKey, context.sourceRef)}:${dedupId}`
    if (seen.has(dedupKey)) continue
    seen.add(dedupKey)

    const acc = { tools: [] as string[], rawBashCommands: [] as string[] }
    collectBlockTools(msg.blocks, acc)

    const channel = extractChannelFromChatDir(chatDir)
    const sessionId = channel ? `${channel}/${chatId}` : chatId

    calls.push({
      provider: 'codebuff',
      model,
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheCreationInputTokens: usage.cacheWrite,
      cacheReadInputTokens: usage.cacheRead,
      cachedInputTokens: usage.cacheRead,
      reasoningTokens: 0,
      webSearchRequests: 0,
      tools: acc.tools,
      rawBashCommands: acc.rawBashCommands,
      timestamp,
      speed: 'standard',
      deduplicationKey: dedupKey,
      userMessage: pendingUserMessage,
      sessionId,
      credits,
    })

    pendingUserMessage = ''
  }

  return { calls, diagnostics }
}

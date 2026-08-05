// @codeburn/core Kiro decoder: pure decode over the five record shapes the host
// hands it. No fs / env / clock — the host owns discovery, durable caching,
// project attribution, and pricing.

import type { DecodeContext } from '../../contracts.js'
import type { RecordDiagnostic } from '../../diagnostics.js'
import type {
  KiroChatFile,
  KiroCliEntry,
  KiroCliSessionMeta,
  KiroDecodedCall,
  KiroModernExecution,
  KiroToolCall,
  KiroV2SessionMeta,
  KiroWorkspaceSessionDraft,
} from './types.js'

const CHARS_PER_TOKEN = 4
function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

const MIN_REASONABLE_TIMESTAMP_MS = 1_000_000_000_000
const MODERN_CONVERSATION_KEYS = ['messages', 'conversation', 'chat', 'transcript', 'entries', 'events']

export const kiroToolNameMap: Record<string, string> = {
  readFile: 'Read',
  read_file: 'Read',
  read: 'Read',
  writeFile: 'Edit',
  write_file: 'Edit',
  write: 'Edit',
  editFile: 'Edit',
  edit_file: 'Edit',
  createFile: 'Write',
  create_file: 'Write',
  deleteFile: 'Delete',
  listDir: 'LS',
  list_dir: 'LS',
  openFolders: 'LS',
  runCommand: 'Bash',
  run_command: 'Bash',
  shell: 'Bash',
  executeBash: 'Bash',
  searchFiles: 'Grep',
  search_files: 'Grep',
  grep: 'Grep',
  grepSearch: 'Grep',
  findFiles: 'Glob',
  find_files: 'Glob',
  glob: 'Glob',
  fileSearch: 'Glob',
  webSearch: 'WebSearch',
  web_search: 'WebSearch',
  web_fetch: 'WebFetch',
  fsWrite: 'Edit',
  strReplace: 'Edit',
  listDirectory: 'LS',
  code: 'Read',
  subagent: 'Agent',
}

function normalizeModelId(raw: string): string {
  return raw.replace(/(\d+)\.(\d+)/g, '$1-$2')
}

export function extractToolNames(content: string): string[] {
  const tools: string[] = []
  const regex = /<tool_use>\s*<name>([^<]+)<\/name>/g
  let match
  while ((match = regex.exec(content)) !== null) {
    const name = match[1]!.trim()
    tools.push(kiroToolNameMap[name] ?? name)
  }
  return tools
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export function stringField(record: Record<string, unknown> | null, names: string[]): string {
  if (!record) return ''
  for (const name of names) {
    const value = record[name]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function timeField(record: Record<string, unknown> | null, names: string[]): number | string | undefined {
  if (!record) return undefined
  for (const name of names) {
    const value = record[name]
    if (typeof value === 'number' || typeof value === 'string') return value
  }
  return undefined
}

export function parseKiroTimestamp(value: number | string | undefined): Date | null {
  if (value === undefined) return null

  let parsed: number | string = value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    parsed = /^-?\d+(\.\d+)?$/.test(trimmed) ? Number(trimmed) : trimmed
  }

  if (typeof parsed === 'number') {
    if (!Number.isFinite(parsed)) return null
    const ms = parsed < MIN_REASONABLE_TIMESTAMP_MS ? parsed * 1000 : parsed
    const date = new Date(ms)
    return Number.isNaN(date.getTime()) || date.getTime() < MIN_REASONABLE_TIMESTAMP_MS ? null : date
  }

  const date = new Date(parsed)
  return Number.isNaN(date.getTime()) || date.getTime() < MIN_REASONABLE_TIMESTAMP_MS ? null : date
}

function textField(record: Record<string, unknown> | null, names: string[]): string {
  if (!record) return ''
  for (const name of names) {
    const text = extractText(record[name])
    if (text) return text
  }
  return ''
}

export function extractText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join('\n')
  const record = asRecord(value)
  if (!record) return ''
  for (const key of ['content', 'text', 'message', 'value', 'parts', 'entries']) {
    const text = extractText(record[key])
    if (text) return text
  }
  return ''
}

function messageRole(value: unknown): string {
  const record = asRecord(value)
  if (!record) return ''
  return stringField(record, ['role', 'type', 'author']).toLowerCase()
}

export function extractStructuredToolNames(value: unknown, text: string, options: { includeDirectName?: boolean } = {}): string[] {
  const tools = extractToolNames(text)
  const record = asRecord(value)
  if (!record) return tools

  if (options.includeDirectName ?? true) {
    const directName = stringField(record, ['toolName', 'name'])
    if (directName) tools.push(kiroToolNameMap[directName] ?? directName)
  }

  for (const key of ['toolCalls', 'tool_calls', 'tools']) {
    const entries = record[key]
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      const name = stringField(asRecord(entry), ['name', 'toolName', 'tool_name'])
      if (name) tools.push(kiroToolNameMap[name] ?? name)
    }
  }

  return tools
}

export type KiroDecodeResult = { calls: KiroDecodedCall[]; diagnostics: RecordDiagnostic[] }

export function decodeKiroChatFile(input: {
  record: Record<string, unknown>
  fallbackChatSessionId: string
  context: DecodeContext
  seenKeys?: Set<string>
}): KiroDecodeResult {
  const { record, fallbackChatSessionId, seenKeys: liveSeen } = input
  const seen = liveSeen ?? new Set<string>()
  const calls: KiroDecodedCall[] = []

  const data = record as unknown as KiroChatFile
  const { chat, metadata } = data

  let modelId = normalizeModelId(metadata.modelId ?? '')
  if (modelId === 'auto' || !modelId) modelId = 'kiro-auto'

  let pendingUserMessage = ''
  // Accumulate every human turn's full length for the input-token estimate,
  // mirroring the modern-execution path's inputChars accumulator. The prior
  // code estimated input tokens from pendingUserMessage.length alone - the
  // LAST human turn truncated to 500 chars - so a multi-turn session, or any
  // final prompt over 500 chars, undercounted input tokens (and therefore
  // costUSD) severalfold, while output correctly summed all bot chars. Note
  // the chat arm still counts only human records: tool and system records
  // stay excluded, unlike the modern-execution, CLI and v2 arms (whose
  // comments state tool results are fed back to the model as input), so this
  // arm still under-reports - just far less than before.
  let inputChars = 0
  const allTools: string[] = []
  const toolSequence: KiroToolCall[][] = []

  for (const msg of chat) {
    if (msg.role === 'human') {
      // The <identity> system preamble is the one non-input human record.
      // Trim leading whitespace before matching: preambles are large, and
      // with the full-length accumulator below a missed match (a leading
      // newline or BOM before the tag) would silently add the preamble's
      // whole length to input tokens on every affected session. Tolerating
      // leading whitespace costs nothing real - a genuine prompt never
      // starts with whitespace plus an identity tag - and the failure
      // asymmetry favours exclusion: a false negative inflates tokens by
      // the preamble length, a false positive only skips a preamble.
      if (msg.content.trimStart().startsWith('<identity>')) continue
      inputChars += msg.content.length
      pendingUserMessage = msg.content.slice(0, 500)
    }
    if (msg.role === 'bot') {
      const msgTools = extractToolNames(msg.content)
      allTools.push(...msgTools)
      if (msgTools.length > 0) toolSequence.push(msgTools.map(t => ({ tool: t })))
    }
  }

  const botMessages = chat.filter(m => m.role === 'bot' && m.content.length > 0)
  const totalOutputChars = botMessages.reduce((sum, m) => sum + m.content.length, 0)
  if (totalOutputChars === 0) return { calls, diagnostics: [] }

  const sessionId = stringField(asRecord(metadata), ['workflowId']) || fallbackChatSessionId
  const dedupKey = `kiro:${sessionId}:${data.executionId}`
  if (seen.has(dedupKey)) return { calls, diagnostics: [] }

  const outputTokens = estimateTokensFromChars(totalOutputChars)
  const inputTokens = estimateTokensFromChars(inputChars)
  const tsDate = parseKiroTimestamp(metadata.startTime)
  if (!tsDate) return { calls, diagnostics: [] }
  const timestamp = tsDate.toISOString()
  seen.add(dedupKey)

  calls.push({
    provider: 'kiro',
    arm: 'chat',
    model: modelId,
    inputTokens,
    outputTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    credits: 0,
    tools: [...new Set(allTools)],
    bashCommands: [],
    toolSequence: toolSequence.length > 1 ? toolSequence : undefined,
    timestamp,
    speed: 'standard',
    deduplicationKey: dedupKey,
    userMessage: pendingUserMessage,
    sessionId,
  })

  return { calls, diagnostics: [] }
}

export function decodeKiroModernExecution(input: {
  record: Record<string, unknown>
  fallbackExecutionId: string
  fallbackSessionId: string
  context: DecodeContext
  seenKeys?: Set<string>
}): KiroDecodeResult {
  const { record: data, fallbackExecutionId, fallbackSessionId, seenKeys: liveSeen } = input
  const seen = liveSeen ?? new Set<string>()
  const calls: KiroDecodedCall[] = []

  if (Array.isArray(data['executions'])) return { calls, diagnostics: [] }

  const metadata = asRecord(data['metadata'])
  const modelObj = asRecord(data['model'])
  let modelId = normalizeModelId(
    stringField(data, ['modelId', 'modelID', 'modelName', 'model']) ||
    stringField(modelObj, ['id', 'name']) ||
    stringField(metadata, ['modelId', 'modelID', 'modelName']),
  )
  if (modelId === 'auto' || !modelId) modelId = 'kiro-auto'

  const executionId = stringField(data, ['executionId', 'id']) || fallbackExecutionId
  const sessionId = stringField(data, ['sessionId', 'chatSessionId', 'conversationId', 'workflowId']) ||
    stringField(metadata, ['workflowId', 'sessionId']) ||
    fallbackSessionId ||
    executionId

  let inputChars = 0
  let outputChars = 0
  let pendingUserMessage = ''
  const allTools: string[] = []
  let hasOutputActivity = false
  const directInput = textField(data, ['prompt', 'input', 'userMessage', 'user_message', 'request'])
  const directOutput = textField(data, ['response', 'output', 'assistantMessage', 'assistant_message', 'result'])
  const directTools = extractStructuredToolNames(data, directOutput, { includeDirectName: false })

  if (directInput) {
    inputChars += directInput.length
    pendingUserMessage = directInput.slice(0, 500)
  }

  if (directOutput) {
    outputChars += directOutput.length
    hasOutputActivity = true
  }

  if (directTools.length > 0) {
    hasOutputActivity = true
    allTools.push(...directTools)
  }

  // Check both data.context[key] and data[key] for conversation arrays.
  // Kiro IDE stores messages at data.context.messages in current builds.
  const contextRec = asRecord(data['context'])
  const conversationSources = contextRec ? [contextRec, data] : [data]

  for (const source of conversationSources) {
    let found = false
    for (const key of MODERN_CONVERSATION_KEYS) {
      const messages = (source as Record<string, unknown>)[key]
      if (!Array.isArray(messages)) continue

      for (const message of messages) {
        const text = extractText(message)
        const role = messageRole(message)
        const tools = extractStructuredToolNames(message, text)

        if (role === 'human' || role === 'user') {
          if (!text) continue
          inputChars += text.length
          pendingUserMessage = text.slice(0, 500)
        } else if (role === 'bot' || role === 'assistant' || role === 'ai' || role === 'model') {
          if (text) outputChars += text.length
          if (text || tools.length > 0) hasOutputActivity = true
          allTools.push(...tools)
        } else if (role === 'tool' || role === 'system') {
          if (text) inputChars += text.length
          allTools.push(...tools)
        }
      }
      found = true
      break
    }
    if (found) break
  }

  // Extract tools and metered credits from usageSummary (reliable structured
  // data in current Kiro builds). usageSummary is an array of per-turn entries
  // with optional usedTools and usage (credits, unit "credit") fields — the
  // v1 predecessor of v2's usage_summary.promptTurnSummaries.
  let executionCredits = 0
  const usageSummary = data['usageSummary']
  if (Array.isArray(usageSummary)) {
    for (const entry of usageSummary) {
      const rec = asRecord(entry)
      if (!rec) continue
      const usage = rec['usage']
      if (typeof usage === 'number' && Number.isFinite(usage)) executionCredits += usage
      const usedTools = rec['usedTools']
      if (Array.isArray(usedTools)) {
        for (const tool of usedTools) {
          if (typeof tool === 'string' && tool) {
            // Strip mcp_ prefix for cleaner display (e.g. mcp_aws_sentral_mcp_search_accounts -> aws_sentral_mcp_search_accounts)
            const cleaned = tool.startsWith('mcp_') ? tool.slice(4) : tool
            allTools.push(kiroToolNameMap[cleaned] ?? cleaned)
            hasOutputActivity = true
          }
        }
      }
    }
  }

  if (!hasOutputActivity) return { calls, diagnostics: [] }

  const dedupKey = `kiro:${sessionId}:${executionId}`
  if (seen.has(dedupKey)) return { calls, diagnostics: [] }

  const rawStartTime = timeField(data, ['startTime', 'createdAt', 'timestamp']) ??
    timeField(metadata, ['startTime', 'createdAt', 'timestamp'])
  const tsDate = parseKiroTimestamp(rawStartTime)
  if (!tsDate) return { calls, diagnostics: [] }

  const inputTokens = estimateTokensFromChars(inputChars)
  const outputTokens = estimateTokensFromChars(outputChars)
  // Prefer real metered credits at the public overage rate; fall back to
  // token-estimated pricing when the execution has no usage data — same
  // contract as the CLI and v2 parsers.
  seen.add(dedupKey)

  calls.push({
    provider: 'kiro',
    arm: 'modern',
    model: modelId,
    inputTokens,
    outputTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    credits: executionCredits,
    tools: [...new Set(allTools)],
    bashCommands: [],
    timestamp: tsDate.toISOString(),
    speed: 'standard',
    deduplicationKey: dedupKey,
    userMessage: pendingUserMessage,
    sessionId,
  })

  return { calls, diagnostics: [] }
}

// --- Kiro IDE workspace-session decode (workspace-sessions/<b64>/<sessionId>.json) ---
// Newer v1-era Kiro builds store session state here: history[] carries user prompts
// and assistant messages, some of which are stubs referencing per-execution files
// (parsed separately by decodeKiroModernExecution). Split in two so the host can
// keep the mtime stat behind the two content gates rather than statting eagerly.
export type KiroWorkspaceSessionPrepared =
  | { kind: 'not-workspace-session' }
  | { kind: 'empty' }
  | { kind: 'ready'; draft: KiroWorkspaceSessionDraft }

export function prepareKiroWorkspaceSession(record: Record<string, unknown>): KiroWorkspaceSessionPrepared {
  const historyArr = record['history']
  if (!Array.isArray(historyArr) || typeof record['sessionId'] !== 'string') return { kind: 'not-workspace-session' }

  const sessionId = record['sessionId']
  const modelRaw = stringField(record, ['selectedModel'])
  let modelId = normalizeModelId(modelRaw)
  if (modelId === 'auto' || !modelId) modelId = 'kiro-auto'

  let inputChars = 0
  let outputChars = 0
  let pendingUserMessage = ''
  const allTools: string[] = []
  let hasExecutionRefs = false
  let hasRealAssistantContent = false

  for (const item of historyArr) {
    const rec = asRecord(item)
    if (!rec) continue

    // Track if this session references execution files (which are parsed separately)
    const execBacked = typeof rec['executionId'] === 'string'
    if (execBacked) hasExecutionRefs = true

    const msg = asRecord(rec['message'])
    if (!msg) continue
    const role = stringField(msg, ['role'])
    const text = extractText(msg['content'])
    if (role === 'user' && text) {
      inputChars += text.length
      pendingUserMessage = text.slice(0, 500)
    } else if (role === 'assistant' && !execBacked && text && text !== 'On it.') {
      // An item carrying an executionId is execution-backed: its content is
      // counted from the execution file, so counting it here would double-count.
      // 'On it.' is the observed placeholder text Kiro writes for such stubs
      // when the executionId rides a separate history item.
      outputChars += text.length
      hasRealAssistantContent = true
    }
  }

  // Skip workspace-session entries that are pure execution stubs:
  // they reference executionIds (parsed separately as execution files)
  // and have no real assistant content beyond "On it." placeholders.
  // This avoids double-counting input tokens from both paths.
  if (hasExecutionRefs && !hasRealAssistantContent) return { kind: 'empty' }

  // Skip sessions with no meaningful content
  if (inputChars === 0 && outputChars === 0) return { kind: 'empty' }

  return {
    kind: 'ready',
    draft: { sessionId, modelId, inputChars, outputChars, pendingUserMessage, allTools },
  }
}

export function finishKiroWorkspaceSession(
  draft: KiroWorkspaceSessionDraft,
  input: { timestamp: string; seenKeys?: Set<string> },
): KiroDecodeResult {
  const { seenKeys: liveSeen } = input
  const seen = liveSeen ?? new Set<string>()
  const calls: KiroDecodedCall[] = []
  const { sessionId, modelId, inputChars, outputChars, pendingUserMessage, allTools } = draft

  const dedupKey = `kiro:ws-session:${sessionId}`
  if (seen.has(dedupKey)) return { calls, diagnostics: [] }
  seen.add(dedupKey)

  const inputTokens = estimateTokensFromChars(inputChars)
  const outputTokens = estimateTokensFromChars(outputChars)

  calls.push({
    provider: 'kiro',
    arm: 'ws-session',
    model: modelId,
    inputTokens,
    outputTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    credits: 0,
    tools: [...new Set(allTools)],
    bashCommands: [],
    timestamp: input.timestamp,
    speed: 'standard',
    deduplicationKey: dedupKey,
    userMessage: pendingUserMessage,
    sessionId,
  })

  return { calls, diagnostics: [] }
}

export function decodeKiroIdeFile(input: {
  record: Record<string, unknown>
  fallbackChatSessionId: string
  fallbackExecutionId: string
  fallbackSessionId: string
  context: DecodeContext
  seenKeys?: Set<string>
}): KiroDecodeResult {
  const { record, fallbackChatSessionId, fallbackExecutionId, fallbackSessionId, context, seenKeys } = input
  const metadata = asRecord(record['metadata'])
  if (Array.isArray(record['chat']) && metadata) {
    return decodeKiroChatFile({ record, fallbackChatSessionId, context, seenKeys })
  }
  return decodeKiroModernExecution({ record, fallbackExecutionId, fallbackSessionId, context, seenKeys })
}

export function decodeKiroCliSession(input: {
  meta: KiroCliSessionMeta
  entries: KiroCliEntry[]
  project: string
  context: DecodeContext
  seenKeys?: Set<string>
}): KiroDecodeResult {
  const { meta, entries, project, seenKeys: liveSeen } = input
  const seen = liveSeen ?? new Set<string>()
  const calls: KiroDecodedCall[] = []
  const sessionId = meta.session_id

  let modelId = meta.session_state?.rts_model_state?.model_info?.model_id ?? 'auto'
  if (modelId === 'auto' || !modelId) modelId = 'kiro-auto'
  else modelId = normalizeModelId(modelId)

  const turns = meta.session_state?.conversation_metadata?.user_turn_metadatas ?? []

  // Walk through JSONL entries grouping by prompt turns
  let turnIndex = 0
  let pendingUserMessage = ''
  let outputChars = 0
  let inputChars = 0
  const allTools: string[] = []
  let turnStartTimestamp: string | undefined

  function flushTurn() {
    if (outputChars === 0) return
    const turnMeta = turns[turnIndex]
    const dedupKey = `kiro-cli:${sessionId}:${turnIndex}`
    if (seen.has(dedupKey)) { turnIndex++; return }

    const timestamp = turnMeta?.end_timestamp ?? turnStartTimestamp ?? meta.created_at
    const tsDate = parseKiroTimestamp(timestamp)
    if (!tsDate) { turnIndex++; return }

    const inputTokens = estimateTokensFromChars(inputChars)
    const outputTokens = estimateTokensFromChars(outputChars)
    // metering_usage values are credits (unit: "credit"), not dollars —
    // convert at the public overage rate. Gate on credits > 0, not array
    // presence: real sessions carry empty metering_usage arrays (turn still
    // in flight when the meta was written), which must fall back to
    // token-estimated pricing — same contract as the v1-execution and v2
    // parsers.
    const turnCredits = turnMeta?.metering_usage
      ? turnMeta.metering_usage.reduce((sum, m) => sum + m.value, 0)
      : 0
    seen.add(dedupKey)

    calls.push({
      provider: 'kiro',
      arm: 'cli',
      model: modelId,
      inputTokens,
      outputTokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      credits: turnCredits,
      tools: [...new Set(allTools)],
      bashCommands: [],
      timestamp: tsDate.toISOString(),
      speed: 'standard',
      deduplicationKey: dedupKey,
      userMessage: pendingUserMessage,
      sessionId,
      project,
    })
    turnIndex++
  }

  let isFirstPrompt = true
  for (const entry of entries) {
    if (entry.kind === 'Prompt') {
      if (!isFirstPrompt) {
        flushTurn()
        pendingUserMessage = ''
        outputChars = 0
        inputChars = 0
        allTools.length = 0
      }
      isFirstPrompt = false
      const content = entry.data['content']
      if (Array.isArray(content)) {
        for (const item of content) {
          const rec = asRecord(item)
          if (rec && rec['kind'] === 'text' && typeof rec['data'] === 'string') {
            pendingUserMessage = (rec['data'] as string).slice(0, 500)
            inputChars += (rec['data'] as string).length
          }
        }
      }
      const meta2 = asRecord(entry.data['meta'])
      if (meta2) {
        const ts = meta2['timestamp']
        if (typeof ts === 'number') turnStartTimestamp = new Date(ts * 1000).toISOString()
      }
    } else if (entry.kind === 'AssistantMessage') {
      const content = entry.data['content']
      if (Array.isArray(content)) {
        for (const item of content) {
          const rec = asRecord(item)
          if (!rec) continue
          if (rec['kind'] === 'text' && typeof rec['data'] === 'string') {
            outputChars += (rec['data'] as string).length
          } else if (rec['kind'] === 'toolUse') {
            const toolData = asRecord(rec['data'])
            if (toolData) {
              const name = typeof toolData['name'] === 'string' ? toolData['name'] : ''
              if (name) allTools.push(kiroToolNameMap[name] ?? name)
            }
          }
        }
      }
    } else if (entry.kind === 'ToolResults') {
      // Tool results count as input context
      const content = entry.data['content']
      if (Array.isArray(content)) {
        for (const item of content) {
          const text = extractText(item)
          if (text) inputChars += text.length
        }
      }
    }
  }
  // Flush last turn
  flushTurn()

  return { calls, diagnostics: [] }
}

// --- Kiro IDE v2 session decode (~/.kiro/sessions/<hash>/sess_*/) ---
// v2 is a self-contained, event-sourced store: one directory per session holding
// session.json (metadata incl. the real modelId) + messages.jsonl (append-only
// event log). Unlike v1 it does NOT use separate execution files — assistant
// content is inline. Usage is billed in credits with no token counts, so tokens
// and cost are estimated from transcript text priced at the real model.
export function decodeKiroV2Session(input: {
  lines: string
  meta: KiroV2SessionMeta
  fallbackSessionId: string
  project: string
  context: DecodeContext
  seenKeys?: Set<string>
}): KiroDecodeResult {
  const { lines, meta, fallbackSessionId, project, seenKeys: liveSeen } = input
  const seen = liveSeen ?? new Set<string>()
  const calls: KiroDecodedCall[] = []

  const sessionId = (typeof meta.id === 'string' && meta.id) || fallbackSessionId
  let modelId = normalizeModelId(meta.modelId ?? '')
  if (modelId === 'auto' || !modelId) modelId = 'kiro-auto'

  // In-flight turn state. A turn spans turn_start..turn_end sharing an
  // executionId; the preceding `user` event carries its prompt.
  let pendingUserMessage = ''
  let pendingUserChars = 0

  let inTurn = false
  let execId = ''
  let turnStartTs: string | undefined
  let outputChars = 0
  let reasoningChars = 0
  let toolResultChars = 0
  let turnCredits = 0
  let turnUserMessage = ''
  let turnUserChars = 0
  const tools: string[] = []

  const resetTurn = () => {
    inTurn = false; execId = ''; turnStartTs = undefined
    outputChars = 0; reasoningChars = 0; toolResultChars = 0; turnCredits = 0
    turnUserMessage = ''; turnUserChars = 0
    tools.length = 0
  }

  const pushTool = (raw: string) => {
    if (!raw) return
    // Strip mcp_ prefix for cleaner display, matching the modern-execution parser.
    const cleaned = raw.startsWith('mcp_') ? raw.slice(4) : raw
    tools.push(kiroToolNameMap[cleaned] ?? cleaned)
  }

  const flushTurn = () => {
    if (!inTurn) { resetTurn(); return }
    const hasActivity = outputChars > 0 || reasoningChars > 0 || tools.length > 0
    if (hasActivity) {
      const dedupKey = `kiro-v2:${sessionId}:${execId || String(calls.length)}`
      const tsDate = parseKiroTimestamp(turnStartTs)
      if (tsDate && !seen.has(dedupKey)) {
        seen.add(dedupKey)
        // Tool results are fed back to the model as input context, so count them
        // toward input tokens — same treatment as the CLI parser's ToolResults.
        const inputTokens = estimateTokensFromChars(turnUserChars + toolResultChars)
        // outputTokens and reasoningTokens are kept disjoint — downstream
        // aggregation (models-report, audit-report, parser) sums the two
        // fields, so folding reasoning into outputTokens would double-count.
        const reasoningTokens = estimateTokensFromChars(reasoningChars)
        const outputTokens = estimateTokensFromChars(outputChars)
        // Prefer real metered credits (converted at the public overage rate)
        // over token estimation; fall back to token pricing when the turn has
        // no usage_summary (e.g. still in progress or null usage). Reasoning
        // text is billed as output, so combine it for pricing only (same as
        // the codex provider).
        calls.push({
          provider: 'kiro',
          arm: 'v2',
          model: modelId,
          inputTokens,
          outputTokens,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          cachedInputTokens: 0,
          reasoningTokens,
          webSearchRequests: 0,
          credits: turnCredits,
          tools: [...new Set(tools)],
          bashCommands: [],
          timestamp: tsDate.toISOString(),
          speed: 'standard',
          deduplicationKey: dedupKey,
          userMessage: turnUserMessage,
          sessionId,
          project,
        })
      }
    }
    resetTurn()
  }

  for (const line of lines.split('\n')) {
    if (!line.trim()) continue
    let evt: Record<string, unknown>
    try { evt = JSON.parse(line) as Record<string, unknown> } catch { continue }
    const payload = asRecord(evt['payload'])
    if (!payload) continue
    const type = stringField(payload, ['type'])
    const ts = typeof evt['timestamp'] === 'string' ? evt['timestamp'] as string : undefined

    if (type === 'user') {
      // New prompt: close any in-flight turn defensively, then stash the text
      // for the upcoming turn_start.
      if (inTurn) flushTurn()
      const text = typeof payload['content'] === 'string' ? payload['content'] as string : extractText(payload['content'])
      pendingUserMessage = text.slice(0, 500)
      pendingUserChars = text.length
    } else if (type === 'turn_start') {
      if (inTurn) flushTurn()
      inTurn = true
      execId = stringField(payload, ['executionId'])
      turnStartTs = ts
      turnUserMessage = pendingUserMessage
      turnUserChars = pendingUserChars
      pendingUserMessage = ''
      pendingUserChars = 0
    } else if (type === 'assistant') {
      const text = typeof payload['content'] === 'string' ? payload['content'] as string : extractText(payload['content'])
      if (stringField(payload, ['operationType']) === 'Reasoning') reasoningChars += text.length
      else outputChars += text.length
      if (!inTurn && text.length > 0) inTurn = true
      if (!turnStartTs && ts) turnStartTs = ts
    } else if (type === 'tool_call') {
      pushTool(stringField(payload, ['toolName', 'name']))
    } else if (type === 'tool_result') {
      // Tool output re-enters the model as context on the next inference call.
      // content is a plain string in observed logs; extractText covers nesting.
      const text = typeof payload['content'] === 'string' ? payload['content'] as string : extractText(payload['content'])
      toolResultChars += text.length
    } else if (type === 'usage_summary') {
      // usedTools is a reliable per-turn tool list. Credits are the real billed
      // usage (promptTurnSummaries[].usage with unit "credit") — harvest them
      // for credit-based cost. usage can be null on some turns.
      const summaries = payload['promptTurnSummaries']
      if (Array.isArray(summaries)) {
        for (const s of summaries) {
          const rec = asRecord(s)
          const used = rec?.['usedTools']
          if (Array.isArray(used)) for (const u of used) if (typeof u === 'string') pushTool(u)
          const usage = rec?.['usage']
          if (typeof usage === 'number' && Number.isFinite(usage)) turnCredits += usage
        }
      }
    } else if (type === 'turn_end') {
      flushTurn()
    }
  }
  // Flush a trailing in-progress turn (session still active, no turn_end yet).
  flushTurn()

  return { calls, diagnostics: [] }
}

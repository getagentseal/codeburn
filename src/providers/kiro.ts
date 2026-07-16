import type { Dirent } from 'fs'
import { existsSync } from 'fs'
import { readdir, readFile, stat } from 'fs/promises'
import { basename, dirname, extname, join } from 'path'
import { homedir } from 'os'

import { readSessionFile } from '../fs-utils.js'
import { calculateCost } from '../models.js'
import type { ToolCall } from '../types.js'
import type { Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'

const CHARS_PER_TOKEN = 4
// Kiro bills in credits: individual plans are $20/mo for 1,000 credits and
// overage is billed at $0.04 per additional credit. We price credits at the
// public overage rate (the marginal price), mirroring the Codebuff provider's
// USD_PER_CREDIT approach, so we never understate real cost.
const USD_PER_KIRO_CREDIT = 0.04
const MIN_REASONABLE_TIMESTAMP_MS = 1_000_000_000_000
const MODERN_CONVERSATION_KEYS = ['messages', 'conversation', 'chat', 'transcript', 'entries', 'events']

const modelDisplayNames: Record<string, string> = {
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-sonnet-4-5': 'Sonnet 4.5',
  'claude-sonnet-4': 'Sonnet 4',
  'claude-haiku-4-5': 'Haiku 4.5',
  'claude-3-7-sonnet': 'Sonnet 3.7',
  'claude-3-5-sonnet': 'Sonnet 3.5',
  'claude-3-5-haiku': 'Haiku 3.5',
}

const modelDisplayEntries = Object.entries(modelDisplayNames).sort((a, b) => b[0].length - a[0].length)

const toolNameMap: Record<string, string> = {
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

type KiroChatMessage = {
  role: 'human' | 'bot' | 'tool'
  content: string
}

type KiroChatFile = {
  executionId: string
  actionId: string
  chat: KiroChatMessage[]
  metadata: {
    modelId: string
    modelProvider: string
    workflow: string
    workflowId: string
    startTime: number
    endTime: number
  }
}

type KiroModernExecution = Record<string, unknown>

function normalizeModelId(raw: string): string {
  return raw.replace(/(\d+)\.(\d+)/g, '$1-$2')
}

function extractToolNames(content: string): string[] {
  const tools: string[] = []
  const regex = /<tool_use>\s*<name>([^<]+)<\/name>/g
  let match
  while ((match = regex.exec(content)) !== null) {
    const name = match[1]!.trim()
    tools.push(toolNameMap[name] ?? name)
  }
  return tools
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function stringField(record: Record<string, unknown> | null, names: string[]): string {
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

function parseKiroTimestamp(value: number | string | undefined): Date | null {
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

function extractText(value: unknown): string {
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

function extractStructuredToolNames(value: unknown, text: string, options: { includeDirectName?: boolean } = {}): string[] {
  const tools = extractToolNames(text)
  const record = asRecord(value)
  if (!record) return tools

  if (options.includeDirectName ?? true) {
    const directName = stringField(record, ['toolName', 'name'])
    if (directName) tools.push(toolNameMap[directName] ?? directName)
  }

  for (const key of ['toolCalls', 'tool_calls', 'tools']) {
    const entries = record[key]
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      const name = stringField(asRecord(entry), ['name', 'toolName', 'tool_name'])
      if (name) tools.push(toolNameMap[name] ?? name)
    }
  }

  return tools
}

function parseChatFile(data: KiroChatFile, sessionId: string, project: string, seenKeys: Set<string>): ParsedProviderCall[] {
  const results: ParsedProviderCall[] = []
  const { chat, metadata } = data

  let modelId = normalizeModelId(metadata.modelId ?? '')
  if (modelId === 'auto' || !modelId) modelId = 'kiro-auto'

  let pendingUserMessage = ''
  const allTools: string[] = []
  const toolSequence: ToolCall[][] = []

  for (const msg of chat) {
    if (msg.role === 'human') {
      if (msg.content.startsWith('<identity>')) continue
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
  if (totalOutputChars === 0) return results

  const dedupKey = `kiro:${sessionId}:${data.executionId}`
  if (seenKeys.has(dedupKey)) return results

  const outputTokens = Math.ceil(totalOutputChars / CHARS_PER_TOKEN)
  const inputTokens = Math.ceil(pendingUserMessage.length / CHARS_PER_TOKEN)
  const costUSD = calculateCost(modelId, inputTokens, outputTokens, 0, 0, 0)
  const tsDate = parseKiroTimestamp(metadata.startTime)
  if (!tsDate) return results
  const timestamp = tsDate.toISOString()
  seenKeys.add(dedupKey)

  results.push({
    provider: 'kiro',
    model: modelId,
    inputTokens,
    outputTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costUSD,
    costIsEstimated: true,
    tools: [...new Set(allTools)],
    bashCommands: [],
    toolSequence: toolSequence.length > 1 ? toolSequence : undefined,
    timestamp,
    speed: 'standard',
    deduplicationKey: dedupKey,
    userMessage: pendingUserMessage,
    sessionId,
  })

  return results
}

function parseModernExecution(data: KiroModernExecution, sourcePath: string, seenKeys: Set<string>): ParsedProviderCall[] {
  const results: ParsedProviderCall[] = []
  if (Array.isArray(data['executions'])) return results

  const metadata = asRecord(data['metadata'])
  const modelObj = asRecord(data['model'])
  let modelId = normalizeModelId(
    stringField(data, ['modelId', 'modelID', 'modelName', 'model']) ||
    stringField(modelObj, ['id', 'name']) ||
    stringField(metadata, ['modelId', 'modelID', 'modelName']),
  )
  if (modelId === 'auto' || !modelId) modelId = 'kiro-auto'

  const executionId = stringField(data, ['executionId', 'id']) || basename(sourcePath)
  const sessionId = stringField(data, ['sessionId', 'chatSessionId', 'conversationId', 'workflowId']) ||
    stringField(metadata, ['workflowId', 'sessionId']) ||
    basename(dirname(sourcePath)) ||
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
  const context = asRecord(data['context'])
  const conversationSources = context ? [context, data] : [data]

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
            allTools.push(toolNameMap[cleaned] ?? cleaned)
            hasOutputActivity = true
          }
        }
      }
    }
  }

  if (!hasOutputActivity) return results

  const dedupKey = `kiro:${sessionId}:${executionId}`
  if (seenKeys.has(dedupKey)) return results

  const rawStartTime = timeField(data, ['startTime', 'createdAt', 'timestamp']) ??
    timeField(metadata, ['startTime', 'createdAt', 'timestamp'])
  const tsDate = parseKiroTimestamp(rawStartTime)
  if (!tsDate) return results

  const inputTokens = Math.ceil(inputChars / CHARS_PER_TOKEN)
  const outputTokens = Math.ceil(outputChars / CHARS_PER_TOKEN)
  // Prefer real metered credits at the public overage rate; fall back to
  // token-estimated pricing when the execution has no usage data — same
  // contract as the CLI and v2 parsers.
  const costUSD = executionCredits > 0
    ? executionCredits * USD_PER_KIRO_CREDIT
    : calculateCost(modelId, inputTokens, outputTokens, 0, 0, 0)
  seenKeys.add(dedupKey)

  results.push({
    provider: 'kiro',
    model: modelId,
    inputTokens,
    outputTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costUSD,
    costIsEstimated: executionCredits === 0,
    tools: [...new Set(allTools)],
    bashCommands: [],
    timestamp: tsDate.toISOString(),
    speed: 'standard',
    deduplicationKey: dedupKey,
    userMessage: pendingUserMessage,
    sessionId,
  })

  return results
}

// --- Kiro CLI session types & parser ---

type KiroCliEntry = {
  version: string
  kind: 'Prompt' | 'AssistantMessage' | 'ToolResults' | 'Clear'
  data: Record<string, unknown>
}

type KiroCliSessionMeta = {
  session_id: string
  cwd: string
  created_at: string
  updated_at: string
  title?: string
  session_state?: {
    rts_model_state?: { model_info?: { model_id?: string } }
    conversation_metadata?: {
      user_turn_metadatas?: Array<{
        end_timestamp?: string
        builtin_tool_uses?: number
        metering_usage?: Array<{ value: number; unit: string }>
        total_request_count?: number
      }>
    }
  }
}

function parseCliSession(meta: KiroCliSessionMeta, entries: KiroCliEntry[], seenKeys: Set<string>): ParsedProviderCall[] {
  const results: ParsedProviderCall[] = []
  const sessionId = meta.session_id
  const project = basename(meta.cwd || '')

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
    if (seenKeys.has(dedupKey)) { turnIndex++; return }

    const timestamp = turnMeta?.end_timestamp ?? turnStartTimestamp ?? meta.created_at
    const tsDate = parseKiroTimestamp(timestamp)
    if (!tsDate) { turnIndex++; return }

    const inputTokens = Math.ceil(inputChars / CHARS_PER_TOKEN)
    const outputTokens = Math.ceil(outputChars / CHARS_PER_TOKEN)
    // metering_usage values are credits (unit: "credit"), not dollars —
    // convert at the public overage rate. Gate on credits > 0, not array
    // presence: real sessions carry empty metering_usage arrays (turn still
    // in flight when the meta was written), which must fall back to
    // token-estimated pricing — same contract as the v1-execution and v2
    // parsers.
    const turnCredits = turnMeta?.metering_usage
      ? turnMeta.metering_usage.reduce((sum, m) => sum + m.value, 0)
      : 0
    const costUSD = turnCredits > 0
      ? turnCredits * USD_PER_KIRO_CREDIT
      : calculateCost(modelId, inputTokens, outputTokens, 0, 0, 0)
    seenKeys.add(dedupKey)

    results.push({
      provider: 'kiro',
      model: modelId,
      inputTokens,
      outputTokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costUSD,
      costIsEstimated: turnCredits === 0,
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
              if (name) allTools.push(toolNameMap[name] ?? name)
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

  return results
}

// --- Kiro IDE workspace-session parser (workspace-sessions/<b64>/<sessionId>.json) ---
// Newer v1-era Kiro builds store session state here: history[] carries user prompts
// and assistant messages, some of which are stubs referencing per-execution files
// (parsed separately by parseModernExecution).
async function parseWorkspaceSession(record: Record<string, unknown>, source: SessionSource, seenKeys: Set<string>): Promise<ParsedProviderCall[]> {
  const results: ParsedProviderCall[] = []
  const historyArr = record['history']
  if (!Array.isArray(historyArr) || typeof record['sessionId'] !== 'string') return results

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
  if (hasExecutionRefs && !hasRealAssistantContent) return results

  // Skip sessions with no meaningful content
  if (inputChars === 0 && outputChars === 0) return results

  // Use file mtime as timestamp (workspace-session files don't carry startTime).
  // No stat means no usable timestamp: drop the call like the other parse paths.
  let timestamp: string
  try {
    const s = await stat(source.path)
    timestamp = new Date(s.mtimeMs).toISOString()
  } catch {
    return results
  }

  const dedupKey = `kiro:ws-session:${sessionId}`
  if (seenKeys.has(dedupKey)) return results
  seenKeys.add(dedupKey)

  const inputTokens = Math.ceil(inputChars / CHARS_PER_TOKEN)
  const outputTokens = Math.ceil(outputChars / CHARS_PER_TOKEN)
  const costUSD = calculateCost(modelId, inputTokens, outputTokens, 0, 0, 0)

  results.push({
    provider: 'kiro',
    model: modelId,
    inputTokens,
    outputTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costUSD,
    costIsEstimated: true,
    tools: [...new Set(allTools)],
    bashCommands: [],
    timestamp,
    speed: 'standard',
    deduplicationKey: dedupKey,
    userMessage: pendingUserMessage,
    sessionId,
  })

  return results
}

// --- Kiro IDE v2 session types & parser (~/.kiro/sessions/<hash>/sess_*/) ---
// v2 is a self-contained, event-sourced store: one directory per session holding
// session.json (metadata incl. the real modelId) + messages.jsonl (append-only
// event log). Unlike v1 it does NOT use separate execution files — assistant
// content is inline. Usage is billed in credits with no token counts, so tokens
// and cost are estimated from transcript text priced at the real model.

type KiroV2SessionMeta = {
  id?: string
  title?: string
  modelId?: string
  workspacePaths?: string[]
  createdAt?: string
  lastModifiedAt?: string
}

async function parseV2Session(source: SessionSource, seenKeys: Set<string>): Promise<ParsedProviderCall[]> {
  const results: ParsedProviderCall[] = []

  const content = await readSessionFile(source.path)
  if (content === null) return results

  // Companion session.json carries the real model + session metadata.
  let meta: KiroV2SessionMeta = {}
  try {
    const raw = await readFile(join(dirname(source.path), 'session.json'), 'utf-8')
    meta = JSON.parse(raw) as KiroV2SessionMeta
  } catch { /* fall back to defaults below */ }

  const sessionId = (typeof meta.id === 'string' && meta.id) || basename(dirname(source.path))
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
    tools.push(toolNameMap[cleaned] ?? cleaned)
  }

  const flushTurn = () => {
    if (!inTurn) { resetTurn(); return }
    const hasActivity = outputChars > 0 || reasoningChars > 0 || tools.length > 0
    if (hasActivity) {
      const dedupKey = `kiro-v2:${sessionId}:${execId || String(results.length)}`
      const tsDate = parseKiroTimestamp(turnStartTs)
      if (tsDate && !seenKeys.has(dedupKey)) {
        seenKeys.add(dedupKey)
        // Tool results are fed back to the model as input context, so count them
        // toward input tokens — same treatment as the CLI parser's ToolResults.
        const inputTokens = Math.ceil((turnUserChars + toolResultChars) / CHARS_PER_TOKEN)
        // outputTokens and reasoningTokens are kept disjoint — downstream
        // aggregation (models-report, audit-report, parser) sums the two
        // fields, so folding reasoning into outputTokens would double-count.
        const reasoningTokens = Math.ceil(reasoningChars / CHARS_PER_TOKEN)
        const outputTokens = Math.ceil(outputChars / CHARS_PER_TOKEN)
        // Prefer real metered credits (converted at the public overage rate)
        // over token estimation; fall back to token pricing when the turn has
        // no usage_summary (e.g. still in progress or null usage). Reasoning
        // text is billed as output, so combine it for pricing only (same as
        // the codex provider).
        const costUSD = turnCredits > 0
          ? turnCredits * USD_PER_KIRO_CREDIT
          : calculateCost(modelId, inputTokens, outputTokens + reasoningTokens, 0, 0, 0)
        results.push({
          provider: 'kiro',
          model: modelId,
          inputTokens,
          outputTokens,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          cachedInputTokens: 0,
          reasoningTokens,
          webSearchRequests: 0,
          costUSD,
          costIsEstimated: turnCredits === 0,
          tools: [...new Set(tools)],
          bashCommands: [],
          timestamp: tsDate.toISOString(),
          speed: 'standard',
          deduplicationKey: dedupKey,
          userMessage: turnUserMessage,
          sessionId,
          project: source.project,
        })
      }
    }
    resetTurn()
  }

  for (const line of content.split('\n')) {
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

  return results
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      // v2 IDE store: ~/.kiro/sessions/<hash>/sess_<id>/messages.jsonl — a
      // self-contained event log. Must be checked BEFORE the generic .jsonl
      // (CLI) branch, since it also ends in .jsonl but has a different schema.
      if (/[/\\]sess_[^/\\]+[/\\]messages\.jsonl$/.test(source.path)) {
        for (const call of await parseV2Session(source, seenKeys)) yield call
        return
      }

      // CLI session: path points to a .jsonl file
      if (source.path.endsWith('.jsonl')) {
        const jsonlContent = await readSessionFile(source.path)
        if (jsonlContent === null) return

        const entries: KiroCliEntry[] = []
        for (const line of jsonlContent.split('\n')) {
          if (!line.trim()) continue
          try { entries.push(JSON.parse(line) as KiroCliEntry) } catch { /* skip malformed lines */ }
        }
        if (entries.length === 0) return

        // Load companion .json for metadata
        const metaPath = source.path.replace(/\.jsonl$/, '.json')
        let meta: KiroCliSessionMeta
        try {
          const raw = await readFile(metaPath, 'utf-8')
          meta = JSON.parse(raw) as KiroCliSessionMeta
        } catch {
          // Minimal fallback
          meta = { session_id: basename(source.path, '.jsonl'), cwd: '', created_at: '', updated_at: '' }
        }

        for (const call of parseCliSession(meta, entries, seenKeys)) {
          yield call
        }
        return
      }

      // IDE session: original path
      const content = await readSessionFile(source.path)
      if (content === null) return

      let data: unknown
      try {
        data = JSON.parse(content)
      } catch {
        return
      }

      const record = asRecord(data)
      if (!record) return

      // Workspace-session files (newer Kiro builds): have history[] with message.role/content
      // and a top-level sessionId/selectedModel/workspaceDirectory.
      if (Array.isArray(record['history']) && typeof record['sessionId'] === 'string') {
        for (const call of await parseWorkspaceSession(record, source, seenKeys)) yield call
        return
      }

      const metadata = asRecord(record['metadata'])
      const calls = Array.isArray(record['chat']) && metadata
        ? parseChatFile(record as unknown as KiroChatFile, stringField(metadata, ['workflowId']) || basename(source.path, '.chat'), source.project, seenKeys)
        : parseModernExecution(record, source.path, seenKeys)
      for (const call of calls) {
        yield call
      }
    },
  }
}

// --- Discovery ---

function getKiroAgentDir(override?: string): string[] {
  if (override) return [override]
  if (process.platform === 'darwin') {
    return [join(homedir(), 'Library', 'Application Support', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent')]
  }
  if (process.platform === 'win32') {
    return [join(homedir(), 'AppData', 'Roaming', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent')]
  }
  // On Linux, scan both ~/.kiro-server/data/... (remote dev boxes) and
  // ~/.config/Kiro/... (local installs). Both can have data simultaneously
  // if the user switches between local and remote, or if .kiro-server exists
  // but is stale while .config/Kiro has current sessions.
  const paths: string[] = []
  const kiroServer = join(homedir(), '.kiro-server', 'data', 'User', 'globalStorage', 'kiro.kiroagent')
  const kiroConfig = join(homedir(), '.config', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent')
  if (existsSync(kiroServer)) paths.push(kiroServer)
  if (existsSync(kiroConfig)) paths.push(kiroConfig)
  // Fallback to config path if neither exists (will just find nothing)
  return paths.length > 0 ? paths : [kiroConfig]
}

function getKiroWorkspaceStorageDir(override?: string): string {
  if (override) return override
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Kiro', 'User', 'workspaceStorage')
  }
  if (process.platform === 'win32') {
    return join(homedir(), 'AppData', 'Roaming', 'Kiro', 'User', 'workspaceStorage')
  }
  return join(homedir(), '.config', 'Kiro', 'User', 'workspaceStorage')
}

async function readWorkspaceProject(workspaceDir: string): Promise<string> {
  try {
    const raw = await readFile(join(workspaceDir, 'workspace.json'), 'utf-8')
    const data = JSON.parse(raw) as { folder?: string }
    if (data.folder) {
      const url = data.folder.replace(/^file:\/\//, '')
      return basename(decodeURIComponent(url))
    }
  } catch {}
  return basename(workspaceDir)
}

async function resolveWorkspaceProject(agentDir: string, workspaceStorageDir: string, workspaceHash: string): Promise<string> {
  const wsDir = join(workspaceStorageDir, workspaceHash)
  const project = await readWorkspaceProject(wsDir)
  if (project !== workspaceHash) return project

  try {
    const sessionsPath = join(agentDir, 'workspace-sessions')
    const dirs = await readdir(sessionsPath)
    for (const dir of dirs) {
      const decoded = Buffer.from(dir.replace(/_$/, ''), 'base64').toString('utf-8')
      if (decoded) return basename(decoded)
    }
  } catch {}

  return workspaceHash
}

async function discoverSessions(agentDir: string, workspaceStorageDir: string, cliSessionsDir: string): Promise<SessionSource[]> {
  const sources: SessionSource[] = []

  // --- Kiro CLI sessions (~/.kiro/sessions/cli/) ---
  try {
    const cliEntries = await readdir(cliSessionsDir, { withFileTypes: true })
    for (const entry of cliEntries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      const jsonlPath = join(cliSessionsDir, entry.name)
      // Derive project from companion .json
      const metaPath = jsonlPath.replace(/\.jsonl$/, '.json')
      let project = 'kiro-cli'
      try {
        const raw = await readFile(metaPath, 'utf-8')
        const meta = JSON.parse(raw) as { cwd?: string }
        if (meta.cwd) project = basename(meta.cwd)
      } catch {}
      sources.push({ path: jsonlPath, project, provider: 'kiro' })
    }
  } catch {}

  // --- Kiro IDE sessions ---
  let workspaceDirs: string[]
  try {
    const entries = await readdir(agentDir, { withFileTypes: true })
    workspaceDirs = entries.filter(e => e.isDirectory() && e.name.length === 32).map(e => e.name)
  } catch {
    return sources
  }

  for (const wsHash of workspaceDirs) {
    const wsPath = join(agentDir, wsHash)
    const project = await resolveWorkspaceProject(agentDir, workspaceStorageDir, wsHash)

    let entries: Dirent[]
    try {
      entries = await readdir(wsPath, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const entryPath = join(wsPath, entry.name)
      if (entry.isFile() && (entry.name.endsWith('.chat') || extname(entry.name) === '')) {
        sources.push({ path: entryPath, project, provider: 'kiro' })
        continue
      }

      if (!entry.isDirectory()) continue

      const childEntries = await readdir(entryPath, { withFileTypes: true }).catch(() => [])
      for (const child of childEntries) {
        if (child.name.startsWith('.')) continue
        if (!child.isFile()) continue
        if (extname(child.name) !== '') continue
        sources.push({ path: join(entryPath, child.name), project, provider: 'kiro' })
      }
    }
  }

  // --- Kiro IDE workspace-sessions (newer builds store session state here) ---
  // These files contain history[].message with user prompts and assistant stubs
  // plus executionId references. They capture sessions not written as per-execution files.
  try {
    const wsSessionsDir = join(agentDir, 'workspace-sessions')
    const wsSessionDirs = await readdir(wsSessionsDir, { withFileTypes: true })
    for (const dir of wsSessionDirs) {
      if (!dir.isDirectory()) continue
      // Directory name is base64-encoded workspace path
      let project = 'kiro-ide'
      try {
        const decoded = Buffer.from(dir.name.replace(/_/g, '='), 'base64').toString('utf-8')
        if (decoded) project = basename(decoded)
      } catch {}
      // Skip bare homedir as project name
      if (project === basename(homedir())) project = 'kiro-ide'

      const sessionFiles = await readdir(join(wsSessionsDir, dir.name), { withFileTypes: true }).catch(() => [])
      for (const sf of sessionFiles) {
        if (!sf.isFile() || !sf.name.endsWith('.json') || sf.name === 'sessions.json') continue
        sources.push({ path: join(wsSessionsDir, dir.name, sf.name), project, provider: 'kiro' })
      }
    }
  } catch {}

  return sources
}

// Discover v2 IDE sessions under ~/.kiro/sessions/<workspaceHash>/sess_*/.
// Each session is a self-contained directory (session.json + messages.jsonl);
// the emitted source points at messages.jsonl and routes to parseV2Session.
async function discoverV2Sessions(sessionsRoot: string): Promise<SessionSource[]> {
  const sources: SessionSource[] = []
  let hashDirs: Dirent[]
  try {
    hashDirs = await readdir(sessionsRoot, { withFileTypes: true })
  } catch {
    return sources
  }

  for (const hd of hashDirs) {
    // Skip the CLI store (scanned separately) and any stray files.
    if (!hd.isDirectory() || hd.name === 'cli') continue
    const hashPath = join(sessionsRoot, hd.name)

    let sessDirs: Dirent[]
    try {
      sessDirs = await readdir(hashPath, { withFileTypes: true })
    } catch {
      continue
    }

    for (const sd of sessDirs) {
      if (!sd.isDirectory() || !sd.name.startsWith('sess_')) continue
      const sessDir = join(hashPath, sd.name)
      const messagesPath = join(sessDir, 'messages.jsonl')
      if (!existsSync(messagesPath)) continue

      // Project from session.json workspacePaths; fall back to a generic label.
      let project = 'kiro-ide'
      try {
        const raw = await readFile(join(sessDir, 'session.json'), 'utf-8')
        const sj = JSON.parse(raw) as { workspacePaths?: string[] }
        const wp = sj.workspacePaths?.[0]
        if (wp) project = basename(wp)
      } catch {}
      if (project === basename(homedir())) project = 'kiro-ide'

      sources.push({ path: messagesPath, project, provider: 'kiro' })
    }
  }

  return sources
}

export function createKiroProvider(agentDirOverride?: string, workspaceStorageDirOverride?: string, cliSessionsDirOverride?: string, v2SessionsRootOverride?: string): Provider {
  const agentDirs = getKiroAgentDir(agentDirOverride)
  const wsDir = getKiroWorkspaceStorageDir(workspaceStorageDirOverride)
  // When overrides are provided (tests), don't scan real CLI sessions unless explicitly given
  const cliDir = cliSessionsDirOverride ?? (agentDirOverride ? join(agentDirOverride, '..', 'cli-sessions') : join(process.env['KIRO_HOME'] || join(homedir(), '.kiro'), 'sessions', 'cli'))
  // v2 IDE sessions live under ~/.kiro/sessions/<hash>/sess_*/, a sibling of the
  // CLI store (.../sessions/cli). Derive the root from cliDir ONLY when cliDir was
  // itself explicit (default path or cliSessionsDirOverride). When only
  // agentDirOverride is set (tests), the derived cliDir parent would point at an
  // arbitrary directory (e.g. the system tmpdir) — scan nothing in that case.
  const v2Root = v2SessionsRootOverride ??
    (cliSessionsDirOverride ? dirname(cliSessionsDirOverride) :
      agentDirOverride ? undefined : dirname(cliDir))

  return {
    name: 'kiro',
    displayName: 'Kiro',

    modelDisplayName(model: string): string {
      if (model === 'kiro-auto') return 'Kiro (auto)'
      for (const [key, name] of modelDisplayEntries) {
        if (model === key || model.startsWith(key + '-')) return name
      }
      return model
    },

    toolDisplayName(rawTool: string): string {
      if (rawTool.startsWith('mcp__')) return rawTool
      return toolNameMap[rawTool] ?? rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      const allSources: SessionSource[] = []
      for (const agentDir of agentDirs) {
        const sources = await discoverSessions(agentDir, wsDir, cliDir)
        allSources.push(...sources)
      }
      // v2 IDE sessions: scan the resolved v2 root (undefined = skip, see above).
      if (v2Root) allSources.push(...await discoverV2Sessions(v2Root))
      // CLI sessions are only scanned once (first agentDir pass includes them);
      // deduplicate by path in case multiple agentDirs share the same CLI dir.
      const seen = new Set<string>()
      return allSources.filter(s => {
        if (seen.has(s.path)) return false
        seen.add(s.path)
        return true
      })
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const kiro = createKiroProvider()

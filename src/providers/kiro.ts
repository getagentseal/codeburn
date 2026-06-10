import type { Dirent } from 'fs'
import { readdir, readFile } from 'fs/promises'
import { basename, dirname, extname, join } from 'path'
import { homedir } from 'os'

import { readSessionFile } from '../fs-utils.js'
import { calculateCost } from '../models.js'
import type { ToolCall } from '../types.js'
import type { Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'

const CHARS_PER_TOKEN = 4
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
  searchFiles: 'Grep',
  search_files: 'Grep',
  grep: 'Grep',
  findFiles: 'Glob',
  find_files: 'Glob',
  glob: 'Glob',
  webSearch: 'WebSearch',
  web_search: 'WebSearch',
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
  for (const key of ['content', 'text', 'message', 'value', 'parts']) {
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
  const sessionId = stringField(data, ['sessionId', 'conversationId', 'workflowId']) ||
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

  for (const key of MODERN_CONVERSATION_KEYS) {
    const messages = data[key]
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
    break
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
  const costUSD = calculateCost(modelId, inputTokens, outputTokens, 0, 0, 0)
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

    const costUSD = turnMeta?.metering_usage
      ? turnMeta.metering_usage.reduce((sum, m) => sum + m.value, 0)
      : 0

    const inputTokens = Math.ceil(inputChars / CHARS_PER_TOKEN)
    const outputTokens = Math.ceil(outputChars / CHARS_PER_TOKEN)
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
      costIsEstimated: !turnMeta?.metering_usage,
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

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
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

function getKiroAgentDir(override?: string): string {
  if (override) return override
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent')
  }
  if (process.platform === 'win32') {
    return join(homedir(), 'AppData', 'Roaming', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent')
  }
  return join(homedir(), '.config', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent')
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

  return sources
}

export function createKiroProvider(agentDirOverride?: string, workspaceStorageDirOverride?: string, cliSessionsDirOverride?: string): Provider {
  const agentDir = getKiroAgentDir(agentDirOverride)
  const wsDir = getKiroWorkspaceStorageDir(workspaceStorageDirOverride)
  // When overrides are provided (tests), don't scan real CLI sessions unless explicitly given
  const cliDir = cliSessionsDirOverride ?? (agentDirOverride ? join(agentDirOverride, '..', 'cli-sessions') : join(process.env['KIRO_HOME'] || join(homedir(), '.kiro'), 'sessions', 'cli'))

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
      return toolNameMap[rawTool] ?? rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      return discoverSessions(agentDir, wsDir, cliDir)
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const kiro = createKiroProvider()

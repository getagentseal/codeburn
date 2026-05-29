import type { Dirent } from 'fs'
import { readdir, readFile, stat } from 'fs/promises'
import { basename, dirname, extname, join } from 'path'
import { homedir } from 'os'

import { readSessionFile, readSessionLines } from '../fs-utils.js'
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
  writeFile: 'Edit',
  write_file: 'Edit',
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
  searchFiles: 'Grep',
  search_files: 'Grep',
  findFiles: 'Glob',
  find_files: 'Glob',
  webSearch: 'WebSearch',
  web_search: 'WebSearch',
}

type KiroChatMessage = {
  role: 'human' | 'bot' | 'tool'
  content: string
}

// --- Kiro CLI support ---

/** Built-in tools in Kiro CLI; anything else is assumed to be an MCP tool. */
const CLI_BUILTIN_TOOLS = new Set([
  'code', 'glob', 'grep', 'introspect', 'knowledge', 'read', 'shell',
  'subagent', 'summary', 'switch_to_execution', 'todo_list', 'web_fetch',
  'web_search', 'write', 'dummy',
])

/** Map Kiro CLI built-in tool names to CodeBurn canonical names. */
const cliToolNameMap: Record<string, string> = {
  read: 'Read',
  write: 'Edit',
  shell: 'Bash',
  grep: 'Grep',
  glob: 'Glob',
  web_search: 'WebSearch',
  web_fetch: 'WebFetch',
  code: 'Read',
  subagent: 'Agent',
}

type CliJsonlEntry = {
  version?: string
  kind: string
  data?: {
    message_id?: string
    content?: Array<{ kind: string; data?: unknown }>
  }
}

type CliSessionMeta = {
  session_id: string
  cwd?: string
  created_at?: string
  updated_at?: string
  title?: string
  session_state?: {
    rts_model_state?: {
      model_info?: { model_id?: string }
    }
  }
}

function getKiroCliSessionsDir(override?: string): string {
  if (override) return override
  return join(homedir(), '.kiro', 'sessions', 'cli')
}

async function loadCliMcpServerName(): Promise<string> {
  const mcpPath = join(homedir(), '.kiro', 'settings', 'mcp.json')
  try {
    const raw = await readFile(mcpPath, 'utf-8')
    const data = JSON.parse(raw) as { mcpServers?: Record<string, unknown> }
    const servers = Object.keys(data.mcpServers ?? {})
    if (servers.length > 0) return servers[0]!
  } catch {}
  return 'mcp-server'
}

function normalizeCliToolName(name: string, mcpServer: string): string {
  if (CLI_BUILTIN_TOOLS.has(name)) {
    return cliToolNameMap[name] ?? name
  }
  return `mcp__${mcpServer}__${name}`
}

function parseCliJsonlSession(
  lines: string[],
  sessionId: string,
  project: string,
  modelId: string,
  timestamp: string,
  mcpServer: string,
  seenKeys: Set<string>,
): ParsedProviderCall[] {
  const results: ParsedProviderCall[] = []
  const chat: Array<{ role: 'human' | 'bot'; content: string; tools: string[] }> = []

  for (const line of lines) {
    let entry: CliJsonlEntry
    try { entry = JSON.parse(line) } catch { continue }

    if (entry.kind === 'Prompt') {
      const text = (entry.data?.content ?? [])
        .filter(c => c.kind === 'text')
        .map(c => c.data as string)
        .join('\n')
      if (text) chat.push({ role: 'human', content: text, tools: [] })
    }

    if (entry.kind === 'AssistantMessage') {
      const parts = entry.data?.content ?? []
      let text = ''
      const tools: string[] = []
      for (const part of parts) {
        if (part.kind === 'text') text += part.data as string
        else if (part.kind === 'toolUse') {
          const toolData = part.data as { name?: string } | undefined
          const rawName = toolData?.name ?? 'unknown'
          tools.push(normalizeCliToolName(rawName, mcpServer))
        }
      }
      if (text || tools.length > 0) chat.push({ role: 'bot', content: text, tools })
    }
  }

  const botMessages = chat.filter(m => m.role === 'bot')
  const totalOutputChars = botMessages.reduce((sum, m) => sum + m.content.length, 0)
  const allTools = botMessages.flatMap(m => m.tools)
  const hasActivity = totalOutputChars > 0 || allTools.length > 0
  if (!hasActivity) return results

  const dedupKey = `kiro-cli:${sessionId}`
  if (seenKeys.has(dedupKey)) return results

  const pendingUserMessage = chat.find(m => m.role === 'human')?.content.slice(0, 500) ?? ''
  const inputChars = chat.filter(m => m.role === 'human').reduce((sum, m) => sum + m.content.length, 0)
  const inputTokens = Math.ceil(inputChars / CHARS_PER_TOKEN)
  const outputTokens = Math.ceil(totalOutputChars / CHARS_PER_TOKEN)

  let resolvedModel = normalizeModelId(modelId)
  if (resolvedModel === 'auto' || !resolvedModel) resolvedModel = 'kiro-auto'

  const costUSD = calculateCost(resolvedModel, inputTokens, outputTokens, 0, 0, 0)
  seenKeys.add(dedupKey)

  const toolSequence: ToolCall[][] = botMessages
    .filter(m => m.tools.length > 0)
    .map(m => m.tools.map(t => ({ tool: t })))

  results.push({
    provider: 'kiro',
    model: resolvedModel,
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

function createCliParser(source: SessionSource, seenKeys: Set<string>, mcpServerPromise: Promise<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      // source.path points to the .jsonl file; metadata is in the sibling .json
      const jsonlPath = source.path
      const jsonPath = jsonlPath.replace(/\.jsonl$/, '.json')

      let meta: CliSessionMeta
      try {
        const raw = await readFile(jsonPath, 'utf-8')
        meta = JSON.parse(raw)
      } catch { return }

      const sessionId = meta.session_id ?? basename(jsonlPath, '.jsonl')
      const modelId = meta.session_state?.rts_model_state?.model_info?.model_id ?? 'auto'
      const timestamp = meta.created_at ?? new Date().toISOString()

      const tsDate = parseKiroTimestamp(timestamp)
      if (!tsDate) return

      const mcpServer = await mcpServerPromise

      const lines: string[] = []
      for await (const line of readSessionLines(jsonlPath)) {
        lines.push(line)
      }

      const calls = parseCliJsonlSession(lines, sessionId, source.project, modelId, tsDate.toISOString(), mcpServer, seenKeys)
      for (const call of calls) {
        yield call
      }
    },
  }
}

async function discoverCliSessions(cliDir: string): Promise<SessionSource[]> {
  const sources: SessionSource[] = []

  let files: string[]
  try {
    const entries = await readdir(cliDir)
    files = entries.filter(f => f.endsWith('.jsonl'))
  } catch { return sources }

  for (const file of files) {
    const sessionId = file.replace('.jsonl', '')
    const jsonPath = join(cliDir, `${sessionId}.json`)

    let meta: CliSessionMeta
    try {
      const raw = await readFile(jsonPath, 'utf-8')
      meta = JSON.parse(raw)
    } catch { continue }

    const filePath = join(cliDir, file)
    const s = await stat(filePath).catch(() => null)
    if (!s?.isFile() || s.size === 0) continue

    const project = meta.cwd ? basename(meta.cwd) : 'kiro-cli'
    sources.push({ path: filePath, project, provider: 'kiro' })
  }

  return sources
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

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
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

async function discoverSessions(agentDir: string, workspaceStorageDir: string): Promise<SessionSource[]> {
  const sources: SessionSource[] = []

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

export function createKiroProvider(agentDirOverride?: string, workspaceStorageDirOverride?: string, cliDirOverride?: string): Provider {
  const agentDir = getKiroAgentDir(agentDirOverride)
  const wsDir = getKiroWorkspaceStorageDir(workspaceStorageDirOverride)
  const cliDir = getKiroCliSessionsDir(cliDirOverride)
  const mcpServerPromise = loadCliMcpServerName()

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
      const [ideSessions, cliSessions] = await Promise.all([
        discoverSessions(agentDir, wsDir),
        discoverCliSessions(cliDir),
      ])
      return [...ideSessions, ...cliSessions]
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      if (source.path.endsWith('.jsonl')) {
        return createCliParser(source, seenKeys, mcpServerPromise)
      }
      return createParser(source, seenKeys)
    },
  }
}

export const kiro = createKiroProvider()

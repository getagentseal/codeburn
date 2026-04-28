import { readdir, readFile, stat } from 'fs/promises'
import { basename, join } from 'path'
import { homedir } from 'os'

import { readSessionFile } from '../fs-utils.js'
import { calculateCost } from '../models.js'
import type { Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'

const CHARS_PER_TOKEN = 4

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

function parseChatFile(data: KiroChatFile, sessionId: string, project: string, seenKeys: Set<string>): ParsedProviderCall[] {
  const results: ParsedProviderCall[] = []
  const { chat, metadata } = data

  let modelId = normalizeModelId(metadata.modelId ?? '')
  if (modelId === 'auto' || !modelId) modelId = 'kiro-auto'

  let pendingUserMessage = ''
  const allTools: string[] = []

  for (const msg of chat) {
    if (msg.role === 'human') {
      if (msg.content.startsWith('<identity>')) continue
      pendingUserMessage = msg.content.slice(0, 500)
    }
    if (msg.role === 'bot') {
      allTools.push(...extractToolNames(msg.content))
    }
  }

  const botMessages = chat.filter(m => m.role === 'bot' && m.content.length > 0)
  const totalOutputChars = botMessages.reduce((sum, m) => sum + m.content.length, 0)
  if (totalOutputChars === 0) return results

  const dedupKey = `kiro:${sessionId}:${data.executionId}`
  if (seenKeys.has(dedupKey)) return results
  seenKeys.add(dedupKey)

  const outputTokens = Math.ceil(totalOutputChars / CHARS_PER_TOKEN)
  const inputTokens = Math.ceil(pendingUserMessage.length / CHARS_PER_TOKEN)
  const costUSD = calculateCost(modelId, inputTokens, outputTokens, 0, 0, 0)
  const tsDate = metadata.startTime ? new Date(metadata.startTime) : null
  if (!tsDate || isNaN(tsDate.getTime()) || tsDate.getTime() < 1_000_000_000_000) return results
  const timestamp = tsDate.toISOString()

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
    timestamp,
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

      let data: KiroChatFile
      try {
        data = JSON.parse(content)
      } catch {
        return
      }

      if (!data.chat || !data.metadata) return

      const sessionId = data.metadata.workflowId ?? basename(source.path, '.chat')
      const calls = parseChatFile(data, sessionId, source.project, seenKeys)
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

    let files: string[]
    try {
      const entries = await readdir(wsPath)
      files = entries.filter(f => f.endsWith('.chat'))
    } catch {
      continue
    }

    for (const file of files) {
      const filePath = join(wsPath, file)
      const s = await stat(filePath).catch(() => null)
      if (!s?.isFile()) continue
      sources.push({ path: filePath, project, provider: 'kiro' })
    }
  }

  return sources
}

export function createKiroProvider(agentDirOverride?: string, workspaceStorageDirOverride?: string): Provider {
  const agentDir = getKiroAgentDir(agentDirOverride)
  const wsDir = getKiroWorkspaceStorageDir(workspaceStorageDirOverride)

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
      return discoverSessions(agentDir, wsDir)
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const kiro = createKiroProvider()

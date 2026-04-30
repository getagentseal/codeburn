import { existsSync } from 'fs'
import { readdir, readFile, stat } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { homedir } from 'os'

import { readSessionFile } from '../fs-utils.js'
import { calculateCost } from '../models.js'
import type { Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'

const modelDisplayNames: Record<string, string> = {
  'gpt-4.1-nano': 'GPT-4.1 Nano',
  'gpt-4.1-mini': 'GPT-4.1 Mini',
  'gpt-4.1': 'GPT-4.1',
  'gpt-4o-mini': 'GPT-4o Mini',
  'gpt-4o': 'GPT-4o',
  'gpt-5.4': 'GPT-5.4',
  'gpt-5.3-codex': 'GPT-5.3 Codex',
  'gpt-5-mini': 'GPT-5 Mini',
  'gpt-5': 'GPT-5',
  'claude-opus-4-7': 'Opus 4.7',
  'claude-opus-4-6': 'Opus 4.6',
  'claude-opus-4-5': 'Opus 4.5',
  'claude-opus-4-1': 'Opus 4.1',
  'claude-opus-4': 'Opus 4',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-sonnet-4-5': 'Sonnet 4.5',
  'claude-sonnet-4': 'Sonnet 4',
  'claude-3-7-sonnet': 'Sonnet 3.7',
  'claude-3-5-sonnet': 'Sonnet 3.5',
  'o4-mini': 'o4-mini',
  'o3': 'o3',
}

const toolNameMap: Record<string, string> = {
  bash: 'Bash',
  run_in_terminal: 'Bash',
  read_file: 'Read',
  write_file: 'Edit',
  edit_file: 'Edit',
  replace_string_in_file: 'Edit',
  create_file: 'Write',
  delete_file: 'Delete',
  search_files: 'Grep',
  file_search: 'Grep',
  find_files: 'Glob',
  list_directory: 'LS',
  list_dir: 'LS',
  web_search: 'WebSearch',
  fetch_webpage: 'WebFetch',
  github_repo: 'GitHub',
  memory: 'Memory',
  kill_terminal: 'Bash',
}

const CHARS_PER_TOKEN = 4
const COPILOT_OPENAI_AUTO = 'copilot-openai-auto'
const COPILOT_ANTHROPIC_AUTO = 'copilot-anthropic-auto'

const modelDisplayEntries = Object.entries(modelDisplayNames).sort((a, b) => b[0].length - a[0].length)

// --- Legacy format (session-state/events.jsonl with outputTokens) ---

type LegacyToolRequest = {
  name?: string
  toolCallId?: string
  type?: string
}

type LegacyCopilotEvent =
  | { type: 'session.model_change'; timestamp?: string; data: { newModel: string } }
  | { type: 'user.message'; timestamp?: string; data: { content: string; interactionId?: string } }
  | { type: 'assistant.message'; timestamp?: string; data: { messageId: string; outputTokens: number; interactionId?: string; toolRequests?: LegacyToolRequest[] } }

function parseLegacyEvents(content: string, sessionId: string, seenKeys: Set<string>): ParsedProviderCall[] {
  const results: ParsedProviderCall[] = []
  const lines = content.split('\n').filter(l => l.trim())
  let currentModel = ''
  let pendingUserMessage = ''

  for (const line of lines) {
    let event: LegacyCopilotEvent
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }

    if (event.type === 'session.model_change') {
      currentModel = event.data.newModel ?? currentModel
      continue
    }

    if (event.type === 'user.message') {
      pendingUserMessage = event.data.content ?? ''
      continue
    }

    if (event.type === 'assistant.message') {
      const { messageId, outputTokens, toolRequests = [] } = event.data
      if (outputTokens === 0) continue
      if (!currentModel) continue

      const dedupKey = `copilot:${sessionId}:${messageId}`
      if (seenKeys.has(dedupKey)) continue
      seenKeys.add(dedupKey)

      const tools = toolRequests
        .map(t => t.name ?? '')
        .filter(Boolean)
        .map(n => toolNameMap[n] ?? n)

      const costUSD = calculateCost(currentModel, 0, outputTokens, 0, 0, 0)

      results.push({
        provider: 'copilot',
        model: currentModel,
        inputTokens: 0,
        outputTokens,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        webSearchRequests: 0,
        costUSD,
        tools,
        bashCommands: [],
        timestamp: event.timestamp ?? '',
        speed: 'standard',
        deduplicationKey: dedupKey,
        userMessage: pendingUserMessage,
        sessionId,
      })

      pendingUserMessage = ''
    }
  }

  return results
}

// --- VS Code transcript format (workspaceStorage transcripts) ---

type TranscriptToolRequest = {
  toolCallId?: string
  name?: string
  arguments?: string
  type?: string
}

type TranscriptEvent =
  | { type: 'session.start'; timestamp?: string; data: { sessionId: string; producer?: string } }
  | { type: 'user.message'; timestamp?: string; data: { content: string; attachments?: unknown[] } }
  | { type: 'assistant.message'; timestamp?: string; data: { messageId: string; content?: string; reasoningText?: string; toolRequests?: TranscriptToolRequest[]; outputTokens?: number } }
  | { type: string; timestamp?: string; data: Record<string, unknown> }

const transcriptToolCallModelHints: Array<{ prefix: string; model: string }> = [
  // Anthropic tool-call ID variants observed in Copilot transcript logs.
  { prefix: 'toolu_bdrk_', model: COPILOT_ANTHROPIC_AUTO },
  { prefix: 'toolu_vrtx_', model: COPILOT_ANTHROPIC_AUTO },
  { prefix: 'tooluse_', model: COPILOT_ANTHROPIC_AUTO },
  // OpenAI tool-call IDs.
  { prefix: 'call_', model: COPILOT_OPENAI_AUTO },
]

function inferModelFromToolCallIds(events: TranscriptEvent[]): string {
  const modelCounts = new Map<string, number>()

  for (const e of events) {
    if (e.type !== 'assistant.message') continue
    const msg = e as { data: { toolRequests?: TranscriptToolRequest[] } }
    for (const t of msg.data.toolRequests ?? []) {
      const toolCallId = t.toolCallId ?? ''
      for (const hint of transcriptToolCallModelHints) {
        if (!toolCallId.startsWith(hint.prefix)) continue
        modelCounts.set(hint.model, (modelCounts.get(hint.model) ?? 0) + 1)
        break
      }
    }
  }

  if (modelCounts.size > 0) {
    return [...modelCounts.entries()].sort((a, b) => b[1] - a[1])[0]![0]
  }

  return 'copilot-auto'
}

function parseTranscriptEvents(content: string, sessionId: string, seenKeys: Set<string>): ParsedProviderCall[] {
  const results: ParsedProviderCall[] = []
  const lines = content.split('\n').filter(l => l.trim())
  const events: TranscriptEvent[] = []

  for (const line of lines) {
    try {
      events.push(JSON.parse(line))
    } catch {
      continue
    }
  }

  const model = inferModelFromToolCallIds(events)
  let pendingUserMessage = ''

  for (const event of events) {
    if (event.type === 'user.message') {
      const data = event.data as { content?: string }
      pendingUserMessage = (data.content ?? '').slice(0, 500)
      continue
    }

    if (event.type === 'assistant.message') {
      const data = event.data as { messageId: string; content?: string; reasoningText?: string; toolRequests?: TranscriptToolRequest[]; outputTokens?: number }
      const contentText = data.content ?? ''
      const reasoningText = data.reasoningText ?? ''

      if (contentText.length === 0 && reasoningText.length === 0 && (data.toolRequests ?? []).length === 0) continue

      const dedupKey = `copilot:${sessionId}:${data.messageId}`
      if (seenKeys.has(dedupKey)) continue
      seenKeys.add(dedupKey)

      let outputTokens = data.outputTokens ?? 0
      let reasoningTokens = 0
      if (outputTokens === 0) {
        outputTokens = Math.ceil(contentText.length / CHARS_PER_TOKEN)
        reasoningTokens = Math.ceil(reasoningText.length / CHARS_PER_TOKEN)
      }

      const inputTokens = Math.ceil(pendingUserMessage.length / CHARS_PER_TOKEN)

      const tools = (data.toolRequests ?? [])
        .map(t => t.name ?? '')
        .filter(Boolean)
        .map(n => toolNameMap[n] ?? n)

      const costUSD = calculateCost(model, inputTokens, outputTokens + reasoningTokens, 0, 0, 0)

      results.push({
        provider: 'copilot',
        model,
        inputTokens,
        outputTokens,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens,
        webSearchRequests: 0,
        costUSD,
        tools,
        bashCommands: [],
        timestamp: event.timestamp ?? '',
        speed: 'standard',
        deduplicationKey: dedupKey,
        userMessage: pendingUserMessage,
        sessionId,
      })

      pendingUserMessage = ''
    }
  }

  return results
}

// --- Parser ---

function isTranscriptFormat(content: string): boolean {
  const firstLine = content.split('\n')[0] ?? ''
  try {
    const event = JSON.parse(firstLine)
    return event.type === 'session.start' && event.data?.producer === 'copilot-agent'
  } catch {
    return false
  }
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const content = await readSessionFile(source.path)
      if (content === null) return
      const sessionId = basename(source.path, '.jsonl').length === 36
        ? basename(source.path, '.jsonl')
        : basename(dirname(source.path))

      const calls = isTranscriptFormat(content)
        ? parseTranscriptEvents(content, sessionId, seenKeys)
        : parseLegacyEvents(content, sessionId, seenKeys)

      for (const call of calls) {
        yield call
      }
    },
  }
}

// --- Discovery ---

function getCopilotSessionStateDir(override?: string): string {
  return override ?? join(homedir(), '.copilot', 'session-state')
}

function getVSCodeWorkspaceStorageDirs(): string[] {
  if (process.platform === 'darwin') {
    return [
      join(homedir(), 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage'),
      join(homedir(), 'Library', 'Application Support', 'Code - Insiders', 'User', 'workspaceStorage'),
    ]
  }

  if (process.platform === 'win32') {
    return [
      join(homedir(), 'AppData', 'Roaming', 'Code', 'User', 'workspaceStorage'),
      join(homedir(), 'AppData', 'Roaming', 'Code - Insiders', 'User', 'workspaceStorage'),
    ]
  }

  return [
    join(homedir(), '.config', 'Code', 'User', 'workspaceStorage'),
    join(homedir(), '.config', 'Code - Insiders', 'User', 'workspaceStorage'),
  ]
}

function parseCwd(yaml: string): string | null {
  const match = yaml.match(/^cwd:\s*(.+)$/m)
  if (!match?.[1]) return null
  const raw = match[1]
    .replace(/\s*#.*$/, '')
    .replace(/^['"]|['"]$/g, '')
    .trim()
  return raw || null
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

async function discoverLegacySessions(sessionStateDir: string): Promise<SessionSource[]> {
  const sources: SessionSource[] = []

  let sessionDirs: string[]
  try {
    sessionDirs = await readdir(sessionStateDir)
  } catch {
    return sources
  }

  for (const sessionId of sessionDirs) {
    const eventsPath = join(sessionStateDir, sessionId, 'events.jsonl')
    const s = await stat(eventsPath).catch(() => null)
    if (!s?.isFile()) continue

    let project = sessionId
    const yaml = await readSessionFile(join(sessionStateDir, sessionId, 'workspace.yaml'))
    if (yaml !== null) {
      const cwd = parseCwd(yaml)
      if (cwd) project = basename(cwd)
    }

    sources.push({ path: eventsPath, project, provider: 'copilot' })
  }

  return sources
}

async function discoverVSCodeTranscripts(workspaceStorageDir: string): Promise<SessionSource[]> {
  const sources: SessionSource[] = []

  let workspaceDirs: string[]
  try {
    workspaceDirs = await readdir(workspaceStorageDir)
  } catch {
    return sources
  }

  for (const wsDir of workspaceDirs) {
    const transcriptsDir = join(workspaceStorageDir, wsDir, 'GitHub.copilot-chat', 'transcripts')
    if (!existsSync(transcriptsDir)) continue

    const project = await readWorkspaceProject(join(workspaceStorageDir, wsDir))

    let files: string[]
    try {
      files = await readdir(transcriptsDir)
    } catch {
      continue
    }

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const filePath = join(transcriptsDir, file)
      const s = await stat(filePath).catch(() => null)
      if (!s?.isFile()) continue
      sources.push({ path: filePath, project, provider: 'copilot' })
    }
  }

  return sources
}

export function createCopilotProvider(sessionStateDir?: string, workspaceStorageDirOverride?: string): Provider {
  const legacyDir = getCopilotSessionStateDir(sessionStateDir)
  const vscodeDirs = workspaceStorageDirOverride != null ? [workspaceStorageDirOverride] : getVSCodeWorkspaceStorageDirs()

  return {
    name: 'copilot',
    displayName: 'Copilot',

    modelDisplayName(model: string): string {
      if (model === 'copilot-auto') return 'Copilot (auto)'
      if (model === COPILOT_OPENAI_AUTO) return 'Copilot (OpenAI auto)'
      if (model === COPILOT_ANTHROPIC_AUTO) return 'Copilot (Anthropic auto)'
      for (const [key, name] of modelDisplayEntries) {
        if (model === key || model.startsWith(key + '-')) return name
      }
      return model
    },

    toolDisplayName(rawTool: string): string {
      return toolNameMap[rawTool] ?? rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      const [legacy, ...vscodeResults] = await Promise.all([
        discoverLegacySessions(legacyDir),
        ...vscodeDirs.map(discoverVSCodeTranscripts),
      ])
      return [...legacy, ...vscodeResults.flat()]
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const copilot = createCopilotProvider()

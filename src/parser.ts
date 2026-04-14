import { readdir, readFile, stat } from 'fs/promises'
import { basename, join } from 'path'
import { homedir } from 'os'
import { calculateCost, getShortModelName } from './models.js'
import type {
  AssistantMessageContent,
  ClassifiedTurn,
  ContentBlock,
  DateRange,
  JournalEntry,
  ParsedApiCall,
  ParsedTurn,
  ProjectSummary,
  SessionSummary,
  TokenUsage,
  ToolUseBlock,
} from './types.js'
import { classifyTurn, BASH_TOOLS } from './classifier.js'
import { extractBashCommands } from './bash-utils.js'
import { parseCodexSessions } from './codex-parser.js'

function getClaudeDir(): string {
  return process.env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude')
}

function getProjectsDir(): string {
  return join(getClaudeDir(), 'projects')
}

function getDesktopSessionsDir(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions')
  if (process.platform === 'win32') return join(homedir(), 'AppData', 'Roaming', 'Claude', 'local-agent-mode-sessions')
  return join(homedir(), '.config', 'Claude', 'local-agent-mode-sessions')
}

async function findDesktopProjectDirs(base: string): Promise<string[]> {
  const results: string[] = []
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 8) return
    const entries = await readdir(dir).catch(() => [])
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.git') continue
      const full = join(dir, entry)
      const s = await stat(full).catch(() => null)
      if (!s?.isDirectory()) continue
      if (entry === 'projects') {
        const projectDirs = await readdir(full).catch(() => [])
        for (const pd of projectDirs) {
          const pdFull = join(full, pd)
          const pdStat = await stat(pdFull).catch(() => null)
          if (pdStat?.isDirectory()) results.push(pdFull)
        }
      } else {
        await walk(full, depth + 1)
      }
    }
  }
  await walk(base, 0)
  return results
}

function unsanitizePath(dirName: string): string {
  return dirName.replace(/-/g, '/')
}

function parseJsonlLine(line: string): JournalEntry | null {
  try {
    return JSON.parse(line) as JournalEntry
  } catch {
    return null
  }
}

function extractToolNames(content: ContentBlock[]): string[] {
  return content
    .filter((b): b is ToolUseBlock => b.type === 'tool_use')
    .map(b => b.name)
}

function extractMcpTools(tools: string[]): string[] {
  return tools.filter(t => t.startsWith('mcp__'))
}

function extractCoreTools(tools: string[]): string[] {
  return tools.filter(t => !t.startsWith('mcp__'))
}

function extractBashCommandsFromContent(content: ContentBlock[]): string[] {
  return content
    .filter((b): b is ToolUseBlock => b.type === 'tool_use' && BASH_TOOLS.has((b as ToolUseBlock).name))
    .flatMap(b => {
      const command = (b.input as Record<string, unknown>)?.command
      return typeof command === 'string' ? extractBashCommands(command) : []
    })
}

function getUserMessageText(entry: JournalEntry): string {
  if (!entry.message || entry.message.role !== 'user') return ''
  const content = entry.message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text)
      .join(' ')
  }
  return ''
}

function getMessageId(entry: JournalEntry): string | null {
  if (entry.type !== 'assistant') return null
  const msg = entry.message as AssistantMessageContent | undefined
  return msg?.id ?? null
}

function parseApiCall(entry: JournalEntry): ParsedApiCall | null {
  if (entry.type !== 'assistant') return null
  const msg = entry.message as AssistantMessageContent | undefined
  if (!msg?.usage || !msg?.model) return null

  const usage = msg.usage
  const tokens: TokenUsage = {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    webSearchRequests: usage.server_tool_use?.web_search_requests ?? 0,
  }

  const tools = extractToolNames(msg.content ?? [])
  const costUSD = calculateCost(
    msg.model,
    tokens.inputTokens,
    tokens.outputTokens,
    tokens.cacheCreationInputTokens,
    tokens.cacheReadInputTokens,
    tokens.webSearchRequests,
    usage.speed ?? 'standard',
  )

  const bashCmds = extractBashCommandsFromContent(msg.content ?? [])

  return {
    model: msg.model,
    usage: tokens,
    costUSD,
    tools,
    mcpTools: extractMcpTools(tools),
    hasAgentSpawn: tools.includes('Agent'),
    hasPlanMode: tools.includes('EnterPlanMode'),
    speed: usage.speed ?? 'standard',
    timestamp: entry.timestamp ?? '',
    bashCommands: bashCmds,
  }
}

function groupIntoTurns(entries: JournalEntry[], seenMsgIds: Set<string>): ParsedTurn[] {
  const turns: ParsedTurn[] = []
  let currentUserMessage = ''
  let currentCalls: ParsedApiCall[] = []
  let currentTimestamp = ''
  let currentSessionId = ''

  for (const entry of entries) {
    if (entry.type === 'user') {
      const text = getUserMessageText(entry)
      if (text.trim()) {
        if (currentCalls.length > 0) {
          turns.push({
            userMessage: currentUserMessage,
            assistantCalls: currentCalls,
            timestamp: currentTimestamp,
            sessionId: currentSessionId,
          })
        }
        currentUserMessage = text
        currentCalls = []
        currentTimestamp = entry.timestamp ?? ''
        currentSessionId = entry.sessionId ?? ''
      }
    } else if (entry.type === 'assistant') {
      const msgId = getMessageId(entry)
      if (msgId && seenMsgIds.has(msgId)) continue
      if (msgId) seenMsgIds.add(msgId)
      const call = parseApiCall(entry)
      if (call) currentCalls.push(call)
    }
  }

  if (currentCalls.length > 0) {
    turns.push({
      userMessage: currentUserMessage,
      assistantCalls: currentCalls,
      timestamp: currentTimestamp,
      sessionId: currentSessionId,
    })
  }

  return turns
}

function buildSessionSummary(
  sessionId: string,
  project: string,
  turns: ClassifiedTurn[],
): SessionSummary {
  const modelBreakdown: SessionSummary['modelBreakdown'] = {}
  const toolBreakdown: SessionSummary['toolBreakdown'] = {}
  const mcpBreakdown: SessionSummary['mcpBreakdown'] = {}
  const bashBreakdown: SessionSummary['bashBreakdown'] = {}
  const categoryBreakdown: SessionSummary['categoryBreakdown'] = {} as SessionSummary['categoryBreakdown']

  let totalCost = 0
  let totalInput = 0
  let totalOutput = 0
  let totalCacheRead = 0
  let totalCacheWrite = 0
  let apiCalls = 0
  let firstTs = ''
  let lastTs = ''

  for (const turn of turns) {
    const turnCost = turn.assistantCalls.reduce((s, c) => s + c.costUSD, 0)

    if (!categoryBreakdown[turn.category]) {
      categoryBreakdown[turn.category] = { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 }
    }
    categoryBreakdown[turn.category].turns++
    categoryBreakdown[turn.category].costUSD += turnCost
    if (turn.hasEdits) {
      categoryBreakdown[turn.category].editTurns++
      categoryBreakdown[turn.category].retries += turn.retries
      if (turn.retries === 0) categoryBreakdown[turn.category].oneShotTurns++
    }

    for (const call of turn.assistantCalls) {
      totalCost += call.costUSD
      totalInput += call.usage.inputTokens
      totalOutput += call.usage.outputTokens
      totalCacheRead += call.usage.cacheReadInputTokens
      totalCacheWrite += call.usage.cacheCreationInputTokens
      apiCalls++

      const modelKey = getShortModelName(call.model)
      if (!modelBreakdown[modelKey]) {
        modelBreakdown[modelKey] = {
          calls: 0,
          costUSD: 0,
          tokens: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, webSearchRequests: 0 },
        }
      }
      modelBreakdown[modelKey].calls++
      modelBreakdown[modelKey].costUSD += call.costUSD
      modelBreakdown[modelKey].tokens.inputTokens += call.usage.inputTokens
      modelBreakdown[modelKey].tokens.outputTokens += call.usage.outputTokens
      modelBreakdown[modelKey].tokens.cacheReadInputTokens += call.usage.cacheReadInputTokens
      modelBreakdown[modelKey].tokens.cacheCreationInputTokens += call.usage.cacheCreationInputTokens

      for (const tool of extractCoreTools(call.tools)) {
        toolBreakdown[tool] = toolBreakdown[tool] ?? { calls: 0 }
        toolBreakdown[tool].calls++
      }
      for (const mcp of call.mcpTools) {
        const server = mcp.split('__')[1] ?? mcp
        mcpBreakdown[server] = mcpBreakdown[server] ?? { calls: 0 }
        mcpBreakdown[server].calls++
      }
      for (const cmd of call.bashCommands) {
        bashBreakdown[cmd] = bashBreakdown[cmd] ?? { calls: 0 }
        bashBreakdown[cmd].calls++
      }

      if (!firstTs || call.timestamp < firstTs) firstTs = call.timestamp
      if (!lastTs || call.timestamp > lastTs) lastTs = call.timestamp
    }
  }

  return {
    sessionId,
    project,
    firstTimestamp: firstTs || turns[0]?.timestamp || '',
    lastTimestamp: lastTs || turns[turns.length - 1]?.timestamp || '',
    totalCostUSD: totalCost,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    totalCacheReadTokens: totalCacheRead,
    totalCacheWriteTokens: totalCacheWrite,
    apiCalls,
    turns,
    modelBreakdown,
    toolBreakdown,
    mcpBreakdown,
    bashBreakdown,
    categoryBreakdown,
  }
}

async function parseSessionFile(
  filePath: string,
  project: string,
  seenMsgIds: Set<string>,
  dateRange?: DateRange,
): Promise<SessionSummary | null> {
  let content: string
  try {
    content = await readFile(filePath, 'utf-8')
  } catch {
    return null
  }
  const lines = content.split('\n').filter(l => l.trim())
  const entries: JournalEntry[] = []

  for (const line of lines) {
    const entry = parseJsonlLine(line)
    if (entry) entries.push(entry)
  }

  if (entries.length === 0) return null

  let filteredEntries = entries
  if (dateRange) {
    filteredEntries = entries.filter(e => {
      if (!e.timestamp) return e.type === 'user'
      const ts = new Date(e.timestamp)
      return ts >= dateRange.start && ts <= dateRange.end
    })
    if (filteredEntries.length === 0) return null
  }

  const sessionId = basename(filePath, '.jsonl')
  const turns = groupIntoTurns(filteredEntries, seenMsgIds)
  const classified = turns.map(classifyTurn)

  return buildSessionSummary(sessionId, project, classified)
}

async function scanProjectDirs(dirs: Array<{ path: string; name: string }>, seenMsgIds: Set<string>, dateRange?: DateRange): Promise<ProjectSummary[]> {
  const projectMap = new Map<string, SessionSummary[]>()

  for (const { path: dirPath, name: dirName } of dirs) {
    const files = await readdir(dirPath).catch(() => [])
    const jsonlFiles = files.filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'))

    for (const file of jsonlFiles) {
      const session = await parseSessionFile(join(dirPath, file), dirName, seenMsgIds, dateRange)
      if (session && session.apiCalls > 0) {
        const existing = projectMap.get(dirName) ?? []
        existing.push(session)
        projectMap.set(dirName, existing)
      }
    }
  }

  const projects: ProjectSummary[] = []
  for (const [dirName, sessions] of projectMap) {
    projects.push({
      project: dirName,
      projectPath: unsanitizePath(dirName),
      sessions,
      totalCostUSD: sessions.reduce((s, sess) => s + sess.totalCostUSD, 0),
      totalApiCalls: sessions.reduce((s, sess) => s + sess.apiCalls, 0),
    })
  }

  return projects
}

export type Source = 'all' | 'claude' | 'codex'

export async function parseAllSessions(dateRange?: DateRange, source: Source = 'all'): Promise<ProjectSummary[]> {
  const seenMsgIds = new Set<string>()
  const allDirs: Array<{ path: string; name: string }> = []

  if (source !== 'codex') {
    const projectsDir = getProjectsDir()
    try {
      const entries = await readdir(projectsDir)
      for (const dirName of entries) {
        const dirPath = join(projectsDir, dirName)
        const dirStat = await stat(dirPath).catch(() => null)
        if (dirStat?.isDirectory()) allDirs.push({ path: dirPath, name: dirName })
      }
    } catch {}

    const desktopDirs = await findDesktopProjectDirs(getDesktopSessionsDir())
    for (const dirPath of desktopDirs) {
      const dirName = basename(dirPath)
      allDirs.push({ path: dirPath, name: dirName })
    }
  }

  const [claudeProjects, codexProjects] = await Promise.all([
    source === 'codex' ? Promise.resolve([] as ProjectSummary[]) : scanProjectDirs(allDirs, seenMsgIds, dateRange),
    source === 'claude' ? Promise.resolve([] as ProjectSummary[]) : parseCodexSessions(dateRange),
  ])

  const merged = new Map<string, ProjectSummary>()
  for (const p of [...claudeProjects, ...codexProjects]) {
    const existing = merged.get(p.project)
    if (!existing) {
      merged.set(p.project, p)
      continue
    }
    existing.sessions.push(...p.sessions)
    existing.totalCostUSD += p.totalCostUSD
    existing.totalApiCalls += p.totalApiCalls
  }

  return [...merged.values()].sort((a, b) => b.totalCostUSD - a.totalCostUSD)
}

import { readdir, readFile, stat } from 'fs/promises'
import { basename, join } from 'path'
import { homedir } from 'os'
import { calculateCost, getShortModelName } from './models.js'
import type {
  ClassifiedTurn,
  DateRange,
  ParsedApiCall,
  ParsedTurn,
  ProjectSummary,
  SessionSummary,
} from './types.js'
import { classifyTurn } from './classifier.js'
import { extractBashCommands } from './bash-utils.js'

type RawUsage = {
  input: number
  cached: number
  output: number
  reasoning: number
  total: number
}

const LEGACY_FALLBACK_MODEL = 'gpt-5'

function getCodexHome(): string {
  const env = process.env['CODEX_HOME']?.trim()
  return env && env !== '' ? env : join(homedir(), '.codex')
}

function getSessionsDir(): string {
  return join(getCodexHome(), 'sessions')
}

async function collectJsonlFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  async function walk(d: string, depth: number): Promise<void> {
    if (depth > 10) return
    const entries = await readdir(d).catch(() => [])
    for (const entry of entries) {
      const full = join(d, entry)
      const s = await stat(full).catch(() => null)
      if (!s) continue
      if (s.isDirectory()) await walk(full, depth + 1)
      else if (entry.endsWith('.jsonl')) out.push(full)
    }
  }
  await walk(dir, 0)
  return out
}

function ensureNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function normalizeUsage(value: unknown): RawUsage | null {
  if (value == null || typeof value !== 'object') return null
  const r = value as Record<string, unknown>
  const input = ensureNumber(r['input_tokens'])
  const cached = ensureNumber(r['cached_input_tokens'] ?? r['cache_read_input_tokens'])
  const output = ensureNumber(r['output_tokens'])
  const reasoning = ensureNumber(r['reasoning_output_tokens'])
  const total = ensureNumber(r['total_tokens'])
  return {
    input,
    cached,
    output,
    reasoning,
    total: total > 0 ? total : input + output,
  }
}

function subtractUsage(cur: RawUsage, prev: RawUsage | null): RawUsage {
  return {
    input: Math.max(cur.input - (prev?.input ?? 0), 0),
    cached: Math.max(cur.cached - (prev?.cached ?? 0), 0),
    output: Math.max(cur.output - (prev?.output ?? 0), 0),
    reasoning: Math.max(cur.reasoning - (prev?.reasoning ?? 0), 0),
    total: Math.max(cur.total - (prev?.total ?? 0), 0),
  }
}

function sanitizeCwdToProjectName(cwd: string): string {
  if (!cwd) return 'unknown'
  return cwd.replace(/[\\/:]/g, '-')
}

function safeParseJson(s: string): unknown | null {
  try { return JSON.parse(s) } catch { return null }
}

type StepAccumulator = {
  tools: string[]
  mcpTools: string[]
  bashCommands: string[]
  hasPlanMode: boolean
  webSearches: number
}

function newStep(): StepAccumulator {
  return { tools: [], mcpTools: [], bashCommands: [], hasPlanMode: false, webSearches: 0 }
}

function handleFunctionCall(step: StepAccumulator, name: string, argsStr: string): void {
  if (name === 'shell_command' || name === 'shell' || name === 'local_shell_call') {
    step.tools.push('Bash')
    const parsed = safeParseJson(argsStr)
    if (parsed && typeof parsed === 'object') {
      const cmd = (parsed as Record<string, unknown>)['command']
      if (typeof cmd === 'string') {
        step.bashCommands.push(...extractBashCommands(cmd))
      } else if (Array.isArray(cmd)) {
        const joined = cmd.filter(x => typeof x === 'string').join(' ')
        step.bashCommands.push(...extractBashCommands(joined))
      }
    }
    return
  }
  if (name === 'update_plan') {
    step.hasPlanMode = true
    step.tools.push('update_plan')
    return
  }
  if (name.startsWith('mcp__')) {
    step.tools.push(name)
    step.mcpTools.push(name)
    return
  }
  step.tools.push(name)
}

function handleCustomToolCall(step: StepAccumulator, name: string): void {
  if (name === 'apply_patch') {
    step.tools.push('Edit')
    return
  }
  step.tools.push(name)
}

function buildApiCall(
  step: StepAccumulator,
  raw: RawUsage,
  model: string,
  timestamp: string,
): ParsedApiCall {
  const nonCachedInput = Math.max(raw.input - raw.cached, 0)
  const cost = calculateCost(
    model,
    nonCachedInput,
    raw.output,
    0,
    raw.cached,
    step.webSearches,
    'standard',
  )
  return {
    model,
    usage: {
      inputTokens: nonCachedInput,
      outputTokens: raw.output,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: raw.cached,
      webSearchRequests: step.webSearches,
    },
    costUSD: cost,
    tools: step.tools,
    mcpTools: step.mcpTools,
    hasAgentSpawn: false,
    hasPlanMode: step.hasPlanMode,
    speed: 'standard',
    timestamp,
    bashCommands: step.bashCommands,
  }
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

  let totalCost = 0, totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0
  let apiCalls = 0
  let firstTs = '', lastTs = ''

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

      for (const tool of call.tools) {
        if (tool.startsWith('mcp__')) continue
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

type ParseFileResult = {
  session: SessionSummary | null
  project: string
  projectPath: string
}

async function parseSessionFile(filePath: string, dateRange?: DateRange): Promise<ParseFileResult | null> {
  let content: string
  try { content = await readFile(filePath, 'utf-8') } catch { return null }

  const lines = content.split(/\r?\n/)
  const sessionId = basename(filePath, '.jsonl')

  let cwd = ''
  let currentModel = LEGACY_FALLBACK_MODEL
  let currentUserMessage = ''
  let currentTurnStartTs = ''
  let pendingCalls: ParsedApiCall[] = []
  let step = newStep()
  let previousTotals: RawUsage | null = null
  const rawTurns: ParsedTurn[] = []

  const flushTurn = (): void => {
    if (pendingCalls.length === 0 && !currentUserMessage) return
    rawTurns.push({
      userMessage: currentUserMessage,
      assistantCalls: pendingCalls,
      timestamp: currentTurnStartTs,
      sessionId,
    })
    pendingCalls = []
    step = newStep()
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parsed = safeParseJson(trimmed) as Record<string, unknown> | null
    if (!parsed || typeof parsed !== 'object') continue

    const entryType = parsed['type']
    const payload = parsed['payload'] as Record<string, unknown> | undefined
    const timestamp = typeof parsed['timestamp'] === 'string' ? parsed['timestamp'] : ''

    if (entryType === 'session_meta' && payload) {
      const c = payload['cwd']
      if (typeof c === 'string') cwd = c
      continue
    }

    if (entryType === 'turn_context' && payload) {
      const m = payload['model']
      if (typeof m === 'string' && m.trim() !== '') currentModel = m.trim()
      const c = payload['cwd']
      if (typeof c === 'string' && !cwd) cwd = c
      continue
    }

    if (entryType === 'event_msg' && payload) {
      const pt = payload['type']
      if (pt === 'user_message') {
        flushTurn()
        const msg = payload['message']
        currentUserMessage = typeof msg === 'string' ? msg : ''
        currentTurnStartTs = timestamp
        continue
      }

      if (pt === 'token_count') {
        const info = payload['info'] as Record<string, unknown> | null | undefined
        if (!info) continue
        const last = normalizeUsage(info['last_token_usage'])
        const totals = normalizeUsage(info['total_token_usage'])

        let raw: RawUsage | null = last
        if (!raw && totals) raw = subtractUsage(totals, previousTotals)
        if (totals) previousTotals = totals
        if (!raw) continue

        const hasAny = raw.input > 0 || raw.output > 0 || raw.cached > 0
        if (!hasAny) {
          step = newStep()
          continue
        }

        pendingCalls.push(buildApiCall(step, raw, currentModel, timestamp))
        step = newStep()
        continue
      }
      continue
    }

    if (entryType === 'response_item' && payload) {
      const pt = payload['type']
      if (pt === 'function_call') {
        const name = typeof payload['name'] === 'string' ? payload['name'] : ''
        const args = typeof payload['arguments'] === 'string' ? payload['arguments'] : ''
        if (name) handleFunctionCall(step, name, args)
        continue
      }
      if (pt === 'custom_tool_call') {
        const name = typeof payload['name'] === 'string' ? payload['name'] : ''
        if (name) handleCustomToolCall(step, name)
        continue
      }
      if (pt === 'web_search_call') {
        step.tools.push('WebSearch')
        step.webSearches++
        continue
      }
      if (pt === 'local_shell_call') {
        step.tools.push('Bash')
        const action = payload['action'] as Record<string, unknown> | undefined
        const cmd = action?.['command']
        if (Array.isArray(cmd)) {
          step.bashCommands.push(...extractBashCommands(cmd.filter(x => typeof x === 'string').join(' ')))
        } else if (typeof cmd === 'string') {
          step.bashCommands.push(...extractBashCommands(cmd))
        }
        continue
      }
      continue
    }
  }

  flushTurn()

  if (rawTurns.length === 0 && pendingCalls.length === 0) return null

  let filtered = rawTurns
  if (dateRange) {
    filtered = rawTurns.filter(t => {
      const ts = t.timestamp || t.assistantCalls[0]?.timestamp
      if (!ts) return false
      const d = new Date(ts)
      return d >= dateRange.start && d <= dateRange.end
    })
    if (filtered.length === 0) return null
  }

  const turnsWithCalls = filtered.filter(t => t.assistantCalls.length > 0)
  if (turnsWithCalls.length === 0) return null

  const classified = turnsWithCalls.map(classifyTurn)
  const projectName = sanitizeCwdToProjectName(cwd)
  const projectPath = cwd || projectName

  return {
    session: buildSessionSummary(sessionId, projectName, classified),
    project: projectName,
    projectPath,
  }
}

export async function parseCodexSessions(dateRange?: DateRange): Promise<ProjectSummary[]> {
  const sessionsDir = getSessionsDir()
  const dirStat = await stat(sessionsDir).catch(() => null)
  if (!dirStat?.isDirectory()) return []

  const files = await collectJsonlFiles(sessionsDir)
  const projectMap = new Map<string, { path: string; sessions: SessionSummary[] }>()

  for (const file of files) {
    const result = await parseSessionFile(file, dateRange)
    if (!result || !result.session) continue
    if (result.session.apiCalls === 0) continue
    const existing = projectMap.get(result.project) ?? { path: result.projectPath, sessions: [] }
    existing.sessions.push(result.session)
    projectMap.set(result.project, existing)
  }

  const projects: ProjectSummary[] = []
  for (const [name, { path: projectPath, sessions }] of projectMap) {
    projects.push({
      project: name,
      projectPath,
      sessions,
      totalCostUSD: sessions.reduce((s, sess) => s + sess.totalCostUSD, 0),
      totalApiCalls: sessions.reduce((s, sess) => s + sess.apiCalls, 0),
    })
  }

  return projects
}

import { createHash } from 'crypto'
import { readdir, stat } from 'fs/promises'
import { basename, join } from 'path'
import { readSessionFile, readSessionLinesFromOffset } from './fs-utils.js'
import { calculateCost, getShortModelName } from './models.js'
import { discoverAllSessions, getProvider } from './providers/index.js'
import type { ParsedProviderCall, Provider, SessionSource } from './providers/types.js'
import {
  computeFileFingerprint,
  loadSourceCacheManifest,
  readSourceCacheEntry,
  saveSourceCacheManifest,
  SOURCE_CACHE_VERSION,
  writeSourceCacheEntry,
} from './source-cache.js'
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
    cachedInputTokens: 0,
    reasoningTokens: 0,
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
    provider: 'claude',
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
    deduplicationKey: msg.id ?? `claude:${entry.timestamp}`,
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
  const modelBreakdown: SessionSummary['modelBreakdown'] = Object.create(null)
  const toolBreakdown: SessionSummary['toolBreakdown'] = Object.create(null)
  const mcpBreakdown: SessionSummary['mcpBreakdown'] = Object.create(null)
  const bashBreakdown: SessionSummary['bashBreakdown'] = Object.create(null)
  const categoryBreakdown: SessionSummary['categoryBreakdown'] = Object.create(null)

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
          tokens: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0 },
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

export type SourceProgressReporter = {
  start(label: string, total: number): void
  advance(itemLabel: string): void
  finish(): void
}

export type ParseOptions = {
  noCache?: boolean
  progress?: SourceProgressReporter | null
}

function addSessionToProjectMap(projectMap: Map<string, SessionSummary[]>, session: SessionSummary) {
  if (session.apiCalls === 0) return
  const existing = projectMap.get(session.project) ?? []
  existing.push(session)
  projectMap.set(session.project, existing)
}

function buildProjects(projectMap: Map<string, SessionSummary[]>): ProjectSummary[] {
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

function filterSessionSummaryToRange(session: SessionSummary, dateRange?: DateRange): SessionSummary | null {
  if (!dateRange) return session

  const turns = session.turns
    .map(turn => ({
      ...turn,
      assistantCalls: turn.assistantCalls.filter(call => {
        const ts = new Date(call.timestamp)
        return ts >= dateRange.start && ts <= dateRange.end
      }),
    }))
    .filter(turn => turn.assistantCalls.length > 0)

  if (turns.length === 0) return null
  return buildSessionSummary(session.sessionId, session.project, turns)
}

function addSeenDeduplicationKeysFromSessions(sessions: SessionSummary[], seenKeys: Set<string>) {
  for (const session of sessions) {
    for (const turn of session.turns) {
      for (const call of turn.assistantCalls) {
        seenKeys.add(call.deduplicationKey)
      }
    }
  }
}

function buildSessionSummaryFromEntries(
  entries: JournalEntry[],
  project: string,
  seenMsgIds: Set<string>,
  sessionIdFallback: string,
  dateRange?: DateRange,
): SessionSummary | null {
  if (entries.length === 0) return null

  let filteredEntries = entries
  if (dateRange) {
    filteredEntries = entries.filter(entry => {
      if (!entry.timestamp) return entry.type === 'user'
      const ts = new Date(entry.timestamp)
      return ts >= dateRange.start && ts <= dateRange.end
    })
    if (filteredEntries.length === 0) return null
  }

  const sessionId = entries.find(entry => typeof entry.sessionId === 'string')?.sessionId ?? sessionIdFallback
  const turns = groupIntoTurns(filteredEntries, seenMsgIds)
  if (turns.length === 0) return null

  return buildSessionSummary(sessionId, project, turns.map(classifyTurn))
}

function buildClaudeSessionSummaryFromLines(
  lines: string[],
  project: string,
  seenMsgIds: Set<string>,
  sessionIdFallback: string,
  dateRange?: DateRange,
): SessionSummary | null {
  const entries = lines
    .map(parseJsonlLine)
    .filter((entry): entry is JournalEntry => entry !== null)
  return buildSessionSummaryFromEntries(entries, project, seenMsgIds, sessionIdFallback, dateRange)
}

async function parseSessionFile(
  filePath: string,
  project: string,
  seenMsgIds: Set<string>,
  dateRange?: DateRange,
): Promise<SessionSummary | null> {
  // Skip files whose mtime is older than the range start. A session file
  // can only contain entries up to its last-modified time; if that predates
  // the requested range, nothing in this file can match.
  if (dateRange) {
    try {
      const s = await stat(filePath)
      if (s.mtimeMs < dateRange.start.getTime()) return null
    } catch { /* fall through to normal read; missing stat shouldn't break parsing */ }
  }
  const content = await readSessionFile(filePath)
  if (content === null) return null
  const lines = content.split('\n').filter(l => l.trim())
  return buildClaudeSessionSummaryFromLines(lines, project, seenMsgIds, basename(filePath, '.jsonl'), dateRange)
}

async function collectJsonlFiles(dirPath: string): Promise<string[]> {
  const files = await readdir(dirPath).catch(() => [])
  const jsonlFiles = files.filter(f => f.endsWith('.jsonl')).map(f => join(dirPath, f))

  for (const entry of files) {
    if (entry.endsWith('.jsonl')) continue
    const subagentsPath = join(dirPath, entry, 'subagents')
    const subFiles = await readdir(subagentsPath).catch(() => [])
    for (const sf of subFiles) {
      if (sf.endsWith('.jsonl')) jsonlFiles.push(join(subagentsPath, sf))
    }
  }

  return jsonlFiles
}

type ClaudeCacheUnit = {
  path: string
  project: string
  progressLabel: string
}

async function listClaudeCacheUnits(dirPath: string, dirName: string): Promise<ClaudeCacheUnit[]> {
  const jsonlFiles = await collectJsonlFiles(dirPath)
  return jsonlFiles.map(filePath => ({
    path: filePath,
    project: dirName,
    progressLabel: filePath.split(/[\\/]/).slice(-2).join('/'),
  }))
}

function appendStateTailHash(session: SessionSummary): string {
  return createHash('sha1').update(session.lastTimestamp).digest('hex')
}

function fingerprintsMatch(
  left: { mtimeMs: number; sizeBytes: number },
  right: { mtimeMs: number; sizeBytes: number },
): boolean {
  return left.mtimeMs === right.mtimeMs && left.sizeBytes === right.sizeBytes
}

async function refreshClaudeCacheUnit(
  manifest: Awaited<ReturnType<typeof loadSourceCacheManifest>>,
  unit: ClaudeCacheUnit,
  seenMsgIds: Set<string>,
  parserVersion: string,
  options: ParseOptions,
): Promise<{ session: SessionSummary | null; wrote: boolean; refreshed: boolean }> {
  let reportedRefresh = false
  const cached = options.noCache
    ? null
    : await readSourceCacheEntry(manifest, 'claude', unit.path, { allowStaleFingerprint: true })
  const fingerprint = await computeFileFingerprint(unit.path)

  if (
    cached
    && cached.parserVersion === parserVersion
    && cached.cacheStrategy === 'append-jsonl'
    && fingerprintsMatch(fingerprint, cached.fingerprint)
  ) {
    addSeenDeduplicationKeysFromSessions(cached.sessions, seenMsgIds)
    return { session: cached.sessions[0] ?? null, wrote: false, refreshed: false }
  }

  if (
    cached
    && cached.parserVersion === parserVersion
    && cached.cacheStrategy === 'append-jsonl'
    && cached.appendState
    && fingerprint.sizeBytes > cached.fingerprint.sizeBytes
  ) {
    reportedRefresh = true
    options.progress?.advance(unit.progressLabel)
    addSeenDeduplicationKeysFromSessions(cached.sessions, seenMsgIds)
    const appendedLines: string[] = []
    for await (const line of readSessionLinesFromOffset(unit.path, cached.appendState.endOffset)) {
      if (line.trim()) appendedLines.push(line)
    }

    const appended = buildClaudeSessionSummaryFromLines(
      appendedLines,
      unit.project,
      seenMsgIds,
      cached.sessions[0]?.sessionId ?? basename(unit.path, '.jsonl'),
    )

    if (appended && cached.sessions[0]) {
      const merged = buildSessionSummary(
        cached.sessions[0].sessionId,
        unit.project,
        [...cached.sessions[0].turns, ...appended.turns],
      )
      await writeSourceCacheEntry(manifest, {
        version: SOURCE_CACHE_VERSION,
        provider: 'claude',
        logicalPath: unit.path,
        fingerprintPath: unit.path,
        cacheStrategy: 'append-jsonl',
        parserVersion,
        fingerprint,
        sessions: [merged],
        appendState: {
          endOffset: fingerprint.sizeBytes,
          tailHash: appendStateTailHash(merged),
        },
      })
      return { session: merged, wrote: true, refreshed: true }
    }
  }

  if (!reportedRefresh) options.progress?.advance(unit.progressLabel)
  const session = await parseSessionFile(unit.path, unit.project, seenMsgIds)
  if (!session) return { session: null, wrote: false, refreshed: true }

  await writeSourceCacheEntry(manifest, {
    version: SOURCE_CACHE_VERSION,
    provider: 'claude',
    logicalPath: unit.path,
    fingerprintPath: unit.path,
    cacheStrategy: 'append-jsonl',
    parserVersion,
    fingerprint,
    sessions: [session],
    appendState: {
      endOffset: fingerprint.sizeBytes,
      tailHash: appendStateTailHash(session),
    },
  })
  return { session, wrote: true, refreshed: true }
}

async function scanClaudeDirsWithCache(
  dirs: Array<{ path: string; name: string }>,
  seenMsgIds: Set<string>,
  dateRange?: DateRange,
  options: ParseOptions = {},
): Promise<ProjectSummary[]> {
  const projectMap = new Map<string, SessionSummary[]>()
  const manifest = await loadSourceCacheManifest()
  const parserVersion = 'claude:v1'
  const units = (await Promise.all(
    dirs.map(dir => listClaudeCacheUnits(dir.path, dir.name)),
  )).flat()
  const refreshStates = await Promise.all(units.map(async unit => {
    const cached = options.noCache
      ? null
      : await readSourceCacheEntry(manifest, 'claude', unit.path, { allowStaleFingerprint: true })
    const fingerprint = await computeFileFingerprint(unit.path).catch(() => null)
    const reusable = !!(
      cached
      && fingerprint
      && cached.parserVersion === parserVersion
      && cached.cacheStrategy === 'append-jsonl'
      && fingerprintsMatch(fingerprint, cached.fingerprint)
    )
    return { unit, refreshed: !reusable }
  }))

  const refreshCount = refreshStates.filter(state => state.refreshed).length
  let wroteManifest = false

  if (refreshCount > 0) options.progress?.start('Updating cache', refreshCount)

  try {
    for (const { unit } of refreshStates) {
      const { session, wrote } = await refreshClaudeCacheUnit(manifest, unit, seenMsgIds, parserVersion, options)
      if (wrote) wroteManifest = true
      if (!session) continue

      const filtered = filterSessionSummaryToRange(session, dateRange)
      if (filtered) addSessionToProjectMap(projectMap, filtered)
    }
  } finally {
    if (refreshCount > 0) options.progress?.finish()
  }

  if (wroteManifest) await saveSourceCacheManifest(manifest)
  return buildProjects(projectMap)
}

function providerCallToTurn(call: ParsedProviderCall): ParsedTurn {
  const tools = call.tools
  const usage: TokenUsage = {
    inputTokens: call.inputTokens,
    outputTokens: call.outputTokens,
    cacheCreationInputTokens: call.cacheCreationInputTokens,
    cacheReadInputTokens: call.cacheReadInputTokens,
    cachedInputTokens: call.cachedInputTokens,
    reasoningTokens: call.reasoningTokens,
    webSearchRequests: call.webSearchRequests,
  }

  const apiCall: ParsedApiCall = {
    provider: call.provider,
    model: call.model,
    usage,
    costUSD: call.costUSD,
    tools,
    mcpTools: extractMcpTools(tools),
    hasAgentSpawn: tools.includes('Agent'),
    hasPlanMode: tools.includes('EnterPlanMode'),
    speed: call.speed,
    timestamp: call.timestamp,
    bashCommands: call.bashCommands,
    deduplicationKey: call.deduplicationKey,
  }

  return {
    userMessage: call.userMessage,
    assistantCalls: [apiCall],
    timestamp: call.timestamp,
    sessionId: call.sessionId,
  }
}

async function parseProviderSources(
  providerName: string,
  sources: SessionSource[],
  seenKeys: Set<string>,
  dateRange?: DateRange,
  options: ParseOptions = {},
): Promise<ProjectSummary[]> {
  const projectMap = new Map<string, SessionSummary[]>()
  const manifest = await loadSourceCacheManifest()
  const sourceStates = await Promise.all(sources.map(async source => {
    const parserVersion = source.parserVersion ?? `${providerName}:v1`
    const cached = options.noCache
      ? null
      : await readSourceCacheEntry(manifest, providerName, source.path)

    if (cached && cached.parserVersion === parserVersion) {
      return { source, parserVersion, cachedSessions: cached.sessions }
    }

    return { source, parserVersion, cachedSessions: null }
  }))

  const refreshCount = sourceStates.filter(state => state.cachedSessions === null).length
  let provider: Provider | undefined
  let wroteManifest = false

  if (refreshCount > 0) options.progress?.start('Updating cache', refreshCount)

  try {
    for (const state of sourceStates) {
      let fullSessions = state.cachedSessions

      if (fullSessions) {
        addSeenDeduplicationKeysFromSessions(fullSessions, seenKeys)
      } else {
        provider ??= await getProvider(providerName)
        if (!provider) continue

        options.progress?.advance(state.source.progressLabel ?? state.source.path)
        fullSessions = await parseFreshProviderSource(provider, providerName, state.source, seenKeys)

        const fingerprintPath = state.source.fingerprintPath ?? state.source.path
        await writeSourceCacheEntry(manifest, {
          version: SOURCE_CACHE_VERSION,
          provider: providerName,
          logicalPath: state.source.path,
          fingerprintPath,
          cacheStrategy: state.source.cacheStrategy ?? 'full-reparse',
          parserVersion: state.parserVersion,
          fingerprint: await computeFileFingerprint(fingerprintPath),
          sessions: fullSessions,
        })
        wroteManifest = true
      }

      for (const session of fullSessions
        .map(session => filterSessionSummaryToRange(session, dateRange))
        .filter((session): session is SessionSummary => session !== null)) {
        addSessionToProjectMap(projectMap, session)
      }
    }
  } finally {
    if (refreshCount > 0) options.progress?.finish()
  }

  if (wroteManifest) await saveSourceCacheManifest(manifest)

  return buildProjects(projectMap)
}

const CACHE_TTL_MS = 60_000
const MAX_CACHE_ENTRIES = 10
const sessionCache = new Map<string, { data: ProjectSummary[]; sourceSignature: string; ts: number }>()

function cacheKey(dateRange?: DateRange, providerFilter?: string, noCache = false): string {
  const s = dateRange ? `${dateRange.start.getTime()}:${dateRange.end.getTime()}` : 'none'
  return `${s}:${providerFilter ?? 'all'}:${noCache ? 'nocache' : 'cache'}`
}

async function sourceSignatureForCache(sources: SessionSource[]): Promise<string> {
  const fingerprints = await Promise.all(sources.map(async source => {
    if (source.provider === 'claude') {
      const jsonlFiles = await collectJsonlFiles(source.path)
      return Promise.all(jsonlFiles.map(async filePath => {
        try {
          const meta = await stat(filePath)
          return [
            source.provider,
            source.project,
            filePath,
            filePath,
            String(meta.mtimeMs),
            String(meta.size),
          ].join(':')
        } catch {
          return [source.provider, source.project, filePath, filePath, 'missing'].join(':')
        }
      }))
    }

    const fingerprintPath = source.fingerprintPath ?? source.path
    try {
      const meta = await stat(fingerprintPath)
      return [[
        source.provider,
        source.project,
        source.path,
        fingerprintPath,
        String(meta.mtimeMs),
        String(meta.size),
      ].join(':')]
    } catch {
      return [[source.provider, source.project, source.path, fingerprintPath, 'missing'].join(':')]
    }
  }))

  return fingerprints.flat().sort().join('|')
}

function cachePut(key: string, data: ProjectSummary[], sourceSignature: string) {
  const now = Date.now()
  for (const [k, v] of sessionCache) {
    if (now - v.ts > CACHE_TTL_MS) sessionCache.delete(k)
  }
  if (sessionCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = [...sessionCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0]
    if (oldest) sessionCache.delete(oldest[0])
  }
  sessionCache.set(key, { data, sourceSignature, ts: now })
}

export function filterProjectsByName(
  projects: ProjectSummary[],
  include?: string[],
  exclude?: string[],
): ProjectSummary[] {
  let result = projects
  if (include && include.length > 0) {
    const patterns = include.map(s => s.toLowerCase())
    result = result.filter(p => {
      const name = p.project.toLowerCase()
      const path = p.projectPath.toLowerCase()
      return patterns.some(pat => name.includes(pat) || path.includes(pat))
    })
  }
  if (exclude && exclude.length > 0) {
    const patterns = exclude.map(s => s.toLowerCase())
    result = result.filter(p => {
      const name = p.project.toLowerCase()
      const path = p.projectPath.toLowerCase()
      return !patterns.some(pat => name.includes(pat) || path.includes(pat))
    })
  }
  return result
}

async function parseFreshProviderSource(
  provider: Provider,
  providerName: string,
  source: SessionSource,
  seenKeys: Set<string>,
): Promise<SessionSummary[]> {
  const sessionMap = new Map<string, { project: string; turns: ClassifiedTurn[] }>()
  const parser = provider.createSessionParser(source, seenKeys)

  for await (const call of parser.parse()) {
    const turn = providerCallToTurn(call)
    const classified = classifyTurn(turn)
    const key = `${providerName}:${call.sessionId}:${source.project}`
    const existing = sessionMap.get(key)

    if (existing) {
      existing.turns.push(classified)
    } else {
      sessionMap.set(key, { project: source.project, turns: [classified] })
    }
  }

  return [...sessionMap.entries()].map(([key, value]) => {
    const sessionId = key.split(':')[1] ?? key
    return buildSessionSummary(sessionId, value.project, value.turns)
  })
}

export async function parseAllSessions(
  dateRange?: DateRange,
  providerFilter?: string,
  options: ParseOptions = {},
): Promise<ProjectSummary[]> {
  const key = cacheKey(dateRange, providerFilter, options.noCache === true)
  const allSources = await discoverAllSessions(providerFilter)
  const sourceSignature = await sourceSignatureForCache(allSources)
  const cached = sessionCache.get(key)
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS && cached.sourceSignature === sourceSignature) {
    return cached.data
  }

  const seenMsgIds = new Set<string>()
  const seenKeys = new Set<string>()

  const claudeSources = allSources.filter(s => s.provider === 'claude')
  const nonClaudeSources = allSources.filter(s => s.provider !== 'claude')

  const claudeDirs = claudeSources.map(s => ({ path: s.path, name: s.project }))
  const claudeProjects = await scanClaudeDirsWithCache(claudeDirs, seenMsgIds, dateRange, options)

  const providerGroups = new Map<string, SessionSource[]>()
  for (const source of nonClaudeSources) {
    const existing = providerGroups.get(source.provider) ?? []
    existing.push(source)
    providerGroups.set(source.provider, existing)
  }

  const otherProjects: ProjectSummary[] = []
  for (const [providerName, sources] of providerGroups) {
    const projects = await parseProviderSources(providerName, sources, seenKeys, dateRange, options)
    otherProjects.push(...projects)
  }

  const mergedMap = new Map<string, ProjectSummary>()
  for (const p of [...claudeProjects, ...otherProjects]) {
    const existing = mergedMap.get(p.project)
    if (existing) {
      existing.sessions.push(...p.sessions)
      existing.totalCostUSD += p.totalCostUSD
      existing.totalApiCalls += p.totalApiCalls
    } else {
      mergedMap.set(p.project, { ...p })
    }
  }

  const result = Array.from(mergedMap.values()).sort((a, b) => b.totalCostUSD - a.totalCostUSD)
  cachePut(key, result, sourceSignature)
  return result
}

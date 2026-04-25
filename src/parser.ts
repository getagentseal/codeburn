import { stat } from 'fs/promises'
import { getShortModelName } from './models.js'
import { discoverAllSessions, getProvider } from './providers/index.js'
import type { ParsedProviderCall } from './providers/types.js'
import type {
  ClassifiedTurn,
  DateRange,
  ParsedApiCall,
  ParsedTurn,
  ProjectSummary,
  SessionSummary,
  TokenUsage,
} from './types.js'
import { classifyTurn } from './classifier.js'

function unsanitizePath(dirName: string): string {
  if (dirName.includes('/')) return dirName
  return dirName.replace(/-/g, '/')
}

/// MCP tool naming conventions:
///   - Auggie: "tool_server-mcp" suffix format (e.g., "read_note_workspace-mcp")
const MCP_SUFFIX = '-mcp'

function isMcpTool(tool: string): boolean {
  return tool.endsWith(MCP_SUFFIX)
}

/// Extract the MCP server name from a tool name.
/// - Auggie format: "tool_server-mcp" → "server"
function extractMcpServerName(tool: string): string {
  if (tool.endsWith(MCP_SUFFIX)) {
    // Auggie: tool_server-mcp
    const withoutSuffix = tool.slice(0, -MCP_SUFFIX.length)
    const lastUnderscore = withoutSuffix.lastIndexOf('_')
    if (lastUnderscore > 0) {
      return withoutSuffix.slice(lastUnderscore + 1)
    }
    return withoutSuffix
  }
  return tool
}

function extractMcpTools(tools: string[]): string[] {
  return tools.filter(isMcpTool)
}

function extractCoreTools(tools: string[]): string[] {
  return tools.filter(t => !isMcpTool(t))
}

/// Helper to add nullable numbers with proper null semantics.
/// null + null = null (no data), null + N = N, N + M = N + M
function addNullable(a: number | null | undefined, b: number | null | undefined): number | null {
  if ((a === null || a === undefined) && (b === null || b === undefined)) return null
  return (a ?? 0) + (b ?? 0)
}

// Alias for backwards compat
const addCredits = addNullable

function buildSessionSummary(
  sessionId: string,
  project: string,
  turns: ClassifiedTurn[],
  sessionCreditUsage?: number | null,
  workspaceId?: string,
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
  // Per-call credits summed for fallback (older sessions without sessionCreditUsage)
  let summedCredits: number | null = null
  // Billing aggregates (Token+ mode)
  let totalBaseCostUsd: number | null = null
  let totalSurchargeUsd: number | null = null
  let totalBilledAmountUsd: number | null = null
  let creditsSynthesizedCount = 0
  let billingMode: 'credits' | 'token_plus' | undefined = undefined
  let apiCalls = 0
  let firstTs = ''
  let lastTs = ''

  for (const turn of turns) {
    const turnCost = turn.assistantCalls.reduce((s, c) => s + c.costUSD, 0)

    if (!categoryBreakdown[turn.category]) {
      categoryBreakdown[turn.category] = {
        turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0,
        credits: null, baseCostUsd: null, surchargeUsd: null, billedAmountUsd: null,
      }
    }
    categoryBreakdown[turn.category].turns++
    categoryBreakdown[turn.category].costUSD += turnCost
    if (turn.hasEdits) {
      categoryBreakdown[turn.category].editTurns++
      categoryBreakdown[turn.category].retries += turn.retries
      if (turn.retries === 0) categoryBreakdown[turn.category].oneShotTurns++
    }

    // Aggregate billing fields per category from turn's calls
    for (const call of turn.assistantCalls) {
      const billing = call.billing
      if (billing) {
        categoryBreakdown[turn.category].credits = addNullable(categoryBreakdown[turn.category].credits, billing.creditsAugment)
        categoryBreakdown[turn.category].baseCostUsd = addNullable(categoryBreakdown[turn.category].baseCostUsd, billing.baseCostUsd)
        categoryBreakdown[turn.category].surchargeUsd = addNullable(categoryBreakdown[turn.category].surchargeUsd, billing.surchargeUsd)
        categoryBreakdown[turn.category].billedAmountUsd = addNullable(categoryBreakdown[turn.category].billedAmountUsd, billing.billedAmountUsd)
      }
    }

    for (const call of turn.assistantCalls) {
      totalCost += call.costUSD
      totalInput += call.usage.inputTokens
      totalOutput += call.usage.outputTokens
      totalCacheRead += call.usage.cacheReadInputTokens
      totalCacheWrite += call.usage.cacheCreationInputTokens
      summedCredits = addCredits(summedCredits, call.credits)
      apiCalls++

      // Aggregate billing fields if present
      const billing = call.billing
      if (billing) {
        if (!billingMode) billingMode = billing.mode
        totalBaseCostUsd = addNullable(totalBaseCostUsd, billing.baseCostUsd)
        totalSurchargeUsd = addNullable(totalSurchargeUsd, billing.surchargeUsd)
        totalBilledAmountUsd = addNullable(totalBilledAmountUsd, billing.billedAmountUsd)
        if (billing.synthesized) creditsSynthesizedCount++
      }

      const modelKey = getShortModelName(call.model)
      if (!modelBreakdown[modelKey]) {
        modelBreakdown[modelKey] = {
          calls: 0,
          costUSD: 0,
          credits: null,
          tokens: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0 },
          baseCostUsd: null,
          surchargeUsd: null,
          billedAmountUsd: null,
          creditsSynthesizedCount: 0,
        }
      }
      modelBreakdown[modelKey].calls++
      modelBreakdown[modelKey].costUSD += call.costUSD
      modelBreakdown[modelKey].credits = addCredits(modelBreakdown[modelKey].credits, call.credits)
      modelBreakdown[modelKey].tokens.inputTokens += call.usage.inputTokens
      modelBreakdown[modelKey].tokens.outputTokens += call.usage.outputTokens
      modelBreakdown[modelKey].tokens.cacheReadInputTokens += call.usage.cacheReadInputTokens
      modelBreakdown[modelKey].tokens.cacheCreationInputTokens += call.usage.cacheCreationInputTokens

      // Aggregate billing fields per model
      if (billing) {
        modelBreakdown[modelKey].baseCostUsd = addNullable(modelBreakdown[modelKey].baseCostUsd, billing.baseCostUsd)
        modelBreakdown[modelKey].surchargeUsd = addNullable(modelBreakdown[modelKey].surchargeUsd, billing.surchargeUsd)
        modelBreakdown[modelKey].billedAmountUsd = addNullable(modelBreakdown[modelKey].billedAmountUsd, billing.billedAmountUsd)
        if (billing.synthesized) {
          modelBreakdown[modelKey].creditsSynthesizedCount = (modelBreakdown[modelKey].creditsSynthesizedCount ?? 0) + 1
        }
      }

      for (const tool of extractCoreTools(call.tools)) {
        toolBreakdown[tool] = toolBreakdown[tool] ?? { calls: 0 }
        toolBreakdown[tool].calls++
      }
      for (const mcp of call.mcpTools) {
        const server = extractMcpServerName(mcp)
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

  // sessionCreditUsage is Augment's authoritative session total (already deduped,
  // includes sub-agents); prefer it over per-node summation when present.
  // Older sessions lacking sessionCreditUsage fall back to summedCredits.
  const totalCredits = sessionCreditUsage !== undefined && sessionCreditUsage !== null
    ? sessionCreditUsage
    : summedCredits

  return {
    sessionId,
    project,
    ...(workspaceId ? { workspaceId } : {}),
    firstTimestamp: firstTs || turns[0]?.timestamp || '',
    lastTimestamp: lastTs || turns[turns.length - 1]?.timestamp || '',
    totalCostUSD: totalCost,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    totalCacheReadTokens: totalCacheRead,
    totalCacheWriteTokens: totalCacheWrite,
    totalCredits,
    billingMode,
    totalBaseCostUsd,
    totalSurchargeUsd,
    totalBilledAmountUsd,
    creditsSynthesizedCount,
    apiCalls,
    turns,
    modelBreakdown,
    toolBreakdown,
    mcpBreakdown,
    bashBreakdown,
    categoryBreakdown,
  }
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
    ...(call.workspaceId ? { workspaceId: call.workspaceId } : {}),
    model: call.model,
    usage,
    costUSD: call.costUSD,
    credits: call.credits ?? null,
    billing: call.billing ?? null,
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
  sources: Array<{ path: string; project: string }>,
  seenKeys: Set<string>,
  dateRange?: DateRange,
): Promise<ProjectSummary[]> {
  const provider = await getProvider(providerName)
  if (!provider) return []

  const sessionMap = new Map<string, { sessionId: string; project: string; turns: ClassifiedTurn[]; sessionCreditUsage?: number | null; workspaceId?: string }>()

  for (const source of sources) {
    if (dateRange) {
      try {
        const s = await stat(source.path)
        if (s.mtimeMs < dateRange.start.getTime()) continue
      } catch { /* fall through; treat unknown stat as "may contain data" */ }
    }
    const parser = provider.createSessionParser(
      { path: source.path, project: source.project, provider: providerName },
      seenKeys,
    )

    for await (const call of parser.parse()) {
      if (dateRange) {
        if (!call.timestamp) continue
        const ts = new Date(call.timestamp)
        if (ts < dateRange.start || ts > dateRange.end) continue
      }

      const turn = providerCallToTurn(call)
      const classified = classifyTurn(turn)
      const project = call.project || source.project
      const key = JSON.stringify([providerName, call.sessionId, project, call.workspaceId ?? ''])

      const existing = sessionMap.get(key)
      if (existing) {
        existing.turns.push(classified)
        // Capture sessionCreditUsage if present (first call that has it wins)
        if (call.sessionCreditUsage !== undefined && existing.sessionCreditUsage === undefined) {
          existing.sessionCreditUsage = call.sessionCreditUsage
        }
        if (call.workspaceId && !existing.workspaceId) existing.workspaceId = call.workspaceId
      } else {
        sessionMap.set(key, { sessionId: call.sessionId, project, turns: [classified], sessionCreditUsage: call.sessionCreditUsage, workspaceId: call.workspaceId })
      }
    }
  }

  const projectMap = new Map<string, { sessions: SessionSummary[]; workspaceIds: Set<string> }>()
  for (const { sessionId, project, turns, sessionCreditUsage, workspaceId } of sessionMap.values()) {
    const session = buildSessionSummary(sessionId, project, turns, sessionCreditUsage, workspaceId)
    if (session.apiCalls > 0) {
      const existing = projectMap.get(project) ?? { sessions: [], workspaceIds: new Set<string>() }
      existing.sessions.push(session)
      if (workspaceId) existing.workspaceIds.add(workspaceId)
      projectMap.set(project, existing)
    }
  }

  const projects: ProjectSummary[] = []
  for (const [dirName, { sessions, workspaceIds }] of projectMap) {
    // Aggregate credits: null + null = null, null + N = N, N + M = N + M
    const totalCredits = sessions.reduce<number | null>((acc, sess) => {
      if (acc === null && sess.totalCredits === null) return null
      return (acc ?? 0) + (sess.totalCredits ?? 0)
    }, null)
    projects.push({
      project: dirName,
      projectPath: unsanitizePath(dirName),
      workspaceIds: [...workspaceIds].sort(),
      sessions,
      totalCostUSD: sessions.reduce((s, sess) => s + sess.totalCostUSD, 0),
      totalCredits,
      totalApiCalls: sessions.reduce((s, sess) => s + sess.apiCalls, 0),
    })
  }

  return projects
}

const CACHE_TTL_MS = 60_000
const MAX_CACHE_ENTRIES = 10
const sessionCache = new Map<string, { data: ProjectSummary[]; ts: number }>()

function cacheKey(dateRange?: DateRange): string {
  return dateRange ? `${dateRange.start.getTime()}:${dateRange.end.getTime()}` : 'none'
}

function cachePut(key: string, data: ProjectSummary[]) {
  const now = Date.now()
  for (const [k, v] of sessionCache) {
    if (now - v.ts > CACHE_TTL_MS) sessionCache.delete(k)
  }
  if (sessionCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = [...sessionCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0]
    if (oldest) sessionCache.delete(oldest[0])
  }
  sessionCache.set(key, { data, ts: now })
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
      const labels = searchableProjectLabels(p)
      return patterns.some(pat => labels.some(label => label.includes(pat)))
    })
  }
  if (exclude && exclude.length > 0) {
    const patterns = exclude.map(s => s.toLowerCase())
    result = result.filter(p => {
      const labels = searchableProjectLabels(p)
      return !patterns.some(pat => labels.some(label => label.includes(pat)))
    })
  }
  return result
}

function searchableProjectLabels(project: ProjectSummary): string[] {
  return [
    project.project,
    project.projectPath,
    ...(project.workspaceIds ?? []),
    ...project.sessions.map(session => session.workspaceId).filter((id): id is string => Boolean(id)),
  ].map(label => label.toLowerCase())
}

export async function parseAllSessions(dateRange?: DateRange): Promise<ProjectSummary[]> {
  const key = cacheKey(dateRange)
  const cached = sessionCache.get(key)
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data

  const seenKeys = new Set<string>()
  const allSources = await discoverAllSessions()

  const providerGroups = new Map<string, Array<{ path: string; project: string }>>()
  for (const source of allSources) {
    const existing = providerGroups.get(source.provider) ?? []
    existing.push({ path: source.path, project: source.project })
    providerGroups.set(source.provider, existing)
  }

  const allProjects: ProjectSummary[] = []
  for (const [providerName, sources] of providerGroups) {
    const projects = await parseProviderSources(providerName, sources, seenKeys, dateRange)
    allProjects.push(...projects)
  }

  const mergedMap = new Map<string, ProjectSummary>()
  for (const p of allProjects) {
    const existing = mergedMap.get(p.project)
    if (existing) {
      existing.sessions.push(...p.sessions)
      existing.workspaceIds = [...new Set([...(existing.workspaceIds ?? []), ...(p.workspaceIds ?? [])])].sort()
      existing.totalCostUSD += p.totalCostUSD
      // Merge credits: null + null = null, null + N = N, N + M = N + M
      if (existing.totalCredits === null && p.totalCredits === null) {
        // Both null, keep null
      } else {
        existing.totalCredits = (existing.totalCredits ?? 0) + (p.totalCredits ?? 0)
      }
      existing.totalApiCalls += p.totalApiCalls
    } else {
      mergedMap.set(p.project, { ...p })
    }
  }

  const result = Array.from(mergedMap.values()).sort((a, b) => b.totalCostUSD - a.totalCostUSD)
  cachePut(key, result)
  return result
}

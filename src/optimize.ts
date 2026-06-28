import type { DateRange, ProjectSummary } from './types.js'
import { scanSessions } from './optimize/scan.js'
import {
  aggregateMcpCoverage,
  detectMcpToolCoverage,
  detectUnusedMcp,
} from './optimize/detectors-mcp.js'
import {
  detectCacheBloat,
  detectLowReadEditRatio,
  detectJunkReads,
  detectDuplicateReads,
  detectBloatedClaudeMd,
} from './optimize/detectors-reads.js'
import {
  detectGhostAgents,
  detectGhostSkills,
  detectGhostCommands,
  detectBashBloat,
} from './optimize/detectors-ghosts.js'
import {
  findLowWorthCandidates,
  detectLowWorthSessions,
  findContextBloatCandidates,
  detectContextBloat,
  detectSessionOutliers,
} from './optimize/detectors-sessions.js'
import {
  computeHealth,
  urgencyScore,
  computeInputCostRate,
} from './optimize/health.js'
import { renderOptimize } from './optimize/render.js'
import { RESULT_CACHE_TTL_MS } from './optimize/constants.js'
import type { OptimizeResult, WasteFinding, CacheEntry } from './optimize/types.js'
import chalk from 'chalk'

// ============================================================================
// Barrel re-exports — keep the public API of './optimize.js' unchanged after
// the split into ./optimize/* modules.
// ============================================================================

export * from './optimize/types.js'
export * from './optimize/scan.js'
export * from './optimize/detectors-reads.js'
export * from './optimize/detectors-mcp.js'
export * from './optimize/detectors-ghosts.js'
export * from './optimize/detectors-sessions.js'
export * from './optimize/health.js'

// ============================================================================
// Main entry points
// ============================================================================

const resultCache = new Map<string, CacheEntry>()

function cacheKey(projects: ProjectSummary[], dateRange: DateRange | undefined): string {
  const dr = dateRange ? `${dateRange.start.getTime()}-${dateRange.end.getTime()}` : 'all'
  const fingerprint = projects.length + ':' + projects.reduce((s, p) => s + p.totalApiCalls, 0)
  return `${dr}:${fingerprint}`
}

export async function scanAndDetect(
  projects: ProjectSummary[],
  dateRange?: DateRange,
): Promise<OptimizeResult> {
  if (projects.length === 0) {
    return { findings: [], costRate: 0, healthScore: 100, healthGrade: 'A' }
  }

  const key = cacheKey(projects, dateRange)
  const cached = resultCache.get(key)
  if (cached && Date.now() - cached.ts < RESULT_CACHE_TTL_MS) return cached.data

  const costRate = computeInputCostRate(projects)
  const { toolCalls, projectCwds, apiCalls, userMessages } = await scanSessions(dateRange)
  const mcpCoverage = aggregateMcpCoverage(projects)

  const findings: WasteFinding[] = []
  // Priority order for the per-session findings: low-worth → context-bloat →
  // outliers. Each later detector excludes sessions already named by an
  // earlier one so a single session is not listed in three findings.
  const lowWorthSessionIds = new Set(findLowWorthCandidates(projects).map(c => c.sessionId))
  const contextBloatVisibleIds = new Set(
    findContextBloatCandidates(projects)
      .filter(c => !lowWorthSessionIds.has(c.sessionId))
      .map(c => c.sessionId),
  )
  const outlierExclusions = new Set([...lowWorthSessionIds, ...contextBloatVisibleIds])
  const syncDetectors: Array<() => WasteFinding | null> = [
    () => detectCacheBloat(apiCalls, projects, dateRange),
    () => detectLowReadEditRatio(toolCalls),
    () => detectJunkReads(toolCalls, dateRange),
    () => detectDuplicateReads(toolCalls, dateRange),
    () => detectUnusedMcp(toolCalls, projects, projectCwds, mcpCoverage),
    () => detectMcpToolCoverage(projects, mcpCoverage),
    () => detectLowWorthSessions(projects),
    () => detectContextBloat(projects, lowWorthSessionIds),
    () => detectSessionOutliers(projects, outlierExclusions),
    () => detectBloatedClaudeMd(projectCwds),
    () => detectBashBloat(),
  ]
  for (const detect of syncDetectors) {
    const finding = detect()
    if (finding) findings.push(finding)
  }

  const ghostResults = await Promise.all([
    detectGhostAgents(toolCalls),
    detectGhostSkills(toolCalls),
    detectGhostCommands(userMessages),
  ])
  for (const f of ghostResults) if (f) findings.push(f)

  findings.sort((a, b) => urgencyScore(b) - urgencyScore(a))
  const { score, grade } = computeHealth(findings)
  const result: OptimizeResult = { findings, costRate, healthScore: score, healthGrade: grade }
  resultCache.set(key, { data: result, ts: Date.now() })
  return result
}

export async function runOptimize(
  projects: ProjectSummary[],
  periodLabel: string,
  dateRange?: DateRange,
): Promise<void> {
  if (projects.length === 0) {
    console.log(chalk.dim('\n  No usage data found for this period.\n'))
    return
  }

  process.stderr.write(chalk.dim('  Analyzing your sessions...\n'))

  const { findings, costRate, healthScore, healthGrade } = await scanAndDetect(projects, dateRange)
  const sessions = projects.flatMap(p => p.sessions)
  const periodCost = projects.reduce((s, p) => s + p.totalCostUSD, 0)
  const callCount = projects.reduce((s, p) => s + p.totalApiCalls, 0)

  const output = renderOptimize(findings, costRate, periodLabel, periodCost, sessions.length, callCount, healthScore, healthGrade)
  console.log(output)
}

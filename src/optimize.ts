import chalk from 'chalk'
import { readdir, stat } from 'fs/promises'
import { existsSync, statSync } from 'fs'
import { basename, join } from 'path'
import { homedir } from 'os'

import { readSessionLines, readSessionFileSync } from './fs-utils.js'
import { discoverAllSessions } from './providers/index.js'
import type { DateRange, ProjectSummary } from './types.js'
import { formatCost } from './currency.js'
import { formatTokens } from './format.js'

// ============================================================================
// Display constants
// ============================================================================

const ORANGE = '#FF8C42'
const DIM = '#666666'
const GOLD = '#FFD700'
const CYAN = '#5BF5E0'
const GREEN = '#5BF5A0'
const RED = '#F55B5B'

// ============================================================================
// Token estimation constants
// ============================================================================

const AVG_TOKENS_PER_READ = 600
const TOKENS_PER_MCP_TOOL = 400
const TOOLS_PER_MCP_SERVER = 5
const TOKENS_PER_AGENT_DEF = 80
const TOKENS_PER_SKILL_DEF = 80
const TOKENS_PER_COMMAND_DEF = 60
const CLAUDEMD_TOKENS_PER_LINE = 13
const BASH_TOKENS_PER_CHAR = 0.25

// ============================================================================
// Detector thresholds
// ============================================================================

const CLAUDEMD_HEALTHY_LINES = 200
const CLAUDEMD_HIGH_THRESHOLD_LINES = 400
const MIN_JUNK_READS_TO_FLAG = 3
const JUNK_READS_HIGH_THRESHOLD = 20
const JUNK_READS_MEDIUM_THRESHOLD = 5
const MIN_DUPLICATE_READS_TO_FLAG = 5
const DUPLICATE_READS_HIGH_THRESHOLD = 30
const DUPLICATE_READS_MEDIUM_THRESHOLD = 10
const MIN_EDITS_FOR_RATIO = 10
const HEALTHY_READ_EDIT_RATIO = 4
const LOW_RATIO_HIGH_THRESHOLD = 2
const LOW_RATIO_MEDIUM_THRESHOLD = 3
const MIN_API_CALLS_FOR_CACHE = 10
const CACHE_EXCESS_HIGH_THRESHOLD = 15000
const UNUSED_MCP_HIGH_THRESHOLD = 3
// MCP tool coverage detector thresholds. A server only earns a finding when
// every condition holds: the inventory is large enough to matter, real-world
// usage is poor, and we observed it in enough sessions to trust the signal.
const MCP_COVERAGE_MIN_TOOLS = 10
const MCP_COVERAGE_MIN_SESSIONS = 2
const MCP_COVERAGE_LOW_THRESHOLD = 0.20
const MCP_COVERAGE_HIGH_IMPACT_TOKENS = 200_000
// Anthropic prices cache writes at 125% of base input and cache reads at
// roughly 10% of base input. We use these to keep overhead estimates honest:
// most MCP schema bytes live in the cached prefix and only get charged at
// the discount rate after the first turn of a session.
const CACHE_WRITE_MULTIPLIER = 1.25
const CACHE_READ_DISCOUNT = 0.10
const GHOST_AGENTS_HIGH_THRESHOLD = 5
const GHOST_AGENTS_MEDIUM_THRESHOLD = 2
const GHOST_SKILLS_HIGH_THRESHOLD = 10
const GHOST_SKILLS_MEDIUM_THRESHOLD = 5
const GHOST_COMMANDS_MEDIUM_THRESHOLD = 10
const MCP_NEW_CONFIG_GRACE_MS = 24 * 60 * 60 * 1000
const BASH_DEFAULT_LIMIT = 30000
const BASH_RECOMMENDED_LIMIT = 15000
const MIN_SESSIONS_FOR_OUTLIER = 3
const SESSION_OUTLIER_MULTIPLIER = 2
const MIN_SESSION_OUTLIER_COST_USD = 1
const SESSION_OUTLIER_PREVIEW = 5
const CONTEXT_BLOAT_MIN_INPUT_TOKENS = 75_000
const CONTEXT_BLOAT_MIN_RATIO = 25
const CONTEXT_BLOAT_TARGET_RATIO = 15
const CONTEXT_BLOAT_PREVIEW = 5
const CONTEXT_BLOAT_LOW_INPUT_TOKENS = 200_000
const CONTEXT_BLOAT_HIGH_INPUT_TOKENS = 500_000
const CONTEXT_BLOAT_LOW_MAX_CANDIDATES = 2
const CONTEXT_BLOAT_HIGH_MIN_CANDIDATES = 10
const CONTEXT_BLOAT_GROWTH_RATIO = 2
const CONTEXT_BLOAT_GROWTH_MAX_GAP_MS = 7 * 24 * 60 * 60 * 1000
const CONTEXT_BLOAT_RATIO_DISPLAY_CAP = 1000
const WORTH_IT_MIN_COST_USD = 2
const WORTH_IT_NO_EDIT_MIN_COST_USD = 3
const WORTH_IT_MIN_RETRIES = 3
const WORTH_IT_RETRY_WITH_EDIT_MIN_RETRIES = 2
const WORTH_IT_PREVIEW = 5
const WORTH_IT_LOW_MAX_CANDIDATES = 2
const WORTH_IT_LOW_MAX_TOTAL_COST_USD = 10
const WORTH_IT_HIGH_MIN_CANDIDATES = 10
const WORTH_IT_HIGH_TOTAL_COST_USD = 50

// ============================================================================
// Scoring constants
// ============================================================================

const HEALTH_WEIGHT_HIGH = 15
const HEALTH_WEIGHT_MEDIUM = 7
const HEALTH_WEIGHT_LOW = 3
const HEALTH_MAX_PENALTY = 80
const GRADE_A_MIN = 90
const GRADE_B_MIN = 75
const GRADE_C_MIN = 55
const GRADE_D_MIN = 30
// Rebalanced so a high-impact finding with zero observed tokens (e.g.
// detectGhostAgents firing on five files but tokensSaved=400) cannot
// outrank a medium-impact finding with many millions of tokens.
// Old: 0.7/0.3 → high+0 = 0.70, medium+1B = 0.65 (high+0 won).
// New: 0.5/0.5 → high+0 = 0.50, medium+1B = 0.75 (medium+1B wins).
// Token normalize lifted to 5M so the rank scales over a realistic range.
const URGENCY_IMPACT_WEIGHT = 0.5
const URGENCY_TOKEN_WEIGHT = 0.5
const URGENCY_TOKEN_NORMALIZE = 5_000_000

// ============================================================================
// File system constants
// ============================================================================

const MAX_IMPORT_DEPTH = 5
const IMPORT_PATTERN = /^@(\.\.?\/[^\s]+|\/[^\s]+)/gm
const COMMAND_PATTERN = /<command-name>([^<]+)<\/command-name>|(?:^|\s)\/([a-zA-Z][\w-]*)/gm

const JUNK_DIRS = [
  'node_modules', '.git', 'dist', 'build', '__pycache__', '.next',
  '.nuxt', '.output', 'coverage', '.cache', '.tsbuildinfo',
  '.venv', 'venv', '.svn', '.hg',
]
const JUNK_PATTERN = new RegExp(`/(?:${JUNK_DIRS.join('|')})/`)

const SHELL_PROFILES = ['.zshrc', '.bashrc', '.bash_profile', '.profile']

const TOP_ITEMS_PREVIEW = 3
const GHOST_NAMES_PREVIEW = 5
const GHOST_CLEANUP_COMMANDS_LIMIT = 10

// ============================================================================
// Types
// ============================================================================

export type Impact = 'high' | 'medium' | 'low'
export type HealthGrade = 'A' | 'B' | 'C' | 'D' | 'F'

export type WasteAction =
  | { type: 'paste'; label: string; text: string }
  | { type: 'command'; label: string; text: string }
  | { type: 'file-content'; label: string; path: string; content: string }

export type Trend = 'active' | 'improving'

export type WasteFinding = {
  title: string
  explanation: string
  impact: Impact
  tokensSaved: number
  fix: WasteAction
  trend?: Trend
}

export type OptimizeResult = {
  findings: WasteFinding[]
  costRate: number
  healthScore: number
  healthGrade: HealthGrade
}

export type ToolCall = {
  name: string
  input: Record<string, unknown>
  sessionId: string
  project: string
  recent?: boolean
}

export type ApiCallMeta = {
  cacheCreationTokens: number
  version: string
  recent?: boolean
}

type ScanData = {
  toolCalls: ToolCall[]
  projectCwds: Set<string>
  apiCalls: ApiCallMeta[]
  userMessages: string[]
}

// ============================================================================
// JSONL scanner
// ============================================================================

const FILE_READ_CONCURRENCY = 16
const RESULT_CACHE_TTL_MS = 60_000
const RECENT_WINDOW_HOURS = 48
const RECENT_WINDOW_MS = RECENT_WINDOW_HOURS * 60 * 60 * 1000
const DEFAULT_TREND_PERIOD_DAYS = 30
const DEFAULT_TREND_PERIOD_MS = DEFAULT_TREND_PERIOD_DAYS * 24 * 60 * 60 * 1000
const IMPROVING_THRESHOLD = 0.5

async function collectJsonlFiles(dirPath: string): Promise<string[]> {
  const files = await readdir(dirPath).catch(() => [])
  const result = files.filter(f => f.endsWith('.jsonl')).map(f => join(dirPath, f))
  for (const entry of files) {
    if (entry.endsWith('.jsonl')) continue
    const subPath = join(dirPath, entry, 'subagents')
    const subFiles = await readdir(subPath).catch(() => [])
    for (const sf of subFiles) {
      if (sf.endsWith('.jsonl')) result.push(join(subPath, sf))
    }
  }
  return result
}

async function isFileStaleForRange(filePath: string, range: DateRange | undefined): Promise<boolean> {
  if (!range) return false
  try {
    const s = await stat(filePath)
    return s.mtimeMs < range.start.getTime()
  } catch { return false }
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let idx = 0
  async function next(): Promise<void> {
    while (idx < items.length) {
      const current = idx++
      await worker(items[current])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => next()))
}

type ScanFileResult = {
  calls: ToolCall[]
  cwds: string[]
  apiCalls: ApiCallMeta[]
  userMessages: string[]
}

function inRange(timestamp: string | undefined, range: DateRange | undefined): boolean {
  if (!range) return true
  if (!timestamp) return false
  const ts = new Date(timestamp)
  return ts >= range.start && ts <= range.end
}

function isRecent(timestamp: string | undefined, cutoff: number): boolean {
  if (!timestamp) return false
  return new Date(timestamp).getTime() >= cutoff
}

export async function scanJsonlFile(
  filePath: string,
  project: string,
  dateRange: DateRange | undefined,
  recentCutoffMs = Date.now() - RECENT_WINDOW_MS,
): Promise<ScanFileResult> {
  const calls: ToolCall[] = []
  const cwds: string[] = []
  const apiCalls: ApiCallMeta[] = []
  const userMessages: string[] = []
  const sessionId = basename(filePath, '.jsonl')
  let lastVersion = ''

  for await (const line of readSessionLines(filePath)) {
    if (!line.trim()) continue
    let entry: Record<string, unknown>
    try { entry = JSON.parse(line) } catch { continue }

    if (entry.version && typeof entry.version === 'string') lastVersion = entry.version

    const ts = typeof entry.timestamp === 'string' ? entry.timestamp : undefined
    const withinRange = inRange(ts, dateRange)
    const recent = isRecent(ts, recentCutoffMs)

    if (entry.cwd && typeof entry.cwd === 'string' && withinRange) cwds.push(entry.cwd)

    if (entry.type === 'user') {
      if (!withinRange) continue
      const msg = entry.message as Record<string, unknown> | undefined
      const msgContent = msg?.content
      if (typeof msgContent === 'string') {
        userMessages.push(msgContent)
      } else if (Array.isArray(msgContent)) {
        for (const block of msgContent) {
          if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
            userMessages.push(block.text)
          }
        }
      }
      continue
    }

    if (entry.type !== 'assistant') continue
    if (!withinRange) continue

    const msg = entry.message as Record<string, unknown> | undefined
    const usage = msg?.usage as Record<string, unknown> | undefined
    if (usage) {
      const cacheCreate = (usage.cache_creation_input_tokens as number) ?? 0
      if (cacheCreate > 0) apiCalls.push({ cacheCreationTokens: cacheCreate, version: lastVersion, recent })
    }

    const blocks = msg?.content
    if (!Array.isArray(blocks)) continue

    for (const block of blocks) {
      if (block.type !== 'tool_use') continue
      calls.push({
        name: block.name as string,
        input: (block.input as Record<string, unknown>) ?? {},
        sessionId,
        project,
        recent,
      })
    }
  }

  return { calls, cwds, apiCalls, userMessages }
}

async function scanSessions(dateRange?: DateRange): Promise<ScanData> {
  const sources = await discoverAllSessions('claude')
  const allCalls: ToolCall[] = []
  const allCwds = new Set<string>()
  const allApiCalls: ApiCallMeta[] = []
  const allUserMessages: string[] = []

  const tasks: Array<{ file: string; project: string }> = []
  for (const source of sources) {
    const files = await collectJsonlFiles(source.path)
    for (const file of files) {
      if (await isFileStaleForRange(file, dateRange)) continue
      tasks.push({ file, project: source.project })
    }
  }

  await runWithConcurrency(tasks, FILE_READ_CONCURRENCY, async ({ file, project }) => {
    const { calls, cwds, apiCalls, userMessages } = await scanJsonlFile(file, project, dateRange)
    allCalls.push(...calls)
    for (const cwd of cwds) allCwds.add(cwd)
    allApiCalls.push(...apiCalls)
    allUserMessages.push(...userMessages)
  })

  return { toolCalls: allCalls, projectCwds: allCwds, apiCalls: allApiCalls, userMessages: allUserMessages }
}

// ============================================================================
// Shared helpers
// ============================================================================

function readJsonFile(path: string): Record<string, unknown> | null {
  const raw = readSessionFileSync(path)
  if (raw === null) return null
  try { return JSON.parse(raw) } catch { return null }
}

function shortHomePath(absPath: string): string {
  const home = homedir()
  return absPath.startsWith(home) ? '~' + absPath.slice(home.length) : absPath
}

function isReadTool(name: string): boolean {
  return name === 'Read' || name === 'FileReadTool'
}

type McpConfigEntry = { normalized: string; original: string; mtime: number }

export function loadMcpConfigs(projectCwds: Iterable<string>): Map<string, McpConfigEntry> {
  const servers = new Map<string, McpConfigEntry>()
  const configPaths = [
    join(homedir(), '.claude', 'settings.json'),
    join(homedir(), '.claude', 'settings.local.json'),
  ]
  for (const cwd of projectCwds) {
    configPaths.push(join(cwd, '.mcp.json'))
    configPaths.push(join(cwd, '.claude', 'settings.json'))
    configPaths.push(join(cwd, '.claude', 'settings.local.json'))
  }

  for (const p of configPaths) {
    if (!existsSync(p)) continue
    const config = readJsonFile(p)
    if (!config) continue
    let mtime = 0
    try { mtime = statSync(p).mtimeMs } catch {}
    const serversObj = (config.mcpServers ?? {}) as Record<string, unknown>
    for (const name of Object.keys(serversObj)) {
      const normalized = name.replace(/:/g, '_')
      const existing = servers.get(normalized)
      if (!existing || existing.mtime < mtime) {
        servers.set(normalized, { normalized, original: name, mtime })
      }
    }
  }
  return servers
}

// ============================================================================
// Detectors
// ============================================================================

export function detectJunkReads(calls: ToolCall[], dateRange?: DateRange): WasteFinding | null {
  const dirCounts = new Map<string, number>()
  let totalJunkReads = 0
  let recentJunkReads = 0

  for (const call of calls) {
    if (!isReadTool(call.name)) continue
    const filePath = call.input.file_path as string | undefined
    if (!filePath || !JUNK_PATTERN.test(filePath)) continue
    totalJunkReads++
    if (call.recent) recentJunkReads++
    for (const dir of JUNK_DIRS) {
      if (filePath.includes(`/${dir}/`)) {
        dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1)
        break
      }
    }
  }

  if (totalJunkReads < MIN_JUNK_READS_TO_FLAG) return null

  const hasRecentActivity = calls.some(c => c.recent)
  const trend = sessionTrend(recentJunkReads, totalJunkReads, dateRange, hasRecentActivity)
  if (trend === 'resolved') return null

  const sorted = [...dirCounts.entries()].sort((a, b) => b[1] - a[1])
  const dirList = sorted.slice(0, TOP_ITEMS_PREVIEW).map(([d, n]) => `${d}/ (${n}x)`).join(', ')
  const tokensSaved = totalJunkReads * AVG_TOKENS_PER_READ

  const detected = sorted.map(([d]) => d)
  const commonDefaults = ['node_modules', '.git', 'dist', '__pycache__']
  const extras = commonDefaults.filter(d => !dirCounts.has(d)).slice(0, Math.max(0, 6 - detected.length))
  const dirsToAvoid = [...detected, ...extras].join(', ')

  return {
    title: 'Claude is reading build/dependency folders',
    explanation: `Claude read into ${dirList} (${totalJunkReads} reads). These are generated or dependency directories, not your code. Tell Claude in CLAUDE.md to avoid them.`,
    impact: totalJunkReads > JUNK_READS_HIGH_THRESHOLD ? 'high' : totalJunkReads > JUNK_READS_MEDIUM_THRESHOLD ? 'medium' : 'low',
    tokensSaved,
    fix: {
      type: 'paste',
      label: 'Append to your project CLAUDE.md:',
      text: `Do not read or search files under these directories unless I explicitly ask: ${dirsToAvoid}.`,
    },
    trend,
  }
}

export function detectDuplicateReads(calls: ToolCall[], dateRange?: DateRange): WasteFinding | null {
  const sessionFiles = new Map<string, Map<string, { count: number; recent: number }>>()

  for (const call of calls) {
    if (!isReadTool(call.name)) continue
    const filePath = call.input.file_path as string | undefined
    if (!filePath || JUNK_PATTERN.test(filePath)) continue
    const key = `${call.project}:${call.sessionId}`
    if (!sessionFiles.has(key)) sessionFiles.set(key, new Map())
    const fm = sessionFiles.get(key)!
    const entry = fm.get(filePath) ?? { count: 0, recent: 0 }
    entry.count++
    if (call.recent) entry.recent++
    fm.set(filePath, entry)
  }

  let totalDuplicates = 0
  let recentDuplicates = 0
  const fileDupes = new Map<string, number>()

  for (const fm of sessionFiles.values()) {
    for (const [file, entry] of fm) {
      if (entry.count <= 1) continue
      const extra = entry.count - 1
      totalDuplicates += extra
      if (entry.recent > 1) recentDuplicates += entry.recent - 1
      const name = basename(file)
      fileDupes.set(name, (fileDupes.get(name) ?? 0) + extra)
    }
  }

  if (totalDuplicates < MIN_DUPLICATE_READS_TO_FLAG) return null

  const hasRecentActivity = calls.some(c => c.recent)
  const trend = sessionTrend(recentDuplicates, totalDuplicates, dateRange, hasRecentActivity)
  if (trend === 'resolved') return null

  const worst = [...fileDupes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_ITEMS_PREVIEW)
    .map(([name, n]) => `${name} (${n + 1}x)`)
    .join(', ')

  const tokensSaved = totalDuplicates * AVG_TOKENS_PER_READ

  return {
    title: 'Claude is re-reading the same files',
    explanation: `${totalDuplicates} redundant re-reads across sessions. Top repeats: ${worst}. Each re-read loads the same content into context again.`,
    impact: totalDuplicates > DUPLICATE_READS_HIGH_THRESHOLD ? 'high' : totalDuplicates > DUPLICATE_READS_MEDIUM_THRESHOLD ? 'medium' : 'low',
    tokensSaved,
    fix: {
      type: 'paste',
      label: 'Point Claude at exact locations in your prompt, for example:',
      text: 'In <file> lines <start>-<end>, look at the <function> function.',
    },
    trend,
  }
}

/**
 * Per-server breakdown of MCP tool inventory vs invocations, computed from the
 * `mcpInventory` field captured by the Claude parser.
 *
 * Each session that loaded a server contributes its observed tool list to
 * the union for that server. Invocations come from the existing
 * `mcpBreakdown` per-call counts plus the parser's `call.tools` stream.
 */
export type McpServerCoverage = {
  server: string
  toolsAvailable: number
  toolsInvoked: number
  unusedTools: string[]
  invocations: number
  loadedSessions: number
  coverageRatio: number
}

type McpSchemaCostEstimate = {
  cacheWriteTokens: number
  cacheReadTokens: number
  effectiveInputTokens: number
}

/**
 * Aggregate MCP inventory and invocations across the projects in scope.
 *
 * Returns one entry per `mcp__<server>__*` namespace observed in any
 * session's `mcpInventory`. Counts of invocations come from
 * `session.mcpBreakdown` (per-server call totals already maintained by the
 * parser).
 */
export function aggregateMcpCoverage(projects: ProjectSummary[]): McpServerCoverage[] {
  type ServerAcc = {
    inventory: Set<string>
    invokedTools: Set<string>
    invocations: number
    loadedSessions: number
  }
  const servers = new Map<string, ServerAcc>()

  function getOrInit(server: string): ServerAcc {
    let acc = servers.get(server)
    if (!acc) {
      acc = { inventory: new Set(), invokedTools: new Set(), invocations: 0, loadedSessions: 0 }
      servers.set(server, acc)
    }
    return acc
  }

  for (const project of projects) {
    for (const session of project.sessions) {
      // Only sessions with an observed inventory count toward `loadedSessions`.
      // Pure invocation-only sessions (server seen via `call.mcpTools` or
      // `session.mcpBreakdown` without any matching `deferred_tools_delta`)
      // could otherwise satisfy the `MCP_COVERAGE_MIN_SESSIONS` threshold
      // without giving us evidence that the schema was actually loaded.
      const inventoriedServers = new Set<string>()
      const sessionInvoked = new Map<string, Set<string>>()

      // Inventory: union of tools observed available in this session.
      for (const fqn of session.mcpInventory ?? []) {
        const parts = fqn.split('__')
        if (parts.length < 3 || parts[0] !== 'mcp') continue
        const server = parts[1]
        if (!server) continue
        const tool = parts.slice(2).join('__')
        if (!tool) continue
        const acc = getOrInit(server)
        acc.inventory.add(fqn)
        inventoriedServers.add(server)
      }

      // Invoked tools: walk turns to collect per-tool invocations. We can't
      // get this from session.mcpBreakdown alone because that's keyed by
      // server, not tool.
      for (const turn of session.turns) {
        for (const call of turn.assistantCalls) {
          for (const fqn of call.mcpTools) {
            const parts = fqn.split('__')
            if (parts.length < 3 || parts[0] !== 'mcp') continue
            const server = parts[1]
            if (!server) continue
            let invoked = sessionInvoked.get(server)
            if (!invoked) {
              invoked = new Set()
              sessionInvoked.set(server, invoked)
            }
            invoked.add(fqn)
          }
        }
      }

      // Invocation totals: trust mcpBreakdown which was already aggregated
      // turn-by-turn, including any invocations the inventory pass missed.
      for (const [server, data] of Object.entries(session.mcpBreakdown)) {
        const acc = getOrInit(server)
        acc.invocations += data.calls
      }

      for (const [server, invoked] of sessionInvoked) {
        const acc = getOrInit(server)
        for (const fqn of invoked) acc.invokedTools.add(fqn)
      }

      for (const server of inventoriedServers) {
        getOrInit(server).loadedSessions += 1
      }
    }
  }

  const result: McpServerCoverage[] = []
  for (const [server, acc] of servers) {
    if (acc.inventory.size === 0) continue
    // Coverage is only meaningful against tools we actually observed in the
    // inventory: invocations of tools never inventoried (older config, typo,
    // etc.) would otherwise inflate the numerator and could even drive
    // `unusedCount` negative.
    const invokedInInventory = new Set<string>()
    for (const fqn of acc.invokedTools) {
      if (acc.inventory.has(fqn)) invokedInInventory.add(fqn)
    }
    const unusedTools = Array.from(acc.inventory).filter(t => !invokedInInventory.has(t)).sort()
    const toolsInvoked = acc.inventory.size - unusedTools.length
    result.push({
      server,
      toolsAvailable: acc.inventory.size,
      toolsInvoked,
      unusedTools,
      invocations: acc.invocations,
      loadedSessions: acc.loadedSessions,
      coverageRatio: acc.inventory.size === 0 ? 0 : toolsInvoked / acc.inventory.size,
    })
  }
  result.sort((a, b) => b.toolsAvailable - a.toolsAvailable)
  return result
}

/**
 * Cache-aware token cost estimate for the unused-tool overhead of one or
 * more servers, summed across all sessions that loaded any of them.
 *
 * Returns three buckets:
 * - `cacheWriteTokens`: schema bytes paid at full input price (each
 *    cache-creation event in a session that loaded one of the servers).
 * - `cacheReadTokens`: schema bytes carried at the cache-read discount on
 *    subsequent turns (ongoing overhead).
 * - `effectiveInputTokens`: equivalent fresh-input tokens, weighted by
 *    cache pricing. Used to estimate dollar cost downstream by multiplying
 *    by the project's input rate.
 *
 * We cap each call's contribution at the observed cache-creation /
 * cache-read totals for that call: it is not meaningful to claim more MCP
 * overhead than the call's own cache bucket could possibly contain. The
 * cap is applied once across the combined unused-schema budget for all
 * flagged servers, not per server, so two flagged servers cannot both
 * independently claim the same call's cache bucket.
 *
 * Anthropic caches expire after roughly 5 minutes of inactivity, so a long
 * session can rebuild the cache multiple times. Every call that reports
 * `cacheCreationInputTokens > 0` is treated as another rebuild, not just
 * the very first one.
 *
 * "Loaded" is defined exclusively by observed inventory: a session that
 * invoked a server without ever emitting a `deferred_tools_delta` for it
 * does not count, matching the invariant `aggregateMcpCoverage` uses for
 * `loadedSessions`.
 */
export function estimateMcpSchemaCost(
  unusedToolCount: number,
  projects: ProjectSummary[],
  server: string,
): McpSchemaCostEstimate
export function estimateMcpSchemaCost(
  unusedToolCountsByServer: Record<string, number>,
  projects: ProjectSummary[],
  servers: string[],
): McpSchemaCostEstimate
export function estimateMcpSchemaCost(
  unusedToolCounts: Record<string, number> | number,
  projects: ProjectSummary[],
  serverOrServers: string | string[],
): McpSchemaCostEstimate {
  let servers: string[]
  let counts: Record<string, number>
  if (typeof unusedToolCounts === 'number') {
    if (typeof serverOrServers !== 'string') {
      throw new TypeError('single-server MCP cost estimates require a string server name')
    }
    servers = [serverOrServers]
    counts = { [serverOrServers]: unusedToolCounts }
  } else {
    if (!Array.isArray(serverOrServers)) {
      throw new TypeError('multi-server MCP cost estimates require a string[] server list')
    }
    servers = serverOrServers
    counts = unusedToolCounts
  }

  const totalUnusedSchemaTokens = servers.reduce(
    (s, srv) => s + (counts[srv] ?? 0) * TOKENS_PER_MCP_TOOL,
    0,
  )
  if (totalUnusedSchemaTokens === 0) {
    return { cacheWriteTokens: 0, cacheReadTokens: 0, effectiveInputTokens: 0 }
  }

  const serverSet = new Set(servers)
  let cacheWriteTokens = 0
  let cacheReadTokens = 0

  for (const project of projects) {
    for (const session of project.sessions) {
      // A session counts only if its observed inventory included at least
      // one of the flagged servers — same invariant `aggregateMcpCoverage`
      // uses for `loadedSessions`.
      let loaded = false
      for (const fqn of session.mcpInventory ?? []) {
        const seg = fqn.split('__')[1]
        if (seg && serverSet.has(seg)) { loaded = true; break }
      }
      if (!loaded) continue

      for (const turn of session.turns) {
        for (const call of turn.assistantCalls) {
          // Both buckets can be non-zero on the same call (cache rebuild
          // alongside a partial read), so account for them independently.
          // The cap is applied to the combined unused-schema budget so
          // multiple flagged servers cannot all claim the same call.
          if (call.usage.cacheCreationInputTokens > 0) {
            cacheWriteTokens += Math.min(totalUnusedSchemaTokens, call.usage.cacheCreationInputTokens)
          }
          if (call.usage.cacheReadInputTokens > 0) {
            cacheReadTokens += Math.min(totalUnusedSchemaTokens, call.usage.cacheReadInputTokens)
          }
        }
      }
    }
  }

  const effectiveInputTokens = cacheWriteTokens * CACHE_WRITE_MULTIPLIER + cacheReadTokens * CACHE_READ_DISCOUNT
  return { cacheWriteTokens, cacheReadTokens, effectiveInputTokens }
}

/**
 * Find MCP servers whose tool inventory is largely unused. Replaces the
 * older server-only `detectUnusedMcp` (which only flagged servers with
 * literal zero invocations).
 *
 * A server is flagged when, taken together:
 *   - it exposed more than `MCP_COVERAGE_MIN_TOOLS` tools,
 *   - we saw it loaded in at least `MCP_COVERAGE_MIN_SESSIONS` sessions,
 *   - the coverage ratio is below `MCP_COVERAGE_LOW_THRESHOLD`.
 *
 * Token-savings estimates use the cache-aware accounting from
 * `estimateMcpSchemaCost` so we don't mistake cached-prefix carry-over for
 * fresh-input billing.
 */
export function detectMcpToolCoverage(
  projects: ProjectSummary[],
  coverage = aggregateMcpCoverage(projects),
): WasteFinding | null {
  if (coverage.length === 0) return null

  const flagged = coverage.filter(c =>
    c.toolsAvailable > MCP_COVERAGE_MIN_TOOLS
    && c.loadedSessions >= MCP_COVERAGE_MIN_SESSIONS
    && c.coverageRatio < MCP_COVERAGE_LOW_THRESHOLD,
  )
  if (flagged.length === 0) return null

  flagged.sort((a, b) => (b.toolsAvailable - b.toolsInvoked) - (a.toolsAvailable - a.toolsInvoked))

  const lines: string[] = []
  const removeCommands: string[] = []
  const unusedCountsByServer: Record<string, number> = {}
  const flaggedServers: string[] = []

  for (const c of flagged) {
    unusedCountsByServer[c.server] = c.toolsAvailable - c.toolsInvoked
    flaggedServers.push(c.server)
    const pct = Math.round(c.coverageRatio * 100)
    lines.push(
      `${c.server}: ${c.toolsInvoked}/${c.toolsAvailable} tools used (${pct}% coverage) across ${c.loadedSessions} session${c.loadedSessions === 1 ? '' : 's'}`,
    )
    removeCommands.push(`claude mcp remove '${c.server}'`)
  }

  // Single combined cost pass: caps each call's contribution at the
  // total unused-schema budget across all flagged servers, so two
  // flagged servers cannot independently claim the same call's cache
  // bucket and overstate `tokensSaved`.
  const cost = estimateMcpSchemaCost(unusedCountsByServer, projects, flaggedServers)
  const tokensSaved = Math.round(cost.effectiveInputTokens)
  const impact: Impact = tokensSaved >= MCP_COVERAGE_HIGH_IMPACT_TOKENS
    ? 'high'
    : flagged.length >= UNUSED_MCP_HIGH_THRESHOLD
      ? 'high'
      : 'medium'

  return {
    title: `${flagged.length} MCP server${flagged.length === 1 ? '' : 's'} with low tool coverage`,
    explanation:
      `Schema for unused tools is loaded into the system prompt every session and ` +
      `carried in the cached prefix on every turn. ` +
      `${lines.join('; ')}.`,
    impact,
    tokensSaved,
    fix: {
      type: 'command',
      label: flagged.length === 1
        ? 'Remove the underused server, or trim its tools in your MCP config:'
        : 'Remove underused servers, or trim their tools in your MCP config:',
      text: removeCommands.join('\n'),
    },
  }
}

export function detectUnusedMcp(
  calls: ToolCall[],
  projects: ProjectSummary[],
  projectCwds: Set<string>,
  mcpCoverage = aggregateMcpCoverage(projects),
): WasteFinding | null {
  const configured = loadMcpConfigs(projectCwds)
  if (configured.size === 0) return null

  const calledServers = new Set<string>()
  for (const call of calls) {
    if (!call.name.startsWith('mcp__')) continue
    const seg = call.name.split('__')[1]
    if (seg) calledServers.add(seg)
  }
  for (const p of projects) {
    for (const s of p.sessions) {
      for (const server of Object.keys(s.mcpBreakdown)) calledServers.add(server)
    }
  }

  // Servers that the new coverage detector will flag fall under its
  // jurisdiction (per-tool granularity, cache-aware costing) and we
  // suppress them here to avoid double-flagging. Importantly, we suppress
  // only the servers that actually clear the coverage detector's
  // thresholds — a small, inventoried-but-uninvoked server that the
  // coverage detector skips would otherwise become a blind spot.
  const coverageReportedServers = new Set(
    mcpCoverage
      .filter(c =>
        c.toolsAvailable > MCP_COVERAGE_MIN_TOOLS
        && c.loadedSessions >= MCP_COVERAGE_MIN_SESSIONS
        && c.coverageRatio < MCP_COVERAGE_LOW_THRESHOLD,
      )
      .map(c => c.server),
  )

  const now = Date.now()
  const unused: string[] = []
  for (const entry of configured.values()) {
    if (calledServers.has(entry.normalized)) continue
    if (coverageReportedServers.has(entry.normalized)) continue
    if (entry.mtime > 0 && now - entry.mtime < MCP_NEW_CONFIG_GRACE_MS) continue
    unused.push(entry.original)
  }

  if (unused.length === 0) return null

  const totalSessions = projects.reduce((s, p) => s + p.sessions.length, 0)
  const schemaTokensPerSession = unused.length * TOOLS_PER_MCP_SERVER * TOKENS_PER_MCP_TOOL
  const tokensSaved = schemaTokensPerSession * Math.max(totalSessions, 1)

  return {
    title: `${unused.length} MCP server${unused.length > 1 ? 's' : ''} configured but never used`,
    explanation: `Never called in this period: ${unused.join(', ')}. Each server loads ~${TOOLS_PER_MCP_SERVER * TOKENS_PER_MCP_TOOL} tokens of tool schema into every session.`,
    impact: unused.length >= UNUSED_MCP_HIGH_THRESHOLD ? 'high' : 'medium',
    tokensSaved,
    fix: {
      type: 'command',
      label: `Remove unused server${unused.length > 1 ? 's' : ''}:`,
      text: unused.map(s => `claude mcp remove ${s}`).join('\n'),
    },
  }
}

function expandImports(filePath: string, seen: Set<string>, depth: number): { totalLines: number; importedFiles: number } {
  if (depth > MAX_IMPORT_DEPTH || seen.has(filePath)) return { totalLines: 0, importedFiles: 0 }
  seen.add(filePath)
  const content = readSessionFileSync(filePath)
  if (content === null) return { totalLines: 0, importedFiles: 0 }

  let totalLines = content.split('\n').length
  let importedFiles = 0
  const dir = join(filePath, '..')

  IMPORT_PATTERN.lastIndex = 0
  for (const match of content.matchAll(IMPORT_PATTERN)) {
    const rawPath = match[1]
    if (!rawPath) continue
    const resolved = rawPath.startsWith('/') ? rawPath : join(dir, rawPath)
    if (!existsSync(resolved)) continue
    const nested = expandImports(resolved, seen, depth + 1)
    totalLines += nested.totalLines
    importedFiles += 1 + nested.importedFiles
  }

  return { totalLines, importedFiles }
}

export function detectBloatedClaudeMd(projectCwds: Set<string>): WasteFinding | null {
  const bloated: { path: string; expandedLines: number; imports: number }[] = []

  for (const cwd of projectCwds) {
    for (const name of ['CLAUDE.md', '.claude/CLAUDE.md']) {
      const fullPath = join(cwd, name)
      if (!existsSync(fullPath)) continue
      const { totalLines, importedFiles } = expandImports(fullPath, new Set(), 0)
      if (totalLines > CLAUDEMD_HEALTHY_LINES) {
        bloated.push({ path: `${shortHomePath(cwd)}/${name}`, expandedLines: totalLines, imports: importedFiles })
      }
    }
  }

  if (bloated.length === 0) return null

  const sorted = bloated.sort((a, b) => b.expandedLines - a.expandedLines)
  const worst = sorted[0]
  const totalExtraLines = sorted.reduce((s, b) => s + (b.expandedLines - CLAUDEMD_HEALTHY_LINES), 0)
  const tokensSaved = totalExtraLines * CLAUDEMD_TOKENS_PER_LINE

  const list = sorted.slice(0, TOP_ITEMS_PREVIEW).map(b => {
    const importNote = b.imports > 0 ? ` with ${b.imports} @-import${b.imports > 1 ? 's' : ''}` : ''
    return `${b.path} (${b.expandedLines} lines${importNote})`
  }).join(', ')

  return {
    title: `Your CLAUDE.md is too long`,
    explanation: `${list}. CLAUDE.md plus all @-imported files load into every API call. Trimming below ${CLAUDEMD_HEALTHY_LINES} lines saves ~${formatTokens(tokensSaved)} tokens per call.`,
    impact: worst.expandedLines > CLAUDEMD_HIGH_THRESHOLD_LINES ? 'high' : 'medium',
    tokensSaved,
    fix: {
      type: 'paste',
      label: 'Ask Claude to trim it:',
      text: `Review CLAUDE.md and all @-imported files. Cut total expanded content to under ${CLAUDEMD_HEALTHY_LINES} lines. Remove anything Claude can figure out from the code itself. Keep only rules, gotchas, and non-obvious conventions.`,
    },
  }
}

const READ_TOOL_NAMES = new Set(['Read', 'Grep', 'Glob', 'FileReadTool', 'GrepTool', 'GlobTool'])
const EDIT_TOOL_NAMES = new Set(['Edit', 'Write', 'FileEditTool', 'FileWriteTool', 'NotebookEdit'])

export function detectLowReadEditRatio(calls: ToolCall[]): WasteFinding | null {
  let reads = 0
  let edits = 0
  let recentEdits = 0
  let recentReads = 0
  for (const call of calls) {
    if (READ_TOOL_NAMES.has(call.name)) {
      reads++
      if (call.recent) recentReads++
    } else if (EDIT_TOOL_NAMES.has(call.name)) {
      edits++
      if (call.recent) recentEdits++
    }
  }

  if (edits < MIN_EDITS_FOR_RATIO) return null
  const ratio = reads / edits
  if (ratio >= HEALTHY_READ_EDIT_RATIO) return null

  const impact: Impact = ratio < LOW_RATIO_HIGH_THRESHOLD ? 'high' : ratio < LOW_RATIO_MEDIUM_THRESHOLD ? 'medium' : 'low'
  const extraReadsNeeded = Math.max(Math.round(edits * HEALTHY_READ_EDIT_RATIO) - reads, 0)
  const tokensSaved = extraReadsNeeded * AVG_TOKENS_PER_READ

  let trend: Trend | 'resolved' = 'active'
  if (recentEdits >= MIN_EDITS_FOR_RATIO) {
    const recentRatio = recentReads / recentEdits
    if (recentRatio >= HEALTHY_READ_EDIT_RATIO) trend = 'resolved'
    else if (recentRatio > ratio * (1 / IMPROVING_THRESHOLD)) trend = 'improving'
  }
  if (trend === 'resolved') return null

  return {
    title: 'Claude edits more than it reads',
    explanation: `Claude made ${reads} reads and ${edits} edits (ratio ${ratio.toFixed(1)}:1). A healthy ratio is ${HEALTHY_READ_EDIT_RATIO}+ reads per edit. Editing without reading leads to retries and wasted tokens.`,
    impact,
    tokensSaved,
    fix: {
      type: 'paste',
      label: 'Add to your CLAUDE.md:',
      text: 'Before editing any file, read it first. Before modifying a function, grep for all callers. Research before you edit.',
    },
    trend,
  }
}

const DEFAULT_CACHE_BASELINE_TOKENS = 50_000
const CACHE_BASELINE_QUANTILE = 0.25
const CACHE_BLOAT_MULTIPLIER = 1.4
const CACHE_VERSION_MIN_SAMPLES = 5
const CACHE_VERSION_DIFF_THRESHOLD = 10_000

function computeBudgetAwareCacheBaseline(projects: ProjectSummary[]): number {
  const sessions = projects.flatMap(p => p.sessions)
  if (sessions.length === 0) return DEFAULT_CACHE_BASELINE_TOKENS
  const cacheWrites = sessions.map(s => s.totalCacheWriteTokens).filter(n => n > 0)
  if (cacheWrites.length < MIN_API_CALLS_FOR_CACHE) return DEFAULT_CACHE_BASELINE_TOKENS
  const sorted = cacheWrites.sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length * CACHE_BASELINE_QUANTILE)] || DEFAULT_CACHE_BASELINE_TOKENS
}

export function detectCacheBloat(apiCalls: ApiCallMeta[], projects: ProjectSummary[], dateRange?: DateRange): WasteFinding | null {
  if (apiCalls.length < MIN_API_CALLS_FOR_CACHE) return null

  const sorted = apiCalls.map(c => c.cacheCreationTokens).sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  const baseline = computeBudgetAwareCacheBaseline(projects)
  const bloatThreshold = baseline * CACHE_BLOAT_MULTIPLIER

  if (median < bloatThreshold) return null

  const recentCalls = apiCalls.filter(c => c.recent)
  const totalBloated = apiCalls.filter(c => c.cacheCreationTokens > bloatThreshold).length
  const recentBloated = recentCalls.filter(c => c.cacheCreationTokens > bloatThreshold).length
  const trend = sessionTrend(recentBloated, totalBloated, dateRange, recentCalls.length > 0)
  if (trend === 'resolved') return null

  const versionCounts = new Map<string, { total: number; count: number }>()
  for (const call of apiCalls) {
    if (!call.version) continue
    const entry = versionCounts.get(call.version) ?? { total: 0, count: 0 }
    entry.total += call.cacheCreationTokens
    entry.count++
    versionCounts.set(call.version, entry)
  }
  const versionAvgs = [...versionCounts.entries()]
    .filter(([, d]) => d.count >= CACHE_VERSION_MIN_SAMPLES)
    .map(([v, d]) => ({ version: v, avg: Math.round(d.total / d.count) }))
    .sort((a, b) => b.avg - a.avg)

  const excess = median - baseline
  const tokensSaved = excess * apiCalls.length

  let versionNote = ''
  if (versionAvgs.length >= 2) {
    const [high, ...rest] = versionAvgs
    const low = rest[rest.length - 1]
    if (high.avg - low.avg > CACHE_VERSION_DIFF_THRESHOLD) {
      versionNote = ` Version ${high.version} averages ${formatTokens(high.avg)} vs ${low.version} at ${formatTokens(low.avg)}.`
    }
  }

  return {
    title: 'Session warmup is unusually large',
    explanation: `Median cache_creation per call is ${formatTokens(median)} tokens, about ${formatTokens(excess)} above your baseline of ${formatTokens(baseline)}.${versionNote}`,
    impact: excess > CACHE_EXCESS_HIGH_THRESHOLD ? 'high' : 'medium',
    tokensSaved,
    fix: {
      type: 'paste',
      label: 'Check for recent Claude Code updates or heavy MCP/skill additions. As a workaround (not officially supported):',
      text: 'export ANTHROPIC_CUSTOM_HEADERS=\'User-Agent: claude-cli/2.1.98 (external, sdk-cli)\'',
    },
    trend,
  }
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return []
  try {
    const entries = await readdir(dir)
    return entries.filter(e => e.endsWith('.md')).map(e => e.replace(/\.md$/, ''))
  } catch { return [] }
}

async function listSkillDirs(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return []
  try {
    const entries = await readdir(dir)
    const names: string[] = []
    for (const entry of entries) {
      if (existsSync(join(dir, entry, 'SKILL.md'))) names.push(entry)
    }
    return names
  } catch { return [] }
}

export async function detectGhostAgents(calls: ToolCall[]): Promise<WasteFinding | null> {
  const defined = await listMarkdownFiles(join(homedir(), '.claude', 'agents'))
  if (defined.length === 0) return null

  const invoked = new Set<string>()
  for (const call of calls) {
    if (call.name !== 'Agent' && call.name !== 'Task') continue
    const subType = call.input.subagent_type as string | undefined
    if (subType) invoked.add(subType)
  }

  const ghosts = defined.filter(name => !invoked.has(name))
  if (ghosts.length === 0) return null

  const tokensSaved = ghosts.length * TOKENS_PER_AGENT_DEF
  const list = ghosts.slice(0, GHOST_NAMES_PREVIEW).join(', ') + (ghosts.length > GHOST_NAMES_PREVIEW ? `, +${ghosts.length - GHOST_NAMES_PREVIEW} more` : '')

  return {
    title: `${ghosts.length} custom agent${ghosts.length > 1 ? 's' : ''} you never use`,
    explanation: `Defined in ~/.claude/agents/ but never invoked in this period: ${list}. Each adds ~${TOKENS_PER_AGENT_DEF} tokens to the Task tool schema on every session.`,
    impact: ghosts.length >= GHOST_AGENTS_HIGH_THRESHOLD ? 'high' : ghosts.length >= GHOST_AGENTS_MEDIUM_THRESHOLD ? 'medium' : 'low',
    tokensSaved,
    fix: {
      type: 'command',
      label: `Archive unused agent${ghosts.length > 1 ? 's' : ''}:`,
      text: ghosts.slice(0, GHOST_CLEANUP_COMMANDS_LIMIT).map(name => `mv ~/.claude/agents/${name}.md ~/.claude/agents/.archived/`).join('\n'),
    },
  }
}

export async function detectGhostSkills(calls: ToolCall[]): Promise<WasteFinding | null> {
  const defined = await listSkillDirs(join(homedir(), '.claude', 'skills'))
  if (defined.length === 0) return null

  const invoked = new Set<string>()
  for (const call of calls) {
    if (call.name !== 'Skill') continue
    const skillName = (call.input.skill as string) || (call.input.name as string)
    if (skillName) invoked.add(skillName)
  }

  const ghosts = defined.filter(name => !invoked.has(name))
  if (ghosts.length === 0) return null

  const tokensSaved = ghosts.length * TOKENS_PER_SKILL_DEF
  const list = ghosts.slice(0, GHOST_NAMES_PREVIEW).join(', ') + (ghosts.length > GHOST_NAMES_PREVIEW ? `, +${ghosts.length - GHOST_NAMES_PREVIEW} more` : '')

  return {
    title: `${ghosts.length} skill${ghosts.length > 1 ? 's' : ''} you never use`,
    explanation: `In ~/.claude/skills/ but not invoked this period: ${list}. Each adds ~${TOKENS_PER_SKILL_DEF} tokens of metadata to every session.`,
    impact: ghosts.length >= GHOST_SKILLS_HIGH_THRESHOLD ? 'high' : ghosts.length >= GHOST_SKILLS_MEDIUM_THRESHOLD ? 'medium' : 'low',
    tokensSaved,
    fix: {
      type: 'command',
      label: `Archive unused skill${ghosts.length > 1 ? 's' : ''}:`,
      text: ghosts.slice(0, GHOST_CLEANUP_COMMANDS_LIMIT).map(name => `mv ~/.claude/skills/${name} ~/.claude/skills/.archived/`).join('\n'),
    },
  }
}

export async function detectGhostCommands(userMessages: string[]): Promise<WasteFinding | null> {
  const defined = await listMarkdownFiles(join(homedir(), '.claude', 'commands'))
  if (defined.length === 0) return null

  const invoked = new Set<string>()
  for (const msg of userMessages) {
    COMMAND_PATTERN.lastIndex = 0
    for (const m of msg.matchAll(COMMAND_PATTERN)) {
      const name = (m[1] || m[2] || '').trim()
      if (name) invoked.add(name)
    }
  }

  const ghosts = defined.filter(name => !invoked.has(name))
  if (ghosts.length === 0) return null

  const tokensSaved = ghosts.length * TOKENS_PER_COMMAND_DEF
  const list = ghosts.slice(0, GHOST_NAMES_PREVIEW).join(', ') + (ghosts.length > GHOST_NAMES_PREVIEW ? `, +${ghosts.length - GHOST_NAMES_PREVIEW} more` : '')

  return {
    title: `${ghosts.length} slash command${ghosts.length > 1 ? 's' : ''} you never use`,
    explanation: `In ~/.claude/commands/ but not referenced this period: ${list}. Each adds ~${TOKENS_PER_COMMAND_DEF} tokens of definition per session.`,
    impact: ghosts.length >= GHOST_COMMANDS_MEDIUM_THRESHOLD ? 'medium' : 'low',
    tokensSaved,
    fix: {
      type: 'command',
      label: `Archive unused command${ghosts.length > 1 ? 's' : ''}:`,
      text: ghosts.slice(0, GHOST_CLEANUP_COMMANDS_LIMIT).map(name => `mv ~/.claude/commands/${name}.md ~/.claude/commands/.archived/`).join('\n'),
    },
  }
}

function readShellProfileLimit(): number | null {
  for (const profile of SHELL_PROFILES) {
    const path = join(homedir(), profile)
    if (!existsSync(path)) continue
    const content = readSessionFileSync(path)
    if (content === null) continue
    const match = content.match(/^\s*export\s+BASH_MAX_OUTPUT_LENGTH\s*=\s*['"]?(\d+)['"]?/m)
    if (match) return parseInt(match[1], 10)
  }
  return null
}

export function detectBashBloat(): WasteFinding | null {
  const profileLimit = readShellProfileLimit()
  const envLimit = process.env['BASH_MAX_OUTPUT_LENGTH']
  const configured = profileLimit ?? (envLimit ? parseInt(envLimit, 10) : null)

  if (configured !== null && configured <= BASH_RECOMMENDED_LIMIT) return null

  const limit = configured ?? BASH_DEFAULT_LIMIT
  const extraChars = limit - BASH_RECOMMENDED_LIMIT
  const tokensSaved = Math.round(extraChars * BASH_TOKENS_PER_CHAR)

  return {
    title: 'Shrink bash output limit',
    explanation: `Your bash output cap is ${(limit / 1000).toFixed(0)}K chars (${configured ? 'configured' : 'default'}). Most output fits in ${(BASH_RECOMMENDED_LIMIT / 1000).toFixed(0)}K. The extra ~${formatTokens(tokensSaved)} tokens per bash call is trailing noise.`,
    impact: 'medium',
    tokensSaved,
    fix: {
      type: 'paste',
      label: 'Add to ~/.zshrc or ~/.bashrc:',
      text: `export BASH_MAX_OUTPUT_LENGTH=${BASH_RECOMMENDED_LIMIT}`,
    },
  }
}

function sessionTokenTotal(session: ProjectSummary['sessions'][number]): number {
  return session.totalInputTokens
    + session.totalOutputTokens
    + session.totalCacheReadTokens
    + session.totalCacheWriteTokens
}

function sessionEffectiveContextTokens(session: ProjectSummary['sessions'][number]): number {
  return session.totalInputTokens
    + session.totalCacheReadTokens * CACHE_READ_DISCOUNT
    + session.totalCacheWriteTokens * CACHE_WRITE_MULTIPLIER
}

function formatContextRatio(ratio: number): string {
  if (ratio >= CONTEXT_BLOAT_RATIO_DISPLAY_CAP) return `${CONTEXT_BLOAT_RATIO_DISPLAY_CAP}+`
  return ratio.toFixed(1)
}

// ============================================================================
// Worth-it / low-worth-session detector helpers
// ============================================================================

// Use (\s|$|--) instead of \b after commit/push so `git commit-tree` and
// `git commit-graph` are not treated as deliveries. The `--` clause keeps
// `git commit --amend` matching as a real delivery command.
const DELIVERY_COMMAND_PATTERNS = [
  /(?:^|[;&|]\s*)git\s+(?:commit|push)(?=\s|$|--)(?![^;&|]*--dry-run)/,
  /(?:^|[;&|]\s*)gh\s+pr\s+(?:create|merge)(?=\s|$|--)(?![^;&|]*--dry-run)/,
]

function sessionDeliveryCommand(session: ProjectSummary['sessions'][number]): string | null {
  const commands = Object.keys(session.bashBreakdown)
  return commands.find(command => DELIVERY_COMMAND_PATTERNS.some(pattern => pattern.test(command))) ?? null
}

function hasCategoryBreakdownData(session: ProjectSummary['sessions'][number]): boolean {
  return Object.values(session.categoryBreakdown).some(category =>
    category.turns > 0
    || category.costUSD > 0
    || category.retries > 0
    || category.editTurns > 0
    || category.oneShotTurns > 0
  )
}

function sessionEditTurns(session: ProjectSummary['sessions'][number]): number {
  if (hasCategoryBreakdownData(session)) {
    return Object.values(session.categoryBreakdown).reduce((sum, c) => sum + c.editTurns, 0)
  }
  return session.turns.filter(turn => turn.hasEdits).length
}

function sessionOneShotTurns(session: ProjectSummary['sessions'][number]): number {
  if (hasCategoryBreakdownData(session)) {
    return Object.values(session.categoryBreakdown).reduce((sum, c) => sum + c.oneShotTurns, 0)
  }
  return session.turns.filter(turn => turn.hasEdits && turn.retries === 0).length
}

function sessionRetryCount(session: ProjectSummary['sessions'][number]): number {
  if (hasCategoryBreakdownData(session)) {
    return Object.values(session.categoryBreakdown).reduce((sum, c) => sum + c.retries, 0)
  }
  return session.turns.reduce((sum, turn) => sum + turn.retries, 0)
}

function sessionTotalTurns(session: ProjectSummary['sessions'][number]): number {
  if (hasCategoryBreakdownData(session)) {
    return Object.values(session.categoryBreakdown).reduce((sum, c) => sum + c.turns, 0)
  }
  return session.turns.length
}

// Token-savings estimate for a low-worth candidate. Two regimes:
//   - No-edit sessions: full session tokens are at risk (the session produced
//     no apparent output to weigh against the spend).
//   - Sessions with edits but with retries / no one-shot: only the retry
//     fraction is counted as recoverable. Edits may still have been useful;
//     we credit the model with that and only flag the retry overhead.
// Ratio is bounded to [0, 1] so retry-heavy sessions with weird turn counts
// can't claim more than the full session token total.
function estimateLowWorthRecoverableTokens(
  session: ProjectSummary['sessions'][number],
  editTurns: number,
  retries: number,
): number {
  const tokens = sessionTokenTotal(session)
  if (editTurns === 0) return tokens
  const totalTurns = sessionTotalTurns(session)
  if (totalTurns === 0) return 0
  const fraction = Math.min(1, Math.max(0, retries / totalTurns))
  return Math.round(tokens * fraction)
}

export type LowWorthCandidate = {
  project: string
  sessionId: string
  date: string
  cost: number
  tokens: number
  reasons: string[]
}

export function findLowWorthCandidates(projects: ProjectSummary[]): LowWorthCandidate[] {
  const candidates: LowWorthCandidate[] = []

  for (const project of projects) {
    for (const session of project.sessions) {
      if (session.totalCostUSD < WORTH_IT_MIN_COST_USD) continue
      if (sessionDeliveryCommand(session)) continue

      const editTurns = sessionEditTurns(session)
      const oneShotTurns = sessionOneShotTurns(session)
      const retries = sessionRetryCount(session)
      const reasons: string[] = []

      if (editTurns === 0 && session.totalCostUSD >= WORTH_IT_NO_EDIT_MIN_COST_USD) {
        reasons.push('no edit turns')
      }
      if (retries >= WORTH_IT_MIN_RETRIES) {
        reasons.push(`${retries} retries`)
      }
      if (
        editTurns > 0
        && oneShotTurns === 0
        && retries >= WORTH_IT_RETRY_WITH_EDIT_MIN_RETRIES
      ) {
        reasons.push('no one-shot edit turns')
      }

      if (reasons.length === 0) continue

      candidates.push({
        project: project.project,
        sessionId: session.sessionId,
        date: session.firstTimestamp.slice(0, 10),
        cost: session.totalCostUSD,
        tokens: estimateLowWorthRecoverableTokens(session, editTurns, retries),
        reasons,
      })
    }
  }

  candidates.sort((a, b) =>
    b.cost - a.cost
    || a.date.localeCompare(b.date)
    || a.project.localeCompare(b.project)
    || a.sessionId.localeCompare(b.sessionId)
  )
  return candidates
}

export function detectLowWorthSessions(projects: ProjectSummary[]): WasteFinding | null {
  const candidates = findLowWorthCandidates(projects)
  if (candidates.length === 0) return null

  const preview = candidates.slice(0, WORTH_IT_PREVIEW)
  const list = preview
    .map(s => `${s.project}/${s.sessionId} on ${s.date}: ${formatCost(s.cost)} (${s.reasons.join(', ')})`)
    .join('; ')
  const extra = candidates.length > preview.length ? `; +${candidates.length - preview.length} more` : ''
  // Per-candidate `tokens` is already the recoverable estimate (full session
  // for no-edit, retry-fraction for edit-with-retries). Sum across candidates.
  const tokensSaved = Math.round(candidates.reduce((sum, s) => sum + s.tokens, 0))
  const totalCost = candidates.reduce((sum, s) => sum + s.cost, 0)

  // Three tiers consistent with detectContextBloat: high at >=10 candidates
  // or >=$50 total spend at risk; low at <=2 candidates AND <$10 total;
  // medium in between.
  let impact: Impact
  if (candidates.length >= WORTH_IT_HIGH_MIN_CANDIDATES || totalCost >= WORTH_IT_HIGH_TOTAL_COST_USD) {
    impact = 'high'
  } else if (candidates.length <= WORTH_IT_LOW_MAX_CANDIDATES && totalCost < WORTH_IT_LOW_MAX_TOTAL_COST_USD) {
    impact = 'low'
  } else {
    impact = 'medium'
  }

  return {
    title: `${candidates.length} possibly low-worth expensive session${candidates.length === 1 ? '' : 's'}`,
    explanation: `Sessions with meaningful spend but weak delivery signals: ${list}${extra}. This is a review candidate, not proof of waste: CodeBurn flags missing edit turns, repeated retries, and sessions without git delivery commands so you can decide whether the work was worth its cost before it becomes a habit.`,
    impact,
    tokensSaved,
    fix: {
      type: 'paste',
      label: 'Set a delivery checkpoint at the start of the next expensive thread:',
      text: 'Before continuing, name the deliverable in one sentence (PR title, file changed, command output you expect). Stop and check with me if (a) you spend more than 10 minutes without an edit, or (b) the same approach fails twice. Do not retry past two attempts on any single fix.',
    },
  }
}

export type ContextBloatCandidate = {
  project: string
  sessionId: string
  date: string
  effectiveInputTokens: number
  outputTokens: number
  ratio: number
  excessInputTokens: number
  growthRatio: number | null
}

export function findContextBloatCandidates(projects: ProjectSummary[]): ContextBloatCandidate[] {
  const candidates: ContextBloatCandidate[] = []

  for (const project of projects) {
    const sessions = [...project.sessions].sort((a, b) =>
      new Date(a.firstTimestamp).getTime() - new Date(b.firstTimestamp).getTime()
    )
    let previousInputTokens: number | null = null
    let previousTimestampMs: number | null = null

    for (const session of sessions) {
      const inputTokens = sessionEffectiveContextTokens(session)
      const outputTokens = session.totalOutputTokens
      const ratio = inputTokens / Math.max(outputTokens, 1)
      const currentMs = new Date(session.firstTimestamp).getTime()
      const gapMs = previousTimestampMs !== null ? currentMs - previousTimestampMs : null
      // Suppress growth ratio when the previous session is too far back to be
      // a meaningful baseline (e.g. a small test run weeks before a real
      // working session would otherwise produce alarming "1000x" figures).
      const growthRatio = previousInputTokens !== null
        && previousInputTokens > 0
        && gapMs !== null
        && gapMs <= CONTEXT_BLOAT_GROWTH_MAX_GAP_MS
        ? inputTokens / previousInputTokens
        : null

      // Anchor growth to the immediately previous project session, even if
      // that session is below threshold and never becomes a finding.
      previousInputTokens = inputTokens
      previousTimestampMs = currentMs

      if (inputTokens < CONTEXT_BLOAT_MIN_INPUT_TOKENS) continue
      if (ratio < CONTEXT_BLOAT_MIN_RATIO) continue

      candidates.push({
        project: project.project,
        sessionId: session.sessionId,
        date: session.firstTimestamp.slice(0, 10),
        effectiveInputTokens: inputTokens,
        outputTokens,
        ratio,
        excessInputTokens: Math.max(0, inputTokens - outputTokens * CONTEXT_BLOAT_TARGET_RATIO),
        growthRatio,
      })
    }
  }

  candidates.sort((a, b) =>
    b.excessInputTokens - a.excessInputTokens
    || a.date.localeCompare(b.date)
    || a.project.localeCompare(b.project)
    || a.sessionId.localeCompare(b.sessionId)
  )
  return candidates
}

export function detectContextBloat(projects: ProjectSummary[], excludedSessionIds?: ReadonlySet<string>): WasteFinding | null {
  const candidates = findContextBloatCandidates(projects)
    .filter(c => !excludedSessionIds?.has(c.sessionId))
  if (candidates.length === 0) return null

  const preview = candidates.slice(0, CONTEXT_BLOAT_PREVIEW)
  const list = preview
    .map(c => {
      const growth = c.growthRatio !== null && c.growthRatio >= CONTEXT_BLOAT_GROWTH_RATIO
        ? `, ${c.growthRatio.toFixed(1)}x previous session input`
        : ''
      return `${c.project}/${c.sessionId} on ${c.date}: ${formatTokens(c.effectiveInputTokens)} effective input/cache vs ${formatTokens(c.outputTokens)} output (${formatContextRatio(c.ratio)}:1${growth})`
    })
    .join('; ')
  const extra = candidates.length > preview.length ? `; +${candidates.length - preview.length} more` : ''
  // Savings estimate only counts context above a healthier 15:1 input-output ratio.
  // Detection stays stricter at 25:1 so borderline sessions are not shown.
  const tokensSaved = Math.round(candidates.reduce((sum, c) => sum + c.excessInputTokens, 0))
  const totalInputTokens = candidates.reduce((sum, c) => sum + c.effectiveInputTokens, 0)

  // Tier on candidate count first, total context size second. A single 600K
  // session is "high"; 1-2 modest-sized sessions are "low"; everything in
  // between is "medium".
  let impact: Impact
  if (candidates.length >= CONTEXT_BLOAT_HIGH_MIN_CANDIDATES || totalInputTokens >= CONTEXT_BLOAT_HIGH_INPUT_TOKENS) {
    impact = 'high'
  } else if (candidates.length <= CONTEXT_BLOAT_LOW_MAX_CANDIDATES && totalInputTokens < CONTEXT_BLOAT_LOW_INPUT_TOKENS) {
    impact = 'low'
  } else {
    impact = 'medium'
  }

  return {
    title: `${candidates.length} context-heavy session${candidates.length === 1 ? '' : 's'}`,
    explanation: `Effective input/cache tokens swamp output in these sessions: ${list}${extra}. This can come from stale context carryover, inherently context-heavy work, or abandoned runs that loaded too much context; starting fresh with only the current goal and relevant files can cut repeated prompt overhead.`,
    impact,
    tokensSaved,
    fix: {
      type: 'paste',
      label: 'Start the next expensive thread with a fresh-context constraint:',
      text: 'Start fresh before continuing. Use only the current goal, the relevant files, the failing command/output, and the constraints below. Restate the working context in under 10 bullets before editing.',
    },
  }
}

export function detectSessionOutliers(projects: ProjectSummary[], excludedSessionIds?: ReadonlySet<string>): WasteFinding | null {
  type Outlier = {
    project: string
    sessionId: string
    date: string
    cost: number
    avgCost: number
    ratio: number
    tokenExcess: number
  }

  const outliers: Outlier[] = []

  for (const project of projects) {
    const sessions = project.sessions.filter(s => s.totalCostUSD > 0)
    if (sessions.length < MIN_SESSIONS_FOR_OUTLIER) continue

    const totalCost = sessions.reduce((sum, s) => sum + s.totalCostUSD, 0)
    const totalTokens = sessions.reduce((sum, s) => sum + sessionTokenTotal(s), 0)
    for (const session of sessions) {
      const avgCost = (totalCost - session.totalCostUSD) / (sessions.length - 1)
      const avgTokens = (totalTokens - sessionTokenTotal(session)) / (sessions.length - 1)
      if (avgCost <= 0) continue

      const ratio = session.totalCostUSD / avgCost
      if (ratio <= SESSION_OUTLIER_MULTIPLIER) continue
      if (session.totalCostUSD < MIN_SESSION_OUTLIER_COST_USD) continue
      // Avoid reporting the same session under both this finding and the
      // context-bloat finding. Context-bloat takes priority because its
      // suggested fix ("start fresh") is more concrete than the generic
      // "tighter constraint" advice here.
      if (excludedSessionIds?.has(session.sessionId)) continue

      outliers.push({
        project: project.project,
        sessionId: session.sessionId,
        date: session.firstTimestamp.slice(0, 10),
        cost: session.totalCostUSD,
        avgCost,
        ratio,
        tokenExcess: Math.max(0, sessionTokenTotal(session) - avgTokens),
      })
    }
  }

  if (outliers.length === 0) return null

  outliers.sort((a, b) => b.cost - a.cost)
  const preview = outliers.slice(0, SESSION_OUTLIER_PREVIEW)
  const list = preview
    .map(o => `${o.project}/${o.sessionId} on ${o.date}: ${formatCost(o.cost)} (${o.ratio.toFixed(1)}x avg)`)
    .join('; ')
  const extra = outliers.length > preview.length ? `; +${outliers.length - preview.length} more` : ''
  const tokensSaved = Math.round(outliers.reduce((sum, o) => sum + o.tokenExcess, 0))
  const totalExcessCost = outliers.reduce((sum, o) => sum + Math.max(0, o.cost - o.avgCost), 0)

  return {
    title: `${outliers.length} high-cost session outlier${outliers.length === 1 ? '' : 's'}`,
    explanation: `Sessions costing more than ${SESSION_OUTLIER_MULTIPLIER}x their peer-session average in the same project: ${list}${extra}. These usually come from broad prompts, runaway loops, or context-heavy work that should be split into smaller sessions.`,
    impact: outliers.length >= 3 || totalExcessCost >= 10 ? 'high' : 'medium',
    tokensSaved,
    fix: {
      type: 'paste',
      label: 'For expensive work, start with a tighter operating constraint:',
      text: 'Before making changes, summarize the smallest viable plan. Keep context narrow, avoid broad searches, and stop after the first working patch so I can review before continuing.',
    },
  }
}

// ============================================================================
// Scoring
// ============================================================================

const HEALTH_WEIGHTS: Record<Impact, number> = {
  high: HEALTH_WEIGHT_HIGH,
  medium: HEALTH_WEIGHT_MEDIUM,
  low: HEALTH_WEIGHT_LOW,
}

export function computeHealth(findings: WasteFinding[]): { score: number; grade: HealthGrade } {
  if (findings.length === 0) return { score: 100, grade: 'A' }
  let penalty = 0
  for (const f of findings) penalty += HEALTH_WEIGHTS[f.impact] ?? 0
  const score = Math.max(0, 100 - Math.min(HEALTH_MAX_PENALTY, penalty))
  const grade: HealthGrade =
    score >= GRADE_A_MIN ? 'A' :
    score >= GRADE_B_MIN ? 'B' :
    score >= GRADE_C_MIN ? 'C' :
    score >= GRADE_D_MIN ? 'D' : 'F'
  return { score, grade }
}

const URGENCY_WEIGHTS: Record<Impact, number> = { high: 1, medium: 0.5, low: 0.2 }

function urgencyScore(f: WasteFinding): number {
  const normalizedTokens = Math.min(1, f.tokensSaved / URGENCY_TOKEN_NORMALIZE)
  return URGENCY_WEIGHTS[f.impact] * URGENCY_IMPACT_WEIGHT + normalizedTokens * URGENCY_TOKEN_WEIGHT
}

type TrendInputs = {
  recentCount: number
  recentWindowMs: number
  baselineCount: number
  baselineWindowMs: number
  hasRecentActivity: boolean
}

export function computeTrend(inputs: TrendInputs): Trend | 'resolved' {
  const { recentCount, recentWindowMs, baselineCount, baselineWindowMs, hasRecentActivity } = inputs
  if (baselineCount === 0) return 'active'
  if (recentCount === 0 && hasRecentActivity) return 'resolved'
  if (!hasRecentActivity) return 'active'
  const baselineRate = baselineCount / baselineWindowMs
  const recentRate = recentCount / Math.max(recentWindowMs, 1)
  if (recentRate < baselineRate * IMPROVING_THRESHOLD) return 'improving'
  return 'active'
}

function sessionTrend(
  recentItemCount: number,
  totalItemCount: number,
  dateRange: DateRange | undefined,
  hasRecentActivity: boolean,
): Trend | 'resolved' {
  const now = Date.now()
  const baselineCount = totalItemCount - recentItemCount
  const periodStart = dateRange ? dateRange.start.getTime() : now - DEFAULT_TREND_PERIOD_MS
  const recentStart = now - RECENT_WINDOW_MS
  const baselineWindowMs = Math.max(recentStart - periodStart, 1)
  return computeTrend({
    recentCount: recentItemCount,
    recentWindowMs: RECENT_WINDOW_MS,
    baselineCount,
    baselineWindowMs,
    hasRecentActivity,
  })
}

// ============================================================================
// Cost estimation
// ============================================================================

const INPUT_COST_RATIO = 0.7
const DEFAULT_COST_PER_TOKEN = 0

function computeInputCostRate(projects: ProjectSummary[]): number {
  const sessions = projects.flatMap(p => p.sessions)
  const totalCost = sessions.reduce((s, sess) => s + sess.totalCostUSD, 0)
  const totalTokens = sessions.reduce((s, sess) =>
    s + sess.totalInputTokens + sess.totalCacheReadTokens + sess.totalCacheWriteTokens, 0)
  if (totalTokens === 0 || totalCost === 0) return DEFAULT_COST_PER_TOKEN
  return (totalCost * INPUT_COST_RATIO) / totalTokens
}

// ============================================================================
// Main entry points
// ============================================================================

type CacheEntry = { data: OptimizeResult; ts: number }
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

// ============================================================================
// CLI rendering
// ============================================================================

const PANEL_WIDTH = 62
const SEP = '\u2500'
const IMPACT_COLORS: Record<Impact, string> = { high: RED, medium: ORANGE, low: DIM }
const GRADE_COLORS: Record<HealthGrade, string> = { A: GREEN, B: GREEN, C: GOLD, D: ORANGE, F: RED }

function wrap(text: string, width: number, indent: string): string {
  const words = text.split(' ')
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    if (current && current.length + word.length + 1 > width) {
      lines.push(indent + current)
      current = word
    } else {
      current = current ? current + ' ' + word : word
    }
  }
  if (current) lines.push(indent + current)
  return lines.join('\n')
}

function renderFinding(n: number, f: WasteFinding, costRate: number): string[] {
  const lines: string[] = []
  const costSaved = f.tokensSaved * costRate
  const impactLabel = f.impact.charAt(0).toUpperCase() + f.impact.slice(1)
  const trendBadge = f.trend === 'improving' ? ' improving \u2193 ' : ''
  const savings = `~${formatTokens(f.tokensSaved)} tokens (~${formatCost(costSaved)})`
  const titlePad = PANEL_WIDTH - f.title.length - impactLabel.length - trendBadge.length - 8
  const pad = titlePad > 0 ? ' ' + SEP.repeat(titlePad) + ' ' : '  '

  lines.push(chalk.hex(DIM)(`  ${SEP}${SEP}${SEP} `) +
    chalk.bold(`${n}. ${f.title}`) +
    chalk.hex(DIM)(pad) +
    chalk.hex(IMPACT_COLORS[f.impact])(impactLabel) +
    (trendBadge ? chalk.hex(GREEN)(trendBadge) : '') +
    chalk.hex(DIM)(` ${SEP}${SEP}${SEP}`))
  lines.push('')
  lines.push(wrap(f.explanation, PANEL_WIDTH - 4, '  '))
  lines.push('')
  lines.push(chalk.hex(GOLD)(`  Potential savings: ${savings}`))
  lines.push('')

  const a = f.fix
  if (a.type === 'file-content') {
    lines.push(chalk.hex(DIM)(`  ${a.label}`))
    for (const line of a.content.split('\n')) lines.push(chalk.hex(CYAN)(`    ${line}`))
  } else if (a.type === 'command') {
    lines.push(chalk.hex(DIM)(`  ${a.label}`))
    for (const line of a.text.split('\n')) lines.push(chalk.hex(CYAN)(`    ${line}`))
  } else {
    lines.push(chalk.hex(DIM)(`  ${a.label}`))
    lines.push(chalk.hex(CYAN)(`    ${a.text}`))
  }
  lines.push('')
  return lines
}

function renderOptimize(
  findings: WasteFinding[],
  costRate: number,
  periodLabel: string,
  periodCost: number,
  sessionCount: number,
  callCount: number,
  healthScore: number,
  healthGrade: HealthGrade,
): string {
  const lines: string[] = []
  lines.push('')
  lines.push(`  ${chalk.bold.hex(ORANGE)('CodeBurn config health')}${chalk.dim('  ' + periodLabel)}`)
  lines.push(chalk.hex(DIM)('  ' + SEP.repeat(PANEL_WIDTH)))

  const issueSuffix = findings.length > 0 ? `, ${findings.length} issue${findings.length > 1 ? 's' : ''}` : ''
  lines.push('  ' + [
    `${sessionCount} sessions`,
    `${callCount.toLocaleString()} calls`,
    chalk.hex(GOLD)(formatCost(periodCost)),
    `Health: ${chalk.bold.hex(GRADE_COLORS[healthGrade])(healthGrade)}${chalk.dim(` (${healthScore}/100${issueSuffix})`)}`,
  ].join(chalk.hex(DIM)('   ')))
  lines.push('')

  if (findings.length === 0) {
    lines.push(chalk.hex(GREEN)('  Nothing to fix. Your setup is lean.'))
    lines.push('')
    lines.push(chalk.dim('  CodeBurn optimize scans your Claude Code sessions and config for'))
    lines.push(chalk.dim('  token waste: junk directory reads, duplicate file reads, unused'))
    lines.push(chalk.dim('  agents/skills/MCP servers, bloated CLAUDE.md, and more.'))
    lines.push('')
    return lines.join('\n')
  }

  const totalTokens = findings.reduce((s, f) => s + f.tokensSaved, 0)
  const totalCost = totalTokens * costRate
  const pctRaw = periodCost > 0 ? (totalCost / periodCost) * 100 : 0
  const pct = pctRaw >= 1 ? pctRaw.toFixed(0) : pctRaw.toFixed(1)

  const costText = costRate > 0 ? ` (~${formatCost(totalCost)}, ~${pct}% of spend)` : ''
  lines.push(chalk.hex(GREEN)(`  Potential savings: ~${formatTokens(totalTokens)} tokens${costText}`))
  lines.push('')

  for (let i = 0; i < findings.length; i++) {
    lines.push(...renderFinding(i + 1, findings[i], costRate))
  }

  lines.push(chalk.hex(DIM)('  ' + SEP.repeat(PANEL_WIDTH)))
  lines.push(chalk.dim('  Estimates only.'))
  lines.push('')
  return lines.join('\n')
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

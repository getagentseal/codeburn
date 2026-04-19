import chalk from 'chalk'
import { readdir, stat } from 'fs/promises'
import { existsSync, statSync } from 'fs'
import { basename, join } from 'path'
import { homedir } from 'os'

import { readSessionFile, readSessionFileSync } from './fs-utils.js'
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
const BASH_TOKENS_PER_CHAR = 0.25

// ============================================================================
// Detector thresholds
// ============================================================================

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
const BASH_DEFAULT_LIMIT = 30000
const BASH_RECOMMENDED_LIMIT = 15000

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
const URGENCY_IMPACT_WEIGHT = 0.7
const URGENCY_TOKEN_WEIGHT = 0.3
const URGENCY_TOKEN_NORMALIZE = 500_000

// ============================================================================
// File system constants
// ============================================================================

const JUNK_DIRS = [
  'node_modules', '.git', 'dist', 'build', '__pycache__', '.next',
  '.nuxt', '.output', 'coverage', '.cache', '.tsbuildinfo',
  '.venv', 'venv', '.svn', '.hg',
]
const JUNK_PATTERN = new RegExp(`/(?:${JUNK_DIRS.join('|')})/`)

const SHELL_PROFILES = ['.zshrc', '.bashrc', '.bash_profile', '.profile']

const TOP_ITEMS_PREVIEW = 3

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
  const content = await readSessionFile(filePath)
  if (content === null) return { calls: [], cwds: [], apiCalls: [], userMessages: [] }

  const calls: ToolCall[] = []
  const cwds: string[] = []
  const apiCalls: ApiCallMeta[] = []
  const userMessages: string[] = []
  const sessionId = basename(filePath, '.jsonl')
  let lastVersion = ''

  for (const line of content.split('\n')) {
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
  const sources = await discoverAllSessions()
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

function isReadTool(name: string): boolean {
  return name === 'Read' || name === 'FileReadTool'
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
    title: 'Agent is reading build/dependency folders',
    explanation: `Agent read into ${dirList} (${totalJunkReads} reads). These are generated or dependency directories, not your code. Add a rule to avoid them.`,
    impact: totalJunkReads > JUNK_READS_HIGH_THRESHOLD ? 'high' : totalJunkReads > JUNK_READS_MEDIUM_THRESHOLD ? 'medium' : 'low',
    tokensSaved,
    fix: {
      type: 'paste',
      label: 'Add to your agent rules:',
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
    title: 'Agent is re-reading the same files',
    explanation: `${totalDuplicates} redundant re-reads across sessions. Top repeats: ${worst}. Each re-read loads the same content into context again.`,
    impact: totalDuplicates > DUPLICATE_READS_HIGH_THRESHOLD ? 'high' : totalDuplicates > DUPLICATE_READS_MEDIUM_THRESHOLD ? 'medium' : 'low',
    tokensSaved,
    fix: {
      type: 'paste',
      label: 'Point agent at exact locations in your prompt, for example:',
      text: 'In <file> lines <start>-<end>, look at the <function> function.',
    },
    trend,
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
    title: 'Agent edits more than it reads',
    explanation: `Agent made ${reads} reads and ${edits} edits (ratio ${ratio.toFixed(1)}:1). A healthy ratio is ${HEALTHY_READ_EDIT_RATIO}+ reads per edit. Editing without reading leads to retries and wasted tokens.`,
    impact,
    tokensSaved,
    fix: {
      type: 'paste',
      label: 'Add to your agent rules:',
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
      label: 'Check for agent rules bloat or large context files.',
      text: 'Review CLAUDE.md, .cursor/rules, and other context files for excessive content.',
    },
    trend,
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
  const { toolCalls, apiCalls } = await scanSessions(dateRange)

  const findings: WasteFinding[] = []
  const detectors: Array<() => WasteFinding | null> = [
    () => detectCacheBloat(apiCalls, projects, dateRange),
    () => detectLowReadEditRatio(toolCalls),
    () => detectJunkReads(toolCalls, dateRange),
    () => detectDuplicateReads(toolCalls, dateRange),
    () => detectBashBloat(),
  ]
  for (const detect of detectors) {
    const finding = detect()
    if (finding) findings.push(finding)
  }

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
    lines.push(chalk.dim('  CodeBurn optimize scans your Augment sessions for token waste:'))
    lines.push(chalk.dim('  junk directory reads, duplicate file reads, and more.'))
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

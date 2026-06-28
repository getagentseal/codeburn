import { existsSync } from 'fs'
import { basename, join } from 'path'

import { readSessionFileSync } from '../fs-utils.js'
import type { DateRange, ProjectSummary } from '../types.js'
import { formatTokens } from '../format.js'
import {
  JUNK_DIRS,
  JUNK_PATTERN,
  AVG_TOKENS_PER_READ,
  MIN_JUNK_READS_TO_FLAG,
  JUNK_READS_HIGH_THRESHOLD,
  JUNK_READS_MEDIUM_THRESHOLD,
  TOP_ITEMS_PREVIEW,
  MIN_DUPLICATE_READS_TO_FLAG,
  DUPLICATE_READS_HIGH_THRESHOLD,
  DUPLICATE_READS_MEDIUM_THRESHOLD,
  MAX_IMPORT_DEPTH,
  IMPORT_PATTERN,
  CLAUDEMD_HEALTHY_LINES,
  CLAUDEMD_HIGH_THRESHOLD_LINES,
  CLAUDEMD_TOKENS_PER_LINE,
  READ_TOOL_NAMES,
  EDIT_TOOL_NAMES,
  MIN_EDITS_FOR_RATIO,
  HEALTHY_READ_EDIT_RATIO,
  LOW_RATIO_HIGH_THRESHOLD,
  LOW_RATIO_MEDIUM_THRESHOLD,
  IMPROVING_THRESHOLD,
  DEFAULT_CACHE_BASELINE_TOKENS,
  CACHE_BASELINE_QUANTILE,
  MIN_API_CALLS_FOR_CACHE,
  CACHE_BLOAT_MULTIPLIER,
  CACHE_VERSION_MIN_SAMPLES,
  CACHE_VERSION_DIFF_THRESHOLD,
  CACHE_EXCESS_HIGH_THRESHOLD,
} from './constants.js'
import type { ToolCall, ApiCallMeta, WasteFinding, Impact, Trend } from './types.js'
import { isReadTool, shortHomePath } from './scan.js'
import { sessionTrend } from './health.js'

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
      destination: 'claude-md',
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
      destination: 'prompt',
      label: 'Point Claude at exact locations in your prompt, for example:',
      text: 'In <file> lines <start>-<end>, look at the <function> function.',
    },
    trend,
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
      destination: 'prompt',
      label: 'Ask Claude in the current session to trim it:',
      text: `Review CLAUDE.md and all @-imported files. Cut total expanded content to under ${CLAUDEMD_HEALTHY_LINES} lines. Remove anything Claude can figure out from the code itself. Keep only rules, gotchas, and non-obvious conventions.`,
    },
  }
}

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
      destination: 'claude-md',
      label: 'Add to your CLAUDE.md:',
      text: 'Before editing any file, read it first. Before modifying a function, grep for all callers. Research before you edit.',
    },
    trend,
  }
}

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
      destination: 'shell-config',
      label: 'Check for recent Claude Code updates or heavy MCP/skill additions. As a workaround (not officially supported), add to ~/.zshrc or ~/.bashrc:',
      text: 'export ANTHROPIC_CUSTOM_HEADERS=\'User-Agent: claude-cli/2.1.98 (external, sdk-cli)\'',
    },
    trend,
  }
}

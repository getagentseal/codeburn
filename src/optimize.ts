import chalk from 'chalk'
import { readdir, readFile, stat } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { basename, join } from 'path'
import { homedir } from 'os'

import { discoverAllSessions } from './providers/index.js'
import type { DateRange, ProjectSummary } from './types.js'
import { formatCost } from './currency.js'
import { formatTokens } from './format.js'

const ORANGE = '#FF8C42'
const DIM = '#666666'
const GOLD = '#FFD700'
const CYAN = '#5BF5E0'
const GREEN = '#5BF5A0'

const JUNK_DIRS = [
  'node_modules', '.git', 'dist', 'build', '__pycache__', '.next',
  '.nuxt', '.output', 'coverage', '.cache', '.tsbuildinfo',
  '.venv', 'venv', '.svn', '.hg',
]
const JUNK_PATTERN = new RegExp(`/(${JUNK_DIRS.join('|')})/`)

const AVG_TOKENS_PER_READ = 1500
const TOKENS_PER_MCP_TOOL = 400
const CLAUDEMD_HEALTHY_LINES = 200

export type WasteAction =
  | { type: 'paste'; label: string; text: string }
  | { type: 'command'; label: string; text: string }
  | { type: 'file-content'; label: string; path: string; content: string }

export type WasteFinding = {
  title: string
  explanation: string
  impact: 'high' | 'medium' | 'low'
  tokensSaved: number
  fix: WasteAction
}

export type OptimizeResult = {
  findings: WasteFinding[]
  costRate: number
}

type ToolCall = {
  name: string
  input: Record<string, unknown>
  sessionId: string
  project: string
}

type ApiCallMeta = {
  cacheCreationTokens: number
  version: string
}

type ScanData = {
  toolCalls: ToolCall[]
  projectCwds: Set<string>
  apiCalls: ApiCallMeta[]
  versions: Set<string>
}

const IMPACT_ORDER: Record<string, number> = { high: 3, medium: 2, low: 1 }

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

type ScanFileResult = {
  calls: ToolCall[]
  cwds: string[]
  apiCalls: ApiCallMeta[]
  versions: string[]
}

async function scanJsonlFile(
  filePath: string,
  project: string,
  dateRange: DateRange | undefined,
): Promise<ScanFileResult> {
  let content: string
  try {
    content = await readFile(filePath, 'utf-8')
  } catch { return { calls: [], cwds: [], apiCalls: [], versions: [] } }

  const calls: ToolCall[] = []
  const cwds: string[] = []
  const apiCalls: ApiCallMeta[] = []
  const versions: string[] = []
  const sessionId = basename(filePath, '.jsonl')

  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    let entry: Record<string, unknown>
    try { entry = JSON.parse(line) } catch { continue }

    if (entry.cwd && typeof entry.cwd === 'string') cwds.push(entry.cwd)
    if (entry.version && typeof entry.version === 'string') versions.push(entry.version)

    if (entry.type !== 'assistant') continue

    if (dateRange && typeof entry.timestamp === 'string') {
      const ts = new Date(entry.timestamp)
      if (ts < dateRange.start || ts > dateRange.end) continue
    }

    const msg = entry.message as Record<string, unknown> | undefined
    const usage = msg?.usage as Record<string, unknown> | undefined
    if (usage) {
      const cacheCreate = (usage.cache_creation_input_tokens as number) ?? 0
      const ver = versions[versions.length - 1] ?? ''
      if (cacheCreate > 0) apiCalls.push({ cacheCreationTokens: cacheCreate, version: ver })
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
      })
    }
  }

  return { calls, cwds, apiCalls, versions }
}

async function scanSessions(dateRange?: DateRange): Promise<ScanData> {
  const sources = await discoverAllSessions('claude')
  const allCalls: ToolCall[] = []
  const allCwds = new Set<string>()
  const allApiCalls: ApiCallMeta[] = []
  const allVersions = new Set<string>()

  for (const source of sources) {
    const files = await collectJsonlFiles(source.path)
    for (const file of files) {
      const { calls, cwds, apiCalls, versions } = await scanJsonlFile(file, source.project, dateRange)
      allCalls.push(...calls)
      for (const cwd of cwds) allCwds.add(cwd)
      allApiCalls.push(...apiCalls)
      for (const v of versions) if (v) allVersions.add(v)
    }
  }

  return { toolCalls: allCalls, projectCwds: allCwds, apiCalls: allApiCalls, versions: allVersions }
}

function detectJunkReads(calls: ToolCall[]): WasteFinding | null {
  const readCalls = calls.filter(c => c.name === 'Read' || c.name === 'FileReadTool')

  const dirCounts = new Map<string, number>()
  let totalJunkReads = 0

  for (const call of readCalls) {
    const filePath = call.input.file_path as string | undefined
    if (!filePath) continue
    if (!JUNK_PATTERN.test(filePath)) continue

    totalJunkReads++
    for (const dir of JUNK_DIRS) {
      if (filePath.includes(`/${dir}/`)) {
        dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1)
        break
      }
    }
  }

  if (totalJunkReads < 3) return null

  const sorted = [...dirCounts.entries()].sort((a, b) => b[1] - a[1])
  const dirList = sorted.slice(0, 3).map(([d, n]) => `${d}/ (${n}x)`).join(', ')
  const tokensSaved = totalJunkReads * AVG_TOKENS_PER_READ

  const detected = sorted.map(([d]) => d)
  const extras = ['node_modules', '.git', 'dist', '__pycache__']
    .filter(d => !dirCounts.has(d))
    .slice(0, Math.max(0, 6 - detected.length))
  const ignoreContent = [...detected, ...extras].join('\n')

  return {
    title: 'STOP READING JUNK DIRECTORIES',
    explanation: `Claude read into ${dirList} -- ${totalJunkReads} times total. Each read loads ~${AVG_TOKENS_PER_READ.toLocaleString()} tokens of irrelevant content into context. A .claudeignore blocks this.`,
    impact: totalJunkReads > 20 ? 'high' : totalJunkReads > 5 ? 'medium' : 'low',
    tokensSaved,
    fix: {
      type: 'file-content',
      label: 'Create .claudeignore in your project root:',
      path: '.claudeignore',
      content: ignoreContent,
    },
  }
}

function detectDuplicateReads(calls: ToolCall[]): WasteFinding | null {
  const readCalls = calls.filter(c => c.name === 'Read' || c.name === 'FileReadTool')

  const sessionFiles = new Map<string, Map<string, number>>()

  for (const call of readCalls) {
    const filePath = call.input.file_path as string | undefined
    if (!filePath || JUNK_PATTERN.test(filePath)) continue

    const key = `${call.project}:${call.sessionId}`
    if (!sessionFiles.has(key)) sessionFiles.set(key, new Map())
    const fm = sessionFiles.get(key)!
    fm.set(filePath, (fm.get(filePath) ?? 0) + 1)
  }

  let totalDuplicates = 0
  const fileDupes = new Map<string, number>()

  for (const fm of sessionFiles.values()) {
    for (const [file, count] of fm) {
      if (count <= 1) continue
      const extra = count - 1
      totalDuplicates += extra
      const name = basename(file)
      fileDupes.set(name, (fileDupes.get(name) ?? 0) + extra)
    }
  }

  if (totalDuplicates < 5) return null

  const worst = [...fileDupes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, n]) => `${name} (+${n})`)
    .join(', ')

  const tokensSaved = totalDuplicates * AVG_TOKENS_PER_READ

  return {
    title: 'CUT DUPLICATE FILE READS',
    explanation: `Claude re-read the same file ${totalDuplicates} times across sessions. Top offenders: ${worst}. Each re-read loads ~${AVG_TOKENS_PER_READ.toLocaleString()} tokens that are already in context.`,
    impact: totalDuplicates > 30 ? 'high' : totalDuplicates > 10 ? 'medium' : 'low',
    tokensSaved,
    fix: {
      type: 'paste',
      label: 'Give Claude exact locations so it reads once:',
      text: 'Look at src/auth.ts lines 45-80, the validateToken function.',
    },
  }
}

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch { return null }
}

function detectUnusedMcp(
  calls: ToolCall[],
  projects: ProjectSummary[],
  projectCwds: Set<string>,
): WasteFinding | null {
  const configuredServers = new Map<string, string>()

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
    const servers = (config.mcpServers ?? {}) as Record<string, unknown>
    for (const name of Object.keys(servers)) {
      const normalized = name.replace(/:/g, '_')
      configuredServers.set(normalized, name)
    }
  }

  if (configuredServers.size === 0) return null

  const calledServers = new Set<string>()
  for (const call of calls) {
    if (!call.name.startsWith('mcp__')) continue
    const seg = call.name.split('__')[1]
    if (seg) calledServers.add(seg)
  }
  for (const p of projects) {
    for (const s of p.sessions) {
      for (const server of Object.keys(s.mcpBreakdown)) {
        calledServers.add(server)
      }
    }
  }

  const unused: string[] = []
  for (const [normalized, original] of configuredServers) {
    if (!calledServers.has(normalized)) unused.push(original)
  }

  if (unused.length === 0) return null

  const totalSessions = projects.reduce((s, p) => s + p.sessions.length, 0)
  const estimatedTools = 5
  const schemaTokens = unused.length * estimatedTools * TOKENS_PER_MCP_TOOL
  const tokensSaved = schemaTokens * totalSessions

  return {
    title: 'REMOVE UNUSED MCP SERVERS',
    explanation: `${unused.length} MCP server${unused.length > 1 ? 's' : ''} configured but never called: ${unused.join(', ')}. Each loads ~${(estimatedTools * TOKENS_PER_MCP_TOOL).toLocaleString()} tokens of schema into every session (${totalSessions.toLocaleString()} sessions in this period).`,
    impact: unused.length >= 3 ? 'high' : 'medium',
    tokensSaved,
    fix: {
      type: 'command',
      label: `Remove unused server${unused.length > 1 ? 's' : ''}:`,
      text: unused.map(s => `claude mcp remove ${s}`).join('\n'),
    },
  }
}

function detectMissingClaudeignore(projectCwds: Set<string>): WasteFinding | null {
  const missing: string[] = []
  const hasJunkDir: string[] = []

  for (const cwd of projectCwds) {
    if (existsSync(join(cwd, '.claudeignore'))) continue
    if (!existsSync(cwd)) continue

    for (const dir of JUNK_DIRS) {
      if (existsSync(join(cwd, dir))) {
        missing.push(cwd)
        hasJunkDir.push(dir)
        break
      }
    }
  }

  if (missing.length === 0) return null

  const shortPaths = missing.map(p => {
    const home = homedir()
    return p.startsWith(home) ? '~' + p.slice(home.length) : p
  })
  const display = shortPaths.length <= 3
    ? shortPaths.join(', ')
    : `${shortPaths.slice(0, 2).join(', ')} + ${shortPaths.length - 2} more`

  const tokensSaved = missing.length * 10 * AVG_TOKENS_PER_READ

  return {
    title: 'ADD .claudeignore FILES',
    explanation: `${missing.length} project${missing.length > 1 ? 's' : ''} ha${missing.length > 1 ? 've' : 's'} junk directories (node_modules, .git, etc.) but no .claudeignore: ${display}. Without it, Claude may read/search these directories.`,
    impact: missing.length >= 3 ? 'high' : 'medium',
    tokensSaved,
    fix: {
      type: 'file-content',
      label: 'Create .claudeignore in each project root:',
      path: '.claudeignore',
      content: JUNK_DIRS.slice(0, 8).join('\n'),
    },
  }
}

function detectBloatedClaudeMd(projectCwds: Set<string>): WasteFinding | null {
  const bloated: { path: string; lines: number }[] = []

  for (const cwd of projectCwds) {
    for (const name of ['CLAUDE.md', '.claude/CLAUDE.md']) {
      const fullPath = join(cwd, name)
      if (!existsSync(fullPath)) continue
      try {
        const content = readFileSync(fullPath, 'utf-8')
        const lineCount = content.split('\n').length
        if (lineCount > CLAUDEMD_HEALTHY_LINES) {
          const short = cwd.startsWith(homedir()) ? '~' + cwd.slice(homedir().length) : cwd
          bloated.push({ path: `${short}/${name}`, lines: lineCount })
        }
      } catch { continue }
    }
  }

  if (bloated.length === 0) return null

  const sorted = bloated.sort((a, b) => b.lines - a.lines)
  const worst = sorted[0]
  const totalExtraLines = sorted.reduce((s, b) => s + (b.lines - CLAUDEMD_HEALTHY_LINES), 0)
  const tokensPerLine = 25
  const tokensSaved = totalExtraLines * tokensPerLine

  const list = sorted.slice(0, 3).map(b => `${b.path} (${b.lines} lines)`).join(', ')

  return {
    title: 'TRIM BLOATED CLAUDE.md',
    explanation: `${list}. Every line loads into every API call as context. Beyond ${CLAUDEMD_HEALTHY_LINES} lines, the extra ~${totalExtraLines} lines cost ~${formatTokens(tokensSaved)} tokens per call.`,
    impact: worst.lines > 400 ? 'high' : 'medium',
    tokensSaved,
    fix: {
      type: 'paste',
      label: 'Ask Claude to trim it:',
      text: 'Review CLAUDE.md and cut it to under 200 lines. Remove anything Claude can figure out from the code itself: file paths, architecture, imports. Keep only: rules, gotchas, and non-obvious conventions.',
    },
  }
}

const READ_TOOL_NAMES = new Set(['Read', 'Grep', 'Glob', 'FileReadTool', 'GrepTool', 'GlobTool'])
const EDIT_TOOL_NAMES = new Set(['Edit', 'Write', 'FileEditTool', 'FileWriteTool', 'NotebookEdit'])

function detectLowReadEditRatio(calls: ToolCall[]): WasteFinding | null {
  let reads = 0
  let edits = 0

  for (const call of calls) {
    if (READ_TOOL_NAMES.has(call.name)) reads++
    else if (EDIT_TOOL_NAMES.has(call.name)) edits++
  }

  if (edits < 10) return null

  const ratio = reads / edits
  if (ratio >= 4) return null

  const ratioStr = ratio.toFixed(1)
  const impact: 'high' | 'medium' | 'low' = ratio < 2 ? 'high' : ratio < 3 ? 'medium' : 'low'

  const extraReadsNeeded = Math.round(edits * 4) - reads
  const tokensSaved = extraReadsNeeded * AVG_TOKENS_PER_READ

  return {
    title: 'CLAUDE IS EDITING WITHOUT READING',
    explanation: `Read:Edit ratio is ${ratioStr}:1 (${reads} reads, ${edits} edits). Healthy is 4:1+. A low ratio means Claude edits files without fully understanding the codebase first -- leading to more retries and wasted tokens.`,
    impact,
    tokensSaved: Math.max(tokensSaved, 0),
    fix: {
      type: 'paste',
      label: 'Add to your CLAUDE.md:',
      text: 'Before editing any file, read it first. Before modifying a function, grep for all callers. Research before you edit.',
    },
  }
}

function detectCacheBloat(apiCalls: ApiCallMeta[]): WasteFinding | null {
  if (apiCalls.length < 10) return null

  const sorted = apiCalls.map(c => c.cacheCreationTokens).sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]

  if (median < 55000) return null

  const versionCounts = new Map<string, { total: number; count: number }>()
  for (const call of apiCalls) {
    if (!call.version) continue
    const v = call.version
    const entry = versionCounts.get(v) ?? { total: 0, count: 0 }
    entry.total += call.cacheCreationTokens
    entry.count++
    versionCounts.set(v, entry)
  }

  const versionAvgs = [...versionCounts.entries()]
    .filter(([, d]) => d.count >= 5)
    .map(([v, d]) => ({ version: v, avg: Math.round(d.total / d.count), count: d.count }))
    .sort((a, b) => b.avg - a.avg)

  const excess = median - 50000
  const tokensSaved = excess * apiCalls.length

  let versionNote = ''
  if (versionAvgs.length >= 2) {
    const highest = versionAvgs[0]
    const lowest = versionAvgs[versionAvgs.length - 1]
    if (highest.avg - lowest.avg > 10000) {
      versionNote = ` Version ${highest.version} averages ${formatTokens(highest.avg)} vs ${lowest.version} at ${formatTokens(lowest.avg)}.`
    }
  }

  return {
    title: 'HIGH CACHE CREATION OVERHEAD',
    explanation: `Median cache_creation per call is ${formatTokens(median)} tokens (baseline ~50K). The extra ~${formatTokens(excess)} tokens per call may be server-injected content invisible to you.${versionNote} See anthropics/claude-code#46917.`,
    impact: excess > 15000 ? 'high' : 'medium',
    tokensSaved,
    fix: {
      type: 'paste',
      label: 'Spoof older User-Agent to reduce overhead:',
      text: 'export ANTHROPIC_CUSTOM_HEADERS=\'User-Agent: claude-cli/2.1.98 (external, sdk-cli)\'',
    },
  }
}

function detectBashBloat(): WasteFinding | null {
  const current = process.env['BASH_MAX_OUTPUT_LENGTH']
  if (current && parseInt(current, 10) <= 15000) return null

  const limit = current ? parseInt(current, 10) : 30000
  const saved = limit - 15000
  const tokensSaved = Math.round(saved * 0.25)

  return {
    title: 'CAP BASH OUTPUT LENGTH',
    explanation: `Bash output limit is ${(limit / 1000).toFixed(0)}K characters (${current ? 'configured' : 'default'}). Most useful output is under 15K. The extra ${(saved / 1000).toFixed(0)}K chars waste ~${formatTokens(tokensSaved)} tokens per bash call.`,
    impact: 'medium',
    tokensSaved,
    fix: {
      type: 'paste',
      label: 'Add to your shell profile (~/.zshrc or ~/.bashrc):',
      text: 'export BASH_MAX_OUTPUT_LENGTH=15000',
    },
  }
}

function computeInputCostRate(projects: ProjectSummary[]): number {
  const sessions = projects.flatMap(p => p.sessions)
  const totalCost = sessions.reduce((s, sess) => s + sess.totalCostUSD, 0)
  const totalTokens = sessions.reduce((s, sess) =>
    s + sess.totalInputTokens + sess.totalCacheReadTokens + sess.totalCacheWriteTokens, 0)
  if (totalTokens === 0 || totalCost === 0) return 1 / 1_000_000
  return (totalCost * 0.7) / totalTokens
}

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

const IMPACT_COLORS: Record<string, string> = { high: '#F55B5B', medium: ORANGE, low: DIM }

function renderFinding(n: number, f: WasteFinding, costRate: number, W: number): string[] {
  const lines: string[] = []
  const sep = '\u2500'
  const costSaved = f.tokensSaved * costRate
  const impactLabel = f.impact.charAt(0).toUpperCase() + f.impact.slice(1)
  const savings = `~${formatTokens(f.tokensSaved)} tokens (~${formatCost(costSaved)})`
  const titlePad = W - f.title.length - impactLabel.length - 8
  const pad = titlePad > 0 ? ' ' + sep.repeat(titlePad) + ' ' : '  '

  lines.push(chalk.hex(DIM)(`  ${sep}${sep}${sep} `) +
    chalk.bold(`${n}. ${f.title}`) +
    chalk.hex(DIM)(pad) +
    chalk.hex(IMPACT_COLORS[f.impact] ?? DIM)(impactLabel) +
    chalk.hex(DIM)(` ${sep}${sep}${sep}`))
  lines.push('')
  lines.push(wrap(f.explanation, W - 4, '  '))
  lines.push('')
  lines.push(chalk.hex(GOLD)(`  Potential savings: ${savings}`))
  lines.push('')

  const a = f.fix
  if (a.type === 'file-content') {
    lines.push(chalk.hex(DIM)(`  ${a.label}`))
    for (const line of a.content.split('\n')) {
      lines.push(chalk.hex(CYAN)(`    ${line}`))
    }
  } else if (a.type === 'command') {
    lines.push(chalk.hex(DIM)(`  ${a.label}`))
    for (const line of a.text.split('\n')) {
      lines.push(chalk.hex(CYAN)(`    ${line}`))
    }
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
): string {
  const lines: string[] = []
  const W = 62
  const sep = '\u2500'

  lines.push('')
  lines.push(`  ${chalk.bold.hex(ORANGE)('CodeBurn Optimize')}${chalk.dim('  ' + periodLabel)}`)
  lines.push(chalk.hex(DIM)('  ' + sep.repeat(W)))

  lines.push('  ' + [
    `${sessionCount} sessions`,
    `${callCount.toLocaleString()} calls`,
    chalk.hex(GOLD)(formatCost(periodCost)),
  ].join(chalk.hex(DIM)('   ')))
  lines.push('')

  if (findings.length === 0) {
    lines.push(chalk.hex(GREEN)('  No waste detected -- your setup looks clean.'))
    lines.push('')
    return lines.join('\n')
  }

  const totalTokens = findings.reduce((s, f) => s + f.tokensSaved, 0)
  const totalCost = totalTokens * costRate
  const pctRaw = periodCost > 0 ? (totalCost / periodCost) * 100 : 0
  const pct = pctRaw >= 1 ? pctRaw.toFixed(0) : pctRaw.toFixed(1)

  lines.push(chalk.hex(GREEN)(`  Potential savings: ~${formatTokens(totalTokens)} tokens (~${formatCost(totalCost)}, ~${pct}% of spend)`))
  lines.push('')

  const sorted = findings.sort((a, b) =>
    (IMPACT_ORDER[b.impact] ?? 0) - (IMPACT_ORDER[a.impact] ?? 0) || b.tokensSaved - a.tokensSaved
  )

  for (let i = 0; i < sorted.length; i++) {
    lines.push(...renderFinding(i + 1, sorted[i], costRate, W))
  }

  lines.push(chalk.hex(DIM)('  ' + sep.repeat(W)))
  lines.push(chalk.dim('  Token estimates are approximate. Actual savings vary by file size and model.'))
  lines.push('')

  return lines.join('\n')
}

export async function scanAndDetect(
  projects: ProjectSummary[],
  dateRange?: DateRange,
): Promise<OptimizeResult> {
  const costRate = computeInputCostRate(projects)
  const { toolCalls, projectCwds, apiCalls } = await scanSessions(dateRange)

  const findings: WasteFinding[] = []
  const detectors = [
    () => detectCacheBloat(apiCalls),
    () => detectLowReadEditRatio(toolCalls),
    () => detectJunkReads(toolCalls),
    () => detectDuplicateReads(toolCalls),
    () => detectUnusedMcp(toolCalls, projects, projectCwds),
    () => detectMissingClaudeignore(projectCwds),
    () => detectBloatedClaudeMd(projectCwds),
    () => detectBashBloat(),
  ]

  for (const detect of detectors) {
    const finding = detect()
    if (finding) findings.push(finding)
  }

  findings.sort((a, b) =>
    (IMPACT_ORDER[b.impact] ?? 0) - (IMPACT_ORDER[a.impact] ?? 0) || b.tokensSaved - a.tokensSaved
  )

  return { findings, costRate }
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

  process.stderr.write(chalk.dim('  Scanning sessions for waste patterns...\n'))

  const { findings, costRate } = await scanAndDetect(projects, dateRange)
  const sessions = projects.flatMap(p => p.sessions)
  const periodCost = projects.reduce((s, p) => s + p.totalCostUSD, 0)
  const callCount = projects.reduce((s, p) => s + p.totalApiCalls, 0)

  const output = renderOptimize(findings, costRate, periodLabel, periodCost, sessions.length, callCount)
  console.log(output)
}

import chalk from 'chalk'

import { formatCost } from './currency.js'
import { CATEGORY_LABELS, type ProjectSummary, type SessionSummary, type TaskCategory, type TokenUsage } from './types.js'

const ORANGE = '#ff8c42'
const GOLD = '#ffd700'
const DIM = '#888888'
const PANEL_WIDTH = 76
const TURN_PROMPT_LIMIT = 220
const LIST_LIMIT = 5

export type ReplayMatch = {
  project: ProjectSummary
  session: SessionSummary
}

export type ReplayCall = {
  provider: string
  model: string
  costUSD: number
  usage: TokenUsage
  tools: string[]
  mcpTools: string[]
  skills: string[]
  bashCommands: string[]
  speed: 'standard' | 'fast'
}

export type ReplayTurn = {
  index: number
  timestamp: string
  category: TaskCategory
  subCategory?: string
  userMessage: string | null
  costUSD: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  calls: ReplayCall[]
  tools: Record<string, number>
  mcpTools: Record<string, number>
  skills: Record<string, number>
  bashCommands: string[]
  retries: number
  hasEdits: boolean
}

export type ReplayResult = {
  project: string
  projectPath: string
  sessionId: string
  firstTimestamp: string
  lastTimestamp: string
  totalCostUSD: number
  apiCalls: number
  turns: ReplayTurn[]
}

function normalizeQuery(value: string): string {
  return value.trim().toLowerCase()
}

export function findReplaySessions(projects: ProjectSummary[], query: string): ReplayMatch[] {
  const normalized = normalizeQuery(query)
  if (!normalized) return []

  const matches: ReplayMatch[] = []
  for (const project of projects) {
    for (const session of project.sessions) {
      if (session.sessionId.toLowerCase() === normalized) {
        matches.push({ project, session })
      }
    }
  }
  if (matches.length > 0) return matches

  for (const project of projects) {
    for (const session of project.sessions) {
      if (session.sessionId.toLowerCase().startsWith(normalized)) {
        matches.push({ project, session })
      }
    }
  }
  return matches
}

function increment(map: Map<string, number>, key: string): void {
  if (!key) return
  map.set(key, (map.get(key) ?? 0) + 1)
}

function sortedRecord(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))
}

function turnCost(calls: ReplayCall[]): number {
  return calls.reduce((sum, call) => sum + call.costUSD, 0)
}

function tokenSum(calls: ReplayCall[], key: keyof TokenUsage): number {
  return calls.reduce((sum, call) => sum + call.usage[key], 0)
}

export function buildReplayResult(match: ReplayMatch, options: { includePrompts: boolean }): ReplayResult {
  const turns: ReplayTurn[] = match.session.turns.map((turn, index) => {
    const tools = new Map<string, number>()
    const mcpTools = new Map<string, number>()
    const skills = new Map<string, number>()
    const bashCommands: string[] = []
    const calls = turn.assistantCalls.map(call => {
      for (const tool of call.tools) increment(tools, tool)
      for (const tool of call.mcpTools) increment(mcpTools, tool)
      for (const skill of call.skills) increment(skills, skill)
      for (const command of call.bashCommands) {
        if (command) bashCommands.push(command)
      }

      return {
        provider: call.provider,
        model: call.model,
        costUSD: call.costUSD,
        usage: call.usage,
        tools: call.tools,
        mcpTools: call.mcpTools,
        skills: call.skills,
        bashCommands: call.bashCommands,
        speed: call.speed,
      }
    })

    return {
      index: index + 1,
      timestamp: turn.timestamp,
      category: turn.category,
      ...(turn.subCategory ? { subCategory: turn.subCategory } : {}),
      userMessage: options.includePrompts ? turn.userMessage : null,
      costUSD: turnCost(calls),
      inputTokens: tokenSum(calls, 'inputTokens'),
      outputTokens: tokenSum(calls, 'outputTokens'),
      cacheReadTokens: tokenSum(calls, 'cacheReadInputTokens'),
      cacheWriteTokens: tokenSum(calls, 'cacheCreationInputTokens'),
      calls,
      tools: sortedRecord(tools),
      mcpTools: sortedRecord(mcpTools),
      skills: sortedRecord(skills),
      bashCommands,
      retries: turn.retries,
      hasEdits: turn.hasEdits,
    }
  })

  return {
    project: match.project.project,
    projectPath: match.project.projectPath,
    sessionId: match.session.sessionId,
    firstTimestamp: match.session.firstTimestamp,
    lastTimestamp: match.session.lastTimestamp,
    totalCostUSD: match.session.totalCostUSD,
    apiCalls: match.session.apiCalls,
    turns,
  }
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`
}

function formatTokens(value: number): string {
  return value.toLocaleString('en-US')
}

function categoryLabel(category: TaskCategory, subCategory?: string): string {
  const base = CATEGORY_LABELS[category] ?? category
  return subCategory ? `${base} / ${subCategory}` : base
}

function formatCountRecord(record: Record<string, number>, limit = LIST_LIMIT): string {
  const entries = Object.entries(record)
  if (entries.length === 0) return '-'
  const shown = entries.slice(0, limit).map(([name, count]) => `${name}${count > 1 ? ` x${count}` : ''}`)
  const hidden = entries.length - shown.length
  return hidden > 0 ? `${shown.join(', ')} +${hidden} more` : shown.join(', ')
}

function formatModels(calls: ReplayCall[]): string {
  const models = new Map<string, number>()
  for (const call of calls) increment(models, call.model)
  return formatCountRecord(sortedRecord(models))
}

function formatShell(commands: string[]): string {
  if (commands.length === 0) return '-'
  const shown = commands.slice(0, 3).map(command => truncate(command, 52))
  const hidden = commands.length - shown.length
  return hidden > 0 ? `${shown.join(' | ')} +${hidden} more` : shown.join(' | ')
}

export function renderReplayText(result: ReplayResult): string {
  const lines: string[] = []
  const totalInput = result.turns.reduce((sum, turn) => sum + turn.inputTokens, 0)
  const totalOutput = result.turns.reduce((sum, turn) => sum + turn.outputTokens, 0)
  const totalCacheRead = result.turns.reduce((sum, turn) => sum + turn.cacheReadTokens, 0)
  const totalCacheWrite = result.turns.reduce((sum, turn) => sum + turn.cacheWriteTokens, 0)

  lines.push('')
  lines.push(`  ${chalk.bold.hex(ORANGE)('CodeBurn session replay')}`)
  lines.push(chalk.hex(DIM)(`  ${'-'.repeat(PANEL_WIDTH)}`))
  lines.push(`  Project: ${chalk.bold(result.project)} ${chalk.hex(DIM)(result.projectPath)}`)
  lines.push(`  Session: ${result.sessionId}`)
  lines.push(`  Window:  ${result.firstTimestamp} -> ${result.lastTimestamp}`)
  lines.push(`  Spend:   ${chalk.hex(GOLD)(formatCost(result.totalCostUSD))}  ${plural(result.turns.length, 'turn')}  ${plural(result.apiCalls, 'call')}`)
  lines.push(`  Tokens:  in ${formatTokens(totalInput)}  out ${formatTokens(totalOutput)}  cache read ${formatTokens(totalCacheRead)}  cache write ${formatTokens(totalCacheWrite)}`)
  lines.push('')

  if (result.turns.length === 0) {
    lines.push(chalk.hex(DIM)('  No turns found in this session.'))
    lines.push('')
    return lines.join('\n')
  }

  for (const turn of result.turns) {
    const title = `Turn ${turn.index}`
    const meta = [
      turn.timestamp || 'unknown time',
      categoryLabel(turn.category, turn.subCategory),
      formatCost(turn.costUSD),
      plural(turn.calls.length, 'call'),
    ].join('  ')

    lines.push(`  ${chalk.bold(title)} ${chalk.hex(DIM)(meta)}`)
    if (turn.userMessage !== null) {
      lines.push(`    Prompt: ${truncate(turn.userMessage || '(empty)', TURN_PROMPT_LIMIT)}`)
    } else {
      lines.push(chalk.hex(DIM)('    Prompt: hidden by --no-prompts'))
    }
    lines.push(`    Models: ${formatModels(turn.calls)}`)
    lines.push(`    Tools:  ${formatCountRecord(turn.tools)}`)
    if (Object.keys(turn.mcpTools).length > 0) {
      lines.push(`    MCP:    ${formatCountRecord(turn.mcpTools)}`)
    }
    if (Object.keys(turn.skills).length > 0) {
      lines.push(`    Skills: ${formatCountRecord(turn.skills)}`)
    }
    lines.push(`    Shell:  ${formatShell(turn.bashCommands)}`)
    if (turn.retries > 0 || turn.hasEdits) {
      lines.push(chalk.hex(DIM)(`    Flags:  ${turn.hasEdits ? 'edits' : 'no edits'}${turn.retries > 0 ? `, ${plural(turn.retries, 'retry', 'retries')}` : ''}`))
    }
    lines.push('')
  }

  return lines.join('\n')
}

export function renderReplayCandidates(matches: ReplayMatch[], query: string): string {
  const lines: string[] = []
  lines.push('')
  lines.push(`  Multiple sessions matched "${query}":`)
  for (const { project, session } of matches.slice(0, 10)) {
    lines.push(`  ${session.sessionId}  ${project.project}  ${formatCost(session.totalCostUSD)}  ${session.firstTimestamp}`)
  }
  const hidden = matches.length - 10
  if (hidden > 0) lines.push(`  ...and ${plural(hidden, 'more match', 'more matches')}`)
  lines.push('')
  lines.push('  Use a longer session id prefix to select exactly one session.')
  lines.push('')
  return lines.join('\n')
}

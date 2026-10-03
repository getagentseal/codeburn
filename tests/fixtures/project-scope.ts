import type { DailyEntry, ProjectDayStats } from '../../src/daily-cache.js'
import type { DateRange, ProjectSummary, SessionSummary, TaskCategory, TokenUsage } from '../../src/types.js'

const FIXTURE_TIMESTAMP = '2026-10-02T12:00:00.000Z'
const FIXTURE_PROVIDER = 'claude'
const FIXTURE_TOKENS: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
  webSearchRequests: 0,
}

const FIXTURE_CATEGORY = { turns: 1, costUSD: 0, savingsUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 }
const FIXTURE_CATEGORIES: SessionSummary['categoryBreakdown'] = {
  coding: FIXTURE_CATEGORY,
  debugging: FIXTURE_CATEGORY,
  feature: FIXTURE_CATEGORY,
  refactoring: FIXTURE_CATEGORY,
  testing: FIXTURE_CATEGORY,
  exploration: FIXTURE_CATEGORY,
  planning: FIXTURE_CATEGORY,
  delegation: FIXTURE_CATEGORY,
  git: FIXTURE_CATEGORY,
  'build/deploy': FIXTURE_CATEGORY,
  conversation: FIXTURE_CATEGORY,
  brainstorming: FIXTURE_CATEGORY,
  general: FIXTURE_CATEGORY,
} satisfies Record<TaskCategory, SessionSummary['categoryBreakdown'][TaskCategory]>

export function project(name: string, path: string | undefined, cost: number, provider?: string): ProjectSummary {
  const sourceProvider = provider ?? FIXTURE_PROVIDER
  const model = `${sourceProvider}-fixture-model`
  const projectDiscriminator = path ? `path:${path}` : `label:${name}`
  const sessionId = `${sourceProvider}:${projectDiscriminator}`
  const deduplicationKey = `${sourceProvider}:${projectDiscriminator}:${FIXTURE_TIMESTAMP}`
  const call = {
    provider: sourceProvider,
    model,
    usage: FIXTURE_TOKENS,
    costUSD: cost,
    tools: [],
    mcpTools: [],
    skills: [],
    subagentTypes: [],
    hasAgentSpawn: false,
    hasPlanMode: false,
    speed: 'standard' as const,
    timestamp: FIXTURE_TIMESTAMP,
    bashCommands: [],
    deduplicationKey,
  }
  const session: SessionSummary = {
    sessionId,
    project: name,
    ...(path ? { workingDirectory: path } : {}),
    firstTimestamp: FIXTURE_TIMESTAMP,
    lastTimestamp: FIXTURE_TIMESTAMP,
    totalCostUSD: cost,
    totalSavingsUSD: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalReasoningTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    apiCalls: 1,
    turns: [{
      userMessage: 'fixture',
      assistantCalls: [call],
      timestamp: FIXTURE_TIMESTAMP,
      sessionId,
      category: 'coding',
      retries: 0,
      hasEdits: false,
    }],
    modelBreakdown: {
      [model]: { calls: 1, costUSD: cost, tokens: FIXTURE_TOKENS, savingsUSD: 0 },
    },
    toolBreakdown: {},
    mcpBreakdown: {},
    bashBreakdown: {},
    categoryBreakdown: { ...FIXTURE_CATEGORIES, coding: { ...FIXTURE_CATEGORIES.coding, costUSD: cost } },
    skillBreakdown: {},
    subagentBreakdown: {},
  }

  return {
    project: name,
    projectPath: path ?? '',
    sessions: [session],
    totalCostUSD: cost,
    totalSavingsUSD: 0,
    totalApiCalls: 1,
    totalProxiedCostUSD: 0,
  }
}

function projectDayStats(key: string, cost: number): ProjectDayStats {
  const pathPrefix = 'path:'
  const path = key.startsWith(pathPrefix) ? key.slice(pathPrefix.length) : undefined
  return {
    cost,
    calls: 1,
    savingsUSD: 0,
    sessions: 1,
    ...(path ? { path } : {}),
  }
}

function day(date: string, key: string, cost: number, provider?: string): DailyEntry {
  const stats = projectDayStats(key, cost)
  return {
    date,
    cost,
    savingsUSD: 0,
    calls: 1,
    sessions: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    editTurns: 0,
    oneShotTurns: 0,
    models: {},
    categories: {},
    providers: provider
      ? { [provider]: { calls: 1, cost, savingsUSD: 0, sessions: 1, projects: { [key]: stats } } }
      : {},
    projects: { [key]: stats },
  }
}

export function exactDay(date: string, id: string, cost: number, provider?: string): DailyEntry {
  return day(date, id, cost, provider)
}

export function legacyDay(date: string, label: string, cost: number): DailyEntry {
  return day(date, label, cost)
}

export function dateRange(from: string, to: string): DateRange {
  return {
    start: new Date(`${from}T00:00:00.000Z`),
    end: new Date(`${to}T23:59:59.999Z`),
  }
}

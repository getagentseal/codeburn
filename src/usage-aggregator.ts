import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CATEGORY_LABELS, type ProjectSummary, type TaskCategory, type DateRange } from './types.js'
import { type PeriodData, type ProviderCost, type BreakdownArrays, type MenubarPayload, type CodexChatsReport, type DailyHistoryEntry, buildMenubarPayload } from './menubar-json.js'
import { parseAllSessions, filterProjectsByName, filterProjectsByDays } from './parser.js'
import { getLocalModelSavingsConfigHash, getShortModelName } from './models.js'
import { getAllProviders } from './providers/index.js'
import { aggregateProjectsIntoDays, buildPeriodDataFromDays } from './day-aggregator.js'
import { aggregateModelEfficiency } from './model-efficiency.js'
import { scanAndDetect, type OptimizeResult } from './optimize.js'
import { openDatabase } from './sqlite.js'
import { getDaysInRange, ensureCacheHydrated, loadDailyCache, emptyCache, BACKFILL_DAYS, toDateString, type DailyCache } from './daily-cache.js'
import { readConfig, readPlans, type Plan, type TokenPackage } from './config.js'
import { computePeriodFromResetDay, isActivePlan } from './plan-usage.js'

export function buildPeriodData(label: string, projects: ProjectSummary[]): PeriodData {
  const sessions = projects.flatMap(p => p.sessions)
  const catTotals: Record<string, { turns: number; cost: number; savingsUSD: number; editTurns: number; oneShotTurns: number }> = {}
  const modelTotals: Record<string, { calls: number; cost: number; savingsUSD: number }> = {}
  let inputTokens = 0, outputTokens = 0, reasoningTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0

  for (const sess of sessions) {
    inputTokens += sess.totalInputTokens
    outputTokens += sess.totalOutputTokens
    reasoningTokens += sess.totalReasoningTokens ?? 0
    cacheReadTokens += sess.totalCacheReadTokens
    cacheWriteTokens += sess.totalCacheWriteTokens
    for (const [cat, d] of Object.entries(sess.categoryBreakdown)) {
      if (!catTotals[cat]) catTotals[cat] = { turns: 0, cost: 0, savingsUSD: 0, editTurns: 0, oneShotTurns: 0 }
      catTotals[cat].turns += d.turns
      catTotals[cat].cost += d.costUSD
      catTotals[cat].savingsUSD += d.savingsUSD
      catTotals[cat].editTurns += d.editTurns
      catTotals[cat].oneShotTurns += d.oneShotTurns
    }
    for (const [model, d] of Object.entries(sess.modelBreakdown)) {
      if (!modelTotals[model]) modelTotals[model] = { calls: 0, cost: 0, savingsUSD: 0 }
      modelTotals[model].calls += d.calls
      modelTotals[model].cost += d.costUSD
      modelTotals[model].savingsUSD += d.savingsUSD
    }
  }

  return {
    label,
    cost: projects.reduce((s, p) => s + p.totalCostUSD, 0),
    savingsUSD: projects.reduce((s, p) => s + p.totalSavingsUSD, 0),
    calls: projects.reduce((s, p) => s + p.totalApiCalls, 0),
    sessions: projects.reduce((s, p) => s + p.sessions.length, 0),
    inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens,
    categories: Object.entries(catTotals)
      .sort(([, a], [, b]) => b.cost - a.cost)
      .map(([cat, d]) => ({ name: CATEGORY_LABELS[cat as TaskCategory] ?? cat, ...d })),
    models: Object.entries(modelTotals)
      .sort(([, a], [, b]) => b.cost - a.cost)
      .map(([name, d]) => ({ name, ...d })),
  }
}

async function hydrateCache(): Promise<DailyCache> {
  try {
    return await ensureCacheHydrated(
      (range) => parseAllSessions(range, 'all'),
      aggregateProjectsIntoDays,
      getLocalModelSavingsConfigHash(),
    )
  } catch (err) {
    // Previously swallowed silently, which turned any backfill failure into an
    // empty trend/history with no signal (issue #441). Per-file parse errors no
    // longer reach here (they're isolated in parseProviderSources), so anything
    // that does is exceptional and worth surfacing.
    process.stderr.write(
      `codeburn: daily history backfill failed; the trend chart may be incomplete. ` +
      `${err instanceof Error ? err.message : String(err)}\n`
    )
    return emptyCache()
  }
}

export type PeriodInfo = { range: DateRange; label: string }
export type AggregateOpts = {
  provider?: string
  project?: string[]
  exclude?: string[]
  daysSelection?: { range: DateRange; label: string; days: Set<string> } | null
  optimize?: boolean
  chatHours?: number
}

type CodexStateChatRow = {
  id: string
  created_at: number
  updated_at: number
  tokens_used: number
  model?: string
  cwd?: string
  title?: string
  first_user_message?: string
}

function normalizeDisplayPath(pathValue: string): string {
  const normalized = pathValue.trim().replace(/\\/g, '/')
  if (normalized.startsWith('/')) return normalized.replace(/\/+/g, '/')
  if (normalized.startsWith('Users/')) return `/${normalized}`
  return normalized
}

function codexWorktreeSlug(pathValue: string): string | null {
  const parts = normalizeDisplayPath(pathValue).split('/').filter(Boolean)
  for (let i = 0; i < parts.length - 2; i++) {
    if (parts[i] === '.codex' && parts[i + 1] === 'worktrees') {
      return parts[i + 2] || null
    }
  }
  return null
}

function codexWorktreeTaskTitle(pathValue: string): string | null {
  const parts = normalizeDisplayPath(pathValue).split('/').filter(Boolean)
  for (let i = 0; i < parts.length - 3; i++) {
    if (parts[i] !== '.codex' || parts[i + 1] !== 'worktrees') continue
    let taskParts = parts.slice(i + 3)
    if (taskParts[0] === 'codex') taskParts = taskParts.slice(1)
    const title = prettySlug(taskParts.join('-'))
    return title || null
  }
  return null
}

function prettySlug(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function knownProjectNameForSlug(slug: string): string {
  const lower = slug.toLowerCase()
  const roots = [
    join(homedir(), 'Documents', 'Codex Project'),
    join(homedir(), 'Documents'),
  ]
  for (const root of roots) {
    if (!existsSync(root)) continue
    try {
      const entries = readdirSync(root, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (entry.name.toLowerCase() === lower) return entry.name
      }
    } catch {
      continue
    }
  }
  return prettySlug(slug)
}

function projectDisplayNameFromPath(
  pathValue: string,
  fallback: string,
): string {
  const resolved = normalizeDisplayPath(pathValue || fallback)
  const slug = codexWorktreeSlug(resolved)
  if (slug) return knownProjectNameForSlug(slug)
  const home = homedir()
  if (resolved === home || resolved === `${home}/`) return 'Home'
  return resolved.split('/').filter(Boolean).pop() || fallback
}

function fallbackChatTitle(
  projectPath: string,
  projectDisplayName: string,
  sessionDisplayId: string,
): string {
  return codexWorktreeTaskTitle(projectPath)
    ?? `${projectDisplayName} ${sessionDisplayId}`
}

function codexThreadIdFromSessionId(sessionId: string): string {
  const match = sessionId.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  )
  return match?.[0] ?? sessionId
}

function codexSessionDisplayId(sessionId: string): string {
  return codexThreadIdFromSessionId(sessionId).replace(/\.jsonl$/i, '').slice(-8)
}

type SubscriptionAdjustment = {
  adjustedCost: number
  subscriptionCost: number
  mode: 'amortized' | 'actual-payments'
  plans: NonNullable<BreakdownArrays['subscriptionPlans']>
  topUps: NonNullable<BreakdownArrays['subscriptionTopUps']>
  providerCosts: Record<string, number>
}

const MS_PER_DAY = 24 * 60 * 60 * 1000
const CODEX_STATE_LIVE_TOKEN_TTL_MS = 5 * 60 * 1000

function dayIndex(date: Date): number {
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / MS_PER_DAY)
}

function isoDay(date: Date): string {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).toISOString()
}

function inclusiveOverlapDays(aStart: Date, aEnd: Date, bStart: Date, bEndExclusive: Date): number {
  const start = Math.max(dayIndex(aStart), dayIndex(bStart))
  const end = Math.min(dayIndex(aEnd), dayIndex(new Date(bEndExclusive.getTime() - 1)))
  return Math.max(0, end - start + 1)
}

function planAppliesToProvider(plan: Plan, provider: string): boolean {
  return provider === 'all' || plan.provider === 'all' || plan.provider === provider
}

function packageAppliesToProvider(pkg: TokenPackage, provider: string): boolean {
  return provider === 'all' || pkg.provider === 'all' || pkg.provider === provider
}

function packageInRange(pkg: TokenPackage, range: DateRange): boolean {
  const purchasedAt = new Date(pkg.purchasedAt)
  return !Number.isNaN(purchasedAt.getTime()) && purchasedAt >= range.start && purchasedAt <= range.end
}

function aggregateProviderCostsFromProjects(projects: ProjectSummary[]): Record<string, number> {
  const totals: Record<string, number> = {}
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const turn of session.turns) {
        for (const call of turn.assistantCalls) {
          if (call.metadataOnly) continue
          totals[call.provider] = (totals[call.provider] ?? 0) + call.costUSD
        }
      }
    }
  }
  return totals
}

function scalePeriodCosts(data: PeriodData, scale: number): void {
  if (!Number.isFinite(scale) || scale <= 0 || scale === 1) return
  data.categories = data.categories.map(cat => ({ ...cat, cost: cat.cost * scale }))
  data.models = data.models.map(model => ({ ...model, cost: model.cost * scale }))
  data.projects = data.projects?.map(project => ({
    ...project,
    cost: project.cost * scale,
    sessionDetails: project.sessionDetails?.map(session => ({
      ...session,
      cost: session.cost * scale,
      models: session.models.map(model => ({ ...model, cost: model.cost * scale })),
    })),
  }))
  data.topSessions = data.topSessions?.map(session => ({ ...session, cost: session.cost * scale }))
  data.modelEfficiency = data.modelEfficiency?.map(model => ({
    ...model,
    costPerEdit: model.costPerEdit === null ? null : model.costPerEdit * scale,
  }))
}

function scaleDailyHistoryCosts(daily: DailyHistoryEntry[], range: DateRange, scale: number): DailyHistoryEntry[] {
  if (!Number.isFinite(scale) || scale <= 0 || scale === 1) return daily
  const start = toDateString(range.start)
  const end = toDateString(range.end)
  return daily.map(day => {
    if (day.date < start || day.date > end) return day
    return {
      ...day,
      cost: day.cost * scale,
      topModels: day.topModels.map(model => ({ ...model, cost: model.cost * scale })),
    }
  })
}

type AggregatedDay = ReturnType<typeof aggregateProjectsIntoDays>[number]

function dailyHistoryFromAggregatedDay(day: AggregatedDay): DailyHistoryEntry {
  const topModels = Object.entries(day.models)
    .filter(([name]) => name !== '<synthetic>')
    .sort(([, a], [, b]) => b.cost - a.cost)
    .slice(0, 5)
    .map(([name, model]) => ({
      name,
      cost: model.cost,
      savingsUSD: model.savingsUSD,
      calls: model.calls,
      inputTokens: model.inputTokens,
      outputTokens: model.outputTokens,
    }))
  return {
    date: day.date,
    cost: day.cost,
    savingsUSD: day.savingsUSD,
    calls: day.calls,
    inputTokens: day.inputTokens,
    outputTokens: day.outputTokens,
    cacheReadTokens: day.cacheReadTokens,
    cacheWriteTokens: day.cacheWriteTokens,
    topModels,
  }
}

function mergeRawDaysIntoHistory(daily: DailyHistoryEntry[], rawDays: AggregatedDay[]): DailyHistoryEntry[] {
  const merged = new Map(daily.map(day => [day.date, day]))
  for (const rawDay of rawDays) {
    merged.set(rawDay.date, dailyHistoryFromAggregatedDay(rawDay))
  }
  return [...merged.values()].sort((a, b) => a.date.localeCompare(b.date))
}

function scaleRetryTaxCosts(retryTax: MenubarPayload['current']['retryTax'], scale: number): MenubarPayload['current']['retryTax'] {
  if (!Number.isFinite(scale) || scale <= 0 || scale === 1) return retryTax
  return {
    ...retryTax,
    totalUSD: retryTax.totalUSD * scale,
    byModel: retryTax.byModel.map(model => ({ ...model, taxUSD: model.taxUSD * scale })),
  }
}

function scaleRoutingWasteCosts(routingWaste: MenubarPayload['current']['routingWaste'], scale: number): MenubarPayload['current']['routingWaste'] {
  if (!Number.isFinite(scale) || scale <= 0 || scale === 1) return routingWaste
  return {
    ...routingWaste,
    totalSavingsUSD: routingWaste.totalSavingsUSD * scale,
    baselineCostPerEdit: routingWaste.baselineCostPerEdit * scale,
    byModel: routingWaste.byModel.map(model => ({
      ...model,
      costPerEdit: model.costPerEdit * scale,
      actualUSD: model.actualUSD * scale,
      counterfactualUSD: model.counterfactualUSD * scale,
      savingsUSD: model.savingsUSD * scale,
    })),
  }
}

function scaleOptimizeResultCostRate(optimize: OptimizeResult | null, scale: number | null): OptimizeResult | null {
  if (!optimize || scale === null || !Number.isFinite(scale) || scale <= 0 || scale === 1) return optimize
  return { ...optimize, costRate: optimize.costRate * scale }
}

async function buildSubscriptionAdjustment(
  currentCost: number,
  canonicalProviderCosts: Record<string, number>,
  provider: string,
  periodRange: DateRange,
  today: Date,
): Promise<SubscriptionAdjustment | null> {
  const config = await readConfig()
  const modes = config.subscriptionCostMode ?? {}
  const plans = Object.values(await readPlans()).filter(isActivePlan)
    .filter(plan => {
      const mode = modes[plan.provider]
      return mode === 'amortized' || mode === 'actual-payments'
    })
    .filter(plan => planAppliesToProvider(plan, provider))

  const topUps = (Array.isArray(config.tokenPackages) ? config.tokenPackages : [])
    .filter(pkg => modes[pkg.provider] === 'actual-payments')
    .filter(pkg => packageAppliesToProvider(pkg, provider))
    .filter(pkg => packageInRange(pkg, periodRange))

  if (plans.length === 0 && topUps.length === 0) return null

  let adjustedCost = currentCost
  let subscriptionCost = 0
  const providerCosts = { ...canonicalProviderCosts }
  const planRows: SubscriptionAdjustment['plans'] = []
  const topUpRows: SubscriptionAdjustment['topUps'] = []
  let hasActualPayments = topUps.length > 0

  for (const plan of plans) {
    const mode = modes[plan.provider] === 'actual-payments'
      ? 'actual-payments'
      : 'amortized'
    if (mode === 'actual-payments') hasActualPayments = true
    const period = computePeriodFromResetDay(plan.resetDay, today)
    const totalDays = Math.max(
      1,
      dayIndex(period.periodEnd) - dayIndex(period.periodStart),
    )
    const overlapDays = inclusiveOverlapDays(
      periodRange.start,
      periodRange.end,
      period.periodStart,
      period.periodEnd,
    )
    if (overlapDays <= 0) continue

    const allocatedCost = plan.monthlyUsd * (overlapDays / totalDays)
    const apiEquivalentCost = plan.provider === 'all'
      ? currentCost
      : (providerCosts[plan.provider] ?? 0)

    adjustedCost += allocatedCost - apiEquivalentCost
    subscriptionCost += allocatedCost
    if (plan.provider !== 'all') {
      const current = providerCosts[plan.provider] ?? 0
      providerCosts[plan.provider] = Math.max(
        0,
        current - apiEquivalentCost + allocatedCost,
      )
    }
    planRows.push({
      provider: plan.provider,
      mode,
      monthlyUsd: plan.monthlyUsd,
      allocatedCost,
      apiEquivalentCost,
      periodStart: isoDay(period.periodStart),
      periodEnd: isoDay(period.periodEnd),
    })
  }

  for (const pkg of topUps) {
    if (!Number.isFinite(pkg.amountUsd) || pkg.amountUsd <= 0) continue
    adjustedCost += pkg.amountUsd
    subscriptionCost += pkg.amountUsd
    if (pkg.provider !== 'all') {
      const current = providerCosts[pkg.provider] ?? 0
      providerCosts[pkg.provider] = current + pkg.amountUsd
    }
    const topUpId = pkg.id ?? [pkg.provider, pkg.purchasedAt, pkg.amountUsd].join(':')
    topUpRows.push({
      id: topUpId,
      provider: pkg.provider,
      amountUsd: pkg.amountUsd,
      purchasedAt: pkg.purchasedAt,
      tokens: Number.isFinite(pkg.tokens ?? NaN) ? pkg.tokens! : null,
      note: pkg.note ?? '',
    })
  }

  if (planRows.length === 0 && topUpRows.length === 0) return null
  return {
    adjustedCost: Math.max(0, adjustedCost),
    subscriptionCost,
    mode: hasActualPayments ? 'actual-payments' : 'amortized',
    plans: planRows,
    topUps: topUpRows,
    providerCosts,
  }
}

function sqliteNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

function sqliteString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function unixSecondsToIso(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  return new Date(seconds * 1000).toISOString()
}

function isServiceChatTitle(title: string | undefined): boolean {
  const trimmed = title?.trim()
  return !trimmed
    || trimmed === 'automation_update'
    || trimmed.startsWith('# AGENTS.md instructions')
    || trimmed.startsWith('<environment_context>')
    || trimmed.startsWith('<permissions instructions>')
    || trimmed.startsWith('<app-context>')
    || trimmed.startsWith('<skills_instructions>')
    || trimmed.startsWith('<plugins_instructions>')
}

function bestChatTitle(title: string | undefined, firstUserMessage: string | undefined, fallback = ''): string {
  if (!isServiceChatTitle(title)) return title!.trim()
  const first = firstUserMessage?.trim()
  if (!isServiceChatTitle(first)) return first!
  return isServiceChatTitle(fallback) ? '' : fallback.trim()
}

function readRecentCodexStateChats(hours: number, now = new Date()): CodexStateChatRow[] {
  const safeHours = Math.max(1, Math.floor(hours || 48))
  const codexDir = process.env['CODEX_HOME'] ?? join(homedir(), '.codex')
  const dbPath = join(codexDir, 'state_5.sqlite')
  if (!existsSync(dbPath)) return []

  const cutoff = Math.floor((now.getTime() - safeHours * 60 * 60 * 1000) / 1000)
  let db: ReturnType<typeof openDatabase> | null = null
  try {
    db = openDatabase(dbPath)
    return db.query<Record<string, unknown>>(
      'SELECT id, created_at, updated_at, tokens_used, model, cwd, title, first_user_message ' +
      'FROM threads ' +
      'WHERE COALESCE(archived, 0) = 0 ' +
      'AND COALESCE(updated_at, 0) >= ? ' +
      'ORDER BY updated_at DESC',
      [cutoff],
    ).map(row => ({
      id: sqliteString(row.id) ?? '',
      created_at: sqliteNumber(row.created_at),
      updated_at: sqliteNumber(row.updated_at),
      tokens_used: sqliteNumber(row.tokens_used),
      model: sqliteString(row.model),
      cwd: sqliteString(row.cwd),
      title: sqliteString(row.title),
      first_user_message: sqliteString(row.first_user_message),
    })).filter(row => row.id.length > 0)
  } catch {
    return []
  } finally {
    db?.close()
  }
}

function timestampInLookback(value: string | undefined, hours: number, now: Date): boolean {
  if (!value) return false
  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp)) return false
  const end = now.getTime()
  return timestamp >= end - hours * 60 * 60 * 1000 && timestamp <= end
}

function freshCodexStateTokenTotal(row: CodexStateChatRow | undefined, parsedTotalTokens: number, now: Date): number {
  if (!row || row.tokens_used <= parsedTotalTokens) return parsedTotalTokens
  const updatedAtMs = row.updated_at * 1000
  if (!Number.isFinite(updatedAtMs)) return parsedTotalTokens
  const ageMs = now.getTime() - updatedAtMs
  if (ageMs < 0 || ageMs > CODEX_STATE_LIVE_TOKEN_TTL_MS) return parsedTotalTokens
  return row.tokens_used
}

export function buildCodexChatsReport(projects: ProjectSummary[], hours: number, limit = 5000, now = new Date()): CodexChatsReport {
  const safeHours = Math.max(1, Math.floor(hours || 48))
  const projectDisplayName = (project: ProjectSummary): string => {
    const resolved = project.projectPath || project.project
    return projectDisplayNameFromPath(resolved, project.project)
  }
  const sessions = projects
    .flatMap(project => project.sessions.map(session => ({ project, session })))
    .filter(({ session }) => session.apiCalls > 0)
    .filter(({ session }) => timestampInLookback(session.lastTimestamp, safeHours, now))
    .sort((a, b) => (
      b.session.lastTimestamp || ''
    ).localeCompare(a.session.lastTimestamp || ''))
  const metadataRows = readRecentCodexStateChats(safeHours, now)
  const metadataBySessionId = new Map(metadataRows.map(row => [row.id, row]))
  const metadataByShortSessionId = new Map<string, CodexStateChatRow | null>()
  for (const row of metadataRows) {
    const key = row.id.slice(-8)
    metadataByShortSessionId.set(key, metadataByShortSessionId.has(key) ? null : row)
  }

  const parsedChats = sessions.map(({ project, session }) => {
    const threadId = codexThreadIdFromSessionId(session.sessionId)
    const sessionDisplayId = codexSessionDisplayId(session.sessionId)
    const metadata = metadataBySessionId.get(session.sessionId)
      ?? metadataBySessionId.get(threadId)
      ?? metadataByShortSessionId.get(sessionDisplayId)
      ?? undefined
    const displayProjectName = projectDisplayName(project)
    const sessionFirstUserMessage = session.turns
      .map(turn => turn.userMessage.trim())
      .find(message => message.length > 0)
    const models = Object.entries(session.modelBreakdown)
      .map(([name, model]) => ({
        name,
        calls: model.calls,
        cost: model.costUSD,
        inputTokens: model.tokens.inputTokens,
        outputTokens: model.tokens.outputTokens,
        reasoningTokens: model.tokens.reasoningTokens ?? 0,
        cacheReadTokens: model.tokens.cacheReadInputTokens,
        cacheWriteTokens: model.tokens.cacheCreationInputTokens,
      }))
      .sort((a, b) => b.cost - a.cost)
    const parsedTotalTokens = session.totalInputTokens
      + session.totalOutputTokens
      + (session.totalReasoningTokens ?? 0)
      + session.totalCacheReadTokens
      + session.totalCacheWriteTokens
    const totalTokens = freshCodexStateTokenTotal(metadata, parsedTotalTokens, now)
    const liveInputDelta = Math.max(0, totalTokens - parsedTotalTokens)
    const displayInputTokens = session.totalInputTokens + liveInputDelta
    const displayModels = models.map((model, index) => index === 0
      ? { ...model, inputTokens: model.inputTokens + liveInputDelta }
      : model)
    return {
      project: project.project,
      projectDisplayName: displayProjectName,
      projectPath: project.projectPath,
      sessionId: session.sessionId,
      sessionDisplayId,
      chatTitle: bestChatTitle(
        session.chatTitle,
        metadata?.first_user_message ?? sessionFirstUserMessage,
        metadata?.title,
      ) || fallbackChatTitle(project.projectPath, displayProjectName, sessionDisplayId),
      startedAt: session.firstTimestamp,
      lastSeenAt: session.lastTimestamp,
      calls: session.apiCalls,
      cost: session.totalCostUSD,
      inputTokens: displayInputTokens,
      outputTokens: session.totalOutputTokens,
      reasoningTokens: session.totalReasoningTokens ?? 0,
      cacheReadTokens: session.totalCacheReadTokens,
      cacheWriteTokens: session.totalCacheWriteTokens,
      totalTokens,
      models: displayModels,
    }
  })

  const seenSessionIds = new Set(parsedChats
    .flatMap(chat => [
      chat.sessionId,
      codexThreadIdFromSessionId(chat.sessionId),
      chat.sessionDisplayId,
    ])
    .filter(Boolean))
  const metadataChats = metadataRows
    .filter(row => !seenSessionIds.has(row.id) && !seenSessionIds.has(row.id.slice(-8)))
    .map(row => {
      const projectPath = row.cwd ?? ''
      const project = projectPath || 'codex'
      const sessionDisplayId = row.id.slice(-8)
      const totalTokens = freshCodexStateTokenTotal(row, 0, now)
      return {
        project,
        projectDisplayName: projectDisplayNameFromPath(projectPath, project),
        projectPath,
        sessionId: row.id,
        sessionDisplayId,
        chatTitle: bestChatTitle(row.title, row.first_user_message)
          || fallbackChatTitle(
            projectPath,
            projectDisplayNameFromPath(projectPath, project),
            sessionDisplayId,
          ),
        startedAt: unixSecondsToIso(row.created_at || row.updated_at),
        lastSeenAt: unixSecondsToIso(row.updated_at || row.created_at),
        calls: 0,
        cost: 0,
        inputTokens: totalTokens,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens,
        models: row.model ? [{
          name: row.model,
          calls: 0,
          cost: 0,
          inputTokens: totalTokens,
          outputTokens: 0,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        }] : [],
      }
    })

  const chats = [...parsedChats, ...metadataChats]
    .sort((a, b) => (b.lastSeenAt || '').localeCompare(a.lastSeenAt || ''))
    .slice(0, Math.max(1, limit))

  const totals = chats.reduce((acc, chat) => {
    acc.calls += chat.calls
    acc.cost += chat.cost
    acc.inputTokens += chat.inputTokens
    acc.outputTokens += chat.outputTokens
    acc.reasoningTokens += chat.reasoningTokens
    acc.cacheReadTokens += chat.cacheReadTokens
    acc.cacheWriteTokens += chat.cacheWriteTokens
    acc.totalTokens += chat.totalTokens
    return acc
  }, { calls: 0, cost: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 })

  return {
    label: `Last ${safeHours} hours`,
    provider: 'codex',
    hours: safeHours,
    totalChats: chats.length,
    returnedChats: chats.length,
    totals,
    chats,
  }
}

/**
 * Resolved-range aggregation shared by `status --format menubar-json` and the MCP server.
 * Pricing must already be loaded (callers run loadPricing first). When opts.optimize is
 * false, the expensive scanAndDetect pass is skipped (retryTax/routingWaste still computed).
 */
export async function buildMenubarPayloadForRange(periodInfo: PeriodInfo, opts: AggregateOpts = {}): Promise<MenubarPayload> {
  const pf = opts.provider ?? 'all'
  const daysSelection = opts.daysSelection ?? null
  const fp = (p: ProjectSummary[]) => filterProjectsByName(p, opts.project ?? [], opts.exclude ?? [])
  const chatHours = Math.max(1, Math.floor(opts.chatHours ?? 48))

  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const todayRange: DateRange = { start: todayStart, end: now }
  const todayStr = toDateString(todayStart)
  const yesterdayStr = toDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))
  const rangeStartStr = toDateString(periodInfo.range.start)
  const rangeEndStr = toDateString(periodInfo.range.end)
  const historicalRangeEndStr = rangeEndStr < yesterdayStr ? rangeEndStr : yesterdayStr
  const isAllProviders = pf === 'all'

  let todayAllProjects: ProjectSummary[] | null = null
  let todayAllDays: ReturnType<typeof aggregateProjectsIntoDays> | null = null

  const getTodayAllProjects = async (): Promise<ProjectSummary[]> => {
    if (!todayAllProjects) {
      todayAllProjects = fp(await parseAllSessions(todayRange, 'all'))
    }
    return todayAllProjects
  }

  const getTodayAllDays = async (): Promise<ReturnType<typeof aggregateProjectsIntoDays>> => {
    if (!todayAllDays) {
      todayAllDays = aggregateProjectsIntoDays(await getTodayAllProjects())
    }
    return todayAllDays
  }

  let currentData: PeriodData
  let scanProjects: ProjectSummary[]
  let scanRange: DateRange
  let cache: DailyCache
  let todayProviderData: PeriodData | null = null
  const codexChats48h = buildCodexChatsReport(fp(await parseAllSessions(undefined, 'codex')), chatHours, 5000, now)

  if (isAllProviders) {
    cache = await hydrateCache()
    const todayProjects = await getTodayAllProjects()
    const todayDays = await getTodayAllDays()
    const historicalDays = rangeStartStr <= historicalRangeEndStr
      ? getDaysInRange(cache, rangeStartStr, historicalRangeEndStr)
      : []
    const todayInRange = todayDays.filter(d => d.date >= rangeStartStr && d.date <= rangeEndStr)
    const unfilteredDays = [...historicalDays, ...todayInRange].sort((a, b) => a.date.localeCompare(b.date))
    const allDays = daysSelection ? unfilteredDays.filter(d => daysSelection.days.has(d.date)) : unfilteredDays
    currentData = buildPeriodDataFromDays(allDays, periodInfo.label)
    const isTodayOnly = rangeStartStr === todayStr && rangeEndStr === todayStr
    if (isTodayOnly) {
      scanProjects = todayProjects
      scanRange = todayRange
    } else {
      const rawProjects = fp(await parseAllSessions(periodInfo.range, 'all'))
      scanProjects = daysSelection ? filterProjectsByDays(rawProjects, daysSelection.days) : rawProjects
      scanRange = periodInfo.range
    }
  } else {
    cache = await loadDailyCache()
    const rawProviderProjects = fp(await parseAllSessions(periodInfo.range, pf))
    const fullProjects = daysSelection ? filterProjectsByDays(rawProviderProjects, daysSelection.days) : rawProviderProjects
    todayProviderData = buildPeriodData(periodInfo.label, fullProjects)
    currentData = todayProviderData
    scanProjects = fullProjects
    scanRange = periodInfo.range
  }
  if (isAllProviders) {
    currentData = buildPeriodData(periodInfo.label, scanProjects)
  }

  // PROVIDERS
  // For .all: enumerate every provider with cost across the same raw sessions
  // used for current.cost, plus installed-but-zero providers.
  // For specific: just this single provider with its scoped cost.
  const allProviders = await getAllProviders()
  const displayNameByName = new Map(allProviders.map(p => [p.name, p.displayName]))
  const providers: ProviderCost[] = []
  const canonicalProviderCosts: Record<string, number> = {}
  if (isAllProviders) {
    const providerTotals = aggregateProviderCostsFromProjects(scanProjects)
    for (const [name, cost] of Object.entries(providerTotals)) {
      canonicalProviderCosts[name] = cost
      providers.push({ name: displayNameByName.get(name) ?? name, cost })
    }
    for (const p of allProviders) {
      if (providers.some(pc => pc.name === p.displayName)) continue
      const sources = await p.discoverSessions()
      if (sources.length > 0) providers.push({ name: p.displayName, cost: 0 })
    }
  } else {
    const display = displayNameByName.get(pf) ?? pf
    canonicalProviderCosts[pf] = currentData.cost
    providers.push({ name: display, cost: currentData.cost })
  }

  const apiEquivalentCost = currentData.cost
  const subscriptionAdjustment = await buildSubscriptionAdjustment(
    apiEquivalentCost,
    canonicalProviderCosts,
    pf,
    periodInfo.range,
    now,
  )
  if (subscriptionAdjustment) {
    currentData.cost = subscriptionAdjustment.adjustedCost
    for (const [name, cost] of Object.entries(subscriptionAdjustment.providerCosts)) {
      const display = displayNameByName.get(name) ?? name
      const providerCost = providers.find(p => p.name === display)
      if (providerCost) providerCost.cost = cost
    }
  }

  // DAILY HISTORY (last 365 days)
  // Cache stores per-provider cost+calls per day in DailyEntry.providers, so we can derive
  // a provider-filtered history without re-parsing. Tokens aren't broken down per provider
  // in the cache, so the filtered view shows zero tokens (heatmap/trend still works on cost).
  const historyStartStr = toDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - BACKFILL_DAYS))
  const allCacheDays = getDaysInRange(cache, historyStartStr, yesterdayStr)

  let dailyHistory
  if (isAllProviders) {
    const todayDays = (await getTodayAllDays()).filter(d => d.date === todayStr)
    const fullHistory = [...allCacheDays, ...todayDays]
    dailyHistory = fullHistory.map(d => {
      const topModels = Object.entries(d.models)
        .filter(([name]) => name !== '<synthetic>')
        .sort(([, a], [, b]) => b.cost - a.cost)
        .slice(0, 5)
        .map(([name, m]) => ({
          name,
          cost: m.cost,
          savingsUSD: m.savingsUSD,
          calls: m.calls,
          inputTokens: m.inputTokens,
          outputTokens: m.outputTokens,
        }))
      return {
        date: d.date,
        cost: d.cost,
        savingsUSD: d.savingsUSD,
        calls: d.calls,
        inputTokens: d.inputTokens,
        outputTokens: d.outputTokens,
        cacheReadTokens: d.cacheReadTokens,
        cacheWriteTokens: d.cacheWriteTokens,
        topModels,
      }
    })
  } else {
    const emptyModels = [] as { name: string; cost: number; savingsUSD: number; calls: number; inputTokens: number; outputTokens: number }[]
    const historyFromCache = allCacheDays.map(d => {
      const prov = d.providers[pf] ?? { calls: 0, cost: 0, savingsUSD: 0 }
      return {
        date: d.date,
        cost: prov.cost,
        savingsUSD: prov.savingsUSD,
        calls: prov.calls,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        topModels: emptyModels,
      }
    })
    const todayFromParse = aggregateProjectsIntoDays(scanProjects)
      .filter(d => d.date === todayStr)
      .map(d => {
        const prov = d.providers[pf] ?? { calls: 0, cost: 0, savingsUSD: 0 }
        return {
          date: d.date,
          cost: prov.cost,
          savingsUSD: prov.savingsUSD,
          calls: prov.calls,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          topModels: emptyModels,
        }
      })
    dailyHistory = [...historyFromCache, ...todayFromParse]
  }

  dailyHistory = mergeRawDaysIntoHistory(dailyHistory, aggregateProjectsIntoDays(scanProjects))

  const friendlyProject = (p: ProjectSummary) => {
    const resolved = p.projectPath || p.project
    return projectDisplayNameFromPath(resolved, p.project)
  }

  currentData.projects = scanProjects.map(p => ({
    name: friendlyProject(p),
    cost: p.totalCostUSD,
    savingsUSD: p.totalSavingsUSD,
    sessions: p.sessions.length,
    inputTokens: p.sessions.reduce((sum, session) => sum + session.totalInputTokens, 0),
    outputTokens: p.sessions.reduce((sum, session) => sum + session.totalOutputTokens, 0),
    reasoningTokens: p.sessions.reduce((sum, session) => sum + (session.totalReasoningTokens ?? 0), 0),
    cacheReadTokens: p.sessions.reduce((sum, session) => sum + session.totalCacheReadTokens, 0),
    cacheWriteTokens: p.sessions.reduce((sum, session) => sum + session.totalCacheWriteTokens, 0),
    sessionDetails: [...p.sessions]
      .sort((a, b) => b.totalCostUSD - a.totalCostUSD)
      .slice(0, 5000)
      .map(s => ({
        cost: s.totalCostUSD,
        savingsUSD: s.totalSavingsUSD,
        calls: s.apiCalls,
        inputTokens: s.totalInputTokens,
        outputTokens: s.totalOutputTokens,
        reasoningTokens: s.totalReasoningTokens ?? 0,
        date: s.firstTimestamp?.split('T')[0] ?? '',
        models: Object.entries(s.modelBreakdown)
          .map(([name, m]) => ({ name, cost: m.costUSD, savingsUSD: m.savingsUSD }))
          .sort((a, b) => b.cost - a.cost)
          .slice(0, 3),
      })),
  }))

  const effMap = aggregateModelEfficiency(scanProjects)
  currentData.modelEfficiency = [...effMap.entries()].map(([name, eff]) => ({
    name,
    costPerEdit: eff.costPerEditUSD,
    oneShotRate: eff.oneShotRate,
  }))

  const retryTaxByModel = [...effMap.values()]
    .filter(m => m.retries > 0 && m.editTurns > 0)
    .map(m => ({
      name: m.model,
      taxUSD: m.retries * (m.editCostUSD / m.editTurns),
      retries: m.retries,
      retriesPerEdit: m.retriesPerEdit,
    }))
    .sort((a, b) => b.taxUSD - a.taxUSD)
  let retryTax = {
    totalUSD: retryTaxByModel.reduce((s, m) => s + m.taxUSD, 0),
    retries: retryTaxByModel.reduce((s, m) => s + m.retries, 0),
    editTurns: [...effMap.values()].filter(m => m.retries > 0).reduce((s, m) => s + m.editTurns, 0),
    byModel: retryTaxByModel.slice(0, 5),
  }

  currentData.topSessions = scanProjects.flatMap(p =>
    p.sessions.map(s => ({
      project: friendlyProject(p),
      cost: s.totalCostUSD,
      savingsUSD: s.totalSavingsUSD,
      calls: s.apiCalls,
      date: s.firstTimestamp?.split('T')[0] ?? '',
    }))
  ).sort((a, b) => (b.cost + b.savingsUSD) - (a.cost + a.savingsUSD)).slice(0, 5000)

  let subscriptionDetailScale: number | null = null
  if (subscriptionAdjustment && apiEquivalentCost > 0) {
    const planProviders = new Set(subscriptionAdjustment.plans.map(p => p.provider))
    const topUpProviders = new Set(subscriptionAdjustment.topUps.map(p => p.provider))
    const activeCostProviders = Object.entries(canonicalProviderCosts)
      .filter(([, cost]) => cost > 0.000001)
      .map(([name]) => name)
    const allCostsCovered = activeCostProviders.every(name => {
      return planProviders.has('all') || planProviders.has(name) || topUpProviders.has('all') || topUpProviders.has(name)
    })
    if (pf !== 'all' || allCostsCovered) {
      subscriptionDetailScale = currentData.cost / apiEquivalentCost
      scalePeriodCosts(currentData, subscriptionDetailScale)
      dailyHistory = scaleDailyHistoryCosts(dailyHistory, periodInfo.range, subscriptionDetailScale)
      retryTax = scaleRetryTaxCosts(retryTax, subscriptionDetailScale)
    }
  }

  // Routing waste: find cheapest reliable model (≥90% 1-shot, ≥5 edits),
  // then compute how much each pricier model overpaid.
  const reliableModels = [...effMap.values()]
    .filter(m => m.oneShotRate !== null && m.oneShotRate >= 90 && m.editTurns >= 5
      && (m.costPerEditUSD ?? 0) >= 0.01)
    .sort((a, b) => (a.costPerEditUSD ?? Infinity) - (b.costPerEditUSD ?? Infinity))
  const baseline = reliableModels[0]
  const routingWasteByModel = baseline
    ? [...effMap.values()]
        .filter(m => m.model !== baseline.model && m.editTurns > 0 && (m.costPerEditUSD ?? 0) > (baseline.costPerEditUSD ?? 0))
        .map(m => {
          const counterfactual = m.editTurns * (baseline.costPerEditUSD ?? 0)
          return {
            name: m.model,
            costPerEdit: m.costPerEditUSD ?? 0,
            editTurns: m.editTurns,
            actualUSD: m.editCostUSD,
            counterfactualUSD: counterfactual,
            savingsUSD: m.editCostUSD - counterfactual,
          }
        })
        .filter(m => m.savingsUSD > 0)
        .sort((a, b) => b.savingsUSD - a.savingsUSD)
    : []
  let routingWaste = {
    totalSavingsUSD: routingWasteByModel.reduce((s, m) => s + m.savingsUSD, 0),
    baselineModel: baseline?.model ?? '',
    baselineCostPerEdit: baseline?.costPerEditUSD ?? 0,
    byModel: routingWasteByModel.slice(0, 5),
  }
  if (subscriptionDetailScale !== null) {
    routingWaste = scaleRoutingWasteCosts(routingWaste, subscriptionDetailScale)
  }

  const breakdowns: BreakdownArrays = (() => {
    const toolMap: Record<string, number> = {}
    const skillMap: Record<string, { turns: number; cost: number }> = {}
    const subagentMap: Record<string, { calls: number; cost: number }> = {}
    const mcpMap: Record<string, number> = {}
    // Local-model savings rollup: avoided spend (cost forced to $0, baseline
    // recorded) grouped by model and provider. Mirrors the per-call savingsUSD
    // that applyLocalModelSavings stamps in the parser.
    const savingsByModel = new Map<string, { calls: number; actualUSD: number; savingsUSD: number; baselineModel: string; inputTokens: number; outputTokens: number }>()
    const savingsByProvider = new Map<string, { calls: number; savingsUSD: number }>()
    let totalSavings = 0
    let totalSavingsCalls = 0
    for (const p of scanProjects) for (const s of p.sessions) {
      for (const [t, d] of Object.entries(s.toolBreakdown)) { if (!t.startsWith('lang:')) toolMap[t] = (toolMap[t] ?? 0) + d.calls }
      for (const [sk, d] of Object.entries(s.skillBreakdown)) { const e = skillMap[sk] ?? { turns: 0, cost: 0 }; e.turns += d.turns; e.cost += d.costUSD; skillMap[sk] = e }
      for (const [sa, d] of Object.entries(s.subagentBreakdown)) { const e = subagentMap[sa] ?? { calls: 0, cost: 0 }; e.calls += d.calls; e.cost += d.costUSD; subagentMap[sa] = e }
      for (const [m, d] of Object.entries(s.mcpBreakdown)) { mcpMap[m] = (mcpMap[m] ?? 0) + d.calls }
      for (const turn of s.turns) for (const call of turn.assistantCalls) {
        if (!call.savingsUSD || call.savingsUSD <= 0) continue
        totalSavings += call.savingsUSD
        totalSavingsCalls += 1
        const modelKey = getShortModelName(call.model)
        const acc = savingsByModel.get(modelKey) ?? { calls: 0, actualUSD: 0, savingsUSD: 0, baselineModel: call.savingsBaselineModel ?? '', inputTokens: 0, outputTokens: 0 }
        acc.calls += 1
        acc.actualUSD += call.costUSD
        acc.savingsUSD += call.savingsUSD
        acc.baselineModel = acc.baselineModel || (call.savingsBaselineModel ?? '')
        acc.inputTokens += call.usage.inputTokens
        acc.outputTokens += call.usage.outputTokens
        savingsByModel.set(modelKey, acc)
        const provAcc = savingsByProvider.get(call.provider) ?? { calls: 0, savingsUSD: 0 }
        provAcc.calls += 1
        provAcc.savingsUSD += call.savingsUSD
        savingsByProvider.set(call.provider, provAcc)
      }
    }
    const localModelSavings = {
      totalUSD: totalSavings,
      calls: totalSavingsCalls,
      byModel: Array.from(savingsByModel.entries()).sort(([, a], [, b]) => b.savingsUSD - a.savingsUSD).slice(0, 5).map(([name, d]) => ({ name, ...d })),
      byProvider: Array.from(savingsByProvider.entries()).sort(([, a], [, b]) => b.savingsUSD - a.savingsUSD).slice(0, 5).map(([name, d]) => ({ name, ...d })),
    }
    return {
      tools: Object.entries(toolMap).sort(([, a], [, b]) => b - a).slice(0, 10).map(([name, calls]) => ({ name, calls })),
      skills: Object.entries(skillMap).sort(([, a], [, b]) => b.cost - a.cost).slice(0, 10).map(([name, d]) => ({ name, ...d })),
      subagents: Object.entries(subagentMap).sort(([, a], [, b]) => b.cost - a.cost).slice(0, 10).map(([name, d]) => ({ name, ...d })),
      mcpServers: Object.entries(mcpMap).sort(([, a], [, b]) => b - a).slice(0, 10).map(([name, calls]) => ({ name, calls })),
      localModelSavings,
      codexChats48h,
    }
  })()

  if (subscriptionAdjustment) {
    breakdowns.apiEquivalentCost = apiEquivalentCost
    breakdowns.subscriptionCost = subscriptionAdjustment.subscriptionCost
    breakdowns.subscriptionCostMode = subscriptionAdjustment.mode
    breakdowns.subscriptionPlans = subscriptionAdjustment.plans
    breakdowns.subscriptionTopUps = subscriptionAdjustment.topUps
  }

  const rawOptimize = opts.optimize === false ? null : await scanAndDetect(scanProjects, scanRange)
  const optimize = scaleOptimizeResultCostRate(rawOptimize, subscriptionDetailScale)
  return buildMenubarPayload(currentData, providers, optimize, dailyHistory, retryTax, routingWaste, breakdowns)
}

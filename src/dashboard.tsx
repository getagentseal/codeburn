import { homedir } from 'os'

import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { render, Box, Text, useInput, useApp, useWindowSize } from 'ink'
import { CATEGORY_LABELS, type DateRange, type ProjectSummary, type TaskCategory } from './types.js'
import { formatCost, formatTokens, markEstimated, carriedCostNote } from './format.js'
import { aggregateModelEfficiency } from './model-efficiency.js'
import { parseAllSessions, filterProjectsByDateRange, filterProjectsByName, setInteractiveScanUI } from './parser.js'
import { findUnpricedModels, loadPricing } from './models.js'
import { aggregateModelTotals } from './model-breakdown.js'
import { buildDurablePeriod } from './usage-aggregator.js'
import { getAllProviders } from './providers/index.js'
import { scanAndDetect, type WasteFinding, type WasteAction, type OptimizeResult } from './optimize.js'
import { estimateContextBudget, type ContextBudget } from './context-budget.js'
import { dateKey } from './day-aggregator.js'
import { CompareView } from './compare.js'
import { getPlanUsages, type PlanUsage } from './plan-usage.js'
import { planDisplayName } from './plans.js'
import { formatDayRangeLabel, getDateRange, parseDayFlag, PERIODS, PERIOD_LABELS, shiftDay, type Period } from './cli-date.js'
import { patchStdoutForWindows } from './ink-win.js'

type View = 'dashboard' | 'optimize' | 'compare'

export type DailyActivityRow = {
  day: string
  cost: number
  calls: number
}

export const DAILY_ACTIVITY_PAGE_SIZE = 10
export const INTERACTIVE_RENDER_OPTIONS = { alternateScreen: true } as const

export function pageHistoryCursor(cursor: number, direction: -1 | 1, pageSize: number, rowCount: number): number {
  const maxCursor = Math.max(0, rowCount - pageSize)
  return Math.max(0, Math.min(cursor + direction * pageSize, maxCursor))
}

export function scrollHistoryCursor(cursor: number, direction: -1 | 1, pageSize: number, rowCount: number): number {
  const maxCursor = Math.max(0, rowCount - pageSize)
  return Math.max(0, Math.min(cursor + direction, maxCursor))
}

// The Daily Activity panel's row count comes from a bounded live scan (see
// getDashboardScanRange), which can undercount vs. the durable-cache-backed
// Overview headline for the same period (expired session files aren't in the
// live scan but are still in the durable cache). "days scanned" names that
// population so the two counts read as different questions, not a
// contradiction.
export function dailyActivityFooter(cursor: number, days: number, rowCount: number): string {
  return `Showing ${cursor + 1}–${Math.min(cursor + days, rowCount)} of ${rowCount} days scanned · newest first`
}

// Scrollable mode keeps the dashboard up when only the selected period is
// empty (full history still renders), but a truly-new user with no history at
// all should still get the clean empty state instead of a zeroed shell.
export function showEmptyState(projectCount: number, scrollableHistory: boolean, historyProjectCount: number, historyLoading: boolean): boolean {
  if (projectCount > 0) return false
  if (!scrollableHistory) return true
  return historyProjectCount === 0 && !historyLoading
}

// The By Model panel drops Tok/s when a responsive panel is too narrow.
const MIN_WIDE = 90
const MAX_DASHBOARD_WIDTH = 256
const ORANGE = '#FF8C42'
const DIM = '#555555'
const GOLD = '#FFD700'
const PLAN_BAR_WIDTH = 10
const HEAVY_PERIODS = new Set<Period>(['30days', 'month', 'all', 'lifetime'])

const LANG_DISPLAY_NAMES: Record<string, string> = {
  javascript: 'JavaScript', typescript: 'TypeScript', python: 'Python',
  rust: 'Rust', go: 'Go', java: 'Java', cpp: 'C++', c: 'C', csharp: 'C#',
  ruby: 'Ruby', php: 'PHP', swift: 'Swift', kotlin: 'Kotlin',
  html: 'HTML', css: 'CSS', scss: 'SCSS', json: 'JSON', yaml: 'YAML',
  sql: 'SQL', shell: 'Shell', shellscript: 'Shell Script', bash: 'Bash',
  typescriptreact: 'TSX', javascriptreact: 'JSX',
  markdown: 'Markdown', dockerfile: 'Dockerfile', toml: 'TOML',
}

const PANEL_COLORS = {
  overview: '#FF8C42',
  daily: '#5B9EF5',
  project: '#5BF5A0',
  model: '#E05BF5',
  activity: '#F5C85B',
  tools: '#5BF5E0',
  mcp: '#F55BE0',
  bash: '#F5A05B',
  skills: '#7B68EE',
}

const PROVIDER_COLORS: Record<string, string> = {
  claude: '#FF8C42',
  codex: '#5BF5A0',
  cursor: '#00B4D8',
  'ibm-bob': '#0F62FE',
  opencode: '#A78BFA',
  pi: '#F472B6',
  kimi: '#B6E34A',
  kimicode: '#A3E635',
  all: '#FF8C42',
}

const CATEGORY_COLORS: Record<TaskCategory, string> = {
  coding: '#5B9EF5',
  debugging: '#F55B5B',
  feature: '#5BF58C',
  refactoring: '#F5E05B',
  testing: '#E05BF5',
  exploration: '#5BF5E0',
  planning: '#7B9EF5',
  delegation: '#F5C85B',
  git: '#CCCCCC',
  'build/deploy': '#5BF5A0',
  conversation: '#888888',
  brainstorming: '#F55BE0',
  general: '#666666',
}

const IMPACT_PANEL_COLORS: Record<string, string> = { high: '#F55B5B', medium: ORANGE, low: DIM }

function toHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')
}

function lerp(a: number, b: number, t: number): number {
  return a + t * (b - a)
}

function gradientColor(pct: number): string {
  if (pct <= 0.33) {
    const t = pct / 0.33
    return toHex(lerp(91, 245, t), lerp(158, 200, t), lerp(245, 91, t))
  }
  if (pct <= 0.66) {
    const t = (pct - 0.33) / 0.33
    return toHex(lerp(245, 255, t), lerp(200, 140, t), lerp(91, 66, t))
  }
  const t = (pct - 0.66) / 0.34
  return toHex(lerp(255, 245, t), lerp(140, 91, t), lerp(66, 91, t))
}

function getPeriodRange(period: Period): { start: Date; end: Date } {
  return getDateRange(period).range
}

/// The durable headline totals the Overview panel renders. Sourced from the
/// carry-forward daily cache (via buildDurablePeriod) so the dashboard's top-
/// line cost/calls/tokens match the menubar and report exactly, including days
/// whose session files have expired.
export type DurableOverview = {
  cost: number
  savingsUSD: number
  calls: number
  sessions: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  // Cost from days whose session logs have since expired, carried forward
  // from the daily cache. Surfaced so the Overview headline can explain why
  // its total may exceed what the (live-scan-bounded) Daily Activity panel
  // below can show. See carriedCostNote in format.ts.
  carriedCostUSD: number
}

async function computeDurableOverview(
  period: Period,
  provider: string,
  projectFilter: string[] | undefined,
  excludeFilter: string[] | undefined,
  customRange: DateRange | null | undefined,
  day: string | null,
): Promise<DurableOverview> {
  const range = day ? getDayRange(day) : customRange ?? getPeriodRange(period)
  const { data, carriedCostUSD } = await buildDurablePeriod(
    { range, label: PERIOD_LABELS[period] },
    { provider, project: projectFilter ?? [], exclude: excludeFilter ?? [] },
  )
  return {
    cost: data.cost,
    savingsUSD: data.savingsUSD,
    calls: data.calls,
    sessions: data.sessions,
    inputTokens: data.inputTokens,
    outputTokens: data.outputTokens,
    cacheReadTokens: data.cacheReadTokens,
    cacheWriteTokens: data.cacheWriteTokens,
    carriedCostUSD,
  }
}

function getDayRange(day: string): DateRange {
  return parseDayFlag(day)!.range
}

export function getDashboardScanRange(period: Period, customRange: DateRange | null | undefined, day: string | null, scrollableHistory = true): DateRange {
  if (day) return getDayRange(day)
  if (customRange) return customRange
  // Daily Activity is scrollable on the standard dashboard, so one bounded
  // six-month scan supplies both the selected period and its history. A
  // concrete range is also required by network-backed providers.
  return getPeriodRange(scrollableHistory ? 'all' : period)
}

export function selectDashboardPeriodProjects(projects: ProjectSummary[], period: Period, scrollableHistory: boolean): ProjectSummary[] {
  if (!scrollableHistory || period === 'all') return projects
  return filterProjectsByDateRange(projects, getPeriodRange(period))
}

function isHeavyPeriod(period: Period): boolean {
  return HEAVY_PERIODS.has(period)
}

function nextTick(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

export type Layout = { dashWidth: number; columnCount: 1 | 2 | 3; panelWidth: number; barWidth: number }

export function getLayout(columns?: number, maxContentWidth = MAX_DASHBOARD_WIDTH): Layout {
  const termWidth = columns || parseInt(process.env['COLUMNS'] ?? '') || 80
  const dashWidth = Math.min(MAX_DASHBOARD_WIDTH, maxContentWidth, termWidth)
  const columnCount = dashWidth >= 135 ? 3 : dashWidth >= MIN_WIDE ? 2 : 1
  const panelWidth = Math.floor(dashWidth / columnCount)
  const inner = panelWidth - 4
  const barWidth = Math.max(6, Math.min(10, Math.floor(inner / 6)))
  return { dashWidth, columnCount, panelWidth, barWidth }
}

export function getRefreshIntervalMs(seconds: number): number {
  return seconds <= 0 ? 0 : Math.max(60, seconds) * 1000
}

export function shouldResetScreenOnResize(currentDashWidth: number, columns: number, maxContentWidth = MAX_DASHBOARD_WIDTH): boolean {
  return getLayout(columns, maxContentWidth).dashWidth !== currentDashWidth
}

function HBar({ value, max, width }: { value: number; max: number; width: number }) {
  if (max === 0) return <Text color={DIM}>{'░'.repeat(width)}</Text>
  const filled = Math.round((value / max) * width)
  const fillChars: React.ReactNode[] = []
  for (let i = 0; i < Math.min(filled, width); i++) {
    fillChars.push(<Text key={i} color={gradientColor(i / width)}>{'█'}</Text>)
  }
  return (
    <Text>
      {fillChars}
      <Text color="#333333">{'░'.repeat(Math.max(width - filled, 0))}</Text>
    </Text>
  )
}

const PANEL_CHROME = 4

function Panel({ title, color, children, width }: { title: string; color: string; children: React.ReactNode; width: number }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} width={width} overflowX="hidden">
      <Text bold color={color}>{title}</Text>
      {children}
    </Box>
  )
}

function fit(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s.padEnd(n)
}

type MetricCell = { text: string; color?: string; dimColor?: boolean }

function DataRow({ panelWidth, barWidth, label, metrics, bar, labelColor, dimColor, metricCellWidth = 7 }: {
  panelWidth: number
  barWidth: number
  label: string
  metrics: MetricCell[]
  bar?: { value: number; max: number }
  labelColor?: string
  dimColor?: boolean
  metricCellWidth?: number
}) {
  const innerWidth = panelWidth - PANEL_CHROME
  const metricsWidth = Math.min(metrics.length * metricCellWidth, innerWidth - barWidth - 2)
  const labelWidth = Math.max(1, innerWidth - barWidth - 1 - metricsWidth)
  const labelNode = <Text color={labelColor} dimColor={dimColor} wrap="truncate-end">{fit(label, labelWidth)}</Text>
  const barNode = bar ? <HBar value={bar.value} max={bar.max} width={barWidth} /> : <Text>{' '.repeat(barWidth)}</Text>
  return (
    <Box width={innerWidth}>
      {barNode}<Text> </Text>{labelNode}
      <Box width={metricsWidth}>
        {metrics.map((metric, index) => (
          <Box key={index} flexBasis={0} flexGrow={1} justifyContent="flex-end">
            <Text color={metric.color} dimColor={metric.dimColor} wrap="truncate-end">{metric.text}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  )
}

function renderPlanBar(percentUsed: number, width: number): string {
  if (percentUsed <= 100) {
    const capped = Math.max(0, percentUsed)
    const filled = Math.round((capped / 100) * width)
    return `${'▓'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}`
  }
  const factor = percentUsed / 100
  const chevrons = Math.min(4, Math.max(1, Math.floor(Math.log10(factor)) + 1))
  return `${'▓'.repeat(width)}${'▶'.repeat(chevrons)}`
}

function planLabel(planUsage: PlanUsage): string {
  const name = planDisplayName(planUsage.plan.id)
  return planUsage.plan.id === 'custom' ? `${name} (${planUsage.plan.provider})` : name
}

function planColor(planUsage: PlanUsage): string {
  return planUsage.status === 'over'
    ? '#F55B5B'
    : planUsage.status === 'near'
      ? ORANGE
      : '#5BF58C'
}

function planStatusText(planUsage: PlanUsage): string {
  if (planUsage.status === 'under') {
    return `Well within plan. Projected month: ${formatCost(planUsage.projectedMonthUsd)} (reset in ${planUsage.daysUntilReset} days).`
  }
  if (planUsage.status === 'near') {
    return `Approaching plan limit. Projected month: ${formatCost(planUsage.projectedMonthUsd)} (reset in ${planUsage.daysUntilReset} days).`
  }
  return `${(planUsage.spentApiEquivalentUsd / Math.max(planUsage.budgetUsd, 1)).toFixed(1)}x your subscription value. Projected month: ${formatCost(planUsage.projectedMonthUsd)} (reset in ${planUsage.daysUntilReset} days).`
}

function Overview({ projects, label, width, planUsages, durable }: { projects: ProjectSummary[]; label: string; width: number; planUsages?: PlanUsage[]; durable?: DurableOverview }) {
  // Headline totals prefer the durable daily cache (carried, expired-source days
  // included) so they match the menubar and report; the live parse is the
  // fallback until the durable figures land / for panels below.
  const totalCost = durable ? durable.cost : projects.reduce((s, p) => s + p.totalCostUSD, 0)
  const totalSavings = durable ? durable.savingsUSD : projects.reduce((s, p) => s + p.totalSavingsUSD, 0)
  const totalCalls = durable ? durable.calls : projects.reduce((s, p) => s + p.totalApiCalls, 0)
  const totalSessions = durable ? durable.sessions : projects.reduce((s, p) => s + p.sessions.length, 0)
  const allSessions = projects.flatMap(p => p.sessions)
  const totalInput = durable ? durable.inputTokens : allSessions.reduce((s, sess) => s + sess.totalInputTokens, 0)
  const totalOutput = durable ? durable.outputTokens : allSessions.reduce((s, sess) => s + sess.totalOutputTokens, 0)
  const totalCacheRead = durable ? durable.cacheReadTokens : allSessions.reduce((s, sess) => s + sess.totalCacheReadTokens, 0)
  const totalCacheWrite = durable ? durable.cacheWriteTokens : allSessions.reduce((s, sess) => s + sess.totalCacheWriteTokens, 0)
  const allInputTokens = totalInput + totalCacheRead + totalCacheWrite
  const cacheHit = allInputTokens > 0
    ? (totalCacheRead / allInputTokens) * 100 : 0
  const activePlanUsages = planUsages ?? []

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={PANEL_COLORS.overview} paddingX={1} width={width}>
      <Text wrap="truncate-end">
        <Text bold color={ORANGE}>CodeBurn</Text>
        <Text dimColor>  {label}</Text>
      </Text>
      <Text wrap="truncate-end">
        <Text bold color={GOLD}>{formatCost(totalCost)}</Text>
        <Text dimColor> cost   </Text>
        <Text bold>{totalCalls.toLocaleString()}</Text>
        <Text dimColor> calls   </Text>
        <Text bold>{String(totalSessions)}</Text>
        <Text dimColor> sessions   </Text>
        <Text bold>{cacheHit.toFixed(1)}%</Text>
        <Text dimColor> cache hit</Text>
      </Text>
      <Text dimColor wrap="truncate-end">
        {formatTokens(totalInput)} in   {formatTokens(totalOutput)} out   {formatTokens(totalCacheRead)} cached   {formatTokens(totalCacheWrite)} written
      </Text>
      {totalSavings > 0 && (
        <Text wrap="truncate-end">
          <Text color="green">{formatCost(totalSavings)}</Text>
          <Text dimColor> saved by local models</Text>
        </Text>
      )}
      {durable && carriedCostNote(durable.carriedCostUSD) && (
        <Text dimColor wrap="truncate-end">  {carriedCostNote(durable.carriedCostUSD)}</Text>
      )}
      {activePlanUsages.length > 0 && (
        <>
          {activePlanUsages.map(planUsage => {
            const color = planColor(planUsage)
            return (
              <React.Fragment key={planUsage.plan.provider}>
                <Text wrap="truncate-end">
                  <Text color={color}>{planLabel(planUsage)}: {formatCost(planUsage.spentApiEquivalentUsd)} API-equivalent vs {formatCost(planUsage.budgetUsd)} plan</Text>
                  <Text>  </Text>
                  <Text color={color}>{renderPlanBar(planUsage.percentUsed, PLAN_BAR_WIDTH)}</Text>
                  <Text> </Text>
                  <Text bold color={color}>{planUsage.percentUsed.toFixed(1)}%</Text>
                </Text>
                <Text dimColor wrap="truncate-end">{planStatusText(planUsage)}</Text>
              </React.Fragment>
            )
          })}
        </>
      )}
    </Box>
  )
}

export function getDailyActivityRows(projects: ProjectSummary[]): DailyActivityRow[] {
  const dailyCosts: Record<string, number> = {}
  const dailyCalls: Record<string, number> = {}
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const turn of session.turns) {
        if (!turn.timestamp) continue
        const day = dateKey(turn.timestamp)
        dailyCosts[day] = (dailyCosts[day] ?? 0) + turn.assistantCalls.reduce((s, c) => s + c.costUSD, 0)
        dailyCalls[day] = (dailyCalls[day] ?? 0) + turn.assistantCalls.length
      }
    }
  }
  return Object.keys(dailyCosts).sort().map(day => ({
    day,
    cost: dailyCosts[day] ?? 0,
    calls: dailyCalls[day] ?? 0,
  }))
}

function DailyActivity({ projects, days = 14, pw, bw, scrollable = false, cursor = 0, loading = false }: { projects: ProjectSummary[]; days?: number; pw: number; bw: number; scrollable?: boolean; cursor?: number; loading?: boolean }) {
  const allRows = getDailyActivityRows(projects)
  const orderedRows = scrollable ? [...allRows].reverse() : allRows
  const rows = scrollable ? orderedRows.slice(cursor, cursor + days) : orderedRows.slice(-days)
  const maxCost = Math.max(0, ...(scrollable ? orderedRows : rows).map(row => row.cost))

  return (
    <Panel title="Daily Activity" color={PANEL_COLORS.daily} width={pw}>
      {loading
        ? <Text dimColor>Loading daily history...</Text>
        : <>
            <DataRow panelWidth={pw} barWidth={bw} label="" dimColor metrics={[{ text: 'cost', dimColor: true }, { text: 'calls', dimColor: true }]} />
            {rows.map(row => (
              <DataRow
                key={row.day}
                panelWidth={pw}
                barWidth={bw}
                label={scrollable ? row.day : row.day.slice(5)}
                labelColor={DIM}
                bar={{ value: row.cost, max: maxCost }}
                metrics={[{ text: formatCost(row.cost), color: GOLD }, { text: String(row.calls) }]}
              />
            ))}
            {scrollable && orderedRows.length > 0 && (
              <Text dimColor wrap="truncate-end">{dailyActivityFooter(cursor, days, orderedRows.length)}</Text>
            )}
          </>}
    </Panel>
  )
}

const _home = homedir()
const _homePrefix = _home.endsWith('/') ? _home : _home + '/'

export function shortProject(absPath: string): string {
  const normalized = absPath.replace(/\\/g, '/')
  let path: string
  if (normalized === _home) path = ''
  else if (normalized.startsWith(_homePrefix)) path = normalized.slice(_homePrefix.length)
  else path = normalized
  path = path.replace(/^\/+/, '')
  path = path.replace(/^private\/tmp\/[^/]+\/[^/]+\//, '').replace(/^private\/tmp\//, '').replace(/^tmp\//, '')
  if (!path) return 'home'
  const parts = path.split('/').filter(Boolean)
  if (parts.length <= 3) return parts.join('/')
  return parts.slice(-3).join('/')
}

export function getDashboardMaxWidth(projects: ProjectSummary[], budgets?: Map<string, ContextBudget>, activeProvider?: string): number {
  const sessions = projects.flatMap(project => project.sessions)
  const longest = (values: string[]) => Math.max(1, ...values.map(value => value.length))
  const rowWidth = (labels: string[], metricCount: number, metricWidth = 7) =>
    PANEL_CHROME + 10 + 1 + longest(labels) + metricCount * metricWidth
  const modelTotals = aggregateModelTotals(projects)
  const hasTiming = Object.values(modelTotals).some(model => model.activeDurationMs > 0 && model.activeGeneratedTokens > 0)
  const categoryLabels = sessions.flatMap(session => Object.keys(session.categoryBreakdown).map(category => CATEGORY_LABELS[category as TaskCategory] ?? category))
  const skillLabels = sessions.flatMap(session => Object.keys(session.skillBreakdown))
  const agentLabels = sessions.flatMap(session => Object.keys(session.subagentBreakdown))
  const widestPanel = Math.max(
    rowWidth(['2026-00-00'], 2),
    rowWidth(projects.map(project => shortProject(project.projectPath)), budgets?.size ? 4 : 3, budgets?.size ? 9 : 7),
    rowWidth(Object.keys(modelTotals), hasTiming ? 5 : 4),
    rowWidth([...categoryLabels, ...skillLabels.map(skill => `  /${skill}`)], 3),
    rowWidth(sessions.flatMap(session => Object.keys(session.mcpBreakdown)), 1),
    rowWidth(sessions.flatMap(session => Object.keys(session.toolBreakdown).filter(tool => activeProvider === 'cursor' ? tool.startsWith('lang:') : !tool.startsWith('lang:'))), 1),
    rowWidth(sessions.flatMap(session => Object.keys(session.bashBreakdown)), 1),
    rowWidth([...skillLabels, ...agentLabels], 2),
  )
  return Math.min(MAX_DASHBOARD_WIDTH, Math.max(135, widestPanel * 3))
}

function ProjectBreakdown({ projects, pw, bw, budgets, rows = 14 }: { projects: ProjectSummary[]; pw: number; bw: number; budgets?: Map<string, ContextBudget>; rows?: number }) {
  const maxCost = Math.max(...projects.map(p => p.totalCostUSD))
  const hasBudgets = budgets && budgets.size > 0
  const headers = ['cost', 'avg/s', 'sess', ...(hasBudgets ? ['overhead'] : [])]
  const metricCellWidth = hasBudgets ? 9 : 7
  const projectBarWidth = hasBudgets
    ? Math.min(bw, Math.max(1, pw - PANEL_CHROME - 1 - headers.length * metricCellWidth - 10))
    : bw
  return (
    <Panel title="By Project" color={PANEL_COLORS.project} width={pw}>
      <DataRow panelWidth={pw} barWidth={projectBarWidth} label="" metrics={headers.map(text => ({ text, dimColor: true }))} metricCellWidth={metricCellWidth} />
      {projects.slice(0, rows).map((project, i) => {
        const budget = budgets?.get(project.project)
        const avgCost = project.sessions.length > 0
          ? formatCost(project.totalCostUSD / project.sessions.length)
          : '-'
        return (
          <DataRow
            key={`${project.project}-${i}`}
            panelWidth={pw}
            barWidth={projectBarWidth}
            label={shortProject(project.projectPath)}
            labelColor={DIM}
            bar={{ value: project.totalCostUSD, max: maxCost }}
            metrics={[
              { text: formatCost(project.totalCostUSD), color: GOLD },
              { text: avgCost, color: GOLD },
              { text: String(project.sessions.length) },
              ...(hasBudgets ? [{ text: budget ? formatTokens(budget.total) : '-', color: '#7B9EF5' }] : []),
            ]}
            metricCellWidth={metricCellWidth}
          />
        )
      })}
    </Panel>
  )
}

const MIN_EDIT_TURNS_FOR_RATE = 5

function ModelBreakdown({ projects, pw, bw }: { projects: ProjectSummary[]; pw: number; bw: number }) {
  // Keyed by friendly display name so mixed-vintage cache keys that resolve to
  // the same model merge into one row (see aggregateModelTotals).
  const modelTotals = aggregateModelTotals(projects)
  const modelEfficiency = aggregateModelEfficiency(projects)
  const anyEstimated = Object.values(modelTotals).some(d => d.estimatedCostUSD > 0)
  const anyActiveTiming = Object.values(modelTotals).some(d => d.activeDurationMs > 0 && d.activeGeneratedTokens > 0)
  // The Tok/s column needs 61 inner columns for the full row; hide it on narrower
  // panels and when no model has timing data (non-Codex users get no dead column).
  const showTps = pw - PANEL_CHROME >= 61 && anyActiveTiming
  const sorted = Object.entries(modelTotals).sort(([, a], [, b]) => b.costUSD - a.costUSD)
  const maxCost = sorted[0]?.[1]?.costUSD ?? 0
  const unpriced = findUnpricedModels(Object.entries(modelTotals).map(([model, d]) => ({
    model,
    calls: d.calls,
    cost: d.costUSD,
    tokens: d.freshInput + d.cacheRead + d.cacheWrite,
  })))

  return (
    <Panel title="By Model" color={PANEL_COLORS.model} width={pw}>
      <DataRow panelWidth={pw} barWidth={bw} label="" metrics={['cost', 'cache', 'calls', '1-shot', ...(showTps ? ['Tok/s'] : [])].map(text => ({ text, dimColor: true }))} />
      {sorted.map(([model, data], i) => {
        const totalInput = data.freshInput + data.cacheRead + data.cacheWrite
        const cacheHit = totalInput > 0 ? (data.cacheRead / totalInput) * 100 : 0
        const cacheLabel = totalInput > 0 ? `${cacheHit.toFixed(1)}%` : '-'
        const efficiency = modelEfficiency.get(model)
        const oneShotLabel = efficiency && efficiency.editTurns >= MIN_EDIT_TURNS_FOR_RATE && efficiency.oneShotRate !== null
          ? `${efficiency.oneShotRate.toFixed(1)}%`
          : '-'
        const tpsLabel = data.activeDurationMs > 0 && data.activeGeneratedTokens > 0
          ? (data.activeGeneratedTokens / (data.activeDurationMs / 1000)).toFixed(1)
          : '-'
        return (
          <DataRow
            key={`${model}-${i}`}
            panelWidth={pw}
            barWidth={bw}
            label={model}
            bar={{ value: data.costUSD, max: maxCost }}
            metrics={[
              { text: markEstimated(formatCost(data.costUSD), data.estimatedCostUSD > 0), color: GOLD },
              { text: cacheLabel },
              { text: String(data.calls) },
              { text: oneShotLabel },
              ...(showTps ? [{ text: tpsLabel }] : []),
            ]}
          />
        )
      })}
      {unpriced.length > 0 && (
        <Text color="yellow" wrap="truncate-end">
          {`! ${unpriced.length} model${unpriced.length === 1 ? '' : 's'} unpriced at $0, fix: codeburn model-alias (${unpriced.slice(0, 2).map(u => u.model).join(', ')}${unpriced.length > 2 ? ', ...' : ''})`}
        </Text>
      )}
      {anyEstimated && (
        <Text dimColor wrap="truncate-end">~ estimated cost (priced from estimated tokens)</Text>
      )}
      {showTps && (
        <Text dimColor wrap="truncate-end">~ Tok/s: generated tokens / active time; tool wait excluded</Text>
      )}
    </Panel>
  )
}

const SKILL_SUB_ROWS_LIMIT = 5

function ActivityBreakdown({ projects, pw, bw }: { projects: ProjectSummary[]; pw: number; bw: number }) {
  const categoryTotals: Record<string, { turns: number; costUSD: number; editTurns: number; oneShotTurns: number }> = {}
  const skillTotals: Record<string, { turns: number; costUSD: number; editTurns: number; oneShotTurns: number }> = {}
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const [cat, data] of Object.entries(session.categoryBreakdown)) {
        if (!categoryTotals[cat]) categoryTotals[cat] = { turns: 0, costUSD: 0, editTurns: 0, oneShotTurns: 0 }
        categoryTotals[cat].turns += data.turns
        categoryTotals[cat].costUSD += data.costUSD
        categoryTotals[cat].editTurns += data.editTurns
        categoryTotals[cat].oneShotTurns += data.oneShotTurns
      }
      for (const [skill, data] of Object.entries(session.skillBreakdown ?? {})) {
        if (!skillTotals[skill]) skillTotals[skill] = { turns: 0, costUSD: 0, editTurns: 0, oneShotTurns: 0 }
        skillTotals[skill].turns += data.turns
        skillTotals[skill].costUSD += data.costUSD
        skillTotals[skill].editTurns += data.editTurns
        skillTotals[skill].oneShotTurns += data.oneShotTurns
      }
    }
  }
  const sorted = Object.entries(categoryTotals).sort(([, a], [, b]) => b.costUSD - a.costUSD)
  const sortedSkills = Object.entries(skillTotals).sort(([, a], [, b]) => b.costUSD - a.costUSD).slice(0, SKILL_SUB_ROWS_LIMIT)
  const maxCost = sorted[0]?.[1]?.costUSD ?? 0
  return (
    <Panel title="By Activity" color={PANEL_COLORS.activity} width={pw}>
      <DataRow panelWidth={pw} barWidth={bw} label="" metrics={['cost', 'turns', '1-shot'].map(text => ({ text, dimColor: true }))} />
      {sorted.flatMap(([cat, data]) => {
        const oneShotPct = data.editTurns > 0 ? Math.round((data.oneShotTurns / data.editTurns) * 100) + '%' : '-'
        const rows: React.ReactNode[] = [
          <DataRow
            key={cat}
            panelWidth={pw}
            barWidth={bw}
            label={CATEGORY_LABELS[cat as TaskCategory] ?? cat}
            labelColor={CATEGORY_COLORS[cat as TaskCategory] ?? '#666666'}
            bar={{ value: data.costUSD, max: maxCost }}
            metrics={[
              { text: formatCost(data.costUSD), color: GOLD },
              { text: String(data.turns) },
              { text: oneShotPct, color: data.editTurns === 0 ? DIM : oneShotPct === '100%' ? '#5BF58C' : ORANGE },
            ]}
          />,
        ]
        if (cat === 'general' && sortedSkills.length > 0) {
          for (const [skill, sd] of sortedSkills) {
            const subPct = sd.editTurns > 0 ? Math.round((sd.oneShotTurns / sd.editTurns) * 100) + '%' : '-'
            rows.push(
              <DataRow
                key={`${cat}:${skill}`}
                panelWidth={pw}
                barWidth={bw}
                label={`  /${skill}`}
                dimColor
                bar={{ value: sd.costUSD, max: maxCost }}
                metrics={[{ text: formatCost(sd.costUSD), dimColor: true }, { text: String(sd.turns), dimColor: true }, { text: subPct, dimColor: true }]}
              />,
            )
          }
        }
        return rows
      })}
    </Panel>
  )
}

function ToolBreakdown({ projects, pw, bw, title, filterPrefix }: { projects: ProjectSummary[]; pw: number; bw: number; title?: string; filterPrefix?: string }) {
  const toolTotals: Record<string, number> = {}
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const [tool, data] of Object.entries(session.toolBreakdown)) {
        if (filterPrefix) { if (!tool.startsWith(filterPrefix)) continue } else { if (tool.startsWith('lang:')) continue }
        toolTotals[tool] = (toolTotals[tool] ?? 0) + data.calls
      }
    }
  }
  const sorted = Object.entries(toolTotals).sort(([, a], [, b]) => b - a)
  const maxCalls = sorted[0]?.[1] ?? 0
  return (
    <Panel title={title ?? 'Core Tools'} color={PANEL_COLORS.tools} width={pw}>
      <DataRow panelWidth={pw} barWidth={bw} label="" metrics={[{ text: 'calls', dimColor: true }]} />
      {sorted.slice(0, 10).map(([tool, calls]) => {
        const raw = filterPrefix ? tool.slice(filterPrefix.length) : tool
        const display = filterPrefix ? (LANG_DISPLAY_NAMES[raw] ?? raw) : raw
        return (
          <DataRow key={tool} panelWidth={pw} barWidth={bw} label={display} bar={{ value: calls, max: maxCalls }} metrics={[{ text: String(calls) }]} />
        )
      })}
    </Panel>
  )
}


function McpBreakdown({ projects, pw, bw }: { projects: ProjectSummary[]; pw: number; bw: number }) {
  const mcpTotals: Record<string, number> = {}
  for (const project of projects) { for (const session of project.sessions) { for (const [server, data] of Object.entries(session.mcpBreakdown)) { mcpTotals[server] = (mcpTotals[server] ?? 0) + data.calls } } }
  const sorted = Object.entries(mcpTotals).sort(([, a], [, b]) => b - a)
  if (sorted.length === 0) return <Panel title="MCP Servers" color={PANEL_COLORS.mcp} width={pw}><Text dimColor>No MCP usage</Text></Panel>
  const maxCalls = sorted[0]?.[1] ?? 0
  return (
    <Panel title="MCP Servers" color={PANEL_COLORS.mcp} width={pw}>
      <DataRow panelWidth={pw} barWidth={bw} label="" metrics={[{ text: 'calls', dimColor: true }]} />
      {sorted.slice(0, 8).map(([server, calls]) => (
        <DataRow key={server} panelWidth={pw} barWidth={bw} label={server} bar={{ value: calls, max: maxCalls }} metrics={[{ text: String(calls) }]} />
      ))}
    </Panel>
  )
}

function BashBreakdown({ projects, pw, bw }: { projects: ProjectSummary[]; pw: number; bw: number }) {
  const bashTotals: Record<string, number> = {}
  for (const project of projects) { for (const session of project.sessions) { for (const [cmd, data] of Object.entries(session.bashBreakdown)) { bashTotals[cmd] = (bashTotals[cmd] ?? 0) + data.calls } } }
  const sorted = Object.entries(bashTotals).sort(([, a], [, b]) => b - a)
  if (sorted.length === 0) return <Panel title="Shell Commands" color={PANEL_COLORS.bash} width={pw}><Text dimColor>No shell commands</Text></Panel>
  const maxCalls = sorted[0]?.[1] ?? 0
  return (
    <Panel title="Shell Commands" color={PANEL_COLORS.bash} width={pw}>
      <DataRow panelWidth={pw} barWidth={bw} label="" metrics={[{ text: 'calls', dimColor: true }]} />
      {sorted.slice(0, 10).map(([cmd, calls]) => (
        <DataRow key={cmd} panelWidth={pw} barWidth={bw} label={cmd} bar={{ value: calls, max: maxCalls }} metrics={[{ text: String(calls) }]} />
      ))}
    </Panel>
  )
}

function SkillsAndAgents({ projects, pw, bw }: { projects: ProjectSummary[]; pw: number; bw: number }) {
  const merged: Record<string, { uses: number; cost: number }> = {}
  for (const project of projects) { for (const session of project.sessions) {
    for (const [skill, d] of Object.entries(session.skillBreakdown)) { const e = merged[skill] ?? { uses: 0, cost: 0 }; e.uses += d.turns; e.cost += d.costUSD; merged[skill] = e }
    for (const [agent, d] of Object.entries(session.subagentBreakdown)) { const e = merged[agent] ?? { uses: 0, cost: 0 }; e.uses += d.calls; e.cost += d.costUSD; merged[agent] = e }
  } }
  const sorted = Object.entries(merged).sort(([, a], [, b]) => b.cost - a.cost)
  if (sorted.length === 0) return <Panel title="Skills & Agents" color={PANEL_COLORS.skills} width={pw}><Text dimColor>No skill/agent usage</Text></Panel>
  const maxCost = sorted[0]?.[1]?.cost ?? 0
  return (
    <Panel title="Skills & Agents" color={PANEL_COLORS.skills} width={pw}>
      <DataRow panelWidth={pw} barWidth={bw} label="" metrics={['uses', 'cost'].map(text => ({ text, dimColor: true }))} />
      {sorted.slice(0, 10).map(([name, d]) => (
        <DataRow key={name} panelWidth={pw} barWidth={bw} label={name} bar={{ value: d.cost, max: maxCost }} metrics={[{ text: String(d.uses) }, { text: formatCost(d.cost), color: GOLD }]} />
      ))}
    </Panel>
  )
}

// Claude Code only: real subagent-transcript spend by agentType
// (workflow-subagent / Explore / general-purpose / …). Returns null when there
// are no agent transcripts, so it never shows for other providers.
function ClaudeAgentTypes({ projects, pw, bw }: { projects: ProjectSummary[]; pw: number; bw: number }) {
  const merged: Record<string, { uses: number; cost: number }> = {}
  for (const project of projects) { for (const session of project.sessions) {
    if (!session.agentType) continue
    const e = merged[session.agentType] ?? { uses: 0, cost: 0 }
    e.uses += session.apiCalls; e.cost += session.totalCostUSD; merged[session.agentType] = e
  } }
  const sorted = Object.entries(merged).sort(([, a], [, b]) => b.cost - a.cost)
  if (sorted.length === 0) return null
  const maxCost = sorted[0]?.[1]?.cost ?? 0
  return (
    <Panel title="Claude Agent Types" color={PANEL_COLORS.skills} width={pw}>
      <DataRow panelWidth={pw} barWidth={bw} label="" metrics={['calls', 'cost'].map(text => ({ text, dimColor: true }))} />
      {sorted.slice(0, 10).map(([name, d]) => (
        <DataRow key={name} panelWidth={pw} barWidth={bw} label={name} bar={{ value: d.cost, max: maxCost }} metrics={[{ text: String(d.uses) }, { text: formatCost(d.cost), color: GOLD }]} />
      ))}
    </Panel>
  )
}

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  all: 'All',
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  'ibm-bob': 'IBM Bob',
  opencode: 'OpenCode',
  pi: 'Pi',
  kimi: 'Kimi',
  kimicode: 'Kimi Code',
}
function getProviderDisplayName(name: string): string { return PROVIDER_DISPLAY_NAMES[name] ?? name }

function PeriodTabs({ active, providerName, showProvider }: { active: Period; providerName?: string; showProvider?: boolean }) {
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Box gap={1}>
        {PERIODS.map(p => (
          <Text key={p} bold={active === p} color={active === p ? ORANGE : DIM}>
            {active === p ? `[ ${PERIOD_LABELS[p]} ]` : `  ${PERIOD_LABELS[p]}  `}
          </Text>
        ))}
      </Box>
      {showProvider && providerName && (
        <Box><Text color={DIM}>|  </Text><Text color={ORANGE} bold>[p]</Text><Text bold color={PROVIDER_COLORS[providerName] ?? ORANGE}> {getProviderDisplayName(providerName)}</Text></Box>
      )}
    </Box>
  )
}

/// Header for an action's intended destination. Helps users distinguish a
/// permanent CLAUDE.md rule from a one-time session opener so they don't
/// accidentally bake a single-run constraint into their project's permanent
/// instructions. Issue #277.
function actionDestinationHeader(action: WasteAction): string {
  switch (action.type) {
    case 'file-content':
      return `── Suggested ${action.path} addition `.padEnd(64, '─')
    case 'command':
      return '── Run this command '.padEnd(64, '─')
    case 'paste': {
      switch (action.destination) {
        case 'claude-md':
          return '── Suggested CLAUDE.md addition (permanent rule) '.padEnd(64, '─')
        case 'session-opener':
          return '── One-time session opener (do not add to CLAUDE.md) '.padEnd(64, '─')
        case 'prompt':
          return '── Ask Claude in the current session '.padEnd(64, '─')
        case 'shell-config':
          return '── Add to your shell config '.padEnd(64, '─')
        default:
          return '── Suggested action '.padEnd(64, '─')
      }
    }
  }
}

function FindingAction({ action }: { action: WasteAction }) {
  const lines = action.type === 'file-content' ? action.content.split('\n') : action.type === 'command' ? action.text.split('\n') : [action.text]
  const header = actionDestinationHeader(action)
  return (
    <>
      <Text color={ORANGE}>{header}</Text>
      <Text dimColor>{action.label}</Text>
      {lines.map((line, i) => <Text key={i} color="#5BF5E0">  {line}</Text>)}
    </>
  )
}

function FindingPanel({ index, finding, costRate, width }: { index: number; finding: WasteFinding; costRate: number; width: number }) {
  const costSaved = finding.tokensSaved * costRate
  const color = IMPACT_PANEL_COLORS[finding.impact] ?? DIM
  const label = finding.impact.charAt(0).toUpperCase() + finding.impact.slice(1)
  const trendBadge = finding.trend === 'improving' ? ' improving \u2193' : ''
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} width={width}>
      <Text wrap="truncate-end">
        <Text bold>{index}. {finding.title}</Text>
        <Text>  </Text>
        <Text color={color}>{label}</Text>
        {trendBadge && <Text color="#5BF5A0">{trendBadge}</Text>}
      </Text>
      <Text dimColor wrap="wrap">{finding.explanation}</Text>
      <Text color={GOLD}>Savings: ~{formatTokens(finding.tokensSaved)} tokens (~{formatCost(costSaved)})</Text>
      <Text> </Text>
      <FindingAction action={finding.fix} />
    </Box>
  )
}

const GRADE_COLORS: Record<string, string> = { A: '#5BF5A0', B: '#5BF5A0', C: GOLD, D: ORANGE, F: '#F55B5B' }

// Each finding panel takes ~6-8 lines. Show 3 at a time so the window fits a
// 30-line terminal alongside the optimize header + status bar; users page
// with j/k. Without this cap, 4 new detectors + 7 originals scrolled findings
// off the alt-buffer top and the user couldn't see the StatusBar at all.
const FINDINGS_WINDOW_SIZE = 3

function OptimizeView({ findings, costRate, projects, label, width, healthScore, healthGrade, cursor }: { findings: WasteFinding[]; costRate: number; projects: ProjectSummary[]; label: string; width: number; healthScore: number; healthGrade: string; cursor: number }) {
  const periodCost = projects.reduce((s, p) => s + p.totalCostUSD, 0)
  const totalTokens = findings.reduce((s, f) => s + f.tokensSaved, 0)
  const totalCost = totalTokens * costRate
  const pctRaw = periodCost > 0 ? (totalCost / periodCost) * 100 : 0
  const pct = pctRaw >= 1 ? pctRaw.toFixed(0) : pctRaw.toFixed(1)
  const gradeColor = GRADE_COLORS[healthGrade] ?? DIM
  const total = findings.length
  const start = total === 0 ? 0 : Math.min(cursor, Math.max(0, total - FINDINGS_WINDOW_SIZE))
  const end = Math.min(start + FINDINGS_WINDOW_SIZE, total)
  const visible = findings.slice(start, end)
  return (
    <Box flexDirection="column" width={width}>
      <Box flexDirection="column" borderStyle="round" borderColor={ORANGE} paddingX={1} width={width}>
        <Text wrap="truncate-end">
          <Text bold color={ORANGE}>CodeBurn Optimize</Text>
          <Text dimColor>  {label}   Setup: </Text>
          <Text bold color={gradeColor}>{healthGrade}</Text>
          <Text dimColor> ({healthScore}/100)</Text>
        </Text>
        <Text color="#5BF5A0" wrap="truncate-end">Savings: ~{formatTokens(totalTokens)} tokens (~{formatCost(totalCost)}, ~{pct}% of spend)</Text>
        {total > FINDINGS_WINDOW_SIZE && (
          <Text dimColor>Showing {start + 1}–{end} of {total} · j/k to scroll</Text>
        )}
      </Box>
      {visible.map((f, i) => <FindingPanel key={start + i} index={start + i + 1} finding={f} costRate={costRate} width={width} />)}
      <Box paddingX={1} width={width}><Text dimColor>Token estimates are approximate.</Text></Box>
    </Box>
  )
}

function StatusBar({ width, showProvider, view, findingCount, optimizeAvailable, compareAvailable, customRange, dayMode }: { width: number; showProvider?: boolean; view?: View; findingCount?: number; optimizeAvailable?: boolean; compareAvailable?: boolean; customRange?: boolean; dayMode?: boolean }) {
  const isOptimize = view === 'optimize'
  return (
    <Box borderStyle="round" borderColor={DIM} width={width} justifyContent="center" paddingX={1}>
      <Text>
        {isOptimize
          ? <><Text color={ORANGE} bold>b</Text><Text dimColor> back   </Text><Text color={ORANGE} bold>j</Text><Text dimColor>/</Text><Text color={ORANGE} bold>k</Text><Text dimColor> scroll   </Text></>
          : dayMode
            ? <><Text color={ORANGE} bold>{'<'}</Text><Text color={ORANGE}>{'>'}</Text><Text dimColor> day   </Text></>
            : !customRange
            ? <><Text color={ORANGE} bold>{'<'}</Text><Text color={ORANGE}>{'>'}</Text><Text dimColor> switch   </Text></>
            : null}
        <Text color={ORANGE} bold>q</Text><Text dimColor> quit</Text>
        {!customRange && !isOptimize && (
          <>
            <Text dimColor>   </Text><Text color={ORANGE} bold>1</Text><Text dimColor> today   </Text>
            <Text color={ORANGE} bold>2</Text><Text dimColor> week   </Text>
            <Text color={ORANGE} bold>3</Text><Text dimColor> 30 days   </Text>
            <Text color={ORANGE} bold>4</Text><Text dimColor> month   </Text>
            <Text color={ORANGE} bold>5</Text><Text dimColor> 6 months   </Text>
            <Text color={ORANGE} bold>6</Text><Text dimColor> lifetime</Text>
          </>
        )}
        {!customRange && !isOptimize && (
          <>
            <Text dimColor>   </Text><Text color={ORANGE} bold>d</Text><Text dimColor>{dayMode ? ' exit day' : ' yesterday'}</Text>
          </>
        )}
        {!isOptimize && optimizeAvailable && (
          <><Text dimColor>   </Text><Text color={ORANGE} bold>o</Text><Text dimColor> optimize</Text>{findingCount != null && findingCount > 0 ? <Text color="#F55B5B"> ({findingCount})</Text> : null}</>
        )}
        {!isOptimize && compareAvailable && (
          <><Text dimColor>   </Text><Text color={ORANGE} bold>c</Text><Text dimColor> compare</Text></>
        )}
        {!isOptimize && !customRange && !dayMode && view === 'dashboard' && (
          <>
            <Text dimColor>   </Text><Text color={PANEL_COLORS.daily} bold>j</Text><Text dimColor>/</Text><Text color={PANEL_COLORS.daily} bold>k</Text><Text dimColor> daily   </Text>
            <Text color={PANEL_COLORS.daily} bold>PgUp</Text><Text dimColor>/</Text><Text color={PANEL_COLORS.daily} bold>PgDn</Text><Text dimColor> page</Text>
          </>
        )}
        {showProvider && (<><Text dimColor>   </Text><Text color={ORANGE} bold>p</Text><Text dimColor> provider</Text></>)}
      </Text>
    </Box>
  )
}

function DashboardContent({ projects, period, columns, maxContentWidth, activeProvider, budgets, planUsages, label, dayMode, dailyHistoryProjects, scrollableDailyHistory = false, dailyHistoryCursor = 0, dailyHistoryLoading = false, durable }: { projects: ProjectSummary[]; period: Period; columns?: number; maxContentWidth: number; activeProvider?: string; budgets?: Map<string, ContextBudget>; planUsages?: PlanUsage[]; label?: string; dayMode?: boolean; dailyHistoryProjects?: ProjectSummary[]; scrollableDailyHistory?: boolean; dailyHistoryCursor?: number; dailyHistoryLoading?: boolean; durable?: DurableOverview }) {
  const { dashWidth, panelWidth, barWidth } = getLayout(columns, maxContentWidth)
  const isCursor = activeProvider === 'cursor'
  const activeLabel = label ?? PERIOD_LABELS[period]
  if (showEmptyState(projects.length, scrollableDailyHistory, (dailyHistoryProjects ?? []).length, dailyHistoryLoading)) return <Panel title="CodeBurn" color={ORANGE} width={dashWidth}><Text dimColor>No usage data found for {activeLabel}.</Text></Panel>
  const days = dayMode ? 1 : DAILY_ACTIVITY_PAGE_SIZE
  // A provider-scoped plan (e.g. SuperGrok) only makes sense on its own
  // provider tab, where the shown cost matches the plan's spend. Hide it on
  // every other tab, including All, so its budget isn't compared to spend it
  // doesn't cover.
  const visiblePlanUsages = (planUsages ?? []).filter(p => p.plan.provider === (activeProvider ?? 'all'))
  return (
    <Box flexDirection="column" width={dashWidth}>
      <Overview projects={projects} label={activeLabel} width={dashWidth} planUsages={visiblePlanUsages} durable={durable} />
      <Box flexWrap="wrap" width={dashWidth}>
        <DailyActivity projects={scrollableDailyHistory ? (dailyHistoryProjects ?? []) : projects} days={days} pw={panelWidth} bw={barWidth} scrollable={scrollableDailyHistory} cursor={dailyHistoryCursor} loading={dailyHistoryLoading} />
        <ProjectBreakdown projects={projects} pw={panelWidth} bw={barWidth} budgets={budgets} rows={dayMode ? 8 : period === 'all' || period === 'lifetime' ? 14 : period === 'month' || period === '30days' ? 14 : 8} />
        <ActivityBreakdown projects={projects} pw={panelWidth} bw={barWidth} />
        <ModelBreakdown projects={projects} pw={panelWidth} bw={barWidth} />
        {isCursor
          ? <ToolBreakdown projects={projects} pw={panelWidth} bw={barWidth} title="Languages" filterPrefix="lang:" />
          : <>
              <McpBreakdown projects={projects} pw={panelWidth} bw={barWidth} />
              <ToolBreakdown projects={projects} pw={panelWidth} bw={barWidth} />
              <BashBreakdown projects={projects} pw={panelWidth} bw={barWidth} />
              <SkillsAndAgents projects={projects} pw={panelWidth} bw={barWidth} />
              <ClaudeAgentTypes projects={projects} pw={panelWidth} bw={barWidth} />
            </>}
      </Box>
    </Box>
  )
}

export function InteractiveDashboard({ initialProjects, initialDailyHistoryProjects, initialPeriod, initialProvider, initialPlanUsages, initialDurable, refreshSeconds, projectFilter, excludeFilter, customRange, customRangeLabel, initialDay, windowColumns, layoutMetricsRef }: {
  initialProjects: ProjectSummary[]
  initialDailyHistoryProjects?: ProjectSummary[]
  initialPeriod: Period
  initialProvider: string
  initialPlanUsages?: PlanUsage[]
  initialDurable?: DurableOverview
  refreshSeconds?: number
  projectFilter?: string[]
  excludeFilter?: string[]
  customRange?: DateRange | null
  customRangeLabel?: string
  initialDay?: string
  windowColumns: number
  layoutMetricsRef?: { current: { dashWidth: number; maxContentWidth: number } }
}) {
  const { exit } = useApp()
  const [period, setPeriod] = useState<Period>(initialPeriod)
  const [projects, setProjects] = useState<ProjectSummary[]>(initialProjects)
  const [durable, setDurable] = useState<DurableOverview | undefined>(initialDurable)
  const [loading, setLoading] = useState(false)
  const [activeProvider, setActiveProvider] = useState(initialProvider)
  const [detectedProviders, setDetectedProviders] = useState<string[]>([])
  const [view, setView] = useState<View>('dashboard')
  const [optimizeResult, setOptimizeResult] = useState<OptimizeResult | null>(null)
  const [optimizeLoading, setOptimizeLoading] = useState(false)
  const [projectBudgets, setProjectBudgets] = useState<Map<string, ContextBudget>>(new Map())
  const [planUsages, setPlanUsages] = useState<PlanUsage[]>(initialPlanUsages ?? [])
  const [dayDate, setDayDate] = useState<string | null>(initialDay ?? null)
  const [dailyHistoryProjects, setDailyHistoryProjects] = useState<ProjectSummary[]>(initialDailyHistoryProjects ?? initialProjects)
  const [dailyHistoryCursor, setDailyHistoryCursor] = useState(0)
  // Cursor for the OptimizeView's findings window. Reset whenever the user
  // leaves the optimize view OR the underlying findings change so a long
  // findings list never strands the user past the new array length.
  const [findingsCursor, setFindingsCursor] = useState(0)
  const isDayMode = dayDate != null
  const isCustomRange = customRange != null && !isDayMode
  const scrollableDailyHistory = !isCustomRange && !isDayMode
  const columns = windowColumns
  const maxContentWidth = useMemo(
    () => getDashboardMaxWidth(projects, projectBudgets, activeProvider),
    [projects, projectBudgets, activeProvider],
  )
  const { dashWidth } = getLayout(columns, maxContentWidth)
  if (layoutMetricsRef) layoutMetricsRef.current = { dashWidth, maxContentWidth }
  const dailyHistoryPageSize = isDayMode ? 1 : DAILY_ACTIVITY_PAGE_SIZE
  const dailyHistoryRowCount = getDailyActivityRows(dailyHistoryProjects).length
  const dailyHistoryMaxCursor = Math.max(0, dailyHistoryRowCount - dailyHistoryPageSize)
  const multipleProviders = detectedProviders.length > 1
  const optimizeAvailable = !isCustomRange && (activeProvider === 'all' || activeProvider === 'claude')
  const modelCount = new Set(
    projects.flatMap(p => p.sessions.flatMap(s => Object.keys(s.modelBreakdown)))
  ).size
  const compareAvailable = modelCount >= 2
  const viewRef = useRef(view)
  viewRef.current = view
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reloadGenerationRef = useRef(0)
  const reloadInFlightRef = useRef(false)
  const currentReloadRef = useRef<{ period: Period; provider: string; day: string | null } | null>(null)
  const pendingReloadRef = useRef<{ period: Period; provider: string; day: string | null; background: boolean } | null>(null)
  const findingCount = optimizeResult?.findings.length ?? 0

  useEffect(() => {
    let cancelled = false
    async function detect() {
      const found: string[] = []
      for (const p of await getAllProviders()) { const s = await p.discoverSessions(); if (s.length > 0) found.push(p.name) }
      if (!cancelled) setDetectedProviders(found)
    }
    detect()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    async function loadBudgets() {
      const budgets = new Map<string, ContextBudget>()
      for (const project of projects.slice(0, 8)) {
        if (cancelled) return
        if (!project.projectPath.startsWith('/')) continue
        budgets.set(project.project, await estimateContextBudget(project.projectPath))
      }
      if (!cancelled) setProjectBudgets(budgets)
    }
    loadBudgets()
    return () => { cancelled = true }
  }, [projects])

  const reloadData = useCallback(async (p: Period, prov: string, day: string | null = null, background = false) => {
    if (reloadInFlightRef.current) {
      const current = currentReloadRef.current
      if (current?.period === p && current.provider === prov && current.day === day) {
        pendingReloadRef.current = null
        return
      }
      reloadGenerationRef.current++
      pendingReloadRef.current = { period: p, provider: prov, day, background }
      return
    }
    reloadInFlightRef.current = true
    currentReloadRef.current = { period: p, provider: prov, day }
    const shouldLoadHistory = !day && customRange == null
    const generation = ++reloadGenerationRef.current
    if (!background) {
      setLoading(true)
      setOptimizeLoading(false)
      setOptimizeResult(null)
    }
    try {
      if (!background && !day && isHeavyPeriod(p)) {
        setProjects([])
        setProjectBudgets(new Map())
        // Drop the previous period's durable headline so it can't flash on the
        // new tab before the fresh figure lands.
        setDurable(undefined)
        await nextTick()
        if (reloadGenerationRef.current !== generation) return
      }
      const range = getDashboardScanRange(p, customRange, day, shouldLoadHistory)
      const data = await parseAllSessions(range, prov)
      if (reloadGenerationRef.current !== generation) return

      const filteredProjects = filterProjectsByName(data, projectFilter, excludeFilter)
      if (reloadGenerationRef.current !== generation) return

      const selectedProjects = selectDashboardPeriodProjects(filteredProjects, p, shouldLoadHistory)
      // Durable headline totals (carry-forward cache + today), matching the
      // menubar/report.
      const durableTotals = await computeDurableOverview(p, prov, projectFilter, excludeFilter, customRange, day)
      if (reloadGenerationRef.current !== generation) return
      const usage = await getPlanUsages()
      if (reloadGenerationRef.current !== generation) return
      if (background && viewRef.current !== 'dashboard') return

      if (shouldLoadHistory) setDailyHistoryProjects(filteredProjects)
      setProjects(selectedProjects)
      setDurable(durableTotals)
      setPlanUsages(usage)
      if (background) setOptimizeResult(null)
    } catch (error) {
      console.error(error)
    } finally {
      if (!background && reloadGenerationRef.current === generation) {
        setLoading(false)
      }
      reloadInFlightRef.current = false
      currentReloadRef.current = null
      const pending = pendingReloadRef.current
      pendingReloadRef.current = null
      if (pending) {
        void reloadData(pending.period, pending.provider, pending.day, pending.background)
      }
    }
  }, [projectFilter, excludeFilter, customRange])

  const currentRange = useCallback(() => {
    return dayDate ? getDayRange(dayDate) : getPeriodRange(period)
  }, [dayDate, period])

  const loadOptimizeResult = useCallback(async () => {
    if (!optimizeAvailable || projects.length === 0 || optimizeLoading) return
    setView('optimize')
    setFindingsCursor(0)
    if (optimizeResult) return

    const generation = reloadGenerationRef.current
    setOptimizeLoading(true)
    try {
      const result = await scanAndDetect(projects, currentRange())
      if (reloadGenerationRef.current === generation) setOptimizeResult(result)
    } catch (error) {
      console.error(error)
    } finally {
      if (reloadGenerationRef.current === generation) setOptimizeLoading(false)
    }
  }, [optimizeAvailable, projects, currentRange, optimizeLoading, optimizeResult])

  useEffect(() => {
    const refreshIntervalMs = getRefreshIntervalMs(refreshSeconds ?? 0)
    if (refreshIntervalMs === 0) return
    if (view !== 'dashboard') return
    const id = setInterval(() => { void reloadData(period, activeProvider, dayDate, true) }, refreshIntervalMs)
    return () => clearInterval(id)
  }, [refreshSeconds, period, activeProvider, dayDate, reloadData, view])

  const switchPeriod = useCallback((np: Period) => {
    if (np === period && !dayDate) return
    // Clear projects + flip loading synchronously so the dashboard never
    // renders the new period label over the old period's numbers between
    // setPeriod() and the reloadData() promise resolving. Without this,
    // there's a frame-to-hundreds-of-ms window where users saw wrong
    // figures captioned with the new period.
    setPeriod(np)
    setDailyHistoryCursor(0)
    setDayDate(null)
    setProjects([])
    setLoading(true)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => { reloadData(np, activeProvider, null) }, 600)
  }, [period, activeProvider, dayDate, reloadData])

  const switchPeriodImmediate = useCallback(async (np: Period) => {
    if (np === period && !dayDate) return
    setPeriod(np)
    setDailyHistoryCursor(0)
    setDayDate(null)
    setProjects([])
    setLoading(true)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    await reloadData(np, activeProvider, null)
  }, [period, activeProvider, dayDate, reloadData])

  const switchDay = useCallback(async (nextDay: string) => {
    const today = parseDayFlag('today')!.day
    const clampedDay = nextDay > today ? today : nextDay
    if (clampedDay === dayDate) return
    setDayDate(clampedDay)
    setDailyHistoryCursor(0)
    setProjects([])
    setLoading(true)
    setView('dashboard')
    if (debounceRef.current) clearTimeout(debounceRef.current)
    await reloadData(period, activeProvider, clampedDay)
  }, [period, activeProvider, dayDate, reloadData])

  const enterYesterday = useCallback(async () => {
    const yesterday = parseDayFlag('yesterday')!.day
    await switchDay(yesterday)
  }, [switchDay])

  useInput((input, key) => {
    if (input === 'q') { exit(); return }
    if (input === 'o' && view === 'dashboard' && optimizeAvailable) { void loadOptimizeResult(); return }
    if ((input === 'b' || key.escape) && view === 'optimize') { setView('dashboard'); setFindingsCursor(0); return }
    if (view === 'optimize') {
      const total = optimizeResult?.findings.length ?? 0
      const maxStart = Math.max(0, total - FINDINGS_WINDOW_SIZE)
      if (input === 'j' || key.downArrow) { setFindingsCursor(c => Math.min(c + 1, maxStart)); return }
      if (input === 'k' || key.upArrow)   { setFindingsCursor(c => Math.max(c - 1, 0)); return }
      return
    }
    if (input === 'c' && compareAvailable && view === 'dashboard') { setView('compare'); return }
    if ((input === 'b' || key.escape) && view === 'compare') { setView('dashboard'); return }
    if (view === 'dashboard' && scrollableDailyHistory) {
      if (key.pageDown || (input === ' ' && !key.shift)) { setDailyHistoryCursor(c => pageHistoryCursor(c, 1, dailyHistoryPageSize, dailyHistoryRowCount)); return }
      if (key.pageUp || (input === ' ' && key.shift)) { setDailyHistoryCursor(c => pageHistoryCursor(c, -1, dailyHistoryPageSize, dailyHistoryRowCount)); return }
      if (input === 'j') { setDailyHistoryCursor(c => scrollHistoryCursor(c, 1, dailyHistoryPageSize, dailyHistoryRowCount)); return }
      if (input === 'k') { setDailyHistoryCursor(c => scrollHistoryCursor(c, -1, dailyHistoryPageSize, dailyHistoryRowCount)); return }
      if (input === 'g') { setDailyHistoryCursor(0); return }
      if (input === 'G') { setDailyHistoryCursor(dailyHistoryMaxCursor); return }
    }
    if (input === 'p' && multipleProviders && view !== 'compare') {
      const opts = ['all', ...detectedProviders]; const next = opts[(opts.indexOf(activeProvider) + 1) % opts.length]
      setActiveProvider(next); setView('dashboard')
      setDailyHistoryCursor(0)
      if (debounceRef.current) clearTimeout(debounceRef.current)
      reloadData(period, next, dayDate); return
    }
    // Period switches reload the underlying data. Disable them while the
    // compare view is mounted; the compare view re-aggregates from
    // `projects` and would visibly change underneath the user without any
    // affordance back to the dashboard. Press `b` or Esc to return first.
    if (view === 'compare') return
    if (!customRange && input === 'd') {
      if (dayDate) {
        setDayDate(null)
        setDailyHistoryCursor(0)
        setProjects([])
        setLoading(true)
        void reloadData(period, activeProvider, null)
      } else {
        void enterYesterday()
      }
      return
    }
    // Also disable while a custom --from/--to range is in effect. Switching
    // period would silently abandon the user's explicit range and reload
    // standard period data; the period tab strip is hidden in this mode so
    // users have no expectation that 1-6 should do anything.
    if (isCustomRange) return
    if (dayDate) {
      if (key.leftArrow) { void switchDay(shiftDay(dayDate, -1)); return }
      if (key.rightArrow || key.tab) { void switchDay(shiftDay(dayDate, 1)); return }
      if (key.escape || input === 'b') {
        setDayDate(null)
        setProjects([])
        setLoading(true)
        void reloadData(period, activeProvider, null)
        return
      }
    }
    const idx = PERIODS.indexOf(period)
    if (key.leftArrow) switchPeriod(PERIODS[(idx - 1 + PERIODS.length) % PERIODS.length]!)
    else if (key.rightArrow || key.tab) switchPeriod(PERIODS[(idx + 1) % PERIODS.length]!)
    else if (input === '1') switchPeriodImmediate('today')
    else if (input === '2') switchPeriodImmediate('week')
    else if (input === '3') switchPeriodImmediate('30days')
    else if (input === '4') switchPeriodImmediate('month')
    else if (input === '5') switchPeriodImmediate('all')
    else if (input === '6') switchPeriodImmediate('lifetime')
  })

  const headerLabel = dayDate ? formatDayRangeLabel(dayDate) : customRangeLabel ?? PERIOD_LABELS[period]

  if (loading || optimizeLoading) {
    return (
      <Box flexDirection="column" width={dashWidth}>
        {!isCustomRange && !isDayMode && <PeriodTabs active={period} providerName={activeProvider} showProvider={view !== 'compare' && multipleProviders} />}
        {isDayMode && <DayBanner label={headerLabel} width={dashWidth} />}
        {isCustomRange && <CustomRangeBanner label={headerLabel} width={dashWidth} />}
        {view === 'compare'
          ? <Box flexDirection="column" paddingX={2} paddingY={1}>
              <Box flexDirection="column" borderStyle="round" borderColor={ORANGE} paddingX={1}>
                <Text bold color={ORANGE}>Model Comparison</Text>
                <Text> </Text>
                <Text dimColor>Loading {headerLabel} model data...</Text>
              </Box>
            </Box>
          : view === 'optimize'
            ? <Panel title="CodeBurn Optimize" color={ORANGE} width={dashWidth}><Text dimColor>Scanning {headerLabel}...</Text></Panel>
            : <Panel title="CodeBurn" color={ORANGE} width={dashWidth}><Text dimColor>Loading {headerLabel}...</Text></Panel>}
        {view !== 'compare' && <StatusBar width={dashWidth} showProvider={multipleProviders} view={view} findingCount={0} optimizeAvailable={false} compareAvailable={false} customRange={isCustomRange} dayMode={isDayMode} />}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" width={dashWidth}>
      {!isCustomRange && !isDayMode && <PeriodTabs active={period} providerName={activeProvider} showProvider={multipleProviders && view !== 'compare'} />}
      {isDayMode && <DayBanner label={headerLabel} width={dashWidth} />}
      {isCustomRange && <CustomRangeBanner label={headerLabel} width={dashWidth} />}
      {view === 'compare'
        ? <CompareView projects={projects} onBack={() => setView('dashboard')} />
        : view === 'optimize' && optimizeResult
          ? <OptimizeView findings={optimizeResult.findings} costRate={optimizeResult.costRate} projects={projects} label={headerLabel} width={dashWidth} healthScore={optimizeResult.healthScore} healthGrade={optimizeResult.healthGrade} cursor={findingsCursor} />
          : <DashboardContent projects={projects} period={period} columns={columns} maxContentWidth={maxContentWidth} activeProvider={activeProvider} budgets={projectBudgets} planUsages={planUsages} label={headerLabel} dayMode={isDayMode} dailyHistoryProjects={dailyHistoryProjects} scrollableDailyHistory={scrollableDailyHistory} dailyHistoryCursor={Math.min(dailyHistoryCursor, dailyHistoryMaxCursor)} durable={durable} />}
      {view !== 'compare' && <StatusBar width={dashWidth} showProvider={multipleProviders} view={view} findingCount={findingCount} optimizeAvailable={optimizeAvailable} compareAvailable={compareAvailable} customRange={isCustomRange} dayMode={isDayMode} />}
    </Box>
  )
}

function DayBanner({ label, width }: { label: string; width: number }) {
  return (
    <Box width={width} paddingX={1} marginBottom={1}>
      <Text color={ORANGE} bold>{label}</Text>
    </Box>
  )
}

function CustomRangeBanner({ label, width }: { label: string; width: number }) {
  return (
    <Box width={width} paddingX={1} marginBottom={1}>
      <Text dimColor>Custom range: </Text>
      <Text color={ORANGE} bold>{label}</Text>
    </Box>
  )
}

function StaticDashboard({ projects, period, activeProvider, planUsages, label, dayMode, durable }: { projects: ProjectSummary[]; period: Period; activeProvider?: string; planUsages?: PlanUsage[]; label?: string; dayMode?: boolean; durable?: DurableOverview }) {
  const { columns } = useWindowSize()
  const maxContentWidth = getDashboardMaxWidth(projects, undefined, activeProvider)
  const { dashWidth } = getLayout(columns, maxContentWidth)
  return (
    <Box flexDirection="column" width={dashWidth}>
      {dayMode ? <DayBanner label={label ?? PERIOD_LABELS[period]} width={dashWidth} /> : <PeriodTabs active={period} />}
      <DashboardContent projects={projects} period={period} columns={columns} maxContentWidth={maxContentWidth} activeProvider={activeProvider} planUsages={planUsages} label={label} dayMode={dayMode} durable={durable} />
    </Box>
  )
}

export async function renderDashboard(period: Period = 'week', provider: string = 'all', refreshSeconds?: number, projectFilter?: string[], excludeFilter?: string[], customRange?: DateRange | null, customRangeLabel?: string, initialDay?: string): Promise<void> {
  // Interactive Ink UI: it renders to the same terminal and has its own in-frame
  // loading state, so the CLI scan-progress line must stay silent for its whole
  // lifetime (initial scan and every 30s auto-refresh, including the
  // getPlanUsages → parseAllSessions path). Plain CLI commands are unaffected.
  setInteractiveScanUI()
  await loadPricing()
  const dayRange = initialDay ? getDayRange(initialDay) : null
  const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  const scrollableDailyHistory = isTTY && dayRange == null && customRange == null
  const range = getDashboardScanRange(period, customRange, initialDay ?? null, scrollableDailyHistory)
  const scannedProjects = filterProjectsByName(await parseAllSessions(range, provider), projectFilter, excludeFilter)
  const filteredProjects = selectDashboardPeriodProjects(scannedProjects, period, scrollableDailyHistory)
  const planUsages = await getPlanUsages()
  // Durable headline totals for the initial paint (carry-forward cache + today),
  // matching the menubar/report. The interactive tree recomputes this on every
  // period/provider/refresh change; the static one-shot render uses just this.
  const initialDurable = await computeDurableOverview(period, provider, projectFilter, excludeFilter, customRange, initialDay ?? null)
  const label = initialDay ? formatDayRangeLabel(initialDay) : customRangeLabel
  patchStdoutForWindows()
  if (isTTY) {
    let windowColumns = process.stdout.columns
    const layoutMetricsRef = { current: { dashWidth: 0, maxContentWidth: MAX_DASHBOARD_WIDTH } }
    const dashboard = () => (
      <InteractiveDashboard initialProjects={filteredProjects} initialDailyHistoryProjects={scrollableDailyHistory ? scannedProjects : undefined} initialPeriod={period} initialProvider={provider} initialPlanUsages={planUsages} initialDurable={initialDurable} refreshSeconds={refreshSeconds} projectFilter={projectFilter} excludeFilter={excludeFilter} customRange={customRange} customRangeLabel={customRangeLabel} initialDay={initialDay} windowColumns={windowColumns} layoutMetricsRef={layoutMetricsRef} />
    )
    const app = render(
      dashboard(),
      INTERACTIVE_RENDER_OPTIONS,
    )
    const resize = () => {
      const nextColumns = process.stdout.columns
      if (shouldResetScreenOnResize(layoutMetricsRef.current.dashWidth, nextColumns, layoutMetricsRef.current.maxContentWidth)) {
        process.stdout.write('\u001B[?2026h\u001B[2J\u001B[H')
      }
      windowColumns = nextColumns
      app.rerender(dashboard())
    }
    process.stdout.prependListener('resize', resize)
    try {
      await app.waitUntilExit()
    } finally {
      process.stdout.off('resize', resize)
    }
  } else {
    const { unmount } = render(<StaticDashboard projects={filteredProjects} period={period} activeProvider={provider} planUsages={planUsages} label={label} dayMode={initialDay != null} durable={initialDurable} />, { patchConsole: false })
    // Non-interactive one-shot output: ink schedules the frame through a
    // throttled render, so yield a tick to let it flush to stdout before
    // unmounting. Unmounting synchronously can race the flush and drop output.
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    unmount()
  }
}

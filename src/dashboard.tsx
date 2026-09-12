import { homedir } from 'os'
import { EventEmitter } from 'node:events'

import React, { Fragment, useState, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { render, Box, Text, measureElement, useInput, useApp, useWindowSize, type DOMElement, type Instance, type RenderOptions } from 'ink'
import { CATEGORY_LABELS, type DateRange, type ProjectSummary, type TaskCategory } from './types.js'
import { formatCost, formatTokens, markEstimated, carriedCostNote } from './format.js'
import { formatSessionCount } from './session-count-label.js'
import { aggregateModelEfficiency } from './model-efficiency.js'
import { parseAllSessions, filterProjectsByDateRange, filterProjectsByName, setInteractiveScanUI, withSinglePassParse, withColdFirstPaintFloor, filesParsedFromSourceCount, isCompleteSessionSnapshotAvailable } from './parser.js'
import { findUnpricedModels, isExpectedFreeModel, loadPricing } from './models.js'
import { aggregateModelTotals } from './model-breakdown.js'
import { buildDurableOverviewFromNormalizedIndex, buildDurablePeriod, hydrateDailyCacheFromNormalizedProjects } from './usage-aggregator.js'
import { loadDailyCache, type DailyCache } from './daily-cache.js'
import { exitAfterCacheCleanup } from './session-cache.js'
import { getAllProviders } from './providers/index.js'
import { classHeaderLine, classTotals, findingBasis, findingClass, scanAndDetect, type FindingClass, type WasteFinding, type WasteAction, type OptimizeResult } from './optimize.js'
import { appliedFixGlyph, formatAppliedFix, type AppliedFix } from './act/types.js'
import { aggregateFileChurn, buildCoachingNotes, computePricingCoverage, medianTimeToFirstEditMs, scanUserCorrections, worstOneShotCategory, type ReworkedFile } from './workflow-insights.js'
import { estimateContextBudget, type ContextBudget } from './context-budget.js'
import { dateKey } from './day-aggregator.js'
import { behavioralCallCount } from './behavioral-weight.js'
import { CompareView } from './compare.js'
import { getPlanUsages, type PlanUsage } from './plan-usage.js'
import { planDisplayName } from './plans.js'
import { formatDayRangeLabel, getDateRange, parseDayFlag, PERIODS, PERIOD_LABELS, shiftDay, type Period } from './cli-date.js'
import { BSU, patchStdoutForWindows } from './ink-win.js'
import { startUserTimingGuard } from './user-timing-guard.js'

type View = 'dashboard' | 'optimize' | 'compare'

export type DailyActivityRow = {
  day: string
  cost: number
  calls: number
}

type DashboardIndexPhase = Period | 'cached' | 'refreshing'

export const DAILY_ACTIVITY_PAGE_SIZE = 10
export const INDEX_PROGRESS_TICK_MS = 1000
export const BACKGROUND_INDEX_INPUT_GRACE_MS = 2000
export const LARGE_HISTORY_FILE_THRESHOLD = 1000
export const INTERACTIVE_RENDER_OPTIONS = { alternateScreen: true, interactive: true } as const
export const RESIZE_DEBOUNCE_MS = 150
const CLEAR_ALTERNATE_SCREEN = '\u001B[2J\u001B[H'

export type TerminalSize = { columns: number; rows: number }
type AlternateScreenClearHandle = {
  cancel(): void
}
export type DebouncedResizeStream = NodeJS.WriteStream & {
  dispose(): void
  onSettledResize(listener: (size: TerminalSize) => void): () => void
  armAlternateScreenClear(): AlternateScreenClearHandle
}

function normalizeTerminalDimension(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback
}

function terminalSizeOf(source: NodeJS.WriteStream): TerminalSize {
  return {
    columns: normalizeTerminalDimension(source.columns, 80),
    rows: normalizeTerminalDimension(source.rows, 24),
  }
}

const RESIZE_LISTENER_METHODS = new Set<PropertyKey>([
  'addListener', 'on', 'once', 'prependListener', 'prependOnceListener', 'off', 'removeListener',
])

export function createDebouncedResizeStream(source: NodeJS.WriteStream, delayMs: number): DebouncedResizeStream {
  let resizeTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let { columns, rows } = terminalSizeOf(source)
  let alternateScreenClear: { token: symbol } | undefined
  const resizeEvents = new EventEmitter()
  const settledResizeListeners = new Set<(size: TerminalSize) => void>()

  const resize = () => {
    if (disposed) return
    if (resizeTimer) clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => {
      resizeTimer = undefined
      if (disposed) return
      const next = terminalSizeOf(source)
      const changed = next.columns !== columns || next.rows !== rows
      columns = next.columns
      rows = next.rows
      if (!changed) return
      // Rerender first so the settled view owns the first paint at the new
      // size; then notify Ink/useWindowSize. Writes are never suppressed, so
      // a mid-burst state update still reaches the terminal even when net
      // size is unchanged.
      for (const listener of [...settledResizeListeners]) listener(next)
      resizeEvents.emit('resize')
    }, delayMs)
  }
  source.on('resize', resize)

  const dispose = () => {
    if (disposed) return
    disposed = true
    source.off('resize', resize)
    if (resizeTimer) clearTimeout(resizeTimer)
    resizeTimer = undefined
    resizeEvents.removeAllListeners()
    settledResizeListeners.clear()
    alternateScreenClear = undefined
  }

  const stream = new Proxy(source as DebouncedResizeStream, {
    get(target, property) {
      if (property === 'dispose') return dispose
      if (property === 'onSettledResize') {
        return (listener: (size: TerminalSize) => void) => {
          if (disposed) return () => {}
          settledResizeListeners.add(listener)
          return () => settledResizeListeners.delete(listener)
        }
      }
      if (property === 'armAlternateScreenClear') {
        return () => {
          const token = Symbol('alternate-screen-clear')
          alternateScreenClear = { token }
          const cancel = () => {
            if (alternateScreenClear?.token === token) alternateScreenClear = undefined
          }
          return { cancel }
        }
      }
      if (property === 'columns') return columns
      if (property === 'rows') return rows
      if (property === 'write') {
        return (chunk: unknown, ...args: unknown[]) => {
          const write = Reflect.get(target, property, target) as (...values: unknown[]) => boolean
          if (typeof chunk === 'string' && chunk.startsWith(BSU) && alternateScreenClear) {
            // Ink owns the complete synchronized-output lifecycle. Decorating
            // every synchronized write until the resize flush settles means an
            // incidental Ink/console frame cannot steal the reset from the
            // resized frame. Unsynchronized writes pass through unchanged.
            const decorated = `${BSU}${CLEAR_ALTERNATE_SCREEN}${chunk.slice(BSU.length)}`
            return Reflect.apply(write, target, [decorated, ...args])
          }
          return Reflect.apply(write, target, [chunk, ...args])
        }
      }
      if (RESIZE_LISTENER_METHODS.has(property)) {
        return (event: string | symbol, ...args: unknown[]) => {
          if (event === 'resize') {
            if (!disposed) {
              Reflect.apply(Reflect.get(resizeEvents, property) as (...args: unknown[]) => unknown, resizeEvents, [event, ...args])
            }
            return stream
          }
          Reflect.apply(Reflect.get(target, property, target) as (...args: unknown[]) => unknown, target, [event, ...args])
          return stream
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return stream
}

function DisposeOnUnmount({ dispose, children }: { dispose: () => void; children: React.ReactNode }) {
  useLayoutEffect(() => dispose, [dispose])
  return children
}

export type DebouncedInteractiveInstance = Instance & {
  dispose(): void
  stdout: DebouncedResizeStream
}

export function renderDebouncedInteractive(
  source: NodeJS.WriteStream,
  view: (size: TerminalSize) => React.ReactElement,
  options: Omit<RenderOptions, 'stdout'> = INTERACTIVE_RENDER_OPTIONS,
): DebouncedInteractiveInstance {
  const stdout = createDebouncedResizeStream(source, RESIZE_DEBOUNCE_MS)
  const isScreenReaderEnabled = options.isScreenReaderEnabled
    ?? process.env['INK_SCREEN_READER'] === 'true'
  const clearsAlternateScreenOnResize = options.alternateScreen === true
    && options.interactive !== false
    && !isScreenReaderEnabled
  let size = { columns: stdout.columns, rows: stdout.rows }
  let unsubscribe = () => {}
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    unsubscribe()
    stdout.dispose()
  }
  const dashboard = () => <DisposeOnUnmount dispose={dispose}>{view(size)}</DisposeOnUnmount>
  let app: Instance
  try {
    app = render(dashboard(), { ...options, stdout })
  } catch (error) {
    dispose()
    throw error
  }
  unsubscribe = stdout.onSettledResize(nextSize => {
    if (disposed) return
    // A narrow/short frame can scroll or reflow inside the alternate buffer.
    // Once the terminal grows again, Ink's line-count erase no longer knows
    // where every physical row from that old frame ended up. Reset the visible
    // alternate screen during the settled repaint, then let the new frame
    // paint from a known top-left origin. Screen-reader output intentionally
    // skips this path because Ink can emit synchronized markers without frame
    // bytes for an unchanged view; clearing that block would blank the screen.
    // This keeps #977's single settled rerender while preventing persistent
    // ghost panels after ordinary alternate-screen reflow.
    const redraw = clearsAlternateScreenOnResize
      ? stdout.armAlternateScreenClear()
      : undefined
    size = nextSize
    app.rerender(dashboard())
    if (redraw) {
      // If the output is byte-identical (for example, resizing farther beyond
      // the dashboard's max width), Ink opens no synchronized repaint and the
      // clear is cancelled without ever blanking the screen. Ink also owns the
      // matching ESU for every decorated synchronized write.
      void app.waitUntilRenderFlush().finally(() => {
        redraw.cancel()
      })
    }
  })
  return Object.assign(app, { dispose, stdout })
}

export function getDailyActivityPageSize(columnCount: 1 | 2 | 3, projectRows: number, activityRows: number, dayMode = false): number {
  if (dayMode) return 1
  if (columnCount === 1) return DAILY_ACTIVITY_PAGE_SIZE
  return Math.max(DAILY_ACTIVITY_PAGE_SIZE, projectRows, columnCount === 3 ? activityRows : 0)
}

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
  workflow: '#B39DFF',
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
  sessionCountBasis?: 'identity' | 'partial'
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

function getDurableRange(period: Period, customRange: DateRange | null | undefined, day: string | null): DateRange {
  return day ? getDayRange(day) : customRange ?? getPeriodRange(period)
}

async function computeDurableOverview(
  period: Period,
  provider: string,
  projectFilter: string[] | undefined,
  excludeFilter: string[] | undefined,
  customRange: DateRange | null | undefined,
  day: string | null,
): Promise<DurableOverview> {
  const range = getDurableRange(period, customRange, day)
  const { data, carriedCostUSD } = await buildDurablePeriod(
    { range, label: PERIOD_LABELS[period] },
    { provider, project: projectFilter ?? [], exclude: excludeFilter ?? [] },
  )
  return {
    cost: data.cost,
    savingsUSD: data.savingsUSD,
    calls: data.calls,
    sessions: data.sessions,
    sessionCountBasis: data.sessionCountBasis,
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

function getMetricWidths(headers: string[], rows: string[][]): number[] {
  return headers.map((header, index) => Math.max(header.length, ...rows.map(row => row[index]?.length ?? 0)))
}

function getMetricGroupWidth(metricWidths: number[]): number {
  return metricWidths.reduce((sum, width) => sum + width, 0) + Math.max(0, metricWidths.length - 1)
}

function getDataRowLayout(panelWidth: number, requestedBarWidth: number, metricWidths: number[]) {
  const innerWidth = panelWidth - PANEL_CHROME
  const metricsWidth = getMetricGroupWidth(metricWidths)
  const barWidth = Math.max(1, Math.min(requestedBarWidth, innerWidth - metricsWidth - 3))
  const labelWidth = Math.max(1, innerWidth - barWidth - metricsWidth - 2)
  return { innerWidth, barWidth, labelWidth }
}

function DataRow({ panelWidth, barWidth: requestedBarWidth, label, metrics, metricWidths, bar, labelColor, dimColor }: {
  panelWidth: number
  barWidth: number
  label: string
  metrics: MetricCell[]
  metricWidths: number[]
  bar?: { value: number; max: number }
  labelColor?: string
  dimColor?: boolean
}) {
  const { innerWidth, barWidth, labelWidth } = getDataRowLayout(panelWidth, requestedBarWidth, metricWidths)
  const labelNode = <Text color={labelColor} dimColor={dimColor} wrap="truncate-end">{fit(label, labelWidth)}</Text>
  const barNode = bar ? <HBar value={bar.value} max={bar.max} width={barWidth} /> : <Text>{' '.repeat(barWidth)}</Text>
  return (
    <Box width={innerWidth}>
      {barNode}<Text> </Text>{labelNode}
      <Text> </Text>
      <Box>
        {metrics.map((metric, index) => (
          <React.Fragment key={index}>
            {index > 0 && <Text> </Text>}
            <Box width={metricWidths[index]} justifyContent="flex-end" flexShrink={0}>
              <Text color={metric.color} dimColor={metric.dimColor} wrap="truncate-end">{metric.text}</Text>
            </Box>
          </React.Fragment>
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

// Headline and status share one line's worth of terminal each, both truncated
// end-first, so the headline stays short enough to keep the percentage visible
// at 80 columns and the status leads with the disclaimer, not the arithmetic.
export function planBudgetHeadline(planUsage: PlanUsage): string {
  if (planUsage.plan.provider === 'copilot') {
    const spent = planUsage.spentCredits ?? 0
    const budget = planUsage.budgetCredits ?? planUsage.plan.monthlyCredits ?? 0
    const unrated = planUsage.creditUnratedCalls ?? 0
    if (unrated > 0) {
      const rated = planUsage.creditRatedCalls ?? 0
      const estimated = planUsage.estimatedCredits ?? spent
      // Whole credits only: the bulk of this number is priced from tokens,
      // so decimals would claim accuracy it lacks.
      const shown = formatCredits(Math.round(estimated))
      return `${planLabel(planUsage)}: ~${shown} / ${formatCredits(budget)} AI Credits (estimated; ${rated} of ${rated + unrated} requests carry GitHub's exact figure)`
    }
    return `${planLabel(planUsage)}: ${formatCredits(spent)} / ${formatCredits(budget)} AI Credits`
  }
  return `${planLabel(planUsage)}: ${formatCost(planUsage.spentApiEquivalentUsd)} API-equivalent / ${formatCost(planUsage.budgetUsd)} budget`
}

function formatCredits(n: number): string {
  if (Number.isInteger(n)) return String(n)
  const rounded = Math.round(n * 1e6) / 1e6
  return String(rounded)
}

export function planStatusText(planUsage: PlanUsage): string {
  // The period is anniversary-based (plan.resetDay, 1-28, settable per plan via
  // `codeburn plan set --reset-day`), so this is a monthly budget window, not a
  // calendar month. The headline already says "budget"; do not repeat it here.
  const detail = `Not a live provider window. Projected: ${formatCost(planUsage.projectedMonthUsd)}. Next budget reset in ${planUsage.daysUntilReset} days.`
  if (planUsage.status === 'under') {
    return `Well within budget. ${detail}`
  }
  if (planUsage.status === 'near') {
    return `Approaching budget. ${detail}`
  }
  return `${(planUsage.spentApiEquivalentUsd / Math.max(planUsage.budgetUsd, 1)).toFixed(1)}x the sticker price. ${detail}`
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
        <Text bold>{durable ? formatSessionCount(totalSessions, durable.sessionCountBasis) : `${totalSessions.toLocaleString()} sessions`}</Text>
        <Text dimColor>   </Text>
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
                  <Text color={color}>{planBudgetHeadline(planUsage)}</Text>
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
        dailyCalls[day] = (dailyCalls[day] ?? 0) + behavioralCallCount(turn.assistantCalls)
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
  const headers = ['cost', 'calls']
  const values = rows.map(row => [formatCost(row.cost), String(row.calls)])
  const metricWidths = getMetricWidths(headers, values)

  return (
    <Panel title="Daily Activity" color={PANEL_COLORS.daily} width={pw}>
      {loading
        ? <Text dimColor>Loading daily history...</Text>
        : <>
            <DataRow panelWidth={pw} barWidth={bw} label="" dimColor metrics={headers.map(text => ({ text, dimColor: true }))} metricWidths={metricWidths} />
            {rows.map((row, index) => (
              <DataRow
                key={row.day}
                panelWidth={pw}
                barWidth={bw}
                label={scrollable ? row.day : row.day.slice(5)}
                labelColor={DIM}
                bar={{ value: row.cost, max: maxCost }}
                metrics={[{ text: values[index]![0]!, color: GOLD }, { text: values[index]![1]! }]}
                metricWidths={metricWidths}
              />
            ))}
            {scrollable && orderedRows.length > 0 && (
              <Text dimColor wrap="truncate-end">{dailyActivityFooter(cursor, days, orderedRows.length)}</Text>
            )}
          </>}
    </Panel>
  )
}

// homedir() returns backslashes and an arbitrarily cased drive letter on Windows
// while project paths arrive in either separator, so the home prefix is compared
// against a normalized, case-folded copy there.
const _home = homedir().replace(/\\/g, '/')
const _homePrefix = _home.endsWith('/') ? _home : _home + '/'
const _foldPath = (value: string): string => (process.platform === 'win32' ? value.toLowerCase() : value)
const _homeFolded = _foldPath(_home)
const _homePrefixFolded = _foldPath(_homePrefix)

function ellipsizeEnd(value: string, width: number): string {
  if (value.length <= width) return value
  if (width <= 0) return ''
  if (width === 1) return '…'
  return `${value.slice(0, width - 1)}…`
}

export function shortProject(absPath: string, width = Infinity): string {
  const normalized = absPath.replace(/\\/g, '/')
  const folded = _foldPath(normalized)
  let path: string
  if (folded === _homeFolded) path = ''
  else if (folded.startsWith(_homePrefixFolded)) path = normalized.slice(_homePrefix.length)
  else path = normalized
  path = path.replace(/^\/+/, '')
  path = path.replace(/^private\/tmp\/[^/]+\/[^/]+\//, '').replace(/^private\/tmp\//, '').replace(/^tmp\//, '')
  if (!path) return 'home'
  const parts = path.split('/').filter(Boolean)
  const visible = parts.length <= 3 ? parts : parts.slice(-3)
  const full = visible.join('/')
  if (full.length <= width) return full

  const title = visible.at(-1)!
  const date = visible.slice(0, -1).find(part => /^\d{4}-\d{2}-\d{2}$/.test(part))
  const folderElided = date ? `…/${date}/${title}` : `…/${title}`
  if (folderElided.length <= width) return folderElided

  const dateElided = date ? `…/…${date.slice(4)}/${title}` : folderElided
  if (dateElided.length <= width) return dateElided

  const prefix = date ? `…/…${date.slice(4)}/` : '…/'
  if (width > prefix.length) return prefix + ellipsizeEnd(title, width - prefix.length)

  const compactPrefix = '…/…/'
  if (width > compactPrefix.length) return compactPrefix + ellipsizeEnd(title, width - compactPrefix.length)
  return ellipsizeEnd(title, width)
}

export function getDashboardMaxWidth(projects: ProjectSummary[], budgets?: Map<string, ContextBudget>, activeProvider?: string): number {
  const sessions = projects.flatMap(project => project.sessions)
  const longest = (values: string[]) => Math.max(1, ...values.map(value => value.length))
  const rowWidth = (labels: string[], metricCount: number, metricWidth = 7) =>
    PANEL_CHROME + 10 + 1 + longest(labels) + metricCount * metricWidth
  const modelTotals = aggregateModelTotals(projects)
  const modelMetricWidth = Math.max(7, ...Object.values(modelTotals).map(model =>
    markEstimated(formatCost(model.costUSD), model.estimatedCostUSD > 0).length
  ))
  const categoryLabels = sessions.flatMap(session => Object.keys(session.categoryBreakdown).map(category => CATEGORY_LABELS[category as TaskCategory] ?? category))
  const skillLabels = sessions.flatMap(session => Object.keys(session.skillBreakdown))
  const agentLabels = sessions.flatMap(session => Object.keys(session.subagentBreakdown))
  const widestPanel = Math.max(
    rowWidth(['2026-00-00'], 2),
    rowWidth(projects.map(project => shortProject(project.projectPath)), budgets?.size ? 4 : 3, budgets?.size ? 9 : 7),
    rowWidth(Object.keys(modelTotals), 5, modelMetricWidth),
    rowWidth([...categoryLabels, ...skillLabels.map(skill => `  /${skill}`)], 3),
    rowWidth(sessions.flatMap(session => Object.keys(session.mcpBreakdown)), 1),
    rowWidth(sessions.flatMap(session => Object.keys(session.toolBreakdown).filter(tool => activeProvider === 'cursor' ? tool.startsWith('lang:') : !tool.startsWith('lang:'))), 1),
    rowWidth(sessions.flatMap(session => Object.keys(session.bashBreakdown)), 1),
    rowWidth([...skillLabels, ...agentLabels], 2),
  )
  return Math.min(MAX_DASHBOARD_WIDTH, Math.max(135, widestPanel * 3))
}

function getProjectBreakdownRowLimit(period: Period, dayMode = false): number {
  return dayMode ? 8 : period === 'all' || period === 'lifetime' || period === 'month' || period === '30days' ? 14 : 8
}

function ProjectBreakdown({ projects, pw, bw, budgets, rows = 14 }: { projects: ProjectSummary[]; pw: number; bw: number; budgets?: Map<string, ContextBudget>; rows?: number }) {
  const maxCost = Math.max(...projects.map(p => p.totalCostUSD))
  const hasBudgets = budgets && budgets.size > 0
  const headers = ['cost', 'avg/s', 'session', ...(hasBudgets ? ['overhead'] : [])]
  const visibleProjects = projects.slice(0, rows)
  const values = visibleProjects.map(project => {
    const budget = budgets?.get(project.project)
    return [
      formatCost(project.totalCostUSD),
      project.sessions.length > 0 ? formatCost(project.totalCostUSD / project.sessions.length) : '-',
      String(project.sessions.length),
      ...(hasBudgets ? [budget ? formatTokens(budget.total) : '-'] : []),
    ]
  })
  const metricWidths = getMetricWidths(headers, values)
  const desiredLabelWidth = 8
  const projectBarWidth = Math.max(1, Math.min(bw, pw - PANEL_CHROME - getMetricGroupWidth(metricWidths) - 2 - desiredLabelWidth))
  const { labelWidth } = getDataRowLayout(pw, projectBarWidth, metricWidths)
  return (
    <Panel title="By Project" color={PANEL_COLORS.project} width={pw}>
      <DataRow panelWidth={pw} barWidth={projectBarWidth} label="" metrics={headers.map(text => ({ text, dimColor: true }))} metricWidths={metricWidths} />
      {visibleProjects.map((project, i) => {
        const row = values[i]!
        return (
          <DataRow
            key={`${project.project}-${i}`}
            panelWidth={pw}
            barWidth={projectBarWidth}
            label={shortProject(project.projectPath, labelWidth)}
            labelColor={DIM}
            bar={{ value: project.totalCostUSD, max: maxCost }}
            metrics={[
              { text: row[0]!, color: GOLD },
              { text: row[1]!, color: GOLD },
              { text: row[2]! },
              ...(hasBudgets ? [{ text: row[3]!, color: '#7B9EF5' }] : []),
            ]}
            metricWidths={metricWidths}
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
  const sorted = Object.entries(modelTotals).sort(([, a], [, b]) => b.costUSD - a.costUSD)
  const costLabels = sorted.map(([, data]) => markEstimated(formatCost(data.costUSD), data.estimatedCostUSD > 0))
  // #1088: this column has zero width slack left at the standard 3-column
  // breakpoint (verified: widening the header even one character clips
  // 'cache'/'1-shot' and drops the value column entirely), so the header stays
  // "Tok/s" -- the legend below carries the "Effective Tok/s" framing and the
  // caveat that it is not a vendor decode-speed figure.
  const headers = ['cost', 'cache', 'calls', '1-shot', 'Tok/s']
  const values = sorted.map(([model, data], index) => {
    const totalInput = data.freshInput + data.cacheRead + data.cacheWrite
    const efficiency = modelEfficiency.get(model)
    return [
      costLabels[index]!,
      totalInput > 0 ? `${((data.cacheRead / totalInput) * 100).toFixed(1)}%` : '-',
      String(data.calls),
      efficiency && efficiency.editTurns >= MIN_EDIT_TURNS_FOR_RATE && efficiency.oneShotRate !== null
        ? `${efficiency.oneShotRate.toFixed(1)}%`
        : '-',
      data.activeDurationMs > 0 && data.activeGeneratedTokens > 0
        ? (data.activeGeneratedTokens / (data.activeDurationMs / 1000)).toFixed(1)
        : '-',
    ]
  })
  const metricWidths = getMetricWidths(headers, values)
  const desiredLabelWidth = 5
  const modelBarWidth = Math.max(1, Math.min(bw, pw - PANEL_CHROME - getMetricGroupWidth(metricWidths) - 2 - desiredLabelWidth))
  const maxCost = sorted[0]?.[1]?.costUSD ?? 0
  const unpriced = findUnpricedModels(Object.entries(modelTotals).map(([model, d]) => ({
    model,
    calls: d.calls,
    cost: d.costUSD,
    tokens: d.freshInput + d.cacheRead + d.cacheWrite,
  })))

  return (
    <Panel title="By Model" color={PANEL_COLORS.model} width={pw}>
      <DataRow panelWidth={pw} barWidth={modelBarWidth} label="" metrics={headers.map(text => ({ text, dimColor: true }))} metricWidths={metricWidths} />
      {sorted.map(([model, data], i) => {
        const row = values[i]!
        return (
          <DataRow
            key={`${model}-${i}`}
            panelWidth={pw}
            barWidth={modelBarWidth}
            label={model}
            bar={{ value: data.costUSD, max: maxCost }}
            metrics={[
              { text: row[0]!, color: GOLD },
              { text: row[1]! },
              { text: row[2]! },
              { text: row[3]! },
              { text: row[4]! },
            ]}
            metricWidths={metricWidths}
          />
        )
      })}
      {unpriced.length > 0 && (
        <Text color="yellow" wrap={pw <= 44 ? 'wrap' : 'truncate-end'}>
          {pw <= 44
            ? `! ${unpriced.length}: codeburn models --unpriced`
            : `! ${unpriced.length} unpriced: codeburn models --unpriced`}
        </Text>
      )}
      {anyEstimated && (
        <Text dimColor wrap="truncate-end">~ estimated cost (priced from estimated tokens)</Text>
      )}
      <Text dimColor wrap="truncate-end">~ Effective Tok/s: generated tokens ÷ time the agent spent waiting on the model, tool execution excluded. Includes prefill, request assembly and reasoning. Not comparable to vendor decode-speed figures.</Text>
    </Panel>
  )
}

const SKILL_SUB_ROWS_LIMIT = 5

function aggregateActivityBreakdown(projects: ProjectSummary[]) {
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
  return { sorted, sortedSkills }
}

function getActivityBreakdownRowCount(projects: ProjectSummary[]): number {
  const { sorted, sortedSkills } = aggregateActivityBreakdown(projects)
  return sorted.length + (sorted.some(([category]) => category === 'general') ? sortedSkills.length : 0)
}

function ActivityBreakdown({ projects, pw, bw }: { projects: ProjectSummary[]; pw: number; bw: number }) {
  const { sorted, sortedSkills } = aggregateActivityBreakdown(projects)
  const maxCost = sorted[0]?.[1]?.costUSD ?? 0
  const headers = ['cost', 'turns', '1-shot']
  const values = [
    ...sorted.map(([, data]) => [formatCost(data.costUSD), String(data.turns), data.editTurns > 0 ? `${Math.round((data.oneShotTurns / data.editTurns) * 100)}%` : '-']),
    ...sortedSkills.map(([, data]) => [formatCost(data.costUSD), String(data.turns), data.editTurns > 0 ? `${Math.round((data.oneShotTurns / data.editTurns) * 100)}%` : '-']),
  ]
  const metricWidths = getMetricWidths(headers, values)
  return (
    <Panel title="By Activity" color={PANEL_COLORS.activity} width={pw}>
      <DataRow panelWidth={pw} barWidth={bw} label="" metrics={headers.map(text => ({ text, dimColor: true }))} metricWidths={metricWidths} />
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
            metricWidths={metricWidths}
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
                metricWidths={metricWidths}
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
  const metricWidths = getMetricWidths(['calls'], sorted.map(([, calls]) => [String(calls)]))
  return (
    <Panel title={title ?? 'Core Tools'} color={PANEL_COLORS.tools} width={pw}>
      <DataRow panelWidth={pw} barWidth={bw} label="" metrics={[{ text: 'calls', dimColor: true }]} metricWidths={metricWidths} />
      {sorted.slice(0, 10).map(([tool, calls]) => {
        const raw = filterPrefix ? tool.slice(filterPrefix.length) : tool
        const display = filterPrefix ? (LANG_DISPLAY_NAMES[raw] ?? raw) : raw
        return (
          <DataRow key={tool} panelWidth={pw} barWidth={bw} label={display} bar={{ value: calls, max: maxCalls }} metrics={[{ text: String(calls) }]} metricWidths={metricWidths} />
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
  const metricWidths = getMetricWidths(['calls'], sorted.map(([, calls]) => [String(calls)]))
  return (
    <Panel title="MCP Servers" color={PANEL_COLORS.mcp} width={pw}>
      <DataRow panelWidth={pw} barWidth={bw} label="" metrics={[{ text: 'calls', dimColor: true }]} metricWidths={metricWidths} />
      {sorted.slice(0, 8).map(([server, calls]) => (
        <DataRow key={server} panelWidth={pw} barWidth={bw} label={server} bar={{ value: calls, max: maxCalls }} metrics={[{ text: String(calls) }]} metricWidths={metricWidths} />
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
  const metricWidths = getMetricWidths(['calls'], sorted.map(([, calls]) => [String(calls)]))
  return (
    <Panel title="Shell Commands" color={PANEL_COLORS.bash} width={pw}>
      <DataRow panelWidth={pw} barWidth={bw} label="" metrics={[{ text: 'calls', dimColor: true }]} metricWidths={metricWidths} />
      {sorted.slice(0, 10).map(([cmd, calls]) => (
        <DataRow key={cmd} panelWidth={pw} barWidth={bw} label={cmd} bar={{ value: calls, max: maxCalls }} metrics={[{ text: String(calls) }]} metricWidths={metricWidths} />
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
  const headers = ['uses', 'cost']
  const metricWidths = getMetricWidths(headers, sorted.map(([, data]) => [String(data.uses), formatCost(data.cost)]))
  return (
    <Panel title="Skills & Agents" color={PANEL_COLORS.skills} width={pw}>
      <DataRow panelWidth={pw} barWidth={bw} label="" metrics={headers.map(text => ({ text, dimColor: true }))} metricWidths={metricWidths} />
      {sorted.slice(0, 10).map(([name, d]) => (
        <DataRow key={name} panelWidth={pw} barWidth={bw} label={name} bar={{ value: d.cost, max: maxCost }} metrics={[{ text: String(d.uses) }, { text: formatCost(d.cost), color: GOLD }]} metricWidths={metricWidths} />
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
  const headers = ['calls', 'cost']
  const metricWidths = getMetricWidths(headers, sorted.map(([, data]) => [String(data.uses), formatCost(data.cost)]))
  return (
    <Panel title="Claude Agent Types" color={PANEL_COLORS.skills} width={pw}>
      <DataRow panelWidth={pw} barWidth={bw} label="" metrics={headers.map(text => ({ text, dimColor: true }))} metricWidths={metricWidths} />
      {sorted.slice(0, 10).map(([name, d]) => (
        <DataRow key={name} panelWidth={pw} barWidth={bw} label={name} bar={{ value: d.cost, max: maxCost }} metrics={[{ text: String(d.uses) }, { text: formatCost(d.cost), color: GOLD }]} metricWidths={metricWidths} />
      ))}
    </Panel>
  )
}

/// Workflow-intelligence figures for the compact Workflow panel. Derived from
/// the already-parsed projects the other panels render (no re-parse), mirroring
/// the same helpers `optimize` and the report use so the numbers agree.
export type WorkflowPanelData = {
  correctionRate: number | null
  corrections: number
  userTurns: number
  medianTimeToFirstEditMs: number | null
  topReworkedFile: ReworkedFile | null
  /// Share (0-1) of cost-bearing calls that resolved a price, or null when there
  /// is nothing to price. Null omits the Coverage row entirely (never renders a
  /// hollow 100%).
  coverage: number | null
}

/// Pricing coverage over the shown projects, replicating usage-aggregator's
/// cost-bearing/unpriced tally so the dashboard figure matches the report.
/// Returns null when there are no cost-bearing calls (nothing to price).
function workflowCoverage(projects: ProjectSummary[]): number | null {
  const totals: Record<string, { calls: number; cost: number; tokens: number }> = {}
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const [model, d] of Object.entries(session.modelBreakdown)) {
        const t = totals[model] ?? { calls: 0, cost: 0, tokens: 0 }
        t.calls += d.calls
        t.cost += d.costUSD
        t.tokens += d.tokens.inputTokens + d.tokens.cacheReadInputTokens + d.tokens.cacheCreationInputTokens
        totals[model] = t
      }
    }
  }
  const costBearing = Object.entries(totals).reduce((s, [model, d]) => s + (model === '<synthetic>' || isExpectedFreeModel(model) ? 0 : d.calls), 0)
  if (costBearing <= 0) return null
  const unpricedCalls = findUnpricedModels(Object.entries(totals).map(([model, d]) => ({ model, calls: d.calls, cost: d.cost, tokens: d.tokens }))).reduce((s, m) => s + m.calls, 0)
  return computePricingCoverage(costBearing, unpricedCalls)
}

export function computeWorkflowPanelData(projects: ProjectSummary[]): WorkflowPanelData {
  const corrections = scanUserCorrections(projects)
  const churn = aggregateFileChurn(projects)
  return {
    correctionRate: corrections.correctionRate,
    corrections: corrections.corrections,
    userTurns: corrections.userTurns,
    medianTimeToFirstEditMs: medianTimeToFirstEditMs(projects),
    topReworkedFile: churn[0] ?? null,
    coverage: workflowCoverage(projects),
  }
}

/// True when there is any workflow signal to show. Hidden otherwise: a brand-new
/// user with no user prompts and no file churn gets no empty panel.
export function hasWorkflowData(data: WorkflowPanelData): boolean {
  return data.userTurns > 0 || data.topReworkedFile != null
}

function formatCorrectionsValue(rate: number | null, count: number): string {
  if (rate == null) return '-'
  return `${Math.round(rate * 100)}% (${count})`
}

// median time to first edit: seconds under a minute, whole minutes above.
function formatFirstEditValue(ms: number | null): string {
  if (ms == null) return '-'
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  return `${Math.round(ms / 60_000)}m`
}

function reworkBasename(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || path
}

function formatReworkValue(file: ReworkedFile | null): string {
  if (!file) return '-'
  return `${reworkBasename(file.path)} ×${file.sessions}`
}

function formatCoverageValue(coverage: number): string {
  // Floor, never round: 99.6% coverage with unpriced calls outstanding must
  // not render as the "100%" the panel reserves for genuinely complete
  // pricing (observed live: 107 unpriced calls rendering as 100% while the
  // model panel warned about them on the same screen).
  return `${Math.floor(coverage * 100)}%`
}

export type WorkflowRow = { label: string; value: string }

/// The Workflow panel's four label/value rows. Coverage is dropped when null so
/// the panel never shows a placeholder 100%.
export function buildWorkflowRows(data: WorkflowPanelData): WorkflowRow[] {
  const rows: WorkflowRow[] = [
    { label: 'Corrections', value: formatCorrectionsValue(data.correctionRate, data.corrections) },
    { label: 'First edit', value: formatFirstEditValue(data.medianTimeToFirstEditMs) },
    { label: 'Rework', value: formatReworkValue(data.topReworkedFile) },
  ]
  if (data.coverage != null) rows.push({ label: 'Coverage', value: formatCoverageValue(data.coverage) })
  return rows
}

/// Coaching notes for the footer, over the same inputs as the report's workflow
/// section. Empty when no signal crosses a threshold.
export function computeCoachingNotes(projects: ProjectSummary[]): string[] {
  const corrections = scanUserCorrections(projects)
  const churn = aggregateFileChurn(projects)
  return buildCoachingNotes({
    worstOneShot: worstOneShotCategory(projects),
    corrections: corrections.corrections,
    correctionRate: corrections.correctionRate,
    topReworkedFile: churn[0] ?? null,
    medianTimeToFirstEditMs: medianTimeToFirstEditMs(projects),
  })
}

/// Picks the note to show for a rotation tick. Null when there are no notes.
export function selectRotatingNote(notes: string[], tick: number): string | null {
  if (notes.length === 0) return null
  return notes[((tick % notes.length) + notes.length) % notes.length] ?? null
}

const WORKFLOW_LABEL_WIDTH = 12

function WorkflowInsights({ projects, pw }: { projects: ProjectSummary[]; pw: number }) {
  const data = useMemo(() => computeWorkflowPanelData(projects), [projects])
  if (!hasWorkflowData(data)) return null
  const rows = buildWorkflowRows(data)
  return (
    <Panel title="Workflow" color={PANEL_COLORS.workflow} width={pw}>
      {rows.map(row => (
        <Text key={row.label} wrap="truncate-end">
          <Text dimColor>{row.label.padEnd(WORKFLOW_LABEL_WIDTH)}</Text>
          <Text>{row.value}</Text>
        </Text>
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
        case 'manual':
          return '── Manual action '.padEnd(64, '─')
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
      <Text color={GOLD}>Savings: ~{formatTokens(finding.tokensSaved)} tokens (~{formatCost(costSaved)})<Text dimColor>  {findingBasis(finding)}</Text></Text>
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

const APPLIED_FIX_COLORS: Record<AppliedFix['verdict'], string> = {
  worked: '#5BF5A0',
  partial: GOLD,
  'no-effect': '#F55B5B',
  pending: DIM,
}

function OptimizeView({ findings, costRate, projects, label, width, healthScore, healthGrade, cursor, appliedFixes = [] }: { findings: WasteFinding[]; costRate: number; projects: ProjectSummary[]; label: string; width: number; healthScore: number; healthGrade: string; cursor: number; appliedFixes?: AppliedFix[] }) {
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
  const totals = classTotals(findings, costRate)
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
      {visible.map((f, i) => {
        // Findings arrive class-sorted, so a header goes in wherever the class
        // changes (including the top of the window after paging).
        const cls = findingClass(f)
        const previous: FindingClass | null = i > 0 ? findingClass(visible[i - 1]!) : null
        return (
          <Fragment key={start + i}>
            {cls !== previous && <Box paddingX={1} width={width}><Text bold color={ORANGE} wrap="truncate-end">{classHeaderLine(cls, totals[cls], costRate)}</Text></Box>}
            <FindingPanel index={start + i + 1} finding={f} costRate={costRate} width={width} />
          </Fragment>
        )
      })}
      {appliedFixes.length > 0 && (
        <Box flexDirection="column" paddingX={1} width={width}>
          <Text bold color={ORANGE} wrap="truncate-end">Applied fixes</Text>
          {appliedFixes.map(fix => (
            <Text key={fix.id} color={APPLIED_FIX_COLORS[fix.verdict]} wrap="truncate-end">
              {appliedFixGlyph(fix)} {formatAppliedFix(fix)}
            </Text>
          ))}
        </Box>
      )}
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
            <Text color={PANEL_COLORS.daily} bold>Space</Text><Text dimColor> daily page</Text>
          </>
        )}
        {showProvider && (<><Text dimColor>   </Text><Text color={ORANGE} bold>p</Text><Text dimColor> provider</Text></>)}
        <Text dimColor>   </Text><Text color={ORANGE} bold>↑</Text><Text dimColor>/</Text><Text color={ORANGE} bold>↓</Text><Text dimColor> scroll   </Text>
        <Text color={ORANGE} bold>PgUp</Text><Text dimColor>/</Text><Text color={ORANGE} bold>PgDn</Text><Text dimColor> page</Text>
      </Text>
    </Box>
  )
}

function DashboardContent({ projects, period, columns, maxContentWidth, activeProvider, budgets, planUsages, label, dayMode, dailyHistoryProjects, dailyHistoryPageSize, scrollableDailyHistory = false, dailyHistoryCursor = 0, dailyHistoryLoading = false, durable }: { projects: ProjectSummary[]; period: Period; columns?: number; maxContentWidth: number; activeProvider?: string; budgets?: Map<string, ContextBudget>; planUsages?: PlanUsage[]; label?: string; dayMode?: boolean; dailyHistoryProjects?: ProjectSummary[]; dailyHistoryPageSize?: number; scrollableDailyHistory?: boolean; dailyHistoryCursor?: number; dailyHistoryLoading?: boolean; durable?: DurableOverview }) {
  const { dashWidth, columnCount, panelWidth, barWidth } = getLayout(columns, maxContentWidth)
  const isCursor = activeProvider === 'cursor'
  const activeLabel = label ?? PERIOD_LABELS[period]
  if (showEmptyState(projects.length, scrollableDailyHistory, (dailyHistoryProjects ?? []).length, dailyHistoryLoading)) return <Panel title="CodeBurn" color={ORANGE} width={dashWidth}><Text dimColor>No usage data found for {activeLabel}.</Text></Panel>
  const projectRows = Math.min(projects.length, getProjectBreakdownRowLimit(period, dayMode))
  const days = dailyHistoryPageSize ?? getDailyActivityPageSize(columnCount, projectRows, getActivityBreakdownRowCount(projects), dayMode)
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
        <ProjectBreakdown projects={projects} pw={panelWidth} bw={barWidth} budgets={budgets} rows={getProjectBreakdownRowLimit(period, dayMode)} />
        <ActivityBreakdown projects={projects} pw={panelWidth} bw={barWidth} />
        <ModelBreakdown projects={projects} pw={panelWidth} bw={barWidth} />
        {isCursor
          ? <><ToolBreakdown projects={projects} pw={panelWidth} bw={barWidth} title="Languages" filterPrefix="lang:" /><WorkflowInsights projects={projects} pw={panelWidth} /></>
          : <>
              <McpBreakdown projects={projects} pw={panelWidth} bw={barWidth} />
              <ToolBreakdown projects={projects} pw={panelWidth} bw={barWidth} />
              <BashBreakdown projects={projects} pw={panelWidth} bw={barWidth} />
              <SkillsAndAgents projects={projects} pw={panelWidth} bw={barWidth} />
              <WorkflowInsights projects={projects} pw={panelWidth} />
              <ClaudeAgentTypes projects={projects} pw={panelWidth} bw={barWidth} />
            </>}
      </Box>
    </Box>
  )
}

/// Sum of wheel scroll deltas in a raw stdin chunk under SGR mouse reporting
/// (DECSET 1006): button 64 is wheel-up, 65 wheel-down, three lines per tick.
/// Every other mouse event (clicks, drags, wheel with modifiers) contributes
/// nothing. Exported for tests.
export function wheelDelta(chunk: string): number {
  let delta = 0
  for (const m of chunk.matchAll(/\x1b\[<(64|65);\d+;\d+[Mm]/g)) {
    delta += m[1] === '64' ? -WHEEL_LINES_PER_TICK : WHEEL_LINES_PER_TICK
  }
  return delta
}

const WHEEL_LINES_PER_TICK = 3
const MOUSE_TRACKING_ON = '\x1b[?1000h\x1b[?1006h'
const MOUSE_TRACKING_OFF = '\x1b[?1006l\x1b[?1000l'

function ScrollableViewport({ children, width, lineScroll = true }: { children: React.ReactNode; width: number; lineScroll?: boolean }) {
  const { rows } = useWindowSize()
  const height = Math.max(1, rows - 1)
  const contentRef = useRef<DOMElement>(null)
  const [maxOffset, setMaxOffset] = useState(0)
  const [offset, setOffset] = useState(0)
  // The stdin listener below outlives renders; it reads the current bound
  // through a ref so scrolling never re-subscribes (and never re-emits the
  // tracking enable sequence).
  const maxOffsetRef = useRef(0)
  maxOffsetRef.current = maxOffset

  useLayoutEffect(() => {
    if (!contentRef.current) return
    const nextMaxOffset = Math.max(0, measureElement(contentRef.current).height - height)
    setMaxOffset(current => current === nextMaxOffset ? current : nextMaxOffset)
    setOffset(current => Math.min(current, nextMaxOffset))
  })

  // Mouse-wheel scrolling via SGR mouse reporting. Known tradeoff: while
  // tracking is on, click-drag text selection needs Shift held in most
  // terminals. Tracking is disabled again on unmount (view switches, q).
  useEffect(() => {
    if (!process.stdout.isTTY || !process.stdin.isTTY) return
    process.stdout.write(MOUSE_TRACKING_ON)
    const onData = (data: Buffer) => {
      const delta = wheelDelta(data.toString('utf8'))
      if (delta !== 0) setOffset(current => Math.max(0, Math.min(current + delta, maxOffsetRef.current)))
    }
    process.stdin.on('data', onData)
    return () => {
      process.stdin.off('data', onData)
      process.stdout.write(MOUSE_TRACKING_OFF)
    }
  }, [])

  useInput((_input, key) => {
    if (lineScroll && key.downArrow) setOffset(current => Math.min(current + 1, maxOffset))
    else if (lineScroll && key.upArrow) setOffset(current => Math.max(current - 1, 0))
    else if (key.pageDown) setOffset(current => Math.min(current + height, maxOffset))
    else if (key.pageUp) setOffset(current => Math.max(current - height, 0))
    else if (key.home) setOffset(0)
    else if (key.end) setOffset(maxOffset)
  })

  return (
    <Box width={width} height={height} overflowY="hidden">
      <Box ref={contentRef} flexDirection="column" position="absolute" top={-Math.min(offset, maxOffset)} left={0}>
        {children}
      </Box>
    </Box>
  )
}

export function InteractiveDashboard({ initialProjects, initialDailyHistoryProjects, initialPeriod, initialProvider, initialPlanUsages, initialDurable, refreshSeconds, projectFilter, excludeFilter, customRange, customRangeLabel, initialDay, windowColumns, initialIndexPendingFiles, initialHistoryIndexing = false, initialCacheWasCold = false, initialHistoryIndex, autoFallbackFromEmptyToday = false, terminateProcess }: {
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
  /// Files the Today-first paint deferred. Non-zero means older periods still
  /// need the background index before they can be selected truthfully.
  initialIndexPendingFiles?: number
  initialHistoryIndexing?: boolean
  initialCacheWasCold?: boolean
  initialHistoryIndex?: DashboardHistoryIndex
  autoFallbackFromEmptyToday?: boolean
  /// CLI-only hard stop after Ink has been asked to restore the terminal.
  /// Component tests and embedders omit it and receive ordinary Ink exit.
  terminateProcess?: (exitCode: number) => void
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
  const [appliedFixes, setAppliedFixes] = useState<AppliedFix[]>([])
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
  // Which coaching note the footer shows; advanced on a slow interval so the
  // whole set rotates through without demanding attention.
  const [noteTick, setNoteTick] = useState(0)
  const indexPendingFiles = initialIndexPendingFiles ?? 0
  const [indexing, setIndexing] = useState(
    (initialHistoryIndexing || indexPendingFiles > 0)
    && (initialHistoryIndex == null || !dashboardIndexSupportsPeriod(initialHistoryIndex, 'lifetime')),
  )
  const [indexedFiles, setIndexedFiles] = useState(0)
  const [indexCold, setIndexCold] = useState(initialCacheWasCold)
  const [indexPhase, setIndexPhase] = useState<DashboardIndexPhase>(initialCacheWasCold ? 'week' : 'cached')
  const historyIndexRef = useRef<DashboardHistoryIndex | null>(initialHistoryIndex ?? null)
  const autoFallbackAppliedRef = useRef(false)
  const quitArmedRef = useRef(false)
  // #1143: first q during the cold-start fill arms a confirmation so the user
  // sees feedback instead of a silent ~16.5s drain. The second q (or any
  // Ctrl+C) takes the abrupt path; #1109 already made abrupt exit kill-safe.
  // Auto-clears the moment the fill lands so a stale flag can never trap a
  // later q.
  const [quitArmed, setQuitArmed] = useState(false)
  const isDayMode = dayDate != null
  const isCustomRange = customRange != null && !isDayMode
  const scrollableDailyHistory = !isCustomRange && !isDayMode
  const columns = windowColumns
  const maxContentWidth = useMemo(
    () => getDashboardMaxWidth(projects, projectBudgets, activeProvider),
    [projects, projectBudgets, activeProvider],
  )
  const { dashWidth, columnCount } = getLayout(columns, maxContentWidth)
  const dailyHistoryPageSize = getDailyActivityPageSize(
    columnCount,
    Math.min(projects.length, getProjectBreakdownRowLimit(period, isDayMode)),
    getActivityBreakdownRowCount(projects),
    isDayMode,
  )
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
  const periodRef = useRef(period)
  periodRef.current = period
  const providerRef = useRef(activeProvider)
  providerRef.current = activeProvider
  const dayRef = useRef(dayDate)
  dayRef.current = dayDate
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reloadGenerationRef = useRef(0)
  const reloadInFlightRef = useRef(false)
  const currentReloadRef = useRef<{ period: Period; provider: string; day: string | null } | null>(null)
  const pendingReloadRef = useRef<{ period: Period; provider: string; day: string | null; background: boolean } | null>(null)
  const findingCount = optimizeResult?.findings.length ?? 0
  const coachingNotes = useMemo(() => computeCoachingNotes(projects), [projects])

  useEffect(() => {
    if (coachingNotes.length <= 1) return
    const id = setInterval(() => setNoteTick(t => t + 1), 12000)
    return () => clearInterval(id)
  }, [coachingNotes.length])

  useEffect(() => {
    if (indexing) return
    let cancelled = false
    async function detect() {
      const found: string[] = []
      for (const p of await getAllProviders()) { const s = await p.discoverSessions(); if (s.length > 0) found.push(p.name) }
      if (!cancelled) setDetectedProviders(found)
    }
    detect()
    return () => { cancelled = true }
  }, [indexing])

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
      const result = await scanAndDetect(projects, currentRange(), activeProvider)
      if (reloadGenerationRef.current === generation) setOptimizeResult(result)
      // Best effort: a bad journal never keeps the findings off screen.
      try {
        const { computeActReport } = await import('./act/report.js')
        const applied = await computeActReport()
        if (reloadGenerationRef.current === generation) setAppliedFixes(applied.appliedFixes)
      } catch { /* the applied section is optional */ }
    } catch (error) {
      console.error(error)
    } finally {
      if (reloadGenerationRef.current === generation) setOptimizeLoading(false)
    }
  }, [optimizeAvailable, projects, currentRange, optimizeLoading, optimizeResult, activeProvider])

  // Warm launch: load the complete normalized snapshot once, make every tab
  // available, then reconcile sources exactly once and atomically replace it.
  // Cold launch: widen through the user-visible readiness order; cached files
  // from an earlier phase are never parsed from source again.
  useEffect(() => {
    if (!initialHistoryIndexing || initialHistoryIndex || isCustomRange || isDayMode) return
    let cancelled = false
    const provider = activeProvider
    const parsedBefore = filesParsedFromSourceCount()
    const progressId = setInterval(() => setIndexedFiles(filesParsedFromSourceCount() - parsedBefore), INDEX_PROGRESS_TICK_MS)

    const publish = async (index: DashboardHistoryIndex): Promise<void> => {
      if (cancelled || providerRef.current !== index.provider) return
      historyIndexRef.current = index
      setDailyHistoryProjects(filterProjectsByName(index.normalizedProjects, projectFilter, excludeFilter))
      let target = periodRef.current
      if (shouldAutoFallbackToWeek(
        autoFallbackFromEmptyToday,
        autoFallbackAppliedRef.current,
        target,
        index,
        initialProjects,
      )) {
        autoFallbackAppliedRef.current = true
        target = 'week'
        setPeriod('week')
      }
      if (dayRef.current == null && dashboardIndexSupportsPeriod(index, target)) {
        const selected = selectDashboardHistoryIndex(index, target)
        setProjects(selected.projects)
        setDurable(selected.durable)
        setLoading(false)
      }
      if (index.planUsages.length > 0) setPlanUsages(index.planUsages)
      await nextTick()
    }

    const run = async (): Promise<void> => {
      // Let Ink flush the truthful Today frame before any cache expansion or
      // provider discovery can compete for the event loop, and leave a short
      // window for immediate q/q input before synchronous provider discovery.
      await nextTick()
      await new Promise<void>(resolve => setTimeout(resolve, BACKGROUND_INDEX_INPUT_GRACE_MS))
      if (cancelled) return
      const snapshotAvailable = await isCompleteSessionSnapshotAvailable(getPeriodRange('today'), provider)
      if (cancelled) return
      setIndexCold(!snapshotAvailable)
      setIndexing(true)
      setIndexedFiles(0)

      if (snapshotAvailable) {
        setIndexPhase('cached')
        await publish(await buildDashboardHistoryIndex(provider, projectFilter, excludeFilter, {
          readyThrough: 'lifetime',
          preferCompleteSnapshot: true,
        }))
        if (cancelled) return
        setIndexPhase('refreshing')
        await publish(await buildDashboardHistoryIndex(provider, projectFilter, excludeFilter))
      } else {
        for (const readyThrough of DASHBOARD_COLD_INDEX_PHASES) {
          if (cancelled) return
          setIndexPhase(readyThrough)
          await publish(await buildDashboardHistoryIndex(provider, projectFilter, excludeFilter, {
            readyThrough,
            progressiveSource: true,
          }))
        }
      }
    }

    void run().catch(error => {
      if (!cancelled) console.error(error)
    }).finally(() => {
      clearInterval(progressId)
      if (!cancelled) setIndexing(false)
    })
    return () => {
      cancelled = true
      clearInterval(progressId)
    }
  }, [activeProvider, autoFallbackFromEmptyToday, customRange, excludeFilter, initialHistoryIndex, initialHistoryIndexing, initialProjects, isCustomRange, isDayMode, projectFilter])

  useEffect(() => {
    const refreshIntervalMs = getRefreshIntervalMs(refreshSeconds ?? 0)
    if (refreshIntervalMs === 0 || indexing) return
    if (view !== 'dashboard') return
    if (!dayDate && isHeavyPeriod(period)) return
    const id = setInterval(() => {
      const index = historyIndexRef.current
      if (!dayDate && index?.provider === activeProvider && dashboardIndexSupportsPeriod(index, 'lifetime')) {
        void buildDashboardHistoryIndex(activeProvider, projectFilter, excludeFilter).then(refreshed => {
          if (providerRef.current !== refreshed.provider || dayRef.current != null) return
          historyIndexRef.current = refreshed
          const selected = selectDashboardHistoryIndex(refreshed, periodRef.current)
          setDailyHistoryProjects(filterProjectsByName(refreshed.normalizedProjects, projectFilter, excludeFilter))
          setProjects(selected.projects)
          setDurable(selected.durable)
          setPlanUsages(refreshed.planUsages)
          setOptimizeResult(null)
        }).catch(console.error)
        return
      }
      void reloadData(period, activeProvider, dayDate, true)
    }, refreshIntervalMs)
    return () => clearInterval(id)
  }, [refreshSeconds, indexing, view, dayDate, period, activeProvider, projectFilter, excludeFilter, reloadData])

  useEffect(() => {
    if (!indexing && quitArmed) {
      quitArmedRef.current = false
      setQuitArmed(false)
    }
  }, [indexing, quitArmed])

  const selectIndexedPeriod = useCallback((np: Period): boolean => {
    const index = historyIndexRef.current
    if (!index || index.provider !== activeProvider || !dashboardIndexSupportsPeriod(index, np)) return false
    // Indexed selection publishes synchronously, so it must also supersede any
    // async day/period reload already in flight. Otherwise that older request
    // can pass its generation checks later and paint day-only data under this
    // newly selected period label.
    reloadGenerationRef.current++
    pendingReloadRef.current = null
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const selected = selectDashboardHistoryIndex(index, np)
    setPeriod(np)
    setDailyHistoryCursor(0)
    setDayDate(null)
    setProjects(selected.projects)
    setDurable(selected.durable)
    setLoading(false)
    return true
  }, [activeProvider])

  const switchPeriod = useCallback((np: Period) => {
    if (np === period && !dayDate) return
    if (selectIndexedPeriod(np)) return
    // Clear projects + flip loading synchronously so the dashboard never
    // renders the new period label over the old period's numbers between
    // setPeriod() and the reloadData() promise resolving. Without this,
    // there's a frame-to-hundreds-of-ms window where users saw wrong
    // figures captioned with the new period.
    setPeriod(np)
    setDailyHistoryCursor(0)
    setDayDate(null)
    setProjects([])
    setDurable(undefined)
    setLoading(true)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (indexing) return
    debounceRef.current = setTimeout(() => { reloadData(np, activeProvider, null) }, 600)
  }, [period, activeProvider, dayDate, reloadData, selectIndexedPeriod, indexing])

  const switchPeriodImmediate = useCallback(async (np: Period) => {
    if (np === period && !dayDate) return
    if (selectIndexedPeriod(np)) return
    setPeriod(np)
    setDailyHistoryCursor(0)
    setDayDate(null)
    setProjects([])
    setDurable(undefined)
    setLoading(true)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (indexing) return
    await reloadData(np, activeProvider, null)
  }, [period, activeProvider, dayDate, reloadData, selectIndexedPeriod, indexing])

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
    const quitNow = (exitCode: number): void => {
      exit()
      terminateProcess?.(exitCode)
    }
    // #1143: Ctrl+C always exits immediately, regardless of fill state. The
    // #1109 abrupt path is kill-safe (nothing marked seen without being
    // parsed, resume converges), so this is the unconditional escape hatch.
    if (key.ctrl && input === 'c') { quitNow(130); return }
    // First q during an active fill: arm confirmation, do not exit. The fill
    // keeps running so the next launch starts warm. A second q takes the
    // abrupt path; q with no fill active exits immediately (no flicker).
    if (input === 'q') {
      if (indexing) {
        // A ref makes two q bytes decisive even when the background scan keeps
        // React from committing the confirmation state between them.
        if (quitArmedRef.current) { quitNow(0); return }
        quitArmedRef.current = true
        setQuitArmed(true)
        return
      }
      quitNow(0)
      return
    }
    if (input === 'o' && view === 'dashboard' && optimizeAvailable) { void loadOptimizeResult(); return }
    if ((input === 'b' || key.escape) && view === 'optimize') { setView('dashboard'); setFindingsCursor(0); return }
    if (view === 'optimize') {
      const total = optimizeResult?.findings.length ?? 0
      const maxStart = Math.max(0, total - FINDINGS_WINDOW_SIZE)
      if (input === 'j') { setFindingsCursor(c => Math.min(c + 1, maxStart)); return }
      if (input === 'k') { setFindingsCursor(c => Math.max(c - 1, 0)); return }
      return
    }
    if (input === 'c' && compareAvailable && view === 'dashboard') { setView('compare'); return }
    if ((input === 'b' || key.escape) && view === 'compare') { setView('dashboard'); return }
    if (view === 'dashboard' && scrollableDailyHistory) {
      if (input === ' ' && !key.shift) { setDailyHistoryCursor(c => pageHistoryCursor(c, 1, dailyHistoryPageSize, dailyHistoryRowCount)); return }
      if (input === ' ' && key.shift) { setDailyHistoryCursor(c => pageHistoryCursor(c, -1, dailyHistoryPageSize, dailyHistoryRowCount)); return }
      if (input === 'j') { setDailyHistoryCursor(c => scrollHistoryCursor(c, 1, dailyHistoryPageSize, dailyHistoryRowCount)); return }
      if (input === 'k') { setDailyHistoryCursor(c => scrollHistoryCursor(c, -1, dailyHistoryPageSize, dailyHistoryRowCount)); return }
      if (input === 'g') { setDailyHistoryCursor(0); return }
      if (input === 'G') { setDailyHistoryCursor(dailyHistoryMaxCursor); return }
    }
    if (input === 'p' && multipleProviders && view !== 'compare') {
      const opts = ['all', ...detectedProviders]; const next = opts[(opts.indexOf(activeProvider) + 1) % opts.length]
      setActiveProvider(next); setView('dashboard')
      setDailyHistoryCursor(0)
      historyIndexRef.current = null
      setProjects([])
      setDurable(undefined)
      setLoading(true)
      if (debounceRef.current) clearTimeout(debounceRef.current)
      // Custom ranges and day views do not run the progressive history effect,
      // so provider cycling must always own and finish its reload. Setting the
      // global indexing flag here stranded --from/--to on a permanent skeleton.
      void reloadData(period, next, dayDate)
      return
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
  const coachingNote = view === 'dashboard' ? selectRotatingNote(coachingNotes, noteTick) : null

  const content = loading || optimizeLoading
    ? (
      <Box flexDirection="column" width={dashWidth}>
        {!isCustomRange && !isDayMode && <PeriodTabs active={period} providerName={activeProvider} showProvider={view !== 'compare' && multipleProviders} />}
        {isDayMode && <DayBanner label={headerLabel} width={dashWidth} />}
        {isCustomRange && <CustomRangeBanner label={headerLabel} width={dashWidth} />}
        {indexing && <IndexingBanner width={dashWidth} done={indexedFiles} total={indexPendingFiles} cold={indexCold} phase={indexPhase} visiblePeriod={period} />}
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
        {quitArmed && indexing && <QuitConfirmationBanner width={dashWidth} />}
        {view !== 'compare' && <StatusBar width={dashWidth} showProvider={multipleProviders} view={view} findingCount={0} optimizeAvailable={false} compareAvailable={false} customRange={isCustomRange} dayMode={isDayMode} />}
      </Box>
    )
    : (
      <Box flexDirection="column" width={dashWidth}>
        {!isCustomRange && !isDayMode && <PeriodTabs active={period} providerName={activeProvider} showProvider={multipleProviders && view !== 'compare'} />}
        {isDayMode && <DayBanner label={headerLabel} width={dashWidth} />}
        {isCustomRange && <CustomRangeBanner label={headerLabel} width={dashWidth} />}
        {indexing && <IndexingBanner width={dashWidth} done={indexedFiles} total={indexPendingFiles} cold={indexCold} phase={indexPhase} visiblePeriod={period} />}
        {view === 'compare'
          ? <CompareView projects={projects} onBack={() => setView('dashboard')} scopeToProjects={(projectFilter?.length ?? 0) > 0 || (excludeFilter?.length ?? 0) > 0} />
          : view === 'optimize' && optimizeResult
            ? <OptimizeView findings={optimizeResult.findings} costRate={optimizeResult.costRate} projects={projects} label={headerLabel} width={dashWidth} healthScore={optimizeResult.healthScore} healthGrade={optimizeResult.healthGrade} cursor={findingsCursor} appliedFixes={appliedFixes} />
            : <DashboardContent projects={projects} period={period} columns={columns} maxContentWidth={maxContentWidth} activeProvider={activeProvider} budgets={projectBudgets} planUsages={planUsages} label={headerLabel} dayMode={isDayMode} dailyHistoryProjects={dailyHistoryProjects} dailyHistoryPageSize={dailyHistoryPageSize} scrollableDailyHistory={scrollableDailyHistory} dailyHistoryCursor={Math.min(dailyHistoryCursor, dailyHistoryMaxCursor)} durable={durable} />}
        {coachingNote && (
          <Box width={dashWidth} paddingX={1}>
            <Text wrap="truncate-end"><Text color={ORANGE} bold>tip </Text><Text dimColor>{coachingNote}</Text></Text>
          </Box>
        )}
        {quitArmed && indexing && <QuitConfirmationBanner width={dashWidth} />}
        {view !== 'compare' && <StatusBar width={dashWidth} showProvider={multipleProviders} view={view} findingCount={findingCount} optimizeAvailable={optimizeAvailable} compareAvailable={compareAvailable} customRange={isCustomRange} dayMode={isDayMode} />}
      </Box>
    )

  return (
    <ScrollableViewport
      key={`${view}:${period}:${activeProvider}:${dayDate ?? ''}:${customRangeLabel ?? ''}`}
      width={dashWidth}
      lineScroll={view !== 'compare'}
    >
      {content}
    </ScrollableViewport>
  )
}

/// Honest phase and file-count state while the selected period remains usable
/// and the shared normalized index widens in the background.
function IndexingBanner({ width, done, total, cold, phase, visiblePeriod }: { width: number; done: number; total: number; cold: boolean; phase: DashboardIndexPhase; visiblePeriod: Period }) {
  const largeFirstIndex = cold && total >= LARGE_HISTORY_FILE_THRESHOLD
  const sharedIndexLabel = phase === 'cached'
    ? 'loading normalized cache; source refresh pending'
    : phase === 'refreshing'
      ? 'cached periods ready; refreshing changed source files'
      : phase === 'week'
        ? 'Today ready; loading 7 Days'
        : `${PERIOD_LABELS[DASHBOARD_COLD_INDEX_PHASES[Math.max(0, DASHBOARD_COLD_INDEX_PHASES.indexOf(phase) - 1)]!]} ready; loading ${PERIOD_LABELS[phase]}`
  const readyLabel = `${PERIOD_LABELS[visiblePeriod]} visible · shared index: ${sharedIndexLabel}`
  const count = cold && total > 0
    ? ` · ${Math.min(done, total)} source files parsed · ${total} deferred at first paint`
    : ''
  return (
    <Box width={width} paddingX={1} flexDirection="column">
      <Text wrap="truncate-end">
        <Text color={ORANGE} bold>{phase === 'refreshing' ? 'refreshing ' : phase === 'cached' ? 'cached ' : 'indexing '}</Text>
        <Text dimColor>
          {readyLabel}{count}
        </Text>
      </Text>
      {largeFirstIndex && <Text color={ORANGE}>large first index · may take a few minutes</Text>}
    </Box>
  )
}

// #1143: shown after the first q during the cold-start fill. The user sees
// feedback instead of a silent ~16.5s drain; a second q (or any Ctrl+C) takes
// the abrupt path. Footer styling matches StatusBar (DIM border, ORANGE
// accent on the action key) so it reads as part of the chrome, not a toast.
function QuitConfirmationBanner({ width }: { width: number }) {
  return (
    <Box borderStyle="round" borderColor={DIM} width={width} justifyContent="center" paddingX={1}>
      <Text wrap="truncate-end">
        <Text dimColor>Finishing background index so the next launch starts warm - press </Text>
        <Text color={ORANGE} bold>q</Text>
        <Text dimColor> or </Text>
        <Text color={ORANGE} bold>Ctrl+C</Text>
        <Text dimColor> again to quit now</Text>
      </Text>
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

/// The initial paint's data, assembled under one declared parse scope.
///
/// The scan parse, the plan window and the durable headline each ran the whole
/// pipeline: three ranges that often share a start and differ only in where
/// they end (end-of-day vs each caller's own `new Date()`), which the exact-key
/// memo cannot match. Declaring the widest of them lets `withSinglePassParse`
/// serve the rest by slicing it — but only the ones that are a pure narrowing,
/// so a range that genuinely needs its own file set (a plan window starting
/// before the scan range, a past `--day`) still parses on its own.
export async function assembleDashboardData(
  period: Period,
  provider: string,
  projectFilter: string[] | undefined,
  excludeFilter: string[] | undefined,
  customRange: DateRange | null | undefined,
  initialDay: string | null,
  scrollableDailyHistory: boolean,
  autoFallback = false,
  includePlanUsages = true,
): Promise<{ period: Period; scannedProjects: ProjectSummary[]; filteredProjects: ProjectSummary[]; planUsages: PlanUsage[]; initialDurable: DurableOverview }> {
  const range = getDashboardScanRange(period, customRange, initialDay, scrollableDailyHistory)
  // With the fallback armed the scope must cover the period it can land on too,
  // so declare the wider of the two durable ranges.
  const durableRange = getDurableRange(autoFallback ? AUTO_FALLBACK_PERIOD : period, customRange, initialDay)
  const superset: DateRange = {
    start: new Date(Math.min(range.start.getTime(), durableRange.start.getTime())),
    end: new Date(Math.max(range.end.getTime(), durableRange.end.getTime())),
  }
  return withSinglePassParse(superset, async () => {
    const scannedProjects = filterProjectsByName(await parseAllSessions(range, provider), projectFilter, excludeFilter)
    // #1111: the today-scoped slice IS the probe for the unset default — it
    // comes out of the parse that had to happen anyway, so an empty today costs
    // a slice, not a second pass. Sessions rather than projects: a project can
    // survive the slice on subagent anchors alone, which carry no in-range
    // spend and are not a day worth opening on.
    const opened = autoFallback && !selectDashboardPeriodProjects(scannedProjects, period, scrollableDailyHistory).some(p => p.sessions.length > 0)
      ? AUTO_FALLBACK_PERIOD
      : period
    const filteredProjects = selectDashboardPeriodProjects(scannedProjects, opened, scrollableDailyHistory)
    // A Today-scoped progressive pass cannot truthfully compute a monthly plan
    // window. Keep that panel absent until the lifetime background index lands.
    const planUsages = includePlanUsages ? await getPlanUsages() : []
    // Durable headline totals for the initial paint (carry-forward cache + today),
    // matching the menubar/report. The interactive tree recomputes this on every
    // period/provider/refresh change; the static one-shot render uses just this.
    const initialDurable = await computeDurableOverview(opened, provider, projectFilter, excludeFilter, customRange, initialDay)
    return { period: opened, scannedProjects, filteredProjects, planUsages, initialDurable }
  })
}

export type DashboardHistoryIndex = {
  provider: string
  normalizedProjects: ProjectSummary[]
  cache: DailyCache
  planUsages: PlanUsage[]
  readyThrough?: Period
  projectFilter?: string[]
  excludeFilter?: string[]
}

export const DASHBOARD_COLD_INDEX_PHASES: Period[] = ['week', '30days', 'month', 'all', 'lifetime']

function dashboardIndexScanRange(readyThrough: Period): DateRange {
  const range = getPeriodRange(readyThrough)
  if (readyThrough !== 'month') return range
  const thirtyDays = getPeriodRange('30days')
  return {
    start: new Date(Math.min(range.start.getTime(), thirtyDays.start.getTime())),
    end: new Date(Math.max(range.end.getTime(), thirtyDays.end.getTime())),
  }
}

export function dashboardIndexSupportsPeriod(index: DashboardHistoryIndex, period: Period): boolean {
  const readyThrough = index.readyThrough ?? 'lifetime'
  return PERIODS.indexOf(period) <= PERIODS.indexOf(readyThrough)
}

/** The unset interactive default moves to 7D only when Today is truly all-zero.
 * A warm lifetime index follows the same rule as a week-ready cold index. */
export function shouldAutoFallbackToWeek(
  enabled: boolean,
  alreadyApplied: boolean,
  visiblePeriod: Period,
  index: DashboardHistoryIndex,
  todayProjects: ProjectSummary[],
): boolean {
  const todayHasUsage = todayProjects.some(project => (
    project.totalApiCalls > 0
    || project.totalCostUSD !== 0
    || (project.totalSavingsUSD ?? 0) !== 0
    || project.sessions.some(session => (
      session.apiCalls > 0
      || session.totalCostUSD !== 0
      || session.totalInputTokens > 0
      || session.totalOutputTokens > 0
      || session.totalCacheReadTokens > 0
      || session.totalCacheWriteTokens > 0
    ))
  ))
  return enabled
    && !alreadyApplied
    && visiblePeriod === 'today'
    && dashboardIndexSupportsPeriod(index, 'week')
    && !todayHasUsage
}

type DashboardHistoryIndexBuildOptions = {
  readyThrough?: Period
  preferCompleteSnapshot?: boolean
  progressiveSource?: boolean
}

/** Build one widening normalized index; cached files are never source-parsed twice. */
export async function buildDashboardHistoryIndex(
  provider: string,
  projectFilter: string[] | undefined,
  excludeFilter: string[] | undefined,
  options: DashboardHistoryIndexBuildOptions = {},
): Promise<DashboardHistoryIndex> {
  const readyThrough = options.readyThrough ?? 'lifetime'
  const range = dashboardIndexScanRange(readyThrough)
  const parse = () => parseAllSessions(range, provider)
  const normalizedProjects = options.preferCompleteSnapshot || options.progressiveSource
    ? (await withColdFirstPaintFloor(
        range.start,
        parse,
        false,
        options.preferCompleteSnapshot === true,
      )).result
    : await parse()
  // The durable cache is all-provider state. Only an all-provider normalized
  // index can safely advance it; a provider-scoped index reads but never
  // rewrites that shared history.
  const cache = provider === 'all'
    ? await hydrateDailyCacheFromNormalizedProjects(normalizedProjects, readyThrough === 'lifetime')
    : await loadDailyCache()
  const planUsages = readyThrough === 'lifetime' && !options.preferCompleteSnapshot ? await getPlanUsages() : []
  return { provider, normalizedProjects, cache, planUsages, readyThrough, projectFilter, excludeFilter }
}

/** Pure period projection: no discovery, transcript reads, or parser calls. */
export function selectDashboardHistoryIndex(
  index: DashboardHistoryIndex,
  period: Period,
): { projects: ProjectSummary[]; durable: DurableOverview } {
  const filtered = filterProjectsByName(index.normalizedProjects, index.projectFilter, index.excludeFilter)
  const projects = filterProjectsByDateRange(filtered, getPeriodRange(period))
  const durable = buildDurableOverviewFromNormalizedIndex(
    { range: getPeriodRange(period), label: PERIOD_LABELS[period] },
    index.normalizedProjects,
    index.cache,
    { provider: index.provider, project: index.projectFilter, exclude: index.excludeFilter },
  )
  return { projects, durable }
}

/**
 * Assemble the first interactive frame from only the period it is about to
 * label. This is intentionally independent of cache coldness: a complete
 * sharded cache can still contain years of normalized sessions, and loading
 * that lifetime result before Ink starts is the warm-start regression this
 * seam prevents.
 *
 * The returned deferred count is passed to the mounted dashboard, which owns
 * the one lifetime background index. If the unset default falls back from an
 * empty Today to 7 Days, repaint under the wider floor before anything is
 * shown so the fallback is truthful too.
 */
export async function assembleDashboardFirstPaint(
  period: Period,
  provider: string,
  projectFilter: string[] | undefined,
  excludeFilter: string[] | undefined,
  customRange: DateRange | null | undefined,
  initialDay: string | null,
  autoFallback = false,
): Promise<{ result: Awaited<ReturnType<typeof assembleDashboardData>>; deferredFiles: number }> {
  const run = (p: Period, fallback: boolean) => withColdFirstPaintFloor(
    getPeriodRange(p).start,
    () => assembleDashboardData(
      p,
      provider,
      projectFilter,
      excludeFilter,
      customRange,
      initialDay,
      false,
      fallback,
      false,
    ),
    true,
    true,
  )
  let paint = await run(period, autoFallback)
  if (paint.result.period !== period) paint = await run(paint.result.period, false)
  return paint
}

/// Where the unset interactive default lands when today has no sessions yet (#1111).
export const AUTO_FALLBACK_PERIOD: Period = 'week'

export async function renderDashboard(period: Period = 'week', provider: string = 'all', refreshSeconds?: number, projectFilter?: string[], excludeFilter?: string[], customRange?: DateRange | null, customRangeLabel?: string, initialDay?: string, autoPeriod = false): Promise<void> {
  // Interactive Ink UI: it renders to the same terminal and has its own in-frame
  // loading state, so the CLI scan-progress line must stay silent for its whole
  // lifetime (initial scan and every enabled auto-refresh, including the
  // getPlanUsages → parseAllSessions path). Plain CLI commands are unaffected.
  setInteractiveScanUI()
  const startupStarted = performance.now()
  await loadPricing()
  if (process.env['CODEBURN_VERBOSE'] === '1') process.stderr.write(`codeburn: startup timing pricing=${(performance.now() - startupStarted).toFixed(1)}ms\n`)
  const dayRange = initialDay ? getDayRange(initialDay) : null
  const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  const scrollableDailyHistory = isTTY && dayRange == null && customRange == null
  // Progressive interactive start: the first paint of the standard dated view
  // only needs the selected period, regardless of whether the normalized cache
  // is cold or complete. Older history is handed to one background index once
  // the dashboard is on screen. Interactive only — every one-shot output
  // (json/csv/markdown, report, sessions, the app and menubar payloads) keeps
  // the full parse and can never return a partial total.
  const progressive = isTTY && dayRange == null && customRange == null
  const snapshotAvailable = progressive
    ? await isCompleteSessionSnapshotAvailable(getPeriodRange('today'), provider)
    : false
  const cacheWasCold = progressive && !snapshotAvailable
  // #1111: with no explicit period the interactive dashboard opens on Today and
  // falls back to 7 days only when today holds nothing yet. Explicit -p/--day/
  // --from/--to and the non-interactive render keep the 7-day default.
  const auto = autoPeriod && isTTY && dayRange == null && customRange == null
  const openPeriod: Period = auto ? 'today' : period
  const paint = progressive
    ? await assembleDashboardFirstPaint(openPeriod, provider, projectFilter, excludeFilter, customRange, initialDay ?? null, false)
    : {
        result: await assembleDashboardData(openPeriod, provider, projectFilter, excludeFilter, customRange, initialDay ?? null, scrollableDailyHistory, auto),
        deferredFiles: 0,
      }
  if (process.env['CODEBURN_VERBOSE'] === '1') {
    process.stderr.write(`codeburn: startup timing pre-ink=${(performance.now() - startupStarted).toFixed(1)}ms\n`)
    process.stderr.write(`codeburn: progressive startup ${progressive ? 'on' : 'off'}, ${paint.deferredFiles} files deferred to the background index\n`)
  }
  const { period: opened, scannedProjects, filteredProjects, planUsages, initialDurable } = paint.result
  const label = initialDay ? formatDayRangeLabel(initialDay) : customRangeLabel
  patchStdoutForWindows()
  if (isTTY) {
    let lastQuitByteAt = 0
    const hardQuitGuard = (chunk: string | Buffer): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      for (const byte of bytes) {
        if (byte === 3) setImmediate(() => exitAfterCacheCleanup(130))
        if (byte !== 113) continue
        const now = Date.now()
        if (now - lastQuitByteAt <= 2000) setImmediate(() => exitAfterCacheCleanup(0))
        lastQuitByteAt = now
      }
    }
    process.stdin.on('data', hardQuitGuard)
    const stopUserTimingGuard = startUserTimingGuard()
    const app = renderDebouncedInteractive(process.stdout, ({ columns }) => (
      <InteractiveDashboard initialProjects={filteredProjects} initialDailyHistoryProjects={scrollableDailyHistory ? scannedProjects : undefined} initialPeriod={opened} initialProvider={provider} initialPlanUsages={planUsages} initialDurable={initialDurable} refreshSeconds={refreshSeconds} projectFilter={projectFilter} excludeFilter={excludeFilter} customRange={customRange} customRangeLabel={customRangeLabel} initialDay={initialDay} windowColumns={columns} initialIndexPendingFiles={paint.deferredFiles} initialHistoryIndexing={progressive} initialCacheWasCold={cacheWasCold} autoFallbackFromEmptyToday={auto} terminateProcess={exitCode => { setImmediate(() => exitAfterCacheCleanup(exitCode)) }} />
    ))
    try {
      await app.waitUntilExit()
    } finally {
      process.stdin.off('data', hardQuitGuard)
      app.dispose()
      stopUserTimingGuard()
    }
  } else {
    const { unmount } = render(<StaticDashboard projects={filteredProjects} period={opened} activeProvider={provider} planUsages={planUsages} label={label} dayMode={initialDay != null} durable={initialDurable} />, { patchConsole: false })
    // Non-interactive one-shot output: ink schedules the frame through a
    // throttled render, so yield a tick to let it flush to stdout before
    // unmounting. Unmounting synchronously can race the flush and drop output.
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    unmount()
  }
}

import { existsSync } from 'fs'
import { dirname } from 'node:path'
import type { DateRange, ProjectSummary, SessionSummary } from '../types.js'
import type { ActionBaseline, ActionKind, ActionRecord, AppliedFix, AppliedVerdict } from './types.js'
import { REPORT_MIN_AGE_DAYS, VERDICT_WORKED_RATIO } from './types.js'
import type { FindingPlan } from './plans.js'
import {
  AVG_TOKENS_PER_READ,
  HEALTHY_READ_EDIT_RATIO,
  TOKENS_PER_MCP_TOOL,
  TOOLS_PER_MCP_SERVER,
  TOKENS_PER_SKILL_DEF,
  TOKENS_PER_AGENT_DEF,
  TOKENS_PER_COMMAND_DEF,
  READ_TOOL_NAMES,
  EDIT_TOOL_NAMES,
  aggregateMcpCoverage,
  computeInputCostRate,
  FINDING_TOKEN_KIND,
  mcpLowCoverageSchemaPerSession,
  mcpProjectScopeSchemaPerSession,
  findingPricing,
  sessionTokensUSD,
  type FindingPricing,
  type McpServerCoverage,
  type WasteFinding,
} from '../optimize.js'
import { parseAllSessions } from '../parser.js'
import { computeYield, type YieldSummary } from '../yield.js'
import { defaultActionsDir, readRecords, shortId } from './journal.js'
import { undoAction } from './undo.js'
import { renderTable } from '../text-table.js'
import { formatTokens } from '../format.js'
import { formatCost } from '../currency.js'

const DAY_MS = 24 * 60 * 60 * 1000
const WINDOW_CAP_DAYS = 30
const BASELINE_WINDOW_DAYS = 14
const MIN_POST_WINDOW_SESSIONS = 20
const VOLUME_SHIFT_FACTOR = 2

// Encode the epic's honest-accounting rules where they are seen: estimates are
// window-scaled so both columns share a scale, each kind measures only its own
// metric, guard is correlation, and realized figures are rounded down.
const HONEST_FOOTER =
  'Estimates are scaled to the measured window for comparability; the at-apply estimate is kept in --json. '
  + 'MCP and archive realized figures are derived from per-session baselines times session counts, not independently measured. '
  + 'Each fix measures only its own metric; effects are never attributed across signals. '
  + 'Guard rows are correlation, not attribution. Realized numbers are rounded down. '
  + 'Deferral rows exclude servers an MCP remove/scope row already measures.'

const MCP_KINDS = new Set<ActionKind>(['mcp-remove', 'mcp-project-scope'])
// defer-* re-enable native MCP tool deferral (part 2 of #614): the same
// prefix schema tokens mcp-remove eliminates, deferral moves out of the
// upfront prefix. Realized the same way — per-session schema tokens times the
// post-apply sessions that benefited — but "benefited" flips: instead of a
// server no longer loading, it is deferral having become active (the session
// now carries a deferred-tools inventory, the detector's own signal).
const DEFER_KINDS = new Set<ActionKind>(['defer-enable', 'defer-alwaysload', 'defer-threshold'])
const ARCHIVE_DEF_TOKENS: Partial<Record<ActionKind, number>> = {
  'archive-skill': TOKENS_PER_SKILL_DEF,
  'archive-agent': TOKENS_PER_AGENT_DEF,
  'archive-command': TOKENS_PER_COMMAND_DEF,
}

// 'pending' means the applied change has not taken effect in any post-apply
// session yet (e.g. deferral before a client restart) - distinct from
// 'reverted', which asserts the user undid it.
export { REPORT_MIN_AGE_DAYS }

export type RealizedStatus = 'measured' | 'reverted' | 'not-measurable' | 'pending'

export type ActReportRow = {
  id: string
  appliedAt: string
  date: string
  kind: ActionKind
  description: string
  // The detector's estimate persisted at apply time, unmodified.
  estimatedAtApply: number
  // The estimate re-expressed over the same post-apply window as realized so
  // the two table columns are comparable; falls back to estimatedAtApply for
  // kinds with no window scaling.
  estimatedForWindow: number
  realizedTokens: number
  // realizedTokens priced the way the fix's finding priced its tokens.
  realizedCostUSD: number
  status: RealizedStatus
  confidence: 'low' | 'normal'
  note: string
  // guard-install only: yield split then vs now, labeled correlation.
  correlation?: {
    abandonedPctThen: number
    abandonedPctNow: number
    avgSessionCostThenUSD: number
    avgSessionCostNowUSD: number
  }
}

export type ActReport = {
  generatedAt: string
  windowCapDays: number
  costRate: number
  rows: ActReportRow[]
  totalRealizedTokens: number
  totalRealizedCostUSD: number
  measuredCount: number
  activeCount: number
  observedDays: number
  // Journal lines that parsed as JSON but are not usable records (missing or
  // unparseable `at`, missing status); skipped and surfaced, never a throw.
  malformedRecords: number
  // findingId -> earliest apply date of an active applied action; drives the
  // optimize "(previously applied ..., re-flagged)" title suffix.
  appliedByFinding: Record<string, string>
  // One entry per active applied action, including ones too young to measure.
  appliedFixes: AppliedFix[]
}

export type ActReportOptions = {
  actionsDir?: string
  now?: Date
  cwd?: string
  loadProjects?: (range: DateRange) => Promise<ProjectSummary[]>
  computeYield?: (range: DateRange) => Promise<YieldSummary>
}

// ---------------------------------------------------------------------------
// Shared measurement helpers
// ---------------------------------------------------------------------------

function ageDays(iso: string, now: Date): number {
  return (now.getTime() - new Date(iso).getTime()) / DAY_MS
}

function allSessions(projects: ProjectSummary[]): SessionSummary[] {
  return projects.flatMap(p => p.sessions)
}

function sessionsInWindow(projects: ProjectSummary[], start: Date, end: Date): SessionSummary[] {
  const out: SessionSummary[] = []
  for (const p of projects) {
    for (const s of p.sessions) {
      if (!s.firstTimestamp) continue
      const t = new Date(s.firstTimestamp).getTime()
      if (t >= start.getTime() && t <= end.getTime()) out.push(s)
    }
  }
  return out
}

function projectPathKey(path: string): string {
  const normalized = path.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized.toLowerCase()
}

function modelDefaultSessionsInWindow(
  rec: ActionRecord, projects: ProjectSummary[], start: Date, end: Date,
): { projectFound: boolean; sessions: SessionSummary[] } {
  const settingsPath = rec.changes[0]?.path
  if (!settingsPath) return { projectFound: false, sessions: [] }
  const normalizedSettingsPath = settingsPath.replace(/\\/g, '/')
  const targetProjectPath = dirname(dirname(normalizedSettingsPath))
  const targetKey = projectPathKey(targetProjectPath)
  const targetProjects = projects.filter(project => projectPathKey(project.projectPath) === targetKey)
  return {
    projectFound: targetProjects.length > 0,
    sessions: sessionsInWindow(targetProjects, start, end),
  }
}

function countToolCalls(sessions: SessionSummary[], names: ReadonlySet<string>): number {
  let n = 0
  for (const s of sessions) {
    for (const [tool, data] of Object.entries(s.toolBreakdown)) {
      if (names.has(tool)) n += data.calls
    }
  }
  return n
}

function countBashCalls(sessions: SessionSummary[]): number {
  let n = 0
  for (const s of sessions) {
    for (const data of Object.values(s.bashBreakdown)) n += data.calls
  }
  return n
}

function sessionLoadsAny(s: SessionSummary, servers: string[]): boolean {
  for (const fqn of s.mcpInventory ?? []) {
    const seg = fqn.split('__')[1]
    if (seg && servers.includes(seg)) return true
  }
  for (const server of Object.keys(s.mcpBreakdown)) {
    if (servers.includes(server)) return true
  }
  return false
}

function countSessionsLoading(projects: ProjectSummary[], servers: string[]): number {
  return allSessions(projects).filter(s => sessionLoadsAny(s, servers)).length
}

// Deferral is active in a session exactly when Claude Code emitted a
// deferred-tools inventory for it — the same signal the mcp-deferral-off
// detector uses (its absence, alongside MCP overhead, is what flags a gap).
function sessionHasDeferralActive(s: SessionSummary): boolean {
  return (s.mcpInventory?.length ?? 0) > 0
}

// MCP servers observed loading in the window (via inventory or invocation).
// defer-enable / defer-threshold re-enable deferral for the whole MCP surface
// rather than a named set, so the affected servers are derived here.
function observedMcpServers(projects: ProjectSummary[]): string[] {
  const servers = new Set<string>()
  for (const s of allSessions(projects)) {
    for (const fqn of s.mcpInventory ?? []) {
      const seg = fqn.split('__')[1]
      if (seg) servers.add(seg)
    }
    for (const server of Object.keys(s.mcpBreakdown)) servers.add(server)
  }
  return [...servers]
}

// A kind whose realized effect is a token saving (everything except guard,
// which is a dollars/yield correlation, and out-of-scope kinds).
function isTokenKind(kind: ActionKind): boolean {
  return kind !== 'guard-install' && kind !== 'guard-uninstall' && kind !== 'model-default'
}

function confidenceFor(afterSessions: number, baseline: ActionBaseline, afterStart: Date, now: Date): 'low' | 'normal' {
  if (afterSessions < MIN_POST_WINDOW_SESSIONS) return 'low'
  if (baseline.sessions > 0 && baseline.windowDays > 0) {
    const afterDays = Math.max((now.getTime() - afterStart.getTime()) / DAY_MS, 1)
    const shift = (afterSessions / afterDays) / (baseline.sessions / baseline.windowDays)
    if (shift > VOLUME_SHIFT_FACTOR || shift < 1 / VOLUME_SHIFT_FACTOR) return 'low'
  }
  return 'normal'
}

// Advertised and realized stay comparable: a measured finding's token kind at
// each benefiting session's rate, else the blended rate on the whole figure.
function realizedUSD(
  pricing: FindingPricing, rec: ActionRecord, realizedTokens: number,
  perSession: Array<[SessionSummary, number]>,
): number {
  const kind = rec.findingId ? FINDING_TOKEN_KIND[rec.findingId] : undefined
  if (!kind) return realizedTokens * pricing.fallbackRate
  return perSession.reduce((sum, [s, tokens]) => sum + sessionTokensUSD(pricing, s.sessionId, tokens, kind), 0)
}

// ---------------------------------------------------------------------------
// Per-kind realized deltas
// ---------------------------------------------------------------------------

function mcpRow(
  base: ActReportRow, rec: ActionRecord, sessions: SessionSummary[],
  baseline: ActionBaseline, afterStart: Date, now: Date, pricing: FindingPricing,
): ActReportRow {
  const servers = Object.keys(baseline.metrics)
  const perSessionTokens = Object.values(baseline.metrics).reduce((a, b) => a + b, 0)
  if (servers.length === 0 || perSessionTokens === 0) return { ...base, note: 'not measurable: empty baseline' }
  if (sessions.length === 0) return { ...base, note: 'not measurable: no sessions in the window yet' }
  // Window-scaled estimate: what the fix would save if every window session
  // benefited. Realized differs from it only through still-loading sessions
  // (and the revert check), so the pair is derived from session counts, not
  // independently measured.
  const estimatedForWindow = Math.floor(perSessionTokens * sessions.length)
  const saved = sessions.filter(s => !sessionLoadsAny(s, servers))
  const stillLoading = sessions.length - saved.length
  const confidence = confidenceFor(sessions.length, baseline, afterStart, now)
  if (rec.kind === 'mcp-remove' && stillLoading > 0) {
    return {
      ...base,
      estimatedForWindow,
      status: 'reverted',
      confidence,
      note: `reverted by user: ${servers.join(', ')} loaded again in ${stillLoading} post-apply session${stillLoading === 1 ? '' : 's'}`,
    }
  }
  const realizedTokens = Math.floor(perSessionTokens * saved.length)
  return {
    ...base, estimatedForWindow, status: 'measured', confidence, realizedTokens,
    realizedCostUSD: realizedUSD(pricing, rec, realizedTokens, saved.map(s => [s, perSessionTokens])),
  }
}

function deferRow(
  base: ActReportRow, rec: ActionRecord, sessions: SessionSummary[],
  baseline: ActionBaseline, afterStart: Date, now: Date,
  mcpClaimedServers: ReadonlySet<string>, pricing: FindingPricing,
): ActReportRow {
  // Sum only the servers no MCP row claims (see mcpClaimedServers in
  // computeActReport), so the same schema tokens are never realized twice.
  const counted = Object.entries(baseline.metrics).filter(([server]) => !mcpClaimedServers.has(server))
  const excludedServers = Object.keys(baseline.metrics).length - counted.length
  const perSessionTokens = counted.reduce((a, [, tokens]) => a + tokens, 0)
  if (perSessionTokens === 0) {
    return {
      ...base,
      note: excludedServers > 0
        ? 'not measurable: every server in this baseline is already measured by an MCP remove/scope row'
        : 'not measurable: empty baseline',
    }
  }
  if (sessions.length === 0) return { ...base, note: 'not measurable: no sessions in the window yet' }
  const estimatedForWindow = Math.floor(perSessionTokens * sessions.length)
  // A post-apply session realized the saving only if deferral actually became
  // active in it. ENABLE_TOOL_SEARCH is read at process start, so sessions
  // begun before the user restarted still run deferral-off — those aren't
  // counted, and if none benefited we report it plainly rather than claim a
  // saving that hasn't taken effect.
  const deferred = sessions.filter(sessionHasDeferralActive)
  const confidence = confidenceFor(sessions.length, baseline, afterStart, now)
  if (deferred.length === 0) {
    return {
      ...base,
      estimatedForWindow,
      status: 'pending',
      confidence,
      note: `not yet in effect: deferral is still inactive in ${sessions.length} post-apply session${sessions.length === 1 ? '' : 's'} (takes effect on the next session; the client may not have restarted, or the change was reverted)`,
    }
  }
  const realizedTokens = Math.floor(perSessionTokens * deferred.length)
  return {
    ...base, estimatedForWindow, status: 'measured', confidence, realizedTokens,
    realizedCostUSD: realizedUSD(pricing, rec, realizedTokens, deferred.map(s => [s, perSessionTokens])),
  }
}

function archiveRow(
  base: ActReportRow, rec: ActionRecord, sessions: SessionSummary[],
  baseline: ActionBaseline, afterStart: Date, now: Date, pricing: FindingPricing,
): ActReportRow {
  const perSessionTokens = Object.values(baseline.metrics).reduce((a, b) => a + b, 0)
  if (perSessionTokens === 0) return { ...base, note: 'not measurable: empty baseline' }
  if (sessions.length === 0) return { ...base, note: 'not measurable: no sessions in the window yet' }
  const estimatedForWindow = Math.floor(perSessionTokens * sessions.length)
  const confidence = confidenceFor(sessions.length, baseline, afterStart, now)
  const restored = rec.changes.some(c => c.op === 'move' && existsSync(c.path))
  if (restored) {
    return { ...base, estimatedForWindow, status: 'reverted', confidence, note: 'reverted by user: an archived item was moved back into place' }
  }
  // Estimate and realized are the same product by construction; the measured
  // signal here is the session count and the revert check, not the multiply.
  const realizedTokens = Math.floor(perSessionTokens * sessions.length)
  return {
    ...base, estimatedForWindow, status: 'measured', confidence, realizedTokens,
    realizedCostUSD: realizedUSD(pricing, rec, realizedTokens, sessions.map(s => [s, perSessionTokens])),
  }
}

function readEditRow(
  base: ActReportRow, rec: ActionRecord, sessions: SessionSummary[],
  baseline: ActionBaseline, afterStart: Date, now: Date, pricing: FindingPricing,
): ActReportRow {
  const editsNow = countToolCalls(sessions, EDIT_TOOL_NAMES)
  const readsNow = countToolCalls(sessions, READ_TOOL_NAMES)
  const editsThen = baseline.metrics['edits'] ?? 0
  const readsThen = baseline.metrics['reads'] ?? 0
  if (editsThen <= 0 || editsNow <= 0) return { ...base, note: 'not measurable: not enough edit activity to compare' }
  const ratioThen = readsThen / editsThen
  const ratioNow = readsNow / editsNow
  // Detector estimate math: reads short of HEALTHY_READ_EDIT_RATIO per edit are
  // the retry-prone deficit. Credit only the reduction in that deficit, scaled
  // by current edits; a worsened ratio claims nothing.
  const deficitThen = Math.max(HEALTHY_READ_EDIT_RATIO - ratioThen, 0)
  const deficitNow = Math.max(HEALTHY_READ_EDIT_RATIO - ratioNow, 0)
  const readsPerEdit = Math.max(0, deficitThen - deficitNow) * AVG_TOKENS_PER_READ
  const realized = Math.floor(readsPerEdit * editsNow)
  // Each session's share of the credited reads follows its edits.
  const realizedCostUSD = realizedUSD(pricing, rec, realized,
    sessions.map(s => [s, readsPerEdit * countToolCalls([s], EDIT_TOOL_NAMES)]))
  // Same edits denominator as realized, so realized never exceeds it.
  const estimatedForWindow = Math.floor(deficitThen * editsNow * AVG_TOKENS_PER_READ)
  return {
    ...base,
    estimatedForWindow,
    status: 'measured',
    realizedTokens: realized,
    realizedCostUSD,
    confidence: confidenceFor(sessions.length, baseline, afterStart, now),
    note: `read:edit ${ratioThen.toFixed(1)}:1 -> ${ratioNow.toFixed(1)}:1`,
  }
}

async function guardRow(
  base: ActReportRow, afterStart: Date, now: Date,
  baseline: ActionBaseline, opts: ActReportOptions,
): Promise<ActReportRow> {
  const abandonedThen = baseline.metrics['abandonedPct']
  const avgThen = baseline.metrics['avgSessionCostUSD']
  if (abandonedThen === undefined || avgThen === undefined) {
    return { ...base, note: 'not measurable: no yield baseline captured at install time' }
  }
  const yieldFn = opts.computeYield ?? ((range: DateRange) => computeYield(range, opts.cwd ?? process.cwd()))
  let summary: YieldSummary
  try {
    summary = await yieldFn({ start: afterStart, end: now })
  } catch {
    return { ...base, note: 'not measurable: yield could not be computed for the post-apply window' }
  }
  const abandonedNow = summary.total.cost > 0 ? Math.round((summary.abandoned.cost / summary.total.cost) * 100) : 0
  const avgNow = summary.total.sessions > 0 ? summary.total.cost / summary.total.sessions : 0
  return {
    ...base,
    status: 'measured',
    confidence: summary.total.sessions < MIN_POST_WINDOW_SESSIONS ? 'low' : 'normal',
    note: 'correlation, not attribution',
    correlation: {
      abandonedPctThen: abandonedThen,
      abandonedPctNow: abandonedNow,
      avgSessionCostThenUSD: avgThen,
      avgSessionCostNowUSD: avgNow,
    },
  }
}

async function modelDefaultRow(
  base: ActReportRow, rec: ActionRecord, sessions: SessionSummary[],
  baseline: ActionBaseline, afterStart: Date, now: Date, projectFound: boolean,
): Promise<ActReportRow> {
  if (!projectFound) {
    return { ...base, note: 'not measurable: project not found in current data (path may have changed)' }
  }
  const models = Object.keys(baseline.metrics)
  if (models.length < 2) return { ...base, note: 'not measurable: invalid baseline' }
  const candidateModel = baseline.candidateModel ?? models[0]!
  const preApplyRate = baseline.metrics[candidateModel]
  if (preApplyRate === undefined) return { ...base, note: 'not measurable: invalid baseline' }
  
  const mockProject: ProjectSummary = {
    project: 'mock',
    projectPath: 'mock',
    totalCostUSD: 0,
    totalSavingsUSD: 0,
    totalApiCalls: 0,
    totalProxiedCostUSD: 0,
    sessions,
  }
  
  const { aggregateModelStats } = await import('../compare-stats.js')
  const stats = aggregateModelStats([mockProject]).find(s => s.model === candidateModel)
  
  if (!stats || stats.editTurns < 20) {
    return { ...base, note: `not measurable: < 20 edit turns for ${candidateModel} since apply` }
  }
  
  const postApplyRate = stats.oneShotTurns / stats.editTurns
  
  if (postApplyRate < preApplyRate - 0.05) {
    return {
      ...base,
      status: 'measured',
      realizedTokens: 0,
      confidence: 'low',
      note: `quality regression, consider undo: one-shot rate ${(preApplyRate * 100).toFixed(1)}% -> ${(postApplyRate * 100).toFixed(1)}%`
    }
  }

  return {
    ...base,
    status: 'measured',
    realizedTokens: 0,
    confidence: confidenceFor(sessions.length, baseline, afterStart, now),
    note: `correlation, not attribution: one-shot rate ${(preApplyRate * 100).toFixed(1)}% -> ${(postApplyRate * 100).toFixed(1)}%`
  }
}

async function computeRow(
  rec: ActionRecord, sessions: SessionSummary[], afterStart: Date, now: Date,
  mcpClaimedServers: ReadonlySet<string>, pricing: FindingPricing, opts: ActReportOptions, modelDefaultProjectFound = true,
): Promise<ActReportRow> {
  const estimatedAtApply = rec.baseline?.estimatedTokens ?? 0
  const base: ActReportRow = {
    id: rec.id,
    appliedAt: rec.at,
    date: rec.at.slice(0, 10),
    kind: rec.kind,
    description: rec.description,
    estimatedAtApply,
    estimatedForWindow: estimatedAtApply,
    realizedTokens: 0,
    realizedCostUSD: 0,
    status: 'not-measurable',
    confidence: 'normal',
    note: '',
  }
  const baseline = rec.baseline
  if (!baseline) return { ...base, note: 'not measurable: no baseline captured at apply time' }

  if (MCP_KINDS.has(rec.kind)) return mcpRow(base, rec, sessions, baseline, afterStart, now, pricing)
  if (DEFER_KINDS.has(rec.kind)) return deferRow(base, rec, sessions, baseline, afterStart, now, mcpClaimedServers, pricing)
  if (rec.kind in ARCHIVE_DEF_TOKENS) return archiveRow(base, rec, sessions, baseline, afterStart, now, pricing)
  if (rec.kind === 'claude-md-rule') return readEditRow(base, rec, sessions, baseline, afterStart, now, pricing)
  if (rec.kind === 'shell-config') return { ...base, note: 'not measurable: bash result token sizes are not retained in the summary' }
  if (rec.kind === 'guard-install') return guardRow(base, afterStart, now, baseline, opts)
  if (rec.kind === 'model-default') return modelDefaultRow(base, rec, sessions, baseline, afterStart, now, modelDefaultProjectFound)
  return { ...base, note: 'not measurable: kind is not tracked by act report' }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

// A journal line can be any JSON; only records with a parseable `at` date and
// a string status can be dated and filtered. Anything else is skipped and
// counted, so a corrupt journal can never crash `act report` or optimize.
function isSaneRecord(r: ActionRecord): boolean {
  return typeof r.at === 'string' && typeof r.status === 'string' && !Number.isNaN(new Date(r.at).getTime())
}

// Turn the measured rows plus the still-young entries into one verdict per
// active applied action. No second reconciliation: everything measurable comes
// straight off the row `act report` already computed.
function buildAppliedFixes(active: ActionRecord[], rows: ActReportRow[], now: Date): AppliedFix[] {
  const byId = new Map(rows.map(r => [r.id, r]))
  return active.map(rec => {
    const row = byId.get(rec.id)
    const base = {
      id: rec.id,
      kind: rec.kind,
      findingId: rec.findingId ?? null,
      appliedAt: rec.at,
      ageDays: ageDays(rec.at, now),
      undoCommand: `codeburn act undo ${shortId(rec.id)}`,
    }
    // No row means too young to measure; a row that is not a measured token
    // row (not-measurable, not yet in effect, reverted by the user, or a
    // correlation-only kind) has no reduction to judge either.
    if (!row) return { ...base, verdict: 'pending' as const, estimatedTokens: rec.baseline?.estimatedTokens ?? 0, realizedTokens: 0, note: '' }
    if (row.status !== 'measured' || !isTokenKind(row.kind)) {
      return { ...base, verdict: 'pending' as const, estimatedTokens: row.estimatedForWindow, realizedTokens: 0, note: row.note }
    }
    const estimatedTokens = row.estimatedForWindow
    const realizedTokens = row.realizedTokens
    const verdict: AppliedVerdict = realizedTokens <= 0
      ? 'no-effect'
      : estimatedTokens <= 0 || realizedTokens >= estimatedTokens * VERDICT_WORKED_RATIO ? 'worked' : 'partial'
    return { ...base, verdict, estimatedTokens, realizedTokens, note: row.note }
  })
}

// --auto-revert: undo the fixes that measured no reduction at all. CLAUDE.md
// rules are never undone unattended, matching the --yes guardrail - the file
// belongs to whatever project the user happened to be in.
export async function autoRevertNoEffect(
  fixes: AppliedFix[], opts: { actionsDir?: string } = {},
): Promise<{ lines: string[]; revertedIds: Set<string> }> {
  const lines: string[] = []
  const revertedIds = new Set<string>()
  for (const fix of fixes) {
    if (fix.verdict !== 'no-effect') continue
    const label = fix.findingId ?? fix.kind
    if (fix.kind === 'claude-md-rule') {
      lines.push(`Not auto-reverted: ${label} edits a CLAUDE.md. Revert: ${fix.undoCommand}`)
      continue
    }
    try {
      const record = await undoAction({ id: fix.id }, { actionsDir: opts.actionsDir })
      revertedIds.add(fix.id)
      lines.push(`Reverted ${shortId(record.id)}: ${record.description}`)
    } catch (err) {
      lines.push(`Could not revert ${label}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { lines, revertedIds }
}

export async function computeActReport(opts: ActReportOptions = {}): Promise<ActReport> {
  const now = opts.now ?? new Date()
  const rawRecords = await readRecords(opts.actionsDir ?? defaultActionsDir())
  const records = rawRecords.filter(isSaneRecord)
  const malformedRecords = rawRecords.length - records.length
  const active = records.filter(r => r.status === 'applied')

  const appliedByFinding: Record<string, string> = {}
  for (const r of active) {
    if (!r.findingId) continue
    const date = r.at.slice(0, 10)
    const prev = appliedByFinding[r.findingId]
    if (!prev || date < prev) appliedByFinding[r.findingId] = date
  }

  const empty: ActReport = {
    generatedAt: now.toISOString(),
    windowCapDays: WINDOW_CAP_DAYS,
    costRate: 0,
    rows: [],
    totalRealizedTokens: 0,
    totalRealizedCostUSD: 0,
    measuredCount: 0,
    activeCount: active.length,
    observedDays: 0,
    malformedRecords,
    appliedByFinding,
    appliedFixes: buildAppliedFixes(active, [], now),
  }

  const eligible = active.filter(r => ageDays(r.at, now) > REPORT_MIN_AGE_DAYS)
  if (eligible.length === 0) return empty

  const windowStart = new Date(now.getTime() - WINDOW_CAP_DAYS * DAY_MS)
  const loadProjects = opts.loadProjects ?? ((range: DateRange) => parseAllSessions(range, 'claude'))
  const projects = await loadProjects({ start: windowStart, end: now })
  const costRate = computeInputCostRate(projects)
  const pricing = findingPricing(projects, costRate)

  // Servers a same-journal MCP row (mcp-remove / mcp-project-scope) already
  // measures. Deferral baselines for defer-enable / defer-threshold span the
  // whole observed MCP surface, so without this exclusion a defer row and an
  // MCP row would both claim the same server's schema tokens over the same
  // post-apply sessions, inflating totalRealizedTokens. Conservative by
  // design: the defer row drops the server for its whole window even though
  // pre-removal sessions were legitimately its own - under-claiming keeps the
  // footer's "each fix measures only its own metric" literally true.
  const mcpClaimedServers = new Set<string>()
  for (const r of active) {
    if (!MCP_KINDS.has(r.kind) || !r.baseline) continue
    for (const server of Object.keys(r.baseline.metrics)) mcpClaimedServers.add(server)
  }

  const rows: ActReportRow[] = []
  for (const rec of eligible) {
    const afterStart = new Date(Math.max(new Date(rec.at).getTime(), windowStart.getTime()))
    const modelDefaultWindow = rec.kind === 'model-default'
      ? modelDefaultSessionsInWindow(rec, projects, afterStart, now)
      : undefined
    const sessions = modelDefaultWindow?.sessions ?? sessionsInWindow(projects, afterStart, now)
    rows.push(await computeRow(rec, sessions, afterStart, now, mcpClaimedServers, pricing, opts, modelDefaultWindow?.projectFound))
  }

  const measuredRows = rows.filter(r => r.status === 'measured' && isTokenKind(r.kind))
  const totalRealizedTokens = measuredRows.reduce((s, r) => s + r.realizedTokens, 0)
  const observedDays = Math.min(
    WINDOW_CAP_DAYS,
    measuredRows.reduce((mx, r) => Math.max(mx, Math.ceil(ageDays(r.appliedAt, now))), 0),
  )

  return {
    generatedAt: now.toISOString(),
    windowCapDays: WINDOW_CAP_DAYS,
    costRate,
    rows,
    totalRealizedTokens,
    totalRealizedCostUSD: measuredRows.reduce((s, r) => s + r.realizedCostUSD, 0),
    measuredCount: measuredRows.length,
    activeCount: active.length,
    observedDays,
    malformedRecords,
    appliedByFinding,
    appliedFixes: buildAppliedFixes(active, rows, now),
  }
}

export function buildOptimizeAppliedHeader(report: ActReport): string | null {
  // Under-claim: only normal-confidence measured rows feed the optimize line.
  // Low-confidence rows stay visible in `act report` but never in the header.
  const confident = report.rows.filter(r => r.status === 'measured' && isTokenKind(r.kind) && r.confidence === 'normal')
  if (confident.length === 0) return null
  const tokens = confident.reduce((s, r) => s + r.realizedTokens, 0)
  const generated = new Date(report.generatedAt)
  const days = Math.min(
    report.windowCapDays,
    confident.reduce((mx, r) => Math.max(mx, Math.ceil(ageDays(r.appliedAt, generated))), 0),
  )
  const usd = confident.reduce((s, r) => s + r.realizedCostUSD, 0)
  const cost = report.costRate > 0 ? ` (~${formatCost(usd)})` : ''
  return `Applied fixes: ${report.activeCount} active, realized ~${formatTokens(tokens)} tokens${cost} over ${days} day${days === 1 ? '' : 's'}. Details: codeburn act report`
}

function realizedCell(r: ActReportRow): string {
  if (r.status === 'reverted') return 'reverted'
  if (r.status === 'pending') return 'not yet in effect'
  if (r.status === 'not-measurable') return 'not measurable'
  if (r.correlation) return `abandoned ${r.correlation.abandonedPctThen}% -> ${r.correlation.abandonedPctNow}% (corr.)`
  if (r.kind === 'model-default') return 'correlation'
  return formatTokens(r.realizedTokens)
}

function malformedNote(n: number): string {
  return `${n} malformed record${n === 1 ? '' : 's'} skipped`
}

export function renderActReport(report: ActReport): string {
  if (report.rows.length === 0) {
    const lines = ['', '  No applied actions to measure yet.']
    if (report.activeCount > 0) {
      lines.push(`  ${report.activeCount} action${report.activeCount === 1 ? '' : 's'} applied; measurement starts after ${REPORT_MIN_AGE_DAYS} days.`)
    } else {
      lines.push('  Apply fixes with codeburn optimize --apply, then check back after a few days.')
    }
    if (report.malformedRecords > 0) lines.push(`  ${malformedNote(report.malformedRecords)}.`)
    lines.push('')
    return lines.join('\n')
  }

  const rows = report.rows.map(r => [
    r.date,
    r.description,
    r.estimatedForWindow > 0 ? formatTokens(r.estimatedForWindow) : '-',
    realizedCell(r),
    r.status === 'measured' && isTokenKind(r.kind) ? r.confidence : '-',
  ])
  const totalCost = report.costRate > 0 ? ` (~${formatCost(report.totalRealizedCostUSD)})` : ''
  rows.push(['', 'Total realized', '', `${formatTokens(report.totalRealizedTokens)}${totalCost}`, ''])

  const table = renderTable(
    [{ header: 'Applied' }, { header: 'Action' }, { header: 'Estimated', right: true }, { header: 'Realized', right: true }, { header: 'Confidence' }],
    rows,
    { boldRows: new Set([rows.length - 1]) },
  )

  const details: string[] = []
  for (const r of report.rows) {
    if (r.status === 'measured' && isTokenKind(r.kind)) continue
    if (r.note) details.push(`  ${r.date} ${r.kind}: ${r.note}`)
    if (r.correlation) {
      details.push(`     avg session cost ${formatCost(r.correlation.avgSessionCostThenUSD)} -> ${formatCost(r.correlation.avgSessionCostNowUSD)}`)
    }
  }
  if (report.malformedRecords > 0) details.push(`  ${malformedNote(report.malformedRecords)}`)

  return ['', table, ...(details.length > 0 ? ['', ...details] : []), '', '  ' + HONEST_FOOTER, ''].join('\n')
}

export function buildActReportJson(report: ActReport): unknown {
  return {
    generatedAt: report.generatedAt,
    windowCapDays: report.windowCapDays,
    malformedRecords: report.malformedRecords,
    actions: report.rows.map(r => {
      const tokenMeasured = r.status === 'measured' && isTokenKind(r.kind)
      return {
        id: r.id,
        date: r.date,
        kind: r.kind,
        description: r.description,
        estimatedAtApply: r.estimatedAtApply,
        estimatedForWindow: r.estimatedForWindow,
        realizedTokens: tokenMeasured ? r.realizedTokens : null,
        status: r.status,
        confidence: tokenMeasured ? r.confidence : null,
        note: r.note,
        ...(r.correlation ? { correlation: r.correlation } : {}),
      }
    }),
    totals: {
      realizedTokens: report.totalRealizedTokens,
      realizedCostUSD: report.totalRealizedCostUSD,
      measuredActions: report.measuredCount,
      activeActions: report.activeCount,
      observedDays: report.observedDays,
    },
    appliedFixes: report.appliedFixes,
    footer: HONEST_FOOTER,
  }
}

// ---------------------------------------------------------------------------
// Baseline capture (apply time)
// ---------------------------------------------------------------------------

type CaptureCtx = {
  projects: ProjectSummary[]
  coverage: McpServerCoverage[]
  windowDays: number
  now: Date
}

function mcpServersFromApply(finding: WasteFinding, affectedMcpServers?: string[]): string[] {
  if (affectedMcpServers) return affectedMcpServers
  if (finding.apply?.kind === 'mcp-remove') return finding.apply.servers
  if (finding.apply?.kind === 'mcp-project-scope') return finding.apply.servers.map(s => s.server)
  return []
}

function needsConfigBaseline(kind: ActionKind): boolean {
  return MCP_KINDS.has(kind) || DEFER_KINDS.has(kind) || kind in ARCHIVE_DEF_TOKENS || kind === 'claude-md-rule' || kind === 'shell-config'
}

// Servers whose upfront schema deferral removes from the prefix. defer-alwaysload
// names them; defer-enable / defer-threshold re-enable deferral across the whole
// observed MCP surface.
function deferServers(finding: WasteFinding, ctx: CaptureCtx): string[] {
  if (finding.apply?.kind === 'defer-alwaysload') return finding.apply.servers.map(s => s.server)
  return observedMcpServers(ctx.projects)
}

export function captureBaseline(
  finding: WasteFinding,
  kind: ActionKind,
  ctx: CaptureCtx,
  affectedMcpServers?: string[],
): ActionBaseline | undefined {
  const common = {
    windowDays: ctx.windowDays,
    capturedAt: ctx.now.toISOString(),
    estimatedTokens: Math.max(0, Math.round(finding.applyTokensSaved ?? finding.tokensSaved)),
  }

  if (MCP_KINDS.has(kind)) {
    const servers = mcpServersFromApply(finding, affectedMcpServers)
    if (servers.length === 0) return undefined
    const covByServer = new Map(ctx.coverage.map(c => [c.server, c]))
    // Removal and scoping realize only the schema their detector estimated,
    // counted the way it counts it. If coverage is unavailable, that is 0
    // rather than an invented five-tool baseline.
    const metrics: Record<string, number> = finding.id === 'mcp-low-coverage'
      ? mcpLowCoverageSchemaPerSession(ctx.projects, ctx.coverage, servers)
      : finding.apply?.kind === 'mcp-project-scope'
        ? mcpProjectScopeSchemaPerSession(ctx.projects, ctx.coverage, finding.apply.servers.filter(s => servers.includes(s.server)))
        : Object.fromEntries(servers.map(server => {
          const cov = covByServer.get(server)
          return [server, (cov && cov.toolsAvailable > 0 ? cov.toolsAvailable : TOOLS_PER_MCP_SERVER) * TOKENS_PER_MCP_TOOL]
        }))
    const estimatedTokens = finding.applyTokensSavedByServer
      ? Math.round(servers.reduce((sum, server) => sum + (finding.applyTokensSavedByServer?.[server] ?? 0), 0))
      : common.estimatedTokens
    return { ...common, estimatedTokens, sessions: countSessionsLoading(ctx.projects, servers), metrics }
  }

  if (DEFER_KINDS.has(kind)) {
    const servers = deferServers(finding, ctx)
    if (servers.length === 0) return undefined
    const covByServer = new Map(ctx.coverage.map(c => [c.server, c]))
    const metrics: Record<string, number> = {}
    for (const server of servers) {
      const cov = covByServer.get(server)
      const tools = cov && cov.toolsAvailable > 0 ? cov.toolsAvailable : TOOLS_PER_MCP_SERVER
      metrics[server] = tools * TOKENS_PER_MCP_TOOL
    }
    return { ...common, sessions: countSessionsLoading(ctx.projects, servers), metrics }
  }

  const defTokens = ARCHIVE_DEF_TOKENS[kind]
  if (defTokens !== undefined) {
    const names = finding.apply?.kind === 'archive' ? finding.apply.names : []
    if (names.length === 0) return undefined
    const metrics: Record<string, number> = {}
    for (const name of names) metrics[name] = defTokens
    return { ...common, sessions: allSessions(ctx.projects).length, metrics }
  }

  const sessions = allSessions(ctx.projects)
  if (kind === 'claude-md-rule') {
    return { ...common, sessions: sessions.length, metrics: { reads: countToolCalls(sessions, READ_TOOL_NAMES), edits: countToolCalls(sessions, EDIT_TOOL_NAMES) } }
  }
  if (kind === 'shell-config') {
    return { ...common, sessions: sessions.length, metrics: { calls: countBashCalls(sessions) } }
  }
  return undefined
}

// Scan the trailing 14 days once and stamp a baseline onto every appliable
// plan that carries one, so runAction persists it for `act report` to diff.
export async function captureBaselinesForPlans(
  plans: FindingPlan[],
  opts: { now?: Date; loadProjects?: (range: DateRange) => Promise<ProjectSummary[]> } = {},
): Promise<void> {
  const applicable = plans.filter(fp => fp.plan && needsConfigBaseline(fp.plan.kind))
  if (applicable.length === 0) return
  const now = opts.now ?? new Date()
  const start = new Date(now.getTime() - BASELINE_WINDOW_DAYS * DAY_MS)
  const loadProjects = opts.loadProjects ?? ((range: DateRange) => parseAllSessions(range, 'claude'))
  const projects = await loadProjects({ start, end: now })
  const ctx: CaptureCtx = { projects, coverage: aggregateMcpCoverage(projects), windowDays: BASELINE_WINDOW_DAYS, now }
  for (const fp of applicable) {
    if (fp.plan!.mcpSavingsUncertain) continue
    const baseline = captureBaseline(fp.finding, fp.plan!.kind, ctx, fp.plan!.affectedMcpServers)
    if (baseline) fp.plan!.baseline = baseline
  }
}

export async function captureGuardBaseline(
  opts: { now?: Date; cwd?: string; computeYield?: (range: DateRange) => Promise<YieldSummary> } = {},
): Promise<ActionBaseline | undefined> {
  const now = opts.now ?? new Date()
  const range = { start: new Date(now.getTime() - BASELINE_WINDOW_DAYS * DAY_MS), end: now }
  const yieldFn = opts.computeYield ?? ((r: DateRange) => computeYield(r, opts.cwd ?? process.cwd()))
  let summary: YieldSummary
  try {
    summary = await yieldFn(range)
  } catch {
    return undefined
  }
  return {
    windowDays: BASELINE_WINDOW_DAYS,
    capturedAt: now.toISOString(),
    estimatedTokens: 0,
    sessions: summary.total.sessions,
    metrics: {
      abandonedPct: summary.total.cost > 0 ? Math.round((summary.abandoned.cost / summary.total.cost) * 100) : 0,
      avgSessionCostUSD: summary.total.sessions > 0 ? summary.total.cost / summary.total.sessions : 0,
    },
  }
}

import { readPlan, type Plan } from './config.js'
import { parseAllSessions } from './parser.js'
import type { DateRange, ProjectSummary } from './types.js'

const MS_PER_DAY = 24 * 60 * 60 * 1000
const PLAN_NEAR_THRESHOLD_PCT = 80

export type PlanStatus = 'under' | 'near' | 'over'

export type PlanUsage = {
  plan: Plan
  periodStart: Date
  periodEnd: Date
  spentApiEquivalentUsd: number
  budgetUsd: number
  percentUsed: number
  status: PlanStatus
  projectedMonthUsd: number
  daysUntilReset: number
}

export function clampResetDay(resetDay: number | undefined): number {
  if (!Number.isInteger(resetDay)) return 1
  return Math.min(28, Math.max(1, resetDay ?? 1))
}

export function computePeriodFromResetDay(resetDay: number | undefined, today: Date): { periodStart: Date; periodEnd: Date } {
  const day = clampResetDay(resetDay)
  const year = today.getFullYear()
  const month = today.getMonth()

  if (today.getDate() >= day) {
    return {
      periodStart: new Date(year, month, day, 0, 0, 0, 0),
      periodEnd: new Date(year, month + 1, day, 0, 0, 0, 0),
    }
  }

  return {
    periodStart: new Date(year, month - 1, day, 0, 0, 0, 0),
    periodEnd: new Date(year, month, day, 0, 0, 0, 0),
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2
  }
  return sorted[mid]!
}

function toLocalDateKey(d: Date): string {
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function toDayIndex(d: Date): number {
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / MS_PER_DAY)
}

function diffCalendarDays(from: Date, to: Date): number {
  return toDayIndex(to) - toDayIndex(from)
}

export function projectMonthEnd(
  projects: ProjectSummary[],
  periodStart: Date,
  periodEnd: Date,
  today: Date,
  spent: number,
): number {
  const dayCosts = new Map<string, number>()

  for (const project of projects) {
    for (const session of project.sessions) {
      for (const turn of session.turns) {
        if (!turn.timestamp) continue
        const ts = new Date(turn.timestamp)
        if (Number.isNaN(ts.getTime())) continue
        if (ts < periodStart || ts > today) continue
        const dayKey = toLocalDateKey(ts)
        const turnCost = turn.assistantCalls.reduce((sum, call) => sum + call.costUSD, 0)
        dayCosts.set(dayKey, (dayCosts.get(dayKey) ?? 0) + turnCost)
      }
    }
  }

  const elapsedDays = Math.max(1, diffCalendarDays(periodStart, today) + 1)
  const elapsedDailyCosts: number[] = []
  for (let i = 0; i < elapsedDays; i++) {
    const date = new Date(periodStart.getFullYear(), periodStart.getMonth(), periodStart.getDate() + i)
    elapsedDailyCosts.push(dayCosts.get(toLocalDateKey(date)) ?? 0)
  }

  const trailingWindow = elapsedDailyCosts.slice(-7)
  const medianDailyCost = median(trailingWindow)
  const daysRemaining = Math.max(0, diffCalendarDays(today, periodEnd) - 1)

  return spent + medianDailyCost * daysRemaining
}

export function getPlanUsageFromProjects(plan: Plan, projects: ProjectSummary[], today = new Date()): PlanUsage {
  const { periodStart, periodEnd } = computePeriodFromResetDay(plan.resetDay, today)
  const spent = projects.reduce((sum, p) => sum + p.totalCostUSD, 0)
  const budgetUsd = plan.monthlyUsd
  const percentUsed = budgetUsd > 0 ? (spent / budgetUsd) * 100 : 0
  const status: PlanStatus = percentUsed > 100 ? 'over' : percentUsed >= PLAN_NEAR_THRESHOLD_PCT ? 'near' : 'under'
  const projectedMonthUsd = projectMonthEnd(projects, periodStart, periodEnd, today, spent)
  const daysUntilReset = Math.max(0, diffCalendarDays(today, periodEnd))

  return {
    plan,
    periodStart,
    periodEnd,
    spentApiEquivalentUsd: spent,
    budgetUsd,
    percentUsed,
    status,
    projectedMonthUsd,
    daysUntilReset,
  }
}

export async function getPlanUsage(plan: Plan, today = new Date()): Promise<PlanUsage> {
  const { periodStart } = computePeriodFromResetDay(plan.resetDay, today)
  const range: DateRange = {
    start: periodStart,
    end: today,
  }
  const provider = plan.provider === 'all' ? 'all' : plan.provider
  const projects = await parseAllSessions(range, provider)
  return getPlanUsageFromProjects(plan, projects, today)
}

export async function getPlanUsageOrNull(today = new Date()): Promise<PlanUsage | null> {
  const plan = await readPlan()
  if (!isActivePlan(plan)) return null
  return getPlanUsage(plan, today)
}

export function isActivePlan(plan: Plan | undefined): plan is Plan {
  return plan !== undefined && plan.id !== 'none' && Number.isFinite(plan.monthlyUsd) && plan.monthlyUsd > 0
}

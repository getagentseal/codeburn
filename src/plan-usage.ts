import { behavioralCallCount } from './behavioral-weight.js'
import { readPlans, type Plan, type PlanMap } from './config.js'
import { AI_CREDIT_USD, creditsToUsd, isFiniteNanoAiu, nanoAiuToCredits } from './copilot-aiu.js'
import { parseAllSessions } from './parser.js'
import { PLAN_PROVIDERS } from './plans.js'
import type { DateRange, ParsedApiCall, ProjectSummary } from './types.js'

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
  // Copilot credit-plan fields. Absent on Claude / cursor / grok / custom-USD.
  spentCredits?: number
  budgetCredits?: number
  creditsIncomplete?: boolean
  /// spentCredits plus a token-priced estimate for the requests GitHub never
  /// gave an exact figure for. Equals spentCredits when creditUnratedCalls is 0.
  estimatedCredits?: number
  creditRatedCalls?: number
  creditUnratedCalls?: number
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

export function isCopilotCreditsPlan(plan: Plan): boolean {
  return plan.provider === 'copilot'
}

function planCallSpend(plan: Plan, call: { costUSD: number; nanoAiu?: number }): number {
  if (!isCopilotCreditsPlan(plan)) return call.costUSD
  return isFiniteNanoAiu(call.nanoAiu) ? creditsToUsd(nanoAiuToCredits(call.nanoAiu)) : 0
}

function forEachPlanSession(projects: ProjectSummary[], visit: (calls: ParsedApiCall[]) => void): void {
  for (const project of projects) {
    for (const session of project.sessions ?? []) {
      const calls: ParsedApiCall[] = []
      for (const turn of session.turns ?? []) {
        calls.push(...(turn.assistantCalls ?? []))
      }
      visit(calls)
    }
  }
}

export type CopilotCreditSpend = {
  spentCredits: number
  estimatedCredits: number
  creditRatedCalls: number
  creditUnratedCalls: number
  creditsIncomplete: boolean
}

export function copilotCreditSpend(projects: ProjectSummary[]): CopilotCreditSpend {
  let nanoSum = 0
  let estimatedUsd = 0
  let ratedCalls = 0
  let unratedCalls = 0
  // Pairing is session-wide. foldCopilotSupplementaryTurns will not fold a
  // supplementary twin across a local-day boundary, so both nanoAiu rows can
  // occupy separate turns of the same session. Close the twin once here.
  forEachPlanSession(projects, calls => {
    const copilot = calls.filter(call => call.provider === 'copilot')
    if (copilot.length === 0) return
    const primaryNano = copilot.filter(call => !call.supplementaryAccounting && isFiniteNanoAiu(call.nanoAiu))
    const suppNano = copilot.filter(call => call.supplementaryAccounting && isFiniteNanoAiu(call.nanoAiu))
    // Store rows are the bill whether paired (supplementary) or not. A rollup
    // is counted only when nothing behavioral carries nanoAiu, so a paired
    // rollup cannot double the credits.
    const counted = primaryNano.length > 0
      ? [...primaryNano, ...suppNano.filter(call => call.deduplicationKey.startsWith('copilot-store:'))]
      : suppNano
    for (const call of counted) nanoSum += call.nanoAiu!
    const unrated = copilot.filter(call => !isFiniteNanoAiu(call.nanoAiu))
    // Requests, not calls: a store row and its per-turn twin, or a rollup, are
    // one request or none. A session with an exact figure is billed whole.
    const requests = behavioralCallCount(copilot)
    if (primaryNano.length > 0 || suppNano.length > 0) ratedCalls += requests
    else unratedCalls += requests
    // A rated row's total_nano_aiu is the whole request's bill, twin tokens
    // included, so a session that carries any exact figure gets no estimate
    // stacked on top of it. Everything else is priced from tokens at listed
    // API rates. GitHub bills credits as exactly that (list rate with the
    // cache-read/write split; request_multiplier is the legacy premium
    // request weight and does not touch credits), verified against real
    // session-store rows, so accuracy hinges on how completely the source
    // recorded tokens and their cache split.
    if (primaryNano.length === 0 && suppNano.length === 0) {
      for (const call of unrated) estimatedUsd += call.costUSD
    }
  })
  const spentCredits = nanoAiuToCredits(nanoSum)
  return {
    spentCredits,
    estimatedCredits: spentCredits + estimatedUsd / AI_CREDIT_USD,
    creditRatedCalls: ratedCalls,
    creditUnratedCalls: unratedCalls,
    creditsIncomplete: unratedCalls > 0,
  }
}

export function copilotCreditsNote(rated: number, unrated: number): string {
  if (rated === 0 && unrated === 0) return 'No Copilot requests in this period.'
  if (unrated === 0) {
    return `All ${rated} Copilot requests in this period carry GitHub's exact credit figure, so spentCredits is complete.`
  }
  return `${rated} of ${rated + unrated} Copilot requests carry GitHub's exact credit figure (only Copilot CLI and VS Code agent-host sessions record it). spentCredits counts only those; estimatedCredits adds the rest priced from tokens at listed API rates, which matched GitHub within about 15% on real Copilot CLI events; VS Code chat sessions record no cache split, so their estimate can land either side of the bill. percentUsed tracks estimatedCredits while any request is unrated.`
}

export function projectMonthEnd(
  projects: ProjectSummary[],
  periodStart: Date,
  periodEnd: Date,
  today: Date,
  spent: number,
  spendOf: (call: { costUSD: number; nanoAiu?: number }) => number = (call) => call.costUSD,
): number {
  const dayCosts = new Map<string, number>()

  for (const project of projects) {
    for (const session of project.sessions) {
      for (const turn of session.turns) {
        for (const call of turn.assistantCalls) {
          const timestamp = call.timestamp || turn.timestamp
          if (!timestamp) continue
          const ts = new Date(timestamp)
          if (Number.isNaN(ts.getTime())) continue
          if (ts < periodStart || ts > today) continue
          const dayKey = toLocalDateKey(ts)
          dayCosts.set(dayKey, (dayCosts.get(dayKey) ?? 0) + spendOf(call))
        }
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
  const budgetUsd = plan.monthlyUsd
  const daysUntilReset = Math.max(0, diffCalendarDays(today, periodEnd))

  if (isCopilotCreditsPlan(plan)) {
    const { spentCredits, estimatedCredits, creditRatedCalls, creditUnratedCalls, creditsIncomplete } = copilotCreditSpend(projects)
    const budgetCredits = plan.monthlyCredits ?? 0
    // The bar follows the estimate once any request lacks an exact figure:
    // a bar at 0% beside a 19k real bill is the misleading picture #1199
    // reported, and a labelled estimate beats a confidently wrong zero.
    const barCredits = creditUnratedCalls > 0 ? estimatedCredits : spentCredits
    const percentUsed = budgetCredits > 0 ? (barCredits / budgetCredits) * 100 : 0
    const spent = creditsToUsd(spentCredits)
    const status: PlanStatus = percentUsed > 100 ? 'over' : percentUsed >= PLAN_NEAR_THRESHOLD_PCT ? 'near' : 'under'
    const projectedMonthUsd = projectMonthEnd(projects, periodStart, periodEnd, today, spent, call => planCallSpend(plan, call))
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
      spentCredits,
      budgetCredits,
      creditsIncomplete,
      estimatedCredits,
      creditRatedCalls,
      creditUnratedCalls,
    }
  }

  const spent = projects.reduce((sum, p) => sum + p.totalCostUSD, 0)
  const percentUsed = budgetUsd > 0 ? (spent / budgetUsd) * 100 : 0
  const status: PlanStatus = percentUsed > 100 ? 'over' : percentUsed >= PLAN_NEAR_THRESHOLD_PCT ? 'near' : 'under'
  const projectedMonthUsd = projectMonthEnd(projects, periodStart, periodEnd, today, spent)

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

export function getPlanScopedProjects(plan: Plan, projects: ProjectSummary[], today: Date): ProjectSummary[] {
  const { periodStart } = computePeriodFromResetDay(plan.resetDay, today)
  const provider = plan.provider

  // These scoped clones are consumed only by plan usage math; cost/call rollups
  // are recomputed below, while unrelated breakdown fields remain unchanged.
  return projects
    .map(project => {
      const sessions = project.sessions
        .map(session => {
          const turns = session.turns
            .map(turn => {
              const assistantCalls = turn.assistantCalls.filter(call => {
                if (provider !== 'all' && call.provider !== provider) return false
                const timestamp = call.timestamp || turn.timestamp
                if (!timestamp) return false
                const ts = new Date(timestamp)
                return !Number.isNaN(ts.getTime()) && ts >= periodStart && ts <= today
              })
              return assistantCalls.length > 0 ? { ...turn, assistantCalls } : null
            })
            .filter((turn): turn is NonNullable<typeof turn> => turn !== null)

          const totalCostUSD = turns.reduce(
            (sum, turn) => sum + turn.assistantCalls.reduce((turnSum, call) => turnSum + call.costUSD, 0),
            0,
          )
          const hasNanoAiu = turns.some(turn => turn.assistantCalls.some(call => isFiniteNanoAiu(call.nanoAiu)))
          const apiCalls = turns.reduce((sum, turn) => sum + behavioralCallCount(turn.assistantCalls), 0)
          // Keep on cost as well as calls: a copilot rollup-only session has
          // zero behavioral calls but real spend, and dropping it would erase
          // that spend from the plan window. A store-row with nanoAiu and $0
          // token cost still has to reach credit math — but only on a copilot
          // credit plan. Claude/cursor/grok USD plans keep the old
          // cost-or-calls predicate so a $0 nanoAiu-only session is not an
          // unannounced retain on providers this PR is not about.
          const keepForCredits = isCopilotCreditsPlan(plan) && hasNanoAiu
          return apiCalls > 0 || totalCostUSD > 0 || keepForCredits ? { ...session, turns, totalCostUSD, apiCalls } : null
        })
        .filter((session): session is NonNullable<typeof session> => session !== null)

      const totalCostUSD = sessions.reduce((sum, session) => sum + session.totalCostUSD, 0)
      const totalApiCalls = sessions.reduce((sum, session) => sum + session.apiCalls, 0)
      return sessions.length > 0 ? { ...project, sessions, totalCostUSD, totalApiCalls } : null
    })
    .filter((project): project is NonNullable<typeof project> => project !== null)
}

export async function getPlanUsage(plan: Plan, today = new Date()): Promise<PlanUsage> {
  const { periodStart } = computePeriodFromResetDay(plan.resetDay, today)
  const range: DateRange = {
    start: periodStart,
    end: today,
  }
  const projects = await parseAllSessions(range, plan.provider)
  return getPlanUsageFromProjects(plan, projects, today)
}

export async function getPlanUsageOrNull(today = new Date()): Promise<PlanUsage | null> {
  return (await getPlanUsages(today))[0] ?? null
}

export function activePlansFromMap(plans: PlanMap): Plan[] {
  return PLAN_PROVIDERS
    .map(provider => plans[provider])
    .filter(isActivePlan)
}

export async function getPlanUsages(today = new Date()): Promise<PlanUsage[]> {
  const plans = activePlansFromMap(await readPlans())
  if (plans.length === 0) return []

  const starts = plans.map(plan => computePeriodFromResetDay(plan.resetDay, today).periodStart.getTime())
  const range: DateRange = {
    start: new Date(Math.min(...starts)),
    end: today,
  }

  if (plans.length === 1) {
    const plan = plans[0]!
    const projects = await parseAllSessions(range, plan.provider)
    return [getPlanUsageFromProjects(plan, projects, today)]
  }

  const projects = await parseAllSessions(range, 'all')

  return plans.map(plan => getPlanUsageFromProjects(plan, getPlanScopedProjects(plan, projects, today), today))
}

export function isActivePlan(plan: Plan | undefined): plan is Plan {
  return plan !== undefined && plan.id !== 'none' && Number.isFinite(plan.monthlyUsd) && plan.monthlyUsd > 0
}

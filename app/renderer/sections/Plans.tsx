import { CliErrorPanel } from '../components/CliErrorPanel'
import { Panel } from '../components/Panel'
import type { Section } from '../components/Sidebar'
import { usePolled } from '../hooks/usePolled'
import { formatUsd } from '../lib/format'
import { codeburn } from '../lib/ipc'
import type { JsonPlanSummary, Period, PlanId, PlanProvider, StatusJson } from '../lib/types'
import type { SettingsPane } from './Settings'

const PROVIDER_ORDER: PlanProvider[] = ['all', 'claude', 'codex', 'cursor', 'grok']
const MS_PER_DAY = 24 * 60 * 60 * 1000

const PLAN_NAMES: Record<PlanId, string> = {
  'claude-pro': 'Claude Pro',
  'claude-max': 'Claude Max',
  'claude-max-5x': 'Claude Max 5x',
  'cursor-pro': 'Cursor Pro',
  supergrok: 'SuperGrok',
  'supergrok-heavy': 'SuperGrok Heavy',
  custom: 'Custom plan',
  none: 'API usage',
}

function fmtPct(n: number): string {
  return Number.isInteger(n) ? `${n}%` : `${n.toFixed(1)}%`
}

function parseIsoDay(iso: string): number | null {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function cycleEndDate(plan: JsonPlanSummary): Date | null {
  const date = new Date(plan.periodEnd)
  if (Number.isNaN(date.getTime())) return null
  date.setDate(date.getDate() - 1)
  return date
}

function formatShortDate(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return 'unknown'
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(date)
}

function cycleLabels(plan: JsonPlanSummary | undefined): { caption: string; pop: string } | null {
  if (!plan) return null
  const startDay = parseIsoDay(plan.periodStart)
  const endDay = parseIsoDay(plan.periodEnd)
  const start = formatShortDate(plan.periodStart)
  const inclusiveEnd = cycleEndDate(plan)
  const end = inclusiveEnd ? formatShortDate(inclusiveEnd) : 'unknown'
  const pop = `Cycle: ${start} – ${end}`

  if (startDay === null || endDay === null) return { caption: `Cycle ${start} – ${end}`, pop }

  const totalDays = Math.max(1, Math.round((endDay - startDay) / MS_PER_DAY))
  const day = Math.min(totalDays, Math.max(1, totalDays - plan.daysUntilReset))
  return {
    caption: `Cycle ${start} – ${end} · day ${day} of ${totalDays}`,
    pop,
  }
}

function planSummaries(status: StatusJson): JsonPlanSummary[] {
  const plans = status.plans
  if (plans) {
    const ordered = PROVIDER_ORDER.flatMap(provider => {
      const plan = plans[provider]
      return plan ? [plan] : []
    })
    if (ordered.length > 0) return ordered
  }
  return status.plan ? [status.plan] : []
}

export function Plans({ period, refreshToken = 0, onNavigate }: { period: Period; refreshToken?: number; onNavigate?: (section: Section, pane?: SettingsPane) => void }) {
  const report = usePolled<StatusJson>(() => codeburn.getPlans(period), [period, refreshToken])
  const plans = report.data ? planSummaries(report.data) : []
  const cycle = cycleLabels(plans[0])

  return (
    <>
      <div className="bar">
        <div className="t">Plans</div>
        {cycle ? <span className="scope">{cycle.caption}</span> : <span className="scope">Cycle unavailable</span>}
        <div className="sp" />
        <span className="scope">{cycle ? cycle.pop : 'Cycle unavailable'}</span>
        <button type="button" className="btn btn-s" onClick={() => onNavigate?.('settings', 'plans')}>
          Add plan…
        </button>
      </div>
      <div className="body">{renderBody(report.data, report.error, plans)}</div>
    </>
  )
}

function renderBody(data: StatusJson | null, error: ReturnType<typeof usePolled<StatusJson>>['error'], plans: JsonPlanSummary[]) {
  if (!data) {
    if (error) return <CliErrorPanel error={error} subject="plan pacing" />
    return (
      <Panel title="Plans">
        <p style={{ color: 'var(--t3)', margin: 0, fontSize: 12 }}>Scanning plan usage…</p>
      </Panel>
    )
  }

  if (plans.length === 0) {
    return (
      <Panel title="No plans configured">
        <p style={{ color: 'var(--t3)', margin: 0, fontSize: 12 }}>
          Add a plan in the CLI settings to see budget pacing here.
        </p>
      </Panel>
    )
  }

  return plans.map(plan => <PlanPanel key={`${plan.provider}-${plan.id}`} plan={plan} />)
}

function PlanPanel({ plan }: { plan: JsonPlanSummary }) {
  const hasBudget = plan.budget > 0
  const displayPercent = Math.min(100, Math.max(0, plan.percentUsed))
  const over = plan.status === 'over' || plan.percentUsed > 100
  const trackClass = hasBudget ? (over ? 'over' : undefined) : 'mut'
  const overage = Math.max(0, plan.spent - plan.budget)
  const right = hasBudget
    ? `${formatUsd(plan.spent)} · ${fmtPct(plan.percentUsed)}${overage > 0 ? ` · ${formatUsd(overage)} over` : ''}`
    : `${formatUsd(plan.spent)} this cycle`
  const detail = hasBudget ? `${formatUsd(plan.budget)} / month · ${plan.provider}` : `${plan.provider} · pay as you go, no plan`

  return (
    <Panel>
      <div className="plrow">
        <b>{PLAN_NAMES[plan.id]}</b>
        <span>{detail}</span>
        <span className="r">{right}</span>
      </div>
      <div className="track" data-testid={`plan-track-${plan.provider}`}>
        <i className={trackClass} style={{ width: `${displayPercent}%` }} />
      </div>
      {hasBudget ? <PaceLine plan={plan} /> : null}
    </Panel>
  )
}

function PaceLine({ plan }: { plan: JsonPlanSummary }) {
  const end = cycleEndDate(plan)
  const endLabel = end ? formatShortDate(end) : 'unknown'
  if (plan.status === 'over' || plan.projectedMonthEnd > plan.budget) {
    return (
      <div className="pace hot">
        On pace to exceed; projected {formatUsd(plan.projectedMonthEnd)} by {endLabel}
      </div>
    )
  }
  if (plan.status === 'near') {
    return (
      <div className="pace hot">
        {fmtPct(plan.percentUsed)} of budget used; projected {formatUsd(plan.projectedMonthEnd)} by {endLabel}
      </div>
    )
  }
  return <div className="pace ok">On track</div>
}

import { Panel } from '../components/Panel'
import { usePolled } from '../hooks/usePolled'
import { codeburn } from '../lib/ipc'
import type { JsonPlanSummary, Period, PlanId, PlanProvider, StatusJson } from '../lib/types'

const PROVIDER_ORDER: PlanProvider[] = ['claude', 'codex', 'cursor', 'grok', 'all']
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

function fmtUsd(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtPct(n: number): string {
  return Number.isInteger(n) ? `${n}%` : `${n.toFixed(1)}%`
}

function parseIsoDay(iso: string): number | null {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

function formatShortDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'unknown'
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(date)
}

function cycleLabels(plan: JsonPlanSummary | undefined): { caption: string; pop: string } | null {
  if (!plan) return null
  const startDay = parseIsoDay(plan.periodStart)
  const endDay = parseIsoDay(plan.periodEnd)
  const start = formatShortDate(plan.periodStart)
  const end = formatShortDate(plan.periodEnd)
  const pop = `Cycle: ${start} - ${end}`

  if (startDay === null || endDay === null) return { caption: `Cycle ${start} - ${end}`, pop }

  const totalDays = Math.max(1, Math.round((endDay - startDay) / MS_PER_DAY) + 1)
  const day = Math.min(totalDays, Math.max(1, totalDays - plan.daysUntilReset))
  return {
    caption: `Cycle ${start} - ${end} · day ${day} of ${totalDays}`,
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

function isPermissionError(message: string): boolean {
  return /permission|full disk access|eacces/i.test(message)
}

export function Plans({ period }: { period: Period }) {
  const report = usePolled<StatusJson>(() => codeburn.getPlans(period), [period])
  const plans = report.data ? planSummaries(report.data) : []
  const cycle = cycleLabels(plans[0])

  return (
    <>
      <div className="bar">
        <div className="t">Plans</div>
        {cycle ? <span className="scope">{cycle.caption}</span> : <span className="scope">Cycle unavailable</span>}
        <div className="sp" />
        <div className="pop">{cycle ? cycle.pop : 'Cycle unavailable'}</div>
        <span className="btn btn-s" aria-disabled="true">
          Add plan…
        </span>
      </div>
      <div className="body">{renderBody(report.data, report.error, plans)}</div>
    </>
  )
}

function renderBody(data: StatusJson | null, error: ReturnType<typeof usePolled<StatusJson>>['error'], plans: JsonPlanSummary[]) {
  if (!data) {
    if (error?.kind === 'not-found') {
      return (
        <Panel title="Locate the codeburn CLI">
          <p style={{ color: 'var(--t2)', margin: '0 0 6px', fontSize: 12.5 }}>
            CodeBurn Desktop reads plan pacing by running the{' '}
            <code style={{ fontFamily: 'var(--mono)', color: 'var(--lav)' }}>codeburn</code> command, but it
            isn&apos;t on your PATH yet.
          </p>
          <p style={{ color: 'var(--t3)', margin: 0, fontSize: 11.5 }}>
            Install it with <code style={{ fontFamily: 'var(--mono)', color: 'var(--lav)' }}>npm i -g codeburn</code>,
            then reopen this window.
          </p>
        </Panel>
      )
    }
    if (error) {
      const permission = error.kind === 'nonzero' && isPermissionError(error.message)
      return (
        <Panel title={permission ? 'Permission denied' : "Couldn't read plans"}>
          <p style={{ color: permission ? 'var(--amber)' : 'var(--red)', margin: 0, fontSize: 12 }}>
            {permission ? 'Grant Full Disk Access, then refresh plan pacing.' : error.message}
          </p>
        </Panel>
      )
    }
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
    ? `${fmtUsd(plan.spent)} · ${fmtPct(plan.percentUsed)}${overage > 0 ? ` · ${fmtUsd(overage)} over` : ''}`
    : `${fmtUsd(plan.spent)} this cycle`
  const detail = hasBudget ? `${fmtUsd(plan.budget)} / month · ${plan.provider}` : `${plan.provider} · pay as you go, no plan`

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
  if (plan.status === 'over' || plan.status === 'near') {
    return (
      <div className="pace hot">
        On pace to exceed - projected {fmtUsd(plan.projectedMonthEnd)} by {formatShortDate(plan.periodEnd)}
      </div>
    )
  }
  return <div className="pace ok">On track</div>
}

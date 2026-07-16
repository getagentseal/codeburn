import { useRef, useState } from 'react'

import { CliErrorPanel } from '../components/CliErrorPanel'
import { ConnectAffordance } from '../components/ConnectAffordance'
import { Panel } from '../components/Panel'
import { SectionSkeleton } from '../components/Skeleton'
import type { Section } from '../components/Sidebar'
import { StaleBanner } from '../components/StaleBanner'
import { usePolled } from '../hooks/usePolled'
import { formatConverted } from '../lib/format'
import { codeburn } from '../lib/ipc'
import { motionClass } from '../lib/motion'
import type { JsonPlanSummary, Period, PlanId, PlanProvider, QuotaProvider, QuotaWindow, StatusJson } from '../lib/types'
import type { SettingsPane } from './Settings'

const PROVIDER_ORDER: PlanProvider[] = ['all', 'claude', 'codex', 'cursor', 'grok']

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

/** Honest copy for a 429 backoff window (the upstream quota endpoint rate
 *  limited us), replacing the generic "waiting" note. */
export function rateLimitedNote(provider: QuotaProvider['provider']): string {
  const owner = provider === 'claude' ? 'Anthropic' : 'OpenAI'
  return `${owner} rate limited the quota endpoint, retrying in a few minutes`
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

function manualPlanSummaries(status: StatusJson): JsonPlanSummary[] {
  return planSummaries(status).filter(plan => plan.provider !== 'claude' && plan.provider !== 'codex')
}

export function Plans({ period, refreshToken = 0, onNavigate, ready = true }: { period: Period; refreshToken?: number; onNavigate?: (section: Section, pane?: SettingsPane) => void; ready?: boolean }) {
  // Force a fresh fetch (bypassing QuotaService's 5-min cache, and its keychain
  // guard) when the user hits ⌘R or clicks Refresh in the Connect affordance;
  // the steady 30s poll keeps serving cached quota.
  const [reconnectNonce, setReconnectNonce] = useState(0)
  const lastForced = useRef(`${refreshToken}:${reconnectNonce}`)
  const quota = usePolled<QuotaProvider[]>(() => {
    const key = `${refreshToken}:${reconnectNonce}`
    const force = key !== lastForced.current
    lastForced.current = key
    return codeburn.getQuota(force)
  }, [refreshToken, reconnectNonce])
  const reconnect = () => setReconnectNonce(value => value + 1)
  const budgetReport = usePolled<StatusJson>(() => codeburn.getPlans(period), [period, refreshToken], { enabled: ready })
  const manualPlans = budgetReport.data ? manualPlanSummaries(budgetReport.data) : []

  return (
    <>
      <div className="bar">
        <div className="t">Plans</div>
        <div className="sp" />
        <button type="button" className="btn btn-s" onClick={() => onNavigate?.('settings', 'plans')}>
          Add plan…
        </button>
      </div>
      <div className={motionClass('body', 'section-fade')}>
        {budgetReport.data && budgetReport.error && <StaleBanner error={budgetReport.error} />}
        {renderQuota(quota.data, quota.error, reconnect)}
        {renderBudgetPlans(budgetReport.data, budgetReport.error, manualPlans)}
      </div>
    </>
  )
}

function renderQuota(data: QuotaProvider[] | null, error: ReturnType<typeof usePolled<QuotaProvider[]>>['error'], onReconnect: () => void) {
  if (!data) {
    if (error) {
      return (
        <Panel title="Live quota">
          <p className="quota-connection-note quota-terminal">Live quota is unavailable.</p>
        </Panel>
      )
    }
    return <SectionSkeleton label="Loading quota…" rows={3} />
  }

  if (data.length === 0) {
    return (
      <Panel title="Live quota">
        <p className="quota-connection-note">No quota providers available.</p>
      </Panel>
    )
  }

  return data.map(provider => <QuotaPanel key={provider.provider} quota={provider} onReconnect={onReconnect} />)
}

function renderBudgetPlans(data: StatusJson | null, error: ReturnType<typeof usePolled<StatusJson>>['error'], plans: JsonPlanSummary[]) {
  if (!data && error) {
    return (
      <section className="budget-plans">
        <h2 className="plans-section-heading">Budget plans</h2>
        <CliErrorPanel error={error} subject="plan pacing" />
      </section>
    )
  }
  if (plans.length === 0) return null

  return (
    <section className="budget-plans">
      <h2 className="plans-section-heading">Budget plans</h2>
      {plans.map(plan => <PlanPanel key={`${plan.provider}-${plan.id}`} plan={plan} />)}
    </section>
  )
}

function QuotaPanel({ quota, onReconnect }: { quota: QuotaProvider; onReconnect: () => void }) {
  const providerName = quota.provider === 'claude' ? 'Claude' : 'Codex'
  return (
    <Panel
      className="quota-card"
      title={<span className="quota-title">{providerName}{quota.planLabel ? <small>{quota.planLabel}</small> : null}</span>}
      right={<ConnectionIndicator connection={quota.connection} />}
    >
      <QuotaContent quota={quota} onReconnect={onReconnect} />
    </Panel>
  )
}

function ConnectionIndicator({ connection }: { connection: QuotaProvider['connection'] }) {
  const label = connection === 'transientFailure' ? 'waiting'
    : connection === 'terminalFailure' ? 'error'
    : connection === 'accessDenied' ? 'locked'
    : connection
  return <span className={`quota-connection quota-connection-${connection}`}><i />{label}</span>
}

function QuotaContent({ quota, onReconnect }: { quota: QuotaProvider; onReconnect: () => void }) {
  if (quota.connection === 'disconnected' || quota.connection === 'accessDenied') {
    return <ConnectAffordance provider={quota.provider} connection={quota.connection} onRefresh={onReconnect} />
  }
  if (quota.connection === 'loading') return <p className="quota-connection-note">Loading quota…</p>
  if (quota.connection === 'stale' || quota.connection === 'transientFailure') {
    if (quota.rateLimited) return <p className="quota-connection-note">{rateLimitedNote(quota.provider)}</p>
    return <p className="quota-connection-note">waiting on the CLI…</p>
  }
  if (quota.connection === 'terminalFailure') {
    return <p className="quota-connection-note quota-terminal">Quota is currently unavailable.</p>
  }

  return (
    <>
      <div className="quota-windows">
        {quota.details.map((window, index) => <QuotaMeter key={`${window.label}-${index}`} window={window} />)}
      </div>
      {quota.footerLines.length > 0 ? (
        <div className="quota-footer">{quota.footerLines.map((line, index) => <span key={`${line}-${index}`}>{line}</span>)}</div>
      ) : null}
    </>
  )
}

function QuotaMeter({ window }: { window: QuotaWindow }) {
  const percent = Math.round(window.percent * 100)
  const severity = window.percent >= 0.9 ? 'bad' : window.percent >= 0.7 ? 'warn' : 'accent'
  const reset = formatResetTime(window.resetsAt)
  return (
    <div className="quota-window">
      <div className="quota-window-labels">
        <span>{window.label}</span>
        <span>{percent}% used{reset ? ` · resets ${reset}` : ''}</span>
      </div>
      <div className="track" data-testid={`quota-track-${window.label}`}>
        <i className={severity} style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
      </div>
    </div>
  )
}

function formatResetTime(resetsAt: string | null): string | null {
  if (!resetsAt) return null
  const reset = Date.parse(resetsAt)
  if (!Number.isFinite(reset)) return null
  const remainingMinutes = Math.floor((reset - Date.now()) / 60_000)
  if (remainingMinutes <= 0) return 'now'
  const days = Math.floor(remainingMinutes / (24 * 60))
  const hours = Math.floor((remainingMinutes % (24 * 60)) / 60)
  const minutes = remainingMinutes % 60
  if (days > 0) return `in ${days}d${hours > 0 ? ` ${hours}h` : ''}`
  if (hours > 0) return `in ${hours}h${minutes > 0 ? ` ${minutes}m` : ''}`
  return `in ${minutes}m`
}

function PlanPanel({ plan }: { plan: JsonPlanSummary }) {
  const hasBudget = plan.budget > 0
  const displayPercent = Math.min(100, Math.max(0, plan.percentUsed))
  const over = plan.status === 'over' || plan.percentUsed > 100
  const trackClass = hasBudget ? (over ? 'over' : undefined) : 'mut'
  const overage = Math.max(0, plan.spent - plan.budget)
  const right = hasBudget
    ? `${formatConverted(plan.spent)} · ${fmtPct(plan.percentUsed)}${overage > 0 ? ` · ${formatConverted(overage)} over` : ''}`
    : `${formatConverted(plan.spent)} this cycle`
  const detail = hasBudget ? `${formatConverted(plan.budget)} / month · ${plan.provider}` : `${plan.provider} · pay as you go, no plan`

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
        On pace to exceed; projected {formatConverted(plan.projectedMonthEnd)} by {endLabel}
      </div>
    )
  }
  if (plan.status === 'near') {
    return (
      <div className="pace hot">
        {fmtPct(plan.percentUsed)} of budget used; projected {formatConverted(plan.projectedMonthEnd)} by {endLabel}
      </div>
    )
  }
  return <div className="pace ok">On track</div>
}

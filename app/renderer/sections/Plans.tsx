import { useRef, useState } from 'react'

import { CliErrorPanel } from '../components/CliErrorPanel'
import { ConnectAffordance } from '../components/ConnectAffordance'
import { Panel } from '../components/Panel'
import { ProviderLogo, hasProviderLogo } from '../components/ProviderLogo'
import { SectionSkeleton } from '../components/Skeleton'
import type { Section } from '../components/Sidebar'
import { StaleBanner } from '../components/StaleBanner'
import { BarNav } from '../components/TopBar'
import { usePolled } from '../hooks/usePolled'
import { localeTag, t } from '../i18n'
import { formatConverted } from '../lib/format'
import { codeburn } from '../lib/ipc'
import { motionClass } from '../lib/motion'
import { PROVIDER_NAMES, PROVIDER_OWNERS, readDisabledProviders } from '../lib/providers'
import { reportMemoKey } from '../lib/reportMemoKey'
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
  return t('plans.quota.rateLimited', { owner: PROVIDER_OWNERS[provider] })
}

function cycleEndDate(plan: JsonPlanSummary): Date | null {
  const date = new Date(plan.periodEnd)
  if (Number.isNaN(date.getTime())) return null
  date.setDate(date.getDate() - 1)
  return date
}

function formatShortDate(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return t('plans.date.unknown')
  return new Intl.DateTimeFormat(localeTag(), {
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

// A single anomalous poll must not flip a live provider to "disconnected". A
// slow/empty serve drops the provider from the array, and a cold or aborted
// read can momentarily report `disconnected`; either one, rendered verbatim,
// flickers a connected row to the Connect affordance and back. So we hold the
// last known status per provider and require `disconnected` to be reported this
// many consecutive polls before the row actually shows it. Other honest states
// (transientFailure/stale/rate-limited/accessDenied) pass through unchanged.
const DISCONNECT_DEBOUNCE = 2
// A provider stuck "waiting" (transientFailure/stale, not rate limited) never
// resolves on its own — the quota service just re-serves the same cached failure
// — so past this cap we stop showing an open-ended spinner and surface an
// actionable, terminal state (Connect + Refresh). The steady poll is 30–60s and
// already cheap (5-min service cache, no repeated spawn), so this only changes
// the copy, not the fetch cadence. Comfortably clears a normal 1–2s answer.
const WAITING_CAP_MS = 20_000

type QuotaKnown = { last: QuotaProvider; strikes: number; waitingSince?: number }

function isWaiting(quota: QuotaProvider): boolean {
  return (quota.connection === 'transientFailure' || quota.connection === 'stale') && !quota.rateLimited
}

export function stabilizeQuota(raw: QuotaProvider[], known: Map<QuotaProvider['provider'], QuotaKnown>, now: number): QuotaProvider[] {
  const out: QuotaProvider[] = []
  const seen = new Set<QuotaProvider['provider']>()
  for (const provider of raw) {
    seen.add(provider.provider)
    const prev = known.get(provider.provider)
    if (provider.connection === 'connected') {
      known.set(provider.provider, { last: provider, strikes: 0 })
      out.push(provider)
      continue
    }
    // Only debounce a provider we last saw connected reporting `disconnected`;
    // a provider that was never connected shows disconnected immediately.
    if (provider.connection === 'disconnected' && prev?.last.connection === 'connected') {
      const strikes = prev.strikes + 1
      if (strikes < DISCONNECT_DEBOUNCE) {
        known.set(provider.provider, { last: prev.last, strikes })
        out.push(prev.last)
        continue
      }
    }
    if (isWaiting(provider)) {
      // A provider that has already shown real numbers keeps them through a
      // transient miss (e.g. a manual Refresh where the serve was busy bringing
      // another provider online): never blank connected bars back to "Waiting…".
      if (prev?.last.connection === 'connected') {
        known.set(provider.provider, { last: prev.last, strikes: 0 })
        out.push(prev.last)
        continue
      }
      // A genuinely cold provider that has never returned data shows "Waiting…",
      // and past the cap escalates to a terminal, actionable error rather than
      // spinning forever.
      const waitingSince = prev?.waitingSince ?? now
      if (now - waitingSince >= WAITING_CAP_MS) {
        known.set(provider.provider, { last: provider, strikes: 0, waitingSince })
        out.push({ ...provider, connection: 'terminalFailure', connectable: true, footerLines: [t('plans.quota.couldNotReach', { name: PROVIDER_NAMES[provider.provider] })] })
        continue
      }
      known.set(provider.provider, { last: provider, strikes: 0, waitingSince })
      out.push(provider)
      continue
    }
    known.set(provider.provider, { last: provider, strikes: 0 })
    out.push(provider)
  }
  // A provider missing from this poll (empty/slow serve) is a transient miss,
  // never a disconnect: keep its last known row.
  for (const [provider, entry] of known) {
    if (!seen.has(provider)) out.push(entry.last)
  }
  return out
}

function useStableQuota(raw: QuotaProvider[] | null): QuotaProvider[] | null {
  const known = useRef(new Map<QuotaProvider['provider'], QuotaKnown>())
  const lastRaw = useRef<QuotaProvider[] | null | undefined>(undefined)
  const stable = useRef<QuotaProvider[] | null>(null)
  if (raw !== lastRaw.current) {
    lastRaw.current = raw
    if (raw) stable.current = stabilizeQuota(raw, known.current, Date.now())
  }
  return raw === null ? null : stable.current
}

export function Plans({ period, refreshToken = 0, onNavigate, ready = true }: { period: Period; refreshToken?: number; onNavigate?: (section: Section, pane?: SettingsPane) => void; ready?: boolean }) {
  // Force a fresh fetch (bypassing QuotaService's 5-min cache, and its keychain
  // guard) when the user hits ⌘R or clicks Refresh in the Connect affordance;
  // the steady 30s poll keeps serving cached quota.
  const [reconnectNonce, setReconnectNonce] = useState(0)
  const lastForced = useRef(`${refreshToken}:${reconnectNonce}`)
  const disabledProviders = readDisabledProviders()
  const quotaMemoKey = `quota|${[...disabledProviders].sort().join(',')}`
  const quota = usePolled<QuotaProvider[]>(() => {
    const key = `${refreshToken}:${reconnectNonce}`
    const force = key !== lastForced.current
    lastForced.current = key
    return codeburn.getQuota(force, disabledProviders)
  }, [refreshToken, reconnectNonce, quotaMemoKey], { memoKey: quotaMemoKey })
  const reconnect = () => setReconnectNonce(value => value + 1)
  const budgetReport = usePolled<StatusJson>(() => codeburn.getPlans(period), [period, refreshToken], {
    enabled: ready,
    memoKey: reportMemoKey('plans', period),
  })
  const manualPlans = budgetReport.data ? manualPlanSummaries(budgetReport.data) : []
  const stableQuota = useStableQuota(quota.data)

  return (
    <>
      <div className="bar">
        <BarNav />
        <h1 className="t">{t('plans.title')}</h1>
        <div className="sp" />
        <button type="button" className="btn btn-s" onClick={() => onNavigate?.('settings', 'plans')}>
          {t('plans.addPlan')}
        </button>
      </div>
      <div className={motionClass('body', 'section-fade')}>
        {budgetReport.data && budgetReport.error && <StaleBanner error={budgetReport.error} />}
        {renderQuota(stableQuota, quota.error, reconnect)}
        {renderBudgetPlans(budgetReport.data, budgetReport.error, manualPlans)}
      </div>
    </>
  )
}

function renderQuota(data: QuotaProvider[] | null, error: ReturnType<typeof usePolled<QuotaProvider[]>>['error'], onReconnect: () => void) {
  if (!data) {
    if (error) {
      return (
        <Panel title={t('plans.quota.panelTitle')}>
          <p className="quota-connection-note quota-terminal">{t('plans.quota.unavailable')}</p>
        </Panel>
      )
    }
    return <SectionSkeleton label={t('plans.quota.loading')} rows={3} />
  }

  if (data.length === 0) {
    return (
      <Panel title={t('plans.quota.panelTitle')}>
        <p className="quota-connection-note">{t('plans.quota.noProviders')}</p>
      </Panel>
    )
  }

  return (
    <div className="plans-grid">
      {data.map(provider => <QuotaPanel key={provider.provider} quota={provider} onReconnect={onReconnect} />)}
    </div>
  )
}

/** The provider's own logo, embossed large and faint into the card's
 *  bottom-right — the menu-bar plugin-card wordmark treatment. Providers with no
 *  logo asset get no background art rather than an invented one. */
function CardEmboss({ provider }: { provider: string }) {
  if (!hasProviderLogo(provider)) return null
  return <div className="plan-card-art" aria-hidden><ProviderLogo provider={provider} size={132} /></div>
}

function renderBudgetPlans(data: StatusJson | null, error: ReturnType<typeof usePolled<StatusJson>>['error'], plans: JsonPlanSummary[]) {
  if (!data && error) {
    return (
      <section className="budget-plans">
        <h2 className="plans-section-heading">{t('plans.budget.heading')}</h2>
        <CliErrorPanel error={error} subject={t('plans.budget.pacingSubject')} />
      </section>
    )
  }
  if (plans.length === 0) return null

  return (
    <section className="budget-plans">
      <h2 className="plans-section-heading">{t('plans.budget.heading')}</h2>
      <div className="plans-grid">
        {plans.map(plan => <PlanPanel key={`${plan.provider}-${plan.id}`} plan={plan} />)}
      </div>
    </section>
  )
}

function QuotaPanel({ quota, onReconnect }: { quota: QuotaProvider; onReconnect: () => void }) {
  const providerName = PROVIDER_NAMES[quota.provider]
  return (
    <Panel
      className="quota-card"
      title={<span className="quota-title">{providerName}{quota.planLabel ? <small>{quota.planLabel}</small> : null}</span>}
      right={<ConnectionIndicator connection={quota.connection} />}
    >
      <CardEmboss provider={quota.provider} />
      <QuotaContent quota={quota} onReconnect={onReconnect} />
    </Panel>
  )
}

const CONNECTION_LABEL_KEYS: Record<QuotaProvider['connection'], string> = {
  connected: 'plans.quota.status.connected',
  disconnected: 'plans.quota.status.disconnected',
  accessDenied: 'plans.quota.status.locked',
  loading: 'plans.quota.status.loading',
  stale: 'plans.quota.status.stale',
  transientFailure: 'plans.quota.status.waiting',
  terminalFailure: 'plans.quota.status.error',
}

function ConnectionIndicator({ connection }: { connection: QuotaProvider['connection'] }) {
  const label = t(CONNECTION_LABEL_KEYS[connection])
  return <span className={`quota-connection quota-connection-${connection}`}><i />{label}</span>
}

function QuotaContent({ quota, onReconnect }: { quota: QuotaProvider; onReconnect: () => void }) {
  if (quota.connection === 'disconnected' || quota.connection === 'accessDenied') {
    return <ConnectAffordance provider={quota.provider} connection={quota.connection} onRefresh={onReconnect} />
  }
  if (quota.connection === 'loading') return <p className="quota-connection-note">{t('plans.quota.loading')}</p>
  if (quota.connection === 'stale' || quota.connection === 'transientFailure') {
    if (quota.rateLimited) return <p className="quota-connection-note">{rateLimitedNote(quota.provider)}</p>
    return <p className="quota-connection-note">{t('plans.quota.waitingOnCli')}</p>
  }
  if (quota.connection === 'terminalFailure') {
    // An auth expiry (or a capped "waiting") is recoverable: show the same
    // Connect affordance the disconnected state uses, keeping the error line.
    if (quota.connectable) {
      return <ConnectAffordance provider={quota.provider} connection="disconnected" onRefresh={onReconnect} message={quota.footerLines[0]} />
    }
    // A genuinely terminal provider (a retired Gemini tier, no allowance) says
    // why; the generic line is the fallback. No action to offer.
    return <p className="quota-connection-note quota-terminal">{quota.footerLines[0] ?? t('plans.quota.unavailableGeneric')}</p>
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
        <span>{reset ? t('plans.quota.usedWithReset', { percent, reset }) : t('plans.quota.used', { percent })}</span>
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
  if (remainingMinutes <= 0) return t('plans.reset.now')
  const days = Math.floor(remainingMinutes / (24 * 60))
  const hours = Math.floor((remainingMinutes % (24 * 60)) / 60)
  const minutes = remainingMinutes % 60
  if (days > 0) return hours > 0 ? t('plans.reset.daysHours', { days, hours }) : t('plans.reset.days', { days })
  if (hours > 0) return minutes > 0 ? t('plans.reset.hoursMinutes', { hours, minutes }) : t('plans.reset.hours', { hours })
  return t('plans.reset.minutes', { minutes })
}

function PlanPanel({ plan }: { plan: JsonPlanSummary }) {
  const hasBudget = plan.budget > 0
  const displayPercent = Math.min(100, Math.max(0, plan.percentUsed))
  const over = plan.status === 'over' || plan.percentUsed > 100
  const trackClass = hasBudget ? (over ? 'over' : undefined) : 'mut'
  const overage = Math.max(0, plan.spent - plan.budget)
  const right = hasBudget
    ? overage > 0
      ? t('plans.card.spentPercentOver', { spent: formatConverted(plan.spent), percent: fmtPct(plan.percentUsed), overage: formatConverted(overage) })
      : t('plans.card.spentPercent', { spent: formatConverted(plan.spent), percent: fmtPct(plan.percentUsed) })
    : t('plans.card.spentThisCycle', { spent: formatConverted(plan.spent) })
  const detail = hasBudget
    ? t('plans.card.budgetDetail', { budget: formatConverted(plan.budget), provider: plan.provider })
    : t('plans.card.noPlanDetail', { provider: plan.provider })

  return (
    <Panel
      className="plan-card"
      title={<span className="plan-title">{PLAN_NAMES[plan.id]}<small>{detail}</small></span>}
      right={right}
    >
      <CardEmboss provider={plan.provider} />
      <div className="track" data-testid={`plan-track-${plan.provider}`}>
        <i className={trackClass} style={{ width: `${displayPercent}%` }} />
      </div>
      {hasBudget ? <PaceLine plan={plan} /> : null}
    </Panel>
  )
}

function PaceLine({ plan }: { plan: JsonPlanSummary }) {
  const end = cycleEndDate(plan)
  const endLabel = end ? formatShortDate(end) : t('plans.date.unknown')
  if (plan.status === 'over' || plan.projectedMonthEnd > plan.budget) {
    return (
      <div className="pace hot">
        {t('plans.pace.exceed', { projected: formatConverted(plan.projectedMonthEnd), date: endLabel })}
      </div>
    )
  }
  if (plan.status === 'near') {
    return (
      <div className="pace hot">
        {t('plans.pace.near', { percent: fmtPct(plan.percentUsed), projected: formatConverted(plan.projectedMonthEnd), date: endLabel })}
      </div>
    )
  }
  return <div className="pace ok">{t('plans.pace.onTrack')}</div>
}

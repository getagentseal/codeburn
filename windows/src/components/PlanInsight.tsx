import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { MenubarPayload } from '../lib/payload'
import type { CurrencyState } from '../lib/currency'
import { formatCompactCurrency, formatTokens, plural } from '../lib/currency'
import { relativeFuture } from '../lib/dates'
import type { PlanProjection, PlanUsage } from '../lib/plan'
import { projectQuotaWindow, projectWindow, earliestReset } from '../lib/plan'
import { displayLabel, refreshQuota, summaryFor, type QuotaState, type QuotaSummary, type QuotaWindow } from '../lib/quota'
import { ALL_PROVIDER, type Provider } from './AgentTabStrip'
import { BulbIcon, ChevronRight, KeySlashIcon, PersonDashedIcon, WarningIcon, ArrowUpRight } from './Icons'

/// Sonnet-weighted approximation the mac app uses to turn a dollar saving into tokens.
const USD_PER_MILLION_EFFECTIVE_TOKENS = 9
const MILLION = 1_000_000
const PLAN_REFRESH_MS = 5 * 60_000
/// The label `codeburn quota` gives each credential-file window, which is where the forecast is.
const CLAUDE_QUOTA_LABELS: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: 'Weekly',
  seven_day_opus: 'Weekly · Opus',
  seven_day_sonnet: 'Weekly · Sonnet',
}

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'loaded'; usage: Extract<PlanUsage, { state: 'ok' }> }
  | { kind: 'no_credentials' }
  | { kind: 'failed'; message: string }

type Props = {
  payload: MenubarPayload | null
  currency: CurrencyState
  provider: Provider
  quota: QuotaState
  onOpenTerminal: (args: string[]) => void
  onConnectClaude: () => void
}

/// What the Plan tab has to say about the selected provider. All has no plan of its own, as
/// on the mac, so the pill is hidden there. Claude always qualifies even before the quota
/// store has answered: its tier and prior-cycle baseline come from the credential file, not
/// from the CLI's quota answer.
export function planTarget(quota: QuotaState, provider: Provider): QuotaSummary | 'claude' | null {
  if (provider === ALL_PROVIDER) return null
  const summary = summaryFor(quota, provider)
  if (summary) return summary
  return provider === 'claude' ? 'claude' : null
}

export function PlanInsight({ payload, currency, provider, quota, onOpenTerminal, onConnectClaude }: Props) {
  const target = planTarget(quota, provider)
  if (target === null) return null
  if (target === 'claude' || target.id === 'claude') {
    return (
      <ClaudePlan
        payload={payload}
        currency={currency}
        quotaWindows={summaryFor(quota, 'claude')?.windows ?? []}
        onOpenTerminal={onOpenTerminal}
        onConnectClaude={onConnectClaude}
      />
    )
  }
  return <ProviderPlan summary={target} />
}

/// The Claude tab keeps its own path: `plan_usage` reads the credential file directly, which
/// is the only source for the subscription tier and last cycle's final reading.
function ClaudePlan({ payload, currency, quotaWindows, onOpenTerminal, onConnectClaude }: {
  payload: MenubarPayload | null
  currency: CurrencyState
  quotaWindows: QuotaWindow[]
  onOpenTerminal: (args: string[]) => void
  onConnectClaude: () => void
}) {
  const [state, setState] = useState<LoadState>({ kind: 'idle' })
  const [now, setNow] = useState(() => new Date())

  const load = async () => {
    setState(prev => (prev.kind === 'loaded' ? prev : { kind: 'loading' }))
    try {
      const usage = await invoke<PlanUsage>('plan_usage')
      if (usage.state === 'ok') setState({ kind: 'loaded', usage })
      else if (usage.state === 'no_credentials') setState({ kind: 'no_credentials' })
      else setState({ kind: 'failed', message: usage.message })
    } catch (err) {
      setState({ kind: 'failed', message: err instanceof Error ? err.message : String(err) })
    }
    setNow(new Date())
  }

  useEffect(() => {
    load()
    const id = setInterval(load, PLAN_REFRESH_MS)
    return () => clearInterval(id)
  }, [])

  switch (state.kind) {
    case 'idle':
    case 'loading':
      return (
        <div className="plan-state">
          <PersonDashedIcon size={22} className="plan-state-icon" />
          <div className="plan-state-title-muted">Loading your plan...</div>
          <div className="plan-state-note">Reading Claude Code credentials from this machine.</div>
        </div>
      )
    case 'no_credentials':
      return (
        <div className="plan-state">
          <KeySlashIcon size={20} className="plan-state-icon" />
          <div className="plan-state-title">No Claude subscription connected</div>
          <div className="plan-state-note">Click Connect to sign in with Claude in a terminal, then return here.</div>
          <div className="plan-actions">
            <button type="button" className="btn btn-prominent" onClick={() => onConnectClaude()}>Connect Claude</button>
            <button type="button" className="btn" onClick={load}>Retry</button>
          </div>
        </div>
      )
    case 'failed':
      return (
        <div className="plan-state">
          <WarningIcon size={18} filled={false} className="plan-state-icon plan-state-icon-accent" />
          <div className="plan-state-title">Couldn't load plan data</div>
          <div className="plan-state-error">{state.message}</div>
          <div className="plan-actions">
            <button type="button" className="btn btn-prominent" onClick={() => onConnectClaude()}>Reconnect Claude</button>
            <button type="button" className="btn" onClick={load}>Retry</button>
          </div>
        </div>
      )
    case 'loaded': {
      const { usage } = state
      const reset = earliestReset(usage.windows)
      return (
        <div className="plan-insight">
          <div className="plan-header">
            <span className="plan-tier">{usage.tier}</span>
            {reset && <span className="plan-reset">Resets {relativeFuture(reset, now)}</span>}
          </div>
          <div className="plan-rows">
            {usage.windows.map(w => (
              <UtilizationRow
                key={w.key}
                label={w.label}
                percent={w.percent}
                projection={projectWindow(w, now)}
                forecast={quotaWindows.find(q => q.label === CLAUDE_QUOTA_LABELS[w.key])}
                now={now}
              />
            ))}
          </div>
          {payload && payload.optimize.findingCount > 0 && payload.optimize.savingsUSD > 0 && (
            <button type="button" className="savings-badge" onClick={() => onOpenTerminal(['optimize'])}>
              <BulbIcon size={10} className="savings-badge-icon" />
              <span>
                Save ~{formatCompactCurrency(payload.optimize.savingsUSD, currency)} / ~
                {formatTokens((payload.optimize.savingsUSD / USD_PER_MILLION_EFFECTIVE_TOKENS) * MILLION)} tokens
                {' · '}{plural(payload.optimize.findingCount, 'finding')}
              </span>
              <ChevronRight size={8} className="savings-badge-chevron" />
            </button>
          )}
        </div>
      )
    }
  }
}

/// Every other provider reads the shared quota store, which is the same data the mac's
/// per-provider plan tabs render. There is no prior-cycle baseline behind it, so a window
/// too fresh to extrapolate simply gets no caption.
function ProviderPlan({ summary }: { summary: QuotaSummary }) {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), PLAN_REFRESH_MS)
    return () => clearInterval(id)
  }, [])

  const retry = () => { setNow(new Date()); void refreshQuota() }

  if (summary.connection === 'disconnected') {
    return (
      <div className="plan-state">
        <KeySlashIcon size={20} className="plan-state-icon" />
        <div className="plan-state-title">No {summary.name} credentials found</div>
        <div className="plan-state-note">Sign in with the {summary.name} CLI first. Then click Try Again.</div>
        <div className="plan-actions">
          <button type="button" className="btn btn-prominent" onClick={retry}>Try Again</button>
        </div>
      </div>
    )
  }
  if (summary.connection === 'terminalFailure') {
    return (
      <div className="plan-state">
        <WarningIcon size={18} filled={false} className="plan-state-icon plan-state-icon-accent" />
        <div className="plan-state-title">Reconnect {summary.name}</div>
        <div className="plan-state-error">{summary.reason ?? `Your ${summary.name} session has expired. Sign in again in your terminal, then click Reconnect.`}</div>
        <div className="plan-actions">
          <button type="button" className="btn btn-prominent" onClick={retry}>Reconnect</button>
        </div>
      </div>
    )
  }
  if (summary.windows.length === 0) {
    return (
      <div className="plan-state">
        <PersonDashedIcon size={22} className="plan-state-icon" />
        <div className="plan-state-title-muted">Reading {summary.name} credentials...</div>
      </div>
    )
  }

  const reset = summary.windows
    .map(w => (w.resetsAt ? new Date(w.resetsAt) : null))
    .filter((d): d is Date => d !== null && !Number.isNaN(d.getTime()))
    .reduce<Date | null>((a, b) => (a && a < b ? a : b), null)

  return (
    <div className="plan-insight">
      <div className="plan-header">
        <span className="plan-tier">{summary.planLabel ?? summary.name}</span>
        {reset && <span className="plan-reset">Resets {relativeFuture(reset, now)}</span>}
      </div>
      <div className="plan-rows">
        {summary.windows.map((window, index) => (
          <UtilizationRow
            key={`${window.label}-${index}`}
            label={`${displayLabel(window.label)} window`}
            percent={window.usedPct}
            projection={projectQuotaWindow(window.label, window.usedPct, window.resetsAt, now)}
            forecast={window}
            now={now}
          />
        ))}
      </div>
      {summary.connection === 'transientFailure' && (
        <div className="plan-note">{summary.name} temporarily unreachable. Retrying.</div>
      )}
      {summary.connection === 'stale' && <div className="plan-note">Showing the last reading.</div>}
    </div>
  )
}

function UtilizationRow({ label, percent, projection, forecast, now }: {
  label: string
  percent: number
  projection: PlanProjection | null
  forecast?: QuotaWindow
  now: Date
}) {
  const clamped = Math.min(Math.max(percent, 0), 100)
  const marker = projection ? Math.min(Math.max(projection.percent, 0), 100) : null

  const runsOutAt = forecast?.runsOutAt ? new Date(forecast.runsOutAt) : null
  const warn = projection?.willOverflow || runsOutAt !== null

  let caption: string | null = null
  if (projection) {
    const pct = Math.round(projection.percent)
    if (projection.source === 'historical') caption = `Based on last cycle: ${pct}%`
    else if (runsOutAt) caption = `On pace: ${pct}% at reset · hits 100% ${relativeFuture(runsOutAt, now)}`
    else if (forecast?.lastsUntilReset) caption = `On pace: ${pct}% at reset · lasts until reset`
    else caption = `On pace: ${pct}% at reset`
  }

  return (
    <div className="util-row">
      <div className="util-row-head">
        <span className="util-label">{label}</span>
        <span className="util-percent">{Math.round(clamped)}%</span>
      </div>
      <div className="util-bar">
        <div className="util-bar-fill" style={{ width: `${clamped}%` }} />
        {marker !== null && <div className="util-bar-marker" style={{ left: `calc(${marker}% - 0.75px)` }} />}
      </div>
      {caption && (
        <div className={`util-caption ${warn ? 'util-caption-warn' : ''}`}>
          {warn ? <WarningIcon size={8} /> : <ArrowUpRight size={8} />}
          <span>{caption}</span>
        </div>
      )}
    </div>
  )
}

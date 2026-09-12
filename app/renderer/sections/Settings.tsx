import { useEffect, useRef, useState } from 'react'

import { Hint } from '../components/Hint'
import { CliErrorText, cliErrorDisplay } from '../components/CliErrorPanel'
import { ConnectAffordance } from '../components/ConnectAffordance'
import { Dropdown } from '../components/Dropdown'
import { Panel } from '../components/Panel'
import { ProviderLogo } from '../components/ProviderLogo'
import type { Section } from '../components/Sidebar'
import { clearPolledMemo, usePolled } from '../hooks/usePolled'
import { updateDownloadUrl, useUpdateStatus } from '../hooks/useUpdateStatus'
import { version as appVersion } from '../../package.json'
import { readDailyBudget } from '../lib/budget'
import { formatConverted, formatUsd, shortenProjectPath } from '../lib/format'
import { codeburn } from '../lib/ipc'
import { projectMatches, projectPattern } from '../lib/projectMatch'
import { shortcutLabel } from '../lib/platform'
import { motionClass } from '../lib/motion'
import { clearOverviewHeadlines } from '../lib/overviewSnapshot'
import { PROVIDER_NAMES, QUOTA_PROVIDERS, readDisabledProviders, writeDisabledProviders } from '../lib/providers'
import { REFRESH_OPTIONS, useRefreshCadence } from '../lib/refreshCadence'
import { reportMemoKey } from '../lib/reportMemoKey'
import { showToast } from '../lib/toast'
import { trackEvent } from '../lib/track'
import { ToastHost } from '../components/ToastHost'
import { rateLimitedNote } from './Plans'
import { SharingPane } from './SettingsSharing'
import { CapacityDockPane, MenuBarPane } from './SettingsTray'
import type { ActionResult, AliasRow, ClaudeConfigSelector, CompanionStatus, CliError, CombinedUsage, DeviceScanResult, Identity, JsonPlanSummary, MenubarPayload, Period, PlanId, PlanProvider, PriceOverrideList, PriceOverrideRow, PriceRates, ProjectFilter, ProjectRow, ProjectsReport, ProviderName, QuotaProvider, Scope, ShareStatus, StatusJson, TelemetryStatus } from '../lib/types'

export type SettingsPane = 'general' | 'providers' | 'projects' | 'aliases' | 'pricing' | 'plans' | 'devices' | 'export' | 'privacy' | 'sharing' | 'menubar' | 'dock'
type Pane = SettingsPane
type Theme = 'system' | 'light' | 'dark'

type PlanPreset = { id: Exclude<PlanId, 'custom' | 'none'>; label: string; provider: Exclude<PlanProvider, 'all' | 'codex'> }

const PLAN_PRESETS: PlanPreset[] = [
  { id: 'claude-pro', label: 'Claude Pro', provider: 'claude' },
  { id: 'claude-max', label: 'Claude Max 20x', provider: 'claude' },
  { id: 'claude-max-5x', label: 'Claude Max 5x', provider: 'claude' },
  { id: 'cursor-pro', label: 'Cursor Pro', provider: 'cursor' },
  { id: 'supergrok', label: 'SuperGrok', provider: 'grok' },
  { id: 'supergrok-heavy', label: 'SuperGrok Heavy', provider: 'grok' },
]

// Claude and Codex subscriptions are detected from the CLI login (see the
// detected-subscriptions list), so only non-OAuth providers get a manual preset.
const MANUAL_PLAN_PRESETS = PLAN_PRESETS.filter(preset => preset.provider !== 'claude')

const CURRENCIES = [
  'USD', 'EUR', 'GBP', 'JPY', 'CNY', 'CAD', 'AUD', 'CHF', 'HKD', 'SGD', 'INR', 'NZD', 'SEK', 'NOK', 'DKK',
  'KRW', 'BRL', 'MXN', 'ZAR', 'AED', 'SAR', 'TRY', 'PLN', 'THB', 'IDR', 'MYR', 'PHP', 'RUB', 'ILS', 'CZK',
]

function readSetting(key: string): string | null {
  try { return globalThis.localStorage?.getItem(key) ?? null } catch { return null }
}

function writeSetting(key: string, value: string): void {
  try { globalThis.localStorage?.setItem(key, value) } catch { /* storage can be unavailable in hardened contexts */ }
}

const RAIL_ITEMS: Array<{ id: Pane; label: string; icon: React.ReactNode }> = [
  { id: 'general', label: 'General', icon: <><line x1="4" y1="8" x2="20" y2="8" /><circle cx="9" cy="8" r="2.2" /><line x1="4" y1="16" x2="20" y2="16" /><circle cx="15" cy="16" r="2.2" /></> },
  { id: 'providers', label: 'Providers', icon: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></> },
  { id: 'projects', label: 'Projects', icon: <><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4L11 8.5h8.5A1.5 1.5 0 0 1 21 10v7.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" /><path d="M9 14l2 2 4-4" /></> },
  { id: 'aliases', label: 'Model aliases', icon: <><path d="M20 12l-8 8-9-9V3h8z" /><circle cx="7.5" cy="7.5" r="1.4" /></> },
  { id: 'pricing', label: 'Pricing', icon: <><circle cx="12" cy="12" r="9" /><path d="M14.5 9a2.5 2.5 0 0 0-2.5-1.6c-1.5 0-2.5.8-2.5 2s1 1.6 2.5 2 2.5.9 2.5 2-1 2-2.5 2A2.5 2.5 0 0 1 9.5 15" /><line x1="12" y1="6" x2="12" y2="18" /></> },
  { id: 'plans', label: 'Plans', icon: <><rect x="2" y="5" width="20" height="14" rx="2" /><line x1="2" y1="10" x2="22" y2="10" /></> },
  { id: 'devices', label: 'Devices', icon: <><rect x="3" y="4" width="18" height="12" rx="1.5" /><line x1="8" y1="20" x2="16" y2="20" /><line x1="12" y1="16" x2="12" y2="20" /></> },
  { id: 'export', label: 'Export', icon: <><path d="M12 3v12" /><path d="M7 11l5 5 5-5" /><path d="M4 21h16" /></> },
  { id: 'sharing', label: 'Automatic Sync', icon: <><path d="M12 3v12" /><path d="M7 11l5 5 5-5" /><path d="M4 21h16" /></> },
  { id: 'privacy', label: 'Privacy & data', icon: <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /> },
]

/// Appended to the rail only while the matching switch in the sidebar corner is on.
const TRAY_RAIL_ITEMS: Record<'menubar' | 'dock', { id: Pane; label: string; icon: React.ReactNode }> = {
  menubar: { id: 'menubar', label: 'Menu bar', icon: <><rect x="2" y="4" width="20" height="5" rx="1.5" /><circle cx="18" cy="6.5" r="1" /><path d="M5 14h6M5 18h10" /></> },
  dock: { id: 'dock', label: 'Capacity Dock', icon: <><rect x="16" y="4" width="5" height="16" rx="2.5" /><circle cx="18.5" cy="9" r="1.4" /><circle cx="18.5" cy="15" r="1.4" /><path d="M3 12h8" /></> },
}

/// The sidebar's two switches decide which tray panes exist, so this reads the same status
/// the corner does. Null until the main process answers, and on any platform without a
/// bundled tray app it stays unsupported and neither pane appears.
function useCompanionStatus(): CompanionStatus | null {
  const [status, setStatus] = useState<CompanionStatus | null>(null)
  useEffect(() => {
    let live = true
    void codeburn?.companionStatus?.()
      .then(next => { if (live) setStatus(next) })
      .catch(() => {})
    return () => { live = false }
  }, [])
  return status
}

function periodLabel(period: Period): string {
  if (period === 'today') return 'today'
  if (period === 'week') return 'last 7 days'
  if (period === 'month') return 'this month'
  if (period === '30days') return 'last 30 days'
  return 'all time'
}

function shortFingerprint(fingerprint: string): string {
  const parts = fingerprint.split(':').filter(Boolean)
  if (parts.length < 3) return fingerprint
  return `${parts[0]}:${parts[1]}:…:${parts[parts.length - 1]}`
}

/** Inline destructive confirm: the button swaps to a prompt + Confirm/Cancel in
 * place (no OS dialog). Auto-cancels on Escape or when focus leaves the group. */
function ConfirmButton({ label, prompt, onConfirm }: { label: string; prompt: string; onConfirm: () => void }) {
  const [confirming, setConfirming] = useState(false)
  if (!confirming) {
    return <button className="btnp" onClick={() => setConfirming(true)}>{label}</button>
  }
  return (
    <span
      className="set-confirm"
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setConfirming(false) }}
      onKeyDown={event => { if (event.key === 'Escape') setConfirming(false) }}
    >
      <span className="set-confirm-q">{prompt}</span>
      <button className="set-text-button" autoFocus onClick={() => { setConfirming(false); onConfirm() }}>Confirm</button>
      <button className="set-text-button" onClick={() => setConfirming(false)}>Cancel</button>
    </span>
  )
}

export function Settings({ period, refreshToken = 0, onNavigate, initialPane, claudeConfigs, claudeConfigSource = null, onConfigMutated, scope = 'local', onScopeChange, projectFiltered = false }: { period: Period; refreshToken?: number; onNavigate?: (section: Section) => void; initialPane?: SettingsPane; claudeConfigs?: ClaudeConfigSelector; claudeConfigSource?: string | null; onConfigMutated?: () => void; scope?: Scope; onScopeChange?: (scope: string) => void; projectFiltered?: boolean }) {
  const [pane, setPane] = useState<Pane>(initialPane ?? 'general')
  // The tray app's own two panes, Windows only, each shown only while its switch in the
  // sidebar corner is on: there is nothing to configure about a tray app that is not running,
  // and the rail is one of its windows.
  const companion = useCompanionStatus()
  const railItems = [
    ...RAIL_ITEMS,
    ...(companion?.supported && companion.menuBar ? [TRAY_RAIL_ITEMS.menubar] : []),
    ...(companion?.supported && companion.sidebar ? [TRAY_RAIL_ITEMS.dock] : []),
  ]
  // A pane whose switch has just been turned off cannot stay on screen.
  const paneExists = railItems.some(item => item.id === pane)
  useEffect(() => {
    if (!paneExists) setPane('general')
  }, [paneExists])

  return (
    <>
      <div className="bar"><div className="t">Settings</div></div>
      <ToastHost />
      <div className={motionClass('body set-body', 'section-fade')}>
        <nav className="set-rail" aria-label="Settings sections">
          {railItems.map(item => (
            <button key={item.id} className={pane === item.id ? 'set-rail-item on' : 'set-rail-item'} aria-current={pane === item.id ? 'page' : undefined} onClick={() => setPane(item.id)}>
              <svg viewBox="0 0 24 24" aria-hidden="true">{item.icon}</svg>{item.label}
            </button>
          ))}
        </nav>
        <main className="set-pane">
          {pane === 'general' && <GeneralPane period={period} refreshToken={refreshToken} claudeConfigs={claudeConfigs} claudeConfigSource={claudeConfigSource} onConfigMutated={onConfigMutated} scope={scope} onScopeChange={onScopeChange} projectFiltered={projectFiltered} />}
          {pane === 'providers' && <ProvidersPane period={period} refreshToken={refreshToken} />}
          {pane === 'projects' && <ProjectsPane refreshToken={refreshToken} onConfigMutated={onConfigMutated} />}
          {pane === 'aliases' && <AliasesPane refreshToken={refreshToken} onConfigMutated={onConfigMutated} />}
          {pane === 'pricing' && <PricingPane refreshToken={refreshToken} onConfigMutated={onConfigMutated} />}
          {pane === 'plans' && <PlansPane period={period} refreshToken={refreshToken} onNavigate={onNavigate} onConfigMutated={onConfigMutated} />}
          {pane === 'devices' && <DevicesPane period={period} refreshToken={refreshToken} />}
          {pane === 'export' && <ExportPane period={period} refreshToken={refreshToken} />}
          {pane === 'sharing' && <SharingPane />}
          {pane === 'privacy' && <PrivacyPane />}
          {pane === 'menubar' && <MenuBarPane />}
          {pane === 'dock' && <CapacityDockPane refreshToken={refreshToken} />}
        </main>
      </div>
      <Hint items={[{ k: shortcutLabel('1-8'), label: 'Navigate' }, { k: shortcutLabel('R'), label: 'Refresh' }]} right="pairing uses mutual TLS · approve-style, no PIN" />
    </>
  )
}

function GeneralPane({ period, refreshToken, claudeConfigs, claudeConfigSource, onConfigMutated, scope = 'local', onScopeChange, projectFiltered = false }: { period: Period; refreshToken: number; claudeConfigs?: ClaudeConfigSelector; claudeConfigSource: string | null; onConfigMutated?: () => void; scope?: Scope; onScopeChange?: (scope: string) => void; projectFiltered?: boolean }) {
  const [currencyNonce, setCurrencyNonce] = useState(0)
  const plans = usePolled<StatusJson>(() => codeburn.getPlans(period), [period, refreshToken, currencyNonce], {
    memoKey: reportMemoKey('plans', period),
  })
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = readSetting('codeburn.theme')
    return saved === 'light' || saved === 'dark' ? saved : 'system'
  })
  const [defaultPeriod, setDefaultPeriod] = useState(() => readSetting('codeburn.defaultPeriod') ?? 'today')
  const cadence = useRefreshCadence()
  const [budgetKind, setBudgetKind] = useState<'off' | 'usd' | 'tokens'>(() => readDailyBudget()?.kind ?? 'off')
  const [budgetInput, setBudgetInput] = useState(() => { const budget = readDailyBudget(); return budget ? String(budget.value) : '' })
  const [budgetError, setBudgetError] = useState('')
  const update = useUpdateStatus()
  const version = update?.currentVersion || appVersion
  const updateNote = update?.updateAvailable && update.latestVersion
    ? `Update available: ${update.latestVersion}`
    : update?.latestVersion
    ? 'Up to date'
    : ''

  useEffect(() => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme')
    else document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  // Store on change; a positive finite amount persists, anything else clears the
  // cap (so the banner turns off) and, when non-empty, flags a validation error.
  const persistBudget = (kind: 'off' | 'usd' | 'tokens', input: string) => {
    const trimmed = input.trim()
    if (kind === 'off' || trimmed === '') { setBudgetError(''); writeSetting('codeburn.dailyBudget', ''); return }
    const value = Number(trimmed)
    if (!Number.isFinite(value) || value <= 0) { setBudgetError('Enter a positive number.'); return }
    setBudgetError('')
    writeSetting('codeburn.dailyBudget', JSON.stringify({ kind, value }))
  }

  const chooseTheme = (next: Theme) => {
    setTheme(next)
    writeSetting('codeburn.theme', next)
    trackEvent('settings_change', { setting: 'theme', value: next })
  }
  const finishCurrency = (result: ActionResult) => {
    showToast(result.ok ? 'Updated' : result.stderr || 'Unable to update currency', result.ok ? 'ok' : 'error')
    if (result.ok) { setCurrencyNonce(value => value + 1); onConfigMutated?.() }
  }
  const currencies = [...CURRENCIES]
  if (plans.data?.currency && !currencies.includes(plans.data.currency)) currencies.push(plans.data.currency)
  const hasConfigs = Boolean(claudeConfigs && claudeConfigs.options.length > 0)
  const activeConfigLabel = claudeConfigSource
    ? claudeConfigs?.options.find(option => option.id === claudeConfigSource)?.label ?? claudeConfigSource
    : 'All Claude configs'

  return (
    <section className="set-p on">
      <div><h3 className="set-h">General</h3><p className="set-sub">Display and appearance for the whole app.</p></div>
      <div className="card">
        <div className="about-sec">
          <div className="about-sec-h">Appearance</div>
          <div className="about-row"><span className="tx">Theme<small>Match your system or force a mode</small></span><span className="r"><span className="seg">
            {(['system', 'light', 'dark'] as Theme[]).map(value => <button key={value} className={theme === value ? 'on' : undefined} aria-pressed={theme === value} onClick={() => chooseTheme(value)}>{value[0]!.toUpperCase() + value.slice(1)}</button>)}
          </span></span></div>
        </div>
        {hasConfigs && (
          <div className="about-sec">
            <div className="about-sec-h">Claude config</div>
            <div className="about-row"><span className="tx">Active config<small>Applies to the overview data. Manage config folders with the codeburn CLI.</small></span><span className="r"><span className="set-cap">{activeConfigLabel}</span></span></div>
          </div>
        )}
        <div className="about-sec">
          <div className="about-sec-h">Display</div>
          <div className="about-row"><label className="tx" htmlFor="settings-currency">Currency</label><span className="r">
            {plans.data ? <Dropdown id="settings-currency" ariaLabel="Currency" value={plans.data.currency} options={currencies.map(code => ({ value: code, label: code }))} onChange={value => { trackEvent('settings_change', { setting: 'currency', value }); void codeburn.setCurrency(value).then(finishCurrency) }} width={92} /> : plans.error ? <SettingsErrorText error={plans.error} /> : <span className="set-cap">Loading…</span>}
            <button className="set-text-button" onClick={() => { trackEvent('settings_change', { setting: 'currency', value: 'USD' }); void codeburn.resetCurrency().then(finishCurrency) }}>Reset to USD</button>
          </span></div>
          <div className="about-row"><label className="tx" htmlFor="settings-period">Default period<small>Applied on next launch.</small></label><span className="r"><Dropdown id="settings-period" ariaLabel="Default period" value={defaultPeriod} options={[{ value: 'today', label: 'Today' }, { value: 'week', label: '7d' }, { value: '30days', label: '30d' }, { value: 'month', label: 'Month' }, { value: 'all', label: 'All' }]} onChange={value => { setDefaultPeriod(value); writeSetting('codeburn.defaultPeriod', value); trackEvent('settings_change', { setting: 'defaultPeriod', value }) }} width={92} /></span></div>
          <div className="about-row"><label className="tx" htmlFor="settings-scope">Scope<small>{projectFiltered ? 'Local only while the Projects pane hides something: paired devices report their usage unfiltered, so a combined total would carry the hidden projects.' : 'Combined aggregates usage across every paired device, like the menubar. Local shows this device only.'}</small></label><span className="r"><Dropdown id="settings-scope" ariaLabel="Scope" value={scope} options={projectFiltered ? [{ value: 'local', label: 'Local' }] : [{ value: 'local', label: 'Local' }, { value: 'combined', label: 'Combined' }]} onChange={value => onScopeChange?.(value)} width={110} /></span></div>
          <div className="about-row"><label className="tx" htmlFor="settings-refresh">Refresh every<small>Runs automatically at this interval. Press {shortcutLabel('R')} to refresh sooner.</small></label><span className="r"><Dropdown id="settings-refresh" ariaLabel="Refresh every" value={cadence.value} options={REFRESH_OPTIONS.map(option => ({ value: option.value, label: option.label }))} onChange={cadence.setValue} width={124} /></span></div>
          <div className="about-row"><label className="tx" htmlFor="settings-budget">Daily budget<small>Warns at 80%, alerts at 100%.</small></label><span className="r"><Dropdown id="settings-budget" ariaLabel="Daily budget" value={budgetKind} options={[{ value: 'off', label: 'Off' }, { value: 'usd', label: 'USD amount' }, { value: 'tokens', label: 'Tokens' }]} onChange={value => { const kind = value as 'off' | 'usd' | 'tokens'; setBudgetKind(kind); persistBudget(kind, budgetInput) }} width={120} />{budgetKind !== 'off' && <input className="set-input" type="text" inputMode="decimal" aria-label="Daily budget amount" placeholder={budgetKind === 'usd' ? 'USD' : 'tokens'} value={budgetInput} onChange={event => { setBudgetInput(event.target.value); persistBudget(budgetKind, event.target.value) }} style={{ width: 90 }} />}</span></div>
          {budgetError && <p className="set-action-msg error">{budgetError}</p>}
        </div>
        <div className="about-sec set-last-sec">
          <div className="about-sec-h">About</div>
          <div className="about-row"><span className="tx">Version {version}{updateNote && <small>{updateNote}</small>}</span><span className="r">{update?.updateAvailable && update.tag ? <button className="set-text-button" onClick={() => { void codeburn.openExternal(updateDownloadUrl(update.tag!)) }}>Download</button> : null}</span></div>
        </div>
      </div>
    </section>
  )
}

function ProvidersPane({ period, refreshToken }: { period: Period; refreshToken: number }) {
  const overview = usePolled<MenubarPayload>(() => codeburn.getOverview(period, 'all'), [period, refreshToken])
  const details = overview.data?.current.providerDetails
  // Prefer providerDetails (internal id + display label) so ProviderLogo keys on
  // the internal id. Fall back to the providers map keys (lowercased display
  // names) for older CLIs that omit providerDetails.
  const providers = details
    ? details.filter(entry => entry.hasUsage ?? true).map(entry => ({ id: entry.id, label: entry.label, cost: entry.cost }))
    : Object.entries(overview.data?.current.providers ?? {}).map(([id, cost]) => ({ id, label: id.charAt(0).toUpperCase() + id.slice(1), cost }))
  return <section className="set-p on">
    <div><h3 className="set-h">Providers</h3><p className="set-sub">codeburn auto-detects coding tools from local session files. No setup needed.</p></div>
    {overview.error ? <SettingsErrorText error={overview.error} /> : !overview.data ? <p className="set-cap">Loading detected providers…</p> : providers.length === 0 ? <p className="set-cap">No providers detected.</p> : providers.map(entry => <div className="card" key={entry.id}><div className="set-prov-head"><ProviderLogo provider={entry.id} /><span className="set-prov-name">{entry.label}</span><span className="set-status"><span className="set-dot ok" />Detected · {formatUsd(entry.cost)}</span></div></div>)}
  </section>
}

const NO_PROJECT_FILTER: ProjectFilter = { project: [], exclude: [] }

function projectVisible(project: ProjectRow, filter: ProjectFilter): boolean {
  if (filter.exclude.some(pattern => projectMatches(project, pattern))) return false
  return filter.project.length === 0 || filter.project.some(pattern => projectMatches(project, pattern))
}

function ProjectsPane({ refreshToken, onConfigMutated }: { refreshToken: number; onConfigMutated?: () => void }) {
  const [actionNonce, setActionNonce] = useState(0)
  const [pattern, setPattern] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // Lifetime, and not the period on screen: the filter applies to every screen
  // and every horizon, so a list bounded to the visible period would call a live
  // exclude an orphan and leave "Nothing is hidden." under hidden projects.
  //
  // Not keyed on refreshToken, and never on an interval: `report` is the
  // heaviest fetch in the app, a toggle cannot change an unfiltered list, and
  // the only thing that can is a project appearing, which the next open picks
  // up. The memo key goes through reportMemoKey like every other pane's.
  const report = usePolled<ProjectsReport>(() => codeburn.getUnfilteredProjects(), [], {
    memoKey: reportMemoKey('projects', 'lifetime'),
    intervalMs: null,
  })
  const saved = usePolled<ProjectFilter>(() => codeburn.getProjectFilter(), [refreshToken, actionNonce])
  const filter = saved.data ?? NO_PROJECT_FILTER
  const projects = report.data?.projects ?? []

  // One write at a time, or a second click drops the first.
  const apply = (next: ProjectFilter, clearInput = false): void => {
    if (busy) return
    setBusy(true)
    void codeburn.setProjectFilter(next).then(() => {
      setError('')
      if (clearInput) setPattern('')
      setActionNonce(value => value + 1)
      clearPolledMemo()
      onConfigMutated?.()
    }).catch(() => setError('Could not save the project filter'))
      .finally(() => setBusy(false))
  }

  const toggle = (project: ProjectRow, visible: boolean): void => {
    if (visible) {
      // Widen the include list too, or it would keep hiding what was just shown.
      const exclude = filter.exclude.filter(entry => !projectMatches(project, entry))
      const include = filter.project.length > 0 && !filter.project.some(entry => projectMatches(project, entry))
        ? [...filter.project, projectPattern(project)]
        : filter.project
      apply({ project: include, exclude })
      return
    }
    // Exclude wins over include in the CLI, so hiding is always one append.
    apply({ ...filter, exclude: [...filter.exclude, projectPattern(project)] })
  }

  const orphans = report.data ? filter.exclude.filter(entry => !projects.some(project => projectMatches(project, entry))) : []
  const hiddenCount = projects.filter(project => !projectVisible(project, filter)).length

  return <section className="set-p on">
    <div><h3 className="set-h">Projects</h3><p className="set-sub">Choose which projects the app shows. Everything else keeps being tracked, and is only hidden from these screens.</p></div>
    {filter.project.length > 0 && <div className="card"><div className="about-row">
      <span className="tx">Showing only projects matching <span className="set-mono">{filter.project.join(', ')}</span></span>
      <button className="btnp r" disabled={busy} onClick={() => apply({ ...filter, project: [] })}>Show all</button>
    </div></div>}
    <div className="card"><div className="about-sec set-last-sec">
      {report.error ? <SettingsErrorText error={report.error} />
        : saved.error ? <SettingsErrorText error={saved.error} />
        : !report.data || !saved.data ? <p className="set-cap">Loading projects…</p>
        : projects.length === 0 ? <p className="set-cap">No projects detected yet.</p>
        : projects.map(project => {
          const visible = projectVisible(project, filter)
          const pattern_ = projectPattern(project)
          return <div className="about-row" key={pattern_}>
            <span className="tx set-mono">{shortenProjectPath(project.path || project.name, 2)}<small>{pattern_}</small></span>
            <span className="r set-status"><span className="set-cap">{formatConverted(project.cost)} · {project.sessions} sessions</span></span>
            <button type="button" role="switch" aria-checked={visible} aria-label={`Show ${pattern_}`} className={visible ? 'switch on' : 'switch'} disabled={busy} onClick={() => toggle(project, !visible)}><span className="switch-knob" /></button>
          </div>
        })}
      {orphans.map(entry => <div className="about-row" key={`orphan-${entry}`}>
        <span className="tx set-mono">{entry}</span>
        <span className="r set-status">matches nothing detected</span>
        <button className="btnp" disabled={busy} onClick={() => apply({ ...filter, exclude: filter.exclude.filter(value => value !== entry) })}>Remove</button>
      </div>)}
      <div className="set-filter-form">
        <input aria-label="Hide projects matching" className="set-input set-mono" placeholder="hide projects matching…" value={pattern} onChange={event => setPattern(event.target.value)} />
        <button className="btnp btnp-primary" disabled={busy || !pattern.trim() || filter.exclude.includes(pattern.trim())} onClick={() => apply({ ...filter, exclude: [...filter.exclude, pattern.trim()] }, true)}>Hide</button>
      </div>
      {error && <p className="set-action-msg error">{error}</p>}
    </div></div>
    <p className="set-cap">{hiddenCount === 0 ? 'Nothing is hidden. ' : `${hiddenCount} project${hiddenCount === 1 ? '' : 's'} hidden. `}A full path hides just that project and anything inside it. A plain word hides everything it appears in, so “my-company” also covers its worktrees.</p>
  </section>
}

function AliasesPane({ refreshToken, onConfigMutated }: { refreshToken: number; onConfigMutated?: () => void }) {
  const [actionNonce, setActionNonce] = useState(0)
  const aliases = usePolled<AliasRow[]>(() => codeburn.getAliases(), [refreshToken, actionNonce])
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [error, setError] = useState('')
  const complete = (result: ActionResult, added = false) => {
    if (!result.ok) { setError(result.stderr || 'Alias action failed'); return }
    setError('')
    if (added) { setFrom(''); setTo('') }
    setActionNonce(value => value + 1)
    onConfigMutated?.()
  }
  return <section className="set-p on">
    <div><h3 className="set-h">Model aliases</h3><p className="set-sub">Map an unrecognized model name to a priced model so its cost shows up.</p></div>
    <div className="card"><div className="about-sec set-last-sec">
      {aliases.error ? <SettingsErrorText error={aliases.error} /> : !aliases.data ? <p className="set-cap">Loading aliases…</p> : aliases.data.length === 0 ? <p className="set-cap set-alias-empty">No aliases configured. Unknown models are priced at $0 until aliased.</p> : aliases.data.map(alias => <div className="set-alias" key={alias.from}><span className="set-mono">{alias.from}</span><span className="set-alias-ar">→</span><span className="set-mono set-alias-to">{alias.to}</span><button className="btnp" onClick={() => void codeburn.removeAlias(alias.from).then(result => complete(result))}>Remove</button></div>)}
      <div className="set-alias"><input aria-label="Unrecognized model" className="set-input set-mono" placeholder="unrecognized model" value={from} onChange={event => setFrom(event.target.value)} /><span className="set-alias-ar">→</span><input aria-label="Priced model" className="set-input set-mono" placeholder="priced model" value={to} onChange={event => setTo(event.target.value)} /><button className="btnp btnp-primary" disabled={!from.trim() || !to.trim()} onClick={() => void codeburn.addAlias(from.trim(), to.trim()).then(result => complete(result, true))}>Add</button></div>
      {error && <p className="set-action-msg error">{error}</p>}
    </div></div>
    <p className="set-cap">Unknown models are priced at $0 until aliased. A local model can instead be credited with what it would have cost via model-savings.</p>
  </section>
}

function priceRateSummary(o: PriceOverrideRow): string {
  const parts = [`in ${o.inputPerM}`, `out ${o.outputPerM}`]
  if (typeof o.cacheReadPerM === 'number') parts.push(`read ${o.cacheReadPerM}`)
  if (typeof o.cacheCreationPerM === 'number') parts.push(`create ${o.cacheCreationPerM}`)
  return parts.join(' · ')
}

// '' -> not provided; a positive finite number -> a rate; 'invalid' otherwise.
function parseRate(raw: string): number | undefined | 'invalid' {
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value <= 0) return 'invalid'
  return value
}

function PricingPane({ refreshToken, onConfigMutated }: { refreshToken: number; onConfigMutated?: () => void }) {
  const [actionNonce, setActionNonce] = useState(0)
  const overrides = usePolled<PriceOverrideList>(() => codeburn.getPriceOverrides(), [refreshToken, actionNonce])
  const [model, setModel] = useState('')
  const [input, setInput] = useState('')
  const [output, setOutput] = useState('')
  const [cacheRead, setCacheRead] = useState('')
  const [cacheCreation, setCacheCreation] = useState('')
  const [error, setError] = useState('')

  const complete = (result: ActionResult, added = false) => {
    if (!result.ok) { setError(result.stderr || 'Price override action failed'); return }
    setError('')
    if (added) { setModel(''); setInput(''); setOutput(''); setCacheRead(''); setCacheCreation('') }
    setActionNonce(value => value + 1)
    onConfigMutated?.()
  }

  const add = () => {
    const fields: Array<[keyof PriceRates, string]> = [['input', input], ['output', output], ['cacheRead', cacheRead], ['cacheCreation', cacheCreation]]
    const rates: PriceRates = {}
    for (const [key, raw] of fields) {
      const parsed = parseRate(raw)
      if (parsed === 'invalid') { setError('Rates must be positive numbers (USD per 1M tokens).'); return }
      if (parsed !== undefined) rates[key] = parsed
    }
    if (!model.trim()) { setError('Enter a model name.'); return }
    if (rates.input === undefined || rates.output === undefined) { setError('Input and output rates are required.'); return }
    setError('')
    void codeburn.setPriceOverride(model.trim(), rates).then(result => complete(result, true))
  }

  return <section className="set-p on">
    <div><h3 className="set-h">Pricing</h3><p className="set-sub">Override or add per-model rates so local or self-hosted models are priced. Rates are USD per 1,000,000 tokens.</p></div>
    <div className="card"><div className="about-sec set-last-sec">
      {overrides.error ? <SettingsErrorText error={overrides.error} /> : !overrides.data ? <p className="set-cap">Loading price overrides…</p> : overrides.data.overrides.length === 0 ? <p className="set-cap set-alias-empty">No price overrides configured. Add one below to price an unrecognized or local model.</p> : overrides.data.overrides.map(override => <div className="set-price-row" key={override.model}><span className="set-mono">{override.model}</span><span className="set-price-rates">{priceRateSummary(override)}</span><ConfirmButton label="Remove" prompt="Remove?" onConfirm={() => void codeburn.removePriceOverride(override.model).then(result => complete(result))} /></div>)}
      <div className="set-price-form">
        <input aria-label="Override model" className="set-input set-mono set-price-model" placeholder="model name" value={model} onChange={event => setModel(event.target.value)} />
        <input aria-label="Input rate" className="set-input" inputMode="decimal" placeholder="input" value={input} onChange={event => setInput(event.target.value)} />
        <input aria-label="Output rate" className="set-input" inputMode="decimal" placeholder="output" value={output} onChange={event => setOutput(event.target.value)} />
        <input aria-label="Cache read rate" className="set-input" inputMode="decimal" placeholder="cache read" value={cacheRead} onChange={event => setCacheRead(event.target.value)} />
        <input aria-label="Cache creation rate" className="set-input" inputMode="decimal" placeholder="cache create" value={cacheCreation} onChange={event => setCacheCreation(event.target.value)} />
        <button className="btnp btnp-primary" disabled={!model.trim() || !input.trim() || !output.trim()} onClick={add}>Add</button>
      </div>
      {error && <p className="set-action-msg error">{error}</p>}
    </div></div>
    <p className="set-cap">Rates are USD per 1,000,000 tokens. Input and output are required; cache read and cache creation are optional. A configured model is overridden; an unknown one is added.</p>
  </section>
}

function planSummaries(status: StatusJson): JsonPlanSummary[] {
  if (status.plans) return Object.values(status.plans).filter((plan): plan is JsonPlanSummary => Boolean(plan))
  return status.plan ? [status.plan] : []
}

function DetectedRow({ quota, enabled, onToggle, onReconnect }: { quota: QuotaProvider; enabled: boolean; onToggle: () => void; onReconnect: () => void }) {
  return <div className="about-row">
    <ProviderLogo provider={quota.provider} />
    <span className="tx">{PROVIDER_NAMES[quota.provider]}</span>
    {!enabled
      ? <span className="r set-status"><span className="set-cap">Off</span></span>
      : quota.connection === 'disconnected' || quota.connection === 'accessDenied'
      ? <div className="r set-status"><ConnectAffordance provider={quota.provider} connection={quota.connection} onRefresh={onReconnect} /></div>
      : quota.rateLimited
      ? <span className="r set-status"><span className="set-dot" />{rateLimitedNote(quota.provider)}</span>
      : quota.connection === 'terminalFailure'
      ? <span className="r set-status"><span className="set-dot" />{quota.footerLines[0] ?? 'Quota unavailable'}</span>
      : <span className="r set-status"><span className="set-dot ok" />{quota.planLabel ?? 'Connected'}</span>}
    <button type="button" role="switch" aria-checked={enabled} aria-label={`${PROVIDER_NAMES[quota.provider]} live quota`} className={enabled ? 'switch on' : 'switch'} onClick={onToggle}><span className="switch-knob" /></button>
  </div>
}

function PlansPane({ period, refreshToken, onNavigate, onConfigMutated }: { period: Period; refreshToken: number; onNavigate?: (section: Section) => void; onConfigMutated?: () => void }) {
  const [nonce, setNonce] = useState(0)
  // Steady poll serves cached quota (force=false); the Connect affordance's
  // Refresh forces a keychain-allowed fetch via the same path as Plans.tsx.
  const [reconnectNonce, setReconnectNonce] = useState(0)
  const [disabledProviders, setDisabledProviders] = useState<ProviderName[]>(() => readDisabledProviders())
  const lastForced = useRef(`${refreshToken}:${reconnectNonce}`)
  const quota = usePolled<QuotaProvider[]>(() => {
    const key = `${refreshToken}:${reconnectNonce}`
    const force = key !== lastForced.current
    lastForced.current = key
    return codeburn.getQuota(force, disabledProviders)
  }, [refreshToken, reconnectNonce, disabledProviders])
  const plans = usePolled<StatusJson>(() => codeburn.getPlans(period), [period, refreshToken, nonce], {
    memoKey: reportMemoKey('plans', period),
  })
  const [presetId, setPresetId] = useState(MANUAL_PLAN_PRESETS[0]!.id)
  const configured = plans.data ? planSummaries(plans.data) : []

  const finish = (result: ActionResult) => {
    showToast(result.ok ? (result.stdout.trim() || 'Plan updated') : (result.stderr || 'Plan action failed'), result.ok ? 'ok' : 'error')
    if (result.ok) { setNonce(value => value + 1); onConfigMutated?.() }
  }
  const remove = (plan: JsonPlanSummary) => {
    void codeburn.resetPlan(plan.provider).then(finish)
  }
  // Toggling a provider off stops polling it entirely (the main process never
  // contacts its endpoints); toggling on forces a fresh fetch so the row
  // repopulates immediately.
  const toggleProvider = (provider: ProviderName) => {
    const next = disabledProviders.includes(provider)
      ? disabledProviders.filter(item => item !== provider)
      : [...disabledProviders, provider]
    writeDisabledProviders(next)
    setDisabledProviders(next)
    setReconnectNonce(value => value + 1)
  }
  const add = () => {
    const preset = MANUAL_PLAN_PRESETS.find(item => item.id === presetId)!
    trackEvent('plan_set', { provider: preset.provider, plan: preset.id })
    void codeburn.setPlan(preset.id, preset.provider).then(finish)
  }

  return <section className="set-p on">
    <div><h3 className="set-h">Plans</h3><p className="set-sub">Claude and Codex subscriptions connect and auto-detect your tier. Set a manual budget plan for any other provider.</p></div>
    <div className="card">
      <div className="about-sec set-last-sec">
        <div className="about-sec-h">Detected subscriptions</div>
        {quota.error && !quota.data ? <SettingsErrorText error={quota.error} /> : QUOTA_PROVIDERS.map(provider => {
          const row = quota.data?.find(item => item.provider === provider)
          if (!row && !disabledProviders.includes(provider)) return null
          return <DetectedRow
            key={provider}
            quota={row ?? { provider, connection: 'disconnected', primary: null, details: [], planLabel: null, footerLines: [] }}
            enabled={!disabledProviders.includes(provider)}
            onToggle={() => toggleProvider(provider)}
            onReconnect={() => setReconnectNonce(value => value + 1)}
          />
        })}
      </div>
    </div>
    <div className="card">
      <div className="about-sec">
        <div className="about-sec-h">Budget plans (manual)</div>
        {plans.error ? <SettingsErrorText error={plans.error} /> : !plans.data ? <p className="set-cap">Loading plans…</p> : configured.length === 0 ? <p className="set-cap">No manual plans configured.</p> : configured.map(plan => <div className="about-row" key={plan.provider}><span className="tx">{PLAN_PRESETS.find(item => item.id === plan.id)?.label ?? plan.id}<small>{formatConverted(plan.budget)}/month · {plan.provider} · {plan.percentUsed}% used</small>{(plan.provider === 'claude' || plan.provider === 'codex') && <small>superseded by the detected subscription</small>}</span><span className="r"><ConfirmButton label="Remove" prompt="Remove?" onConfirm={() => remove(plan)} /></span></div>)}
      </div>
      <div className="about-sec set-last-sec">
        <div className="about-row"><label className="tx" htmlFor="settings-plan-preset">Add a plan</label><span className="r"><Dropdown id="settings-plan-preset" ariaLabel="Add a plan" value={presetId} options={MANUAL_PLAN_PRESETS.map(preset => ({ value: preset.id, label: preset.label }))} onChange={value => setPresetId(value as PlanPreset['id'])} width={160} /><button className="btnp btnp-primary" onClick={add}>Add</button></span></div>
      </div>
    </div>
    <p className="set-cap">Claude and Codex plans are detected automatically from your login. <button className="set-text-button" onClick={() => onNavigate?.('plans')}>Open Plans →</button></p>
  </section>
}

function ExportPane({ period, refreshToken }: { period: Period; refreshToken: number }) {
  const overview = usePolled<MenubarPayload>(() => codeburn.getOverview(period, 'all'), [period, refreshToken])
  const [format, setFormat] = useState<'csv' | 'json'>('csv')
  const [provider, setProvider] = useState('all')
  const [destination, setDestination] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const providers = Object.keys(overview.data?.current.providers ?? {})

  const chooseDirectory = async () => {
    const selected = await codeburn.chooseDirectory()
    if (selected) setDestination(selected)
  }
  const exportNow = async () => {
    if (!destination) return
    setExporting(true)
    try {
      // Format and provider only. The destination is a real path on this
      // machine and never leaves it.
      trackEvent('export', { format, provider })
      const result = await codeburn.exportData(format, provider, destination)
      showToast(result.ok ? `Exported to ${destination}` : (result.stderr || 'Export failed'), result.ok ? 'ok' : 'error')
    } finally {
      setExporting(false)
    }
  }

  return <section className="set-p on">
    <div><h3 className="set-h">Export</h3><p className="set-sub">Save your usage as CSV or JSON. Everything stays on your machine.</p></div>
    <div className="card">
      <div className="about-sec">
        <div className="about-row"><span className="tx">Format</span><span className="r"><span className="seg"><button className={format === 'csv' ? 'on' : undefined} aria-pressed={format === 'csv'} onClick={() => setFormat('csv')}>CSV</button><button className={format === 'json' ? 'on' : undefined} aria-pressed={format === 'json'} onClick={() => setFormat('json')}>JSON</button></span></span></div>
        <div className="about-row"><label className="tx" htmlFor="settings-export-provider">Provider</label><span className="r"><Dropdown id="settings-export-provider" ariaLabel="Provider" value={provider} options={[{ value: 'all', label: 'All providers' }, ...providers.map(value => ({ value, label: value.charAt(0).toUpperCase() + value.slice(1) }))]} onChange={setProvider} width={150} /></span></div>
        <div className="about-row"><span className="tx">Destination</span><span className="r set-export-destination"><span className="set-mono">{destination ?? 'Choose a folder…'}</span><button className="btnp" onClick={() => void chooseDirectory()}>Choose folder…</button></span></div>
      </div>
      <div className="about-sec set-last-sec"><div className="about-row"><span className="tx" /><span className="r"><button className="btnp btnp-primary" disabled={!destination || exporting} onClick={() => void exportNow()}>{exporting ? 'Exporting…' : 'Export'}</button></span></div></div>
    </div>
    <p className="set-cap">CSV writes a folder (summary, daily, models, projects, sessions, tools, mcp). JSON writes one file (schema codeburn.export.v2).</p>
  </section>
}

function DevicesPane({ period, refreshToken }: { period: Period; refreshToken: number }) {
  const [nonce, setNonce] = useState(0)
  const identity = usePolled<Identity>(() => codeburn.getIdentity(), [refreshToken])
  const shareStatus = usePolled<ShareStatus>(() => codeburn.getShareStatus(), [refreshToken])
  const scan = usePolled<DeviceScanResult>(() => codeburn.getDevicesScan(), [refreshToken, nonce])
  const devices = usePolled<CombinedUsage>(() => codeburn.getDevices(period), [period, refreshToken, nonce])
  const refresh = () => setNonce(value => value + 1)
  return <section className="set-p on"><div><h3 className="set-h">Devices</h3><p className="set-sub">Combine usage across your machines.</p></div><ThisDevicePanel identity={identity} shareStatus={shareStatus} /><DiscoveredPanel scan={scan} /><PairedPanel devices={devices} period={period} onRefresh={refresh} /></section>
}

function PrivacyPane() {
  const clearSnapshots = () => {
    clearPolledMemo()
    clearOverviewHeadlines()
    showToast('Cached report snapshots cleared', 'ok')
  }
  return <section className="set-p on"><div><h3 className="set-h">Privacy &amp; data</h3><p className="set-sub">What codeburn does, and does not do, with your data.</p></div><div className="card">
    <PrivacyClaim title="Local-only" detail="Everything runs on your machine. Data is read from local session files." icon={<><rect x="4.5" y="10" width="15" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>} />
    <PrivacyClaim title="No API keys" detail="Usage is detected from local files; no provider API keys are required." icon={<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />} />
    <div className="set-claim"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M6 7l1 14h10l1-14M9 7V4h6v3" /></svg><div style={{ flex: 1 }}><div className="set-claim-t">Local report snapshots</div><div className="set-claim-d">Calculated usage and cost reports are compressed and kept on this Mac so screens open immediately after restart. Credentials are never included.</div></div><button type="button" className="btnp" onClick={clearSnapshots}>Clear snapshots</button></div>
    <TelemetryClaim />
  </div></section>
}

/** The anonymous-telemetry consent toggle, mirroring the onboarding decision. */
function TelemetryClaim() {
  const [status, setStatus] = useState<TelemetryStatus | null>(null)
  useEffect(() => {
    if (typeof codeburn.telemetryStatus !== 'function') return
    codeburn.telemetryStatus().then(value => setStatus(value)).catch(() => {})
  }, [])
  if (!status) return null
  const toggle = () => {
    if (typeof codeburn.setTelemetryEnabled !== 'function') return
    // Only the opt-IN is reportable: turning telemetry off mints a fresh install
    // id and drops the queue, so an opt-out event would never be sent anyway.
    // And it is tracked after the switch has taken, never before: telemetry that is
    // still off drops the event on the floor, so an opt-in recorded ahead of the
    // write was one that could never be sent.
    const optingIn = !status.enabled
    codeburn.setTelemetryEnabled(optingIn).then(value => {
      setStatus(value)
      if (optingIn && value?.enabled) trackEvent('settings_change', { setting: 'telemetry', value: true })
    }).catch(() => {})
  }
  return <div className="set-claim"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19v-5M9 19V9M14 19v-8M19 19V5" /></svg><div style={{ flex: 1 }}><div className="set-claim-t">Anonymous telemetry</div><div className="set-claim-d">Optional usage statistics: model mix, task success, performance and errors. The daily report includes the names of the models, tools, skills and MCP servers you use, alongside bucketed counts of how often each one came up. Never your prompts, your code, or your project and file names.</div></div>
    <button type="button" role="switch" aria-checked={status.enabled} aria-label="Anonymous telemetry" className={status.enabled ? 'switch on' : 'switch'} onClick={toggle}><span className="switch-knob" /></button>
  </div>
}

function PrivacyClaim({ title, detail, icon }: { title: string; detail: string; icon: React.ReactNode }) {
  return <div className="set-claim"><svg viewBox="0 0 24 24" aria-hidden="true">{icon}</svg><div><div className="set-claim-t">{title}</div><div className="set-claim-d">{detail}</div></div></div>
}

function ThisDevicePanel({ identity, shareStatus }: { identity: ReturnType<typeof usePolled<Identity>>; shareStatus: ReturnType<typeof usePolled<ShareStatus>> }) {
  const status = shareStatus.data ? <span className="set-status"><span className={shareStatus.data.sharing ? 'set-dot ok' : 'set-dot'} />{shareStatus.data.sharing ? 'Visible' : 'Not sharing'}</span> : null
  return <Panel title="This device" right={status}>{identity.data ? <div className="li"><div className="lx"><b>{identity.data.name}</b><span>Local device name: {identity.data.name}</span><span>{identity.data.fingerprint}</span></div></div> : identity.error ? <SettingsErrorText error={identity.error} /> : <p className="set-cap">Reading this device identity…</p>}{shareStatus.error && <SettingsErrorText error={shareStatus.error} />}</Panel>
}

function DiscoveredPanel({ scan }: { scan: ReturnType<typeof usePolled<DeviceScanResult>> }) {
  const found = scan.data?.found.filter(device => !device.paired) ?? []
  return <Panel title="Discovered nearby" right={scan.loading ? 'listening…' : undefined}>{!scan.data && scan.error ? <SettingsErrorText error={scan.error} /> : !scan.data ? <p className="set-cap">listening…</p> : found.length === 0 ? <p className="set-cap">No nearby devices found.</p> : found.map(device => <div className="li" key={`${device.host}:${device.port}:${device.fingerprint}`}><div className="lx"><b>{device.name}</b><span>fingerprint {shortFingerprint(device.fingerprint)}</span></div></div>)}<p className="set-cap set-device-caption">To pair a device, run <code>codeburn devices add</code> in a terminal. Pairing is interactive (approve on the other device).</p></Panel>
}

function PairedPanel({ devices, period, onRefresh }: { devices: ReturnType<typeof usePolled<CombinedUsage>>; period: Period; onRefresh: () => void }) {
  const [error, setError] = useState('')
  const paired = devices.data?.perDevice.filter(device => !device.local) ?? []
  const remove = (name: string) => {
    void codeburn.removeDevice(name).then(result => {
      if (!result.ok) { setError(result.stderr || 'Unable to remove device'); return }
      setError('')
      onRefresh()
    })
  }
  return <Panel title="Paired devices" right={<button className="set-text-button" onClick={onRefresh}>Refresh</button>}>{!devices.data && devices.error ? <SettingsErrorText error={devices.error} /> : !devices.data ? <p className="set-cap">Loading paired devices…</p> : paired.length === 0 ? <p className="set-cap">No paired devices yet.</p> : paired.map(device => <div className="li" key={device.id}><div className="lx"><b>{device.name}</b><span>{device.sessions.toLocaleString('en-US')} sessions · {formatUsd(device.cost)} {periodLabel(period)}</span></div><ConfirmButton label="Remove" prompt="Remove?" onConfirm={() => remove(device.name)} /></div>)}{devices.data && devices.data.combined.deviceCount > 1 && <div className="li"><div className="lx"><b>Combined view active · {devices.data.combined.deviceCount} devices</b></div></div>}{error && <p className="set-action-msg error">{error}</p>}</Panel>
}

function SettingsErrorText({ error }: { error: CliError }) {
  if (error.kind === 'not-found') { const display = cliErrorDisplay(error); return <p className="set-cap">{display.title}</p> }
  return <CliErrorText error={error} />
}

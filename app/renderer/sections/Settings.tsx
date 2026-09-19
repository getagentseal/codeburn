import { useEffect, useMemo, useRef, useState } from 'react'

import { Hint } from '../components/Hint'
import { CliErrorText, cliErrorDisplay } from '../components/CliErrorPanel'
import { ConnectAffordance } from '../components/ConnectAffordance'
import { Dropdown } from '../components/Dropdown'
import { Panel } from '../components/Panel'
import { ProviderLogo } from '../components/ProviderLogo'
import { BarNav } from '../components/TopBar'
import type { Section } from '../components/Sidebar'
import { clearPolledMemo, usePolled } from '../hooks/usePolled'
import { updateDownloadUrl, useUpdateStatus } from '../hooks/useUpdateStatus'
import { version as appVersion } from '../../package.json'
import { readDailyBudget } from '../lib/budget'
import { formatConverted, formatCount, formatUsd, shortenProjectPath } from '../lib/format'
import { codeburn } from '../lib/ipc'
import { t, useLocale, type LocaleChoice } from '../i18n'
import { projectMatches, projectPattern } from '../lib/projectMatch'
import { shortcutLabel } from '../lib/platform'
import { motionClass } from '../lib/motion'
import { clearOverviewHeadlines } from '../lib/overviewSnapshot'
import { detectedProviders, PROVIDER_NAMES, QUOTA_PROVIDERS, readDisabledProviders, writeDisabledProviders } from '../lib/providers'
import { REFRESH_OPTIONS, useRefreshCadence } from '../lib/refreshCadence'
import { reportMemoKey } from '../lib/reportMemoKey'
import { showToast } from '../lib/toast'
import { trackEvent } from '../lib/track'
import { ToastHost } from '../components/ToastHost'
import { rateLimitedNote } from './Plans'
import { SharingPane } from './SettingsSharing'
import { CapacityDockPane, MenuBarPane } from './SettingsTray'
import type { ActionResult, AliasRow, ClaudeConfigSelector, CompanionStatus, CliError, CombinedUsage, DeviceScanResult, Identity, JsonPlanSummary, MenubarPayload, Period, PlanId, PlanProvider, PriceOverrideList, PriceOverrideRow, PriceRates, ProjectFilter, ProjectRow, ProjectsReport, ProviderName, QuotaProvider, Scope, ShareStatus, StatusJson, TelemetryStatus } from '../lib/types'
import { Icon } from '../components/icons'

export type SettingsPane = 'general' | 'providers' | 'projects' | 'aliases' | 'pricing' | 'plans' | 'devices' | 'export' | 'privacy' | 'sharing' | 'menubar' | 'dock'
type Pane = SettingsPane
type Theme = 'system' | 'light' | 'dark'

// Each label in its own language, System in the app's language. Stage 1 renders
// English everywhere else; only these picker labels localize.
function languageOptions(): { value: LocaleChoice; label: string }[] {
  return [
    { value: 'system', label: t('settings.language.system') },
    { value: 'en', label: 'English' },
    { value: 'fr', label: 'Français' },
    { value: 'ja', label: '日本語' },
    { value: 'ko', label: '한국어' },
    { value: 'zh-CN', label: '简体中文' },
    { value: 'zh-TW', label: '繁體中文' },
  ]
}

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

const RAIL_ITEMS: Array<{ id: Pane; labelKey: string; icon: React.ReactNode }> = [
  { id: 'general', labelKey: 'settings.rail.general', icon: <Icon name="sliders-horizontal" /> },
  { id: 'providers', labelKey: 'settings.rail.providers', icon: <Icon name="layout-grid" /> },
  { id: 'projects', labelKey: 'settings.rail.projects', icon: <Icon name="folder" /> },
  { id: 'aliases', labelKey: 'settings.rail.aliases', icon: <Icon name="tag" /> },
  { id: 'pricing', labelKey: 'settings.rail.pricing', icon: <Icon name="circle-dollar-sign" /> },
  { id: 'plans', labelKey: 'settings.rail.plans', icon: <Icon name="credit-card" /> },
  { id: 'devices', labelKey: 'settings.rail.devices', icon: <Icon name="monitor-smartphone" /> },
  { id: 'export', labelKey: 'settings.rail.export', icon: <Icon name="download" /> },
  { id: 'sharing', labelKey: 'settings.rail.sharing', icon: <Icon name="refresh-cw" /> },
  { id: 'privacy', labelKey: 'settings.rail.privacy', icon: <Icon name="shield" /> },
]

/// Appended to the rail only while the matching switch in the sidebar corner is on.
const TRAY_RAIL_ITEMS: Record<'menubar' | 'dock', { id: Pane; labelKey: string; icon: React.ReactNode }> = {
  menubar: { id: 'menubar', labelKey: 'settings.rail.menubar', icon: <Icon name="panel-top" /> },
  dock: { id: 'dock', labelKey: 'settings.rail.dock', icon: <Icon name="panel-right" /> },
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
  if (period === 'today') return t('settings.periodLabel.today')
  if (period === 'week') return t('settings.periodLabel.week')
  if (period === 'month') return t('settings.periodLabel.month')
  if (period === '30days') return t('settings.periodLabel.thirtyDays')
  return t('settings.periodLabel.allTime')
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
      <button className="set-text-button" autoFocus onClick={() => { setConfirming(false); onConfirm() }}>{t('settings.confirm.confirm')}</button>
      <button className="set-text-button" onClick={() => setConfirming(false)}>{t('settings.confirm.cancel')}</button>
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
      <div className="bar"><BarNav /><h1 className="t">{t('settings.title')}</h1></div>
      <ToastHost />
      <div className={motionClass('body set-body', 'section-fade')}>
        <nav className="set-rail" aria-label={t('settings.rail.ariaLabel')}>
          {railItems.map(item => (
            <button key={item.id} className={pane === item.id ? 'set-rail-item on' : 'set-rail-item'} aria-current={pane === item.id ? 'page' : undefined} onClick={() => setPane(item.id)}>
              {item.icon}{t(item.labelKey)}
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
      <Hint items={[{ k: shortcutLabel('1-9'), label: t('settings.hint.navigate') }, { k: shortcutLabel(','), label: t('settings.hint.settings') }, { k: shortcutLabel('R'), label: t('settings.hint.refresh') }]} right={t('settings.hint.pairing')} />
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
    // No saved choice defaults to light (a fresh install), not to the OS setting; an explicit
    // "system" choice is kept.
    return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'light'
  })
  const [defaultPeriod, setDefaultPeriod] = useState(() => readSetting('codeburn.defaultPeriod') ?? 'today')
  const { choice: languageChoice, setChoice: setLanguageChoice } = useLocale()
  const cadence = useRefreshCadence()
  const [budgetKind, setBudgetKind] = useState<'off' | 'usd' | 'tokens'>(() => readDailyBudget()?.kind ?? 'off')
  const [budgetInput, setBudgetInput] = useState(() => { const budget = readDailyBudget(); return budget ? String(budget.value) : '' })
  const [budgetError, setBudgetError] = useState('')
  const update = useUpdateStatus()
  const version = update?.currentVersion || appVersion
  const updateNote = update?.updateAvailable && update.latestVersion
    ? t('settings.update.available', { version: update.latestVersion })
    : update?.latestVersion
    ? t('settings.update.upToDate')
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
    if (!Number.isFinite(value) || value <= 0) { setBudgetError(t('settings.budget.error')); return }
    setBudgetError('')
    writeSetting('codeburn.dailyBudget', JSON.stringify({ kind, value }))
  }

  const chooseTheme = (next: Theme) => {
    setTheme(next)
    writeSetting('codeburn.theme', next)
    trackEvent('settings_change', { setting: 'theme', value: next })
  }
  const finishCurrency = (result: ActionResult) => {
    showToast(result.ok ? t('settings.toast.updated') : result.stderr || t('settings.toast.currencyError'), result.ok ? 'ok' : 'error')
    if (result.ok) { setCurrencyNonce(value => value + 1); onConfigMutated?.() }
  }
  const currencies = [...CURRENCIES]
  if (plans.data?.currency && !currencies.includes(plans.data.currency)) currencies.push(plans.data.currency)
  const hasConfigs = Boolean(claudeConfigs && claudeConfigs.options.length > 0)
  const activeConfigLabel = claudeConfigSource
    ? claudeConfigs?.options.find(option => option.id === claudeConfigSource)?.label ?? claudeConfigSource
    : t('settings.claudeConfig.all')

  return (
    <section className="set-p on">
      <div><h3 className="set-h">{t('settings.general.heading')}</h3><p className="set-sub">{t('settings.general.subtitle')}</p></div>
      <div className="card">
        <div className="about-sec">
          <div className="about-sec-h">{t('settings.section.appearance')}</div>
          <div className="about-row"><span className="tx">{t('settings.theme.label')}<small>{t('settings.theme.hint')}</small></span><span className="r"><span className="seg">
            {(['system', 'light', 'dark'] as Theme[]).map(value => <button key={value} className={theme === value ? 'on' : undefined} aria-pressed={theme === value} onClick={() => chooseTheme(value)}>{t(`settings.theme.option.${value}`)}</button>)}
          </span></span></div>
          <div className="about-row"><label className="tx" htmlFor="settings-language">{t('settings.language.label')}<small>{t('settings.language.hint')}</small></label><span className="r"><Dropdown id="settings-language" ariaLabel={t('settings.language.label')} value={languageChoice} options={languageOptions()} onChange={value => { setLanguageChoice(value as LocaleChoice); trackEvent('settings_change', { setting: 'language', value }) }} width={140} /></span></div>
        </div>
        {hasConfigs && (
          <div className="about-sec">
            <div className="about-sec-h">{t('settings.section.claudeConfig')}</div>
            <div className="about-row"><span className="tx">{t('settings.claudeConfig.activeLabel')}<small>{t('settings.claudeConfig.hint')}</small></span><span className="r"><span className="set-cap">{activeConfigLabel}</span></span></div>
          </div>
        )}
        <div className="about-sec">
          <div className="about-sec-h">{t('settings.section.display')}</div>
          <div className="about-row"><label className="tx" htmlFor="settings-currency">{t('settings.currency.label')}</label><span className="r">
            <button className="set-text-button" onClick={() => { trackEvent('settings_change', { setting: 'currency', value: 'USD' }); void codeburn.resetCurrency().then(finishCurrency) }}>{t('settings.currency.reset')}</button>
            {plans.data ? <Dropdown id="settings-currency" ariaLabel={t('settings.currency.label')} value={plans.data.currency} options={currencies.map(code => ({ value: code, label: code }))} onChange={value => { trackEvent('settings_change', { setting: 'currency', value }); void codeburn.setCurrency(value).then(finishCurrency) }} width={92} /> : plans.error ? <SettingsErrorText error={plans.error} /> : <span className="set-cap">{t('settings.loading')}</span>}
          </span></div>
          <div className="about-row"><label className="tx" htmlFor="settings-period">{t('settings.period.label')}<small>{t('settings.period.hint')}</small></label><span className="r"><Dropdown id="settings-period" ariaLabel={t('settings.period.label')} value={defaultPeriod} options={[{ value: 'today', label: t('settings.period.option.today') }, { value: 'week', label: '7d' }, { value: '30days', label: '30d' }, { value: 'month', label: t('settings.period.option.month') }, { value: 'all', label: t('settings.period.option.all') }]} onChange={value => { setDefaultPeriod(value); writeSetting('codeburn.defaultPeriod', value); trackEvent('settings_change', { setting: 'defaultPeriod', value }) }} width={92} /></span></div>
          <div className="about-row"><label className="tx" htmlFor="settings-scope">{t('settings.scope.label')}<small>{projectFiltered ? t('settings.scope.hintFiltered') : t('settings.scope.hintDefault')}</small></label><span className="r"><Dropdown id="settings-scope" ariaLabel={t('settings.scope.label')} value={scope} options={projectFiltered ? [{ value: 'local', label: t('settings.scope.option.local') }] : [{ value: 'local', label: t('settings.scope.option.local') }, { value: 'combined', label: t('settings.scope.option.combined') }]} onChange={value => onScopeChange?.(value)} width={110} /></span></div>
          <div className="about-row"><label className="tx" htmlFor="settings-refresh">{t('settings.refresh.label')}<small>{t('settings.refresh.hint', { key: shortcutLabel('R') })}</small></label><span className="r"><Dropdown id="settings-refresh" ariaLabel={t('settings.refresh.label')} value={cadence.value} options={REFRESH_OPTIONS.map(option => ({ value: option.value, label: option.label }))} onChange={cadence.setValue} width={124} /></span></div>
          <div className="about-row"><label className="tx" htmlFor="settings-budget">{t('settings.budget.label')}<small>{t('settings.budget.hint')}</small></label><span className="r"><Dropdown id="settings-budget" ariaLabel={t('settings.budget.label')} value={budgetKind} options={[{ value: 'off', label: t('settings.budget.option.off') }, { value: 'usd', label: t('settings.budget.option.usd') }, { value: 'tokens', label: t('settings.budget.option.tokens') }]} onChange={value => { const kind = value as 'off' | 'usd' | 'tokens'; setBudgetKind(kind); persistBudget(kind, budgetInput) }} width={120} />{budgetKind !== 'off' && <input className="set-input" type="text" inputMode="decimal" aria-label={t('settings.budget.amountAriaLabel')} placeholder={budgetKind === 'usd' ? 'USD' : t('settings.budget.placeholderTokens')} value={budgetInput} onChange={event => { setBudgetInput(event.target.value); persistBudget(budgetKind, event.target.value) }} style={{ width: 90 }} />}</span></div>
          {budgetError && <p className="set-action-msg error">{budgetError}</p>}
        </div>
        <div className="about-sec set-last-sec">
          <div className="about-sec-h">{t('settings.section.about')}</div>
          <div className="about-row"><span className="tx">{t('settings.about.version', { version })}{updateNote && <small>{updateNote}</small>}</span><span className="r">{update?.updateAvailable && update.tag ? <button className="set-text-button" onClick={() => { void codeburn.openExternal(updateDownloadUrl(update.tag!)) }}>{t('settings.about.download')}</button> : null}</span></div>
        </div>
      </div>
    </section>
  )
}

function ProvidersPane({ period, refreshToken }: { period: Period; refreshToken: number }) {
  const overview = usePolled<MenubarPayload>(() => codeburn.getOverview(period, 'all'), [period, refreshToken])
  const providers = detectedProviders(overview.data?.current)
  return <section className="set-p on">
    <div><h3 className="set-h">{t('settings.providers.heading')}</h3><p className="set-sub">{t('settings.providers.subtitle')}</p></div>
    {overview.error ? <SettingsErrorText error={overview.error} /> : !overview.data ? <p className="set-cap">{t('settings.providers.loading')}</p> : providers.length === 0 ? <p className="set-cap">{t('settings.providers.empty')}</p> : providers.map(entry => <div className="card" key={entry.id}><div className="set-prov-head"><ProviderLogo provider={entry.id} /><span className="set-prov-name">{entry.label}</span><span className="set-status"><span className={entry.idle ? 'set-dot' : 'set-dot ok'} />{entry.idle ? t('settings.providers.idle') : t('settings.providers.detected', { cost: formatUsd(entry.cost) })}</span></div></div>)}
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
  const [search, setSearch] = useState('')
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
  // Costliest first: a lifetime list runs to thousands of rows here, and the
  // ones worth hiding are the ones with spend on them.
  const projects = useMemo(
    () => [...(report.data?.projects ?? [])].sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0)),
    [report.data],
  )
  const needle = search.trim().toLowerCase()
  const shown = needle
    ? projects.filter(project => project.name.toLowerCase().includes(needle) || project.path.toLowerCase().includes(needle))
    : projects

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
    }).catch(() => setError(t('settings.projects.saveError')))
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
    <div><h3 className="set-h">{t('settings.projects.heading')}</h3><p className="set-sub">{t('settings.projects.subtitle')}</p></div>
    {filter.project.length > 0 && <div className="card"><div className="about-row">
      <span className="tx">{t('settings.projects.matchingPrefix')} <span className="set-mono">{filter.project.join(', ')}</span></span>
      <button className="btnp r" disabled={busy} onClick={() => apply({ ...filter, project: [] })}>{t('settings.projects.showAll')}</button>
    </div></div>}
    <div className="card"><div className="about-sec set-last-sec">
      {projects.length > 0 && <div className="set-filter-form set-search-form">
        <input aria-label={t('settings.projects.searchAriaLabel')} className="set-input set-mono" placeholder={t('settings.projects.searchPlaceholder')} value={search} onChange={event => setSearch(event.target.value)} />
        {needle && <span className="set-cap">{t('settings.projects.countOf', { shown: shown.length.toLocaleString(), total: projects.length.toLocaleString() })}</span>}
      </div>}
      {report.error ? <SettingsErrorText error={report.error} />
        : saved.error ? <SettingsErrorText error={saved.error} />
        : !report.data || !saved.data ? <p className="set-cap">{t('settings.projects.loading')}</p>
        : projects.length === 0 ? <p className="set-cap">{t('settings.projects.emptyNone')}</p>
        : shown.length === 0 ? <p className="set-cap">{t('settings.projects.emptySearch')}</p>
        : shown.map(project => {
          const visible = projectVisible(project, filter)
          const pattern_ = projectPattern(project)
          return <div className="about-row" key={pattern_}>
            <span className="tx set-mono">{shortenProjectPath(project.path || project.name, 2)}<small>{pattern_}</small></span>
            <span className="r set-status"><span className="set-cap">{formatConverted(project.cost)} · {formatCount(project.sessions, 'session')}</span></span>
            <button type="button" role="switch" aria-checked={visible} aria-label={t('settings.projects.showAriaLabel', { pattern: pattern_ })} className={visible ? 'switch on' : 'switch'} disabled={busy} onClick={() => toggle(project, !visible)}><span className="switch-knob" /></button>
          </div>
        })}
      {orphans.map(entry => <div className="about-row" key={`orphan-${entry}`}>
        <span className="tx set-mono">{entry}</span>
        <span className="r set-status">{t('settings.projects.orphanNote')}</span>
        <button className="btnp" disabled={busy} onClick={() => apply({ ...filter, exclude: filter.exclude.filter(value => value !== entry) })}>{t('settings.action.remove')}</button>
      </div>)}
      <div className="set-filter-form">
        <input aria-label={t('settings.projects.hideAriaLabel')} className="set-input set-mono" placeholder={t('settings.projects.hidePlaceholder')} value={pattern} onChange={event => setPattern(event.target.value)} />
        <button className="btnp btnp-primary" disabled={busy || !pattern.trim() || filter.exclude.includes(pattern.trim())} onClick={() => apply({ ...filter, exclude: [...filter.exclude, pattern.trim()] }, true)}>{t('settings.projects.hideButton')}</button>
      </div>
      {error && <p className="set-action-msg error">{error}</p>}
    </div></div>
    <p className="set-cap">{hiddenCount === 0 ? t('settings.projects.hiddenNone') : hiddenCount === 1 ? t('settings.projects.hiddenSingular', { count: hiddenCount }) : t('settings.projects.hiddenPlural', { count: hiddenCount })}{t('settings.projects.hint')}</p>
  </section>
}

function AliasesPane({ refreshToken, onConfigMutated }: { refreshToken: number; onConfigMutated?: () => void }) {
  const [actionNonce, setActionNonce] = useState(0)
  const aliases = usePolled<AliasRow[]>(() => codeburn.getAliases(), [refreshToken, actionNonce])
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [error, setError] = useState('')
  const complete = (result: ActionResult, added = false) => {
    if (!result.ok) { setError(result.stderr || t('settings.aliases.actionFailed')); return }
    setError('')
    if (added) { setFrom(''); setTo('') }
    setActionNonce(value => value + 1)
    onConfigMutated?.()
  }
  return <section className="set-p on">
    <div><h3 className="set-h">{t('settings.aliases.heading')}</h3><p className="set-sub">{t('settings.aliases.subtitle')}</p></div>
    <div className="card"><div className="about-sec set-last-sec">
      {aliases.error ? <SettingsErrorText error={aliases.error} /> : !aliases.data ? <p className="set-cap">{t('settings.aliases.loading')}</p> : aliases.data.length === 0 ? <p className="set-cap set-alias-empty">{t('settings.aliases.empty')}</p> : aliases.data.map(alias => <div className="set-alias" key={alias.from}><span className="set-mono">{alias.from}</span><span className="set-alias-ar">→</span><span className="set-mono set-alias-to">{alias.to}</span><button className="btnp" onClick={() => void codeburn.removeAlias(alias.from).then(result => complete(result))}>{t('settings.action.remove')}</button></div>)}
      <div className="set-alias"><input aria-label={t('settings.aliases.fromAriaLabel')} className="set-input set-mono" placeholder={t('settings.aliases.fromPlaceholder')} value={from} onChange={event => setFrom(event.target.value)} /><span className="set-alias-ar">→</span><input aria-label={t('settings.aliases.toAriaLabel')} className="set-input set-mono" placeholder={t('settings.aliases.toPlaceholder')} value={to} onChange={event => setTo(event.target.value)} /><button className="btnp btnp-primary" disabled={!from.trim() || !to.trim()} onClick={() => void codeburn.addAlias(from.trim(), to.trim()).then(result => complete(result, true))}>{t('settings.action.add')}</button></div>
      {error && <p className="set-action-msg error">{error}</p>}
    </div></div>
    <p className="set-cap">{t('settings.aliases.hint')}</p>
  </section>
}

function priceRateSummary(o: PriceOverrideRow): string {
  const parts = [t('settings.pricing.rateIn', { value: o.inputPerM }), t('settings.pricing.rateOut', { value: o.outputPerM })]
  if (typeof o.cacheReadPerM === 'number') parts.push(t('settings.pricing.rateRead', { value: o.cacheReadPerM }))
  if (typeof o.cacheCreationPerM === 'number') parts.push(t('settings.pricing.rateCreate', { value: o.cacheCreationPerM }))
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
    if (!result.ok) { setError(result.stderr || t('settings.pricing.actionFailed')); return }
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
      if (parsed === 'invalid') { setError(t('settings.pricing.invalidRate')); return }
      if (parsed !== undefined) rates[key] = parsed
    }
    if (!model.trim()) { setError(t('settings.pricing.modelRequired')); return }
    if (rates.input === undefined || rates.output === undefined) { setError(t('settings.pricing.ratesRequired')); return }
    setError('')
    void codeburn.setPriceOverride(model.trim(), rates).then(result => complete(result, true))
  }

  return <section className="set-p on">
    <div><h3 className="set-h">{t('settings.pricing.heading')}</h3><p className="set-sub">{t('settings.pricing.subtitle')}</p></div>
    <div className="card"><div className="about-sec set-last-sec">
      {overrides.error ? <SettingsErrorText error={overrides.error} /> : !overrides.data ? <p className="set-cap">{t('settings.pricing.loading')}</p> : overrides.data.overrides.length === 0 ? <p className="set-cap set-alias-empty">{t('settings.pricing.empty')}</p> : overrides.data.overrides.map(override => <div className="set-price-row" key={override.model}><span className="set-mono">{override.model}</span><span className="set-price-rates">{priceRateSummary(override)}</span><ConfirmButton label={t('settings.action.remove')} prompt={t('settings.confirm.removePrompt')} onConfirm={() => void codeburn.removePriceOverride(override.model).then(result => complete(result))} /></div>)}
      <div className="set-price-form">
        <input aria-label={t('settings.pricing.modelAriaLabel')} className="set-input set-mono set-price-model" placeholder={t('settings.pricing.modelPlaceholder')} value={model} onChange={event => setModel(event.target.value)} />
        <input aria-label={t('settings.pricing.inputAriaLabel')} className="set-input" inputMode="decimal" placeholder={t('settings.pricing.inputPlaceholder')} value={input} onChange={event => setInput(event.target.value)} />
        <input aria-label={t('settings.pricing.outputAriaLabel')} className="set-input" inputMode="decimal" placeholder={t('settings.pricing.outputPlaceholder')} value={output} onChange={event => setOutput(event.target.value)} />
        <input aria-label={t('settings.pricing.cacheReadAriaLabel')} className="set-input" inputMode="decimal" placeholder={t('settings.pricing.cacheReadPlaceholder')} value={cacheRead} onChange={event => setCacheRead(event.target.value)} />
        <input aria-label={t('settings.pricing.cacheCreateAriaLabel')} className="set-input" inputMode="decimal" placeholder={t('settings.pricing.cacheCreatePlaceholder')} value={cacheCreation} onChange={event => setCacheCreation(event.target.value)} />
        <button className="btnp btnp-primary" disabled={!model.trim() || !input.trim() || !output.trim()} onClick={add}>{t('settings.action.add')}</button>
      </div>
      {error && <p className="set-action-msg error">{error}</p>}
    </div></div>
    <p className="set-cap">{t('settings.pricing.hint')}</p>
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
      ? <span className="r set-status"><span className="set-cap">{t('settings.plans.providerOff')}</span></span>
      : quota.connection === 'disconnected' || quota.connection === 'accessDenied'
      ? <div className="r set-status"><ConnectAffordance provider={quota.provider} connection={quota.connection} onRefresh={onReconnect} /></div>
      : quota.rateLimited
      ? <span className="r set-status"><span className="set-dot" />{rateLimitedNote(quota.provider)}</span>
      : quota.connection === 'terminalFailure'
      ? <span className="r set-status"><span className="set-dot" />{quota.footerLines[0] ?? t('settings.plans.quotaUnavailable')}</span>
      : <span className="r set-status"><span className="set-dot ok" />{quota.planLabel ?? t('settings.plans.connected')}</span>}
    <button type="button" role="switch" aria-checked={enabled} aria-label={t('settings.plans.liveQuotaAriaLabel', { provider: PROVIDER_NAMES[quota.provider] })} className={enabled ? 'switch on' : 'switch'} onClick={onToggle}><span className="switch-knob" /></button>
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
    showToast(result.ok ? (result.stdout.trim() || t('settings.plans.updated')) : (result.stderr || t('settings.plans.actionFailed')), result.ok ? 'ok' : 'error')
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
    <div><h3 className="set-h">{t('settings.plans.heading')}</h3><p className="set-sub">{t('settings.plans.subtitle')}</p></div>
    <div className="card">
      <div className="about-sec set-last-sec">
        <div className="about-sec-h">{t('settings.plans.detectedHeading')}</div>
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
        <div className="about-sec-h">{t('settings.plans.manualHeading')}</div>
        {plans.error ? <SettingsErrorText error={plans.error} /> : !plans.data ? <p className="set-cap">{t('settings.plans.loading')}</p> : configured.length === 0 ? <p className="set-cap">{t('settings.plans.emptyManual')}</p> : configured.map(plan => <div className="about-row" key={plan.provider}><span className="tx">{PLAN_PRESETS.find(item => item.id === plan.id)?.label ?? plan.id}<small>{t('settings.plans.perMonth', { budget: formatConverted(plan.budget) })} · {plan.provider} · {t('settings.plans.percentUsed', { percent: plan.percentUsed })}</small>{(plan.provider === 'claude' || plan.provider === 'codex') && <small>{t('settings.plans.superseded')}</small>}</span><span className="r"><ConfirmButton label={t('settings.action.remove')} prompt={t('settings.confirm.removePrompt')} onConfirm={() => remove(plan)} /></span></div>)}
      </div>
      <div className="about-sec set-last-sec">
        <div className="about-row"><label className="tx" htmlFor="settings-plan-preset">{t('settings.plans.addLabel')}</label><span className="r"><Dropdown id="settings-plan-preset" ariaLabel={t('settings.plans.addLabel')} value={presetId} options={MANUAL_PLAN_PRESETS.map(preset => ({ value: preset.id, label: preset.label }))} onChange={value => setPresetId(value as PlanPreset['id'])} width={160} /><button className="btnp btnp-primary" onClick={add}>{t('settings.action.add')}</button></span></div>
      </div>
    </div>
    <p className="set-cap">{t('settings.plans.footerNote')} <button className="set-text-button" onClick={() => onNavigate?.('plans')}>{t('settings.plans.openPlans')}</button></p>
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
      showToast(result.ok ? t('settings.export.exported', { destination }) : (result.stderr || t('settings.export.failed')), result.ok ? 'ok' : 'error')
    } finally {
      setExporting(false)
    }
  }

  return <section className="set-p on">
    <div><h3 className="set-h">{t('settings.export.heading')}</h3><p className="set-sub">{t('settings.export.subtitle')}</p></div>
    <div className="card">
      <div className="about-sec">
        <div className="about-row"><span className="tx">{t('settings.export.formatLabel')}</span><span className="r"><span className="seg"><button className={format === 'csv' ? 'on' : undefined} aria-pressed={format === 'csv'} onClick={() => setFormat('csv')}>CSV</button><button className={format === 'json' ? 'on' : undefined} aria-pressed={format === 'json'} onClick={() => setFormat('json')}>JSON</button></span></span></div>
        <div className="about-row"><label className="tx" htmlFor="settings-export-provider">{t('settings.export.providerLabel')}</label><span className="r"><Dropdown id="settings-export-provider" ariaLabel={t('settings.export.providerLabel')} value={provider} options={[{ value: 'all', label: t('settings.export.allProviders') }, ...providers.map(value => ({ value, label: value.charAt(0).toUpperCase() + value.slice(1) }))]} onChange={setProvider} width={150} /></span></div>
        <div className="about-row"><span className="tx">{t('settings.export.destinationLabel')}</span><span className="r set-export-destination"><span className="set-mono">{destination ?? t('settings.export.noDestination')}</span><button className="btnp" onClick={() => void chooseDirectory()}>{t('settings.export.chooseFolder')}</button></span></div>
      </div>
      <div className="about-sec set-last-sec"><div className="about-row"><span className="tx" /><span className="r"><button className="btnp btnp-primary" disabled={!destination || exporting} onClick={() => void exportNow()}>{exporting ? t('settings.export.exporting') : t('settings.export.exportButton')}</button></span></div></div>
    </div>
    <p className="set-cap">{t('settings.export.hint')}</p>
  </section>
}

function DevicesPane({ period, refreshToken }: { period: Period; refreshToken: number }) {
  const [nonce, setNonce] = useState(0)
  const identity = usePolled<Identity>(() => codeburn.getIdentity(), [refreshToken])
  const shareStatus = usePolled<ShareStatus>(() => codeburn.getShareStatus(), [refreshToken])
  const scan = usePolled<DeviceScanResult>(() => codeburn.getDevicesScan(), [refreshToken, nonce])
  const devices = usePolled<CombinedUsage>(() => codeburn.getDevices(period), [period, refreshToken, nonce])
  const refresh = () => setNonce(value => value + 1)
  return <section className="set-p on"><div><h3 className="set-h">{t('settings.devices.heading')}</h3><p className="set-sub">{t('settings.devices.subtitle')}</p></div><ThisDevicePanel identity={identity} shareStatus={shareStatus} /><DiscoveredPanel scan={scan} /><PairedPanel devices={devices} period={period} onRefresh={refresh} /></section>
}

function PrivacyPane() {
  const clearSnapshots = () => {
    clearPolledMemo()
    clearOverviewHeadlines()
    showToast(t('settings.privacy.snapshotsCleared'), 'ok')
  }
  return <section className="set-p on"><div><h3 className="set-h">{t('settings.privacy.heading')}</h3><p className="set-sub">{t('settings.privacy.subtitle')}</p></div><div className="card">
    <PrivacyClaim title={t('settings.privacy.localOnly.title')} detail={t('settings.privacy.localOnly.detail')} icon={<><rect x="4.5" y="10" width="15" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>} />
    <PrivacyClaim title={t('settings.privacy.noApiKeys.title')} detail={t('settings.privacy.noApiKeys.detail')} icon={<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />} />
    <div className="set-claim"><Icon name="trash-2" /><div style={{ flex: 1 }}><div className="set-claim-t">{t('settings.privacy.snapshots.title')}</div><div className="set-claim-d">{t('settings.privacy.snapshots.detail')}</div></div><button type="button" className="btnp" onClick={clearSnapshots}>{t('settings.privacy.clearButton')}</button></div>
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
  return <div className="set-claim"><Icon name="chart-column" /><div style={{ flex: 1 }}><div className="set-claim-t">{t('settings.privacy.telemetry.title')}</div><div className="set-claim-d">{t('settings.privacy.telemetry.detail')}</div></div>
    <button type="button" role="switch" aria-checked={status.enabled} aria-label={t('settings.privacy.telemetry.title')} className={status.enabled ? 'switch on' : 'switch'} onClick={toggle}><span className="switch-knob" /></button>
  </div>
}

function PrivacyClaim({ title, detail, icon }: { title: string; detail: string; icon: React.ReactNode }) {
  return <div className="set-claim">{icon}<div><div className="set-claim-t">{title}</div><div className="set-claim-d">{detail}</div></div></div>
}

function ThisDevicePanel({ identity, shareStatus }: { identity: ReturnType<typeof usePolled<Identity>>; shareStatus: ReturnType<typeof usePolled<ShareStatus>> }) {
  const status = shareStatus.data ? <span className="set-status"><span className={shareStatus.data.sharing ? 'set-dot ok' : 'set-dot'} />{shareStatus.data.sharing ? t('settings.devices.visible') : t('settings.devices.notSharing')}</span> : null
  return <Panel title={t('settings.devices.thisDeviceTitle')} right={status}>{identity.data ? <div className="li"><div className="lx"><b>{identity.data.name}</b><span>{t('settings.devices.localName', { name: identity.data.name })}</span><span>{identity.data.fingerprint}</span></div></div> : identity.error ? <SettingsErrorText error={identity.error} /> : <p className="set-cap">{t('settings.devices.readingIdentity')}</p>}{shareStatus.error && <SettingsErrorText error={shareStatus.error} />}</Panel>
}

function DiscoveredPanel({ scan }: { scan: ReturnType<typeof usePolled<DeviceScanResult>> }) {
  const found = scan.data?.found.filter(device => !device.paired) ?? []
  return <Panel title={t('settings.devices.discoveredTitle')} right={scan.loading ? t('settings.devices.listening') : undefined}>{!scan.data && scan.error ? <SettingsErrorText error={scan.error} /> : !scan.data ? <p className="set-cap">{t('settings.devices.listening')}</p> : found.length === 0 ? <p className="set-cap">{t('settings.devices.noneFound')}</p> : found.map(device => <div className="li" key={`${device.host}:${device.port}:${device.fingerprint}`}><div className="lx"><b>{device.name}</b><span>{t('settings.devices.fingerprint', { fingerprint: shortFingerprint(device.fingerprint) })}</span></div></div>)}<p className="set-cap set-device-caption">{t('settings.devices.pairPrefix')} <code>codeburn devices add</code> {t('settings.devices.pairSuffix')}</p></Panel>
}

function PairedPanel({ devices, period, onRefresh }: { devices: ReturnType<typeof usePolled<CombinedUsage>>; period: Period; onRefresh: () => void }) {
  const [error, setError] = useState('')
  const paired = devices.data?.perDevice.filter(device => !device.local) ?? []
  const remove = (name: string) => {
    void codeburn.removeDevice(name).then(result => {
      if (!result.ok) { setError(result.stderr || t('settings.devices.removeFailed')); return }
      setError('')
      onRefresh()
    })
  }
  return <Panel title={t('settings.devices.pairedTitle')} right={<button className="set-text-button" onClick={onRefresh}>{t('settings.devices.refreshButton')}</button>}>{!devices.data && devices.error ? <SettingsErrorText error={devices.error} /> : !devices.data ? <p className="set-cap">{t('settings.devices.loadingPaired')}</p> : paired.length === 0 ? <p className="set-cap">{t('settings.devices.noPaired')}</p> : paired.map(device => <div className="li" key={device.id}><div className="lx"><b>{device.name}</b><span>{formatCount(device.sessions, 'session')} · {formatUsd(device.cost)} {periodLabel(period)}</span></div><ConfirmButton label={t('settings.action.remove')} prompt={t('settings.confirm.removePrompt')} onConfirm={() => remove(device.name)} /></div>)}{devices.data && devices.data.combined.deviceCount > 1 && <div className="li"><div className="lx"><b>{t('settings.devices.combinedActive')} · {formatCount(devices.data.combined.deviceCount, 'device')}</b></div></div>}{error && <p className="set-action-msg error">{error}</p>}</Panel>
}

function SettingsErrorText({ error }: { error: CliError }) {
  if (error.kind === 'not-found') { const display = cliErrorDisplay(error); return <p className="set-cap">{display.title}</p> }
  return <CliErrorText error={error} />
}

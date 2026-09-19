import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

import type { MenubarPayload } from './lib/payload'
import type { CurrencyState } from './lib/currency'
import { USD, formatCurrency, formatTokens, plural, trayBadgeText } from './lib/currency'
import { PayloadCache, sameSelection, selectionKey, type Selection } from './lib/cache'
import { relativePast } from './lib/dates'
import { applyTheme, readSetting, writeSetting } from './lib/settings'
import {
  DEFAULT_SETTINGS, MENUBAR_PERIODS, MENUBAR_SUFFIX, cacheThemeAndAccent, nextTheme, subscribeSettings, themeCycleLabel,
  writeSettings, type AppSettings, type ThemeChoice,
} from './lib/appSettings'
import { TRAY_BADGE_SUPPORTED } from './lib/platform'
import { usageRefreshPlan } from './lib/refresh'
import { EMPTY_QUOTA, refreshQuota, refreshQuotaIfDue, subscribeQuota, worstSeverity, type QuotaState } from './lib/quota'
import { AgentTabStrip, ALL_PROVIDER, providerLabel, providerTabs } from './components/AgentTabStrip'
import type { Provider } from './components/AgentTabStrip'
import { ModelsSection } from './components/ModelsSection'
import { InsightPills, INSIGHT_ORDER, isInsightMode, type InsightMode } from './components/InsightPills'
import { TrendInsight, trendDayCount } from './components/TrendInsight'
import { CalendarInsight } from './components/CalendarInsight'
import { OptimizeInsight } from './components/OptimizeInsight'
import { ForecastInsight } from './components/ForecastInsight'
import { PulseInsight } from './components/PulseInsight'
import { StatsInsight } from './components/StatsInsight'
import { PlanInsight, planTarget } from './components/PlanInsight'
import { FindingsSection } from './components/FindingsSection'
import { PullRequestsSection } from './components/PullRequestsSection'
import { ToolingSection } from './components/ToolingSection'
import { ActivitySection } from './components/ActivitySection'
import { LoadingOverlay } from './components/LoadingOverlay'
import { EmptyProviderState } from './components/EmptyProviderState'
import { NoDataState } from './components/NoDataState'
import { SetupState, type CliStatus } from './components/SetupState'
import { StarBanner } from './components/StarBanner'
import { TelemetryNotice } from './components/TelemetryNotice'
import { HeroSection } from './components/HeroSection'
import { PeriodTabs, PERIOD_LABELS, daySelectionLabel } from './components/PeriodTabs'
import { ScopeControl, type Scope } from './components/ScopeControl'
import type { DaySelection, Period } from './components/PeriodTabs'
import { FooterBar } from './components/FooterBar'
import { ErrorToast } from './components/ErrorToast'
import { FetchErrorOverlay } from './components/FetchErrorOverlay'
import { Header } from './components/Header'
import { CLIUpdateBanner } from './components/CLIUpdateBanner'
import { accentById, applyAccent, type AccentPreset } from './lib/accent'
import { track } from './lib/telemetry'

const payloadCache = new PayloadCache<MenubarPayload>()

/// The tab strip's costs read this one key, whatever the popover is showing.
const TODAY_ALL: Selection = {
  period: 'today',
  provider: 'all',
  days: [],
  scope: 'local',
  claudeConfigSourceId: null,
}

/// What the tray figure is measured over, from the settings window's Period and Scope. The
/// mac keeps a second payload key for exactly this, since the popover and the tray can be
/// looking at different spans.
function menubarSelection(settings: AppSettings): Selection {
  return {
    period: settings.menubarPeriod,
    provider: 'all',
    days: [],
    scope: settings.menubarScope,
    claudeConfigSourceId: null,
  }
}

/// What a background tick does, mirroring mac/Sources/CodeBurnMenubar/RefreshCadence.swift:
/// every fetch is a full Node process, so the popover being closed has to cost less than it
/// being open. Visible, a tick refreshes today/all plus the selected period/provider with
/// optimize findings; hidden, a slower tick refreshes only the tray key and skips optimize,
/// since the badge and the tooltip are the only things anyone can see. How long the loop
/// waits between ticks comes from Rust, since it follows the power state. Entries younger
/// than STALE_MS are left alone when the popover is re-opened.
const STALE_MS = 60_000

/// Stuck-load recovery, from the mac BurnLoadingOverlay task: while the popover has
/// nothing to show, retry the fetch on a doubling delay and then give up with a message
/// rather than spinning forever. The first delay is longer than a healthy CLI run.
const RECOVERY_FIRST_MS = 8_000
const RECOVERY_MAX_MS = 60_000
const RECOVERY_ATTEMPTS = 6
/// A fetch this old is an orphan, not a slow run: its in-flight mark can be cleared. Rust
/// stops a child that has gone quiet for 45 s, so anything still running past two minutes is
/// either a genuinely large first parse, which will answer, or a promise lost across sleep,
/// which will not. A younger mark is left alone so recovery never races a fetch that is
/// still going to answer.
const FLIGHT_WATCHDOG_MS = 120_000

type FetchOptions = {
  includeOptimize: boolean
  showOverlay: boolean
}

/// The two daily alert thresholds from the CLI config. Only the one the display metric is
/// measured in is ever shown, as on the mac; `null` means that alert is off. `cost` arrives in
/// dollars, since that is what the payload is measured in; the settings window edits the
/// display-currency figure that the CLI's `budget.daily` actually holds.
type Budgets = { cost: number | null; tokens: number | null }

export function App() {
  const [period, setPeriod] = useState<Period>('today')
  // Days picked in the calendar. Non-empty overrides the period, as isDayMode does on
  // the mac; the period stays put so clearing the picker returns to it.
  const [days, setDays] = useState<DaySelection>([])
  const [scope, setScope] = useState<Scope>('local')
  const [claudeConfigSourceId, setClaudeConfigSourceId] = useState<string | null>(null)
  const [provider, setProvider] = useState<Provider>(ALL_PROVIDER)
  const [payload, setPayload] = useState<MenubarPayload | null>(null)
  const [todayPayload, setTodayPayload] = useState<MenubarPayload | null>(null)
  const [currency, setCurrency] = useState<CurrencyState>(USD)
  const [overlay, setOverlay] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [insight, setInsight] = useState<InsightMode>(() => {
    const saved = readSetting('insight')
    return isInsightMode(saved) ? saved : 'trend'
  })
  const [cliStatus, setCliStatus] = useState<CliStatus | null>(null)
  const [cliChecking, setCliChecking] = useState(false)
  const [version, setVersion] = useState('')
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [quota, setQuota] = useState<QuotaState>(EMPTY_QUOTA)
  // The window starts hidden and is shown by a tray click, which emits `codeburn://shown`.
  const [popoverVisible, setPopoverVisible] = useState(false)
  const [budgets, setBudgets] = useState<Budgets>({ cost: null, tokens: null })
  // Every preference the settings window owns arrives here through one store, so a change
  // made in that window reaches this one without a reload.
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [menubarPayload, setMenubarPayload] = useState<MenubarPayload | null>(null)
  const accent: AccentPreset = accentById(settings.accent)
  const trayBadge = TRAY_BADGE_SUPPORTED && settings.trayBadge

  // The CLI refuses combined scope alongside a multi-day pick, since paired devices
  // report a range rather than a set of days. The mac falls back to local there too.
  const effectiveScope: Scope = days.length > 1 ? 'local' : scope
  const current: Selection = {
    period,
    provider,
    days,
    scope: effectiveScope,
    claudeConfigSourceId,
  }
  const selection = useRef(current)
  selection.current = current

  // The wake listener is armed once and must still see the cadence as it stands then.
  const cadence = useRef(settings.usageRefreshSeconds)
  cadence.current = settings.usageRefreshSeconds

  const menubarKey = menubarSelection(settings)
  const menubarRef = useRef(menubarKey)
  menubarRef.current = menubarKey

  const fetchKey = useCallback(async (key: Selection, opts: FetchOptions) => {
    if (payloadCache.isInFlight(key)) return
    payloadCache.markInFlight(key)
    const isSelected = () => sameSelection(selection.current, key)
    if (opts.showOverlay && isSelected()) setOverlay(true)
    try {
      const json = await invoke<MenubarPayload>('fetch_payload', {
        period: key.period,
        provider: key.provider,
        days: key.days,
        scope: key.scope,
        claudeConfigSource: key.claudeConfigSourceId,
        includeOptimize: opts.includeOptimize,
      })
      // A quiet (no-optimize) refresh must not wipe findings a previous full fetch had.
      if (!opts.includeOptimize) {
        const previous = payloadCache.get(key)
        if (previous) json.optimize = previous.optimize
      }
      payloadCache.set(key, json)
      if (isSelected()) {
        setError(null)
        setPayload(json)
        // "updated Xs ago" describes what the user is looking at, so only a fetch of the
        // visible key may stamp it - a background today/all tick must not.
        setLastUpdated(new Date())
      }
      if (sameSelection(key, TODAY_ALL)) setTodayPayload(json)
      if (sameSelection(key, menubarRef.current)) setMenubarPayload(json)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('CLI not found')) {
        const status = await invoke<CliStatus>('cli_status').catch(() => null)
        if (status) setCliStatus(status)
      } else if (isSelected()) {
        setError(message)
      }
    } finally {
      payloadCache.clearInFlight(key)
      if (isSelected()) setOverlay(false)
    }
  }, [])

  const refreshAll = useCallback(async (opts: FetchOptions) => {
    const key = selection.current
    // Three keys can be in play at once: what the popover shows, today for the tab strip
    // costs, and whatever span and scope the tray figure was set to. Usually they collapse
    // into one, and each extra key is a whole CLI run, so only genuine differences are
    // fetched.
    const quiet = { includeOptimize: false, showOverlay: false }
    const extras = [TODAY_ALL, menubarRef.current].filter(
      (extra, index, all) =>
        !sameSelection(extra, key) && all.findIndex(other => sameSelection(other, extra)) === index,
    )
    for (const extra of extras) fetchKey(extra, quiet)
    // A usage tick may ride along with a quota poll the cadence has already earned, but it
    // must not set the pace: one Refresh Now is a reader asking, a loop is not.
    void refreshQuotaIfDue(false)
    await fetchKey(key, opts)
  }, [fetchKey])

  /// Refresh Now, from the footer, the tray or an empty state. A reader asking is the one
  /// thing that outranks the quota cadence, as the mac's force path does.
  const userRefresh = useCallback(() => {
    void refreshQuota()
    refreshAll({ includeOptimize: true, showOverlay: true })
  }, [refreshAll])

  /// The single source of truth for the CLI gate. Nothing else writes a "compatible"
  /// verdict: a payload that happens to parse does not prove the CLI is new enough, and a
  /// probe from the settings panel must not be able to invent one either.
  const checkCli = useCallback(async () => {
    setCliChecking(true)
    try {
      const status = await invoke<CliStatus>('cli_status')
      setCliStatus(status)
      if (status.found && status.compatible) {
        refreshAll({ includeOptimize: true, showOverlay: true })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCliChecking(false)
    }
  }, [refreshAll])

  const cliReady = cliStatus !== null && cliStatus.found && cliStatus.compatible

  // Probe the gate before the first fetch: an old CLI emits a payload missing fields the
  // popover reads, which used to blank the whole window instead of showing the setup screen.
  useEffect(() => {
    invoke<string>('app_version').then(setVersion).catch(() => {})
    checkCli()
    // Startup only; checkCli is re-run from the setup screen and settings on demand.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The background loop. Rust is asked on every tick how long to wait for the next one,
  // because the answer follows the machine: Auto is 30 s with the popover open, 120 s hidden,
  // and backs off on battery and further in battery saver, all of which can change under a
  // timer that has already been armed. The same answer says whether this tick is worth
  // spawning at all: a locked session or sleeping displays get the timer back and no CLI
  // run. Manual answers null and the loop stops; usage then refreshes only when the popover
  // opens, on wake, or when Refresh is pressed.
  useEffect(() => {
    if (!cliReady) return
    let stopped = false
    let timer = 0
    const step = async (refresh: boolean) => {
      let plan
      try {
        plan = await usageRefreshPlan(settings.usageRefreshSeconds, popoverVisible)
      } catch {
        return
      }
      if (stopped) return
      if (refresh && !plan.skip) {
        if (popoverVisible) refreshAll({ includeOptimize: true, showOverlay: false })
        // Hidden, the tray figure is the only thing anyone can see, so only its key is
        // refreshed and the optimize pass is skipped.
        else fetchKey(menubarRef.current, { includeOptimize: false, showOverlay: false })
      }
      if (plan.intervalMs === null) return
      timer = window.setTimeout(() => { void step(true) }, plan.intervalMs)
    }
    void step(false)
    return () => { stopped = true; window.clearTimeout(timer) }
  }, [cliReady, popoverVisible, refreshAll, fetchKey, settings.usageRefreshSeconds])

  const selectionKeyValue = selectionKey(current)
  useEffect(() => {
    const key = selection.current
    const cached = payloadCache.get(key)
    // The error describes the selection that failed, so it goes with it.
    setError(null)
    setPayload(cached)
    if (!cliReady) return
    if (!cached) {
      fetchKey(key, { includeOptimize: true, showOverlay: true })
    } else if (payloadCache.age(key) > STALE_MS) {
      fetchKey(key, { includeOptimize: true, showOverlay: false })
    }
    // The selection is a fresh object each render, so the key string is what changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKeyValue, cliReady, fetchKey])

  useEffect(() => {
    const unlistenRefresh = listen('codeburn://refresh', () => userRefresh())
    const unlistenShown = listen('codeburn://shown', () => {
      setPopoverVisible(true)
      // The popover is hidden rather than closed, so it mounts once a launch: an open is
      // this event, not this component appearing.
      track('popover_open')
      readDailyBudget()
      // The reader is looking at the bars now, so the quota gets an answer the cadence had
      // not earned yet, down to the interactive floor.
      void refreshQuotaIfDue(true)
      if (payloadCache.age(selection.current) > STALE_MS) {
        refreshAll({ includeOptimize: true, showOverlay: false })
      }
    })
    const unlistenHidden = listen('codeburn://hidden', () => setPopoverVisible(false))
    // Waking, unlocking or the screens coming back: whatever is on the tray is as old as the
    // sleep was long. Manual is the one mode that stays silent, as it is on the mac, where
    // the wake path passes forcePayload only outside Manual.
    const unlistenWake = listen('codeburn://wake', () => {
      if (cadence.current === 0) return
      refreshAll({ includeOptimize: false, showOverlay: false })
    })
    const unlistenBudget = listen<Budgets>('codeburn://budget-changed', event => {
      if (event.payload) setBudgets(event.payload)
    })
    // The spend limit is stored in the display currency, so what it is worth in the dollars
    // the payload reports changes with the currency, not only with the limit.
    const unlistenCurrency = listen<CurrencyState>('codeburn://currency-changed', event => {
      if (event.payload) setCurrency(event.payload)
      invoke<Budgets>('daily_budgets').then(setBudgets).catch(() => {})
    })
    return () => {
      unlistenRefresh.then(fn => fn())
      unlistenShown.then(fn => fn())
      unlistenHidden.then(fn => fn())
      unlistenWake.then(fn => fn())
      unlistenBudget.then(fn => fn())
      unlistenCurrency.then(fn => fn())
    }
  }, [refreshAll, userRefresh])

  // The one place the popover learns what the settings window changed. The theme and the
  // accent are applied here rather than only stored, so a change made over there lands on
  // this surface without a reload.
  useEffect(() => subscribeSettings(next => {
    setSettings(next)
    applyAccent(accentById(next.accent))
    applyTheme(next.theme === 'system' ? null : next.theme)
    cacheThemeAndAccent(next)
  }), [])

  useEffect(() => {
    invoke<CurrencyState>('currency').then(setCurrency).catch(() => {})
  }, [])

  // The limit lives in the CLI config, which package C's settings window will write, so
  // it is re-read whenever the popover comes back rather than cached for the session.
  const readDailyBudget = () => {
    invoke<Budgets>('daily_budgets').then(setBudgets).catch(() => {})
  }
  useEffect(readDailyBudget, [])

  // Nothing on screen and nothing coming: retry on a doubling delay, then say so. A
  // fetch torn down across sleep can leave its in-flight mark behind, which would make
  // every retry bail on the guard, so a mark older than the watchdog is cleared first.
  const coldLoading = overlay && payload === null && error === null
  useEffect(() => {
    if (!coldLoading || !cliReady) return
    let attempt = 0
    let delay = RECOVERY_FIRST_MS
    let timer = 0
    const tick = () => {
      attempt += 1
      const key = selection.current
      if (payloadCache.flightAge(key) > FLIGHT_WATCHDOG_MS) payloadCache.clearInFlight(key)
      fetchKey(key, { includeOptimize: false, showOverlay: true })
      if (attempt >= RECOVERY_ATTEMPTS) {
        setError(`Could not load ${label}. Check that the codeburn CLI is installed and working.`)
        return
      }
      delay = Math.min(delay * 2, RECOVERY_MAX_MS)
      timer = window.setTimeout(tick, delay)
    }
    timer = window.setTimeout(tick, delay)
    return () => window.clearTimeout(timer)
    // `label` only decorates the give-up message; re-arming the ladder on a relabel
    // would restart the clock for no reason.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coldLoading, cliReady, fetchKey])

  // The quota store polls only while something is watching it, so it starts here and stops
  // with the page. A manual Refresh asks it for a fresh answer too.
  useEffect(() => subscribeQuota(setQuota), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') invoke('hide_popover').catch(() => {})
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const todayCost = todayPayload?.current?.cost ?? null
  const trayCurrent = menubarPayload?.current ?? null
  // The tray figure is measured over the settings window's period, which is not always
  // today, so the suffix says which. Combined scope prefers the cross-device total, as the
  // mac's badge does, and falls back to local when pulling the peers did not work.
  const trayCombined = settings.menubarScope === 'combined' ? menubarPayload?.combined?.combined ?? null : null
  const trayCost = trayCombined?.cost ?? trayCurrent?.cost ?? null
  const trayTokens = trayCurrent
    ? (trayCombined?.inputTokens ?? trayCurrent.inputTokens) + (trayCombined?.outputTokens ?? trayCurrent.outputTokens)
    : null
  const traySuffix = MENUBAR_SUFFIX[settings.menubarPeriod]
  const isTokenMetric = settings.metric === 'tokens' || settings.metric === 'totalTokens'
  // The 16 px badge bitmap has room for about four glyphs, so the mac's up/down token pair
  // cannot fit; both token metrics show the total there and the hero carries the split.
  const trayFigure = isTokenMetric
    ? (trayTokens === null ? null : `${formatTokens(trayTokens)} tok`)
    : (trayCost === null ? null : formatCurrency(trayCost, currency))
  // Combined scope with a paired device that did not report this cycle: the figure is short
  // of what these machines actually spent, and the mac says so beside its title with a dimmed
  // "reachable/total". A 16 px bitmap has no room for that, so the badge is drawn dimmed and
  // the counts go where there is room for words.
  const trayShortfall = trayCombined !== null && trayCombined.reachableCount < trayCombined.deviceCount
    ? { reachable: trayCombined.reachableCount, total: trayCombined.deviceCount }
    : null

  useEffect(() => {
    if (trayFigure === null) return
    const devices = trayShortfall
      ? ` · ${trayShortfall.reachable} of ${trayShortfall.total} devices reporting`
      : ''
    invoke('set_tray_tooltip', { text: `CodeBurn · ${trayFigure}${traySuffix}${devices}` }).catch(() => {})
    // Only the counts matter here, not the object identity a render makes fresh every time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trayFigure, traySuffix, trayShortfall?.reachable, trayShortfall?.total])

  useEffect(() => {
    if (!TRAY_BADGE_SUPPORTED) return
    const showBadge = trayBadge && settings.metric !== 'iconOnly'
    // Before the first payload there is nothing to say, and the badge restored from the last
    // session is already on screen: clearing it here would blank the tray on every launch.
    if (showBadge && trayCost === null && trayTokens === null) return
    const text = !showBadge
      ? null
      : isTokenMetric
        ? (trayTokens === null ? null : formatTokens(trayTokens))
        : (trayCost === null ? null : trayBadgeText(trayCost, currency))
    invoke('set_tray_badge', { text, muted: trayShortfall !== null }).catch(err => setError(`Tray badge: ${String(err)}`))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trayCost, trayTokens, currency, trayBadge, settings.metric, isTokenMetric, trayShortfall?.reachable, trayShortfall?.total])

  // The flame carries the worst connected provider's quota severity. Rust decides whether
  // today's spend is over the daily budget, since the limit lives in the CLI's config.
  const todayTokens = todayPayload?.current
    ? todayPayload.current.inputTokens + todayPayload.current.outputTokens
    : null
  // `budgets` is in the list although Rust reads the limits from the config itself: without
  // it, arming an alert would not tint the flame until the next refresh moved a figure.
  useEffect(() => {
    invoke('set_tray_severity', { severity: worstSeverity(quota), todayCost, todayTokens }).catch(() => {})
  }, [quota, todayCost, todayTokens, budgets])

  useEffect(() => {
    const span = MENUBAR_PERIODS.find(p => p.id === settings.menubarPeriod)?.label ?? 'Today'
    const devices = trayShortfall ? ` · ${trayShortfall.reachable}/${trayShortfall.total} devices` : ''
    const text = trayCurrent
      ? `${span} · ${trayFigure} · ${plural(trayCurrent.calls, 'call')}${devices}`
      : `${span} · no usage yet`
    invoke('set_tray_usage', { text }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trayCurrent, trayFigure, settings.menubarPeriod, trayShortfall?.reachable, trayShortfall?.total])

  const chooseAccent = (preset: AccentPreset) => {
    applyAccent(preset)
    void writeSettings({ accent: preset.id })
  }

  const chooseTheme = (choice: ThemeChoice) => {
    applyTheme(choice === 'system' ? null : choice)
    void writeSettings({ theme: choice })
  }

  const cycleTheme = () => {
    chooseTheme(nextTheme(settings.theme))
  }

  const setTrayBadgePref = (on: boolean) => {
    void writeSettings({ trayBadge: on })
  }

  const applyCurrency = async (code: string) => {
    try {
      setCurrency(await invoke<CurrencyState>('set_currency', { code }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const openTerminal = (args: string[]) => {
    invoke('open_terminal_command', { args }).catch(err => setError(String(err)))
  }

  /// The mac's runExport: into the Downloads folder as codeburn-<stamp>, then revealed in
  /// the file manager with the result selected. The stamp is the mac's local-time
  /// `yyyy-MM-dd-HHmmss`, which is why it is formatted here rather than in Rust.
  const runExport = (format: 'csv' | 'json') => {
    const now = new Date()
    const two = (n: number) => String(n).padStart(2, '0')
    const stamp = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`
      + `-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`
    invoke('export_usage', { format, stamp }).catch(err => setError(String(err)))
  }

  const connectClaude = () => {
    invoke('open_claude_login').catch(err => setError(String(err)))
  }

  /// Settings left the popover for a window of their own; what is left here is the link.
  const openSettingsWindow = (section = 'general') => {
    // The pane name only; a deep link's anchor is dropped, since it names a row rather than
    // a section anyone is choosing between.
    track('settings_open', { pane: section.split('#')[0] || 'general' })
    invoke('open_settings_window', { section }).catch(err => setError(String(err)))
  }

  // Combined pulls unfiltered totals from every paired device, so a provider filter or a
  // Claude config would be a contradiction; the CLI rejects both. Picking a config is the
  // mirror image: it scopes Claude on this machine, so it forces All and local.
  const chooseScope = (next: Scope) => {
    setScope(next)
    if (next === 'combined') {
      setProvider(ALL_PROVIDER)
      setClaudeConfigSourceId(null)
    }
  }

  const chooseClaudeConfig = (id: string | null) => {
    setClaudeConfigSourceId(id)
    if (id !== null) {
      setProvider(ALL_PROVIDER)
      setScope('local')
    }
  }

  const chooseProvider = (next: Provider) => {
    setProvider(next)
    if (next !== ALL_PROVIDER && next !== 'claude') setClaudeConfigSourceId(null)
  }

  const selectInsight = (mode: InsightMode) => {
    setInsight(mode)
    writeSetting('insight', mode)
  }

  const tabs = providerTabs(todayPayload)
  // The selector is worth showing only when there is a choice, so the CLI emits the block
  // only past one config. Today's payload is the fallback while the selected key loads.
  const claudeConfigs = payload?.claudeConfigs?.options ?? todayPayload?.claudeConfigs?.options ?? []
  // The Plan pill is offered exactly when there is one plan to show. All aggregates several
  // providers and so has no plan of its own, as on the mac.
  const planVisible = planTarget(quota, provider) !== null
  const visibleModes = useMemo(
    () => INSIGHT_ORDER.filter(m => m !== 'plan' || planVisible),
    [planVisible],
  )
  const activeInsight = visibleModes.includes(insight) ? insight : 'trend'

  const cliBlocked = cliStatus !== null && (!cliStatus.found || !cliStatus.compatible)
  // The version gate above is what keeps these fields present; the optional reads are the
  // backstop that turns a surprising payload into an empty state rather than a blank window.
  const isFilteredEmpty = payload !== null && provider !== ALL_PROVIDER
    && (payload.current?.cost ?? 0) <= 0 && (payload.current?.calls ?? 0) === 0
  const neverAnyData = payload !== null && provider === ALL_PROVIDER
    && (payload.current?.calls ?? 0) === 0 && (payload.current?.sessions ?? 0) === 0
    && (payload.history?.daily?.length ?? 0) === 0

  const label = daySelectionLabel(days) ?? PERIOD_LABELS[period]

  const footnote = [version ? `CodeBurn v${version}` : 'CodeBurn', lastUpdated ? `updated ${relativePast(lastUpdated)}` : null]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="popover">
      <Header
        quota={quota}
        showQuota={!cliBlocked}
        accent={accent}
        onAccent={chooseAccent}
        animate={popoverVisible}
      />

      {!cliBlocked && (
        <AgentTabStrip selected={provider} onSelect={chooseProvider} payload={todayPayload} currency={currency} quota={quota} />
      )}

      <div className="main-content">
        {cliBlocked && cliStatus ? (
          <SetupState status={cliStatus} checking={cliChecking} onCheckAgain={checkCli} />
        ) : (
          <>
            <HeroSection
              payload={payload}
              currency={currency}
              periodLabel={label}
              isToday={days.length === 0 && period === 'today'}
              metric={settings.metric}
              dailyBudget={isTokenMetric ? budgets.tokens : budgets.cost}
              combinedScope={effectiveScope === 'combined'}
            />
            <PeriodTabs
              selected={period}
              days={days}
              onSelect={p => { setDays([]); setPeriod(p) }}
              onSelectDays={setDays}
            />
            <ScopeControl
              scope={effectiveScope}
              onScope={chooseScope}
              configs={claudeConfigs}
              selectedConfigId={claudeConfigSourceId}
              onConfig={chooseClaudeConfig}
            />

            {isFilteredEmpty ? (
              <EmptyProviderState label={providerLabel(tabs, provider)} period={period} />
            ) : neverAnyData ? (
              <NoDataState onRefresh={userRefresh} />
            ) : (
              <>
                <div className="insight-area">
                  <InsightPills selected={activeInsight} onSelect={selectInsight} modes={visibleModes} />
                  {/* One panel for whichever insight is showing: the pills are its tabs. */}
                  <div id="insight-panel" role="tabpanel" aria-labelledby={`insight-tab-${activeInsight}`}>
                  {activeInsight === 'plan' && (
                    <PlanInsight
                      payload={payload}
                      currency={currency}
                      provider={provider}
                      quota={quota}
                      onOpenTerminal={openTerminal}
                      onConnectClaude={connectClaude}
                    />
                  )}
                  {activeInsight === 'trend' && (
                    <TrendInsight
                      days={payload?.history?.daily ?? []}
                      currency={currency}
                      dayCount={trendDayCount(period, days, payload?.history?.daily?.length ?? 0)}
                    />
                  )}
                  {activeInsight === 'forecast' && <ForecastInsight days={payload?.history?.daily ?? []} currency={currency} />}
                  {activeInsight === 'calendar' && <CalendarInsight days={payload?.history?.daily ?? []} currency={currency} />}
                  {activeInsight === 'pulse' && payload && <PulseInsight payload={payload} currency={currency} />}
                  {activeInsight === 'stats' && payload && <StatsInsight payload={payload} currency={currency} period={period} />}
                  {activeInsight === 'optimize' && payload && <OptimizeInsight payload={payload} currency={currency} />}
                  </div>
                </div>
                {payload?.current && (
                  <>
                    <ActivitySection payload={payload} currency={currency} />
                    <ModelsSection
                      models={payload.current.topModels}
                      inputTokens={payload.current.inputTokens}
                      outputTokens={payload.current.outputTokens}
                      cacheHitPercent={payload.current.cacheHitPercent}
                      currency={currency}
                      unpricedModels={payload.current.unpricedModels}
                    />
                    <PullRequestsSection payload={payload} currency={currency} />
                    <ToolingSection payload={payload} currency={currency} />
                    <FindingsSection payload={payload} currency={currency} onOpenTerminal={openTerminal} />
                  </>
                )}
              </>
            )}
            {/* The overlay only takes over on a cold cache, so a failed background
                refresh leaves the numbers that are already on screen alone. */}
            {payload === null && error !== null ? (
              <FetchErrorOverlay
                message={error}
                periodLabel={label}
                onRetry={() => {
                  setError(null)
                  refreshAll({ includeOptimize: false, showOverlay: true })
                }}
              />
            ) : overlay ? (
              <LoadingOverlay periodLabel={label} />
            ) : null}
          </>
        )}
      </div>

      <FooterBar
        currency={currency}
        onCurrency={applyCurrency}
        loading={overlay}
        onRefresh={userRefresh}
        onExport={runExport}
        onOpenReport={() => openTerminal(['report'])}
        onToggleTheme={cycleTheme}
        onQuit={() => invoke('quit_app').catch(() => {})}
        themeLabel={themeCycleLabel(settings.theme)}
        trayBadge={trayBadge}
        onToggleTrayBadge={() => setTrayBadgePref(!trayBadge)}
        onOpenSettings={openSettingsWindow}
        footnote={footnote}
      />

      <TelemetryNotice />

      <CLIUpdateBanner />

      <StarBanner />

      {/* With something already on screen the failure is an aside, not a wall. */}
      {error !== null && payload !== null && (
        <ErrorToast message={error} onDismiss={() => setError(null)} />
      )}
    </div>
  )
}

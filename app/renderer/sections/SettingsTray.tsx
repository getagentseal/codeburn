// The tray app's own settings, inside the desktop app's Settings.
//
// The tray app (windows/) has a settings window of its own, and everything here writes the
// same two files it reads: `windows-settings.json` and `windows-dock.json`. Only the settings
// the desktop app does not already have appear; currency, period, scope and the daily budget
// are shared through the CLI config and live in General.
//
// Both panes are Windows only, and each is shown only while its switch in the sidebar corner
// is on: there is nothing to configure about a tray app that is not running, and the rail is
// one of its windows.

import { useCallback, useEffect, useState } from 'react'

import { Dropdown } from '../components/Dropdown'
import { ProviderLogo } from '../components/ProviderLogo'
import { usePolled } from '../hooks/usePolled'
import { t } from '../i18n'
import { codeburn } from '../lib/ipc'
import { PROVIDER_NAMES, QUOTA_PROVIDERS } from '../lib/providers'
import type { QuotaProvider, TrayPrefs } from '../lib/types'

/** The Windows Settings page that owns launch at login for the Store build. The same value
 *  is the one exception in the main process's external-open guard (app/electron/main.ts). */
const STARTUP_APPS_SETTINGS_URL = 'ms-settings:startupapps'

/// The nine presets from the tray app's Theme/ThemeState.swift port
/// (windows/src/lib/accent.ts). Only the base shade is needed to draw a swatch.
const ACCENTS: Array<{ id: string; labelKey: string; base: string }> = [
  { id: 'ember', labelKey: 'settings.tray.accent.ember', base: '#C9521D' },
  { id: 'blue', labelKey: 'settings.tray.accent.blue', base: '#0A84FF' },
  { id: 'purple', labelKey: 'settings.tray.accent.purple', base: '#BF5AF2' },
  { id: 'pink', labelKey: 'settings.tray.accent.pink', base: '#FF375F' },
  { id: 'red', labelKey: 'settings.tray.accent.red', base: '#FF453A' },
  { id: 'orange', labelKey: 'settings.tray.accent.orange', base: '#FF9F0A' },
  { id: 'yellow', labelKey: 'settings.tray.accent.yellow', base: '#FFD60A' },
  { id: 'green', labelKey: 'settings.tray.accent.green', base: '#30D158' },
  { id: 'graphite', labelKey: 'settings.tray.accent.graphite', base: '#98989D' },
]

const METRICS = [
  { value: 'cost', labelKey: 'settings.tray.metric.cost' },
  { value: 'tokens', labelKey: 'settings.tray.metric.tokens' },
  { value: 'totalTokens', labelKey: 'settings.tray.metric.totalTokens' },
  { value: 'iconOnly', labelKey: 'settings.tray.metric.iconOnly' },
]

const MENUBAR_PERIODS = [
  { value: 'today', labelKey: 'settings.tray.period.today' },
  { value: 'week', labelKey: 'settings.tray.period.week' },
  { value: 'month', labelKey: 'settings.tray.period.month' },
  { value: 'all', labelKey: 'settings.tray.period.sixMonths' },
]

// The cadences are seconds, and the dropdown speaks strings, so they travel as strings and
// are turned back into numbers on the way to the file.
const USAGE_CADENCES = [
  { value: '-1', labelKey: 'settings.tray.cadence.auto' },
  { value: '0', labelKey: 'settings.tray.cadence.manual' },
  { value: '60', labelKey: 'settings.tray.cadence.oneMinute' },
  { value: '300', labelKey: 'settings.tray.cadence.fiveMinutes' },
  { value: '900', labelKey: 'settings.tray.cadence.fifteenMinutes' },
]

const QUOTA_CADENCES = [
  { value: '0', labelKey: 'settings.tray.cadence.manual' },
  { value: '60', labelKey: 'settings.tray.cadence.oneMinute' },
  { value: '120', labelKey: 'settings.tray.cadence.twoMinutes' },
  { value: '300', labelKey: 'settings.tray.cadence.fiveMinutes' },
  { value: '900', labelKey: 'settings.tray.cadence.fifteenMinutes' },
]

const TERMINALS = [
  { value: 'windowsTerminal', label: 'Windows Terminal' },
  { value: 'powershell', label: 'Windows PowerShell' },
  { value: 'commandPrompt', label: 'Command Prompt' },
]

const DOCK_THEMES = [
  { value: 'graphite', labelKey: 'settings.dock.theme.graphite' },
  { value: 'glass', labelKey: 'settings.dock.theme.glass' },
]

const DOCK_GAUGE_SHAPES = [
  { value: 'circle', labelKey: 'settings.dock.gauge.circle' },
  { value: 'squircle', labelKey: 'settings.dock.gauge.squircle' },
]

const SCALE_MIN = 0.6
const SCALE_MAX = 1.2
const SCALE_STEP = 0.05

/**
 * One read of the tray app's settings, and one writer per file. Every setter answers with the
 * whole set, because the main process is what decides what a value ends up as: an unreadable
 * one collapses to a default, and a provider set moves the resting provider with it.
 */
export function useTrayPrefs(): {
  prefs: TrayPrefs | null
  setApp: (patch: Record<string, unknown>) => void
  setDock: (patch: Record<string, unknown>) => void
  setLaunchAtLogin: (enabled: boolean) => void
} {
  const [prefs, setPrefs] = useState<TrayPrefs | null>(null)

  useEffect(() => {
    let live = true
    void codeburn?.trayPrefs?.()
      .then(next => { if (live) setPrefs(next) })
      .catch(() => {})
    return () => { live = false }
  }, [])

  const apply = useCallback((run: (() => Promise<TrayPrefs | null>) | undefined) => {
    if (!run) return
    void run().then(next => { if (next) setPrefs(next) }).catch(() => {})
  }, [])

  return {
    prefs,
    setApp: patch => apply(codeburn.setTrayAppPref && (() => codeburn.setTrayAppPref!(patch))),
    setDock: patch => apply(codeburn.setTrayDockPref && (() => codeburn.setTrayDockPref!(patch))),
    setLaunchAtLogin: enabled => apply(codeburn.setLaunchAtLogin && (() => codeburn.setLaunchAtLogin!(enabled))),
  }
}

function Switch({ on, label, disabled, onToggle }: {
  on: boolean
  label: string
  disabled?: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      className={on ? 'switch on' : 'switch'}
      onClick={onToggle}
    >
      <span className="switch-knob" />
    </button>
  )
}

export function MenuBarPane() {
  const { prefs, setApp, setLaunchAtLogin } = useTrayPrefs()
  if (!prefs) return <section className="set-p on"><p className="set-cap">{t('settings.tray.loadingMenuBar')}</p></section>
  const app = prefs.app

  return (
    <section className="set-p on">
      <div>
        <h3 className="set-h">{t('settings.tray.menuBarHeading')}</h3>
        <p className="set-sub">{t('settings.tray.menuBarSubtitle')}</p>
      </div>
      <div className="card">
        <div className="about-sec">
          <div className="about-sec-h">{t('settings.tray.figureHeading')}</div>
          <div className="about-row"><label className="tx" htmlFor="tray-metric">{t('settings.tray.metricLabel')}<small>{t('settings.tray.metricHint')}</small></label><span className="r">
            <Dropdown id="tray-metric" ariaLabel={t('settings.tray.metricAriaLabel')} value={app.metric} options={METRICS.map(m => ({ value: m.value, label: t(m.labelKey) }))} onChange={value => setApp({ metric: value })} width={168} />
          </span></div>
          <div className="about-row"><label className="tx" htmlFor="tray-period">{t('settings.tray.periodLabel')}<small>{t('settings.tray.periodHint')}</small></label><span className="r">
            <Dropdown id="tray-period" ariaLabel={t('settings.tray.periodAriaLabel')} value={app.menubarPeriod} options={MENUBAR_PERIODS.map(p => ({ value: p.value, label: t(p.labelKey) }))} onChange={value => setApp({ menubarPeriod: value })} width={120} />
          </span></div>
          <div className="about-row"><span className="tx">{t('settings.tray.showFigure')}<small>{t('settings.tray.showFigureHint')}</small></span><span className="r">
            <Switch on={app.trayBadge} label={t('settings.tray.showFigureAriaLabel')} onToggle={() => setApp({ trayBadge: !app.trayBadge })} />
          </span></div>
        </div>

        <div className="about-sec">
          <div className="about-sec-h">{t('settings.tray.appearanceHeading')}</div>
          <div className="about-row"><span className="tx">{t('settings.tray.accentLabel')}<small>{t('settings.tray.accentHint')}</small></span><span className="r">
            <span className="tray-accents" role="radiogroup" aria-label={t('settings.tray.accentLabel')}>
              {ACCENTS.map(accent => (
                <button
                  key={accent.id}
                  type="button"
                  role="radio"
                  aria-checked={app.accent === accent.id}
                  aria-label={t(accent.labelKey)}
                  title={t(accent.labelKey)}
                  className={app.accent === accent.id ? 'tray-accent on' : 'tray-accent'}
                  style={{ background: accent.base }}
                  onClick={() => setApp({ accent: accent.id })}
                />
              ))}
            </span>
          </span></div>
        </div>

        <div className="about-sec">
          <div className="about-sec-h">{t('settings.tray.refreshHeading')}</div>
          <div className="about-row"><label className="tx" htmlFor="tray-usage">{t('settings.tray.usageLabel')}<small>{t('settings.tray.usageHint')}</small></label><span className="r">
            <Dropdown id="tray-usage" ariaLabel={t('settings.tray.usageAriaLabel')} value={String(app.usageRefreshSeconds)} options={USAGE_CADENCES.map(c => ({ value: c.value, label: t(c.labelKey) }))} onChange={value => setApp({ usageRefreshSeconds: Number(value) })} width={124} />
          </span></div>
          <div className="about-row"><label className="tx" htmlFor="tray-quota">{t('settings.tray.quotaLabel')}<small>{t('settings.tray.quotaHint')}</small></label><span className="r">
            <Dropdown id="tray-quota" ariaLabel={t('settings.tray.quotaAriaLabel')} value={String(app.quotaCadenceSeconds)} options={QUOTA_CADENCES.map(c => ({ value: c.value, label: t(c.labelKey) }))} onChange={value => setApp({ quotaCadenceSeconds: Number(value) })} width={124} />
          </span></div>
        </div>

        <div className="about-sec set-last-sec">
          <div className="about-sec-h">{t('settings.tray.systemHeading')}</div>
          <div className="about-row"><label className="tx" htmlFor="tray-terminal">{t('settings.tray.terminalLabel')}<small>{t('settings.tray.terminalHint')}</small></label><span className="r">
            <Dropdown id="tray-terminal" ariaLabel={t('settings.tray.terminalLabel')} value={app.terminal} options={TERMINALS} onChange={value => setApp({ terminal: value })} width={168} />
          </span></div>
          {prefs.launchAtLoginManaged ? (
            // The Store package declares launch at login as its own startup task, which only
            // Windows can turn on and off. A switch here would move nothing, so this says who
            // owns it and opens the page that does.
            <div className="about-row"><span className="tx">{t('settings.tray.launchAtLogin')}<small>{t('settings.tray.launchAtLoginManagedHint')}</small></span><span className="r">
              <button
                type="button"
                className="set-text-button"
                onClick={() => { void codeburn.openExternal(STARTUP_APPS_SETTINGS_URL) }}
              >
                {t('settings.tray.openStartupApps')}
              </button>
            </span></div>
          ) : (
            <div className="about-row"><span className="tx">{t('settings.tray.launchAtLogin')}<small>{t('settings.tray.launchAtLoginHint')}</small></span><span className="r">
              <Switch on={prefs.launchAtLogin} label={t('settings.tray.launchAtLogin')} onToggle={() => setLaunchAtLogin(!prefs.launchAtLogin)} />
            </span></div>
          )}
        </div>
      </div>
    </section>
  )
}

export function CapacityDockPane({ refreshToken }: { refreshToken?: number }) {
  const { prefs, setDock } = useTrayPrefs()
  const quota = usePolled<QuotaProvider[]>(() => codeburn.getQuota(), [refreshToken])

  if (!prefs) return <section className="set-p on"><p className="set-cap">{t('settings.dock.loading')}</p></section>
  const dock = prefs.dock

  const connected = (quota.data ?? [])
    .filter(entry => entry.connection === 'connected')
    .map(entry => entry.provider as string)
  // Everything connected, plus anything already on the rail, so a provider whose connection
  // later fails can still be taken off it.
  const manageable = QUOTA_PROVIDERS.filter(id => dock.providers.includes(id) || connected.includes(id))
  // The rail must never end up with nothing to show, so the last connected provider stays on.
  const canDeselect = (id: string) =>
    !dock.providers.includes(id)
    || !connected.includes(id)
    || dock.providers.filter(entry => connected.includes(entry)).length > 1

  const toggleProvider = (id: string) => {
    const on = dock.providers.includes(id)
    if (on && !canDeselect(id)) return
    setDock({ providers: on ? dock.providers.filter(entry => entry !== id) : [...dock.providers, id] })
  }

  const restingOptions = (dock.providers.length > 0 ? dock.providers : manageable)
    .map(id => ({ value: id, label: PROVIDER_NAMES[id as keyof typeof PROVIDER_NAMES] ?? id }))

  return (
    <section className="set-p on">
      <div>
        <h3 className="set-h">{t('settings.dock.heading')}</h3>
        <p className="set-sub">{t('settings.dock.subtitle')}</p>
      </div>
      <div className="card">
        <div className="about-sec">
          <div className="about-sec-h">{t('settings.dock.railHeading')}</div>
          <div className="about-row"><span className="tx">{t('settings.dock.showRail')}<small>{t('settings.dock.showRailHint')}</small></span><span className="r">
            <Switch on={dock.enabled} label={t('settings.dock.showRailAriaLabel')} onToggle={() => setDock({ enabled: !dock.enabled })} />
          </span></div>
          <div className="about-row"><label className="tx" htmlFor="dock-resting">{t('settings.dock.restingLabel')}<small>{t('settings.dock.restingHint')}</small></label><span className="r">
            {restingOptions.length > 0
              ? <Dropdown id="dock-resting" ariaLabel={t('settings.dock.restingLabel')} value={dock.preferred ?? restingOptions[0]!.value} options={restingOptions} onChange={value => setDock({ preferred: value })} width={140} />
              : <span className="set-cap">{t('settings.dock.noProvidersYet')}</span>}
          </span></div>
          <div className="about-row"><label className="tx" htmlFor="dock-scale">{t('settings.dock.sizeLabel')}<small>{t('settings.dock.sizePercent', { percent: Math.round(dock.scale * 100) })}</small></label><span className="r">
            <input
              id="dock-scale"
              className="set-range"
              type="range"
              aria-label={t('settings.dock.sizeAriaLabel')}
              min={SCALE_MIN}
              max={SCALE_MAX}
              step={SCALE_STEP}
              value={dock.scale}
              onChange={event => setDock({ scale: Number(event.target.value) })}
            />
          </span></div>
        </div>

        <div className="about-sec">
          <div className="about-sec-h">{t('settings.dock.appearanceHeading')}</div>
          <div className="about-row"><label className="tx" htmlFor="dock-theme">{t('settings.dock.surfaceLabel')}<small>{t('settings.dock.surfaceHint')}</small></label><span className="r">
            <Dropdown id="dock-theme" ariaLabel={t('settings.dock.appearanceAriaLabel')} value={dock.theme} options={DOCK_THEMES.map(o => ({ value: o.value, label: t(o.labelKey) }))} onChange={value => setDock({ theme: value })} width={124} />
          </span></div>
          <div className="about-row"><label className="tx" htmlFor="dock-gauge">{t('settings.dock.gaugeLabel')}<small>{t('settings.dock.gaugeHint')}</small></label><span className="r">
            <Dropdown id="dock-gauge" ariaLabel={t('settings.dock.gaugeAriaLabel')} value={dock.gaugeShape} options={DOCK_GAUGE_SHAPES.map(o => ({ value: o.value, label: t(o.labelKey) }))} onChange={value => setDock({ gaugeShape: value })} width={124} />
          </span></div>
        </div>

        <div className="about-sec set-last-sec">
          <div className="about-sec-h">{t('settings.dock.providersHeading')}</div>
          {manageable.length === 0
            ? <p className="set-cap">{t('settings.dock.noneConnected')}</p>
            : manageable.map(id => {
              const on = dock.providers.includes(id)
              const locked = on && !canDeselect(id)
              return (
                <div className="about-row" key={id}>
                  <span className="tx set-dock-prov">
                    <ProviderLogo provider={id} />
                    {PROVIDER_NAMES[id as keyof typeof PROVIDER_NAMES] ?? id}
                    {locked && <small>{t('settings.dock.lastProviderHint')}</small>}
                    {!connected.includes(id) && <small>{t('settings.dock.notConnected')}</small>}
                  </span>
                  <span className="r">
                    <Switch on={on} disabled={locked} label={t('settings.dock.providerSwitchLabel', { provider: PROVIDER_NAMES[id as keyof typeof PROVIDER_NAMES] ?? id })} onToggle={() => toggleProvider(id)} />
                  </span>
                </div>
              )
            })}
        </div>
      </div>
    </section>
  )
}

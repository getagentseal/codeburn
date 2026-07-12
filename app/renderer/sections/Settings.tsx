import { useEffect, useState } from 'react'

import { Hint } from '../components/Hint'
import { CliErrorText, cliErrorDisplay } from '../components/CliErrorPanel'
import { Panel } from '../components/Panel'
import { usePolled } from '../hooks/usePolled'
import { formatUsd } from '../lib/format'
import { codeburn } from '../lib/ipc'
import type { ActionResult, AliasRow, CliError, CombinedUsage, DeviceScanResult, Identity, MenubarPayload, Period, StatusJson } from '../lib/types'

type Pane = 'general' | 'providers' | 'aliases' | 'plans' | 'devices' | 'export' | 'privacy'
type Theme = 'system' | 'light' | 'dark'

function readSetting(key: string): string | null {
  try { return globalThis.localStorage?.getItem(key) ?? null } catch { return null }
}

function writeSetting(key: string, value: string): void {
  try { globalThis.localStorage?.setItem(key, value) } catch { /* storage can be unavailable in hardened contexts */ }
}

const RAIL_ITEMS: Array<{ id: Pane; label: string; icon: React.ReactNode }> = [
  { id: 'general', label: 'General', icon: <><line x1="4" y1="8" x2="20" y2="8" /><circle cx="9" cy="8" r="2.2" /><line x1="4" y1="16" x2="20" y2="16" /><circle cx="15" cy="16" r="2.2" /></> },
  { id: 'providers', label: 'Providers', icon: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></> },
  { id: 'aliases', label: 'Model aliases', icon: <><path d="M20 12l-8 8-9-9V3h8z" /><circle cx="7.5" cy="7.5" r="1.4" /></> },
  { id: 'plans', label: 'Plans', icon: <><rect x="2" y="5" width="20" height="14" rx="2" /><line x1="2" y1="10" x2="22" y2="10" /></> },
  { id: 'devices', label: 'Devices', icon: <><rect x="3" y="4" width="18" height="12" rx="1.5" /><line x1="8" y1="20" x2="16" y2="20" /><line x1="12" y1="16" x2="12" y2="20" /></> },
  { id: 'export', label: 'Export', icon: <><path d="M12 3v12" /><path d="M7 11l5 5 5-5" /><path d="M4 21h16" /></> },
  { id: 'privacy', label: 'Privacy & data', icon: <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /> },
]

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

export function Settings({ period, refreshToken = 0 }: { period: Period; refreshToken?: number }) {
  const [pane, setPane] = useState<Pane>('general')
  const identity = usePolled<Identity>(() => codeburn.getIdentity(), [refreshToken])
  const scan = usePolled<DeviceScanResult>(() => codeburn.getDevicesScan(), [refreshToken])
  const devices = usePolled<CombinedUsage>(() => codeburn.getDevices(period), [period, refreshToken])

  return (
    <>
      <div className="bar"><div className="t">Settings</div></div>
      <div className="body set-body">
        <nav className="set-rail" aria-label="Settings sections">
          {RAIL_ITEMS.map(item => (
            <button key={item.id} className={pane === item.id ? 'set-rail-item on' : 'set-rail-item'} onClick={() => setPane(item.id)}>
              <svg viewBox="0 0 24 24" aria-hidden="true">{item.icon}</svg>{item.label}
            </button>
          ))}
        </nav>
        <main className="set-pane">
          {pane === 'general' && <GeneralPane period={period} refreshToken={refreshToken} />}
          {pane === 'providers' && <ProvidersPane period={period} refreshToken={refreshToken} />}
          {pane === 'aliases' && <AliasesPane refreshToken={refreshToken} />}
          {pane === 'plans' && <PlaceholderPane title="Plans" subtitle="Set a monthly budget plan per provider." />}
          {pane === 'devices' && <DevicesPane identity={identity} scan={scan} devices={devices} period={period} />}
          {pane === 'export' && <PlaceholderPane title="Export" subtitle="Save your usage as CSV or JSON." />}
          {pane === 'privacy' && <PrivacyPane />}
        </main>
      </div>
      <Hint items={[{ k: '⌘1-7', label: 'Navigate' }, { k: '⌘R', label: 'Refresh' }]} right="pairing uses mutual TLS · approve-style, no PIN" />
    </>
  )
}

function GeneralPane({ period, refreshToken }: { period: Period; refreshToken: number }) {
  const [currencyNonce, setCurrencyNonce] = useState(0)
  const plans = usePolled<StatusJson>(() => codeburn.getPlans(period), [period, refreshToken, currencyNonce])
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = readSetting('codeburn.theme')
    return saved === 'light' || saved === 'dark' ? saved : 'system'
  })
  const [defaultPeriod, setDefaultPeriod] = useState(() => readSetting('codeburn.defaultPeriod') ?? 'today')
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)

  useEffect(() => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme')
    else document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  const chooseTheme = (next: Theme) => {
    setTheme(next)
    writeSetting('codeburn.theme', next)
  }
  const finishCurrency = (result: ActionResult) => {
    setMessage({ text: result.ok ? 'Updated' : result.stderr || 'Unable to update currency', error: !result.ok })
    if (result.ok) setCurrencyNonce(value => value + 1)
  }
  const currencies = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'INR']
  if (plans.data?.currency && !currencies.includes(plans.data.currency)) currencies.push(plans.data.currency)

  return (
    <section className="set-p on">
      <div><h3 className="set-h">General</h3><p className="set-sub">Display and appearance for the whole app.</p></div>
      <div className="card">
        <div className="about-sec">
          <div className="about-sec-h">Appearance</div>
          <div className="about-row"><span className="tx">Theme<small>Match your system or force a mode</small></span><span className="r"><span className="seg">
            {(['system', 'light', 'dark'] as Theme[]).map(value => <button key={value} className={theme === value ? 'on' : undefined} onClick={() => chooseTheme(value)}>{value[0]!.toUpperCase() + value.slice(1)}</button>)}
          </span></span></div>
        </div>
        <div className="about-sec set-last-sec">
          <div className="about-sec-h">Display</div>
          <div className="about-row"><label className="tx" htmlFor="settings-currency">Currency</label><span className="r">
            {plans.data ? <select id="settings-currency" className="set-input" value={plans.data.currency} onChange={event => void codeburn.setCurrency(event.target.value).then(finishCurrency)}>{currencies.map(code => <option key={code}>{code}</option>)}</select> : plans.error ? <SettingsErrorText error={plans.error} /> : <span className="set-cap">Loading…</span>}
            <button className="set-text-button" onClick={() => void codeburn.resetCurrency().then(finishCurrency)}>Reset to USD</button>
          </span></div>
          <div className="about-row"><label className="tx" htmlFor="settings-period">Default period<small>Applied on next launch.</small></label><span className="r"><select id="settings-period" className="set-input" value={defaultPeriod} onChange={event => { setDefaultPeriod(event.target.value); writeSetting('codeburn.defaultPeriod', event.target.value) }}>
            <option value="today">Today</option><option value="week">7d</option><option value="30days">30d</option><option value="month">Month</option><option value="all">All</option>
          </select></span></div>
          {message && <p className={message.error ? 'set-action-msg error' : 'set-action-msg'}>{message.text}</p>}
        </div>
      </div>
    </section>
  )
}

function ProvidersPane({ period, refreshToken }: { period: Period; refreshToken: number }) {
  const overview = usePolled<MenubarPayload>(() => codeburn.getOverview(period, 'all'), [period, refreshToken])
  const providers = Object.entries(overview.data?.current.providers ?? {})
  return <section className="set-p on">
    <div><h3 className="set-h">Providers</h3><p className="set-sub">codeburn auto-detects coding tools from local session files — no setup needed.</p></div>
    {overview.error ? <SettingsErrorText error={overview.error} /> : !overview.data ? <p className="set-cap">Loading detected providers…</p> : providers.length === 0 ? <p className="set-cap">No providers detected.</p> : providers.map(([name, cost]) => <div className="card" key={name}><div className="set-prov-head"><span className="set-prov-name">{name.charAt(0).toUpperCase() + name.slice(1)}</span><span className="set-status"><span className="set-dot ok" />Detected · {formatUsd(cost)}</span></div></div>)}
  </section>
}

function AliasesPane({ refreshToken }: { refreshToken: number }) {
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

function PlaceholderPane({ title, subtitle }: { title: string; subtitle: string }) {
  return <section className="set-p on"><div><h3 className="set-h">{title}</h3><p className="set-sub">{subtitle}</p></div><p className="set-cap">Wired up in the next pass.</p></section>
}

function DevicesPane({ identity, scan, devices, period }: { identity: ReturnType<typeof usePolled<Identity>>; scan: ReturnType<typeof usePolled<DeviceScanResult>>; devices: ReturnType<typeof usePolled<CombinedUsage>>; period: Period }) {
  return <section className="set-p on"><div><h3 className="set-h">Devices</h3><p className="set-sub">Combine usage across your machines.</p></div><ThisDevicePanel identity={identity} /><DiscoveredPanel scan={scan} /><PairedPanel devices={devices} period={period} /></section>
}

function PrivacyPane() {
  return <section className="set-p on"><div><h3 className="set-h">Privacy &amp; data</h3><p className="set-sub">What codeburn does, and does not do, with your data.</p></div><div className="card">
    <PrivacyClaim title="Local-only" detail="Everything runs on your machine. Data is read from local session files." icon={<><rect x="4.5" y="10" width="15" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>} />
    <PrivacyClaim title="No telemetry" detail="codeburn does not collect or send telemetry." icon={<><path d="M2 12s3.5-7 10-7 10 7 10 7" /><line x1="3" y1="3" x2="21" y2="21" /></>} />
    <PrivacyClaim title="No API keys" detail="Usage is detected from local files; no provider API keys are required." icon={<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />} />
  </div></section>
}

function PrivacyClaim({ title, detail, icon }: { title: string; detail: string; icon: React.ReactNode }) {
  return <div className="set-claim"><svg viewBox="0 0 24 24" aria-hidden="true">{icon}</svg><div><div className="set-claim-t">{title}</div><div className="set-claim-d">{detail}</div></div></div>
}

function ThisDevicePanel({ identity }: { identity: ReturnType<typeof usePolled<Identity>> }) {
  return <Panel title="This device">{identity.data ? <div className="li"><div className="lx"><b>{identity.data.name}</b><span>Visible on the local network as {identity.data.name}.local</span><span>{identity.data.fingerprint}</span></div><span className="btn btn-s" aria-disabled="true">Visibility: on</span></div> : identity.error ? <SettingsErrorText error={identity.error} /> : <p style={{ color: 'var(--t3)', margin: 0, fontSize: 12 }}>Reading this device identity…</p>}</Panel>
}

function DiscoveredPanel({ scan }: { scan: ReturnType<typeof usePolled<DeviceScanResult>> }) {
  const found = scan.data?.found.filter(device => !device.paired) ?? []
  return <Panel title="Discovered nearby" right={scan.loading ? 'listening…' : undefined}>{!scan.data && scan.error ? <SettingsErrorText error={scan.error} /> : !scan.data ? <p style={{ color: 'var(--t3)', margin: 0, fontSize: 12 }}>listening…</p> : found.length === 0 ? <p style={{ color: 'var(--t3)', margin: 0, fontSize: 12 }}>No nearby devices found.</p> : found.map(device => <div className="li" key={`${device.host}:${device.port}:${device.fingerprint}`}><div className="lx"><b>{device.name}</b><span className="hot">wants to pair · fingerprint {shortFingerprint(device.fingerprint)}</span></div><span className="btn btn-p" aria-disabled="true">Approve</span></div>)}</Panel>
}

function PairedPanel({ devices, period }: { devices: ReturnType<typeof usePolled<CombinedUsage>>; period: Period }) {
  const paired = devices.data?.perDevice.filter(device => !device.local) ?? []
  const deviceScope = devices.data ? `· ${devices.data.combined.deviceCount} devices` : '· paired devices'
  return <Panel title="Paired">{!devices.data && devices.error ? <SettingsErrorText error={devices.error} /> : !devices.data ? <p style={{ color: 'var(--t3)', margin: 0, fontSize: 12 }}>Loading paired devices…</p> : paired.length === 0 ? <p style={{ color: 'var(--t3)', margin: 0, fontSize: 12 }}>No paired devices yet.</p> : paired.map(device => <div className="li" key={device.id}><div className="lx"><b>{device.name}</b><span>{device.sessions.toLocaleString('en-US')} sessions · {formatUsd(device.cost)} {periodLabel(period)}</span></div><span className="btn btn-s" aria-disabled="true">Pull now</span></div>)}<div className="li"><div className="lx"><b>Combine usage from paired devices</b><span>scope captions gain “{deviceScope}” when on</span></div><span className="tglon" aria-disabled="true" /></div></Panel>
}

function SettingsErrorText({ error }: { error: CliError }) {
  if (error.kind === 'not-found') { const display = cliErrorDisplay(error); return <p style={{ color: 'var(--t3)', margin: 0, fontSize: 12 }}>{display.title}</p> }
  return <CliErrorText error={error} />
}

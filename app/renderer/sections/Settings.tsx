import { useEffect, useState } from 'react'

import { Hint } from '../components/Hint'
import { CliErrorText, cliErrorDisplay } from '../components/CliErrorPanel'
import { Panel } from '../components/Panel'
import { ProviderLogo } from '../components/ProviderLogo'
import type { Section } from '../components/Sidebar'
import { usePolled } from '../hooks/usePolled'
import { formatUsd } from '../lib/format'
import { codeburn } from '../lib/ipc'
import type { ActionResult, AliasRow, CliError, CombinedUsage, DeviceScanResult, Identity, JsonPlanSummary, MenubarPayload, Period, PlanId, PlanProvider, ShareStatus, StatusJson } from '../lib/types'

export type SettingsPane = 'general' | 'providers' | 'aliases' | 'plans' | 'devices' | 'export' | 'privacy'
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

export function Settings({ period, refreshToken = 0, onNavigate, initialPane }: { period: Period; refreshToken?: number; onNavigate?: (section: Section) => void; initialPane?: SettingsPane }) {
  const [pane, setPane] = useState<Pane>(initialPane ?? 'general')

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
          {pane === 'plans' && <PlansPane period={period} refreshToken={refreshToken} onNavigate={onNavigate} />}
          {pane === 'devices' && <DevicesPane period={period} refreshToken={refreshToken} />}
          {pane === 'export' && <ExportPane period={period} refreshToken={refreshToken} />}
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
    <div><h3 className="set-h">Providers</h3><p className="set-sub">codeburn auto-detects coding tools from local session files. No setup needed.</p></div>
    {overview.error ? <SettingsErrorText error={overview.error} /> : !overview.data ? <p className="set-cap">Loading detected providers…</p> : providers.length === 0 ? <p className="set-cap">No providers detected.</p> : providers.map(([name, cost]) => <div className="card" key={name}><div className="set-prov-head"><ProviderLogo provider={name} /><span className="set-prov-name">{name.charAt(0).toUpperCase() + name.slice(1)}</span><span className="set-status"><span className="set-dot ok" />Detected · {formatUsd(cost)}</span></div></div>)}
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

function planSummaries(status: StatusJson): JsonPlanSummary[] {
  if (status.plans) return Object.values(status.plans).filter((plan): plan is JsonPlanSummary => Boolean(plan))
  return status.plan ? [status.plan] : []
}

function PlansPane({ period, refreshToken, onNavigate }: { period: Period; refreshToken: number; onNavigate?: (section: Section) => void }) {
  const [nonce, setNonce] = useState(0)
  const plans = usePolled<StatusJson>(() => codeburn.getPlans(period), [period, refreshToken, nonce])
  const [presetId, setPresetId] = useState(PLAN_PRESETS[0]!.id)
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)
  const configured = plans.data ? planSummaries(plans.data) : []

  const finish = (result: ActionResult) => {
    setMessage({ text: result.ok ? (result.stdout.trim() || 'Plan updated') : (result.stderr || 'Plan action failed'), error: !result.ok })
    if (result.ok) setNonce(value => value + 1)
  }
  const remove = (plan: JsonPlanSummary) => {
    if (!window.confirm(`Remove the ${plan.provider} plan?`)) return
    void codeburn.resetPlan(plan.provider).then(finish)
  }
  const add = () => {
    const preset = PLAN_PRESETS.find(item => item.id === presetId)!
    void codeburn.setPlan(preset.id, preset.provider).then(finish)
  }

  return <section className="set-p on">
    <div><h3 className="set-h">Plans</h3><p className="set-sub">Set a monthly budget plan per provider. codeburn compares it to your API-equivalent spend.</p></div>
    <div className="card">
      <div className="about-sec">
        {plans.error ? <SettingsErrorText error={plans.error} /> : !plans.data ? <p className="set-cap">Loading plans…</p> : configured.length === 0 ? <p className="set-cap">No plans configured.</p> : configured.map(plan => <div className="about-row" key={plan.provider}><span className="tx">{PLAN_PRESETS.find(item => item.id === plan.id)?.label ?? plan.id}<small>${plan.budget}/month · {plan.provider} · {plan.percentUsed}% used</small></span><span className="r"><button className="btnp" onClick={() => remove(plan)}>Remove</button></span></div>)}
      </div>
      <div className="about-sec set-last-sec">
        <div className="about-row"><label className="tx" htmlFor="settings-plan-preset">Add a plan</label><span className="r"><select id="settings-plan-preset" className="set-input" value={presetId} onChange={event => setPresetId(event.target.value as PlanPreset['id'])}>{PLAN_PRESETS.map(preset => <option key={preset.id} value={preset.id}>{preset.label}</option>)}</select><button className="btnp btnp-primary" onClick={add}>Add</button></span></div>
        {message && <p className={message.error ? 'set-action-msg error' : 'set-action-msg'}>{message.text}</p>}
      </div>
    </div>
    <p className="set-cap">Presets: Claude Pro, Claude Max 20x, Claude Max 5x, Cursor Pro, SuperGrok, and SuperGrok Heavy. <button className="set-text-button" onClick={() => onNavigate?.('plans')}>Open Plans →</button></p>
  </section>
}

function ExportPane({ period, refreshToken }: { period: Period; refreshToken: number }) {
  const overview = usePolled<MenubarPayload>(() => codeburn.getOverview(period, 'all'), [period, refreshToken])
  const [format, setFormat] = useState<'csv' | 'json'>('csv')
  const [provider, setProvider] = useState('all')
  const [destination, setDestination] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)
  const providers = Object.keys(overview.data?.current.providers ?? {})

  const chooseDirectory = async () => {
    const selected = await codeburn.chooseDirectory()
    if (selected) setDestination(selected)
  }
  const exportNow = async () => {
    if (!destination) return
    setExporting(true)
    setMessage(null)
    try {
      const result = await codeburn.exportData(format, provider, destination)
      setMessage({ text: result.ok ? `Exported to ${destination}` : (result.stderr || 'Export failed'), error: !result.ok })
    } finally {
      setExporting(false)
    }
  }

  return <section className="set-p on">
    <div><h3 className="set-h">Export</h3><p className="set-sub">Save your usage as CSV or JSON. Everything stays on your machine.</p></div>
    <div className="card">
      <div className="about-sec">
        <div className="about-row"><span className="tx">Format</span><span className="r"><span className="seg"><button className={format === 'csv' ? 'on' : undefined} onClick={() => setFormat('csv')}>CSV</button><button className={format === 'json' ? 'on' : undefined} onClick={() => setFormat('json')}>JSON</button></span></span></div>
        <div className="about-row"><label className="tx" htmlFor="settings-export-provider">Provider</label><span className="r"><select id="settings-export-provider" className="set-input" value={provider} onChange={event => setProvider(event.target.value)}><option value="all">All providers</option>{providers.map(value => <option value={value} key={value}>{value.charAt(0).toUpperCase() + value.slice(1)}</option>)}</select></span></div>
        <div className="about-row"><span className="tx">Destination</span><span className="r set-export-destination"><span className="set-mono">{destination ?? 'Choose a folder…'}</span><button className="btnp" onClick={() => void chooseDirectory()}>Choose folder…</button></span></div>
      </div>
      <div className="about-sec set-last-sec"><div className="about-row"><span className="tx" /><span className="r"><button className="btnp btnp-primary" disabled={!destination || exporting} onClick={() => void exportNow()}>{exporting ? 'Exporting…' : 'Export'}</button></span></div>{message && <p className={message.error ? 'set-action-msg error' : 'set-action-msg'}>{message.text}</p>}</div>
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
  return <section className="set-p on"><div><h3 className="set-h">Privacy &amp; data</h3><p className="set-sub">What codeburn does, and does not do, with your data.</p></div><div className="card">
    <PrivacyClaim title="Local-only" detail="Everything runs on your machine. Data is read from local session files." icon={<><rect x="4.5" y="10" width="15" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>} />
    <PrivacyClaim title="No telemetry" detail="codeburn does not collect or send telemetry." icon={<><path d="M2 12s3.5-7 10-7 10 7 10 7" /><line x1="3" y1="3" x2="21" y2="21" /></>} />
    <PrivacyClaim title="No API keys" detail="Usage is detected from local files; no provider API keys are required." icon={<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />} />
  </div></section>
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
    if (!window.confirm(`Remove paired device ${name}?`)) return
    void codeburn.removeDevice(name).then(result => {
      if (!result.ok) { setError(result.stderr || 'Unable to remove device'); return }
      setError('')
      onRefresh()
    })
  }
  return <Panel title="Paired devices" right={<button className="set-text-button" onClick={onRefresh}>Refresh</button>}>{!devices.data && devices.error ? <SettingsErrorText error={devices.error} /> : !devices.data ? <p className="set-cap">Loading paired devices…</p> : paired.length === 0 ? <p className="set-cap">No paired devices yet.</p> : paired.map(device => <div className="li" key={device.id}><div className="lx"><b>{device.name}</b><span>{device.sessions.toLocaleString('en-US')} sessions · {formatUsd(device.cost)} {periodLabel(period)}</span></div><button className="btnp" onClick={() => remove(device.name)}>Remove</button></div>)}{devices.data && devices.data.combined.deviceCount > 1 && <div className="li"><div className="lx"><b>Combined view active · {devices.data.combined.deviceCount} devices</b></div></div>}{error && <p className="set-action-msg error">{error}</p>}</Panel>
}

function SettingsErrorText({ error }: { error: CliError }) {
  if (error.kind === 'not-found') { const display = cliErrorDisplay(error); return <p className="set-cap">{display.title}</p> }
  return <CliErrorText error={error} />
}

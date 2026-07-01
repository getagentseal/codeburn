import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import {
  approvePairing,
  fetchDevices,
  PERIODS,
  shareStatus,
  startShare,
  stopShare,
  type DeviceUsage,
  type Payload,
  type Period,
} from '@/lib/api'
import { cn, fmtNum, fmtTokens, usd } from '@/lib/utils'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { MetricCard } from '@/components/MetricCard'
import { BarList, type BarItem } from '@/components/BarList'
import { DataTable } from '@/components/DataTable'
import { UsageChart, DeviceUsageChart, type Unit } from '@/components/UsageChart'
import { DeviceSearchModal } from '@/components/DeviceSearchModal'

const n = (v: number | undefined): number => v ?? 0

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="px-5 py-4">
      <h2 className="mb-3.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-heading">{title}</h2>
      {children}
    </Card>
  )
}

function SideLink({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13.5px] transition-colors max-md:min-h-9',
        active ? 'bg-interactive-secondary font-medium text-foreground' : 'font-light text-muted-foreground hover:text-foreground',
      )}
    >
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', active ? 'bg-primary' : 'bg-transparent')} />
      <span className="truncate">{children}</span>
    </button>
  )
}

function Switch({ on }: { on: boolean }) {
  return (
    <span
      className={cn(
        'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors',
        on ? 'bg-primary' : 'bg-interactive-secondary ring-1 ring-inset ring-border',
      )}
    >
      <span className={cn('inline-block h-3 w-3 transform rounded-full bg-card shadow-sm transition-transform', on ? 'translate-x-3.5' : 'translate-x-0.5')} />
    </span>
  )
}

function Stat({ label: lbl, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-tertiary-foreground">{lbl}</span>
      <span className="tabular-nums text-foreground">{value}</span>
    </div>
  )
}

// One device's full dashboard. Remote devices arrive sanitized, so their
// project and session detail is intentionally absent.
function DeviceView({ payload, isRemote, unit }: { payload?: Payload; isRemote: boolean; unit: Unit }) {
  const c = payload?.current
  const daily = payload?.history.daily ?? []
  const cacheWrite = daily.reduce((s, d) => s + d.cacheWriteTokens, 0)
  const cacheRead = daily.reduce((s, d) => s + d.cacheReadTokens, 0)
  const toolBars: BarItem[] = c
    ? Object.entries(c.providers).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ name: k, value: v, display: usd(v) }))
    : []
  const modelBars: BarItem[] = c
    ? c.topModels.filter((m) => m.cost > 0).slice(0, 8).map((m) => ({ name: m.name, value: m.cost, display: usd(m.cost) }))
    : []
  const activityBars: BarItem[] = c
    ? c.topActivities.filter((a) => a.cost > 0).map((a) => ({ name: a.name, value: a.cost, display: usd(a.cost) }))
    : []

  return (
    <>
      <Card className="mb-3 overflow-hidden">
        <div className="flex items-end justify-between px-5 pt-4">
          <div>
            <div className="text-xs text-tertiary-foreground">
              {c ? `${fmtNum(c.calls)} calls · ${fmtNum(c.sessions)} sessions` : ' '}
            </div>
            <div className="mt-1 font-display text-4xl tracking-tight tabular-nums text-primary">
              {c ? (unit === 'tokens' ? fmtTokens(c.inputTokens + c.outputTokens) : usd(c.cost)) : <Skeleton className="h-10 w-36" />}
            </div>
          </div>
        </div>
        <div className="mt-3 h-64 px-2 pb-2">
          {!payload ? <Skeleton className="mx-3 mb-3 h-[228px]" /> : <UsageChart daily={payload.history.daily} unit={unit} />}
        </div>
      </Card>

      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {c ? (
          <>
            <MetricCard label="Cost" value={usd(c.cost)} accent />
            <MetricCard
              label="Tokens"
              value={fmtTokens(c.inputTokens + c.outputTokens)}
              sub={`in ${fmtTokens(c.inputTokens)} / out ${fmtTokens(c.outputTokens)}`}
            />
            <MetricCard label="Calls" value={fmtNum(c.calls)} />
            <MetricCard label="Sessions" value={fmtNum(c.sessions)} />
            <MetricCard label="Cache hit" value={`${(c.cacheHitPercent || 0).toFixed(1)}%`} />
            <MetricCard label="Cache write" value={fmtTokens(cacheWrite)} />
            <MetricCard label="Cache read" value={fmtTokens(cacheRead)} />
            <MetricCard label="One-shot" value={c.oneShotRate == null ? '—' : `${Math.round(c.oneShotRate * 100)}%`} />
          </>
        ) : (
          Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-20" />)
        )}
      </div>

      <div className="mb-3 grid gap-3 lg:grid-cols-2">
        <Panel title="By tool">
          <BarList items={toolBars} total={c?.cost} />
        </Panel>
        <Panel title="Top models">
          <BarList items={modelBars} total={c?.cost} />
        </Panel>
      </div>

      <div className="mb-3 grid gap-3 lg:grid-cols-2">
        <Panel title="Top projects">
          {isRemote ? (
            <p className="py-6 text-center text-sm text-tertiary-foreground">
              Project and session detail stays on that device. Only totals are shared.
            </p>
          ) : (
            <DataTable
              columns={[
                { key: 'name', label: 'Project' },
                { key: 'cost', label: 'Cost', num: true },
                { key: 'sessions', label: 'Sessions', num: true },
              ]}
              rows={(c?.topProjects ?? []).slice(0, 10).map((p) => ({
                name: p.name,
                cost: usd(p.cost),
                sessions: fmtNum(p.sessions),
              }))}
            />
          )}
        </Panel>
        <Panel title="By activity">
          <BarList items={activityBars} total={c?.cost} />
        </Panel>
      </div>

      <div className="mb-3 grid gap-3 lg:grid-cols-2">
        <Panel title="Subagents">
          <DataTable
            columns={[
              { key: 'name', label: 'Subagent' },
              { key: 'calls', label: 'Calls', num: true },
              { key: 'cost', label: 'Cost', num: true },
            ]}
            rows={(c?.subagents ?? []).slice(0, 10).map((s) => ({ name: s.name, calls: fmtNum(s.calls), cost: usd(s.cost) }))}
          />
        </Panel>
        <Panel title="Skills">
          <DataTable
            columns={[
              { key: 'name', label: 'Skill' },
              { key: 'turns', label: 'Turns', num: true },
              { key: 'cost', label: 'Cost', num: true },
            ]}
            rows={(c?.skills ?? []).slice(0, 10).map((s) => ({ name: s.name, turns: fmtNum(s.turns), cost: usd(s.cost) }))}
          />
        </Panel>
      </div>

      <div className="mb-3 grid gap-3 lg:grid-cols-2">
        <Panel title="MCP servers">
          <DataTable
            columns={[
              { key: 'name', label: 'Server' },
              { key: 'calls', label: 'Calls', num: true },
            ]}
            rows={(c?.mcpServers ?? []).slice(0, 10).map((m) => ({ name: m.name, calls: fmtNum(m.calls) }))}
          />
        </Panel>
        <Panel title="Savings & waste">
          {c ? (
            <div className="flex flex-col gap-3 py-1">
              <Stat label="Local-model savings" value={usd(c.localModelSavings?.totalUSD)} />
              <Stat
                label={`Retry tax${c.retryTax?.retries ? ` (${fmtNum(c.retryTax.retries)} retries)` : ''}`}
                value={usd(c.retryTax?.totalUSD)}
              />
              <Stat label="Routing waste (potential)" value={usd(c.routingWaste?.totalSavingsUSD)} />
            </div>
          ) : (
            <Skeleton className="h-20" />
          )}
        </Panel>
      </div>

      <Panel title="Tools">
        <DataTable
          columns={[
            { key: 'name', label: 'Tool' },
            { key: 'calls', label: 'Calls', num: true },
          ]}
          rows={(c?.tools ?? []).slice(0, 14).map((t) => ({ name: t.name, calls: fmtNum(t.calls) }))}
        />
      </Panel>
    </>
  )
}

// The "All devices" view: combined totals plus a per-device breakdown. Devices
// are summed for display only; nothing is merged on the server.
function CombinedView({ devices, unit }: { devices: DeviceUsage[]; unit: Unit }) {
  const rows = devices.map((d) => {
    const c = d.payload?.current
    return {
      name: d.name,
      local: d.local,
      cost: n(c?.cost),
      tokens: n(c?.inputTokens) + n(c?.outputTokens),
      calls: n(c?.calls),
      sessions: n(c?.sessions),
      error: d.error,
    }
  })
  const total = rows.reduce(
    (a, r) => ({ cost: a.cost + r.cost, tokens: a.tokens + r.tokens, calls: a.calls + r.calls, sessions: a.sessions + r.sessions }),
    { cost: 0, tokens: 0, calls: 0, sessions: 0 },
  )
  const reachable = devices.filter((d) => d.payload).length

  const providers = new Map<string, number>()
  const models = new Map<string, number>()
  const activities = new Map<string, number>()
  let inTok = 0
  let outTok = 0
  let cacheWrite = 0
  let cacheRead = 0
  for (const d of devices) {
    const c = d.payload?.current
    if (!c) continue
    inTok += c.inputTokens
    outTok += c.outputTokens
    for (const e of d.payload?.history.daily ?? []) {
      cacheWrite += e.cacheWriteTokens
      cacheRead += e.cacheReadTokens
    }
    for (const [k, v] of Object.entries(c.providers)) providers.set(k, (providers.get(k) ?? 0) + v)
    for (const m of c.topModels) models.set(m.name, (models.get(m.name) ?? 0) + m.cost)
    for (const a of c.topActivities) activities.set(a.name, (activities.get(a.name) ?? 0) + a.cost)
  }
  const toolBars: BarItem[] = [...providers.entries()]
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => ({ name: k, value: v, display: usd(v) }))
  const modelBars: BarItem[] = [...models.entries()]
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([k, v]) => ({ name: k, value: v, display: usd(v) }))
  const taskBars: BarItem[] = [...activities.entries()]
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => ({ name: k, value: v, display: usd(v) }))

  return (
    <>
      <Card className="mb-3 overflow-hidden">
        <div className="flex items-end justify-between px-5 pt-4">
          <div>
            <div className="text-xs text-tertiary-foreground">{`${reachable} device${reachable === 1 ? '' : 's'} · ${fmtNum(total.calls)} calls`}</div>
            <div className="mt-1 font-display text-4xl tracking-tight tabular-nums text-primary">
              {unit === 'tokens' ? fmtTokens(total.tokens) : usd(total.cost)}
            </div>
          </div>
        </div>
        <div className="mt-3 h-64 px-2 pb-2">
          <DeviceUsageChart devices={devices} unit={unit} />
        </div>
      </Card>

      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricCard label="Total cost" value={usd(total.cost)} accent />
        <MetricCard label="Tokens" value={fmtTokens(total.tokens)} sub={`in ${fmtTokens(inTok)} / out ${fmtTokens(outTok)}`} />
        <MetricCard label="Calls" value={fmtNum(total.calls)} />
        <MetricCard label="Sessions" value={fmtNum(total.sessions)} />
        <MetricCard label="Cache write" value={fmtTokens(cacheWrite)} />
        <MetricCard label="Cache read" value={fmtTokens(cacheRead)} />
        <MetricCard label="Devices" value={String(reachable)} />
      </div>

      <Panel title="By device">
        <DataTable
          columns={[
            { key: 'device', label: 'Device' },
            { key: 'cost', label: 'Cost', num: true },
            { key: 'tokens', label: 'Tokens', num: true },
            { key: 'calls', label: 'Calls', num: true },
            { key: 'sessions', label: 'Sessions', num: true },
          ]}
          rows={rows.map((r) => ({
            device: r.name + (r.local ? ' · this Mac' : ''),
            cost: r.error ? <span className="text-tertiary-foreground">unreachable</span> : usd(r.cost),
            tokens: r.error ? '—' : fmtTokens(r.tokens),
            calls: r.error ? '—' : fmtNum(r.calls),
            sessions: r.error ? '—' : fmtNum(r.sessions),
          }))}
        />
      </Panel>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <Panel title="By task (all devices)">
          <BarList items={taskBars} total={total.cost} />
        </Panel>
        <Panel title="By tool (all devices)">
          <BarList items={toolBars} total={total.cost} />
        </Panel>
      </div>

      <div className="mt-3">
        <Panel title="Top models (all devices)">
          <BarList items={modelBars} total={total.cost} />
        </Panel>
      </div>
    </>
  )
}

export function App() {
  const [period, setPeriod] = useState<Period>('today')
  const [provider, setProvider] = useState('all')
  const [view, setView] = useState<string>('all')
  const [unit, setUnit] = useState<Unit>('cost')
  const [searchOpen, setSearchOpen] = useState(false)
  // Mobile only: the sidebar collapses to an off-canvas drawer below md.
  // On desktop this flag is inert (the max-md: transform classes don't apply).
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [responded, setResponded] = useState<Set<string>>(new Set())

  const qc = useQueryClient()

  const { data, isError, error, refetch } = useQuery({
    queryKey: ['devices', period, provider],
    queryFn: () => fetchDevices(period, provider),
    initialData: () => (period === 'today' && provider === 'all' ? window.__CODEBURN_BOOTSTRAP__ : undefined),
    // Bootstrap paints instantly but is stale by definition, so refetch at once
    // (the default 30s staleTime would otherwise hide a live peer until then).
    initialDataUpdatedAt: 0,
    // When devices are paired, re-pull periodically so a device that briefly
    // dropped (asleep/network blip) reappears on its own instead of staying
    // gone until you switch tabs.
    refetchInterval: (q) => ((q.state.data?.devices?.some((d) => !d.local) ?? false) ? 20000 : false),
  })

  const { data: shareInfo } = useQuery({
    queryKey: ['share'],
    queryFn: shareStatus,
    refetchInterval: (q) => (q.state.data?.sharing ? 2500 : 8000),
  })

  const refreshShare = () => qc.invalidateQueries({ queryKey: ['share'] })
  const toggleShare = async () => {
    if (shareInfo?.sharing) await stopShare()
    else await startShare(shareInfo?.always ?? false)
    refreshShare()
  }
  const toggleAlways = async () => {
    await startShare(!(shareInfo?.always ?? false))
    refreshShare()
  }
  const respondPairing = async (id: string, approve: boolean) => {
    setResponded((s) => new Set(s).add(id)) // drop it from the prompt at once so it can't be double-clicked
    await approvePairing(id, approve)
    refreshShare()
    void refetch()
  }
  const pending = (shareInfo?.pending ?? []).filter((p) => !responded.has(p.id))

  // Only show devices we could actually reach; an unreachable paired device is
  // hidden entirely rather than shown as an error row.
  const devices = (data?.devices ?? []).filter((d) => d.payload)
  const local = devices.find((d) => d.local)
  const multi = devices.some((d) => !d.local)
  const viewing = view === 'all' ? undefined : devices.find((d) => d.id === view)
  const primary = viewing ?? local
  const c0 = primary?.payload?.current

  const providerOptions = useMemo(
    () =>
      c0
        ? Object.entries(c0.providers)
            .filter(([, v]) => v > 0)
            .sort((a, b) => b[1] - a[1])
            .map(([k]) => k)
        : [],
    [c0],
  )

  // If the device you're viewing drops off (slept/unreachable), fall back to
  // All devices instead of showing an empty panel with nothing selected.
  useEffect(() => {
    if (view !== 'all' && data && !devices.some((d) => d.id === view)) setView('all')
  }, [view, devices, data])

  // If the selected provider isn't present on the current view, reset to all
  // (otherwise a healthy device shows empty under a filter it has no data for).
  useEffect(() => {
    if (provider !== 'all' && c0 && !providerOptions.includes(provider)) setProvider('all')
  }, [provider, providerOptions, c0])

  const showCombined = multi && view === 'all'
  const viewTitle = showCombined ? 'All devices' : (primary ? primary.name + (primary.local ? ' · this Mac' : '') : 'Loading…')
  const label = local?.payload?.current?.label ?? ''

  return (
    <div className="min-h-screen bg-outer-background p-2.5 max-md:min-h-[100dvh]">
      <div className="flex h-[calc(100vh-20px)] flex-col gap-2.5 max-md:h-[calc(100dvh-20px)]">
        <header className="flex h-12 shrink-0 items-center gap-4 rounded-md border border-border bg-card px-5 shadow-[0_2px_8px_rgba(0,0,0,0.03)] max-md:gap-3 max-md:px-3">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open menu"
            aria-expanded={sidebarOpen}
            aria-controls="dashboard-sidebar"
            className="-ml-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-foreground transition-colors hover:bg-interactive-secondary md:hidden"
          >
            <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
            </svg>
          </button>
          <div className="flex items-center gap-2 max-md:shrink-0">
            <img src="/codeburn-logo.png" alt="CodeBurn" className="h-6 w-6" />
            <span className="text-lg font-semibold tracking-[-0.02em] text-foreground">
              Code<span className="text-[#e8553a]">Burn</span>
            </span>
            <span className="ml-1 text-[11px] font-light uppercase tracking-[0.14em] text-tertiary-foreground max-sm:hidden">usage</span>
          </div>

          <div className="ml-auto flex items-center gap-2 max-md:min-w-0 max-md:overflow-x-auto max-md:[-ms-overflow-style:none] max-md:[scrollbar-width:none] max-md:[&::-webkit-scrollbar]:hidden">
            <div className="flex rounded-md border border-border bg-interactive-secondary p-0.5 max-md:shrink-0">
              {PERIODS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => setPeriod(p.key)}
                  className={cn(
                    'rounded-[5px] px-3 py-1 text-xs font-medium transition-colors max-md:inline-flex max-md:min-h-9 max-md:items-center max-md:justify-center',
                    period === p.key ? 'bg-active-primary text-foreground shadow-sm' : 'text-tertiary-foreground hover:text-foreground',
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="flex rounded-md border border-border bg-interactive-secondary p-0.5 max-md:shrink-0">
              {(['cost', 'tokens'] as Unit[]).map((u) => (
                <button
                  key={u}
                  type="button"
                  onClick={() => setUnit(u)}
                  className={cn(
                    'rounded-[5px] px-3 py-1 text-xs font-medium transition-colors max-md:inline-flex max-md:min-h-9 max-md:items-center max-md:justify-center',
                    unit === u ? 'bg-active-primary text-foreground shadow-sm' : 'text-tertiary-foreground hover:text-foreground',
                  )}
                >
                  {u === 'cost' ? 'Cost' : 'Tokens'}
                </button>
              ))}
            </div>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              className="rounded-md border border-border bg-card px-3 py-1.5 text-xs text-foreground outline-none max-md:min-h-9 max-md:shrink-0"
            >
              <option value="all">All tools</option>
              {providerOptions.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 gap-2.5">
          {sidebarOpen && (
            <button
              type="button"
              aria-label="Close menu"
              onClick={() => setSidebarOpen(false)}
              className="fixed inset-0 z-30 bg-black/40 md:hidden"
            />
          )}
          <aside
            id="dashboard-sidebar"
            className={cn(
              'flex w-60 shrink-0 flex-col gap-5 overflow-y-auto rounded-md border border-border bg-card p-5',
              'max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:rounded-none max-md:shadow-2xl max-md:transition-[transform,visibility] max-md:duration-200 max-md:ease-out',
              // Closed below md: slide off-canvas AND go visibility:hidden so its
              // links leave the tab order / a11y tree (not just visually hidden).
              sidebarOpen ? 'max-md:visible max-md:translate-x-0' : 'max-md:invisible max-md:-translate-x-full',
            )}
          >
            <button
              type="button"
              aria-label="Close menu"
              onClick={() => setSidebarOpen(false)}
              className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-md text-tertiary-foreground transition-colors hover:bg-interactive-secondary hover:text-foreground md:hidden"
            >
              <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
            <div className="flex flex-col gap-1">
              <p className="mb-1 px-2.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-heading">Devices</p>
              {multi && (
                <SideLink active={view === 'all'} onClick={() => { setView('all'); setSidebarOpen(false) }}>
                  All devices
                </SideLink>
              )}
              {devices.map((d) => (
                <SideLink
                  key={d.id}
                  active={view === d.id || (!multi && view === 'all' && d.local)}
                  onClick={() => { setView(d.id); setSidebarOpen(false) }}
                >
                  {d.name}
                  {d.local ? ' · this Mac' : ''}
                </SideLink>
              ))}
              {devices.length === 0 && <p className="px-2.5 py-1 text-xs text-tertiary-foreground">Loading…</p>}
            </div>

            <button
              type="button"
              onClick={() => { setSearchOpen(true); setSidebarOpen(false) }}
              className="flex items-center justify-center gap-2 rounded-md border border-border px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-interactive-secondary max-md:min-h-9"
            >
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <circle cx="7" cy="7" r="4.5" />
                <path d="M10.5 10.5L14 14" />
              </svg>
              Search local devices
            </button>

            <div className="border-t border-border pt-4">
              <p className="mb-2 px-2.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-heading">Share</p>
              <button
                type="button"
                onClick={() => void toggleShare()}
                className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-[13.5px] text-foreground transition-colors hover:bg-interactive-secondary max-md:min-h-9"
              >
                <span>Share this device</span>
                <Switch on={!!shareInfo?.sharing} />
              </button>
              {shareInfo?.sharing && (
                <div className="mt-1.5 px-2.5">
                  <p className="text-[11px] leading-relaxed text-tertiary-foreground">
                    Discoverable as &ldquo;{shareInfo.name}&rdquo; · {shareInfo.peers} paired
                  </p>
                  <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={shareInfo.always}
                      onChange={() => void toggleAlways()}
                      className="h-3.5 w-3.5 accent-[#1f8a5b]"
                    />
                    Keep sharing always
                  </label>
                </div>
              )}
            </div>

            <div className="mt-auto border-t border-border pt-4">
              <p className="text-[11px] leading-relaxed text-tertiary-foreground">
                Local only. Nothing leaves your machine; only totals are shared between your devices.
              </p>
              <div className="mt-3 flex items-center gap-1">
                <a
                  href="https://codeburn.app/"
                  target="_blank"
                  rel="noreferrer"
                  title="codeburn.app"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-tertiary-foreground transition-colors hover:bg-interactive-secondary hover:text-foreground"
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M3 12h18" />
                    <path d="M12 3c2.5 2.7 2.5 15.3 0 18M12 3c-2.5 2.7-2.5 15.3 0 18" />
                  </svg>
                </a>
                <a
                  href="https://discord.com/invite/w2sw8mCqep"
                  target="_blank"
                  rel="noreferrer"
                  title="Discord"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-tertiary-foreground transition-colors hover:bg-interactive-secondary hover:text-foreground"
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                    <path d="M20.317 4.369A19.79 19.79 0 0 0 16.558 3c-.2.36-.43.85-.59 1.23a18.27 18.27 0 0 0-5.93 0A12.6 12.6 0 0 0 9.44 3 19.7 19.7 0 0 0 5.68 4.37C2.9 8.46 2.14 12.45 2.52 16.38a19.9 19.9 0 0 0 6.07 3.08c.49-.67.93-1.38 1.3-2.13-.71-.27-1.4-.6-2.04-.99.17-.13.34-.26.5-.4 3.93 1.84 8.18 1.84 12.06 0 .17.14.33.27.5.4-.65.39-1.33.72-2.05.99.38.75.81 1.46 1.3 2.13a19.9 19.9 0 0 0 6.07-3.08c.45-4.55-.77-8.5-3.2-12.01zM9.69 14.5c-1.18 0-2.15-1.08-2.15-2.42 0-1.33.95-2.42 2.15-2.42 1.2 0 2.17 1.09 2.15 2.42 0 1.34-.95 2.42-2.15 2.42zm4.62 0c-1.18 0-2.15-1.08-2.15-2.42 0-1.33.95-2.42 2.15-2.42 1.2 0 2.17 1.09 2.15 2.42 0 1.34-.94 2.42-2.15 2.42z" />
                  </svg>
                </a>
                <a
                  href="https://x.com/_codeburn"
                  target="_blank"
                  rel="noreferrer"
                  title="X"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-tertiary-foreground transition-colors hover:bg-interactive-secondary hover:text-foreground"
                >
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
                    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.65l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                  </svg>
                </a>
              </div>
            </div>
          </aside>

          <main className="min-w-0 flex-1 overflow-y-auto pr-0.5">
            <div className="mb-3 flex items-baseline justify-between">
              <h1 className="font-display text-xl tracking-tight text-foreground">{viewTitle}</h1>
              <span className="text-xs text-tertiary-foreground">{label}</span>
            </div>

            {showCombined ? (
              <CombinedView devices={devices} unit={unit} />
            ) : (
              <DeviceView payload={primary?.payload} isRemote={!!viewing && !viewing.local} unit={unit} />
            )}

            {isError && (
              <div className="mt-4 text-sm text-tertiary-foreground">Failed to load: {String((error as Error)?.message)}</div>
            )}
          </main>
        </div>
      </div>

      {searchOpen && <DeviceSearchModal onClose={() => setSearchOpen(false)} onPaired={() => void refetch()} />}

      {pending.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="w-full max-w-sm overflow-hidden rounded-lg border border-border bg-card shadow-[0_24px_60px_-20px_rgba(0,0,0,0.35)]">
            <div className="border-b border-border px-5 py-3.5">
              <h2 className="text-sm font-semibold text-foreground">Incoming pairing request</h2>
            </div>
            <div className="flex flex-col gap-3 px-5 py-4">
              {pending.map((p) => (
                <div key={p.id} className="rounded-md border border-border px-3.5 py-3">
                  <p className="text-sm text-foreground">
                    &ldquo;{p.name}&rdquo; wants to pair with this device.
                  </p>
                  <p className="mt-1 text-xs text-tertiary-foreground">
                    Confirm this code matches on that device: <span className="font-mono text-foreground">{p.code}</span>
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={() => void respondPairing(p.id, true)}
                      className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => void respondPairing(p.id, false)}
                      className="rounded-md border border-border px-3 py-1.5 text-xs text-tertiary-foreground transition-colors hover:text-foreground"
                    >
                      Deny
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

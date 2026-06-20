import { useMemo, useState, type ReactNode } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'

import { fetchDevices, PERIODS, type DailyEntry, type DeviceUsage, type Payload, type Period } from '@/lib/api'
import { cn, fmtNum, fmtTokens, usd } from '@/lib/utils'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { MetricCard } from '@/components/MetricCard'
import { BarList, type BarItem } from '@/components/BarList'
import { DataTable } from '@/components/DataTable'
import { UsageChart } from '@/components/UsageChart'
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
        'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13.5px] transition-colors',
        active ? 'bg-interactive-secondary font-medium text-foreground' : 'font-light text-muted-foreground hover:text-foreground',
      )}
    >
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', active ? 'bg-primary' : 'bg-transparent')} />
      <span className="truncate">{children}</span>
    </button>
  )
}

// One device's full dashboard. Remote devices arrive sanitized, so their
// project and session detail is intentionally absent.
function DeviceView({ payload, isRemote }: { payload?: Payload; isRemote: boolean }) {
  const c = payload?.current
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
              {c ? usd(c.cost) : <Skeleton className="h-10 w-36" />}
            </div>
          </div>
        </div>
        <div className="mt-3 h-64 px-2 pb-2">
          {!payload ? <Skeleton className="mx-3 mb-3 h-[228px]" /> : <UsageChart daily={payload.history.daily} />}
        </div>
      </Card>

      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
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
            <MetricCard label="One-shot" value={c.oneShotRate == null ? '—' : `${Math.round(c.oneShotRate * 100)}%`} />
          </>
        ) : (
          Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-20" />)
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

// Merge every device's daily history by date for the combined chart, summing
// per-model costs so the stacked bars stay correct.
function mergeDaily(devices: DeviceUsage[]): DailyEntry[] {
  const byDate = new Map<string, DailyEntry>()
  for (const d of devices) {
    for (const e of d.payload?.history.daily ?? []) {
      const cur =
        byDate.get(e.date) ??
        { date: e.date, cost: 0, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, topModels: [] }
      cur.cost += e.cost
      cur.calls += e.calls
      cur.inputTokens += e.inputTokens
      cur.outputTokens += e.outputTokens
      cur.cacheReadTokens += e.cacheReadTokens
      cur.cacheWriteTokens += e.cacheWriteTokens
      const m = new Map(cur.topModels.map((x) => [x.name, { ...x }]))
      for (const tm of e.topModels) {
        const ex = m.get(tm.name)
        if (ex) {
          ex.cost += tm.cost
          ex.calls += tm.calls
          ex.inputTokens += tm.inputTokens
          ex.outputTokens += tm.outputTokens
        } else {
          m.set(tm.name, { ...tm })
        }
      }
      cur.topModels = [...m.values()]
      byDate.set(e.date, cur)
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}

// The "All devices" view: combined totals plus a per-device breakdown. Devices
// are summed for display only; nothing is merged on the server.
function CombinedView({ devices }: { devices: DeviceUsage[] }) {
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
  for (const d of devices) {
    const c = d.payload?.current
    if (!c) continue
    for (const [k, v] of Object.entries(c.providers)) providers.set(k, (providers.get(k) ?? 0) + v)
    for (const m of c.topModels) models.set(m.name, (models.get(m.name) ?? 0) + m.cost)
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

  return (
    <>
      <Card className="mb-3 overflow-hidden">
        <div className="flex items-end justify-between px-5 pt-4">
          <div>
            <div className="text-xs text-tertiary-foreground">{`${reachable} device${reachable === 1 ? '' : 's'} · ${fmtNum(total.calls)} calls`}</div>
            <div className="mt-1 font-display text-4xl tracking-tight tabular-nums text-primary">{usd(total.cost)}</div>
          </div>
        </div>
        <div className="mt-3 h-64 px-2 pb-2">
          <UsageChart daily={mergeDaily(devices)} />
        </div>
      </Card>

      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <MetricCard label="Total cost" value={usd(total.cost)} accent />
        <MetricCard label="Tokens" value={fmtTokens(total.tokens)} />
        <MetricCard label="Calls" value={fmtNum(total.calls)} />
        <MetricCard label="Sessions" value={fmtNum(total.sessions)} />
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
        <Panel title="By tool (all devices)">
          <BarList items={toolBars} total={total.cost} />
        </Panel>
        <Panel title="Top models (all devices)">
          <BarList items={modelBars} total={total.cost} />
        </Panel>
      </div>
    </>
  )
}

export function App() {
  const [period, setPeriod] = useState<Period>('month')
  const [provider, setProvider] = useState('all')
  const [view, setView] = useState<string>('all')
  const [searchOpen, setSearchOpen] = useState(false)

  const { data, isError, error, refetch } = useQuery({
    queryKey: ['devices', period, provider],
    queryFn: () => fetchDevices(period, provider),
    placeholderData: keepPreviousData,
  })

  const devices = data?.devices ?? []
  const local = devices.find((d) => d.local)
  const multi = devices.some((d) => !d.local)
  const viewing = view === 'all' ? undefined : devices.find((d) => d.name === view)
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

  const showCombined = multi && view === 'all'
  const viewTitle = showCombined ? 'All devices' : (primary ? primary.name + (primary.local ? ' · this Mac' : '') : 'Loading…')
  const label = local?.payload?.current.label ?? ''

  return (
    <div className="min-h-screen bg-outer-background p-2.5">
      <div className="flex h-[calc(100vh-20px)] flex-col gap-2.5">
        <header className="flex h-12 shrink-0 items-center gap-4 rounded-md border border-border bg-card px-5 shadow-[0_2px_8px_rgba(0,0,0,0.03)]">
          <div className="flex items-center gap-2">
            <span className="text-base leading-none text-primary">&#9650;</span>
            <span className="font-display text-lg tracking-wide text-foreground">CodeBurn</span>
            <span className="ml-1 text-[11px] font-light uppercase tracking-[0.14em] text-tertiary-foreground">usage</span>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <div className="flex rounded-md border border-border bg-interactive-secondary p-0.5">
              {PERIODS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => setPeriod(p.key)}
                  className={cn(
                    'rounded-[5px] px-3 py-1 text-xs font-medium transition-colors',
                    period === p.key ? 'bg-active-primary text-foreground shadow-sm' : 'text-tertiary-foreground hover:text-foreground',
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              className="rounded-md border border-border bg-card px-3 py-1.5 text-xs text-foreground outline-none"
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
          <aside className="flex w-60 shrink-0 flex-col gap-5 overflow-y-auto rounded-md border border-border bg-card p-5">
            <div className="flex flex-col gap-1">
              <p className="mb-1 px-2.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-heading">Devices</p>
              {multi && (
                <SideLink active={view === 'all'} onClick={() => setView('all')}>
                  All devices
                </SideLink>
              )}
              {devices.map((d) => (
                <SideLink
                  key={d.name}
                  active={view === d.name || (!multi && view === 'all' && d.local)}
                  onClick={() => setView(d.name)}
                >
                  {d.name}
                  {d.local ? ' · this Mac' : ''}
                </SideLink>
              ))}
              {devices.length === 0 && <p className="px-2.5 py-1 text-xs text-tertiary-foreground">Loading…</p>}
            </div>

            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              className="flex items-center justify-center gap-2 rounded-md border border-border px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-interactive-secondary"
            >
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <circle cx="7" cy="7" r="4.5" />
                <path d="M10.5 10.5L14 14" />
              </svg>
              Search local devices
            </button>

            <div className="mt-auto border-t border-border pt-4">
              <p className="text-[11px] leading-relaxed text-tertiary-foreground">
                Local only. Nothing leaves your machine; only totals are shared between your devices.
              </p>
            </div>
          </aside>

          <main className="min-w-0 flex-1 overflow-y-auto pr-0.5">
            <div className="mb-3 flex items-baseline justify-between">
              <h1 className="font-display text-xl tracking-tight text-foreground">{viewTitle}</h1>
              <span className="text-xs text-tertiary-foreground">{label}</span>
            </div>

            {showCombined ? (
              <CombinedView devices={devices} />
            ) : (
              <DeviceView payload={primary?.payload} isRemote={!!viewing && !viewing.local} />
            )}

            {isError && (
              <div className="mt-4 text-sm text-tertiary-foreground">Failed to load: {String((error as Error)?.message)}</div>
            )}
          </main>
        </div>
      </div>

      {searchOpen && <DeviceSearchModal onClose={() => setSearchOpen(false)} onPaired={() => void refetch()} />}
    </div>
  )
}

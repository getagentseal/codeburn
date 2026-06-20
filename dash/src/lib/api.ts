export type Period = 'today' | 'week' | '30days' | 'month' | 'all'

export type ModelDay = {
  name: string
  cost: number
  calls: number
  inputTokens: number
  outputTokens: number
}

export type DailyEntry = {
  date: string
  cost: number
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  topModels: ModelDay[]
}

export type Current = {
  label: string
  cost: number
  calls: number
  sessions: number
  oneShotRate: number | null
  inputTokens: number
  outputTokens: number
  cacheHitPercent: number
  codexCredits: number
  topActivities: Array<{ name: string; cost: number; turns: number; oneShotRate: number | null }>
  topModels: Array<{ name: string; cost: number; calls: number; savingsUSD: number }>
  providers: Record<string, number>
  topProjects: Array<{ name: string; cost: number; sessions: number; avgCostPerSession: number }>
  tools: Array<{ name: string; calls: number }>
  subagents: Array<{ name: string; calls: number; cost: number }>
  skills: Array<{ name: string; turns: number; cost: number }>
  mcpServers: Array<{ name: string; calls: number }>
  modelEfficiency: Array<{ name: string; costPerEdit: number; oneShotRate: number }>
  localModelSavings: { totalUSD: number }
  retryTax: { totalUSD: number; retries: number }
  routingWaste: { totalSavingsUSD: number }
}

export type Payload = {
  generated: string
  current: Current
  history: { daily: DailyEntry[] }
}

export async function fetchUsage(period: Period, provider: string): Promise<Payload> {
  const res = await fetch(`/api/usage?period=${encodeURIComponent(period)}&provider=${encodeURIComponent(provider)}`)
  if (!res.ok) throw new Error(`Request failed (${res.status})`)
  return res.json() as Promise<Payload>
}

export type DeviceUsage = {
  id: string
  name: string
  local: boolean
  payload?: Payload
  error?: string
}

// A device may run a different CodeBurn version and send a payload missing
// fields we treat as required. Fill safe defaults at the boundary so the UI
// can iterate them without crashing (the alternative is a white screen for an
// innocent local user because a peer sent an old shape).
function normalizePayload(p?: Payload): Payload | undefined {
  if (!p) return p
  const c = (p.current ?? {}) as Partial<Current>
  return {
    generated: p.generated,
    current: {
      label: c.label ?? '',
      cost: c.cost ?? 0,
      calls: c.calls ?? 0,
      sessions: c.sessions ?? 0,
      oneShotRate: c.oneShotRate ?? null,
      inputTokens: c.inputTokens ?? 0,
      outputTokens: c.outputTokens ?? 0,
      cacheHitPercent: c.cacheHitPercent ?? 0,
      codexCredits: c.codexCredits ?? 0,
      topActivities: c.topActivities ?? [],
      topModels: c.topModels ?? [],
      providers: c.providers ?? {},
      topProjects: c.topProjects ?? [],
      tools: c.tools ?? [],
      subagents: c.subagents ?? [],
      skills: c.skills ?? [],
      mcpServers: c.mcpServers ?? [],
      modelEfficiency: c.modelEfficiency ?? [],
      localModelSavings: c.localModelSavings ?? { totalUSD: 0 },
      retryTax: c.retryTax ?? { totalUSD: 0, retries: 0 },
      routingWaste: c.routingWaste ?? { totalSavingsUSD: 0 },
    },
    history: {
      daily: (p.history?.daily ?? []).map((d) => ({
        date: d.date,
        cost: d.cost ?? 0,
        calls: d.calls ?? 0,
        inputTokens: d.inputTokens ?? 0,
        outputTokens: d.outputTokens ?? 0,
        cacheReadTokens: d.cacheReadTokens ?? 0,
        cacheWriteTokens: d.cacheWriteTokens ?? 0,
        topModels: (d.topModels ?? []).map((m) => ({
          name: m.name,
          cost: m.cost ?? 0,
          calls: m.calls ?? 0,
          inputTokens: m.inputTokens ?? 0,
          outputTokens: m.outputTokens ?? 0,
        })),
      })),
    },
  }
}

export async function fetchDevices(period: Period, provider: string): Promise<{ devices: DeviceUsage[] }> {
  const res = await fetch(`/api/devices?period=${encodeURIComponent(period)}&provider=${encodeURIComponent(provider)}`)
  if (!res.ok) throw new Error(`Request failed (${res.status})`)
  const data = (await res.json()) as { devices: DeviceUsage[] }
  return { devices: (data.devices ?? []).map((d) => ({ ...d, payload: normalizePayload(d.payload) })) }
}

export const PERIODS: Array<{ key: Period; label: string }> = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: '7 days' },
  { key: '30days', label: '30 days' },
  { key: 'month', label: 'Month' },
  { key: 'all', label: 'All' },
]

export type DiscoveredDevice = {
  name: string
  host: string
  port: number
  fingerprint: string
  code: string
  paired: boolean
}

export async function scanDevices(): Promise<DiscoveredDevice[]> {
  const res = await fetch('/api/devices/scan')
  if (!res.ok) throw new Error(`Scan failed (${res.status})`)
  const json = (await res.json()) as { found: DiscoveredDevice[] }
  return json.found
}

export async function pairDevice(d: DiscoveredDevice): Promise<{ ok: boolean; name?: string; error?: string }> {
  const res = await fetch('/api/devices/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: d.name, host: d.host, port: d.port, fingerprint: d.fingerprint }),
  })
  return res.json() as Promise<{ ok: boolean; name?: string; error?: string }>
}

export type PendingPairing = { id: string; name: string; code: string }
export type ShareStatus = {
  sharing: boolean
  name: string
  port: number
  always: boolean
  peers: number
  pending: PendingPairing[]
}

const postJson = (path: string, body: unknown) =>
  fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

export async function shareStatus(): Promise<ShareStatus> {
  const res = await fetch('/api/share/status')
  if (!res.ok) throw new Error(`share status failed (${res.status})`)
  return res.json() as Promise<ShareStatus>
}
export async function startShare(always: boolean): Promise<ShareStatus> {
  return (await postJson('/api/share/start', { always })).json() as Promise<ShareStatus>
}
export async function stopShare(): Promise<ShareStatus> {
  return (await postJson('/api/share/stop', {})).json() as Promise<ShareStatus>
}
export async function approvePairing(id: string, approve: boolean): Promise<{ ok: boolean }> {
  return (await postJson('/api/share/approve', { id, approve })).json() as Promise<{ ok: boolean }>
}

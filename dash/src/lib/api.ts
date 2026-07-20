export type Period = 'today' | 'week' | '30days' | 'month' | 'all' | 'lifetime'

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

export type GranularSeries = { id: string; label: string }
export type GranularValue = { seriesId: string; cost: number; tokens: number }
export type GranularPoint = {
  timestamp: string
  cost: number
  tokens: number
  models: GranularValue[]
  sessions: GranularValue[]
}
export type GranularHistory = {
  bucketMinutes: number
  modelSeries: GranularSeries[]
  sessionSeries: GranularSeries[]
  points: GranularPoint[]
}

export type Current = {
  label: string
  cost: number
  calls: number
  sessions: number
  oneShotRate: number | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
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
  history: { daily: DailyEntry[]; timeline?: GranularHistory }
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

declare global {
  interface Window {
    __CODEBURN_BOOTSTRAP__?: { devices: DeviceUsage[] }
  }
}

// A device may run a different CodeBurn version and send a payload missing
// fields we treat as required. Fill safe defaults at the boundary so the UI
// can iterate them without crashing (the alternative is a white screen for an
// innocent local user because a peer sent an old shape).
function normalizePayload(p?: Payload): Payload | undefined {
  if (!p) return p
  const c = (p.current ?? {}) as Partial<Current>
  const rawTimeline = p.history?.timeline
  const timeline = rawTimeline ? {
    bucketMinutes: rawTimeline.bucketMinutes ?? 1440,
    modelSeries: rawTimeline.modelSeries ?? [],
    sessionSeries: rawTimeline.sessionSeries ?? [],
    points: (rawTimeline.points ?? []).map((point) => ({
      timestamp: point.timestamp,
      cost: point.cost ?? 0,
      tokens: point.tokens ?? 0,
      models: (point.models ?? []).map((value) => ({
        seriesId: value.seriesId,
        cost: value.cost ?? 0,
        tokens: value.tokens ?? 0,
      })),
      sessions: (point.sessions ?? []).map((value) => ({
        seriesId: value.seriesId,
        cost: value.cost ?? 0,
        tokens: value.tokens ?? 0,
      })),
    })),
  } : undefined
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
      cacheReadTokens: c.cacheReadTokens ?? 0,
      cacheWriteTokens: c.cacheWriteTokens ?? 0,
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
      ...(timeline ? { timeline } : {}),
    },
  }
}

export async function fetchDevices(period: Period, provider: string): Promise<{ devices: DeviceUsage[] }> {
  const res = await fetch(`/api/devices?period=${encodeURIComponent(period)}&provider=${encodeURIComponent(provider)}`)
  if (!res.ok) throw new Error(`Request failed (${res.status})`)
  const data = (await res.json()) as { devices: DeviceUsage[] }
  return { devices: (data.devices ?? []).map((d) => ({ ...d, payload: normalizePayload(d.payload) })) }
}

// Keys map 1:1 to the CLI's --period values (src/cli-date.ts). Period windows
// are computed server-side by the CLI; the dashboard only forwards the key, so
// these can never drift from the CLI's totals.
export const PERIODS: Array<{ key: Period; label: string }> = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: '7 days' },
  { key: '30days', label: '30 days' },
  { key: 'month', label: 'Month' },
  { key: 'all', label: '6 months' },
  { key: 'lifetime', label: 'Lifetime' },
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

export type ContextProvider = 'claude' | 'codex'

export type ContextSessionInfo = {
  provider: ContextProvider
  sessionId: string
  project: string
  title: string
  mtimeMs: number
  sizeBytes: number
}

export type BlockStat = { count: number; tokens: number }

export type ContextSnapshot = {
  messages: number
  tokens: number
  assistant: {
    count: number
    tokens: number
    text: BlockStat
    reasoning: BlockStat
    toolCall: BlockStat
    byTool: Array<{ tool: string; count: number; tokens: number }>
  }
  user: {
    count: number
    tokens: number
    text: BlockStat
    image: BlockStat
    compactSummary: BlockStat
    meta: BlockStat
  }
  toolResult: BlockStat
  system: BlockStat
}

export type ContextRow = { depth: number; label: string; count: number; tokens: number; bold?: boolean }

export type ContextTree = {
  session: { sessionId: string; project: string; mtimeMs: number; sizeBytes: number }
  model: string
  compactions: number
  reported: { context: number; window: number | null } | null
  effective: ContextSnapshot
  full: ContextSnapshot
  effectiveRows: ContextRow[]
  fullRows: ContextRow[]
}

export async function fetchContextSessions(provider: ContextProvider): Promise<ContextSessionInfo[]> {
  const res = await fetch(`/api/context/sessions?provider=${encodeURIComponent(provider)}`)
  if (!res.ok) throw new Error(`Request failed (${res.status})`)
  const json = (await res.json()) as { sessions: ContextSessionInfo[] }
  return json.sessions ?? []
}

export async function fetchContextTree(provider: ContextProvider, id: string): Promise<ContextTree> {
  const res = await fetch(`/api/context/tree?provider=${encodeURIComponent(provider)}&id=${encodeURIComponent(id)}`)
  if (!res.ok) throw new Error(`Request failed (${res.status})`)
  return res.json() as Promise<ContextTree>
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

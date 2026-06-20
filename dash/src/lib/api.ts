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
  name: string
  local: boolean
  payload?: Payload
  error?: string
}

export async function fetchDevices(period: Period, provider: string): Promise<{ devices: DeviceUsage[] }> {
  const res = await fetch(`/api/devices?period=${encodeURIComponent(period)}&provider=${encodeURIComponent(provider)}`)
  if (!res.ok) throw new Error(`Request failed (${res.status})`)
  return res.json() as Promise<{ devices: DeviceUsage[] }>
}

export const PERIODS: Array<{ key: Period; label: string }> = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: '7 days' },
  { key: '30days', label: '30 days' },
  { key: 'month', label: 'Month' },
  { key: 'all', label: 'All' },
]

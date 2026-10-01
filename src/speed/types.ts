export const SPEED_HARNESSES = ['codex', 'claude', 'zcode', 'dsh', 'hermes', 'antigravity'] as const
export type SpeedHarness = typeof SPEED_HARNESSES[number]

// A token timestamp is accepted only from a producer that observes individual
// tokens. SSE deltas are chunks, even when they happen to contain one word.
export type SpeedSample = {
  version: 1
  id: string
  harness: SpeedHarness
  model: string
  source: 'proxy' | 'native' | 'antigravity-cli' | 'zcode-db' | 'codex-checkpoint'
  resolution: 'token' | 'chunk' | 'request' | 'turn'
  startedAt: string
  durationMs: number
  firstEmissionMs?: number
  lastEmissionMs?: number
  outputTokens?: number
  inputTokens?: number
  reasoningTokens?: number
  status: 'complete' | 'incomplete' | 'interrupted' | 'error'
  events: Array<{ elapsedMs: number; tokens?: 1 }>
  timelineTruncated?: boolean
}

export function isSpeedHarness(value: string): value is SpeedHarness {
  return (SPEED_HARNESSES as readonly string[]).includes(value)
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const count = (v: unknown): v is number => finite(v) && Number.isSafeInteger(v)
const label = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\x00-\x1f\x7f]/.test(v)

// Rebuild an allowlisted record rather than persisting arbitrary producer JSON.
// In particular, text, token IDs, headers, paths and credentials never survive.
export function validateSpeedSample(value: unknown): SpeedSample {
  if (!value || typeof value !== 'object') throw new Error('Expected a speed sample')
  const v = value as Record<string, unknown>
  if (v.version !== 1 || !label(v.id) || !label(v.model) || typeof v.harness !== 'string' || !isSpeedHarness(v.harness)
    || !['proxy', 'native', 'antigravity-cli', 'zcode-db', 'codex-checkpoint'].includes(String(v.source))
    || !['token', 'chunk', 'request', 'turn'].includes(String(v.resolution))
    || !['complete', 'incomplete', 'interrupted', 'error'].includes(String(v.status))
    || typeof v.startedAt !== 'string' || !Number.isFinite(Date.parse(v.startedAt)) || !finite(v.durationMs)
    || !Array.isArray(v.events) || v.events.length > 100_000) throw new Error('Invalid speed sample')
  for (const key of ['outputTokens', 'inputTokens', 'reasoningTokens']) {
    if (v[key] !== undefined && !count(v[key])) throw new Error('Invalid token count')
  }
  for (const key of ['firstEmissionMs', 'lastEmissionMs']) {
    if (v[key] !== undefined && (!finite(v[key]) || v[key] > v.durationMs)) throw new Error('Invalid emission time')
  }
  if (v.timelineTruncated !== undefined && typeof v.timelineTruncated !== 'boolean') throw new Error('Invalid timeline flag')
  if (v.resolution === 'token' && v.source !== 'native') throw new Error('Token timing requires a native producer')
  if ((v.lastEmissionMs !== undefined && v.firstEmissionMs === undefined)
    || (finite(v.firstEmissionMs) && finite(v.lastEmissionMs) && v.firstEmissionMs > v.lastEmissionMs)) throw new Error('Invalid emission window')
  const durationMs = v.durationMs
  let previous = -1
  const events = v.events.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid emission event')
    const e = raw as Record<string, unknown>
    if (!finite(e.elapsedMs) || e.elapsedMs < previous || e.elapsedMs > durationMs
      || (e.tokens !== undefined && e.tokens !== 1) || (v.resolution === 'token' && e.tokens !== 1)) throw new Error('Invalid emission event')
    previous = e.elapsedMs
    return { elapsedMs: e.elapsedMs, ...(e.tokens === 1 ? { tokens: 1 as const } : {}) }
  })
  if (events.length && (events[0]!.elapsedMs !== v.firstEmissionMs
    || (!v.timelineTruncated && events.at(-1)!.elapsedMs !== v.lastEmissionMs))) throw new Error('Timeline does not match emission window')
  if (v.resolution === 'token' && v.status === 'complete' && !v.timelineTruncated && v.outputTokens !== events.length) {
    throw new Error('Complete token timelines must match outputTokens')
  }
  if (v.resolution === 'token' && v.timelineTruncated && count(v.outputTokens) && v.outputTokens < events.length) {
    throw new Error('Truncated token timelines cannot exceed outputTokens')
  }
  return {
    version: 1, id: v.id, harness: v.harness, model: v.model,
    source: v.source as SpeedSample['source'], resolution: v.resolution as SpeedSample['resolution'],
    startedAt: new Date(v.startedAt).toISOString(), durationMs: v.durationMs,
    status: v.status as SpeedSample['status'], events,
    ...(finite(v.firstEmissionMs) ? { firstEmissionMs: v.firstEmissionMs } : {}),
    ...(finite(v.lastEmissionMs) ? { lastEmissionMs: v.lastEmissionMs } : {}),
    ...(count(v.outputTokens) ? { outputTokens: v.outputTokens } : {}),
    ...(count(v.inputTokens) ? { inputTokens: v.inputTokens } : {}),
    ...(count(v.reasoningTokens) ? { reasoningTokens: v.reasoningTokens } : {}),
    ...(v.timelineTruncated === true ? { timelineTruncated: true } : {}),
  }
}

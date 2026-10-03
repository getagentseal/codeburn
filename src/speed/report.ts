import { SPEED_HARNESSES, speedHarnessName, type SpeedSample } from './types.js'

export type SpeedTrendBucket = 'hour' | 'day' | 'week'
export type SpeedTrendPoint = {
  generationTokensPerSecondP50: number | null
  generationRequests: number
  firstEmissionMsP50: number | null
  firstEmissionRequests: number
} | null
export type SpeedTypical = {
  days: number
  generationTokensPerSecondP50: number | null
  firstEmissionMsP50: number | null
  generationChangePct: number | null
  firstEmissionChangePct: number | null
  generationShift: boolean
  firstEmissionShift: boolean
}

// "Typical" is the median of daily medians before the report window, so one
// busy day cannot dominate it. Daily medians of real ZCode history move about
// +/-20% on ordinary days; a 25% change is flagged as a shift.
export const SPEED_SHIFT_THRESHOLD_PCT = 25
const TYPICAL_MIN_SAMPLES = 5
const TYPICAL_MIN_DAYS = 3
const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const i = (sorted.length - 1) * p
  const lower = Math.floor(i)
  return sorted[lower]! + (sorted[Math.ceil(i)]! - sorted[lower]!) * (i - lower)
}

const isComplete = (s: SpeedSample) => s.status === 'complete' && s.durationMs > 0 && s.outputTokens !== undefined && s.outputTokens > 0

// Request and chunk timestamps only bound the streaming window. A proxy that
// buffers delivers the whole reply in one burst: in real ZCode history half of
// one provider path's requests ended within 170 ms of their first chunk, which
// reads as thousands of tok/s. Under a second, such a window measures delivery,
// not generation. Native per-token timelines are exact and need no window.
const MIN_ESTIMATE_WINDOW_MS = 1000

/** Output tokens after the first arrival and the time they took, when observed at all. */
function generationWindow(s: SpeedSample): { tokens: number; ms: number } | null {
  // Inverse time per output token (TPOT): exclude the first token and its
  // initial wait. Never substitute the whole request/turn rate for this.
  if (!isComplete(s) || s.resolution === 'turn' || s.firstEmissionMs === undefined || s.outputTokens! <= 1) return null
  // Request logs can estimate completion-minus-TTFT without pretending to
  // contain a last-token timestamp. A lone streamed chunk has no observed
  // generation interval, so cannot use that fallback.
  const end = s.lastEmissionMs ?? (s.resolution === 'request' ? s.durationMs : undefined)
  if (end === undefined || end <= s.firstEmissionMs) return null
  return { tokens: s.outputTokens! - 1, ms: end - s.firstEmissionMs }
}

function generationRate(s: SpeedSample): number | null {
  const window = generationWindow(s)
  if (!window || (s.resolution !== 'token' && window.ms < MIN_ESTIMATE_WINDOW_MS)) return null
  return window.tokens / (window.ms / 1000)
}

/** Most windows too short to measure: the delivery path buffers, so no rate is honest. */
function bufferedDelivery(samples: SpeedSample[]): boolean {
  const windows = samples.filter(s => generationWindow(s) !== null)
  return windows.length >= TYPICAL_MIN_SAMPLES && windows.filter(s => generationRate(s) !== null).length < windows.length / 2
}

/** Local-time interval starts covering every sample, sized so the chart stays readable. */
export function speedTrendIntervals(samples: SpeedSample[]): { bucket: SpeedTrendBucket; starts: number[] } {
  if (!samples.length) return { bucket: 'day', starts: [] }
  let first = Infinity, last = -Infinity
  for (const s of samples) { const t = Date.parse(s.startedAt); first = Math.min(first, t); last = Math.max(last, t) }
  const bucket: SpeedTrendBucket = last - first <= 2 * DAY_MS ? 'hour' : last - first <= 120 * DAY_MS ? 'day' : 'week'
  const d = new Date(first)
  // Hours step in absolute time; days and weeks step on the local calendar,
  // so a DST change never moves a local midnight.
  let start = bucket === 'hour' ? new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime()
    : new Date(d.getFullYear(), d.getMonth(), d.getDate() - (bucket === 'week' ? (d.getDay() + 6) % 7 : 0)).getTime()
  const starts: number[] = []
  while (start <= last) {
    starts.push(start)
    const s = new Date(start)
    start = bucket === 'hour' ? start + HOUR_MS : new Date(s.getFullYear(), s.getMonth(), s.getDate() + (bucket === 'week' ? 7 : 1)).getTime()
  }
  return { bucket, starts }
}

function intervalIndex(starts: number[], time: number): number {
  let lo = 0, hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid]! <= time) lo = mid; else hi = mid - 1
  }
  return lo
}

type Metrics = { generation: number[]; first: number[] }

function metricsOf(samples: SpeedSample[], buffered = false): Metrics {
  const metrics: Metrics = { generation: [], first: [] }
  for (const s of samples) {
    if (!isComplete(s)) continue
    const rate = buffered ? null : generationRate(s)
    if (rate !== null) metrics.generation.push(rate)
    if (s.firstEmissionMs !== undefined) metrics.first.push(s.firstEmissionMs)
  }
  return metrics
}

const groupKey = (s: SpeedSample) => JSON.stringify([s.harness, s.model, s.source, s.resolution])

function typicalOf(before: SpeedSample[], current: Metrics, currentBuffered: boolean): SpeedTypical | null {
  const days = new Map<number, SpeedSample[]>()
  for (const s of before) {
    const d = new Date(s.startedAt)
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    const list = days.get(day) ?? []
    list.push(s); days.set(day, list)
  }
  // A row with no measurable rate now gets no typical rate either, whichever side buffered.
  const buffered = currentBuffered || bufferedDelivery(before)
  const daily = [...days.values()].map(day => metricsOf(day, buffered))
  const typical = (pick: (m: Metrics) => number[]) => {
    const medians = daily.flatMap(m => pick(m).length >= TYPICAL_MIN_SAMPLES ? [percentile(pick(m), 0.5)!] : [])
    return medians.length >= TYPICAL_MIN_DAYS ? { value: percentile(medians, 0.5)!, days: medians.length } : null
  }
  const generation = typical(m => m.generation), first = typical(m => m.first)
  if (!generation && !first) return null
  // A window with a handful of requests is too noisy to call a change.
  const change = (base: { value: number } | null, values: number[]) => base && base.value > 0 && values.length >= TYPICAL_MIN_SAMPLES
    ? (percentile(values, 0.5)! - base.value) / base.value * 100 : null
  const generationChangePct = change(generation, current.generation)
  const firstEmissionChangePct = change(first, current.first)
  return {
    days: Math.max(generation?.days ?? 0, first?.days ?? 0),
    generationTokensPerSecondP50: generation?.value ?? null, firstEmissionMsP50: first?.value ?? null,
    generationChangePct, firstEmissionChangePct,
    generationShift: generationChangePct !== null && Math.abs(generationChangePct) >= SPEED_SHIFT_THRESHOLD_PCT,
    firstEmissionShift: firstEmissionChangePct !== null && Math.abs(firstEmissionChangePct) >= SPEED_SHIFT_THRESHOLD_PCT,
  }
}

/** `before` holds samples preceding the report window; rows then carry their typical day. */
export function buildSpeedReport(samples: SpeedSample[], before?: SpeedSample[]) {
  const intervals = speedTrendIntervals(samples)
  const byGroup = (list: SpeedSample[]) => {
    const groups = new Map<string, SpeedSample[]>()
    for (const sample of list) {
      const group = groups.get(groupKey(sample)) ?? []
      group.push(sample); groups.set(groupKey(sample), group)
    }
    return groups
  }
  const groups = byGroup(samples), earlier = byGroup(before ?? [])
  const rows = [...groups.values()].map(group => {
    const first = group[0]!
    const latest = group.reduce((a, b) => Date.parse(a.startedAt) > Date.parse(b.startedAt) ? a : b)
    const complete = group.filter(isComplete)
    const buffered = bufferedDelivery(group)
    const metrics = metricsOf(group, buffered)
    const perInterval = intervals.starts.map(() => [] as SpeedSample[])
    for (const s of complete) perInterval[intervalIndex(intervals.starts, Date.parse(s.startedAt))]!.push(s)
    const trend: SpeedTrendPoint[] = perInterval.map(list => metricsOf(list, buffered)).map(m => m.generation.length || m.first.length ? {
      generationTokensPerSecondP50: percentile(m.generation, 0.5), generationRequests: m.generation.length,
      firstEmissionMsP50: percentile(m.first, 0.5), firstEmissionRequests: m.first.length,
    } : null)
    const tokenIntervals = complete.filter(s => s.resolution === 'token' && !s.timelineTruncated).flatMap(s => s.events.slice(1).map((e, i) => e.elapsedMs - s.events[i]!.elapsedMs))
    const totalTokens = complete.reduce((n, s) => n + s.outputTokens!, 0)
    const totalDuration = complete.reduce((n, s) => n + s.durationMs, 0)
    return {
      harness: first.harness, model: first.model, source: first.source, resolution: first.resolution,
      latestStartedAt: latest.startedAt,
      // Historical samples are reconstructed, so the persisted-event inspector
      // only advertises IDs that are actually available in the local store.
      latestSampleId: ['proxy', 'native', 'antigravity-cli'].includes(first.source) ? latest.id : null,
      estimated: first.source === 'codex-checkpoint', generationRateEstimated: first.resolution !== 'token',
      requests: group.length, timedRequests: complete.length, incompleteRequests: group.length - complete.length,
      generationRequests: metrics.generation.length,
      bufferedDelivery: buffered,
      outputTokens: totalTokens,
      effectiveTokensPerSecond: totalDuration > 0 ? totalTokens / (totalDuration / 1000) : null,
      generationTokensPerSecondP50: percentile(metrics.generation, 0.5),
      firstEmissionMsP50: percentile(metrics.first, 0.5),
      firstEmissionMsP95: percentile(metrics.first, 0.95),
      durationMsP50: percentile(complete.map(s => s.durationMs), 0.5), durationMsP95: percentile(complete.map(s => s.durationMs), 0.95),
      interTokenMsP50: percentile(tokenIntervals, 0.5), interTokenMsP95: percentile(tokenIntervals, 0.95),
      trend,
      typical: before ? typicalOf(earlier.get(groupKey(first)) ?? [], metrics, buffered) : null,
    }
  }).sort((a, b) => a.harness.localeCompare(b.harness) || a.model.localeCompare(b.model) || a.source.localeCompare(b.source))
  return {
    rows, unavailableHarnesses: SPEED_HARNESSES.filter(h => !rows.some(r => r.harness === h && r.generationRequests > 0)),
    trend: { bucket: intervals.bucket, starts: intervals.starts.map(t => new Date(t).toISOString()) },
  }
}

export function renderSpeedReport(report: ReturnType<typeof buildSpeedReport> & { typicalDays?: number | null }): string {
  const n = (value: number | null) => value === null ? '-' : value.toFixed(1)
  const lines = ['Harness\tModel\tSource / resolution\tGeneration / seen\tGeneration Tok/s p50\tFirst ms p50\tDuration ms p95']
  for (const row of report.rows) lines.push([speedHarnessName[row.harness], row.model, `${row.source}/${row.resolution}`, `${row.generationRequests}/${row.requests}`,
    (row.generationRateEstimated && row.generationTokensPerSecondP50 !== null ? '~' : '') + n(row.generationTokensPerSecondP50),
    n(row.firstEmissionMsP50), n(row.durationMsP95)].join('\t'))
  const change = (pct: number | null, shift: boolean) => pct === null ? '' : ` (now ${pct > 0 ? '+' : ''}${pct.toFixed(0)}%${shift ? ', SHIFT' : ''})`
  for (const row of report.rows) {
    const t = row.typical
    if (!t) continue
    lines.push(`Typical day, ${report.typicalDays ?? '?'} days before: ${speedHarnessName[row.harness]} / ${row.model} (${row.source})`
      + ` generation ${n(t.generationTokensPerSecondP50)} tok/s${change(t.generationChangePct, t.generationShift)},`
      + ` first ${n(t.firstEmissionMsP50)} ms${change(t.firstEmissionChangePct, t.firstEmissionShift)}`)
  }
  const buffered = report.rows.filter(row => row.bufferedDelivery)
  if (buffered.length) lines.push(`Buffered delivery, generation unavailable: ${buffered.map(row => `${speedHarnessName[row.harness]} / ${row.model}`).join(', ')}`)
  if (report.unavailableHarnesses.length) lines.push(`No generation timing: ${report.unavailableHarnesses.map(h => speedHarnessName[h]).join(', ')}`)
  lines.push('~ = estimate. First = first token (native/ZCode), SSE chunk (proxy), or CLI delta (antigravity-cli).')
  lines.push('Generation Tok/s excludes the initial wait: (output tokens - 1) / seconds after first arrival. Chunk timing and request-end timing are estimates that need at least 1 s after the first arrival; shorter bursts are delivery, not generation. Turn-only history cannot measure generation speed. Sources stay separate.')
  return lines.join('\n')
}

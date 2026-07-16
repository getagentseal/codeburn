import type { DateRange, ProjectSummary } from './types.js'

const FIFTEEN_MINUTES = 15
const ONE_HOUR = 60
const ONE_DAY = 24 * 60
const MINUTE_MS = 60 * 1000
const MAX_SERIES_PER_METRIC = 6

export type GranularSeries = {
  id: string
  label: string
}

export type GranularValue = {
  seriesId: string
  cost: number
  tokens: number
}

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

type Totals = { cost: number; tokens: number }
type RawBucket = {
  timestamp: string
  cost: number
  tokens: number
  models: Map<string, Totals>
  sessions: Map<string, Totals>
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}

export function granularBucketMinutes(range: DateRange): number {
  const durationMs = Math.max(0, range.end.getTime() - range.start.getTime())
  if (durationMs <= 48 * ONE_HOUR * MINUTE_MS) return FIFTEEN_MINUTES
  // Hourly beyond ~8 days means 200+ points of overlapping spikes; daily
  // buckets keep month-scale charts readable.
  if (durationMs <= 8 * ONE_DAY * MINUTE_MS) return ONE_HOUR
  return ONE_DAY
}

function bucketStart(date: Date, bucketMinutes: number): Date {
  if (bucketMinutes === ONE_DAY) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate())
  }

  // Floor against local wall-clock time so :00 means the user's hour even in
  // half-hour timezones. Applying that timestamp's own offset also keeps the
  // two repeated hours distinct across a daylight-saving fallback.
  const intervalMs = bucketMinutes * MINUTE_MS
  const offsetMs = date.getTimezoneOffset() * MINUTE_MS
  const localEpoch = date.getTime() - offsetMs
  return new Date(Math.floor(localEpoch / intervalMs) * intervalMs + offsetMs)
}

function nextBucket(date: Date, bucketMinutes: number): Date {
  if (bucketMinutes === ONE_DAY) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1)
  }
  return new Date(date.getTime() + bucketMinutes * MINUTE_MS)
}

function add(map: Map<string, Totals>, key: string, cost: number, tokens: number): void {
  const total = map.get(key) ?? { cost: 0, tokens: 0 }
  total.cost += cost
  total.tokens += tokens
  map.set(key, total)
}

function topSeriesKeys(totals: Map<string, Totals>): Set<string> {
  const selected = new Set<string>()
  const rows = [...totals.entries()]
  for (const [key] of [...rows].sort((a, b) => b[1].cost - a[1].cost).slice(0, MAX_SERIES_PER_METRIC)) {
    selected.add(key)
  }
  for (const [key] of [...rows].sort((a, b) => b[1].tokens - a[1].tokens).slice(0, MAX_SERIES_PER_METRIC)) {
    selected.add(key)
  }
  return selected
}

function shortSessionId(sessionId: string): string {
  const trimmed = sessionId.trim()
  return trimmed.length > 12 ? `${trimmed.slice(0, 6)}…${trimmed.slice(-4)}` : trimmed || 'unknown'
}

// Legend labels: the sanitized project dir ("-Users-name-Projects-app") is
// unreadable, so prefer the real projectPath's last two segments ("app/web").
// Fall back to the sanitized name when no usable path exists.
function shortProjectLabel(projectPath: string, fallback: string): string {
  const segments = projectPath.trim().replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean)
  if (segments.length === 0) return fallback
  return segments.slice(-2).join('/')
}

function projectSeries(
  rawBuckets: RawBucket[],
  kind: 'models' | 'sessions',
  totals: Map<string, Totals>,
  labels: Map<string, string>,
): { series: GranularSeries[]; values: GranularValue[][] } {
  const selected = topSeriesKeys(totals)
  const prefix = kind === 'models' ? 'model' : 'session'
  const publicIds = new Map<string, string>()
  const series: GranularSeries[] = []

  let index = 0
  for (const rawKey of selected) {
    const id = `${prefix}_${index++}`
    publicIds.set(rawKey, id)
    series.push({ id, label: labels.get(rawKey) ?? rawKey })
  }

  let hasOther = false
  const otherId = `${prefix}_other`
  const values = rawBuckets.map(bucket => {
    const rows: GranularValue[] = []
    let otherCost = 0
    let otherTokens = 0
    for (const [rawKey, value] of bucket[kind]) {
      const id = publicIds.get(rawKey)
      if (id) {
        rows.push({ seriesId: id, cost: value.cost, tokens: value.tokens })
      } else {
        otherCost += value.cost
        otherTokens += value.tokens
      }
    }
    if (otherCost > 0 || otherTokens > 0) {
      hasOther = true
      rows.push({ seriesId: otherId, cost: otherCost, tokens: otherTokens })
    }
    return rows
  })

  if (hasOther) series.push({ id: otherId, label: 'Other' })
  return { series, values }
}

/**
 * Build a selected-period timeline from real call timestamps. The result is
 * bounded to the top six cost series plus the top six token series for each
 * breakdown; everything else is retained in an aggregate Other series.
 */
export function buildGranularHistory(
  projects: ProjectSummary[],
  range: DateRange,
  now = new Date(),
): GranularHistory {
  const bucketMinutes = granularBucketMinutes(range)
  const effectiveEnd = range.end.getTime() < now.getTime() ? range.end : now
  if (range.start.getTime() > effectiveEnd.getTime()) {
    return { bucketMinutes, modelSeries: [], sessionSeries: [], points: [] }
  }

  const rawBuckets: RawBucket[] = []
  const byTimestamp = new Map<string, RawBucket>()
  for (
    let cursor = bucketStart(range.start, bucketMinutes);
    cursor.getTime() <= effectiveEnd.getTime();
    cursor = nextBucket(cursor, bucketMinutes)
  ) {
    const timestamp = cursor.toISOString()
    const bucket: RawBucket = { timestamp, cost: 0, tokens: 0, models: new Map(), sessions: new Map() }
    rawBuckets.push(bucket)
    byTimestamp.set(timestamp, bucket)
  }

  const modelTotals = new Map<string, Totals>()
  const sessionTotals = new Map<string, Totals>()
  const modelLabels = new Map<string, string>()
  const sessionLabels = new Map<string, string>()
  let callCount = 0

  for (const project of projects) {
    for (const session of project.sessions) {
      for (const turn of session.turns) {
        for (const call of turn.assistantCalls) {
          const timestamp = Date.parse(call.timestamp)
          if (!Number.isFinite(timestamp) || timestamp < range.start.getTime() || timestamp > effectiveEnd.getTime()) continue
          const bucket = byTimestamp.get(bucketStart(new Date(timestamp), bucketMinutes).toISOString())
          if (!bucket) continue

          const cost = nonNegative(call.costUSD)
          // Match the browser's existing Tokens view: fresh input + output.
          // Cache and reasoning remain available in their dedicated metrics.
          const tokens = nonNegative(call.usage.inputTokens) + nonNegative(call.usage.outputTokens)
          const modelKey = call.model || 'unknown'
          // Session ids are usually globally unique, but a few providers scope
          // them to a workspace. Include the project path so two workspaces do
          // not collapse into one line when they reuse the same local id.
          const sessionKey = `${call.provider}\0${project.projectPath}\0${session.sessionId}`
          const projectName = session.project || project.project || 'Unknown project'

          bucket.cost += cost
          bucket.tokens += tokens
          add(bucket.models, modelKey, cost, tokens)
          add(bucket.sessions, sessionKey, cost, tokens)
          add(modelTotals, modelKey, cost, tokens)
          add(sessionTotals, sessionKey, cost, tokens)
          modelLabels.set(modelKey, modelKey === '<synthetic>' ? 'Other model' : modelKey)
          sessionLabels.set(sessionKey, `${shortProjectLabel(project.projectPath, projectName)} · ${shortSessionId(session.sessionId)} (${call.provider})`)
          callCount++
        }
      }
    }
  }

  if (callCount === 0) {
    return { bucketMinutes, modelSeries: [], sessionSeries: [], points: [] }
  }

  const modelProjection = projectSeries(rawBuckets, 'models', modelTotals, modelLabels)
  const sessionProjection = projectSeries(rawBuckets, 'sessions', sessionTotals, sessionLabels)
  return {
    bucketMinutes,
    modelSeries: modelProjection.series,
    sessionSeries: sessionProjection.series,
    points: rawBuckets.map((bucket, i) => ({
      timestamp: bucket.timestamp,
      cost: bucket.cost,
      tokens: bucket.tokens,
      models: modelProjection.values[i] ?? [],
      sessions: sessionProjection.values[i] ?? [],
    })),
  }
}

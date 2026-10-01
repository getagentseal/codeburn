import { SPEED_HARNESSES, type SpeedSample } from './types.js'

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const i = (sorted.length - 1) * p
  const lower = Math.floor(i)
  return sorted[lower]! + (sorted[Math.ceil(i)]! - sorted[lower]!) * (i - lower)
}

export function buildSpeedReport(samples: SpeedSample[]) {
  const groups = new Map<string, SpeedSample[]>()
  for (const sample of samples) {
    const key = JSON.stringify([sample.harness, sample.model, sample.source, sample.resolution])
    const group = groups.get(key) ?? []
    group.push(sample); groups.set(key, group)
  }
  const rows = [...groups.values()].map(group => {
    const first = group[0]!
    const complete = group.filter(s => s.status === 'complete' && s.durationMs > 0 && s.outputTokens !== undefined && s.outputTokens > 0)
    const emitted = complete.filter(s => s.firstEmissionMs !== undefined && s.lastEmissionMs !== undefined && s.lastEmissionMs > s.firstEmissionMs)
    const streamRates = emitted.map(s => {
      // With native individual tokens, N-1 intervals cover N-1 tokens.
      // Chunk/request boundaries cannot locate each token: label as estimate.
      const numerator = s.resolution === 'token' ? s.outputTokens! - 1 : s.outputTokens!
      return numerator / ((s.lastEmissionMs! - s.firstEmissionMs!) / 1000)
    })
    const intervals = complete.filter(s => s.resolution === 'token' && !s.timelineTruncated).flatMap(s => s.events.slice(1).map((e, i) => e.elapsedMs - s.events[i]!.elapsedMs))
    const totalTokens = complete.reduce((n, s) => n + s.outputTokens!, 0)
    const totalDuration = complete.reduce((n, s) => n + s.durationMs, 0)
    return {
      harness: first.harness, model: first.model, source: first.source, resolution: first.resolution,
      estimated: first.source === 'codex-checkpoint', streamRateEstimated: first.resolution !== 'token',
      requests: group.length, timedRequests: complete.length, incompleteRequests: group.length - complete.length,
      outputTokens: totalTokens,
      effectiveTokensPerSecond: totalDuration > 0 ? totalTokens / (totalDuration / 1000) : null,
      streamTokensPerSecondP50: percentile(streamRates, 0.5),
      firstEmissionMsP50: percentile(complete.flatMap(s => s.firstEmissionMs === undefined ? [] : [s.firstEmissionMs]), 0.5),
      firstEmissionMsP95: percentile(complete.flatMap(s => s.firstEmissionMs === undefined ? [] : [s.firstEmissionMs]), 0.95),
      durationMsP50: percentile(complete.map(s => s.durationMs), 0.5), durationMsP95: percentile(complete.map(s => s.durationMs), 0.95),
      interTokenMsP50: percentile(intervals, 0.5), interTokenMsP95: percentile(intervals, 0.95),
    }
  }).sort((a, b) => a.harness.localeCompare(b.harness) || a.model.localeCompare(b.model) || a.source.localeCompare(b.source))
  return { rows, unavailableHarnesses: SPEED_HARNESSES.filter(h => !rows.some(r => r.harness === h && r.timedRequests > 0)) }
}

export function renderSpeedReport(report: ReturnType<typeof buildSpeedReport>): string {
  const n = (value: number | null) => value === null ? '-' : value.toFixed(1)
  const lines = ['Harness\tModel\tSource / resolution\tTimed / seen\tEffective Tok/s\tStream Tok/s p50\tFirst ms p50\tDuration ms p95']
  for (const row of report.rows) lines.push([row.harness, row.model, `${row.source}/${row.resolution}`, `${row.timedRequests}/${row.requests}`,
    (row.estimated ? '~' : '') + n(row.effectiveTokensPerSecond), (row.streamRateEstimated && row.streamTokensPerSecondP50 !== null ? '~' : '') + n(row.streamTokensPerSecondP50),
    n(row.firstEmissionMsP50), n(row.durationMsP95)].join('\t'))
  if (report.unavailableHarnesses.length) lines.push(`No timed samples: ${report.unavailableHarnesses.join(', ')}`)
  lines.push('~ = estimate. First = first token (native/ZCode) or first generated SSE chunk (proxy).')
  lines.push('Effective Tok/s includes request latency; Codex estimates exclude tools. Stream rates from chunks are estimates. Sources stay separate; do not sum overlapping historical/proxy samples.')
  return lines.join('\n')
}

import { SPEED_HARNESSES, speedHarnessName, type SpeedSample } from './types.js'

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
    const latest = group.reduce((a, b) => Date.parse(a.startedAt) > Date.parse(b.startedAt) ? a : b)
    const complete = group.filter(s => s.status === 'complete' && s.durationMs > 0 && s.outputTokens !== undefined && s.outputTokens > 0)
    const generationRates = complete.flatMap(s => {
      // Inverse time per output token (TPOT): exclude the first token and its
      // initial wait. Never substitute the whole request/turn rate for this.
      if (s.resolution === 'turn' || s.firstEmissionMs === undefined || s.outputTokens! <= 1) return []
      // Request logs can estimate completion-minus-TTFT without pretending to
      // contain a last-token timestamp. A lone streamed chunk has no observed
      // generation interval, so cannot use that fallback.
      const end = s.lastEmissionMs ?? (s.resolution === 'request' ? s.durationMs : undefined)
      if (end === undefined || end <= s.firstEmissionMs) return []
      return [(s.outputTokens! - 1) / ((end - s.firstEmissionMs) / 1000)]
    })
    const intervals = complete.filter(s => s.resolution === 'token' && !s.timelineTruncated).flatMap(s => s.events.slice(1).map((e, i) => e.elapsedMs - s.events[i]!.elapsedMs))
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
      generationRequests: generationRates.length,
      outputTokens: totalTokens,
      effectiveTokensPerSecond: totalDuration > 0 ? totalTokens / (totalDuration / 1000) : null,
      generationTokensPerSecondP50: percentile(generationRates, 0.5),
      firstEmissionMsP50: percentile(complete.flatMap(s => s.firstEmissionMs === undefined ? [] : [s.firstEmissionMs]), 0.5),
      firstEmissionMsP95: percentile(complete.flatMap(s => s.firstEmissionMs === undefined ? [] : [s.firstEmissionMs]), 0.95),
      durationMsP50: percentile(complete.map(s => s.durationMs), 0.5), durationMsP95: percentile(complete.map(s => s.durationMs), 0.95),
      interTokenMsP50: percentile(intervals, 0.5), interTokenMsP95: percentile(intervals, 0.95),
    }
  }).sort((a, b) => a.harness.localeCompare(b.harness) || a.model.localeCompare(b.model) || a.source.localeCompare(b.source))
  return { rows, unavailableHarnesses: SPEED_HARNESSES.filter(h => !rows.some(r => r.harness === h && r.generationRequests > 0)) }
}

export function renderSpeedReport(report: ReturnType<typeof buildSpeedReport>): string {
  const n = (value: number | null) => value === null ? '-' : value.toFixed(1)
  const lines = ['Harness\tModel\tSource / resolution\tGeneration / seen\tGeneration Tok/s p50\tFirst ms p50\tDuration ms p95']
  for (const row of report.rows) lines.push([speedHarnessName[row.harness], row.model, `${row.source}/${row.resolution}`, `${row.generationRequests}/${row.requests}`,
    (row.generationRateEstimated && row.generationTokensPerSecondP50 !== null ? '~' : '') + n(row.generationTokensPerSecondP50),
    n(row.firstEmissionMsP50), n(row.durationMsP95)].join('\t'))
  if (report.unavailableHarnesses.length) lines.push(`No generation timing: ${report.unavailableHarnesses.map(h => speedHarnessName[h]).join(', ')}`)
  lines.push('~ = estimate. First = first token (native/ZCode), SSE chunk (proxy), or CLI delta (antigravity-cli).')
  lines.push('Generation Tok/s excludes the initial wait: (output tokens - 1) / seconds after first arrival. Chunk timing and request-end timing are estimates; short/buffered replies can distort them. Turn-only history cannot measure generation speed. Sources stay separate.')
  return lines.join('\n')
}

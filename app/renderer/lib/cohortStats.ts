import type { CohortObservation, CohortStats, CohortVolumeStats } from './types'

/**
 * Renderer-side cohort math over the DECLARED population a cohort-json report
 * carries. The core implementation is src/compare-cohorts.ts; this mirror
 * exists so volume-band changes recompute instantly from the report's own
 * observation list instead of respawning the CLI, and both sides pin the same
 * percentile convention in tests: sort ascending, position (N-1)*p, linear
 * interpolation — [1, 2, 4, 8] → median 3, P90 6.8.
 */

/** Volume measure an observation carries. `contextProxy` is input + cache-read
 *  tokens — a proxy, not a measured context window; callers must label it so. */
export type VolumeMeasure = 'output' | 'input' | 'contextProxy'

export type VolumeBand = {
  measure: VolumeMeasure
  min: number | null
  max: number | null
}

export function linearPercentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null
  if (sorted.length === 1) return sorted[0] as number
  const pos = (sorted.length - 1) * p
  const lower = Math.floor(pos)
  const upper = Math.ceil(pos)
  if (lower === upper) return sorted[lower] as number
  const fraction = pos - lower
  return (sorted[lower] as number) * (1 - fraction) + (sorted[upper] as number) * fraction
}

export function medianOf(sorted: readonly number[]): number | null {
  return linearPercentile(sorted, 0.5)
}

export function volumeOf(observation: CohortObservation, measure: VolumeMeasure): number {
  if (measure === 'output') return observation.outputTokens
  if (measure === 'input') return observation.inputTokens
  return observation.contextProxyTokens
}

export type BandFilterResult = {
  /** Observations inside the band — the new declared population. */
  kept: CohortObservation[]
  /** Observations dropped because they fall OUTSIDE the band edges. */
  outsideBand: number
  /** Observations dropped because they carry NO token measure at all. A band
   *  must never read these as small context — they are excluded and counted. */
  missingMeasure: number
}

export function applyVolumeBand(observations: readonly CohortObservation[], band: VolumeBand | null): BandFilterResult {
  if (!band || (band.min == null && band.max == null)) {
    return { kept: [...observations], outsideBand: 0, missingMeasure: 0 }
  }
  const kept: CohortObservation[] = []
  let outsideBand = 0
  let missingMeasure = 0
  for (const observation of observations) {
    if (!observation.tokensReported) {
      missingMeasure++
      continue
    }
    const value = volumeOf(observation, band.measure)
    if (band.min != null && value < band.min) { outsideBand++; continue }
    if (band.max != null && value > band.max) { outsideBand++; continue }
    kept.push(observation)
  }
  return { kept, outsideBand, missingMeasure }
}

const HISTOGRAM_BUCKETS = 8

/** Same deterministic histogram as the core: linear edges 0 → P95 of known
 *  costs, top bucket open-ended so outliers stretch nothing. */
export function costHistogram(costs: readonly number[]): { edges: number[]; counts: number[] } {
  if (costs.length === 0) return { edges: [], counts: [] }
  const sorted = [...costs].sort((a, b) => a - b)
  const p95 = linearPercentile(sorted, 0.95) ?? 0
  if (p95 <= 0) return { edges: [], counts: [costs.length] }
  const edges: number[] = []
  for (let i = 1; i < HISTOGRAM_BUCKETS; i++) edges.push((p95 * i) / HISTOGRAM_BUCKETS)
  const counts = new Array(HISTOGRAM_BUCKETS).fill(0)
  for (const cost of costs) {
    let bucket = 0
    while (bucket < edges.length && cost >= (edges[bucket] as number)) bucket++
    counts[bucket]++
  }
  return { edges, counts }
}

export function computeBandCohortStats(model: string, observations: readonly CohortObservation[]): CohortStats {
  const knownCosts = observations.filter(o => o.costKnown).map(o => o.costUSD).sort((a, b) => a - b)
  const knownCostSum = knownCosts.reduce((sum, c) => sum + c, 0)
  const sessionKeys = new Set(observations.map(o => `${o.project}/${o.sessionId}`))
  const reported = observations.filter(o => o.tokensReported)
  const byMeasure = (pick: (o: CohortObservation) => number) => reported.map(pick).sort((a, b) => a - b)
  const outputTokens = byMeasure(o => o.outputTokens)
  const inputTokens = byMeasure(o => o.inputTokens)
  const contextProxy = byMeasure(o => o.contextProxyTokens)

  const retryCount = observations.reduce((sum, o) => sum + o.retries, 0)
  const oneShotCount = observations.filter(o => o.oneShot).length
  const n = observations.length

  const volume: CohortVolumeStats = {
    outputMedian: medianOf(outputTokens),
    outputP90: linearPercentile(outputTokens, 0.9),
    inputMedian: medianOf(inputTokens),
    inputP90: linearPercentile(inputTokens, 0.9),
    contextProxyMedian: medianOf(contextProxy),
    contextProxyP90: linearPercentile(contextProxy, 0.9),
    missingMeasureCount: observations.filter(o => !o.tokensReported).length,
  }

  return {
    model,
    label: model,
    observationCount: n,
    distinctSessionCount: sessionKeys.size,
    retryCount,
    retryRate: n > 0 ? retryCount / n : null,
    oneShotCount,
    oneShotRate: n > 0 ? (oneShotCount / n) * 100 : null,
    costKnownCount: knownCosts.length,
    unknownCostCount: n - knownCosts.length,
    costMedian: medianOf(knownCosts),
    costP90: linearPercentile(knownCosts, 0.9),
    costMean: knownCosts.length > 0 ? knownCostSum / knownCosts.length : null,
    costHistogram: costHistogram(knownCosts),
    volume,
  }
}

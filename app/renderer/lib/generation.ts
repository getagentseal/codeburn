import type { MenubarPayload, Period } from './types'

export type PeriodTotals = NonNullable<MenubarPayload['periodTotals']>
export type Generation = { at: number; totals: PeriodTotals }

/// Windows that nest, narrowest first. `month` is a calendar window rather than
/// a suffix of history, so it is not comparable with the rest.
const NESTED: Array<keyof PeriodTotals> = ['today', 'week', '30days', 'all', 'lifetime']

/** Each window contains the one before it, so its totals cannot be smaller.
 *  Returns the first pair that breaks, or null. Windows the generation does not
 *  carry are skipped rather than compared against a neighbour they do not
 *  bracket. */
export function periodTotalsBreach(totals: PeriodTotals): string | null {
  const present = NESTED.filter(period => totals[period])
  for (let index = 1; index < present.length; index++) {
    const narrow = totals[present[index - 1]]!
    const wide = totals[present[index]]!
    // A cent of float drift across two sums is not a breach.
    if (wide.cost + 0.005 < narrow.cost) return `${present[index]} cost ${wide.cost} < ${present[index - 1]} ${narrow.cost}`
    if (wide.calls < narrow.calls) return `${present[index]} calls ${wide.calls} < ${present[index - 1]} ${narrow.calls}`
  }
  return null
}

/**
 * The newest generation the app has been handed.
 *
 * Every period's headline is read from one aggregation pass, so switching
 * period cannot mix two snapshots taken minutes apart — which is how the same
 * six months read $20,770.90 on one refresh and $37,683.63 on the next, and how
 * Lifetime came back smaller than the six months it contains.
 */
let current: Generation | null = null

export function rememberGeneration(payload: MenubarPayload | null | undefined, at: number | null): Generation | null {
  const totals = payload?.periodTotals
  // A first paint the producer is still filling in is not a generation: its
  // windows are summed from the files indexed so far.
  const complete = payload?.stale !== true && payload?.hydration?.complete !== false
  if (totals && complete && at != null && (current === null || at > current.at)) {
    if (import.meta.env?.DEV) {
      const breach = periodTotalsBreach(totals)
      if (breach) console.error(`codeburn: period totals are not nested: ${breach}`)
    }
    current = { at, totals }
  }
  return current
}

/**
 * Cost and calls for `period` from the newest generation, or null to use the
 * payload's own headline.
 *
 * A generation only stands in for a payload it is NEWER than: the payload's own
 * `current` is what a direct request for its period returns, and nothing may
 * replace a correct number with an estimate of it. It also only answers for
 * windows it actually carries — the CLI omits the ones its live scan did not
 * reach, because the cache alone trails a direct request there.
 */
export function generationHeadline(period: Period, payloadAt: number | null): NonNullable<PeriodTotals[keyof PeriodTotals]> | null {
  if (!current || payloadAt == null || current.at <= payloadAt) return null
  return current.totals[period as keyof PeriodTotals] ?? null
}

export function generationAt(): number | null {
  return current?.at ?? null
}

/** Test-only: drop the held generation between renders. */
export function __resetGeneration(): void {
  current = null
}

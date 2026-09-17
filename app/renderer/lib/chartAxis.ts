/** Value-axis maths for the bar charts, kept out of the components so it is testable. */

const STEPS = [1, 2, 2.5, 5, 10]

/** Four or five round ticks from 0 up to at or above `max`, on a 1/2/2.5/5 ladder. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0]
  const rough = max / count
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const step = (STEPS.find(factor => factor * magnitude >= rough) ?? 10) * magnitude
  const top = Math.ceil(max / step) * step
  const ticks: number[] = []
  for (let value = 0; value <= top + step / 2; value += step) {
    ticks.push(Number(value.toPrecision(12)))
  }
  return ticks
}

/** Axis money, short enough for a gutter: `$0`, `$300`, `$1.2K`, `$0.50`. */
export function formatAxisMoney(value: number): string {
  const sign = value < 0 ? '-' : ''
  const size = Math.abs(value)
  if (size === 0) return '$0'
  if (size >= 1000) {
    const thousands = size / 1000
    return `${sign}$${thousands % 1 === 0 ? thousands : thousands.toFixed(1)}K`
  }
  if (size >= 1) return `${sign}$${Math.round(size)}`
  return `${sign}$${size.toFixed(2)}`
}

/** Plot height the axis labels are spaced against, in CSS px (`.chart` / `.sbars`). */
const PLOT_HEIGHT = 150

/** Drops any tick whose label would collide with the peak's own label: the exact figure wins. */
export function ticksClearOfPeak(ticks: number[], peak: number, axisMax: number, minGap = 15): number[] {
  if (!(axisMax > 0) || !(peak > 0)) return ticks
  return ticks.filter(tick => Math.abs(tick - peak) / axisMax * PLOT_HEIGHT >= minGap)
}

// Narrowest plot the app supports (900px window, sidebar and axis gutter
// removed). A column set that fits this fits every wider layout, so the chart
// never overflows its card.
const MIN_PLOT_PX = 520
// Bar width and gap in descending comfort. The first row whose columns fit
// MIN_PLOT_PX wins, so 30D keeps its airy bars and 6M tightens instead of
// spilling past the card.
const BAR_STEPS: ReadonlyArray<{ minWidth: number; gap: number }> = [
  { minWidth: 2, gap: 4 },
  { minWidth: 2, gap: 2 },
  { minWidth: 1, gap: 1 },
  { minWidth: 1, gap: 0 },
]

export function barLayout(count: number): { minWidth: number; gap: number } {
  return BAR_STEPS.find(step => count * step.minWidth + Math.max(0, count - 1) * step.gap <= MIN_PLOT_PX)
    ?? BAR_STEPS[BAR_STEPS.length - 1]
}

/** Days per column. Past one column per available pixel the chart aggregates to
 *  whole weeks (multiples of 7 keep the x-axis reading as weeks). */
export function barBucketDays(count: number): number {
  return count <= MIN_PLOT_PX ? 1 : 7 * Math.ceil(count / (7 * MIN_PLOT_PX))
}

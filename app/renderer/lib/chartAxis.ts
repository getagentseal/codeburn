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

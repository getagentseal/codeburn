/** Sparkline geometry, kept out of the component so the maths is testable. */

export type SparkPoint = [number, number]

/** Maps a series onto a `width` x `height` box, newest last, `inset` px clear of every edge. */
export function sparkPoints(values: number[], width: number, height: number, inset = 3): SparkPoint[] {
  if (!values.length) return []
  const max = Math.max(...values, 0)
  const span = Math.max(1, values.length - 1)
  const usableY = Math.max(0, height - inset * 2)
  const usableX = Math.max(0, width - inset * 2)
  return values.map((value, index) => [
    inset + (index / span) * usableX,
    height - inset - (max > 0 ? Math.max(0, value) / max : 0) * usableY,
  ])
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Monotone cubic (Fritsch-Carlson): smooth through every point without the
 * overshoot a Catmull-Rom spline would add to a cumulative, only-rising series.
 */
export function sparkPath(points: SparkPoint[]): string {
  if (!points.length) return ''
  if (points.length === 1) return `M${round(points[0][0])} ${round(points[0][1])}`
  const last = points.length - 1
  const dx: number[] = []
  const slope: number[] = []
  for (let index = 0; index < last; index++) {
    dx[index] = points[index + 1][0] - points[index][0]
    slope[index] = dx[index] === 0 ? 0 : (points[index + 1][1] - points[index][1]) / dx[index]
  }
  const tangent: number[] = new Array(points.length)
  tangent[0] = slope[0]
  tangent[last] = slope[last - 1]
  for (let index = 1; index < last; index++) {
    if (slope[index - 1] * slope[index] <= 0) {
      tangent[index] = 0
    } else {
      const left = 2 * dx[index] + dx[index - 1]
      const right = dx[index] + 2 * dx[index - 1]
      tangent[index] = (left + right) / (left / slope[index - 1] + right / slope[index])
    }
  }
  let d = `M${round(points[0][0])} ${round(points[0][1])}`
  for (let index = 0; index < last; index++) {
    const third = dx[index] / 3
    d += ` C${round(points[index][0] + third)} ${round(points[index][1] + tangent[index] * third)}`
      + ` ${round(points[index + 1][0] - third)} ${round(points[index + 1][1] - tangent[index + 1] * third)}`
      + ` ${round(points[index + 1][0])} ${round(points[index + 1][1])}`
  }
  return d
}

/** The same curve closed down to the baseline, for the gradient fill. */
export function sparkArea(points: SparkPoint[], height: number): string {
  if (points.length < 2) return ''
  const last = points[points.length - 1]
  return `${sparkPath(points)} L${last[0]} ${height} L${points[0][0]} ${height} Z`
}

/** Spend under its comparison is the good direction, so a negative delta is green. */
export function paceDirection(delta: number): 'good' | 'bad' {
  return delta < 0 ? 'good' : 'bad'
}

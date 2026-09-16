export function maxOf(values: readonly number[], initial: number): number {
  let max = initial
  for (const value of values) if (value > max) max = value
  return max
}

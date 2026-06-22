const MS_PER_DAY = 24 * 60 * 60 * 1000

export type BudgetTier = 'daily' | 'weekly' | 'monthly'
export type BudgetState = 'under' | 'warn' | 'over'

export type BudgetStatus = {
  spent: number
  budget: number
  pct: number
  projected: number
  state: BudgetState
}

export type BudgetStatusInput = {
  spent: number
  budget: number
  elapsedDays: number
  totalDays: number
}

function requireFinitePositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite number greater than 0`)
  }
}

function requireFiniteNonNegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite number greater than or equal to 0`)
  }
}

function toDayIndex(d: Date): number {
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / MS_PER_DAY)
}

export function diffCalendarDays(from: Date, to: Date): number {
  return toDayIndex(to) - toDayIndex(from)
}

export function daysInMonth(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
}

export function computeBudgetStatus(input: BudgetStatusInput): BudgetStatus {
  requireFiniteNonNegative('spent', input.spent)
  requireFinitePositive('budget', input.budget)
  requireFinitePositive('elapsedDays', input.elapsedDays)
  requireFinitePositive('totalDays', input.totalDays)

  const pct = (input.spent / input.budget) * 100
  const projected = input.spent * input.totalDays / input.elapsedDays
  const state: BudgetState = pct >= 100 ? 'over' : pct >= 80 ? 'warn' : 'under'

  return {
    spent: input.spent,
    budget: input.budget,
    pct,
    projected,
    state,
  }
}

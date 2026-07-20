// Provider-agnostic quota model (#725 Part 1). Pure and side-effect free:
// callers hand in window readings from whatever source they have — the live
// quota endpoints the menubar already fetches, or windows derived from local
// token history — and get back one merged, provenance-tagged view with pace.
//
// Provenance is load-bearing: a derived window is an estimate and every
// surface must be able to render it as one. Same discipline as
// costIsEstimated — a guess never renders as a measurement.

export type QuotaWindowKind = 'five_hour' | 'weekly' | 'monthly' | 'credits' | { custom: string }

export type QuotaSource = 'live' | 'derived'

export type QuotaPace = {
  /** Elapsed fraction of the window, 0..1. */
  expectedFraction: number
  /** usedFraction − expectedFraction; positive = ahead of pace (deficit). */
  deltaFraction: number
  /** Linear projection of usedFraction at the reset boundary. */
  projectedAtReset: number
  /**
   * When the window hits 100% at the current pace. Absent when the pace
   * doesn't overflow, or on short windows where a whole-window linear ETA
   * isn't defensible (one burst on a 5h window reads as "runs out in 40min",
   * then recovers). Deficit still reports there.
   */
  exhaustsAt?: Date
}

export type QuotaWindow = {
  kind: QuotaWindowKind
  /** Display label; provider-supplied when live. */
  label: string
  /** 0..1. Callers clamp out-of-range provider values before storing. */
  usedFraction: number
  resetsAt?: Date
  windowSeconds?: number
  source: QuotaSource
  /** Computed via computePace/withPace, never persisted. */
  pace?: QuotaPace
}

export type PlanQuota = {
  provider: string
  /** e.g. "pro", "max_20x" when known. */
  plan?: string
  windows: QuotaWindow[]
  asOf: Date
}

/** No pace until this fraction of the window has elapsed — projecting a week
 * off the first few minutes is noise, not signal. */
export const QUOTA_PACE_MIN_ELAPSED_FRACTION = 0.03

/** Windows at or under this length report deficit but no exhaustion ETA. */
export const QUOTA_PACE_ETA_MAX_WINDOW_SECONDS = 6 * 3600

/** Stable identity for merging: live and derived readings of the same window
 * kind describe the same underlying quota. */
export function quotaWindowKey(kind: QuotaWindowKind): string {
  return typeof kind === 'string' ? kind : `custom:${kind.custom}`
}

/**
 * Whole-window linear pace with the guards that keep it honest. Returns
 * undefined — never a fabricated value — when the window lacks the inputs,
 * hasn't elapsed enough to say anything, is exhausted (the bar already says
 * it), or its reset time is skewed (in the past, or further out than one
 * window length).
 */
export function computePace(window: QuotaWindow, now: Date = new Date()): QuotaPace | undefined {
  const { resetsAt, windowSeconds } = window
  if (!resetsAt || !windowSeconds || windowSeconds <= 0) return undefined
  const remainingSeconds = (resetsAt.getTime() - now.getTime()) / 1000
  if (remainingSeconds <= 0 || remainingSeconds > windowSeconds) return undefined
  const elapsedSeconds = windowSeconds - remainingSeconds
  const expectedFraction = elapsedSeconds / windowSeconds
  if (expectedFraction < QUOTA_PACE_MIN_ELAPSED_FRACTION) return undefined
  const used = Math.min(Math.max(window.usedFraction, 0), 1)
  if (used >= 1) return undefined

  const projectedAtReset = used / expectedFraction
  const pace: QuotaPace = {
    expectedFraction,
    deltaFraction: used - expectedFraction,
    projectedAtReset,
  }
  if (projectedAtReset > 1 && windowSeconds > QUOTA_PACE_ETA_MAX_WINDOW_SECONDS) {
    const usedPerSecond = used / elapsedSeconds
    if (usedPerSecond > 0) {
      pace.exhaustsAt = new Date(now.getTime() + ((1 - used) / usedPerSecond) * 1000)
    }
  }
  return pace
}

/**
 * Merge live and derived readings of a provider's windows. Live wins per
 * window kind; derived fills the gaps. Provenance stays on each surviving
 * window. Order: live windows first (in given order), then unmatched derived.
 */
export function mergeQuotaWindows(live: QuotaWindow[], derived: QuotaWindow[]): QuotaWindow[] {
  const liveKeys = new Set(live.map(w => quotaWindowKey(w.kind)))
  return [...live, ...derived.filter(w => !liveKeys.has(quotaWindowKey(w.kind)))]
}

/**
 * Assemble a plan's merged quota view with pace attached. A provider with no
 * readings from either source yields an empty windows list — absent data is
 * absent, never zeros.
 */
export function buildPlanQuota(input: {
  provider: string
  plan?: string
  live?: QuotaWindow[]
  derived?: QuotaWindow[]
  now?: Date
}): PlanQuota {
  const now = input.now ?? new Date()
  const windows = mergeQuotaWindows(input.live ?? [], input.derived ?? []).map(w => {
    const pace = computePace(w, now)
    return pace ? { ...w, pace } : { ...w, pace: undefined }
  })
  return { provider: input.provider, plan: input.plan, windows, asOf: now }
}

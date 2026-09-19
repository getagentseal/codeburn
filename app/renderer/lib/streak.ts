/**
 * The machine's usage streak, as last reported by the CLI.
 *
 * The CLI emits it only on the all-provider path, because counting active days
 * under a provider filter would mean scanning providers the view does not show.
 * Every screen therefore quotes the last value the app was given rather than
 * deriving its own from a period-narrowed history, which is what made the same
 * pill read a different number on every tab.
 */
let lastStreak: number | null = null

export function rememberStreak(reported: number | undefined): number | null {
  if (typeof reported === 'number' && Number.isFinite(reported)) lastStreak = reported
  return lastStreak
}

/** Test-only: drop the remembered value between renders. */
export function __resetStreak(): void {
  lastStreak = null
}

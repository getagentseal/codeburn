/**
 * The usage streak, as last reported by the CLI, remembered per exact report
 * scope so a global value cannot survive into a provider/project view.
 *
 * The CLI emits it only on the all-provider path, because counting active days
 * under a provider filter would mean scanning providers the view does not show.
 * An unscoped screen quotes the last global value rather than deriving its own
 * from a period-narrowed history; scoped screens use only their own value or
 * their own daily history.
 */
let lastStreak: number | null = null
let lastScope = 'all'

export function rememberStreak(reported: number | undefined, scope = 'all'): number | null {
  if (scope !== lastScope) {
    lastScope = scope
    lastStreak = null
  }
  if (typeof reported === 'number' && Number.isFinite(reported)) lastStreak = reported
  return lastStreak
}

/** Test-only: drop the remembered value between renders. */
export function __resetStreak(): void {
  lastStreak = null
  lastScope = 'all'
}

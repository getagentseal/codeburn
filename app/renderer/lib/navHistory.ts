import type { Section } from '../components/Sidebar'
import { filtersEqual, filtersToKey, type InvestigationFilters } from './investigation'
import type { DateRange, Period } from './types'

/**
 * One restorable app position: the section on screen, the app-level report
 * filters (period/provider/range), the investigation selection, the sessions
 * sort and pagination depth, and the open drawer's session. Everything in it
 * is serializable, so the same structure serves the in-app Back/Forward stack
 * and the best-effort restart restore.
 */
export type NavState = {
  section: Section
  period: Period
  provider: string
  range: DateRange | null
  filters: InvestigationFilters
  /** Composite key (provider\u0000project\u0000sessionId) of the open drawer. */
  sessionId: string | null
  sort: string
  visibleCount: number
}

export type NavHistory = {
  past: NavState[]
  future: NavState[]
}

export const EMPTY_NAV_HISTORY: NavHistory = { past: [], future: [] }

function sameState(a: NavState, b: NavState): boolean {
  return a.section === b.section
    && a.period === b.period
    && a.provider === b.provider
    && (a.range?.from ?? null) === (b.range?.from ?? null)
    && (a.range?.to ?? null) === (b.range?.to ?? null)
    && a.sessionId === b.sessionId
    && a.sort === b.sort
    && a.visibleCount === b.visibleCount
    && filtersEqual(a.filters, b.filters)
}

/**
 * Commit a new current state: the previous current lands on the past stack and
 * the future stack is dropped (a new navigation invalidates "forward", like
 * every platform convention). Consecutive identical commits coalesce so poll
 * cycles and re-renders never pollute the stack.
 */
export function pushState(history: NavHistory, current: NavState, next: NavState): NavHistory {
  if (sameState(current, next)) return history
  return {
    past: [...history.past.slice(-49), current],
    future: [],
  }
}

/** The state Back restores, or null when there is nothing to go back to. */
export function backState(history: NavHistory, current: NavState): { history: NavHistory; state: NavState } | null {
  const previous = history.past.at(-1)
  if (!previous) return null
  return {
    history: { past: history.past.slice(0, -1), future: [current, ...history.future].slice(0, 50) },
    state: previous,
  }
}

/** The state Forward restores, or null when there is nothing to go forward to. */
export function forwardState(history: NavHistory, current: NavState): { history: NavHistory; state: NavState } | null {
  const [next, ...rest] = history.future
  if (!next) return null
  return {
    history: { past: [...history.past, current], future: rest },
    state: next,
  }
}

/** Stable identity of a state for memoization/telemetry. */
export function navStateKey(state: NavState): string {
  return [state.section, state.period, state.provider, state.range?.from ?? '', state.range?.to ?? '', state.sessionId ?? '', state.sort, String(state.visibleCount), filtersToKey(state.filters)].join('|')
}

// ————— restart restore (best-effort, same rules as report snapshots) —————

const NAV_SNAPSHOT_KEY = 'codeburn.navState.v1'

export function persistNavState(state: NavState): void {
  try { globalThis.localStorage?.setItem(NAV_SNAPSHOT_KEY, JSON.stringify(state)) } catch { /* storage can be unavailable */ }
}

export function readPersistedNavState(): NavState | null {
  try {
    const raw = globalThis.localStorage?.getItem(NAV_SNAPSHOT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as NavState | null
    if (!parsed || typeof parsed !== 'object' || typeof parsed.section !== 'string') return null
    return { ...parsed, filters: { ...parsed.filters } }
  } catch { return null }
}

export function clearPersistedNavState(): void {
  try { globalThis.localStorage?.removeItem(NAV_SNAPSHOT_KEY) } catch { /* storage can be unavailable */ }
}

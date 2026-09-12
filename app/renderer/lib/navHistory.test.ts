import { describe, expect, it } from 'vitest'

import {
  backState,
  EMPTY_NAV_HISTORY,
  forwardState,
  navStateKey,
  pushState,
  type NavHistory,
  type NavState,
} from './navHistory'
import { categoryFilters, dayFilters, EMPTY_FILTERS } from './investigation'

function state(overrides: Partial<NavState> = {}): NavState {
  return {
    section: 'overview',
    period: '30days',
    provider: 'all',
    range: null,
    filters: EMPTY_FILTERS,
    sessionId: null,
    sort: 'cost',
    visibleCount: 120,
    ...overrides,
  }
}

describe('navHistory', () => {
  it('pushes committed changes onto the past stack and drops the future', () => {
    const current = state()
    let history: NavHistory = { past: [], future: [state({ section: 'plans' })] }
    history = pushState(history, current, state({ section: 'sessions' }))
    expect(history.past).toHaveLength(1)
    expect(history.past[0]!.section).toBe('overview')
    expect(history.future).toHaveLength(0)
  })

  it('coalesces identical consecutive states so polls never pollute the stack', () => {
    const current = state()
    const history = pushState({ past: [], future: [] }, current, state())
    expect(history.past).toHaveLength(0)
  })

  it('back restores the previous state and makes it forward-reachable', () => {
    const first = state()
    const second = state({ section: 'sessions', filters: dayFilters('2026-09-10') })
    let history = pushState({ past: [], future: [] }, first, second)

    const back = backState(history, second)
    expect(back).not.toBeNull()
    expect(back!.state).toEqual(first)
    history = back!.history

    const forward = forwardState(history, back!.state)
    expect(forward).not.toBeNull()
    expect(forward!.state).toEqual(second)
  })

  it('a drill-through round trip restores the selection and the open drawer', () => {
    const origin = state()
    const drilled = state({
      section: 'sessions',
      filters: categoryFilters('coding'),
      sessionId: 'claude\u0000/repo/app\u0000session-1',
      sort: 'recent',
      visibleCount: 240,
    })
    const history = pushState({ past: [], future: [] }, origin, drilled)

    const back = backState(history, drilled)!
    expect(back.state.section).toBe('overview')
    expect(back.state.sessionId).toBeNull()
    expect(back.state.filters).toEqual(EMPTY_FILTERS)

    const forward = forwardState(back.history, back.state)!
    expect(forward.state.filters).toEqual(categoryFilters('coding'))
    expect(forward.state.sessionId).toBe('claude\u0000/repo/app\u0000session-1')
    expect(forward.state.sort).toBe('recent')
    expect(forward.state.visibleCount).toBe(240)
  })

  it('forward is empty after a brand-new navigation', () => {
    const first = state()
    let history = pushState(EMPTY_NAV_HISTORY, first, state({ section: 'sessions' }))
    history = pushState(history, state({ section: 'sessions' }), state({ section: 'spend' }))
    const back = backState(history, state({ section: 'spend' }))
    expect(back!.state.section).toBe('sessions')
    expect(forwardState({ past: history.past, future: [] }, state({ section: 'spend' }))).toBeNull()
  })

  it('bounds the past stack', () => {
    let history: NavHistory = EMPTY_NAV_HISTORY
    let current = state()
    for (let index = 0; index < 60; index++) {
      const next = state({ section: index % 2 ? 'sessions' : 'overview', visibleCount: 120 + index })
      history = pushState(history, current, next)
      current = next
    }
    expect(history.past.length).toBeLessThanOrEqual(50)
  })

  it('navStateKey distinguishes every dimension', () => {
    const base = navStateKey(state())
    expect(base).not.toBe(navStateKey(state({ section: 'spend' })))
    expect(base).not.toBe(navStateKey(state({ filters: dayFilters('2026-09-10') })))
    expect(base).not.toBe(navStateKey(state({ sessionId: 'x' })))
    expect(base).not.toBe(navStateKey(state({ sort: 'recent' })))
    expect(base).not.toBe(navStateKey(state({ visibleCount: 240 })))
    expect(base).toBe(navStateKey(state()))
  })
})

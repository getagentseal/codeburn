// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

import { desktopProjectScopeKey } from './projectScope'
import { reportMemoKey } from './reportMemoKey'

describe('reportMemoKey', () => {
  it('rolls Today at the local calendar boundary', () => {
    const before = new Date(2026, 7, 28, 23, 59, 59)
    const after = new Date(2026, 7, 29, 0, 0, 1)
    expect(reportMemoKey('sessions', 'today', 'all', null, '', before))
      .not.toBe(reportMemoKey('sessions', 'today', 'all', null, '', after))
  })

  it('keeps historical horizons stable across a new day', () => {
    const before = new Date(2026, 7, 28, 23, 59, 59)
    const after = new Date(2026, 7, 29, 0, 0, 1)
    expect(reportMemoKey('sessions', 'week', 'all', null, '', before))
      .toBe(reportMemoKey('sessions', 'week', 'all', null, '', after))
  })

  it('rolls Month at the local month boundary', () => {
    const august = new Date(2026, 7, 31, 23, 59, 59)
    const september = new Date(2026, 8, 1, 0, 0, 1)
    expect(reportMemoKey('plans', 'month', 'all', null, '', august))
      .not.toBe(reportMemoKey('plans', 'month', 'all', null, '', september))
  })

  it('separates All projects from an exact project even when every report dimension matches', () => {
    const now = new Date(2026, 7, 28, 12, 0, 0)
    const allProjects = reportMemoKey('sessions', 'week', 'all', null, '', desktopProjectScopeKey(null), now)
    const alpha = reportMemoKey('sessions', 'week', 'all', null, '', desktopProjectScopeKey('path:/work/alpha'), now)
    const beta = reportMemoKey('sessions', 'week', 'all', null, '', desktopProjectScopeKey('path:/work/beta'), now)

    expect(allProjects).not.toBe(alpha)
    expect(alpha).not.toBe(beta)
    expect(desktopProjectScopeKey('all')).not.toBe(desktopProjectScopeKey(null))
  })

  it('keeps a filter revision in the report identity when a persistent filter changes', () => {
    const scope = desktopProjectScopeKey('path:/work/alpha')
    const before = `${reportMemoKey('overview', 'week', 'all', null, '', scope)}|filter:before`
    const after = `${reportMemoKey('overview', 'week', 'all', null, '', scope)}|filter:after`

    expect(before).not.toBe(after)
  })
})

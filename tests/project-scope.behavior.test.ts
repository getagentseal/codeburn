import { describe, expect, it } from 'vitest'

import { emptyCache } from '../src/daily-cache.js'
import { makeProjectFilter } from '../src/parser.js'
import { desktopProjectScopeKey } from '../src/project-scope.js'
import { buildProjectScopeCatalog, sliceDayToProject } from '../src/usage-aggregator.js'
import { dateRange, exactDay, legacyDay, project } from './fixtures/project-scope.js'

describe('Feature: exact Desktop project scope', () => {
  it('fixture project identities include their canonical path', () => {
    const alpha = project('Alpha', '/work/alpha', 1, 'claude')
    const alphaUi = project('Alpha', '/work/alpha-ui', 2, 'claude')
    const alphaSession = alpha.sessions[0]!
    const alphaUiSession = alphaUi.sessions[0]!

    expect(alphaSession.sessionId).not.toBe(alphaUiSession.sessionId)
    expect(alphaSession.turns[0]!.assistantCalls[0]!.deduplicationKey)
      .not.toBe(alphaUiSession.turns[0]!.assistantCalls[0]!.deduplicationKey)
  })

  it('Scenario: duplicate display names remain separately selectable by path', () => {
    const catalog = buildProjectScopeCatalog([
      project('Alpha', '/work/alpha', 1, 'claude'),
      project('Alpha', '/work/alpha-ui', 2, 'claude'),
    ], emptyCache(), { project: [], exclude: [] })

    expect(catalog.options.map(option => option.id)).toEqual(['path:/work/alpha', 'path:/work/alpha-ui'])
  })

  it('Scenario: persistent Settings visibility remains the outer boundary', () => {
    const catalog = buildProjectScopeCatalog([
      project('Visible', '/work/visible', 1, 'claude'),
      project('Hidden', '/work/hidden', 2, 'claude'),
    ], emptyCache(), { project: [], exclude: ['/work/hidden'] })

    expect(catalog.options.map(option => option.id)).toEqual(['path:/work/visible'])
  })

  it('Scenario: legacy history is available to All projects but not a selected project', () => {
    const legacy = legacyDay('2026-10-01', 'Alpha', 2)
    const scoped = sliceDayToProject(legacy, makeProjectFilter([], []), 'path:/work/alpha')

    expect(legacy.cost).toBe(2)
    expect(scoped.cost).toBe(0)
  })

  it('Scenario: a late response from another project cannot replace the active report', () => {
    expect(desktopProjectScopeKey('path:/work/alpha'))
      .not.toBe(desktopProjectScopeKey('path:/work/beta'))
    void dateRange('2026-10-01', '2026-10-02')
    void exactDay('2026-10-01', 'path:/work/alpha', 1, 'claude')
  })
})

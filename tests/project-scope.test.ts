import { describe, expect, it } from 'vitest'

import { filterProjectsByName, makeProjectFilter } from '../src/parser.js'
import { buildCohortComparison, buildCohortFacets } from '../src/compare-cohorts.js'
import {
  canonicalDesktopProjectId,
  catalogRevision,
  desktopProjectScopeKey,
  exactProjectBucketKey,
  legacyProjectBucketKey,
  matchesDesktopProjectId,
  validateDesktopProjectId,
} from '../src/project-scope.js'
import type { ProjectSummary } from '../src/types.js'

function project(projectName: string, projectPath: string): ProjectSummary {
  return {
    project: projectName,
    projectPath,
    sessions: [],
    totalCostUSD: 0,
    totalApiCalls: 0,
  }
}

describe('Desktop project identity', () => {
  it('canonicalizes trustworthy paths and falls back to the source label', () => {
    expect(canonicalDesktopProjectId({ project: 'alpha', projectPath: '/work/alpha/' }))
      .toBe('path:/work/alpha')
    expect(canonicalDesktopProjectId({ project: 'alpha', projectPath: 'C:\\Work\\Alpha\\' }))
      .toBe('path:c:/work/alpha')
    expect(canonicalDesktopProjectId({ project: 'alpha', projectPath: '-Users-me-alpha' }))
      .toBe('label:alpha')
  })

  it('uses exact identity boundaries rather than basename or substring matching', () => {
    expect(matchesDesktopProjectId({ project: 'alpha-ui', projectPath: '/work/alpha-ui' }, 'path:/work/alpha'))
      .toBe(false)
    expect(matchesDesktopProjectId({ project: 'alpha', projectPath: '/work/alpha/' }, 'path:/work/alpha'))
      .toBe(true)
    expect(matchesDesktopProjectId({ project: 'alpha-ui', projectPath: '/work/alpha-ui' }, 'label:alpha'))
      .toBe(false)
  })

  it('keeps same-name projects at different canonical paths separately selectable', () => {
    const projects = [
      project('project', '/a/project'),
      project('project', '/b/project'),
    ]
    const firstId = canonicalDesktopProjectId(projects[0]!)
    const secondId = canonicalDesktopProjectId(projects[1]!)

    expect(firstId).toBe('path:/a/project')
    expect(secondId).toBe('path:/b/project')
    expect(firstId).not.toBe(secondId)
    expect(filterProjectsByName(projects, undefined, undefined, firstId)).toEqual([projects[0]])
    expect(matchesDesktopProjectId(projects[1]!, firstId)).toBe(false)
  })

  it('collapses duplicate pathless labels to one identity and catalog row', () => {
    const projects = [project('shared', ''), project('shared', '')]

    expect(canonicalDesktopProjectId(projects[0]!)).toBe('label:shared')
    expect(canonicalDesktopProjectId(projects[1]!)).toBe('label:shared')
    expect(buildCohortFacets(projects).projects).toHaveLength(1)
  })

  it('intersects exact identity after the existing loose Settings filter', () => {
    const projects = [
      project('alpha', '/work/alpha'),
      project('alpha-ui', '/work/alpha-ui'),
    ]

    expect(filterProjectsByName(projects, ['alpha'], undefined, 'path:/work/alpha'))
      .toEqual([projects[0]])
    expect(filterProjectsByName(projects, ['alpha'], undefined, 'path:/work/alpha-ui'))
      .toEqual([projects[1]])
    expect(filterProjectsByName(projects, undefined, undefined, 'path:/work/alpha'))
      .toEqual([projects[0]])
    expect(projects.filter(makeProjectFilter(['alpha'], undefined, 'path:/work/alpha')))
      .toEqual([projects[0]])
  })

  it('applies Desktop exact identity to cohort report selection without changing labels', () => {
    const projects = [
      project('alpha', '/work/alpha'),
      project('alpha-ui', '/work/alpha-ui'),
    ]
    const report = buildCohortComparison(
      projects,
      'model-a',
      'model-b',
      'period',
      'claude',
      { desktopProjectId: 'path:/work/alpha' },
    )

    expect(report.selection.projects).toEqual(['alpha'])
    expect(report.modelA.observations).toEqual([])
  })

  it('does not collide the all scope with a valid project id', () => {
    expect(desktopProjectScopeKey('label:all')).not.toBe('all')
    expect(desktopProjectScopeKey(null)).toBe('all')
    expect(desktopProjectScopeKey(undefined)).toBe('all')
  })

  it('keeps exact and legacy daily-cache buckets in distinct namespaces', () => {
    expect(exactProjectBucketKey('path:/work/alpha')).toBe('exact:cGF0aDovd29yay9hbHBoYQ')
    expect(legacyProjectBucketKey('alpha')).toBe('legacy:YWxwaGE')
    expect(exactProjectBucketKey('path:/work/alpha')).not.toBe(legacyProjectBucketKey('path:/work/alpha'))
  })

  it('rejects unsafe Desktop ids before argv construction but accepts dash-leading data', () => {
    for (const value of ['', '   ', 'label:bad\u0000id', 42, null, undefined]) {
      expect(() => validateDesktopProjectId(value)).toThrow('Invalid Desktop project ID')
    }

    expect(validateDesktopProjectId('label:-leading-project')).toBe('label:-leading-project')
    expect(validateDesktopProjectId('-leading-project')).toBe('-leading-project')
  })

  it('creates deterministic catalog revisions from filters and generation', () => {
    expect(catalogRevision(['alpha', 'beta'], ['hidden'], 'generation-1'))
      .toBe(catalogRevision(['beta', 'alpha'], ['hidden'], 'generation-1'))
    expect(catalogRevision(['alpha'], ['hidden'], 'generation-1'))
      .not.toBe(catalogRevision(['alpha'], ['hidden'], 'generation-2'))
    expect(catalogRevision(['alpha'], ['hidden'], 'generation-1'))
      .not.toBe(catalogRevision(['alpha'], ['other'], 'generation-1'))
  })
})

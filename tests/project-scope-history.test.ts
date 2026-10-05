import { describe, expect, it } from 'vitest'

import {
  buildProjectScopeCatalog,
  sliceDayToProject,
} from '../src/usage-aggregator.js'
import { emptyCache, type DailyEntry, type ProjectDayStats } from '../src/daily-cache.js'
import { exactProjectBucketKey, legacyProjectBucketKey } from '../src/project-scope.js'
import { makeProjectFilter } from '../src/parser.js'
import { project } from './fixtures/project-scope.js'

function emptyFilter(): { project: readonly string[]; exclude: readonly string[] } {
  return { project: [], exclude: [] }
}

function projectStats(
  id: string,
  sourceLabel: string,
  path: string | null,
  cost: number,
  model: string,
): ProjectDayStats {
  const modelStats = {
    calls: 1,
    cost,
    savingsUSD: 0,
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 40,
  }
  return {
    canonicalId: id,
    sourceLabel,
    displayName: path?.split('/').filter(Boolean).pop() ?? sourceLabel,
    path,
    provenance: 'exact',
    cost,
    calls: 1,
    savingsUSD: 0,
    sessions: 1,
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 40,
    editTurns: 1,
    oneShotTurns: 1,
    models: { [model]: modelStats },
    categories: { coding: { turns: 1, cost, savingsUSD: 0, editTurns: 1, oneShotTurns: 1 } },
  }
}

function exactProjectDay(date: string, alphaCost = 12.5, betaCost = 7): DailyEntry {
  const alphaId = 'path:/work/alpha'
  const betaId = 'path:/work/beta'
  const alpha = projectStats(alphaId, 'alpha', '/work/alpha', alphaCost, 'alpha-model')
  const beta = projectStats(betaId, 'beta', '/work/beta', betaCost, 'beta-model')
  return {
    date,
    cost: alphaCost + betaCost,
    savingsUSD: 0,
    calls: 2,
    sessions: 2,
    inputTokens: 20,
    outputTokens: 40,
    cacheReadTokens: 60,
    cacheWriteTokens: 80,
    editTurns: 2,
    oneShotTurns: 2,
    models: { 'alpha-model': alpha.models['alpha-model']!, 'beta-model': beta.models['beta-model']! },
    categories: {
      coding: { turns: 2, cost: alphaCost + betaCost, savingsUSD: 0, editTurns: 2, oneShotTurns: 2 },
    },
    providers: {
      claude: {
        calls: 2,
        cost: alphaCost + betaCost,
        savingsUSD: 0,
        sessions: 2,
        inputTokens: 20,
        outputTokens: 40,
        cacheReadTokens: 60,
        cacheWriteTokens: 80,
        editTurns: 2,
        oneShotTurns: 2,
        models: { 'alpha-model': alpha.models['alpha-model']!, 'beta-model': beta.models['beta-model']! },
        categories: {
          coding: { turns: 2, cost: alphaCost + betaCost, savingsUSD: 0, editTurns: 2, oneShotTurns: 2 },
        },
        projects: {
          [exactProjectBucketKey(alphaId)]: alpha,
          [exactProjectBucketKey(betaId)]: beta,
        },
      },
    },
    projects: {
      [exactProjectBucketKey(alphaId)]: alpha,
      [exactProjectBucketKey(betaId)]: beta,
    },
    carried: true,
  }
}

function legacyProjectDay(date: string, cost: number): DailyEntry {
  return {
    ...exactProjectDay(date, cost, 0),
    cost,
    calls: 1,
    sessions: 1,
    projects: {
      [legacyProjectBucketKey('alpha')]: {
        canonicalId: null,
        sourceLabel: 'alpha',
        displayName: 'alpha',
        path: null,
        provenance: 'legacy',
        cost,
        calls: 1,
        savingsUSD: 0,
        sessions: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        editTurns: 0,
        oneShotTurns: 0,
        models: {},
        categories: {},
      },
    },
  }
}

describe('Feature: durable exact project projection', () => {
  it('Scenario: persistent include/exclude filtering runs before exact project selection', () => {
    const day = exactProjectDay('2026-09-20')
    // The Settings filter names a path prefix that permits both rows. The
    // Desktop ID must then narrow that permitted population to alpha only.
    const durable = sliceDayToProject(day, makeProjectFilter(['/work'], []), 'path:/work/alpha')

    expect(durable.cost).toBe(12.5)
    expect(Object.keys(durable.projects ?? {})).toHaveLength(1)
  })

  it('Scenario: an exact historical bucket survives after its transcript is gone', () => {
    const day = exactProjectDay('2026-09-20')
    const projected = sliceDayToProject(day, makeProjectFilter(), 'path:/work/alpha')
    const alpha = projected.projects![exactProjectBucketKey('path:/work/alpha')]!

    expect(alpha.provenance).toBe('exact')
    expect(alpha.cost).toBe(12.5)
    expect(alpha.models['alpha-model']?.cost).toBe(12.5)
    expect(alpha.categories.coding.cost).toBe(12.5)
    expect(projected.models).toEqual({ 'alpha-model': alpha.models['alpha-model'] })
  })

  it('Scenario: legacy history is omitted rather than subtracted from a global day', () => {
    const durable = sliceDayToProject(legacyProjectDay('2026-09-20', 12.5), makeProjectFilter(), 'path:/work/alpha')

    expect(durable.cost).toBe(0)
  })

  it('Scenario: an ambiguous pathless label is absent from the catalog', () => {
    const ambiguous = [project('shared', undefined, 1), project('shared', undefined, 2)]

    expect(buildProjectScopeCatalog(ambiguous, emptyCache(), emptyFilter()).options).toEqual([])
  })

  it('omits a pathless label that could belong to multiple exact paths', () => {
    const ambiguous = [
      project('shared', '/work/a/shared', 1),
      project('shared', '/work/b/shared', 2),
      project('shared', undefined, 3),
    ]

    expect(buildProjectScopeCatalog(ambiguous, emptyCache(), emptyFilter()).options.map(option => option.id)).toEqual([
      'path:/work/a/shared',
      'path:/work/b/shared',
    ])
  })

  it('includes retained exact options, omits legacy rows, and fingerprints the filter/options generation', () => {
    const cache = { ...emptyCache(), days: [exactProjectDay('2026-09-20'), legacyProjectDay('2026-09-21', 4)] }
    const all = buildProjectScopeCatalog([], cache, emptyFilter())
    const excluded = buildProjectScopeCatalog([], cache, { project: [], exclude: ['/work/alpha'] })

    expect(all.options.map(option => option.id)).toEqual(['path:/work/alpha', 'path:/work/beta'])
    expect(excluded.options.map(option => option.id)).toEqual(['path:/work/beta'])
    expect(excluded.revision).not.toBe(all.revision)
  })

  it('keeps catalog revisions invariant under live/cache/filter permutations', () => {
    const live = [project('alpha', '/work/alpha', 1), project('beta', '/work/beta', 2)]
    const filter = { project: ['/work/gamma', '/work/beta', '/work/alpha'], exclude: ['/nowhere', '/also-nowhere'] }
    const reversedFilter = { project: [...filter.project].reverse(), exclude: [...filter.exclude].reverse() }
    const cacheA = { ...emptyCache(), days: [exactProjectDay('2026-09-20'), exactProjectDay('2026-09-21')] }
    const cacheB = { ...emptyCache(), days: [...cacheA.days].reverse() }

    const first = buildProjectScopeCatalog(live, cacheA, filter)
    const permuted = buildProjectScopeCatalog([...live].reverse(), cacheB, reversedFilter)

    expect(permuted.options).toEqual(first.options)
    expect(permuted.revision).toBe(first.revision)
    expect(buildProjectScopeCatalog([...live, project('gamma', '/work/gamma', 0)], cacheA, filter).revision).not.toBe(first.revision)
    expect(buildProjectScopeCatalog(live, cacheA, { project: filter.project, exclude: ['/work/beta'] }).revision).not.toBe(first.revision)
  })

  it('Scenario: an exact project with no rows in the current slice remains selectable', () => {
    const catalog = buildProjectScopeCatalog([project('alpha', '/work/alpha', 0)], emptyCache(), emptyFilter())

    expect(catalog.options[0]!.id).toBe('path:/work/alpha')
  })

  it('retains a recorded non-absolute project path for catalog display', () => {
    const catalog = buildProjectScopeCatalog([project('project', 'Users/x/project', 1)], emptyCache(), emptyFilter())

    expect(catalog.options).toEqual([
      { id: 'label:project', name: 'project', path: 'Users/x/project' },
    ])
  })

  it('omits same-label stripped paths instead of collapsing them into one selection', () => {
    const catalog = buildProjectScopeCatalog([
      project('project', 'Users/a/project', 1),
      project('project', 'Users/b/project', 2),
    ], emptyCache(), emptyFilter())

    expect(catalog.options).toEqual([])
  })

  it('omits a stripped path when the same label also has a pathless project', () => {
    const catalog = buildProjectScopeCatalog([
      project('project', 'Users/a/project', 1),
      project('project', undefined, 2),
    ], emptyCache(), emptyFilter())

    expect(catalog.options).toEqual([])
  })
})

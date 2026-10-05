// @vitest-environment node
import { describe, expect, expectTypeOf, it, vi } from 'vitest'

import { createBridgeHandlers } from './main'
import {
  decodeProjectScopeCatalog,
  desktopProjectArg,
  validateCatalogSelection,
  validateDesktopReportQuery,
} from './projectScope'
import type {
  CodeburnBridge,
  DesktopCohortQuery,
  DesktopCompareQuery,
  DesktopModelsQuery,
  DesktopOverviewQuery,
  DesktopOptimizeSnapshotQuery,
  DesktopPeriodQuery,
  DesktopPeriodSessionsQuery,
  DesktopReportQuery,
  ProjectScopeCatalog,
} from '../renderer/lib/types'

describe('Feature: exact Desktop project scope', () => {
  it('keeps the bridge report methods on named query contracts', () => {
    expectTypeOf<Parameters<CodeburnBridge['getOverview']>[0]>().toEqualTypeOf<DesktopOverviewQuery>()
    expectTypeOf<Parameters<CodeburnBridge['getModels']>[0]>().toEqualTypeOf<DesktopModelsQuery>()
    expectTypeOf<Parameters<CodeburnBridge['getCompare']>[0]>().toEqualTypeOf<DesktopCompareQuery>()
    expectTypeOf<Parameters<CodeburnBridge['getCompareCohort']>[0]>().toEqualTypeOf<DesktopCohortQuery>()
    expectTypeOf<Parameters<CodeburnBridge['getPeriodCompare']>[0]>().toEqualTypeOf<DesktopPeriodQuery>()
    expectTypeOf<Parameters<CodeburnBridge['getPeriodCompareSessions']>[0]>().toEqualTypeOf<DesktopPeriodSessionsQuery>()
    expectTypeOf<Parameters<NonNullable<CodeburnBridge['getOptimizeSnapshot']>>[0]>().toEqualTypeOf<DesktopOptimizeSnapshotQuery>()
    expectTypeOf<DesktopReportQuery>().toMatchTypeOf<{ projectId?: string | null }>()
  })

  it('Scenario: duplicate display names remain separately selectable by path', async () => {
    const catalog: ProjectScopeCatalog = {
      revision: 'revision-1',
      options: [
        { id: 'path:/work/alpha', name: 'Alpha', path: '/work/alpha' },
        { id: 'path:/work/alpha-ui', name: 'Alpha', path: '/work/alpha-ui' },
      ],
    }
    const spawnCli = vi.fn(async () => catalog)
    const handlers = createBridgeHandlers({
      spawnCli,
      spawnCliAction: vi.fn(),
      resolveCodeburnPath: () => '/bin/codeburn',
      getQuota: vi.fn(async () => []),
    })

    expect(await handlers['codeburn:getProjectScopeCatalog']!()).toEqual({ ok: true, value: catalog })
    expect(spawnCli).toHaveBeenCalledWith([
      'report', '--format', 'json', '--period', 'lifetime', '--desktop-project-catalog',
    ], expect.anything())
    expect(await handlers['codeburn:validateProjectScope']!('path:/work/alpha-ui', 'revision-1'))
      .toEqual({ ok: true, value: catalog.options[1] })
  })

  it('rejects a stale catalog revision after reloading the catalog', async () => {
    const spawnCli = vi.fn(async () => ({
      revision: 'revision-2',
      options: [{ id: 'path:/work/alpha', name: 'Alpha', path: '/work/alpha' }],
    }))
    const handlers = createBridgeHandlers({
      spawnCli,
      spawnCliAction: vi.fn(),
      resolveCodeburnPath: () => '/bin/codeburn',
      getQuota: vi.fn(async () => []),
    })

    await expect(handlers['codeburn:validateProjectScope']!('path:/work/alpha', 'revision-1'))
      .resolves.toMatchObject({ ok: false, error: { kind: 'bad-args' } })
    expect(spawnCli).toHaveBeenCalledOnce()
  })

  it('keeps the catalog payload separate from report query typing', () => {
    const catalog: ProjectScopeCatalog = { revision: 'revision-1', options: [] }
    expect(catalog.options).toEqual([])
  })

  it('attaches dash-leading project IDs and rejects unsafe query scope combinations', () => {
    expect(desktopProjectArg('-Users-me-app')).toEqual(['--desktop-project-id=-Users-me-app'])
    expect(() => desktopProjectArg('')).toThrowError(/invalid Desktop project id/)
    expect(() => validateDesktopReportQuery({
      period: 'today', provider: 'all', deviceScope: 'combined', projectId: 'path:/work/app',
    })).toThrowError(/Combined scope/)
  })

  it('decodes and validates exact catalog selections by revision', () => {
    const catalog = decodeProjectScopeCatalog({
      revision: 'revision-1',
      options: [{ id: 'path:/work/alpha', name: 'Alpha', path: '/work/alpha' }],
    })
    expect(validateCatalogSelection(catalog, 'path:/work/alpha', 'revision-1')).toEqual(catalog.options[0])
    expect(() => validateCatalogSelection(catalog, 'path:/work/beta', 'revision-1')).toThrowError(/invalid Desktop project scope selection/)
    expect(() => validateCatalogSelection(catalog, 'path:/work/alpha', 'revision-0')).toThrowError(/catalog is stale/)
    expect(() => decodeProjectScopeCatalog({ revision: 'revision-1', options: [{ id: 'x', name: 'X', path: null }, { id: 'x', name: 'X', path: null }] }))
      .toThrowError(/invalid Desktop project scope catalog/)
  })
})

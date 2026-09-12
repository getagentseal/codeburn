import { PassThrough } from 'node:stream'

import React from 'react'
import { render } from 'ink'
import stripAnsi from 'strip-ansi'
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  assembleDashboardFirstPaint,
  buildDashboardHistoryIndex,
  DASHBOARD_COLD_INDEX_PHASES,
  dashboardIndexSupportsPeriod,
  InteractiveDashboard,
  selectDashboardHistoryIndex,
  shouldAutoFallbackToWeek,
} from '../src/dashboard.js'
import { getDateRange, type Period } from '../src/cli-date.js'
import { clearSessionCache, filesParsedFromSourceCount, isCompleteSessionSnapshotAvailable, parseAllSessions, sessionMemoPublicationCount } from '../src/parser.js'
import { clearLoadCacheMemo, fingerprintFileCount, isColdCacheOnDisk } from '../src/session-cache.js'
import { buildDurablePeriod } from '../src/usage-aggregator.js'
import type { ProjectSummary } from '../src/types.js'
import { setHome } from './setup/home.js'

const DAY_MS = 24 * 60 * 60 * 1000

let tmpDir: string
const originalHome = process.env['HOME']

beforeEach(async () => {
  clearSessionCache()
  clearLoadCacheMemo()
  tmpDir = await mkdtemp(join(tmpdir(), 'dashboard-progressive-'))
  setHome(tmpDir)
  process.env['CLAUDE_CONFIG_DIR'] = tmpDir
  process.env['CODEBURN_CACHE_DIR'] = join(tmpDir, 'cache')
  process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] = join(tmpDir, 'desktop-sessions')
})

afterEach(async () => {
  clearSessionCache()
  clearLoadCacheMemo()
  delete process.env['CLAUDE_CONFIG_DIR']
  delete process.env['CODEBURN_CACHE_DIR']
  delete process.env['CODEBURN_DESKTOP_SESSIONS_DIR']
  if (originalHome == null) setHome(undefined)
  else setHome(originalHome)
  await rm(tmpDir, { recursive: true, force: true })
})

async function writeSession(name: string, ageDays: number, outputTokens = 50): Promise<void> {
  const dir = join(tmpDir, 'projects', 'proj')
  await mkdir(dir, { recursive: true })
  const at = new Date(Date.now() - ageDays * DAY_MS)
  const path = join(dir, `${name}.jsonl`)
  await writeFile(path, `${JSON.stringify({
    type: 'assistant',
    sessionId: name,
    timestamp: at.toISOString(),
    cwd: '/tmp/proj',
    message: {
      id: `msg-${name}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [],
      usage: { input_tokens: 100, output_tokens: outputTokens },
    },
  })}\n`)
  await utimes(path, at, at)
}

async function appendSessionCall(name: string, outputTokens: number): Promise<void> {
  const timestamp = new Date().toISOString()
  await appendFile(join(tmpDir, 'projects', 'proj', `${name}.jsonl`), `${JSON.stringify({
    type: 'assistant',
    sessionId: name,
    timestamp,
    cwd: '/tmp/proj',
    message: {
      id: `msg-${name}-appended`,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [],
      usage: { input_tokens: 100, output_tokens: outputTokens },
    },
  })}\n`)
}

async function renderAutoPeriodDashboard(initialProjects: ProjectSummary[], initialDurable: Awaited<ReturnType<typeof assembleDashboardFirstPaint>>['result']['initialDurable']) {
  const stdin = new PassThrough() as PassThrough & NodeJS.ReadStream
  const stdout = new PassThrough() as PassThrough & NodeJS.WriteStream
  stdin.isTTY = true
  stdin.setRawMode = () => stdin
  stdin.ref = () => stdin
  stdin.unref = () => stdin
  stdout.isTTY = true
  stdout.columns = 120
  stdout.rows = 50
  const frames: string[] = []
  stdout.on('data', chunk => frames.push(stripAnsi(String(chunk))))
  const app = render(React.createElement(InteractiveDashboard, {
    initialProjects,
    initialPeriod: 'today',
    initialProvider: 'all',
    initialDurable,
    refreshSeconds: 0,
    windowColumns: 120,
    initialHistoryIndexing: true,
    initialCacheWasCold: true,
    autoFallbackFromEmptyToday: true,
  }), { stdin, stdout, debug: true, interactive: true, patchConsole: false })
  onTestFinished(() => app.unmount())
  return { app, frames }
}

async function waitForFrame(app: ReturnType<typeof render>, frames: string[], predicate: (frame: string) => boolean): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt++) {
    await app.waitUntilRenderFlush()
    const frame = frames.filter(value => value.trim()).at(-1) ?? ''
    if (predicate(frame)) return frame
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return frames.filter(value => value.trim()).at(-1) ?? ''
}

describe('interactive dashboard progressive startup', () => {
  it('selects and loads 7 Days in the rendered TUI when Today has exactly zero usage', async () => {
    await writeSession('older', 3)
    const paint = await assembleDashboardFirstPaint(
      'today', 'all', undefined, undefined, null, null, false,
    )
    expect(paint.result.filteredProjects).toEqual([])

    const { app, frames } = await renderAutoPeriodDashboard(
      paint.result.filteredProjects,
      paint.result.initialDurable,
    )
    await app.waitUntilRenderFlush()
    expect(frames.filter(value => value.trim()).at(-1)).toContain('[ Today ]')
    const frame = await waitForFrame(
      app,
      frames,
      value => value.includes('[ 7 Days ]') && !value.includes('indexing'),
    )

    expect(frame).toContain('[ 7 Days ]')
    expect(frame).toContain('proj')
  })

  it('preserves Today in the rendered TUI when Today has any usage', async () => {
    await writeSession('today', 0)
    await writeSession('older', 3)
    const paint = await assembleDashboardFirstPaint(
      'today', 'all', undefined, undefined, null, null, false,
    )
    expect(paint.result.filteredProjects).toHaveLength(1)

    const { app, frames } = await renderAutoPeriodDashboard(
      paint.result.filteredProjects,
      paint.result.initialDurable,
    )
    await app.waitUntilRenderFlush()
    expect(frames.filter(value => value.trim()).at(-1)).toContain('[ Today ]')
    const frame = await waitForFrame(
      app,
      frames,
      value => value.includes('[ Today ]') && !value.includes('indexing'),
    )

    expect(frame).toContain('[ Today ]')
    expect(frame).not.toContain('[ 7 Days ]')
  })

  it('falls back from an all-zero Today on cold and warm indexes, but keeps real usage on Today', () => {
    const cache = { version: 29, savingsConfigHash: '', lastComputedDate: null, days: [], complete: true } as const
    const coldWeek = { provider: 'all', normalizedProjects: [], cache, planUsages: [], readyThrough: 'week' as const }
    const warmLifetime = { ...coldWeek, readyThrough: 'lifetime' as const }
    const zeroSessionProject = {
      project: 'zero', projectPath: '/tmp/zero', sessions: [{
        sessionId: 'zero', project: 'zero', firstTimestamp: '', lastTimestamp: '', totalCostUSD: 0,
        totalSavingsUSD: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0, apiCalls: 0, turns: [], modelBreakdown: {}, toolBreakdown: {},
        mcpBreakdown: {}, bashBreakdown: {}, categoryBreakdown: {}, skillBreakdown: {}, subagentBreakdown: {},
      }], totalCostUSD: 0, totalSavingsUSD: 0, totalApiCalls: 0,
    } as ProjectSummary
    const realUsage = { ...zeroSessionProject, totalApiCalls: 1 }

    expect(shouldAutoFallbackToWeek(true, false, 'today', coldWeek, [])).toBe(true)
    expect(shouldAutoFallbackToWeek(true, false, 'today', warmLifetime, [zeroSessionProject])).toBe(true)
    expect(shouldAutoFallbackToWeek(true, false, 'today', coldWeek, [realUsage])).toBe(false)
    expect(shouldAutoFallbackToWeek(true, false, 'today', warmLifetime, [realUsage])).toBe(false)
  })

  it('does not treat an empty cache as a usable complete snapshot', async () => {
    expect(await isCompleteSessionSnapshotAvailable(getDateRange('today').range, 'all')).toBe(false)
    await parseAllSessions(getDateRange('today').range, 'all')
    clearSessionCache()
    clearLoadCacheMemo()
    expect(await isCompleteSessionSnapshotAvailable(getDateRange('today').range, 'all')).toBe(false)
    await writeSession('arrived-after-empty-cache', 0)
    const paint = await assembleDashboardFirstPaint(
      'today', 'all', undefined, undefined, null, null, false,
    )
    expect(paint.result.filteredProjects.flatMap(project => project.sessions).map(session => session.sessionId))
      .toEqual(['arrived-after-empty-cache'])
    clearSessionCache()
    clearLoadCacheMemo()
    expect(await isCompleteSessionSnapshotAvailable(getDateRange('today').range, 'codex')).toBe(false)
  })

  it('discovers current source files when the normalized cache is cold', async () => {
    await writeSession('today', 0)

    const paint = await assembleDashboardFirstPaint(
      'today', 'all', undefined, undefined, null, null, false,
    )

    expect(paint.result.filteredProjects.flatMap(project => project.sessions).map(session => session.sessionId))
      .toEqual(['today'])
    expect(filesParsedFromSourceCount()).toBeGreaterThan(0)
  })

  it('paints Today first even when the normalized session cache is already complete', async () => {
    await writeSession('today', 0)
    await writeSession('old', 90)
    const configDir = join(tmpDir, '.config', 'codeburn')
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, 'config.json'), JSON.stringify({
      plans: { claude: { id: 'claude-max', monthlyUsd: 200, resetDay: 1 } },
    }))

    await parseAllSessions(getDateRange('lifetime').range, 'all')
    await buildDurablePeriod(getDateRange('lifetime'), { provider: 'all' })
    expect(await isColdCacheOnDisk()).toBe(false)
    clearSessionCache()
    clearLoadCacheMemo()

    const parsedBefore = filesParsedFromSourceCount()
    const fingerprintsBefore = fingerprintFileCount()
    const paint = await assembleDashboardFirstPaint(
      'today', 'all', undefined, undefined, null, null, false,
    )

    expect(paint.result.period).toBe('today')
    expect(paint.result.filteredProjects.flatMap(project => project.sessions).map(session => session.sessionId)).toEqual(['today'])
    expect(paint.result.planUsages).toEqual([])
    expect(paint.deferredFiles).toBe(0)
    expect(filesParsedFromSourceCount() - parsedBefore).toBe(0)
    expect(fingerprintFileCount() - fingerprintsBefore).toBe(0)
  })

  it('projects every period from one normalized lifetime index without returning to source files', async () => {
    const periods: Period[] = ['today', 'week', '30days', 'month', 'all', 'lifetime']
    await Promise.all([
      writeSession('today', 0),
      writeSession('week', 5),
      writeSession('month', 20),
      writeSession('older', 45),
      writeSession('six-months', 120),
      writeSession('lifetime', 500),
    ])

    const baseline = new Map<Period, Awaited<ReturnType<typeof buildDurablePeriod>>>()
    for (const period of periods) {
      baseline.set(period, await buildDurablePeriod(getDateRange(period), { provider: 'all' }))
    }

    const index = await buildDashboardHistoryIndex('all', undefined, undefined)
    const parsedAfterIndex = filesParsedFromSourceCount()
    await rm(join(tmpDir, 'projects'), { recursive: true, force: true })

    for (const period of periods) {
      const selected = selectDashboardHistoryIndex(index, period)
      const expected = baseline.get(period)!
      expect(selected.durable).toEqual({
        cost: expected.data.cost,
        savingsUSD: expected.data.savingsUSD,
        calls: expected.data.calls,
        sessions: expected.data.sessions,
        sessionCountBasis: expected.data.sessionCountBasis,
        inputTokens: expected.data.inputTokens,
        outputTokens: expected.data.outputTokens,
        cacheReadTokens: expected.data.cacheReadTokens,
        cacheWriteTokens: expected.data.cacheWriteTokens,
        carriedCostUSD: expected.carriedCostUSD,
      })
      expect(selected.projects.flatMap(project => project.sessions).map(session => session.sessionId).sort())
        .toEqual(expected.liveProjects.flatMap(project => project.sessions).map(session => session.sessionId).sort())
    }
    expect(filesParsedFromSourceCount()).toBe(parsedAfterIndex)
  })

  it('does not let the fast cached snapshot suppress source reconciliation', async () => {
    await writeSession('today', 0)
    await writeSession('old', 90)
    await parseAllSessions(getDateRange('lifetime').range, 'all')
    clearSessionCache()
    clearLoadCacheMemo()
    // The source changes before launch, with no resident watcher available to
    // invalidate an in-process memo. Cached first paint may show the old value;
    // its immediately-following source reconciliation must replace it.
    await appendSessionCall('today', 450)

    const beforeSnapshot = fingerprintFileCount()
    const memoPublicationsBefore = sessionMemoPublicationCount()
    const snapshot = await buildDashboardHistoryIndex('all', undefined, undefined, {
      readyThrough: 'lifetime',
      preferCompleteSnapshot: true,
    })
    const afterSnapshot = fingerprintFileCount()
    expect(afterSnapshot).toBe(beforeSnapshot)
    expect(sessionMemoPublicationCount()).toBe(memoPublicationsBefore)
    expect(snapshot.normalizedProjects.flatMap(project => project.sessions)
      .find(session => session.sessionId === 'today')?.totalOutputTokens).toBe(50)

    const refreshed = await buildDashboardHistoryIndex('all', undefined, undefined)
    expect(fingerprintFileCount()).toBeGreaterThan(afterSnapshot)
    expect(refreshed.normalizedProjects.flatMap(project => project.sessions)
      .find(session => session.sessionId === 'today')?.totalOutputTokens).toBe(500)
  })

  it('widens a cold index in readiness order without parsing a source twice', async () => {
    const periods: Period[] = ['today', ...DASHBOARD_COLD_INDEX_PHASES]
    await Promise.all([
      writeSession('today', 0),
      writeSession('week', 5),
      writeSession('month', 20),
      writeSession('older', 45),
      writeSession('six-months', 120),
      writeSession('lifetime', 500),
    ])

    const parsedBefore = filesParsedFromSourceCount()
    let previousParsed = parsedBefore
    for (const [position, readyThrough] of DASHBOARD_COLD_INDEX_PHASES.entries()) {
      const index = await buildDashboardHistoryIndex('all', undefined, undefined, {
        readyThrough,
        progressiveSource: true,
      })
      for (const [periodPosition, period] of periods.entries()) {
        expect(dashboardIndexSupportsPeriod(index, period)).toBe(periodPosition <= position + 1)
      }
      const parsed = filesParsedFromSourceCount()
      expect(parsed).toBeGreaterThanOrEqual(previousParsed)
      previousParsed = parsed
    }

    expect(filesParsedFromSourceCount() - parsedBefore).toBe(6)
  })
})

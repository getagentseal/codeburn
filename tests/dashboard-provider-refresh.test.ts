import { PassThrough } from 'node:stream'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import React from 'react'
import { render } from 'ink'
import stripAnsi from 'strip-ansi'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'

import { assembleDashboardFirstPaint, buildDashboardHistoryIndex, InteractiveDashboard, selectDashboardHistoryIndex } from '../src/dashboard.js'
import { DAILY_CACHE_VERSION, emptyCache, saveDailyCache, toDateString } from '../src/daily-cache.js'
import { aggregateProjectsIntoDays } from '../src/day-aggregator.js'
import { clearSessionCache, parseAllSessions } from '../src/parser.js'
import { clearLoadCacheMemo } from '../src/session-cache.js'
import { getDailyCacheConfigHash } from '../src/usage-aggregator.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dashboard-provider-refresh-'))
  for (const [key, value] of Object.entries({
    HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEBURN_CACHE_DIR: join(root, 'cache'), CODEBURN_COPILOT_DISABLE_OTEL: '1',
    CODEBURN_COPILOT_SESSION_STATE_DIR: join(root, 'no-cli'),
    CODEBURN_COPILOT_SESSION_STORE_DB: join(root, 'no-store'),
    CODEBURN_COPILOT_WS_STORAGE_DIR: join(root, 'workspace'),
    CODEBURN_COPILOT_GLOBAL_STORAGE_DIR: join(root, 'no-global'),
    CODEBURN_COPILOT_JETBRAINS_DIR: join(root, 'no-jb'),
  })) vi.stubEnv(key, value)
  clearSessionCache()
  clearLoadCacheMemo()
})

afterEach(async () => {
  clearSessionCache()
  clearLoadCacheMemo()
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

it('keeps the Copilot headline through cached startup and source refresh when its day is absent from a complete cache', async () => {
  const at = (age: number) => new Date(Date.now() - age * 86400000).toISOString()
  const oldDir = join(root, 'claude', 'projects', 'old')
  await mkdir(oldDir, { recursive: true })
  await writeFile(join(oldDir, 'old.jsonl'), JSON.stringify({
    type: 'assistant', sessionId: 'old', timestamp: at(12), cwd: '/fixture/old',
    message: { id: 'old', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
      content: [], usage: { input_tokens: 100, output_tokens: 50 } },
  }) + '\n')
  // The all-provider cache was completed before these Copilot journals appeared.
  // Its non-empty history is on a different day from both new sessions.
  const oldProjects = await parseAllSessions(undefined, 'claude')
  await saveDailyCache({
    ...emptyCache(getDailyCacheConfigHash()), days: aggregateProjectsIntoDays(oldProjects),
    complete: true, watermarkTrusted: true, lastComputedDate: toDateString(new Date(at(1))),
  })
  const cachePath = join(root, 'cache', `daily-cache.v${DAILY_CACHE_VERSION}.json`)
  const cacheBefore = await readFile(cachePath, 'utf8')

  const timestamp = Date.parse(at(3))
  for (const [id, credits] of [['alpha', 40], ['beta', 60]] as const) {
    const dir = join(root, 'workspace', id, 'chatSessions')
    await mkdir(dir, { recursive: true })
    await writeFile(join(root, 'workspace', id, 'workspace.json'), JSON.stringify({ folder: `file:///fixture/${id}` }))
    await writeFile(join(dir, `${id}.jsonl`), JSON.stringify({ kind: 0, v: {
      sessionId: id, creationDate: timestamp, requests: [{
        requestId: `${id}-request`, modelId: 'copilot/gpt-4o', timestamp,
        modelTotals: [{ model: 'gpt-4o', inputTokens: 3500, cachedTokens: 2500, outputTokens: 500 }],
        copilotCredits: credits,
      }],
    } }) + '\n')
  }
  await parseAllSessions(undefined, 'copilot')
  clearSessionCache()
  clearLoadCacheMemo()

  const first = await assembleDashboardFirstPaint('week', 'copilot', undefined, undefined, undefined, null)
  const expected = { cost: 1, calls: 2, sessions: 2, inputTokens: 2000, outputTokens: 1000, cacheReadTokens: 5000 }
  expect(first.result.initialDurable).toMatchObject(expected)

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
  let indexed!: () => void
  const settled = new Promise<void>(resolve => { indexed = resolve })
  const app = render(React.createElement(InteractiveDashboard, {
    initialProjects: first.result.filteredProjects, initialPeriod: 'week', initialProvider: 'copilot',
    initialDurable: first.result.initialDurable, refreshSeconds: 0, windowColumns: 120,
    initialHistoryIndexing: true, initialCacheWasCold: false, onHistoryIndexed: indexed,
  }), { stdin, stdout, debug: true, interactive: true, patchConsole: false })
  onTestFinished(() => app.unmount())
  await app.waitUntilRenderFlush()
  expect(frames.filter(value => value.trim()).at(-1)).toContain('$1.00 cost   2 calls')
  await settled
  await app.waitUntilRenderFlush()
  const refreshedFrame = frames.filter(value => value.trim()).at(-1) ?? ''
  expect(refreshedFrame).toContain('$1.00 cost   2 calls')
  expect(refreshedFrame).toContain('2.0K in   1.0K out   5.0K cached')
  expect(refreshedFrame).not.toContain('source refresh pending')
  app.unmount()

  // Both index paths, repeated refreshes, and project filters must agree with
  // the first paint without advancing the shared all-provider cache.
  for (const preferCompleteSnapshot of [true, false]) {
    const index = await buildDashboardHistoryIndex('copilot', undefined, undefined, { preferCompleteSnapshot })
    expect(selectDashboardHistoryIndex(index, 'week').durable).toMatchObject(expected)
    expect(selectDashboardHistoryIndex(index, 'lifetime').durable).toMatchObject(expected)
    expect(selectDashboardHistoryIndex({ ...index, projectFilter: ['alpha'] }, 'week').durable)
      .toMatchObject({ cost: 0.4, calls: 1, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2500 })
    expect(selectDashboardHistoryIndex({ ...index, excludeFilter: ['alpha'] }, 'week').durable)
      .toMatchObject({ cost: 0.6, calls: 1, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2500 })
  }
  expect(await readFile(cachePath, 'utf8')).toBe(cacheBefore)
})

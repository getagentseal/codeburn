import { homedir } from 'os'
import { PassThrough } from 'stream'

import React from 'react'
import { render } from 'ink'
import stripAnsi from 'strip-ansi'
import { describe, it, expect, onTestFinished, vi } from 'vitest'

import { DAILY_ACTIVITY_PAGE_SIZE, INTERACTIVE_RENDER_OPTIONS, dailyActivityFooter, getDailyActivityRows, getDashboardMaxWidth, getDashboardScanRange, getLayout, getRefreshIntervalMs, InteractiveDashboard, pageHistoryCursor, scrollHistoryCursor, selectDashboardPeriodProjects, shortProject, shouldResetScreenOnResize, showEmptyState } from '../src/dashboard.js'
import { getDateRange } from '../src/cli-date.js'
import { formatCost } from '../src/format.js'
import type { ProjectSummary, SessionSummary } from '../src/types.js'

const EMPTY_CATEGORY_BREAKDOWN = {
  coding: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  debugging: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  feature: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  refactoring: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  testing: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  exploration: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  planning: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  delegation: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  git: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  'build/deploy': { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  conversation: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  brainstorming: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  general: { turns: 0, costUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
} satisfies SessionSummary['categoryBreakdown']

function makeSession(id: string, cost: number, timestamp = '2026-04-14T10:00:00Z'): SessionSummary {
  return {
    sessionId: id,
    project: 'test-project',
    firstTimestamp: timestamp,
    lastTimestamp: timestamp,
    totalCostUSD: cost,
    totalSavingsUSD: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    apiCalls: 1,
    turns: [],
    modelBreakdown: {},
    toolBreakdown: {},
    mcpBreakdown: {},
    bashBreakdown: {},
    categoryBreakdown: { ...EMPTY_CATEGORY_BREAKDOWN },
    skillBreakdown: {},
    subagentBreakdown: {},
  }
}

function makeProject(name: string, sessions: SessionSummary[]): ProjectSummary {
  return {
    project: name,
    projectPath: name,
    sessions,
    totalCostUSD: sessions.reduce((s, x) => s + x.totalCostUSD, 0),
    totalApiCalls: sessions.reduce((s, x) => s + x.apiCalls, 0),
  }
}

function makeTurn(timestamp: string, costs: number[]): SessionSummary['turns'][number] {
  return {
    userMessage: 'fixture turn',
    sessionId: 'fixture-session',
    timestamp,
    category: 'coding',
    retries: 0,
    hasEdits: false,
    assistantCalls: costs.map((costUSD, index) => ({
      provider: 'codex',
      model: 'test-model',
      usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0 },
      costUSD,
      tools: [],
      mcpTools: [],
      skills: [],
      subagentTypes: [],
      hasAgentSpawn: false,
      hasPlanMode: false,
      speed: 'standard',
      timestamp,
      bashCommands: [],
      deduplicationKey: `fixture-${timestamp}-${index}`,
    })),
  }
}

// Logic replicated from TopSessions component
function getTopSessions(projects: ProjectSummary[], n = 5) {
  const all = projects.flatMap(p => p.sessions.map(s => ({ ...s, projectPath: p.projectPath })))
  return [...all].sort((a, b) => b.totalCostUSD - a.totalCostUSD).slice(0, n)
}

// Logic replicated from ProjectBreakdown component
function avgCostLabel(project: ProjectSummary): string {
  return project.sessions.length > 0
    ? formatCost(project.totalCostUSD / project.sessions.length)
    : '-'
}

describe('TopSessions - top-5 selection', () => {
  it('returns all sessions when fewer than 5 exist', () => {
    const project = makeProject('proj', [
      makeSession('s1', 1.0),
      makeSession('s2', 2.0),
    ])
    const top = getTopSessions([project])
    expect(top).toHaveLength(2)
    expect(top[0].totalCostUSD).toBe(2.0)
    expect(top[1].totalCostUSD).toBe(1.0)
  })

  it('returns exactly 5 when more than 5 sessions exist', () => {
    const sessions = [0.1, 0.5, 3.0, 1.0, 0.8, 2.0].map((cost, i) =>
      makeSession(`s${i}`, cost)
    )
    const project = makeProject('proj', sessions)
    const top = getTopSessions([project])
    expect(top).toHaveLength(5)
    expect(top[0].totalCostUSD).toBe(3.0)
    expect(top[4].totalCostUSD).toBe(0.5)
  })

  it('is stable on tied costs - preserves input order for equal values', () => {
    const sessions = [
      makeSession('s1', 1.0),
      makeSession('s2', 1.0),
      makeSession('s3', 1.0),
    ]
    const project = makeProject('proj', sessions)
    const top = getTopSessions([project])
    expect(top.map(s => s.sessionId)).toEqual(['s1', 's2', 's3'])
  })
})

describe('shortProject - path shortening', () => {
  const home = homedir()

  it('preserves directory names containing dashes', () => {
    expect(shortProject(`${home}/work/my-project`)).toBe('work/my-project')
  })

  it('preserves directory names containing dots', () => {
    expect(shortProject(`${home}/work/my.app.io`)).toBe('work/my.app.io')
  })

  it('returns "home" for the home dir itself', () => {
    expect(shortProject(home)).toBe('home')
  })

  it('does not strip a sibling whose name shares the home prefix', () => {
    const sibling = `${home}-backup/proj`
    expect(shortProject(sibling).endsWith('proj')).toBe(true)
    expect(shortProject(sibling)).not.toMatch(/^-/)
  })

  it('keeps only the last 3 segments for deeply nested paths', () => {
    expect(shortProject(`${home}/a/b/c/d/e/f`)).toBe('d/e/f')
  })

  it('handles paths outside the home dir', () => {
    expect(shortProject('/opt/myproject')).toBe('opt/myproject')
  })
})

describe('avg/s in ProjectBreakdown', () => {
  it('returns dash for a project with no sessions', () => {
    const project = makeProject('proj', [])
    expect(avgCostLabel(project)).toBe('-')
  })

  it('returns formatted average cost across sessions', () => {
    const sessions = [makeSession('s1', 2.0), makeSession('s2', 4.0)]
    const project = makeProject('proj', sessions)
    expect(avgCostLabel(project)).toBe(formatCost(3.0))
  })
})

describe('Daily Activity history', () => {
  it('uses one concrete six-month scan for standard dashboard periods', () => {
    const scanRange = getDashboardScanRange('week', null, null)
    const allRange = getDateRange('all').range

    expect(scanRange.start.getTime()).toBe(allRange.start.getTime())
    expect(scanRange.end.getTime()).toBe(allRange.end.getTime())
  })

  it('keeps non-interactive output scoped to the selected period', () => {
    const scanRange = getDashboardScanRange('week', null, null, false)
    const weekRange = getDateRange('week').range

    expect(scanRange.start.getTime()).toBe(weekRange.start.getTime())
    expect(scanRange.end.getTime()).toBe(weekRange.end.getTime())
  })

  it('derives the selected period from the bounded history scan', () => {
    const recent = new Date().toISOString()
    const old = new Date()
    old.setMonth(old.getMonth() - 2)
    const session = makeSession('s1', 0)
    session.turns = [makeTurn(old.toISOString(), [1]), makeTurn(recent, [2])]

    const selected = selectDashboardPeriodProjects([makeProject('proj', [session])], 'week', true)
    expect(getDailyActivityRows(selected)).toEqual([
      { day: recent.slice(0, 10), cost: 2, calls: 1 },
    ])
  })

  it('aggregates every active day in chronological order', () => {
    const session = makeSession('s1', 0)
    session.turns = [
      makeTurn('2025-01-02T12:00:00Z', [1.25, 0.75]),
      makeTurn('2024-12-31T12:00:00Z', [3]),
    ]

    expect(getDailyActivityRows([makeProject('proj', [session])])).toEqual([
      { day: '2024-12-31', cost: 3, calls: 1 },
      { day: '2025-01-02', cost: 2, calls: 2 },
    ])
  })

  it('pages one viewport and keeps the final page full', () => {
    expect(pageHistoryCursor(0, 1, 35, 69)).toBe(34)
    expect(pageHistoryCursor(34, -1, 35, 69)).toBe(0)
    expect(pageHistoryCursor(0, -1, 35, 69)).toBe(0)
  })

  it('scrolls one row without moving past either end', () => {
    expect(scrollHistoryCursor(0, 1, 14, 21)).toBe(1)
    expect(scrollHistoryCursor(1, -1, 14, 21)).toBe(0)
    expect(scrollHistoryCursor(0, -1, 14, 21)).toBe(0)
    expect(scrollHistoryCursor(7, 1, 14, 21)).toBe(7)
  })
})

describe('showEmptyState', () => {
  it('keeps the clean empty state for a truly-new user in scrollable mode', () => {
    expect(showEmptyState(0, true, 0, false)).toBe(true)
  })

  it('renders the dashboard while full history is still loading', () => {
    expect(showEmptyState(0, true, 0, true)).toBe(false)
  })

  it('renders the dashboard when the period is empty but history exists', () => {
    expect(showEmptyState(0, true, 3, false)).toBe(false)
  })

  it('non-scrollable mode (custom range, day view) keeps the original behavior', () => {
    expect(showEmptyState(0, false, 0, false)).toBe(true)
    expect(showEmptyState(2, false, 0, false)).toBe(false)
  })
})

// Issue #767 item 3: the Daily Activity panel's "of N" is a count of days
// found by the bounded live scan, not the same population the Overview
// headline (durable cache) counts for the period. The two numbers are each
// correct for what they measure, but nothing on screen said so - label the
// denominator instead of changing it.
describe('dailyActivityFooter', () => {
  it('labels the count as the scanned-days population, not a bare total', () => {
    expect(dailyActivityFooter(0, 14, 37)).toBe('Showing 1–14 of 37 days scanned · newest first')
  })

  it('clamps the visible end to the row count', () => {
    expect(dailyActivityFooter(30, 14, 37)).toBe('Showing 31–37 of 37 days scanned · newest first')
  })
})

describe('getLayout - dashboard width breakpoints', () => {
  it('uses a single column at 89 columns or below', () => {
    expect(getLayout(89)).toMatchObject({ dashWidth: 89, columnCount: 1, panelWidth: 89 })
  })

  it('switches to two columns at 90 columns', () => {
    expect(getLayout(90)).toMatchObject({ dashWidth: 90, columnCount: 2, panelWidth: 45 })
  })

  it('keeps two columns through 134 columns', () => {
    expect(getLayout(134)).toMatchObject({ dashWidth: 134, columnCount: 2, panelWidth: 67 })
  })

  it('switches to three columns at 135 columns', () => {
    expect(getLayout(135)).toMatchObject({ dashWidth: 135, columnCount: 3, panelWidth: 45 })
  })

  it('continues growing three equal panels by one for every three columns', () => {
    expect(getLayout(160)).toMatchObject({ dashWidth: 160, columnCount: 3, panelWidth: 53 })
    expect(getLayout(161)).toMatchObject({ dashWidth: 161, columnCount: 3, panelWidth: 53 })
    expect(getLayout(162)).toMatchObject({ dashWidth: 162, columnCount: 3, panelWidth: 54 })
    expect(getLayout(165)).toMatchObject({ dashWidth: 165, columnCount: 3, panelWidth: 55 })
  })

  it('stops at the lesser of 256 columns or the source-data width', () => {
    expect(getLayout(300)).toMatchObject({ dashWidth: 256, columnCount: 3, panelWidth: 85 })
    expect(getLayout(300, 213)).toMatchObject({ dashWidth: 213, columnCount: 3, panelWidth: 71 })
  })

  it('derives the wide-layout ceiling from renderable source labels', () => {
    const short = makeProject('short', [makeSession('short', 1)])
    const long = makeProject('x'.repeat(200), [makeSession('long', 1)])

    expect(getDashboardMaxWidth([long])).toBe(256)
    expect(getDashboardMaxWidth([short])).toBeLessThan(256)
  })
})

describe('Daily Activity viewport', () => {
  it('shows ten dates at a time', () => {
    expect(DAILY_ACTIVITY_PAGE_SIZE).toBe(10)
  })
})

describe('getRefreshIntervalMs', () => {
  it('allows disabled refresh and clamps enabled refreshes to one minute', () => {
    expect(getRefreshIntervalMs(0)).toBe(0)
    expect(getRefreshIntervalMs(30)).toBe(60_000)
    expect(getRefreshIntervalMs(60)).toBe(60_000)
    expect(getRefreshIntervalMs(300)).toBe(300_000)
  })
})

describe('interactive terminal rendering', () => {
  it('isolates resize reflow from stale primary-screen frames', () => {
    expect(INTERACTIVE_RENDER_OPTIONS).toMatchObject({ alternateScreen: true })
  })

  it('clears the alternate buffer before repainting a resized frame', () => {
    expect(shouldResetScreenOnResize(160, 110)).toBe(true)
  })

  it('keeps the frame when the window grows beyond its content cap', () => {
    expect(shouldResetScreenOnResize(256, 300)).toBe(false)
  })

  it('accepts the next width before Ink paints each breakpoint transition', async () => {
    const stdin = new PassThrough() as PassThrough & NodeJS.ReadStream
    const stdout = new PassThrough() as PassThrough & NodeJS.WriteStream
    stdin.isTTY = true
    stdin.setRawMode = () => stdin
    stdin.ref = () => stdin
    stdin.unref = () => stdin
    stdout.isTTY = true
    stdout.columns = 135
    stdout.rows = 50
    const chunks: string[] = []
    stdout.on('data', chunk => chunks.push(stripAnsi(String(chunk))))
    const props = {
      initialProjects: [makeProject('proj', [makeSession('s1', 1)])],
      initialPeriod: 'today' as const,
      initialProvider: 'all',
      refreshSeconds: 0,
    }
    const app = render(React.createElement(InteractiveDashboard, { ...props, windowColumns: 135 }), {
      stdin, stdout, interactive: true, patchConsole: false,
    })
    onTestFinished(() => app.unmount())

    await new Promise(resolve => setTimeout(resolve, 20))
    chunks.length = 0
    app.rerender(React.createElement(InteractiveDashboard, { ...props, windowColumns: 134 }))
    await app.waitUntilRenderFlush()

    let panelTitleLine = (chunks.filter(chunk => chunk.trim()).at(-1) ?? '').split('\n').find(line => line.includes('Daily Activity')) ?? ''
    expect(panelTitleLine).toContain('By Project')
    expect(panelTitleLine).not.toContain('By Activity')

    chunks.length = 0
    app.rerender(React.createElement(InteractiveDashboard, { ...props, windowColumns: 89 }))
    await app.waitUntilRenderFlush()

    panelTitleLine = (chunks.filter(chunk => chunk.trim()).at(-1) ?? '').split('\n').find(line => line.includes('Daily Activity')) ?? ''
    expect(panelTitleLine).not.toContain('By Project')
  })
})

describe('InteractiveDashboard refresh', () => {
  it('keeps project metric headings readable before long project paths', async () => {
    const stdin = new PassThrough() as PassThrough & NodeJS.ReadStream
    const stdout = new PassThrough() as PassThrough & NodeJS.WriteStream
    stdin.isTTY = true
    stdin.setRawMode = () => stdin
    stdin.ref = () => stdin
    stdin.unref = () => stdin
    stdout.isTTY = true
    stdout.columns = 80
    stdout.rows = 100
    const frames: string[] = []
    stdout.on('data', chunk => frames.push(stripAnsi(String(chunk))))
    const project = makeProject('long-project', [makeSession('s1', 19.43)])
    project.projectPath = '/Users/jared/Documents/Codex/2026-07-30/global-agents-md-config-toml-codex'

    const app = render(React.createElement(InteractiveDashboard, {
      initialProjects: [project],
      initialPeriod: 'today',
      initialProvider: 'all',
      refreshSeconds: 0,
      windowColumns: 80,
    }), { stdin, stdout, debug: true, interactive: true, patchConsole: false })
    onTestFinished(() => app.unmount())

    let frame = ''
    for (let i = 0; i < 100 && !frame.includes('10.4K'); i++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      frame = frames.filter(value => value.trim()).at(-1) ?? ''
    }

    expect(frame).toContain('10.4K')
    const projectHeader = frame.split('\n').find(line => line.includes('avg/s')) ?? ''
    expect(projectHeader).toMatch(/cost\s+avg\/s\s+sess\s+overhead/)
    expect(projectHeader).not.toContain('sessover')
  })

  it('keeps Optimize mounted without a loading frame when auto-refresh fires', async () => {
    vi.useFakeTimers()
    const stdin = new PassThrough() as PassThrough & NodeJS.ReadStream
    const stdout = new PassThrough() as PassThrough & NodeJS.WriteStream
    stdin.isTTY = true
    stdin.setRawMode = () => stdin
    stdin.ref = () => stdin
    stdin.unref = () => stdin
    stdout.isTTY = true
    stdout.columns = 160
    stdout.rows = 50
    const frames: string[] = []
    stdout.on('data', chunk => frames.push(stripAnsi(String(chunk))))
    const session = makeSession('s1', 1)
    session.turns = Array.from({ length: 11 }, (_, index) => makeTurn(`2026-07-${String(index + 1).padStart(2, '0')}T10:00:00Z`, [1]))
    session.categoryBreakdown.coding = { turns: 12, costUSD: 1, retries: 0, editTurns: 10, oneShotTurns: 5 }

    const app = render(React.createElement(InteractiveDashboard, {
      initialProjects: [makeProject('proj', [session])],
      initialPeriod: 'today',
      initialProvider: 'all',
      refreshSeconds: 60,
      windowColumns: 160,
    }), { stdin, stdout, debug: true, interactive: true, patchConsole: false })
    onTestFinished(() => {
      app.unmount()
      vi.useRealTimers()
    })

    await vi.advanceTimersByTimeAsync(100)
    const dashboardFrame = frames.filter(frame => frame.trim()).at(-1) ?? ''
    const dashboardLines = dashboardFrame.split('\n')
    expect(dashboardLines.find(line => line.includes('Daily Activity'))).toContain('By Project')
    expect(dashboardLines.find(line => line.includes('Daily Activity'))).toContain('By Activity')
    expect(dashboardLines.find(line => line.includes('By Model'))).toContain('MCP Servers')
    expect(dashboardLines.find(line => line.includes('By Model'))).toContain('Core Tools')
    expect(dashboardLines.find(line => line.includes('Shell Commands'))).toContain('Skills & Agents')
    expect(dashboardFrame.match(/2026-07-/g)).toHaveLength(DAILY_ACTIVITY_PAGE_SIZE)
    const dailyRow = dashboardLines.find(line => /2026-07-\d{2}/.test(line)) ?? ''
    const dailyBarIndex = ['█', '░'].map(char => dailyRow.indexOf(char)).filter(index => index >= 0).sort((a, b) => a - b)[0] ?? -1
    expect(dailyBarIndex).toBeGreaterThanOrEqual(0)
    expect(dailyBarIndex).toBeLessThan(dailyRow.search(/2026-07-\d{2}/))
    const activityHeader = dashboardLines.find(line => line.includes('turns'))?.slice(106, 159) ?? ''
    const activityRow = dashboardLines.find(line => line.includes('Coding'))?.slice(106, 159) ?? ''
    expect(activityHeader.indexOf('cost') + 'cost'.length).toBe(activityRow.indexOf('$1.00') + '$1.00'.length)
    expect(activityHeader.indexOf('turns') + 'turns'.length).toBe(activityRow.indexOf('12') + '12'.length)
    expect(activityHeader.indexOf('1-shot') + '1-shot'.length).toBe(activityRow.indexOf('50%') + '50%'.length)
    stdin.write('o')
    for (let i = 0; i < 20 && !frames.some(frame => frame.includes('Token estimates are approximate.')); i++) {
      await vi.advanceTimersByTimeAsync(50)
    }
    const beforeRefresh = frames.filter(frame => frame.trim()).at(-1) ?? ''
    expect(beforeRefresh).toContain('CodeBurn Optimize')
    expect(beforeRefresh).toContain('Token estimates are approximate.')

    frames.length = 0
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.advanceTimersByTimeAsync(100)

    const frame = frames.filter(value => value.trim()).at(-1) ?? beforeRefresh
    expect(frame).toBe(beforeRefresh)
    expect(frame).toContain('CodeBurn Optimize')
    expect(frame).toContain('Token estimates are approximate.')
    expect(frame).toContain('b back')
    expect(frame).not.toContain('Loading Today')
    expect(frame).not.toContain('Scanning Today')

  })
})

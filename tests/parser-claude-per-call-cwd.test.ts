import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { appendFile, mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { clearSessionCache, filterProjectsByName, mergeProjectSplits, parseAllSessions } from '../src/parser.js'
import { aggregateSessions } from '../src/sessions-report.js'
import { aggregateProjectsIntoDays } from '../src/day-aggregator.js'
import { countSessions } from '../src/session-output.js'
import { buildMenubarPayloadForRange, uniqueCanonicalSessionCountFromProjects } from '../src/usage-aggregator.js'
import type { DateRange, ProjectSummary } from '../src/types.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'claude-per-call-cwd-'))
  process.env['CLAUDE_CONFIG_DIR'] = tmpDir
  process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] = join(tmpDir, 'desktop-sessions')
  process.env['CODEBURN_CACHE_DIR'] = join(tmpDir, 'cache')
  clearSessionCache()
})

afterEach(async () => {
  clearSessionCache()
  await rm(tmpDir, { recursive: true, force: true })
})

const RANGE: DateRange = { start: new Date('2099-06-01T00:00:00.000Z'), end: new Date('2099-06-01T23:59:59.999Z') }
const HOME = '/work/home'
const APP = '/work/app'

const user = (text: string, cwd: string, ts: string) => JSON.stringify({
  type: 'user', sessionId: 's1', timestamp: ts, cwd, message: { role: 'user', content: text },
})
const assistant = (id: string, cwd: string, ts: string, input: number) => JSON.stringify({
  type: 'assistant', sessionId: 's1', timestamp: ts, cwd,
  message: { id, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], usage: { input_tokens: input, output_tokens: 0 } },
})

async function writeSession(lines: string[]): Promise<string> {
  const dir = join(tmpDir, 'projects', '-work-home')
  await mkdir(dir, { recursive: true })
  const file = join(dir, 's1.jsonl')
  await writeFile(file, lines.join('\n') + '\n')
  return file
}

const byPath = (projects: ProjectSummary[]) => Object.fromEntries(projects.map(p => [p.projectPath, p]))

describe('Claude per-call cwd', () => {
  it('splits a session that moved folders by call, keeping totals, turns and the session count whole', async () => {
    await writeSession([
      user('start', HOME, '2099-06-01T10:00:00.000Z'),
      assistant('m1', HOME, '2099-06-01T10:00:01.000Z', 1_000_000),
      // The working directory changes mid-turn, then a new turn starts there.
      assistant('m2', APP, '2099-06-01T10:00:02.000Z', 2_000_000),
      user('next', APP, '2099-06-01T10:05:00.000Z'),
      assistant('m3', APP, '2099-06-01T10:05:01.000Z', 3_000_000),
    ])

    const projects = await parseAllSessions(RANGE, 'claude')
    const paths = byPath(projects)
    expect(Object.keys(paths).sort()).toEqual([APP, HOME])
    expect(paths[HOME]!.totalApiCalls).toBe(1)
    expect(paths[APP]!.totalApiCalls).toBe(2)
    expect(paths[APP]!.totalCostUSD).toBeCloseTo(paths[HOME]!.totalCostUSD * 5, 10)

    const allTurns = projects.flatMap(p => p.sessions).reduce((n, s) => n + Object.values(s.categoryBreakdown).reduce((m, c) => m + c.turns, 0), 0)
    expect(allTurns).toBe(2)
    expect(countSessions(projects)).toBe(1)
    expect(uniqueCanonicalSessionCountFromProjects(projects)).toBe(1)

    const [day] = aggregateProjectsIntoDays(projects)
    expect(day!.sessions).toBe(1)
    expect(day!.calls).toBe(3)
    expect(Object.values(day!.projects!).map(p => p.calls).sort()).toEqual([1, 2])

    const rows = aggregateSessions(mergeProjectSplits(projects))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.project).toBe('-work-app')
    expect(rows[0]!.calls).toBe(3)
    expect(rows[0]!.turns).toBe(2)
    expect(rows[0]!.cost).toBeCloseTo(paths[HOME]!.totalCostUSD + paths[APP]!.totalCostUSD, 10)

    const payload = await buildMenubarPayloadForRange({ range: RANGE, label: 'p' }, { provider: 'claude', optimize: false, timeline: false })
    expect(payload.current.topSessions.map(s => [s.sessionId, s.calls])).toEqual([['s1', 3]])

    const onlyApp = filterProjectsByName(projects, ['app'], [])
    expect(onlyApp.map(p => p.projectPath)).toEqual([APP])
    expect(countSessions(onlyApp)).toBe(1)
  })

  it('keeps a cd into a subfolder of the same repository on the transcript project', async () => {
    const repo = join(tmpDir, 'repo')
    await mkdir(join(repo, '.git'), { recursive: true })
    await mkdir(join(repo, 'app', 'src'), { recursive: true })
    await writeSession([
      user('start', repo, '2099-06-01T10:00:00.000Z'),
      assistant('m1', repo, '2099-06-01T10:00:01.000Z', 1_000_000),
      assistant('m2', join(repo, 'app'), '2099-06-01T10:00:02.000Z', 2_000_000),
      assistant('m3', join(repo, 'app', 'src'), '2099-06-01T10:00:03.000Z', 3_000_000),
    ])
    const projects = await parseAllSessions(RANGE, 'claude')
    expect(projects.map(p => p.projectPath)).toEqual([repo])
    expect(projects[0]!.totalApiCalls).toBe(3)
    expect(projects[0]!.sessions[0]!.projectSplit).toBeUndefined()
  })

  it('splits a cd from a plain folder into a repository below it, and keeps the repository whole', async () => {
    const home = join(tmpDir, 'home')
    const repo = join(home, 'Projects', 'crew')
    await mkdir(join(repo, '.git'), { recursive: true })
    await mkdir(join(repo, 'src'), { recursive: true })
    await mkdir(join(home, 'notes'), { recursive: true })
    await writeSession([
      user('start', home, '2099-06-01T10:00:00.000Z'),
      assistant('m1', home, '2099-06-01T10:00:01.000Z', 1_000_000),
      assistant('m2', join(home, 'notes'), '2099-06-01T10:00:02.000Z', 1_000_000),
      assistant('m3', repo, '2099-06-01T10:00:03.000Z', 2_000_000),
      assistant('m4', join(repo, 'src'), '2099-06-01T10:00:04.000Z', 2_000_000),
      // A deleted worktree cannot prove it belonged to home, so it stays apart.
      assistant('m5', join(home, 'gone-wt'), '2099-06-01T10:00:05.000Z', 1_000_000),
    ])
    const paths = byPath(await parseAllSessions(RANGE, 'claude'))
    expect(Object.keys(paths).sort()).toEqual([home, repo, join(home, 'gone-wt')].sort())
    expect(paths[home]!.totalApiCalls).toBe(2)
    expect(paths[repo]!.totalApiCalls).toBe(2)
  })

  it('reads the same split from an appended transcript as from a fresh parse', async () => {
    const file = await writeSession([
      user('start', HOME, '2099-06-01T10:00:00.000Z'),
      assistant('m1', HOME, '2099-06-01T10:00:01.000Z', 1_000_000),
    ])
    await parseAllSessions(RANGE, 'claude')
    await appendFile(file, [
      assistant('m2', APP, '2099-06-01T10:00:02.000Z', 2_000_000),
      assistant('m3', HOME, '2099-06-01T10:00:03.000Z', 4_000_000),
    ].join('\n') + '\n')
    clearSessionCache()
    const appended = byPath(await parseAllSessions(RANGE, 'claude'))

    await rm(join(tmpDir, 'cache'), { recursive: true, force: true })
    clearSessionCache()
    const fresh = byPath(await parseAllSessions(RANGE, 'claude'))

    for (const paths of [appended, fresh]) {
      expect(paths[HOME]!.totalApiCalls).toBe(2)
      expect(paths[APP]!.totalApiCalls).toBe(1)
    }
    expect(appended[HOME]!.totalCostUSD).toBeCloseTo(fresh[HOME]!.totalCostUSD, 10)
    expect(appended[APP]!.totalCostUSD).toBeCloseTo(fresh[APP]!.totalCostUSD, 10)
  })

  it('keeps a PR-bearing session whose transcript is gone across a parse bump', async () => {
    const file = await writeSession([
      user('start', HOME, '2099-06-01T10:00:00.000Z'),
      assistant('m1', HOME, '2099-06-01T10:00:01.000Z', 1_000_000),
      JSON.stringify({ type: 'pr-link', sessionId: 's1', timestamp: '2099-06-01T10:00:02.000Z', prUrl: 'https://github.com/o/r/pull/1' }),
    ])
    await parseAllSessions(RANGE, 'claude')
    await rm(file)
    // Any change to the provider's env fingerprint rebuilds its cache section,
    // exactly like a parse-version bump.
    process.env['APPDATA'] = join(tmpDir, 'appdata')
    clearSessionCache()
    try {
      const projects = await parseAllSessions(RANGE, 'claude')
      expect(projects.flatMap(p => p.sessions).map(s => s.sessionId)).toEqual(['s1'])
    } finally {
      delete process.env['APPDATA']
    }
  })
})

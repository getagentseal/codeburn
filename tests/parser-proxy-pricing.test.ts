import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { setProxyPaths, isProxiedPath, getProxyPathsConfigHash, setLocalModelSavings, setModelAliases, loadPricing } from '../src/models.js'
import { parseAllSessions, clearSessionCache, filterProjectsByDateRange } from '../src/parser.js'
import type { DateRange, ProjectSummary } from '../src/types.js'

// ── Part A: isProxiedPath matching rule (pure) ─────────────────────────────

describe('isProxiedPath: path matching rule', () => {
  beforeEach(() => setProxyPaths([]))
  afterEach(() => setProxyPaths([]))

  it('never matches when no proxy paths are configured', () => {
    expect(isProxiedPath('/Users/me/work/acme')).toBe(false)
  })

  it('matches an exact path', () => {
    setProxyPaths(['/Users/me/work/acme'])
    expect(isProxiedPath('/Users/me/work/acme')).toBe(true)
  })

  it('matches a child directory under the prefix', () => {
    setProxyPaths(['/Users/me/work'])
    expect(isProxiedPath('/Users/me/work/acme/sub')).toBe(true)
  })

  it('does NOT match across a partial path segment (boundary guard)', () => {
    // The single most important negative: a string prefix that is not a
    // directory-segment boundary must not silently zero unrelated spend.
    setProxyPaths(['/Users/me/proj'])
    expect(isProxiedPath('/Users/me/project-unrelated')).toBe(false)
  })

  it('is tolerant of trailing slashes on both config and cwd', () => {
    setProxyPaths(['/Users/me/work/'])
    expect(isProxiedPath('/Users/me/work')).toBe(true)
    expect(isProxiedPath('/Users/me/work/')).toBe(true)
  })

  it('is case-insensitive (macOS/Windows default filesystems)', () => {
    setProxyPaths(['/Users/Me/Work'])
    expect(isProxiedPath('/users/me/work/acme')).toBe(true)
  })

  it('matches a Windows-style config against a forward-slash cwd', () => {
    setProxyPaths(['C:\\Users\\me\\work'])
    expect(isProxiedPath('C:/Users/me/work/acme')).toBe(true)
  })

  it('never matches an empty/undefined/null cwd', () => {
    setProxyPaths(['/Users/me/work'])
    expect(isProxiedPath('')).toBe(false)
    expect(isProxiedPath(undefined)).toBe(false)
    expect(isProxiedPath(null)).toBe(false)
  })

  it('drops a root "/" entry so it can never match everything', () => {
    setProxyPaths(['/'])
    expect(isProxiedPath('/Users/me/anything')).toBe(false)
  })

  it('drops blank / non-string entries', () => {
    setProxyPaths(['', '   ', undefined as unknown as string, '/Users/me/work'])
    expect(isProxiedPath('/Users/me/work/x')).toBe(true)
    expect(isProxiedPath('/somewhere/else')).toBe(false)
  })

  it('matches when any one of several configured paths matches', () => {
    setProxyPaths(['/Users/me/a', '/Users/me/b'])
    expect(isProxiedPath('/Users/me/b/deep')).toBe(true)
    expect(isProxiedPath('/Users/me/c')).toBe(false)
  })

  it('is reset by setProxyPaths([])', () => {
    setProxyPaths(['/Users/me/work'])
    expect(isProxiedPath('/Users/me/work')).toBe(true)
    setProxyPaths([])
    expect(isProxiedPath('/Users/me/work')).toBe(false)
  })

  it('matches a leading-slash-stripped cwd (non-Claude provider path form)', () => {
    // Codex/unsanitizePath project paths drop the leading slash; the configured
    // path keeps it. Matching must be agnostic to that difference.
    setProxyPaths(['/Users/me/work'])
    expect(isProxiedPath('Users/me/work/acme')).toBe(true)
    expect(isProxiedPath('Users/me/work')).toBe(true)
  })
})

describe('getProxyPathsConfigHash: cache-key stability', () => {
  beforeEach(() => setProxyPaths([]))
  afterEach(() => setProxyPaths([]))

  it('is empty when unconfigured', () => {
    expect(getProxyPathsConfigHash()).toBe('')
  })

  it('is order-independent', () => {
    setProxyPaths(['/a', '/b'])
    const h1 = getProxyPathsConfigHash()
    setProxyPaths(['/b', '/a'])
    expect(getProxyPathsConfigHash()).toBe(h1)
  })

  it('does NOT collide two materially different sets (delimited join)', () => {
    // Regression guard: a separator-less join would make {'/a','/b'} and
    // {'/a/b'} hash identically and let the session cache serve stale numbers.
    setProxyPaths(['/a', '/b'])
    const h1 = getProxyPathsConfigHash()
    setProxyPaths(['/a/b'])
    expect(getProxyPathsConfigHash()).not.toBe(h1)
  })
})

// ── Part B: end-to-end attribution through parseAllSessions ────────────────

const FIXTURE_DAY = Date.UTC(2026, 3, 16)
const RANGE_START = new Date(FIXTURE_DAY - 24 * 60 * 60 * 1000)
const RANGE_END = new Date(FIXTURE_DAY + 24 * 60 * 60 * 1000)
const makeRange = (): DateRange => ({ start: RANGE_START, end: RANGE_END })

// A stable, non-existent absolute path: resolveCanonicalProjectPath finds no
// .git ancestor and returns it unchanged, so projectPath is predictable.
const FIXTURE_CWD = '/private/var/eywa-proxy-fixture/acme'

let tmpDirs: string[] = []
let originalConfigDir: string | undefined

beforeAll(async () => {
  await loadPricing()
})

beforeEach(() => {
  originalConfigDir = process.env['CLAUDE_CONFIG_DIR']
  setProxyPaths([])
  setLocalModelSavings({})
  setModelAliases({})
  clearSessionCache()
})

afterEach(async () => {
  setProxyPaths([])
  if (originalConfigDir === undefined) delete process.env['CLAUDE_CONFIG_DIR']
  else process.env['CLAUDE_CONFIG_DIR'] = originalConfigDir
  clearSessionCache()
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop()
    if (d) await rm(d, { recursive: true, force: true })
  }
})

async function setupProxiedSession(cwd: string = FIXTURE_CWD): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'codeburn-proxy-'))
  tmpDirs.push(base)
  const projectDir = join(base, 'projects', 'p')
  await mkdir(projectDir, { recursive: true })
  const line = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-04-16T10:00:00.000Z',
    sessionId: 's1',
    cwd,
    message: {
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      id: 'msg-1',
      content: [],
      usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  })
  await writeFile(join(projectDir, 's1.jsonl'), line + '\n', 'utf-8')
  process.env['CLAUDE_CONFIG_DIR'] = base
}

const allCalls = (projects: ProjectSummary[]) =>
  projects.flatMap(p => p.sessions.flatMap(s => s.turns.flatMap(t => t.assistantCalls)))

describe('proxy pricing: end-to-end through parseAllSessions', () => {
  it('attributes nothing as proxied when no proxy paths are configured', async () => {
    await setupProxiedSession()
    const projects = await parseAllSessions(makeRange(), 'all')
    const total = projects.reduce((s, p) => s + p.totalCostUSD, 0)
    const proxied = projects.reduce((s, p) => s + p.totalProxiedCostUSD, 0)
    expect(total).toBeGreaterThan(0)
    expect(proxied).toBe(0)
  })

  it('flags the full cost as proxied when the project is under a proxy path, WITHOUT altering costUSD', async () => {
    await setupProxiedSession()
    setProxyPaths([FIXTURE_CWD])
    clearSessionCache()
    const projects = await parseAllSessions(makeRange(), 'all')

    const total = projects.reduce((s, p) => s + p.totalCostUSD, 0)
    const proxied = projects.reduce((s, p) => s + p.totalProxiedCostUSD, 0)
    expect(total).toBeGreaterThan(0)
    // "Full cost, flagged": the billable figure is preserved, the same amount
    // is reported as subscription-covered, so net out-of-pocket is 0.
    expect(proxied).toBeCloseTo(total, 10)
    expect(total - proxied).toBeCloseTo(0, 10)

    // The raw per-call cost is never destroyed — it stays at the full API rate.
    const calls = allCalls(projects)
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) expect(c.costUSD).toBeGreaterThan(0)
  })

  it('matches a parent prefix on a segment boundary', async () => {
    await setupProxiedSession()
    setProxyPaths(['/private/var/eywa-proxy-fixture'])
    clearSessionCache()
    const projects = await parseAllSessions(makeRange(), 'all')
    const proxied = projects.reduce((s, p) => s + p.totalProxiedCostUSD, 0)
    expect(proxied).toBeGreaterThan(0)
  })

  it('does NOT flag a sibling path that is only a string prefix (no spend silently zeroed)', async () => {
    await setupProxiedSession()
    // '/private/var/eywa-proxy-fixture/ac' is a string prefix of '.../acme'
    // but not a directory-segment boundary — must not match.
    setProxyPaths(['/private/var/eywa-proxy-fixture/ac'])
    clearSessionCache()
    const projects = await parseAllSessions(makeRange(), 'all')
    const total = projects.reduce((s, p) => s + p.totalCostUSD, 0)
    const proxied = projects.reduce((s, p) => s + p.totalProxiedCostUSD, 0)
    expect(total).toBeGreaterThan(0)
    expect(proxied).toBe(0)
  })

  it('attributes nothing when a different, unrelated path is configured', async () => {
    await setupProxiedSession()
    setProxyPaths(['/Users/someone/else'])
    clearSessionCache()
    const projects = await parseAllSessions(makeRange(), 'all')
    const proxied = projects.reduce((s, p) => s + p.totalProxiedCostUSD, 0)
    expect(proxied).toBe(0)
  })

  it('preserves proxy attribution after date-range filtering (filterProjectsByDateRange)', async () => {
    await setupProxiedSession()
    setProxyPaths([FIXTURE_CWD])
    clearSessionCache()
    const projects = await parseAllSessions(makeRange(), 'all')
    const filtered = filterProjectsByDateRange(projects, makeRange())
    expect(filtered.length).toBeGreaterThan(0)
    const total = filtered.reduce((s, p) => s + p.totalCostUSD, 0)
    const proxied = filtered.reduce((s, p) => s + p.totalProxiedCostUSD, 0)
    expect(total).toBeGreaterThan(0)
    expect(proxied).toBeCloseTo(total, 10)
  })

  it('does not serve stale proxy attribution from the in-memory cache after proxyPaths changes', async () => {
    // parseAllSessions caches ProjectSummary[] for 180s keyed partly on the
    // proxy-config hash. Toggling proxyPaths must change the key so the second
    // call recomputes rather than returning the pre-change (proxied=0) result.
    await setupProxiedSession()
    const before = await parseAllSessions(makeRange(), 'all')
    expect(before.reduce((s, p) => s + p.totalProxiedCostUSD, 0)).toBe(0)

    setProxyPaths([FIXTURE_CWD]) // deliberately NO clearSessionCache()
    const after = await parseAllSessions(makeRange(), 'all')
    const proxied = after.reduce((s, p) => s + p.totalProxiedCostUSD, 0)
    expect(proxied).toBeGreaterThan(0)
  })
})

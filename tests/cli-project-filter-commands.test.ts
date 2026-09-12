import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { DAILY_CACHE_VERSION, currentTzKey } from '../src/daily-cache.js'

// Each test spawns `tsx src/cli.ts`, which re-transpiles the CLI per spawn.
vi.setConfig({ testTimeout: 30_000 })

// Unit tests of filterProjectsByName cannot tell whether a command passes its
// patterns down. These run the real binary over two path siblings, so dropping
// the argument anywhere here fails the suite.
const SIBLINGS = [
  { dir: '-Users-gone-app', cwd: '/Users/gone/app', session: 's-app' },
  { dir: '-Users-gone-app-kit', cwd: '/Users/gone/app-kit', session: 's-kit' },
]

let homes: string[] = []

afterEach(async () => {
  while (homes.length > 0) {
    const home = homes.pop()
    if (home) await rm(home, { recursive: true, force: true })
  }
})

async function seedHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'codeburn-project-filter-cli-'))
  homes.push(home)
  const now = Date.now()
  const line = (session: string, cwd: string, index: number): string => JSON.stringify({
    type: 'assistant',
    timestamp: new Date(now - (30 - index) * 60_000).toISOString(),
    sessionId: session,
    cwd,
    message: {
      type: 'message', role: 'assistant', model: 'claude-3-5-sonnet-20241022', id: `${session}-m${index}`,
      content: [],
      usage: { input_tokens: 90000, output_tokens: 12000, cache_creation_input_tokens: 0, cache_read_input_tokens: 300000 },
    },
  })
  for (const project of SIBLINGS) {
    const dir = join(home, '.claude', 'projects', project.dir)
    await mkdir(dir, { recursive: true })
    const lines = [1, 2].map(index => line(project.session, project.cwd, index))
    await writeFile(join(dir, `${project.session}.jsonl`), lines.join('\n') + '\n', 'utf-8')
  }
  return home
}

/** A project whose only sessions are older than today, so a today-scoped pass misses it. */
async function seedHomeWithOlderSessions(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'codeburn-project-filter-cli-'))
  homes.push(home)
  const dir = join(home, '.claude', 'projects', SIBLINGS[0]!.dir)
  await mkdir(dir, { recursive: true })
  const fiveDaysAgo = Date.now() - 5 * 24 * 60 * 60 * 1000
  const lines = [1, 2].map(index => JSON.stringify({
    type: 'assistant',
    timestamp: new Date(fiveDaysAgo + index * 60_000).toISOString(),
    sessionId: 's-old',
    cwd: SIBLINGS[0]!.cwd,
    message: {
      type: 'message', role: 'assistant', model: 'claude-3-5-sonnet-20241022', id: `old-m${index}`,
      content: [],
      usage: { input_tokens: 90000, output_tokens: 12000, cache_creation_input_tokens: 0, cache_read_input_tokens: 300000 },
    },
  }))
  await writeFile(join(dir, 's-old.jsonl'), lines.join('\n') + '\n', 'utf-8')
  return home
}

/** A carried day the cache still bills, whose session files are long gone. */
async function seedDayCacheOnly(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'codeburn-project-filter-cli-'))
  homes.push(home)
  await mkdir(join(home, '.claude', 'projects'), { recursive: true })
  await mkdir(join(home, 'cache'), { recursive: true })
  const date = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const projects = { app: { cost: 30, calls: 10, savingsUSD: 0, sessions: 1, path: SIBLINGS[0]!.cwd } }
  const day = {
    date, cost: 30, savingsUSD: 0, calls: 10, sessions: 1,
    inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0,
    editTurns: 1, oneShotTurns: 0, models: {}, categories: {}, providers: {}, projects, carried: true,
  }
  await writeFile(join(home, 'cache', `daily-cache.v${DAILY_CACHE_VERSION}.json`), JSON.stringify({
    version: DAILY_CACHE_VERSION, savingsConfigHash: '', tzKey: currentTzKey(),
    lastComputedDate: date, days: [day], complete: true,
  }), 'utf-8')
  return home
}

/** A project pair whose assistant turns all read as self-corrections. */
async function seedHomeWithApologies(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'codeburn-project-filter-cli-'))
  homes.push(home)
  const now = Date.now()
  for (const [offset, project] of SIBLINGS.entries()) {
    const dir = join(home, '.claude', 'projects', project.dir)
    await mkdir(dir, { recursive: true })
    // scanSelfCorrections dedupes on model+timestamp, so the siblings must not
    // share one.
    const lines = [1, 2].map(index => JSON.stringify({
      type: 'assistant',
      timestamp: new Date(now - (30 - index - offset * 5) * 60_000).toISOString(),
      sessionId: project.session,
      cwd: project.cwd,
      message: {
        type: 'message', role: 'assistant', model: 'claude-3-5-sonnet-20241022', id: `${project.session}-m${index}`,
        content: [{ type: 'text', text: 'I apologize for the confusion.' }],
        usage: { input_tokens: 90000, output_tokens: 12000, cache_creation_input_tokens: 0, cache_read_input_tokens: 300000 },
      },
    }))
    await writeFile(join(dir, `${project.session}.jsonl`), lines.join('\n') + '\n', 'utf-8')
  }
  return home
}

function runCli(args: string[], home: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEBURN_CACHE_DIR: join(home, 'cache'), TZ: 'UTC' },
    encoding: 'utf-8',
    timeout: 30_000,
  })
}

/** `web` never exits on its own: run it until the server announces itself. */
function runServerCli(args: string[], home: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEBURN_CACHE_DIR: join(home, 'cache'), TZ: 'UTC' },
    })
    let stderr = ''
    let stdout = ''
    const stop = () => { child.kill('SIGKILL'); resolve(stderr) }
    child.stderr.setEncoding('utf-8')
    child.stdout.setEncoding('utf-8')
    child.stderr.on('data', chunk => { stderr += chunk })
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.includes('Press Ctrl+C to stop')) stop() })
    child.on('error', reject)
    child.on('close', () => resolve(stderr))
  })
}

describe('--project / --exclude reach the reporting commands', () => {
  it('compare scopes self-corrections to the filtered projects', async () => {
    const home = await seedHomeWithApologies()

    const all = runCli(['compare', '--format', 'json', '--period', '30days'], home)
    expect(all.status).toBe(0)
    const allStats = JSON.parse(all.stdout) as Array<{ selfCorrections: number }>
    expect(allStats).toHaveLength(1)
    expect(allStats[0]!.selfCorrections).toBe(4)

    const filtered = runCli(['compare', '--format', 'json', '--period', '30days', '--project', '/Users/gone/app-kit'], home)
    expect(filtered.status).toBe(0)
    const filteredStats = JSON.parse(filtered.stdout) as Array<{ selfCorrections: number }>
    expect(filteredStats[0]!.selfCorrections).toBe(2)
  })

  it('sessions keeps the sibling an absolute --exclude does not name', async () => {
    const home = await seedHome()

    const all = runCli(['sessions', '--format', 'json', '--period', '30days'], home)
    expect(all.stderr).not.toContain('no project in this period matches')
    expect(JSON.parse(all.stdout).map((s: { project: string }) => s.project).sort())
      .toEqual(['-Users-gone-app', '-Users-gone-app-kit'])

    const filtered = runCli(['sessions', '--format', 'json', '--period', '30days', '--exclude', '/Users/gone/app'], home)
    expect(filtered.status).toBe(0)
    expect(JSON.parse(filtered.stdout).map((s: { project: string }) => s.project))
      .toEqual(['-Users-gone-app-kit'])
  })

  it('spend carries the patterns into computeSpendFlow', async () => {
    const home = await seedHome()

    const all = runCli(['spend', '--format', 'flow-json', '--period', '30days'], home)
    expect(all.status).toBe(0)
    expect(JSON.parse(all.stdout).projects).toHaveLength(2)

    const filtered = runCli(['spend', '--format', 'flow-json', '--period', '30days', '--exclude', '/Users/gone/app'], home)
    expect(filtered.status).toBe(0)
    const projects = JSON.parse(filtered.stdout).projects as Array<{ label: string }>
    expect(projects.map(p => p.label)).toEqual(['app-kit'])
  })

  it('yield carries the patterns into computeYield', async () => {
    const home = await seedHome()

    const all = runCli(['yield', '--format', 'json', '--period', '30days'], home)
    expect(all.status).toBe(0)
    expect(JSON.parse(all.stdout).details).toHaveLength(2)

    const filtered = runCli(['yield', '--format', 'json', '--period', '30days', '--exclude', '/Users/gone/app'], home)
    expect(filtered.status).toBe(0)
    const report = JSON.parse(filtered.stdout)
    expect(report.details.map((d: { project: string }) => d.project)).toEqual(['-Users-gone-app-kit'])
    type YieldDetail = { project: string; costUSD: number }
    const kept = (JSON.parse(all.stdout).details as YieldDetail[]).find(d => d.project === '-Users-gone-app-kit')!
    const total = (report.details as YieldDetail[]).reduce((sum, d) => sum + d.costUSD, 0)
    expect(total).toBeCloseTo(kept.costUSD, 6)
  })
})

describe('a rooted pattern that names nothing is reported', () => {
  it('warns on stderr rather than reporting a total over a set nobody asked for', async () => {
    const home = await seedHome()
    const result = runCli(['sessions', '--format', 'json', '--period', '30days', '--exclude', '/Users/gone/apps'], home)

    expect(result.stderr).toContain('no project in this period matches /Users/gone/apps')
    // The run still reports: the warning is advisory, not a failure.
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toHaveLength(2)
  })

  it('stays quiet when the pattern selects something, and for a loose word', async () => {
    const home = await seedHome()

    const rooted = runCli(['sessions', '--format', 'json', '--period', '30days', '--exclude', '/Users/gone/app'], home)
    expect(rooted.stderr).not.toContain('no project in this period matches')

    // A plain word is a substring by design, so it is never a typo signal.
    const loose = runCli(['sessions', '--format', 'json', '--period', '30days', '--exclude', 'nothing-like-this'], home)
    expect(loose.stderr).not.toContain('no project in this period matches')
  })

  it('does not contradict a total the same command prints', async () => {
    const home = await seedHomeWithOlderSessions()
    // `status` builds today and then month. Judged on the today pass alone, the
    // pattern looks unmatched while the month total beside it is that project's.
    const result = runCli(['status', '--format', 'json', '--project', '/Users/gone/app'], home)

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout).month.cost).toBeGreaterThan(0)
    expect(result.stderr).not.toContain('no project in this period matches')

    const typo = runCli(['status', '--format', 'json', '--project', '/Users/gone/apps'], home)
    expect(typo.stderr).toContain('no project in this period matches /Users/gone/apps')
  })

  it('stays quiet for a project only the day cache still bills', async () => {
    const home = await seedDayCacheOnly()
    // The sources expired, so the live parse cannot see this project; the cache
    // can, and it is what the totals are built from. Every command has to agree.
    const durable = runCli(['overview', '--period', '30days', '--project', SIBLINGS[0]!.cwd, '--no-color'], home)
    expect(durable.stderr).not.toContain('no project in this period matches')
    expect(durable.stdout).toContain('30.00')

    const live = runCli(['sessions', '--format', 'json', '--period', '30days', '--project', SIBLINGS[0]!.cwd], home)
    expect(live.status).toBe(0)
    expect(live.stderr).not.toContain('no project in this period matches')

    const typo = runCli(['sessions', '--format', 'json', '--period', '30days', '--project', `${SIBLINGS[0]!.cwd}s`], home)
    expect(typo.stderr).toContain(`no project in this period matches ${SIBLINGS[0]!.cwd}s`)
  })

  it('reports from web too, before the server starts', async () => {
    const home = await seedHome()

    const typo = await runServerCli(['web', '--no-open', '--port', '0', '--period', '30days', '--project', '/Users/gone/apps'], home)
    expect(typo).toContain('no project in this period matches /Users/gone/apps')

    const named = await runServerCli(['web', '--no-open', '--port', '0', '--period', '30days', '--project', '/Users/gone/app'], home)
    expect(named).not.toContain('no project in this period matches')
  })

  it('reports a quoted ~ pattern the shell never expanded', async () => {
    const home = await seedHome()
    // The README tells people to quote it, and a pattern field has no shell.
    const result = runCli(['sessions', '--format', 'json', '--period', '30days', '--project', '~/nowhere'], home)
    expect(result.stderr).toContain('no project in this period matches ~/nowhere')
  })

  it('judges each pattern on its own, against the list before any filtering', async () => {
    const home = await seedHome()

    // The second --project selects a project the first one also covers. Judged
    // inside the filter, `some()` would stop at the first and call it unmatched.
    const overlapping = runCli([
      'sessions', '--format', 'json', '--period', '30days',
      '--project', '/Users/gone/app', '--project', '/Users/gone/app/sub',
    ], home)
    expect(overlapping.stderr).toContain('/Users/gone/app/sub')
    expect(overlapping.stderr).not.toContain('matches /Users/gone/app (')

    // And an --exclude must not be judged against what --project already removed.
    const both = runCli([
      'sessions', '--format', 'json', '--period', '30days',
      '--project', '/Users/gone/app', '--exclude', '/Users/gone/app-kit',
    ], home)
    expect(both.stderr).not.toContain('no project in this period matches')
  })
})

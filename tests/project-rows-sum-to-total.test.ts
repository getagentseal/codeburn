import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'fs/promises'
import { homedir, tmpdir } from 'os'
import { join } from 'path'

import { loadPricing } from '../src/models.js'
import { clearSessionCache } from '../src/parser.js'
import { buildDurablePeriod, buildPayloadProjects } from '../src/usage-aggregator.js'
import type { DateRange } from '../src/types.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'project-rows-sum-'))
  process.env['CLAUDE_CONFIG_DIR'] = join(tmpDir, 'claude')
  process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] = join(tmpDir, 'desktop-sessions')
  process.env['CODEBURN_CACHE_DIR'] = join(tmpDir, 'cache')
  clearSessionCache()
  await loadPricing()
})

afterEach(async () => {
  clearSessionCache()
  await rm(join(homedir(), '.cursor'), { recursive: true, force: true })
  await rm(tmpDir, { recursive: true, force: true })
})

const now = new Date()
const local = (daysAgo: number, h = 0, m = 0) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, h, m)

const user = (sid: string, cwd: string, ts: Date) => JSON.stringify({
  type: 'user', sessionId: sid, timestamp: ts.toISOString(), cwd, message: { role: 'user', content: 'do the thing' },
})
const assistant = (sid: string, id: string, cwd: string, ts: Date, input: number) => JSON.stringify({
  type: 'assistant', sessionId: sid, timestamp: ts.toISOString(), cwd,
  message: { id, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], usage: { input_tokens: input, output_tokens: 0 } },
})

async function writeClaudeSession(sid: string, cwd: string, lines: string[], mtime: Date): Promise<void> {
  const dir = join(tmpDir, 'claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${sid}.jsonl`)
  await writeFile(file, lines.join('\n') + '\n')
  await utimes(file, mtime, mtime)
}

// Same construction as the report JSON's project list in main.ts.
async function payload(range: DateRange) {
  clearSessionCache()
  const durable = await buildDurablePeriod({ range, label: 'p' }, { provider: 'all' })
  const projects = buildPayloadProjects(durable.liveProjects, durable.days, homedir())
  const projectSum = projects.reduce((s, x) => s + x.cost, 0)
  return { total: durable.data.cost, projectSum }
}

describe('project rows sum to the period total', () => {
  it('a deleted linked worktree double counts its sealed calls in project rows', async () => {
    const main = join(tmpDir, 'src', 'app')
    const wt = join(tmpDir, 'src', 'app-wt')
    await mkdir(join(main, '.git', 'worktrees', 'app-wt'), { recursive: true })
    await mkdir(wt, { recursive: true })
    await writeFile(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'app-wt')}\n`)

    // Outside the 7-day reseal window, so the sealed day stays frozen.
    const t = (h: number, m: number) => local(10, h, m)
    await writeClaudeSession('s1', wt, [
      user('s1', wt, t(12, 0)),
      assistant('s1', 'm1', wt, t(12, 1), 1_000_000),
      assistant('s1', 'm2', wt, t(12, 2), 2_000_000),
    ], t(12, 2))
    const range: DateRange = { start: local(12), end: now }

    const before = await payload(range)
    expect(before.total).toBeCloseTo(9, 6)
    expect(before.projectSum).toBeCloseTo(before.total, 6)

    await rm(wt, { recursive: true, force: true })
    const after = await payload(range)
    expect(after.total).toBeCloseTo(9, 6)
    expect(after.projectSum).toBeCloseTo(after.total, 6)
  })

  it('a cursor-agent bare folder name double counts in a ranged run', async () => {
    // A Claude session in .../providers 20 days ago, a cursor-agent session in
    // a folder with the same basename 10 days ago. The daily cache's backfill
    // parse sees both and attaches the cursor-agent label to the Claude path;
    // a ranged run that excludes the Claude day leaves it a bare label.
    const providersDir = join(tmpDir, 'repo', 'app', 'providers')
    await mkdir(providersDir, { recursive: true })
    const t0 = local(20, 12, 0)
    await writeClaudeSession('s2', providersDir, [
      user('s2', providersDir, t0),
      assistant('s2', 'm1', providersDir, local(20, 12, 1), 1_000_000),
    ], local(20, 12, 1))

    const agentDir = join(homedir(), '.cursor', 'projects', providersDir.replace(/[^a-zA-Z0-9]/g, '-'), 'agent-transcripts')
    await mkdir(agentDir, { recursive: true })
    const agentFile = join(agentDir, 'ca1.txt')
    await writeFile(agentFile, `user:\n<user_query>question</user_query>\nA:\nanswer ${'x'.repeat(4000)}\n`)
    const at = local(10, 12, 0)
    await utimes(agentFile, at, at)

    const ranged = await payload({ start: local(12), end: now })
    expect(ranged.total).toBeGreaterThan(0)
    expect(ranged.projectSum).toBeCloseTo(ranged.total, 6)
  })
})

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import { getDateRange } from '../src/cli-date.js'

const CLI_TIMEOUT_MS = 30_000

function runCli(args: string[], home: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      HOME: home,
      USERPROFILE: home,
      HOMEPATH: home,
      HOMEDRIVE: '',
      TZ: 'UTC',
    },
    encoding: 'utf-8',
    timeout: CLI_TIMEOUT_MS,
  })
}

async function readConfig(home: string): Promise<{ budget?: { daily?: number; weekly?: number; monthly?: number } }> {
  const raw = await readFile(join(home, '.config', 'codeburn', 'config.json'), 'utf-8')
  return JSON.parse(raw) as { budget?: { daily?: number; weekly?: number; monthly?: number } }
}

function timestampFromDate(date: Date, offsetMinutes = 0): string {
  return new Date(date.getTime() + offsetMinutes * 60_000)
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
}

function currentMonthTimestamp(offsetMinutes: number): string {
  const now = new Date()
  const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12, 0, 0))
  return timestampFromDate(base, offsetMinutes)
}

function userLine(sessionId: string, timestamp: string): string {
  return JSON.stringify({
    type: 'user',
    sessionId,
    timestamp,
    cwd: '/tmp/codeburn-budget-app',
    message: { role: 'user', content: 'ship budget check' },
  })
}

function assistantLine(sessionId: string, timestamp: string): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId,
    timestamp,
    cwd: '/tmp/codeburn-budget-app',
    message: {
      id: `msg-${sessionId}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'done' }],
      usage: {
        input_tokens: 1_000_000,
        output_tokens: 100_000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  })
}

async function seedClaudeSpend(home: string, opts: { sessionId: string; timestamp: string }): Promise<void> {
  const projectDir = join(home, '.claude', 'projects', 'budget-app')
  await mkdir(projectDir, { recursive: true })
  await writeFile(
    join(projectDir, `${opts.sessionId}.jsonl`),
    [
      userLine(opts.sessionId, opts.timestamp),
      assistantLine(opts.sessionId, timestampFromDate(new Date(opts.timestamp), 1)),
    ].join('\n') + '\n',
    'utf-8',
  )
}

async function seedCurrentMonthSpend(home: string): Promise<void> {
  await seedClaudeSpend(home, { sessionId: 'budget-session', timestamp: currentMonthTimestamp(0) })
}

describe('codeburn budget command', () => {
  it('saves, lists, and removes a monthly budget', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-cli-budget-'))
    try {
      const set = runCli(['budget', '--monthly', '123.45'], home)
      expect(set.status, `stderr: ${set.stderr}`).toBe(0)
      expect(set.stdout).toContain('monthly')

      const saved = await readConfig(home)
      expect(saved.budget?.monthly).toBe(123.45)

      const list = runCli(['budget', '--list'], home)
      expect(list.status).toBe(0)
      expect(list.stdout).toContain('monthly')
      expect(list.stdout).toContain('$123.45')

      const remove = runCli(['budget', '--remove', 'monthly'], home)
      expect(remove.status).toBe(0)

      const after = await readConfig(home)
      expect(after.budget).toBeUndefined()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, CLI_TIMEOUT_MS)

  it('rejects an invalid amount without writing a budget', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-cli-budget-'))
    try {
      const result = runCli(['budget', '--daily', '0'], home)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('--daily must be a finite number greater than 0')

      const list = runCli(['budget', '--list'], home)
      expect(list.status).toBe(0)
      expect(list.stdout).toContain('No budgets configured')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, CLI_TIMEOUT_MS)

  it('exits 1 when the current month is over budget', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-cli-budget-'))
    try {
      await seedCurrentMonthSpend(home)
      expect(runCli(['budget', '--monthly', '0.01'], home).status).toBe(0)

      const result = runCli(['budget', '--check'], home)
      expect(result.status, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(1)
      expect(result.stdout).toContain('monthly:')
      expect(result.stdout).toContain('[OVER]')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, CLI_TIMEOUT_MS)

  it('floors a 99.x percent budget check without reporting over', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-cli-budget-'))
    try {
      await seedCurrentMonthSpend(home)
      expect(runCli(['budget', '--monthly', '4.52'], home).status).toBe(0)

      const result = runCli(['budget', '--check'], home)
      expect(result.status, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0)
      expect(result.stdout).toContain('(99%) [WARN]')
      expect(result.stdout).not.toContain('(100%)')
      expect(result.stdout).not.toContain('[OVER]')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, CLI_TIMEOUT_MS)

  it('exits 0 when the current month is under budget or no budget is configured', async () => {
    const noneHome = await mkdtemp(join(tmpdir(), 'codeburn-cli-budget-'))
    const underHome = await mkdtemp(join(tmpdir(), 'codeburn-cli-budget-'))
    try {
      const none = runCli(['budget', '--check'], noneHome)
      expect(none.status).toBe(0)
      expect(none.stdout).toContain('No budgets configured')

      await seedCurrentMonthSpend(underHome)
      expect(runCli(['budget', '--monthly', '100000'], underHome).status).toBe(0)

      const under = runCli(['budget', '--check'], underHome)
      expect(under.status, `stdout: ${under.stdout}\nstderr: ${under.stderr}`).toBe(0)
      expect(under.stdout).toContain('monthly:')
      expect(under.stdout).toContain('[OK]')
    } finally {
      await rm(noneHome, { recursive: true, force: true })
      await rm(underHome, { recursive: true, force: true })
    }
  }, CLI_TIMEOUT_MS)

  it('keeps overview budget lines only on unfiltered overviews', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-cli-budget-'))
    try {
      await seedCurrentMonthSpend(home)
      expect(runCli(['budget', '--monthly', '100000'], home).status).toBe(0)

      const unfiltered = runCli(['overview', '-p', 'month', '--no-color'], home)
      expect(unfiltered.status, `stdout: ${unfiltered.stdout}\nstderr: ${unfiltered.stderr}`).toBe(0)
      expect(unfiltered.stdout).toContain('Monthly budget:')

      for (const filterArgs of [
        ['--provider', 'claude'],
        ['--project', 'budget-app'],
        ['--exclude', 'not-the-budget-app'],
      ]) {
        const filtered = runCli(['overview', '-p', 'month', '--no-color', ...filterArgs], home)
        expect(filtered.status, `args: ${filterArgs.join(' ')}\nstdout: ${filtered.stdout}\nstderr: ${filtered.stderr}`).toBe(0)
        expect(filtered.stdout).toContain('Totals')
        expect(filtered.stdout).not.toMatch(/\b(?:Daily|Weekly|Monthly) budget:/)
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, CLI_TIMEOUT_MS)

  it('uses the same weekly spend window for budget --check and overview -p week', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-cli-budget-'))
    try {
      const weekStart = getDateRange('week').range.start
      await seedClaudeSpend(home, {
        sessionId: 'weekly-boundary-session',
        timestamp: timestampFromDate(weekStart, 1),
      })
      expect(runCli(['budget', '--weekly', '100000'], home).status).toBe(0)

      const overview = runCli(['overview', '-p', 'week', '--no-color'], home)
      expect(overview.status, `stdout: ${overview.stdout}\nstderr: ${overview.stderr}`).toBe(0)
      const overviewSpent = overview.stdout.match(/Weekly budget: (\$[0-9,]+\.\d{2}) of/)
      expect(overviewSpent?.[1]).toBeDefined()
      expect(overviewSpent?.[1]).not.toBe('$0.00')

      const check = runCli(['budget', '--check'], home)
      expect(check.status, `stdout: ${check.stdout}\nstderr: ${check.stderr}`).toBe(0)
      const checkSpent = check.stdout.match(/weekly:\s+(\$[0-9,]+\.\d{2}) of/)
      expect(checkSpent?.[1]).toBe(overviewSpent?.[1])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, CLI_TIMEOUT_MS)
})

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { validateDesktopProjectId } from '../src/project-scope.js'
import { SERVED_DESKTOP_REPORT_COMMANDS, serveAllows } from '../src/serve.js'

vi.setConfig({ testTimeout: 60_000 })

const RANGE = { from: '2026-09-01', to: '2026-09-07' }
const ALPHA = 'path:/work/alpha'

let homes: string[] = []

afterEach(async () => {
  while (homes.length > 0) {
    const home = homes.pop()
    if (home) await rm(home, { recursive: true, force: true })
  }
})

function runCli(args: string[], home: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      CODEBURN_CACHE_DIR: join(home, '.cache', 'codeburn'),
      CODEX_HOME: join(home, 'no-codex'),
      HERMES_HOME: join(home, 'no-hermes'),
      TZ: 'UTC',
    },
    encoding: 'utf-8',
    timeout: 60_000,
  })
}

function userLine(sessionId: string, cwd: string, timestamp: string): string {
  return JSON.stringify({
    type: 'user',
    sessionId,
    cwd,
    timestamp,
    message: { role: 'user', content: 'implement this feature' },
  })
}

function assistantLine(
  sessionId: string,
  cwd: string,
  timestamp: string,
  messageId: string,
  model: string,
  toolName = 'Edit',
  input: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId,
    cwd,
    timestamp,
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'tool_use', id: `${messageId}-tool`, name: toolName, input }],
      usage: { input_tokens: 1_000, output_tokens: 100 },
    },
  })
}

async function seedHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'codeburn-desktop-scope-'))
  homes.push(home)
  const alphaDir = join(home, '.claude', 'projects', '-work-alpha')
  const betaDir = join(home, '.claude', 'projects', '-work-beta')
  await mkdir(alphaDir, { recursive: true })
  await mkdir(betaDir, { recursive: true })
  await writeFile(join(alphaDir, 'alpha.jsonl'), [
    userLine('alpha', '/work/alpha', '2026-09-02T10:00:00.000Z'),
    assistantLine('alpha', '/work/alpha', '2026-09-02T10:01:00.000Z', 'alpha-a', 'claude-sonnet-4-5'),
    userLine('alpha', '/work/alpha', '2026-09-03T10:00:00.000Z'),
    assistantLine('alpha', '/work/alpha', '2026-09-03T10:01:00.000Z', 'alpha-b', 'claude-opus-4-5'),
    assistantLine('alpha', '/work/alpha', '2026-09-03T10:02:00.000Z', 'alpha-read-1', 'claude-sonnet-4-5', 'Read', { file_path: '/work/alpha/node_modules/one.js' }),
    assistantLine('alpha', '/work/alpha', '2026-09-03T10:03:00.000Z', 'alpha-read-2', 'claude-sonnet-4-5', 'Read', { file_path: '/work/alpha/node_modules/two.js' }),
    assistantLine('alpha', '/work/alpha', '2026-09-03T10:04:00.000Z', 'alpha-read-3', 'claude-sonnet-4-5', 'Read', { file_path: '/work/alpha/node_modules/three.js' }),
  ].join('\n') + '\n', 'utf-8')
  await writeFile(join(betaDir, 'beta.jsonl'), [
    userLine('beta', '/work/beta', '2026-09-03T10:00:00.000Z'),
    assistantLine('beta', '/work/beta', '2026-09-03T10:01:00.000Z', 'beta-a', 'claude-opus-4-5'),
  ].join('\n') + '\n', 'utf-8')
  return home
}

async function seedComparePeriodsHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'codeburn-desktop-periods-'))
  homes.push(home)
  const alphaDir = join(home, '.claude', 'projects', '-work-alpha')
  const betaDir = join(home, '.claude', 'projects', '-work-beta')
  await mkdir(alphaDir, { recursive: true })
  await mkdir(betaDir, { recursive: true })
  await writeFile(join(alphaDir, 'alpha.jsonl'), [
    userLine('alpha', '/work/alpha', '2026-09-01T10:00:00.000Z'),
    assistantLine('alpha', '/work/alpha', '2026-09-01T10:01:00.000Z', 'alpha-a', 'claude-sonnet-4-5'),
    userLine('alpha', '/work/alpha', '2026-09-08T10:00:00.000Z'),
    assistantLine('alpha', '/work/alpha', '2026-09-08T10:01:00.000Z', 'alpha-b', 'claude-sonnet-4-5'),
  ].join('\n') + '\n', 'utf-8')
  await writeFile(join(betaDir, 'beta.jsonl'), [
    userLine('beta', '/work/beta', '2026-09-01T10:00:00.000Z'),
    assistantLine('beta', '/work/beta', '2026-09-01T10:01:00.000Z', 'beta-a', 'claude-opus-4-5'),
    userLine('beta', '/work/beta', '2026-09-08T10:00:00.000Z'),
    assistantLine('beta', '/work/beta', '2026-09-08T10:01:00.000Z', 'beta-b', 'claude-opus-4-5'),
  ].join('\n') + '\n', 'utf-8')
  return home
}

function buildStatusArgv(options: { desktopProjectId?: string }): string[] {
  let desktopProjectId: string | undefined
  if (options.desktopProjectId !== undefined) {
    try {
      desktopProjectId = validateDesktopProjectId(options.desktopProjectId)
    } catch {
      throw new Error('invalid Desktop project id')
    }
  }
  return [
    'status', '--format', 'json', '--period', 'lifetime',
    ...(desktopProjectId === undefined ? [] : [`--desktop-project-id=${desktopProjectId}`]),
  ]
}

function reportQuery(command: 'compare' | 'yield', options: { from: string; to: string; desktopProjectId: string }, home: string): Record<string, any> {
  const result = runCli([
    command,
    '--format', 'json',
    '--from', options.from,
    '--to', options.to,
    `--desktop-project-id=${options.desktopProjectId}`,
    ...(command === 'compare' ? ['--model-a', 'claude-sonnet-4-5', '--model-b', 'claude-opus-4-5'] : []),
  ], home)
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout) as Record<string, any>
}

function publicHelp(command: string, home: string): string {
  const result = runCli([command, '--help'], home)
  expect(result.status, result.stderr).toBe(0)
  return result.stdout
}

describe('Feature: hidden Desktop project scope CLI transport', () => {
  it('Scenario: an attached path identity reaches status without becoming two argv tokens', async () => {
    const home = await seedHome()
    const argv = buildStatusArgv({ desktopProjectId: ALPHA })
    expect(argv).toContain('--desktop-project-id=path:/work/alpha')
    const result = runCli(argv, home)
    expect(result.status, result.stderr).toBe(0)
  })

  it('Scenario: a dash-leading identity stays a value in the hidden option', async () => {
    const home = await seedHome()
    const argv = buildStatusArgv({ desktopProjectId: 'label:-alpha' })
    expect(argv).toContain('--desktop-project-id=label:-alpha')
    const result = runCli(argv, home)
    expect(result.status, result.stderr).toBe(0)
  })

  it('Scenario: malformed or NUL-containing IDs fail before argv construction', () => {
    expect(() => buildStatusArgv({ desktopProjectId: '' })).toThrow(/invalid Desktop project id/)
    expect(() => buildStatusArgv({ desktopProjectId: 'path:\u0000alpha' })).toThrow(/invalid Desktop project id/)
  })

  it('Scenario: hidden Desktop scope is accepted by every served report path', () => {
    for (const command of SERVED_DESKTOP_REPORT_COMMANDS) expect(serveAllows(command, ALPHA)).toBe(true)
    expect(SERVED_DESKTOP_REPORT_COMMANDS).toContain('spend --format branch-json')
    expect(serveAllows('status --format json --desktop-project-id -alpha')).toBe(false)
    expect(serveAllows('report --format json --period lifetime --desktop-project-catalog')).toBe(true)
  })

  it('Scenario: Optimize, Audit, Spend flow/branch, and Yield all honor one hidden identity', async () => {
    const home = await seedHome()
    const cases = [
      ['optimize', '--format', 'json', '--period', 'all'],
      ['audit', '--format', 'json', '--period', 'all'],
      ['spend', '--format', 'flow-json', '--period', 'all'],
      ['spend', '--format', 'branch-json', '--period', 'all'],
      ['yield', '--format', 'json', '--period', 'all'],
    ] as const

    for (const args of cases) {
      const result = runCli([...args, `--desktop-project-id=${ALPHA}`], home)
      expect(result.status, `${args[0]}: ${result.stderr}`).toBe(0)
      const parsed = JSON.parse(result.stdout) as any
      if (args[0] === 'optimize') {
        expect(parsed.summary.periodCostUSD).toBeGreaterThan(0)
        expect(parsed.summary.sessions).toBeGreaterThan(0)
        expect(parsed.summary.calls).toBeGreaterThan(0)
        expect(parsed.findings.some((finding: any) => finding.projectId === ALPHA)).toBe(true)
        expect(parsed.findings.every((finding: any) => finding.projectId === undefined || finding.projectId === ALPHA)).toBe(true)
      } else if (args[0] === 'audit') {
        expect(parsed.length).toBeGreaterThan(0)
        expect(parsed.reduce((sum: number, row: any) => sum + row.calls, 0)).toBe(5)
        expect(parsed.find((row: any) => row.model === 'claude-sonnet-4-5')?.calls).toBe(4)
      } else if (args[0] === 'spend' && args[1] === '--format' && args[2] === 'flow-json') {
        const alphaProject = parsed.projects.find((project: any) => project.id === '/work/alpha')
        expect(alphaProject).toMatchObject({ id: '/work/alpha' })
        expect(alphaProject.cost).toBeGreaterThan(0)
        expect(parsed.links.some((link: any) => link.project === '/work/alpha')).toBe(true)
      } else if (args[0] === 'spend') {
        const alphaProject = parsed.projects.find((project: any) => project.id === '/work/alpha')
        expect(alphaProject).toMatchObject({ id: '/work/alpha' })
        expect(alphaProject.totalCost).toBeGreaterThan(0)
        expect(alphaProject.coverage.noBranchDataCost).toBeGreaterThan(0)
      } else {
        expect(parsed.summary.total.costUSD).toBeGreaterThan(0)
        expect(parsed.details.length).toBeGreaterThan(0)
        expect(parsed.details.every((detail: any) => detail.project === '-work-alpha')).toBe(true)
      }
      expect(JSON.stringify(parsed)).not.toContain('-work-beta')
    }
  })

  it('Scenario: resident serve rejects writes and unsupported administrative commands', () => {
    expect(serveAllows('optimize --format json --apply', ALPHA)).toBe(false)
    expect(serveAllows('audit --format json --write', ALPHA)).toBe(false)
    expect(serveAllows('spend --format branch-json --apply', ALPHA)).toBe(false)
    expect(serveAllows('yield --format json --refresh', ALPHA)).toBe(false)
    expect(serveAllows('act report --json', ALPHA)).toBe(false)
    expect(serveAllows('currency EUR', ALPHA)).toBe(false)
  })

  it('Scenario: hidden scope options stay out of every public report help surface', async () => {
    const home = await seedHome()
    for (const command of ['report', 'status', 'models', 'sessions', 'compare', 'compare-periods', 'spend', 'yield', 'optimize', 'audit']) {
      expect(publicHelp(command, home), command).not.toContain('--desktop-project-id')
    }
  })

  it('Scenario: Combined plus hidden Desktop scope is rejected by CLI and serve', async () => {
    const home = await seedHome()
    const cli = runCli(['status', '--format', 'json', '--scope', 'combined', `--desktop-project-id=${ALPHA}`], home)
    expect(cli.status).not.toBe(0)
    expect(cli.stderr).toMatch(/Combined/)
    expect(serveAllows('status --format json --scope combined', ALPHA)).toBe(false)
  })

  it('Scenario: public cohort --project-id remains repeatable and intersects hidden scope', async () => {
    const home = await seedHome()
    const result = runCli([
      'compare', '--format', 'cohort-json', '--period', 'all',
      '--model-a', 'claude-sonnet-4-5', '--model-b', 'claude-opus-4-5',
      '--project-id=/work/alpha', '--project-id=/work/beta',
      `--desktop-project-id=${ALPHA}`,
    ], home)
    expect(result.status, result.stderr).toBe(0)
    const report = JSON.parse(result.stdout) as { selection: { projects: string[] } }
    expect(report.selection.projects).toEqual(['-work-alpha'])
  })

  it('Scenario: classic Compare and Yield preserve custom ranges under hidden scope', async () => {
    const home = await seedHome()
    const compare = reportQuery('compare', { ...RANGE, desktopProjectId: ALPHA }, home)
    expect(compare.period).toMatchObject({ label: '2026-09-01 to 2026-09-07' })
    const yielded = reportQuery('yield', { ...RANGE, desktopProjectId: ALPHA }, home)
    expect(yielded.period).toMatchObject({
      start: '2026-09-01T00:00:00.000Z',
      end: '2026-09-07T23:59:59.999Z',
    })
  })

  it('Scenario: Compare Periods sends one hidden identity through A/B/history/drill-down', async () => {
    const home = await seedComparePeriodsHome()
    const args = [
      'compare-periods', '--format', 'json',
      '--from-a', '2026-09-01', '--to-a', '2026-09-01',
      '--from-b', '2026-09-08', '--to-b', '2026-09-08',
      `--desktop-project-id=${ALPHA}`,
    ]
    const reportResult = runCli(args, home)
    expect(reportResult.status, reportResult.stderr).toBe(0)
    const report = JSON.parse(reportResult.stdout) as {
      history: { basis: string }
      projects: Array<{ key: string }>
    }
    expect(report.projects).toHaveLength(1)
    expect(report.projects[0]!.key).toBe(ALPHA)
    expect(report.history.basis).toContain('Totals come from parsed session transcripts')

    const drill = runCli([
      'compare-periods', '--format', 'sessions',
      '--from-a', '2026-09-01', '--to-a', '2026-09-01',
      '--from-b', '2026-09-08', '--to-b', '2026-09-08',
      `--desktop-project-id=${ALPHA}`,
      '--dimension', 'project', '--key', ALPHA,
    ], home)
    expect(drill.status, drill.stderr).toBe(0)
    const sessions = JSON.parse(drill.stdout) as { sessions: Array<{ project: string }> }
    expect(sessions.sessions).toHaveLength(1)
    expect(sessions.sessions[0]!.project).toBe('-work-alpha')
  })

  it('Scenario: the lifetime catalog is internal and absent from public help text', async () => {
    const home = await seedHome()
    const result = runCli(['report', '--format', 'json', '--period', 'lifetime', '--desktop-project-catalog', '--exclude', 'beta'], home)
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      options: [{ id: ALPHA }],
    })
    expect(publicHelp('report', home)).not.toContain('--desktop-project-catalog')

    const rejected = runCli([
      'report', '--format', 'json', '--period', 'lifetime',
      '--desktop-project-catalog', `--desktop-project-id=${ALPHA}`,
    ], home)
    expect(rejected.status).not.toBe(0)
    expect(rejected.stderr).toContain('cannot be combined')
  })
})

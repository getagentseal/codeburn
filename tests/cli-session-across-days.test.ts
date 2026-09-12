import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { CLEARED, REDIRECTED } from './setup/env-isolation-vars.js'

function runCli(args: string[], home: string) {
  const env = { ...process.env }
  delete env.FORCE_COLOR
  env.NO_COLOR = '1'
  for (const key of CLEARED) delete env[key]
  for (const key of REDIRECTED) env[key] = home
  env.CLAUDE_CONFIG_DIR = join(home, '.claude')
  env.CODEBURN_CACHE_DIR = join(home, '.cache', 'codeburn')
  env.CODEBURN_DESKTOP_SESSIONS_DIR = join(home, 'desktop-sessions')
  env.TZ = 'UTC'
  env.CODEBURN_PRICING_SNAPSHOT_ONLY = '1'
  env.CODEBURN_FX_NO_FETCH = '1'
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env,
    encoding: 'utf-8',
    timeout: 60_000,
  })
}

describe('codeburn status counts a session that spans days', () => {
  it('one real session spanning two days is one period project session', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-session-across-days-'))
    try {
      const cwd = '/tmp/same-session-project'
      const sessionId = 'same-actual-session'
      const projectDir = join(home, '.claude', 'projects', 'project-a')
      await mkdir(projectDir, { recursive: true })

      const now = new Date(Date.now() - 60_000)
      const older = new Date(now.getTime() - 5 * 86_400_000)
      const rows = [older, now].flatMap((date, index) => [
        {
          type: 'user',
          sessionId,
          timestamp: date.toISOString(),
          cwd,
          message: { role: 'user', content: `task${index}` },
        },
        {
          type: 'assistant',
          sessionId,
          timestamp: date.toISOString(),
          cwd,
          message: {
            id: `response${index}`,
            role: 'assistant',
            model: 'claude-sonnet-4-5',
            content: [{ type: 'text', text: 'done' }],
            usage: {
              input_tokens: 1000,
              output_tokens: 200,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        },
      ])
      await writeFile(join(projectDir, `${sessionId}.jsonl`), `${rows.map(row => JSON.stringify(row)).join('\n')}\n`)

      // Warm the daily cache the same way a real CLI user would, then read the
      // menubar payload. Occupancy on two days must still be one session.
      const models = runCli(['models', '--format', 'json', '--period', 'week'], home)
      expect(models.status, models.stderr).toBe(0)
      JSON.parse(models.stdout)

      const result = runCli([
        'status',
        '--format', 'menubar-json',
        '--period', 'week',
        '--provider', 'claude',
        '--no-timeline',
      ], home)
      expect(result.status, result.stderr).toBe(0)

      const json = JSON.parse(result.stdout) as {
        current: {
          topProjects: Array<{ id?: string; sessions: number; sessionDetails: unknown[] }>
        }
      }
      const row = json.current.topProjects.find(project => project.id === cwd)
      expect(row.sessionDetails).toHaveLength(1)
      expect(row.sessions).toBe(1)

      const report = runCli(['report', '--format', 'json', '--period', 'week', '--provider', 'claude'], home)
      expect(report.status, report.stderr).toBe(0)
      const exported = JSON.parse(report.stdout) as {
        overview: { sessionCountBasis?: string }
        projects: Array<{ path?: string; sessions: number; sessionCountBasis?: string; avgCostPerSession?: number }>
      }
      const exportedRow = exported.projects.find(project => project.path === cwd)!
      expect(exported.overview.sessionCountBasis).toBe('partial')
      expect(exportedRow.sessions).toBe(1)
      expect(exportedRow.sessionCountBasis).toBe('partial')
      expect(exportedRow.avgCostPerSession).toBeUndefined()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, 120_000)
})

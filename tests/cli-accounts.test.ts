import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

async function createClaudeSession(configDir: string, project: string, sessionId: string, timestamp: string): Promise<void> {
  const projectDir = join(configDir, 'projects', project)
  await mkdir(projectDir, { recursive: true })
  const filePath = join(projectDir, `${sessionId}.jsonl`)
  await writeFile(filePath, JSON.stringify({
    type: 'assistant',
    sessionId,
    timestamp,
    cwd: project.replace(/-/g, '/'),
    message: {
      id: `msg-${sessionId}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
      },
    },
  }) + '\n')
  const mtime = new Date(timestamp)
  await utimes(filePath, mtime, mtime)
}

function runCli(args: string[], home: string, extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_CONFIG_DIR: '',
      ...extraEnv,
    },
    encoding: 'utf-8',
  })
}

describe('codeburn accounts command', () => {
  it('configures subscription metadata and reports filtered account rollups', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-cli-accounts-'))
    const workDir = join(home, 'claude-work')
    const personalDir = join(home, 'claude-personal')

    try {
      await createClaudeSession(workDir, '-Users-alice-work-app', 'work-session', '2099-04-20T10:00:00.000Z')
      await createClaudeSession(personalDir, '-Users-alice-work-app', 'personal-session', '2099-04-20T11:00:00.000Z')

      const setResult = runCli(['accounts', 'set', 'Work', '--plan', 'Claude Max', '--monthly-usd', '100', '--budget-usd', '0.001'], home)
      expect(setResult.status).toBe(0)
      expect(setResult.stdout).toContain('Budget: USD 0.001/month')

      const config = JSON.parse(await readFile(join(home, '.config', 'codeburn', 'config.json'), 'utf-8')) as {
        accounts?: Record<string, { plan?: string; monthlyUsd?: number; budgetUsd?: number }>
      }
      expect(config.accounts?.work).toMatchObject({ plan: 'Claude Max', monthlyUsd: 100, budgetUsd: 0.001 })

      const result = runCli([
        'accounts',
        'work',
        '--format',
        'json',
        '--provider',
        'claude',
        '--account',
        'claude-work',
        '--from',
        '2099-04-20',
        '--to',
        '2099-04-20',
      ], home, {
        CLAUDE_CONFIG_DIRS: `${workDir}:${personalDir}`,
      })

      expect(result.status).toBe(0)
      const payload = JSON.parse(result.stdout) as {
        accounts: Array<{ name: string; plan?: string; sessions: number; budgetUtilizationPercent?: number | null }>
        risks: Array<{ type: string }>
      }
      expect(payload.accounts.map(a => a.name)).toEqual(['work'])
      expect(payload.accounts[0]).toMatchObject({ name: 'work', plan: 'Claude Max', sessions: 1 })
      expect(payload.accounts[0]!.budgetUtilizationPercent).toBeGreaterThan(100)
      expect(payload.risks.map(r => r.type)).toContain('over-budget')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, 15_000)
})

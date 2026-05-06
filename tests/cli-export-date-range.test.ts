import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

function runCli(args: string[], home: string, extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      HOME: home,
      TZ: 'UTC',
      ...extraEnv,
    },
    encoding: 'utf-8',
  })
}

function userLine(sessionId: string, timestamp: string): string {
  return JSON.stringify({
    type: 'user',
    sessionId,
    timestamp,
    message: { role: 'user', content: 'add feature' },
  })
}

function assistantLine(sessionId: string, timestamp: string, messageId: string): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId,
    timestamp,
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'done' }],
      usage: {
        input_tokens: 1000,
        output_tokens: 100,
      },
    },
  })
}

describe('codeburn export custom date range', () => {
  it('exports a single custom period filtered by --from/--to and --account', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-cli-export-'))

    try {
      const workDir = join(home, 'claude-work')
      const personalDir = join(home, 'claude-personal')
      const configDir = join(home, '.config', 'codeburn')
      const projectDir = join(workDir, 'projects', 'app')
      const personalProjectDir = join(personalDir, 'projects', 'app')
      await mkdir(projectDir, { recursive: true })
      await mkdir(personalProjectDir, { recursive: true })
      await mkdir(configDir, { recursive: true })
      await writeFile(join(configDir, 'config.json'), JSON.stringify({
        accounts: {
          work: { plan: 'Claude Max', monthlyUsd: 100, budgetUsd: 50 },
        },
      }))
      await writeFile(
        join(projectDir, 'in-range.jsonl'),
        [
          userLine('in-range', '2026-04-10T09:00:00Z'),
          assistantLine('in-range', '2026-04-10T09:01:00Z', 'msg-in-range'),
        ].join('\n'),
      )
      await writeFile(
        join(projectDir, 'out-of-range.jsonl'),
        [
          userLine('out-of-range', '2026-04-11T09:00:00Z'),
          assistantLine('out-of-range', '2026-04-11T09:01:00Z', 'msg-out-of-range'),
        ].join('\n'),
      )
      await writeFile(
        join(personalProjectDir, 'personal-in-range.jsonl'),
        [
          userLine('personal-in-range', '2026-04-10T10:00:00Z'),
          assistantLine('personal-in-range', '2026-04-10T10:01:00Z', 'msg-personal-in-range'),
        ].join('\n'),
      )

      const outputPath = join(home, 'custom-export.json')
      const result = runCli([
        'export',
        '--format', 'json',
        '--from', '2026-04-10',
        '--to', '2026-04-10',
        '--provider', 'claude',
        '--account', 'claude-work',
        '--output', outputPath,
      ], home, {
        CLAUDE_CONFIG_DIR: '',
        CLAUDE_CONFIG_DIRS: `${workDir}:${personalDir}`,
      })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('Exported (2026-04-10 to 2026-04-10)')

      const exported = JSON.parse(await readFile(outputPath, 'utf-8')) as {
        summary: Array<{ Period: string; Sessions: number }>
        accounts: Array<{ Account: string; Plan?: string; 'Monthly USD'?: number }>
        sessions: Array<{ 'Session ID': string; Account?: string }>
      }
      expect(exported.summary).toHaveLength(1)
      expect(exported.summary[0]?.Period).toBe('2026-04-10 to 2026-04-10')
      expect(exported.summary[0]?.Sessions).toBe(1)
      expect(exported.accounts[0]).toMatchObject({ Account: 'work', Plan: 'Claude Max', 'Monthly USD': 100 })
      expect(exported.sessions.map(s => s['Session ID'])).toEqual(['in-range'])
      expect(exported.sessions[0]?.Account).toBe('work')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

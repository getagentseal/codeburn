import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

function runCli(args: string[], home: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), TZ: 'UTC' },
    encoding: 'utf-8',
    timeout: 30_000,
  })
}

function userLine(sessionId: string, timestamp: string): string {
  return JSON.stringify({
    type: 'user',
    sessionId,
    timestamp,
    message: { role: 'user', content: 'implement feature' },
  })
}

function assistantLine(sessionId: string, timestamp: string, messageId: string, model: string): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId,
    timestamp,
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text: 'done' }],
      usage: { input_tokens: 1000, output_tokens: 100 },
    },
  })
}

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'codeburn-cli-emitters-'))
  const projectDir = join(home, '.claude', 'projects', 'app')
  await mkdir(projectDir, { recursive: true })
  await writeFile(join(projectDir, 'session-a.jsonl'), [
    userLine('session-a', '2026-04-10T09:00:00Z'),
    assistantLine('session-a', '2026-04-10T09:01:00Z', 'msg-a', 'claude-sonnet-4-5'),
  ].join('\n'))
  await writeFile(join(projectDir, 'session-b.jsonl'), [
    userLine('session-b', '2026-04-10T10:00:00Z'),
    assistantLine('session-b', '2026-04-10T10:01:00Z', 'msg-b', 'claude-opus-4-5'),
  ].join('\n'))
  return home
}

describe('CLI JSON emitters', () => {
  it('emits compare list mode and full mode as JSON', async () => {
    const home = await makeHome()
    try {
      const listResult = runCli(['compare', '--format', 'json', '--period', 'all', '--provider', 'claude'], home)
      expect(listResult.status, listResult.stderr).toBe(0)
      const models = JSON.parse(listResult.stdout) as Array<{ model: string; selfCorrections: number }>
      expect(models.map(model => model.model)).toEqual(expect.arrayContaining(['claude-sonnet-4-5', 'claude-opus-4-5']))
      expect(models.every(model => typeof model.selfCorrections === 'number')).toBe(true)

      const fullResult = runCli([
        'compare', '--format', 'json', '--period', 'all', '--provider', 'claude',
        '--model-a', 'claude-sonnet-4-5', '--model-b', 'claude-opus-4-5',
      ], home)
      expect(fullResult.status, fullResult.stderr).toBe(0)
      const report = JSON.parse(fullResult.stdout)
      expect(Object.keys(report)).toEqual(['period', 'modelA', 'modelB', 'metrics', 'categories', 'workingStyle'])
      expect(report.period.provider).toBe('claude')
      expect(report.modelA.model).toBe('claude-sonnet-4-5')
      expect(report.modelB.model).toBe('claude-opus-4-5')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('emits flat session rows as JSON', async () => {
    const home = await makeHome()
    try {
      const result = runCli(['sessions', '--format', 'json', '--period', 'all', '--provider', 'claude'], home)
      expect(result.status, result.stderr).toBe(0)
      const rows = JSON.parse(result.stdout) as Array<Record<string, unknown>>
      expect(rows).toHaveLength(2)
      expect(Object.keys(rows[0]!)).toEqual([
        'sessionId', 'title', 'project', 'provider', 'models', 'cost', 'savingsUSD', 'calls', 'turns',
        'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens',
        'startedAt', 'endedAt', 'durationMs',
      ])
      expect(rows.every(row => row.provider === 'claude')).toBe(true)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

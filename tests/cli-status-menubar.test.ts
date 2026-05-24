import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

function runCli(args: string[], home: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      HOME: home,
      TZ: 'UTC',
    },
    encoding: 'utf-8',
    timeout: 30_000,
  })
}

function userLine(sessionId: string, timestamp: string): string {
  return JSON.stringify({
    type: 'user',
    sessionId,
    timestamp,
    message: { role: 'user', content: 'do the thing' },
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
      content: [
        { type: 'text', text: 'done' },
        { type: 'tool_use', id: 'tu-1', name: 'Edit', input: { file_path: '/tmp/x', old_string: 'a', new_string: 'b' } },
      ],
      usage: { input_tokens: 500, output_tokens: 50 },
    },
  })
}

describe('codeburn status --format menubar-json', () => {
  it('returns valid MenubarPayload with expected top-level fields', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-menubar-'))

    try {
      const projectDir = join(home, '.claude', 'projects', 'myapp')
      await mkdir(projectDir, { recursive: true })

      const now = new Date()
      const h = now.getUTCHours()
      const base = h >= 2 ? new Date(now.getTime() - 2 * 3600_000) : new Date(now.getTime() - h * 3600_000 - 300_000)
      const ts1 = base.toISOString().replace(/\.\d+Z$/, 'Z')
      const ts2 = new Date(base.getTime() + 60_000).toISOString().replace(/\.\d+Z$/, 'Z')
      const ts3 = new Date(base.getTime() + 120_000).toISOString().replace(/\.\d+Z$/, 'Z')
      const ts4 = new Date(base.getTime() + 180_000).toISOString().replace(/\.\d+Z$/, 'Z')

      await writeFile(
        join(projectDir, 'session.jsonl'),
        [
          userLine('s1', ts1),
          assistantLine('s1', ts2, 'msg-1'),
          userLine('s1', ts3),
          assistantLine('s1', ts4, 'msg-2'),
        ].join('\n'),
      )

      const result = runCli([
        'status',
        '--format', 'menubar-json',
        '--period', 'today',
        '--provider', 'all',
        '--no-optimize',
      ], home)

      expect(result.status, `stderr: ${result.stderr}`).toBe(0)

      const payload = JSON.parse(result.stdout) as Record<string, unknown>

      expect(payload).toHaveProperty('generated')
      expect(payload).toHaveProperty('current')
      expect(payload).toHaveProperty('optimize')
      expect(payload).toHaveProperty('history')

      const current = payload['current'] as Record<string, unknown>
      expect(current['cost']).toBeGreaterThan(0)
      expect(current['calls']).toBe(2)
      expect(current['sessions']).toBe(1)
      expect(current).toHaveProperty('oneShotRate')
      expect(current).toHaveProperty('topActivities')
      expect(current).toHaveProperty('topModels')
      expect(current).toHaveProperty('providers')

      const history = payload['history'] as { daily: unknown[] }
      expect(Array.isArray(history.daily)).toBe(true)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('filters menubar payloads to a selected review day with --day', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-menubar-day-'))

    try {
      const projectDir = join(home, '.claude', 'projects', 'myapp')
      await mkdir(projectDir, { recursive: true })

      await writeFile(
        join(projectDir, 'session.jsonl'),
        [
          userLine('before', '2026-04-09T23:58:00Z'),
          assistantLine('before', '2026-04-09T23:59:00Z', 'msg-before'),
          userLine('selected', '2026-04-10T11:59:00Z'),
          assistantLine('selected', '2026-04-10T12:00:00Z', 'msg-selected'),
          userLine('after', '2026-04-11T00:00:00Z'),
          assistantLine('after', '2026-04-11T00:01:00Z', 'msg-after'),
        ].join('\n'),
      )

      const result = runCli([
        'status',
        '--format', 'menubar-json',
        '--day', '2026-04-10',
        '--provider', 'all',
        '--no-optimize',
      ], home)

      expect(result.status, `stderr: ${result.stderr}`).toBe(0)

      const payload = JSON.parse(result.stdout) as {
        current: {
          label: string
          calls: number
          sessions: number
          topProjects: Array<{ sessions: number; sessionDetails: Array<{ date: string }> }>
        }
      }

      expect(payload.current.label).toBe('Day (2026-04-10)')
      expect(payload.current.calls).toBe(1)
      expect(payload.current.sessions).toBe(1)
      expect(payload.current.topProjects).toHaveLength(1)
      expect(payload.current.topProjects[0]?.sessions).toBe(1)
      expect(payload.current.topProjects[0]?.sessionDetails.map(s => s.date)).toEqual(['2026-04-10'])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

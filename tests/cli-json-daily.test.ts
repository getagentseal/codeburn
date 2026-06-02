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

function assistantEditLine(sessionId: string, timestamp: string, messageId: string): string {
  // Includes a tool_use of `Edit` so the parser flags this turn as hasEdits=true.
  // Single edit-turn with no retry (one assistant message in the turn) → counts
  // as one oneShotTurn.
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
        { type: 'text', text: 'editing' },
        { type: 'tool_use', id: 'tu-1', name: 'Edit', input: { file_path: '/tmp/x', old_string: 'a', new_string: 'b' } },
      ],
      usage: { input_tokens: 1000, output_tokens: 100 },
    },
  })
}

function assistantNoEditLine(sessionId: string, timestamp: string, messageId: string): string {
  // No edit tool — this turn does not count toward editTurns/oneShotTurns,
  // but does count toward `turns` and `calls`.
  return JSON.stringify({
    type: 'assistant',
    sessionId,
    timestamp,
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'just chatting' }],
      usage: { input_tokens: 200, output_tokens: 30 },
    },
  })
}

describe('codeburn report --format json daily[] one-shot fields (issue #279)', () => {
  it('exposes per-day turns / editTurns / oneShotTurns / oneShotRate', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-cli-json-daily-'))

    try {
      const projectDir = join(home, '.claude', 'projects', 'app')
      await mkdir(projectDir, { recursive: true })

      // Day 1 (2026-04-10): one edit-turn (one-shot), one chat-turn
      // Day 2 (2026-04-11): one edit-turn (one-shot)
      await writeFile(
        join(projectDir, 'session.jsonl'),
        [
          userLine('s1', '2026-04-10T09:00:00Z'),
          assistantEditLine('s1', '2026-04-10T09:01:00Z', 'm-d1-edit'),
          userLine('s1', '2026-04-10T10:00:00Z'),
          assistantNoEditLine('s1', '2026-04-10T10:01:00Z', 'm-d1-chat'),
          userLine('s1', '2026-04-11T09:00:00Z'),
          assistantEditLine('s1', '2026-04-11T09:01:00Z', 'm-d2-edit'),
        ].join('\n'),
      )

      const result = runCli([
        '--format', 'json',
        '--from', '2026-04-10',
        '--to', '2026-04-11',
        '--provider', 'claude',
      ], home)

      expect(result.status).toBe(0)

      const report = JSON.parse(result.stdout) as {
        daily: Array<{
          date: string
          cost: number
          calls: number
          turns: number
          editTurns: number
          oneShotTurns: number
          oneShotRate: number | null
        }>
      }

      expect(report.daily).toHaveLength(2)

      const day1 = report.daily.find(d => d.date === '2026-04-10')
      expect(day1).toBeDefined()
      expect(day1!.turns).toBe(2)
      expect(day1!.editTurns).toBe(1)
      expect(day1!.oneShotTurns).toBe(1)
      expect(day1!.oneShotRate).toBe(100)

      const day2 = report.daily.find(d => d.date === '2026-04-11')
      expect(day2).toBeDefined()
      expect(day2!.turns).toBe(1)
      expect(day2!.editTurns).toBe(1)
      expect(day2!.oneShotTurns).toBe(1)
      expect(day2!.oneShotRate).toBe(100)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('reports null oneShotRate when the day has no edit turns', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-cli-json-daily-'))

    try {
      const projectDir = join(home, '.claude', 'projects', 'app')
      await mkdir(projectDir, { recursive: true })

      await writeFile(
        join(projectDir, 'chat-only.jsonl'),
        [
          userLine('s2', '2026-04-10T09:00:00Z'),
          assistantNoEditLine('s2', '2026-04-10T09:01:00Z', 'm-chat-1'),
          userLine('s2', '2026-04-10T09:30:00Z'),
          assistantNoEditLine('s2', '2026-04-10T09:31:00Z', 'm-chat-2'),
        ].join('\n'),
      )

      const result = runCli([
        '--format', 'json',
        '--from', '2026-04-10',
        '--to', '2026-04-10',
        '--provider', 'claude',
      ], home)

      expect(result.status).toBe(0)
      const report = JSON.parse(result.stdout) as {
        daily: Array<{ date: string; turns: number; editTurns: number; oneShotTurns: number; oneShotRate: number | null }>
      }
      const day = report.daily.find(d => d.date === '2026-04-10')!
      expect(day.turns).toBe(2)
      expect(day.editTurns).toBe(0)
      expect(day.oneShotTurns).toBe(0)
      // null, not 0 — the rate is undefined when no edits happened, and a
      // chat-only day would otherwise read as 0% one-shot which is misleading.
      expect(day.oneShotRate).toBeNull()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

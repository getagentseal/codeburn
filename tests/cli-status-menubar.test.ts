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
      expect(payload).toHaveProperty('stats')

      const current = payload['current'] as Record<string, unknown>
      expect(current['cost']).toBeGreaterThan(0)
      expect(current['calls']).toBe(2)
      expect(current['sessions']).toBe(1)
      expect(current).toHaveProperty('oneShotRate')
      expect(current).toHaveProperty('topActivities')
      expect(current).toHaveProperty('topModels')
      expect(current).toHaveProperty('providers')

      const history = payload['history'] as { daily: unknown[]; intraday: Array<Record<string, unknown>> }
      expect(Array.isArray(history.daily)).toBe(true)
      expect(Array.isArray(history.intraday)).toBe(true)
      expect(history.intraday).toHaveLength(6)
      expect(history.intraday.some(bucket => Number(bucket['calls'] ?? 0) > 0)).toBe(true)

      const stats = payload['stats'] as Record<string, unknown>
      expect(stats['trackedSpend']).toBeGreaterThan(0)
      expect(stats['trackedDays']).toBeGreaterThan(0)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('supports the lifetime period for sessions older than the cache window', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-menubar-lifetime-'))

    try {
      const projectDir = join(home, '.claude', 'projects', 'archive-app')
      await mkdir(projectDir, { recursive: true })

      const base = new Date(Date.now() - 900 * 24 * 3600_000)
      const ts1 = base.toISOString().replace(/\.\d+Z$/, 'Z')
      const ts2 = new Date(base.getTime() + 60_000).toISOString().replace(/\.\d+Z$/, 'Z')
      const ts3 = new Date(base.getTime() + 120_000).toISOString().replace(/\.\d+Z$/, 'Z')
      const ts4 = new Date(base.getTime() + 180_000).toISOString().replace(/\.\d+Z$/, 'Z')

      await writeFile(
        join(projectDir, 'session.jsonl'),
        [
          userLine('s-old', ts1),
          assistantLine('s-old', ts2, 'msg-old-1'),
          userLine('s-old', ts3),
          assistantLine('s-old', ts4, 'msg-old-2'),
        ].join('\n'),
      )

      const result = runCli([
        'status',
        '--format', 'menubar-json',
        '--period', 'lifetime',
        '--provider', 'all',
        '--no-optimize',
      ], home)

      expect(result.status, `stderr: ${result.stderr}`).toBe(0)

      const payload = JSON.parse(result.stdout) as {
        current: { label: string; cost: number; calls: number; sessions: number }
        stats: { trackedSpend: number; trackedDays: number }
        history: { daily: Array<{ date: string }> }
      }

      expect(payload.current.label).toBe('Lifetime')
      expect(payload.current.cost).toBeGreaterThan(0)
      expect(payload.current.calls).toBe(2)
      expect(payload.current.sessions).toBe(1)
      expect(payload.stats.trackedSpend).toBeCloseTo(payload.current.cost)
      expect(payload.stats.trackedDays).toBe(1)
      expect(payload.history.daily.some(day => day.date === ts1.slice(0, 10))).toBe(true)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('supports the lifetime period for a specific provider', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-menubar-lifetime-provider-'))

    try {
      const projectDir = join(home, '.claude', 'projects', 'provider-archive-app')
      await mkdir(projectDir, { recursive: true })

      const base = new Date(Date.now() - 900 * 24 * 3600_000)
      const ts1 = base.toISOString().replace(/\.\d+Z$/, 'Z')
      const ts2 = new Date(base.getTime() + 60_000).toISOString().replace(/\.\d+Z$/, 'Z')

      await writeFile(
        join(projectDir, 'session.jsonl'),
        [
          userLine('s-provider-old', ts1),
          assistantLine('s-provider-old', ts2, 'msg-provider-old-1'),
        ].join('\n'),
      )

      const result = runCli([
        'status',
        '--format', 'menubar-json',
        '--period', 'lifetime',
        '--provider', 'claude',
        '--no-optimize',
      ], home)

      expect(result.status, `stderr: ${result.stderr}`).toBe(0)

      const payload = JSON.parse(result.stdout) as {
        current: { label: string; cost: number; calls: number; sessions: number }
        stats: { trackedSpend: number; trackedDays: number }
        history: { daily: Array<{ date: string }> }
      }

      expect(payload.current.label).toBe('Lifetime')
      expect(payload.current.cost).toBeGreaterThan(0)
      expect(payload.current.calls).toBe(1)
      expect(payload.current.sessions).toBe(1)
      expect(payload.stats.trackedSpend).toBeCloseTo(payload.current.cost)
      expect(payload.stats.trackedDays).toBe(1)
      expect(payload.history.daily.some(day => day.date === ts1.slice(0, 10))).toBe(true)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('retains multi-year lifetime history for 2024 and 2025 sessions', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-menubar-lifetime-multiyear-'))

    try {
      const projectDir = join(home, '.claude', 'projects', 'history-app')
      await mkdir(projectDir, { recursive: true })

      const ts2024a = '2024-02-15T10:00:00Z'
      const ts2024b = '2024-02-15T10:01:00Z'
      const ts2025a = '2025-06-10T14:00:00Z'
      const ts2025b = '2025-06-10T14:01:00Z'
      const ts2026a = '2026-05-20T09:00:00Z'
      const ts2026b = '2026-05-20T09:01:00Z'

      await writeFile(
        join(projectDir, 'session-2024.jsonl'),
        [
          userLine('s-2024', ts2024a),
          assistantLine('s-2024', ts2024b, 'msg-2024-1'),
        ].join('\n'),
      )
      await writeFile(
        join(projectDir, 'session-2025.jsonl'),
        [
          userLine('s-2025', ts2025a),
          assistantLine('s-2025', ts2025b, 'msg-2025-1'),
        ].join('\n'),
      )
      await writeFile(
        join(projectDir, 'session-2026.jsonl'),
        [
          userLine('s-2026', ts2026a),
          assistantLine('s-2026', ts2026b, 'msg-2026-1'),
        ].join('\n'),
      )

      const result = runCli([
        'status',
        '--format', 'menubar-json',
        '--period', 'lifetime',
        '--provider', 'all',
        '--no-optimize',
      ], home)

      expect(result.status, `stderr: ${result.stderr}`).toBe(0)

      const payload = JSON.parse(result.stdout) as {
        current: { label: string; sessions: number }
        history: { daily: Array<{ date: string }> }
        stats: { trackedDays: number }
      }

      expect(payload.current.label).toBe('Lifetime')
      expect(payload.current.sessions).toBe(3)
      expect(payload.stats.trackedDays).toBe(3)
      expect(payload.history.daily.map(day => day.date)).toEqual(expect.arrayContaining([
        '2024-02-15',
        '2025-06-10',
        '2026-05-20',
      ]))
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('retains older lifetime history for yearly desktop aggregation', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-menubar-lifetime-yearly-'))

    try {
      const projectDir = join(home, '.claude', 'projects', 'yearly-history-app')
      await mkdir(projectDir, { recursive: true })

      const ts2020a = '2020-01-15T10:00:00Z'
      const ts2020b = '2020-01-15T10:01:00Z'
      const ts2023a = '2023-07-11T14:00:00Z'
      const ts2023b = '2023-07-11T14:01:00Z'
      const ts2026a = '2026-05-20T09:00:00Z'
      const ts2026b = '2026-05-20T09:01:00Z'

      await writeFile(
        join(projectDir, 'session-2020.jsonl'),
        [
          userLine('s-2020', ts2020a),
          assistantLine('s-2020', ts2020b, 'msg-2020-1'),
        ].join('\n'),
      )
      await writeFile(
        join(projectDir, 'session-2023.jsonl'),
        [
          userLine('s-2023', ts2023a),
          assistantLine('s-2023', ts2023b, 'msg-2023-1'),
        ].join('\n'),
      )
      await writeFile(
        join(projectDir, 'session-2026.jsonl'),
        [
          userLine('s-2026-yearly', ts2026a),
          assistantLine('s-2026-yearly', ts2026b, 'msg-2026-yearly-1'),
        ].join('\n'),
      )

      const result = runCli([
        'status',
        '--format', 'menubar-json',
        '--period', 'lifetime',
        '--provider', 'all',
        '--no-optimize',
      ], home)

      expect(result.status, `stderr: ${result.stderr}`).toBe(0)

      const payload = JSON.parse(result.stdout) as {
        current: { label: string; sessions: number }
        history: { daily: Array<{ date: string }> }
        stats: { trackedDays: number }
      }

      expect(payload.current.label).toBe('Lifetime')
      expect(payload.current.sessions).toBe(3)
      expect(payload.stats.trackedDays).toBe(3)
      expect(payload.history.daily.map(day => day.date)).toEqual(expect.arrayContaining([
        '2020-01-15',
        '2023-07-11',
        '2026-05-20',
      ]))
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

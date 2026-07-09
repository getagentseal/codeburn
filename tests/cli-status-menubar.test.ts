import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
      CODEBURN_CACHE_DIR: join(home, '.cache', 'codeburn'),
      HOME: home,
      TZ: 'UTC',
      ...extraEnv,
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

  it('includes LingTai TUI usage and activity categories in menubar payloads', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-menubar-lingtai-'))

    try {
      const lingtaiHome = join(home, '.lingtai')
      const agentDir = join(lingtaiHome, 'agent')
      await mkdir(join(agentDir, 'logs'), { recursive: true })
      await writeFile(join(agentDir, '.agent.json'), JSON.stringify({
        agent_id: 'agent-1',
        agent_name: 'LingTai Agent',
        llm: { model: 'gpt-4o' },
      }))

      const now = new Date()
      const h = now.getUTCHours()
      const base = h >= 2 ? new Date(now.getTime() - 2 * 3600_000) : new Date(now.getTime() - h * 3600_000 - 300_000)
      const ts1 = base.toISOString().replace(/\.\d+Z$/, 'Z')
      const ts2 = new Date(base.getTime() + 60_000).toISOString().replace(/\.\d+Z$/, 'Z')
      const ts3 = new Date(base.getTime() + 120_000).toISOString().replace(/\.\d+Z$/, 'Z')

      await writeFile(
        join(agentDir, 'logs', 'token_ledger.jsonl'),
        [
          JSON.stringify({ source: 'main', ts: ts1, input: 1000, cached: 100, output: 100, model: 'gpt-4o' }),
          JSON.stringify({ source: 'tc_wake', ts: ts2, input: 2000, cached: 500, output: 200, model: 'gpt-4o' }),
          JSON.stringify({ source: 'summarize_apriori', ts: ts3, input: 1500, cached: 300, output: 150, model: 'gpt-4o' }),
        ].join('\n') + '\n',
      )

      const result = runCli([
        'status',
        '--format', 'menubar-json',
        '--period', 'today',
        '--provider', 'lingtai-tui',
        '--no-optimize',
      ], home, {
        LINGTAI_HOME: lingtaiHome,
        LINGTAI_TUI_GLOBAL_DIR: join(home, '.lingtai-tui'),
      })

      expect(result.status, `stderr: ${result.stderr}`).toBe(0)

      const payload = JSON.parse(result.stdout) as {
        current: {
          cost: number
          calls: number
          providers: Record<string, number>
          topActivities: Array<{ name: string; turns: number }>
        }
      }

      expect(payload.current.cost).toBeGreaterThan(0)
      expect(payload.current.calls).toBe(3)
      expect(payload.current.providers['lingtai tui']).toBeGreaterThan(0)
      expect(payload.current.topActivities.map(a => a.name).sort()).toEqual([
        'Conversation',
        'Delegation',
        'Planning',
      ])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('attaches combined local-only usage for --scope combined and omits it for local scope', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-menubar-combined-'))

    try {
      const projectDir = join(home, '.claude', 'projects', 'myapp')
      await mkdir(projectDir, { recursive: true })

      const now = new Date()
      const h = now.getUTCHours()
      const base = h >= 2 ? new Date(now.getTime() - 2 * 3600_000) : new Date(now.getTime() - h * 3600_000 - 300_000)
      const ts1 = base.toISOString().replace(/\.\d+Z$/, 'Z')
      const ts2 = new Date(base.getTime() + 60_000).toISOString().replace(/\.\d+Z$/, 'Z')

      await writeFile(
        join(projectDir, 'session.jsonl'),
        [
          userLine('s1', ts1),
          assistantLine('s1', ts2, 'msg-1'),
        ].join('\n'),
      )

      const combinedResult = runCli([
        'status',
        '--format', 'menubar-json',
        '--scope', 'combined',
        '--period', 'today',
        '--provider', 'all',
        '--no-optimize',
      ], home)

      expect(combinedResult.status, `stderr: ${combinedResult.stderr}`).toBe(0)

      const payload = JSON.parse(combinedResult.stdout) as {
        current: {
          cost: number
          calls: number
          sessions: number
          inputTokens: number
          outputTokens: number
        }
        history: {
          daily: Array<{ cacheWriteTokens?: number; cacheReadTokens?: number }>
        }
        combined?: {
          perDevice: Array<{
            id: string
            local: boolean
            cost: number
            calls: number
            sessions: number
            inputTokens: number
            outputTokens: number
            cacheCreateTokens: number
            cacheReadTokens: number
            totalTokens: number
          }>
          combined: {
            cost: number
            calls: number
            sessions: number
            inputTokens: number
            outputTokens: number
            cacheCreateTokens: number
            cacheReadTokens: number
            totalTokens: number
            deviceCount: number
            reachableCount: number
          }
        }
      }

      expect(payload.combined).toBeDefined()
      expect(payload.combined!.perDevice).toHaveLength(1)
      const local = payload.combined!.perDevice[0]!
      const cacheCreateTokens = payload.history.daily.reduce((sum, d) => sum + (d.cacheWriteTokens ?? 0), 0)
      const cacheReadTokens = payload.history.daily.reduce((sum, d) => sum + (d.cacheReadTokens ?? 0), 0)
      const totalTokens = payload.current.inputTokens + payload.current.outputTokens + cacheCreateTokens + cacheReadTokens

      expect(local).toMatchObject({
        id: 'local',
        local: true,
        cost: payload.current.cost,
        calls: payload.current.calls,
        sessions: payload.current.sessions,
        inputTokens: payload.current.inputTokens,
        outputTokens: payload.current.outputTokens,
        cacheCreateTokens,
        cacheReadTokens,
        totalTokens,
      })
      expect(payload.combined!.combined).toEqual({
        cost: payload.current.cost,
        calls: payload.current.calls,
        sessions: payload.current.sessions,
        inputTokens: payload.current.inputTokens,
        outputTokens: payload.current.outputTokens,
        cacheCreateTokens,
        cacheReadTokens,
        totalTokens,
        deviceCount: 1,
        reachableCount: 1,
      })

      const localResult = runCli([
        'status',
        '--format', 'menubar-json',
        '--scope', 'local',
        '--period', 'today',
        '--provider', 'all',
        '--no-optimize',
      ], home)
      expect(localResult.status, `stderr: ${localResult.stderr}`).toBe(0)
      expect(JSON.parse(localResult.stdout)).not.toHaveProperty('combined')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it.each([
    ['--provider', ['--provider', 'claude']],
    ['--project', ['--project', 'x']],
    ['--exclude', ['--exclude', 'y']],
  ])('rejects combined scope with filtered local payloads from %s', async (_name, filterArgs) => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-menubar-combined-filter-'))

    try {
      const result = runCli([
        'status',
        '--format', 'menubar-json',
        '--scope', 'combined',
        ...filterArgs,
        '--no-optimize',
      ], home)

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('error: --scope combined cannot be combined with --provider, --project, or --exclude (paired devices report unfiltered usage)')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('rejects invalid menubar-json scope values', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-menubar-scope-'))

    try {
      const result = runCli([
        'status',
        '--format', 'menubar-json',
        '--scope', 'remote',
        '--no-optimize',
      ], home)

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('unknown scope "remote"')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('still emits a valid combined menubar payload when the remotes store is corrupt', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-menubar-corrupt-remotes-'))

    try {
      const projectDir = join(home, '.claude', 'projects', 'myapp')
      await mkdir(projectDir, { recursive: true })
      const now = new Date()
      const h = now.getUTCHours()
      const base = h >= 2 ? new Date(now.getTime() - 2 * 3600_000) : new Date(now.getTime() - h * 3600_000 - 300_000)
      const ts1 = base.toISOString().replace(/\.\d+Z$/, 'Z')
      const ts2 = new Date(base.getTime() + 60_000).toISOString().replace(/\.\d+Z$/, 'Z')
      await writeFile(join(projectDir, 'session.jsonl'), [userLine('s1', ts1), assistantLine('s1', ts2, 'msg-1')].join('\n'))

      // Corrupt the remotes store the combined path reads. The menubar must
      // still get a valid payload (combined degrades to local-only).
      const sharingDir = join(home, '.config', 'codeburn', 'sharing')
      await mkdir(sharingDir, { recursive: true })
      await writeFile(join(sharingDir, 'remote-devices.json'), '{ this is : not valid json ]')

      const result = runCli([
        'status', '--format', 'menubar-json', '--scope', 'combined',
        '--period', 'today', '--no-optimize',
      ], home)

      expect(result.status, `stderr: ${result.stderr}`).toBe(0)
      const payload = JSON.parse(result.stdout) as {
        current: { cost: number }
        combined?: { perDevice: unknown[]; combined: { deviceCount: number; reachableCount: number } }
      }
      expect(payload.combined).toBeDefined()
      expect(payload.combined!.perDevice).toHaveLength(1)
      expect(payload.combined!.combined.deviceCount).toBe(1)
      expect(payload.combined!.combined.reachableCount).toBe(1)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter as pathDelimiter, join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

function runCli(args: string[], home: string, extraEnv: Record<string, string | undefined> = {}) {
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

  it('omits history.timeline with --no-timeline, includes it by default', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-menubar-tl-'))
    try {
      const projectDir = join(home, '.claude', 'projects', 'myapp')
      await mkdir(projectDir, { recursive: true })
      const base = new Date(Date.now() - 3600_000)
      const ts = (offset: number) => new Date(base.getTime() + offset).toISOString().replace(/\.\d+Z$/, 'Z')
      await writeFile(
        join(projectDir, 'session.jsonl'),
        [userLine('s1', ts(0)), assistantLine('s1', ts(60_000), 'msg-1')].join('\n'),
      )

      const withTimeline = runCli(['status', '--format', 'menubar-json', '--period', 'today', '--no-optimize'], home)
      expect(withTimeline.status, `stderr: ${withTimeline.stderr}`).toBe(0)
      const withHistory = (JSON.parse(withTimeline.stdout) as { history: Record<string, unknown> }).history
      expect(withHistory).toHaveProperty('timeline')

      const noTimeline = runCli(['status', '--format', 'menubar-json', '--period', 'today', '--no-optimize', '--no-timeline'], home)
      expect(noTimeline.status, `stderr: ${noTimeline.stderr}`).toBe(0)
      const noHistory = (JSON.parse(noTimeline.stdout) as { history: Record<string, unknown> }).history
      expect(noHistory).not.toHaveProperty('timeline')
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

  it('filters the whole menubar payload to a selected Claude config source', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-menubar-claude-config-'))

    try {
      const work = join(home, 'claude-work')
      const personal = join(home, 'claude-personal')
      const slug = 'shared-app'
      await mkdir(join(work, 'projects', slug), { recursive: true })
      await mkdir(join(personal, 'projects', slug), { recursive: true })

      await writeFile(
        join(work, 'projects', slug, 'work.jsonl'),
        [
          userLine('work', '2026-04-10T11:59:00Z'),
          assistantLine('work', '2026-04-10T12:00:00Z', 'msg-work'),
        ].join('\n'),
      )
      await writeFile(
        join(personal, 'projects', slug, 'personal.jsonl'),
        [
          userLine('personal', '2026-04-10T12:59:00Z'),
          assistantLine('personal', '2026-04-10T13:00:00Z', 'msg-personal'),
        ].join('\n'),
      )

      const env = { CLAUDE_CONFIG_DIRS: [work, personal].join(pathDelimiter) }
      const allResult = runCli([
        'status',
        '--format', 'menubar-json',
        '--period', 'all',
        '--provider', 'all',
        '--no-optimize',
      ], home, env)

      expect(allResult.status, `stderr: ${allResult.stderr}`).toBe(0)
      const allPayload = JSON.parse(allResult.stdout) as {
        current: { calls: number; sessions: number }
        claudeConfigs?: { selectedId: string | null; options: Array<{ id: string; label: string; path: string }> }
      }
      expect(allPayload.current.calls).toBe(2)
      expect(allPayload.current.sessions).toBe(2)
      expect(allPayload.claudeConfigs?.selectedId).toBeNull()
      expect(allPayload.claudeConfigs?.options.map(o => o.label).sort()).toEqual(['claude-personal', 'claude-work'])

      const workSourceId = allPayload.claudeConfigs!.options.find(o => o.label === 'claude-work')!.id
      const workResult = runCli([
        'status',
        '--format', 'menubar-json',
        '--period', 'all',
        '--provider', 'all',
        '--claude-config-source', workSourceId,
        '--no-optimize',
      ], home, env)

      expect(workResult.status, `stderr: ${workResult.stderr}`).toBe(0)
      const workPayload = JSON.parse(workResult.stdout) as {
        current: { calls: number; sessions: number; providers: Record<string, number> }
        history: { daily: Array<{ calls: number }> }
        claudeConfigs?: { selectedId: string | null }
      }
      expect(workPayload.claudeConfigs?.selectedId).toBe(workSourceId)
      expect(workPayload.current.calls).toBe(1)
      expect(workPayload.current.sessions).toBe(1)
      expect(Object.keys(workPayload.current.providers)).toEqual(['claude'])
      expect(workPayload.history.daily.reduce((sum, d) => sum + d.calls, 0)).toBe(1)

      const invalidResult = runCli([
        'status',
        '--format', 'menubar-json',
        '--period', 'all',
        '--provider', 'all',
        '--claude-config-source', 'claude-config:missing',
        '--no-optimize',
      ], home, env)

      expect(invalidResult.status, `stderr: ${invalidResult.stderr}`).toBe(0)
      const invalidPayload = JSON.parse(invalidResult.stdout) as {
        current: { calls: number }
        claudeConfigs?: { selectedId: string | null }
      }
      expect(invalidPayload.current.calls).toBe(2)
      expect(invalidPayload.claudeConfigs?.selectedId).toBeNull()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('keeps idle Claude config options visible for the selected period', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-menubar-claude-config-idle-'))

    try {
      const work = join(home, 'claude-work')
      const personal = join(home, 'claude-personal')
      await mkdir(join(work, 'projects', 'app'), { recursive: true })
      await mkdir(join(personal, 'projects', 'app'), { recursive: true })

      await writeFile(
        join(work, 'projects', 'app', 'work.jsonl'),
        [
          userLine('work', '2026-04-10T11:59:00Z'),
          assistantLine('work', '2026-04-10T12:00:00Z', 'msg-work'),
        ].join('\n'),
      )
      await writeFile(
        join(personal, 'projects', 'app', 'personal.jsonl'),
        [
          userLine('personal', '2026-04-09T11:59:00Z'),
          assistantLine('personal', '2026-04-09T12:00:00Z', 'msg-personal'),
        ].join('\n'),
      )

      const env = { CLAUDE_CONFIG_DIRS: [work, personal].join(pathDelimiter) }
      const allResult = runCli([
        'status',
        '--format', 'menubar-json',
        '--day', '2026-04-10',
        '--provider', 'all',
        '--no-optimize',
      ], home, env)

      expect(allResult.status, `stderr: ${allResult.stderr}`).toBe(0)
      const allPayload = JSON.parse(allResult.stdout) as {
        current: { calls: number }
        claudeConfigs?: { options: Array<{ id: string; label: string }> }
      }
      expect(allPayload.current.calls).toBe(1)
      expect(allPayload.claudeConfigs?.options.map(o => o.label).sort()).toEqual(['claude-personal', 'claude-work'])

      const personalSourceId = allPayload.claudeConfigs!.options.find(o => o.label === 'claude-personal')!.id
      const personalResult = runCli([
        'status',
        '--format', 'menubar-json',
        '--day', '2026-04-10',
        '--provider', 'all',
        '--claude-config-source', personalSourceId,
        '--no-optimize',
      ], home, env)

      expect(personalResult.status, `stderr: ${personalResult.stderr}`).toBe(0)
      const personalPayload = JSON.parse(personalResult.stdout) as {
        current: { calls: number; sessions: number; providers: Record<string, number> }
        claudeConfigs?: { selectedId: string | null }
      }
      expect(personalPayload.claudeConfigs?.selectedId).toBe(personalSourceId)
      expect(personalPayload.current.calls).toBe(0)
      expect(personalPayload.current.sessions).toBe(0)
      expect(personalPayload.current.providers).toEqual({ claude: 0 })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('rejects --claude-config-source combined with a non-Claude --provider', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-menubar-cfg-provider-'))
    try {
      const work = join(home, 'claude-work')
      const personal = join(home, 'claude-personal')
      await mkdir(join(work, 'projects', 'app'), { recursive: true })
      await mkdir(join(personal, 'projects', 'app'), { recursive: true })
      const env = { CLAUDE_CONFIG_DIRS: [work, personal].join(pathDelimiter) }

      const result = runCli([
        'status', '--format', 'menubar-json', '--period', 'all',
        '--provider', 'codex', '--claude-config-source', 'claude-config:whatever',
        '--no-optimize',
      ], home, env)

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('--claude-config-source cannot be combined with --provider codex')

      // 'claude' is allowed (a config scopes Claude usage).
      const okClaude = runCli([
        'status', '--format', 'menubar-json', '--period', 'all',
        '--provider', 'claude', '--no-optimize',
      ], home, env)
      expect(okClaude.status, `stderr: ${okClaude.stderr}`).toBe(0)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('surfaces Claude Desktop sessions as their own bucket so config sum equals All', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-menubar-desktop-'))
    try {
      const work = join(home, 'claude-work')
      const personal = join(home, 'claude-personal')
      await mkdir(join(work, 'projects', 'app'), { recursive: true })
      await mkdir(join(personal, 'projects', 'app'), { recursive: true })
      await writeFile(join(work, 'projects', 'app', 'w.jsonl'),
        [userLine('w', '2026-04-10T11:59:00Z'), assistantLine('w', '2026-04-10T12:00:00Z', 'mw')].join('\n'))
      await writeFile(join(personal, 'projects', 'app', 'p.jsonl'),
        [userLine('p', '2026-04-10T12:59:00Z'), assistantLine('p', '2026-04-10T13:00:00Z', 'mp')].join('\n'))

      // A fake Claude Desktop sessions tree.
      const desktop = join(home, 'desktop-sessions')
      const dProj = join(desktop, 'appid', 'ws', 'local_s1', '.claude', 'projects', 'space')
      await mkdir(dProj, { recursive: true })
      await writeFile(join(dProj, 'd.jsonl'),
        [userLine('d', '2026-04-10T13:59:00Z'), assistantLine('d', '2026-04-10T14:00:00Z', 'md')].join('\n'))

      const env = {
        CLAUDE_CONFIG_DIRS: [work, personal].join(pathDelimiter),
        CODEBURN_DESKTOP_SESSIONS_DIR: desktop,
      }
      const result = runCli([
        'status', '--format', 'menubar-json', '--period', 'all', '--provider', 'all', '--no-optimize',
      ], home, env)
      expect(result.status, `stderr: ${result.stderr}`).toBe(0)
      const payload = JSON.parse(result.stdout) as {
        current: { calls: number }
        claudeConfigs?: { options: Array<{ id: string; label: string }> }
      }
      // 3 sessions total: work + personal + desktop.
      expect(payload.current.calls).toBe(3)
      // The selector lists all three, including a Claude Desktop bucket.
      const labels = payload.claudeConfigs?.options.map(o => o.label).sort()
      expect(labels).toContain('Claude Desktop')
      expect(labels).toHaveLength(3)
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

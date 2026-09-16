import { mkdir, rm, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { delimiter as pathDelimiter, join } from 'node:path'

import { describe, expect, it, type TestContext } from 'vitest'

import { DAILY_CACHE_VERSION } from '../src/daily-cache.js'
import { getDailyCacheConfigHash } from '../src/usage-aggregator.js'

type ProviderSeed = {
  calls: number
  cost: number
  sessions: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
}

function dateStringUtc(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function dayAtUtcOffset(now: Date, offset: number): string {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return dateStringUtc(new Date(today - offset * 24 * 60 * 60 * 1000))
}

// Seed times for a fresh Claude turn: the user line ten minutes back and the
// assistant line one minute after it, both clamped into [today's UTC midnight,
// now]. runCli pins TZ=UTC and the CLI reads the real clock, so a plain now-10m
// lands on yesterday for the first ten minutes after UTC midnight and the fresh
// slice drops out of `--days ...,today` and `--period today`. At exactly
// midnight both lines share one timestamp, which the parser accepts
// (cli-session-across-days seeds every turn that way).
function freshTurnTimes(now: Date): { userAt: string; assistantAt: string } {
  const todayUtcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const userAt = Math.max(todayUtcMidnight, now.getTime() - 10 * 60_000)
  const assistantAt = Math.min(now.getTime(), userAt + 60_000)
  return { userAt: new Date(userAt).toISOString(), assistantAt: new Date(assistantAt).toISOString() }
}

// The CLI subprocess has no injectable clock. If UTC midnight passes between
// seeding and a CLI run finishing, that run answered for a different "today"
// than the fixture describes, so skip rather than report a false regression.
function skipIfUtcDayRolled(ctx: TestContext, seededDay: string): void {
  ctx.skip(dateStringUtc(new Date()) !== seededDay, `UTC day rolled past ${seededDay} mid-test; the fixture no longer describes today`)
}

function seededDay(date: string, providers: Record<string, ProviderSeed>) {
  const rows = Object.values(providers)
  return {
    date,
    cost: rows.reduce((sum, row) => sum + row.cost, 0),
    savingsUSD: 0,
    calls: rows.reduce((sum, row) => sum + row.calls, 0),
    sessions: rows.reduce((sum, row) => sum + row.sessions, 0),
    inputTokens: rows.reduce((sum, row) => sum + row.inputTokens, 0),
    outputTokens: rows.reduce((sum, row) => sum + row.outputTokens, 0),
    cacheReadTokens: rows.reduce((sum, row) => sum + (row.cacheReadTokens ?? 0), 0),
    cacheWriteTokens: 0,
    editTurns: 0,
    oneShotTurns: 0,
    models: {},
    categories: {},
    providers,
  }
}

function runCli(args: string[], home: string, extraEnv: Record<string, string | undefined> = {}) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      CODEBURN_CACHE_DIR: join(home, '.cache', 'codeburn'),
      CODEX_HOME: join(home, '.codex'),
      KIMI_CODE_HOME: join(home, '.kimi'),
      CODEBURN_DESKTOP_SESSIONS_DIR: join(home, '.desktop-sessions'),
      TZ: 'UTC',
      ...extraEnv,
    },
    encoding: 'utf-8',
    timeout: 60_000,
  })
}

function detail(payload: { current: { providerDetails: Array<{ id: string; cacheReadTokens?: number; hasUsage?: boolean }> } }, id: string) {
  return payload.current.providerDetails.find(row => row.id === id)
}

describe('status menubar cache-read pipeline', () => {
  it('combines fresh and durable provider slices while honoring selected dates and unknown legacy fields', async (ctx) => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-cache-read-pipeline-'))
    const now = new Date()
    const knownDate = dayAtUtcOffset(now, 10)
    const excludedDate = dayAtUtcOffset(now, 9)
    const partialDate = dayAtUtcOffset(now, 8)
    const todayDate = dayAtUtcOffset(now, 0)
    const fresh = freshTurnTimes(now)
    const run = (args: string[]) => {
      const result = runCli(args, home)
      skipIfUtcDayRolled(ctx, todayDate)
      return result
    }

    try {
      await mkdir(join(home, '.claude', 'projects', 'fresh-project'), { recursive: true })
      await mkdir(join(home, '.codex'), { recursive: true })
      await mkdir(join(home, '.kimi'), { recursive: true })
      await mkdir(join(home, '.desktop-sessions'), { recursive: true })
      await mkdir(join(home, '.cache', 'codeburn'), { recursive: true })

      await writeFile(
        join(home, '.claude', 'projects', 'fresh-project', 'fresh.jsonl'),
        [
          JSON.stringify({
            type: 'user',
            sessionId: 'fresh-cache-session',
            timestamp: fresh.userAt,
            message: { role: 'user', content: 'exercise the durable cache path' },
          }),
          JSON.stringify({
            type: 'assistant',
            sessionId: 'fresh-cache-session',
            timestamp: fresh.assistantAt,
            message: {
              id: 'fresh-cache-message',
              type: 'message',
              role: 'assistant',
              model: 'claude-sonnet-4-5',
              content: [{ type: 'text', text: 'done' }],
              usage: {
                input_tokens: 500,
                output_tokens: 50,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 700,
              },
            },
          }),
        ].join('\n') + '\n',
      )

      const cache = {
        version: DAILY_CACHE_VERSION,
        savingsConfigHash: getDailyCacheConfigHash(),
        tzKey: 'UTC',
        lastComputedDate: dayAtUtcOffset(now, 1),
        complete: true,
        days: [
          seededDay(knownDate, {
            claude: { calls: 2, cost: 10, sessions: 1, inputTokens: 100, outputTokens: 20, cacheReadTokens: 1111 },
            codex: { calls: 3, cost: 20, sessions: 1, inputTokens: 200, outputTokens: 30, cacheReadTokens: 2222 },
            // Explicit zero with no activity: this is a known zero, not an
            // absent legacy field, and must survive a provider-scoped query.
            gemini: { calls: 0, cost: 0, sessions: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
            hermes: { calls: 1, cost: 40, sessions: 1, inputTokens: 400, outputTokens: 50 },
          }),
          // This day is deliberately inside the selected range but omitted by
          // --days below. Its values prove that provider/date selection happens
          // after durable loading, rather than selecting a whole cache file.
          seededDay(excludedDate, {
            claude: { calls: 2, cost: 11, sessions: 1, inputTokens: 110, outputTokens: 21, cacheReadTokens: 9001 },
            codex: { calls: 3, cost: 21, sessions: 1, inputTokens: 210, outputTokens: 31, cacheReadTokens: 9002 },
            gemini: { calls: 1, cost: 31, sessions: 1, inputTokens: 310, outputTokens: 41, cacheReadTokens: 9003 },
            hermes: { calls: 1, cost: 41, sessions: 1, inputTokens: 410, outputTokens: 51, cacheReadTokens: 9004 },
          }),
          // Included alongside knownDate: this gives Hermes one known row and
          // one active legacy-missing row, so a partial sum must stay unknown.
          seededDay(partialDate, {
            hermes: { calls: 1, cost: 42, sessions: 1, inputTokens: 420, outputTokens: 52, cacheReadTokens: 3333 },
          }),
        ],
      }
      await writeFile(
        join(home, '.cache', 'codeburn', `daily-cache.v${DAILY_CACHE_VERSION}.json`),
        JSON.stringify(cache),
        'utf-8',
      )

      const args = [
        'status', '--format', 'menubar-json', '--provider', 'all', '--days', `${knownDate},${partialDate},${todayDate}`,
        '--no-optimize', '--no-timeline',
      ]
      const all = run(args)
      expect(all.status, `stderr: ${all.stderr}`).toBe(0)
      const allPayload = JSON.parse(all.stdout) as { current: { providerDetails: Array<{ id: string; cacheReadTokens?: number; hasUsage?: boolean }> } }

      // Historical Claude (1111) + the real fresh parse (700) are both present.
      expect(detail(allPayload, 'claude')?.cacheReadTokens).toBe(1811)
      // The selected day has a distinct durable Codex value, while the excluded
      // day's 9002 never enters the total.
      expect(detail(allPayload, 'codex')?.cacheReadTokens).toBe(2222)
      expect(detail(allPayload, 'gemini')?.cacheReadTokens).toBe(0) // known zero
      expect(detail(allPayload, 'hermes')).toMatchObject({ hasUsage: true })
      expect(detail(allPayload, 'hermes')).not.toHaveProperty('cacheReadTokens') // active legacy missing

      const selectedClaude = run([
        'status', '--format', 'menubar-json', '--provider', 'claude', '--days', `${knownDate},${partialDate},${todayDate}`,
        '--no-optimize', '--no-timeline',
      ])
      expect(selectedClaude.status, `stderr: ${selectedClaude.stderr}`).toBe(0)
      const claudePayload = JSON.parse(selectedClaude.stdout) as { current: { providerDetails: Array<{ id: string; cacheReadTokens?: number }> } }
      expect(detail(claudePayload, 'claude')?.cacheReadTokens).toBe(1811)

      const selectedCodex = run([
        'status', '--format', 'menubar-json', '--provider', 'codex', '--days', `${knownDate},${partialDate},${todayDate}`,
        '--no-optimize', '--no-timeline',
      ])
      expect(selectedCodex.status, `stderr: ${selectedCodex.stderr}`).toBe(0)
      const codexPayload = JSON.parse(selectedCodex.stdout) as { current: { providerDetails: Array<{ id: string; cacheReadTokens?: number }> } }
      expect(detail(codexPayload, 'codex')?.cacheReadTokens).toBe(2222)

      const selectedGemini = run([
        'status', '--format', 'menubar-json', '--provider', 'gemini', '--days', `${knownDate},${partialDate},${todayDate}`,
        '--no-optimize', '--no-timeline',
      ])
      expect(selectedGemini.status, `stderr: ${selectedGemini.stderr}`).toBe(0)
      const geminiPayload = JSON.parse(selectedGemini.stdout) as { current: { providerDetails: Array<{ id: string; cacheReadTokens?: number; hasUsage?: boolean }> } }
      expect(detail(geminiPayload, 'gemini')).toMatchObject({ hasUsage: false, cacheReadTokens: 0 })

      const selectedHermes = run([
        'status', '--format', 'menubar-json', '--provider', 'hermes', '--days', `${knownDate},${partialDate},${todayDate}`,
        '--no-optimize', '--no-timeline',
      ])
      expect(selectedHermes.status, `stderr: ${selectedHermes.stderr}`).toBe(0)
      const hermesPayload = JSON.parse(selectedHermes.stdout) as { current: { providerDetails: Array<{ id: string; cacheReadTokens?: number; hasUsage?: boolean }> } }
      expect(detail(hermesPayload, 'hermes')).toMatchObject({ hasUsage: true })
      expect(detail(hermesPayload, 'hermes')).not.toHaveProperty('cacheReadTokens')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, 120_000)

  it('keeps fresh cache reads in a selected Claude config provider detail', async (ctx) => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-cache-read-config-scope-'))
    const work = join(home, 'claude-work')
    const personal = join(home, 'claude-personal')
    const now = new Date()
    const todayDate = dayAtUtcOffset(now, 0)
    const fresh = freshTurnTimes(now)
    const assistant = (sessionId: string, timestamp: string, cacheRead: number) => JSON.stringify({
      type: 'assistant',
      sessionId,
      timestamp,
      message: {
        id: `${sessionId}-assistant`,
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'done' }],
        usage: {
          input_tokens: 500,
          output_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: cacheRead,
        },
      },
    })
    const sourceEnv = {
      CLAUDE_CONFIG_DIR: '',
      CLAUDE_CONFIG_DIRS: [work, personal].join(pathDelimiter),
    }
    const run = (args: string[]) => {
      const result = runCli(args, home, sourceEnv)
      skipIfUtcDayRolled(ctx, todayDate)
      return result
    }

    try {
      await mkdir(join(work, 'projects', 'selected'), { recursive: true })
      await mkdir(join(personal, 'projects', 'other'), { recursive: true })
      await mkdir(join(home, '.cache', 'codeburn'), { recursive: true })
      await writeFile(
        join(work, 'projects', 'selected', 'work.jsonl'),
        [
          JSON.stringify({ type: 'user', sessionId: 'selected-session', timestamp: fresh.userAt, message: { role: 'user', content: 'fixture' } }),
          assistant('selected-session', fresh.assistantAt, 4321),
        ].join('\n') + '\n',
      )
      await writeFile(
        join(personal, 'projects', 'other', 'personal.jsonl'),
        [
          JSON.stringify({ type: 'user', sessionId: 'other-session', timestamp: fresh.userAt, message: { role: 'user', content: 'fixture' } }),
          assistant('other-session', fresh.assistantAt, 9876),
        ].join('\n') + '\n',
      )

      const all = run([
        'status', '--format', 'menubar-json', '--period', 'today', '--provider', 'all', '--no-optimize', '--no-timeline',
      ])
      expect(all.status, `stderr: ${all.stderr}`).toBe(0)
      const allPayload = JSON.parse(all.stdout) as {
        claudeConfigs?: { options: Array<{ id: string; label: string }> }
      }
      const selectedId = allPayload.claudeConfigs?.options.find(option => option.label === 'claude-work')?.id
      expect(selectedId).toBeTruthy()

      const selected = run([
        'status', '--format', 'menubar-json', '--period', 'today', '--provider', 'all',
        '--claude-config-source', selectedId!, '--no-optimize', '--no-timeline',
      ])
      expect(selected.status, `stderr: ${selected.stderr}`).toBe(0)
      const selectedPayload = JSON.parse(selected.stdout) as {
        current: { cacheReadTokens: number; providerDetails: Array<{ id: string; cacheReadTokens?: number }> }
      }
      expect(selectedPayload.current.cacheReadTokens).toBe(4321)
      expect(detail(selectedPayload, 'claude')?.cacheReadTokens).toBe(4321)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, 120_000)
})

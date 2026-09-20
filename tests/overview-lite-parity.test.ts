import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { getDateRange } from '../src/cli-date.js'
import { loadPricing } from '../src/models.js'
import { aggregateProjectsIntoDays } from '../src/day-aggregator.js'
import { buildPeriodData } from '../src/usage-aggregator.js'
import { clearSessionCache, parseAllSessions } from '../src/parser.js'
import { renderOverview } from '../src/overview.js'
import type { DateRange } from '../src/types.js'

// Lite-vs-full parity for aggregate mode (overview -p today): a stripped
// parse must report exactly what the full parse reports — same totals, days,
// models, categories, tools, and rendered text — while carrying no per-call
// payloads. Isolated env (mirrors cli-durable-totals) so host sessions leak in.

const ROOT = join(tmpdir(), `codeburn-lite-parity-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
const ENV_KEYS = ['HOME', 'CODEBURN_CACHE_DIR', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CONFIG_DIRS', 'CODEX_HOME', 'USERPROFILE', 'KIMI_CODE_HOME', 'CODEBURN_DESKTOP_SESSIONS_DIR'] as const
let savedEnv: Record<string, string | undefined>

const CODEX_ROOT = vi.hoisted(() => {
  const root = `${process.env['TMPDIR'] || '/tmp'}/codeburn-lite-parity-codex-${process.pid}-${Date.now()}`
  process.env['CODEX_HOME'] = `${root}/codex`
  return root
})

function minutesAgo(now: Date, midnight: number, m: number): string {
  return new Date(Math.max(midnight, now.getTime() - m * 60_000)).toISOString()
}

/** One live-today Claude session: user prompt, edit turn, bash turn, chat turn. */
async function seedTodaySession(): Promise<void> {
  const projectDir = join(ROOT, 'home', '.claude', 'projects', 'p')
  await mkdir(projectDir, { recursive: true })
  const now = new Date()
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const user = (t: string, text: string): string => JSON.stringify({
    type: 'user', sessionId: 's-lite', timestamp: t, message: { role: 'user', content: text },
  })
  const assistant = (id: string, t: string, model: string, content: unknown[], usage: unknown): string => JSON.stringify({
    type: 'assistant', sessionId: 's-lite', timestamp: t,
    message: { id, type: 'message', role: 'assistant', model, content, usage },
  })
  const usage = { input_tokens: 1000, output_tokens: 100 }
  const lines = [
    user(minutesAgo(now, midnight, 50), 'add retry logic to the uploader'),
    assistant('m1', minutesAgo(now, midnight, 40), 'claude-sonnet-4-5', [
      { type: 'text', text: 'editing' },
      { type: 'tool_use', id: 'tu-1', name: 'Edit', input: { file_path: '/tmp/x', old_string: 'a', new_string: 'b' } },
    ], usage),
    user(minutesAgo(now, midnight, 30), 'check git status now'),
    assistant('m2', minutesAgo(now, midnight, 20), 'claude-sonnet-4-5', [
      { type: 'text', text: 'running' },
      { type: 'tool_use', id: 'tu-2', name: 'Bash', input: { command: 'git status --short' } },
    ], usage),
    user(minutesAgo(now, midnight, 10), 'thanks'),
    assistant('m3', minutesAgo(now, midnight, 5), 'claude-sonnet-4-5', [
      { type: 'text', text: 'done' },
    ], usage),
  ]
  await writeFile(join(projectDir, 's-lite.jsonl'), lines.join('\n') + '\n', 'utf-8')
}

beforeAll(async () => {
  await loadPricing()
})

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
  await mkdir(join(ROOT, 'home', '.claude'), { recursive: true })
  await mkdir(join(ROOT, 'cache'), { recursive: true })
  await mkdir(join(ROOT, 'no-desktop-sessions'), { recursive: true })
  await mkdir(join(ROOT, 'no-kimi-home'), { recursive: true })
  process.env['HOME'] = join(ROOT, 'home')
  process.env['CODEBURN_CACHE_DIR'] = join(ROOT, 'cache')
  process.env['CLAUDE_CONFIG_DIR'] = join(ROOT, 'home', '.claude')
  delete process.env['CLAUDE_CONFIG_DIRS']
  delete process.env['CODEX_HOME']
  process.env['USERPROFILE'] = join(ROOT, 'home')
  process.env['KIMI_CODE_HOME'] = join(ROOT, 'no-kimi-home')
  process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] = join(ROOT, 'no-desktop-sessions')
  await rm(CODEX_ROOT, { recursive: true, force: true })
  clearSessionCache()
})

afterEach(async () => {
  clearSessionCache()
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  if (existsSync(ROOT)) await rm(ROOT, { recursive: true, force: true })
  await rm(CODEX_ROOT, { recursive: true, force: true })
})

describe('overview lite parity', () => {
  it('reports byte-identical output with stripped payloads', async () => {
    await seedTodaySession()
    const range: DateRange = getDateRange('today').range

    clearSessionCache()
    const full = await parseAllSessions(range, 'all')
    const fullText = renderOverview(full, { label: 'Today', color: false })
    const fullData = buildPeriodData('lite-parity', full)
    const fullDays = aggregateProjectsIntoDays(full)

    clearSessionCache()
    const lite = await parseAllSessions(range, 'all', { stripForAggregate: true })
    const liteText = renderOverview(lite, { label: 'Today', color: false })
    const liteData = buildPeriodData('lite-parity', lite)
    const liteDays = aggregateProjectsIntoDays(lite)

    expect(liteText).toBe(fullText)
    expect(liteData.cost).toBe(fullData.cost)
    expect(liteData.calls).toBe(fullData.calls)
    expect(liteData.inputTokens).toBe(fullData.inputTokens)
    expect(liteData.outputTokens).toBe(fullData.outputTokens)
    expect(liteDays).toEqual(fullDays)
    expect(liteData.models).toEqual(fullData.models)
    expect(liteData.categories).toEqual(fullData.categories)

    // Structural: payloads stripped, billing/PR inputs kept.
    const liteCalls = lite.flatMap(p => p.sessions).flatMap(s => s.turns).flatMap(t => t.assistantCalls)
    const fullCalls = full.flatMap(p => p.sessions).flatMap(s => s.turns).flatMap(t => t.assistantCalls)
    expect(liteCalls.length).toBeGreaterThan(0)
    expect(liteCalls.length).toBe(fullCalls.length)
    for (const c of liteCalls) {
      expect(c.toolSequence).toBeUndefined()
      expect(c.deduplicationKey).toBe('')
    }
    const fullCommands = fullCalls.map(c => (c.toolSequence ?? []).flat().map(t => t.command).filter(Boolean)).filter(a => a.length > 0)
    const liteCommands = liteCalls.map(c => c.commands ?? []).filter(a => a.length > 0)
    expect(liteCommands).toEqual(fullCommands)
    const liteTexts = lite.flatMap(p => p.sessions).flatMap(s => s.turns).map(t => t.userMessage)
    expect(liteTexts).toContain('add retry logic to the uploader')
  })
})

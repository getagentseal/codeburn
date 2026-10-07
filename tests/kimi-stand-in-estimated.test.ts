// The K2.8 Preview stand-in flag is set where every call is read
// (cachedCallToApiCall), so it reaches calls from any provider, cold or warm.
// Own file because the codex provider captures CODEX_HOME at import.

import { afterAll, beforeEach, expect, it, vi } from 'vitest'
import { mkdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'

const testRoot = vi.hoisted(() => {
  const root = `${process.env['TMPDIR'] || '/tmp'}/kimi-stand-in-${process.pid}-${Date.now()}`
  process.env['HOME'] = `${root}/home`
  process.env['USERPROFILE'] = `${root}/home`
  process.env['CODEX_HOME'] = `${root}/codex`
  return root
})

const CODEX_HOME = join(testRoot, 'codex')
const CACHE_DIR = join(testRoot, 'cache')

beforeEach(() => {
  process.env['HOME'] = join(testRoot, 'home')
  process.env['USERPROFILE'] = join(testRoot, 'home')
  process.env['CODEX_HOME'] = CODEX_HOME
  process.env['CODEBURN_CACHE_DIR'] = CACHE_DIR
})

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true })
})

function rollout(id: string, day: string): string {
  const usage = { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 0, total_tokens: 1100 }
  return [
    JSON.stringify({ type: 'session_meta', timestamp: `${day}T10:00:00Z`, payload: { session_id: id, model: 'kimi-for-coding', cwd: '/Users/test/proj', originator: 'codex_cli_rs' } }),
    JSON.stringify({ type: 'response_item', timestamp: `${day}T10:00:10Z`, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } }),
    JSON.stringify({ type: 'event_msg', timestamp: `${day}T10:01:00Z`, payload: { type: 'token_count', info: { model: 'kimi-for-coding', last_token_usage: usage, total_token_usage: usage } } }),
  ].join('\n') + '\n'
}

it('marks kimi-for-coding calls from 11 Sep 2026 estimated on a cold parse and a cache-rehydrated read', async () => {
  await mkdir(join(CODEX_HOME, 'sessions', '2026', '09', '10'), { recursive: true })
  await mkdir(join(CODEX_HOME, 'sessions', '2026', '09', '12'), { recursive: true })
  await mkdir(CACHE_DIR, { recursive: true })
  await writeFile(join(CODEX_HOME, 'sessions', '2026', '09', '10', 'rollout-k27.jsonl'), rollout('k27', '2026-09-10'))
  await writeFile(join(CODEX_HOME, 'sessions', '2026', '09', '12', 'rollout-k28.jsonl'), rollout('k28', '2026-09-12'))

  const { clearSessionCache, parseAllSessions } = await import('../src/parser.js')
  const flags = (projects: Awaited<ReturnType<typeof parseAllSessions>>) => projects
    .flatMap(p => p.sessions).flatMap(s => s.turns).flatMap(t => t.assistantCalls)
    .map(c => [c.timestamp.slice(0, 10), c.isEstimated ?? false])
    .sort()

  clearSessionCache()
  expect(flags(await parseAllSessions(undefined, 'codex'))).toEqual([['2026-09-10', false], ['2026-09-12', true]])
  clearSessionCache()
  expect(flags(await parseAllSessions(undefined, 'codex'))).toEqual([['2026-09-10', false], ['2026-09-12', true]])
})

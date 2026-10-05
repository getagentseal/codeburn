// #1075, cost site 2 of 2. Codex is NOT on parser.ts's reported-cost
// pass-through allowlist, so the session cache stores its calls with
// `costUSD: undefined` and every warm run re-prices them from the stored token
// buckets in cachedCallToApiCall. That line and the one in the codex provider
// are twins: if only one drops the reasoning double-count, a user's number
// changes between a cold and a warm run. This drives the full parseAllSessions
// pipeline twice against the same file to prove they agree.
//
// Own file because the codex provider captures CODEX_HOME when its module is
// first evaluated, so the env must be set before any import of it.

import { afterAll, beforeEach, expect, it, vi } from 'vitest'
import { mkdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'

const testRoot = vi.hoisted(() => {
  const root = `${process.env['TMPDIR'] || '/tmp'}/codex-1075-rehydrate-${process.pid}-${Date.now()}`
  process.env['HOME'] = `${root}/home`
  process.env['USERPROFILE'] = `${root}/home`
  process.env['CODEX_HOME'] = `${root}/codex`
  return root
})

const CODEX_HOME = join(testRoot, 'codex')
const CACHE_DIR = join(testRoot, 'cache')

// gpt-5.5: input 5e-6, output 30e-6, cacheRead 5e-7 (src/data/litellm-snapshot.json).
// 800 uncached input + 200 cached + 1000 output, of which 400 are reasoning.
const EXPECTED = 800 * 5e-6 + 200 * 5e-7 + 1000 * 30e-6

beforeEach(() => {
  process.env['HOME'] = join(testRoot, 'home')
  process.env['USERPROFILE'] = join(testRoot, 'home')
  process.env['CODEX_HOME'] = CODEX_HOME
  process.env['CODEBURN_CACHE_DIR'] = CACHE_DIR
})

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true })
})

it('prices a codex call the same on a cold parse and a cache-rehydrated read', async () => {
  const sessionDir = join(CODEX_HOME, 'sessions', '2026', '08', '16')
  await mkdir(sessionDir, { recursive: true })
  await mkdir(CACHE_DIR, { recursive: true })
  const usage = { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 1000, reasoning_output_tokens: 400, total_tokens: 2000 }
  await writeFile(join(sessionDir, 'rollout-1075.jsonl'), [
    JSON.stringify({ type: 'session_meta', timestamp: '2026-08-16T10:00:00Z', payload: { session_id: 's1075', model: 'gpt-5.5', cwd: '/Users/test/proj', originator: 'codex_cli_rs' } }),
    JSON.stringify({ type: 'response_item', timestamp: '2026-08-16T10:00:10Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] } }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-08-16T10:01:00Z', payload: { type: 'token_count', info: { model: 'gpt-5.5', last_token_usage: usage, total_token_usage: usage } } }),
  ].join('\n') + '\n')

  const { clearSessionCache, parseAllSessions } = await import('../src/parser.js')

  clearSessionCache()
  const cold = await parseAllSessions(undefined, 'codex')
  const coldCost = cold.reduce((sum, p) => sum + p.totalCostUSD, 0)

  // Drop the in-memory cache only: session-cache.json on disk now serves the
  // unchanged file, so this run's cost comes out of cachedCallToApiCall.
  clearSessionCache()
  const warm = await parseAllSessions(undefined, 'codex')
  const warmCost = warm.reduce((sum, p) => sum + p.totalCostUSD, 0)

  // Revert only src/providers/codex.ts and the cold leg breaks; revert only
  // src/parser.ts's outputForCost and the warm leg breaks.
  expect(coldCost).toBeCloseTo(EXPECTED, 12)
  expect(warmCost).toBeCloseTo(EXPECTED, 12)
})

it('prices a pre-30-Jul auto-review as gpt-5.4 on a cold parse and a cache-rehydrated read', async () => {
  const sessionDir = join(CODEX_HOME, 'sessions', '2026', '06', '01')
  await mkdir(sessionDir, { recursive: true })
  await mkdir(CACHE_DIR, { recursive: true })
  const usage = { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 1000, reasoning_output_tokens: 400, total_tokens: 2000 }
  await writeFile(join(sessionDir, 'rollout-auto-review-date.jsonl'), [
    JSON.stringify({ type: 'session_meta', timestamp: '2026-06-01T10:00:00Z', payload: { session_id: 'sauto', model: 'codex-auto-review', cwd: '/Users/test/proj', originator: 'codex_cli_rs' } }),
    JSON.stringify({ type: 'response_item', timestamp: '2026-06-01T10:00:10Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'review' }] } }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-06-01T10:01:00Z', payload: { type: 'token_count', info: { model: 'codex-auto-review', last_token_usage: usage, total_token_usage: usage } } }),
  ].join('\n') + '\n')
  // gpt-5.4: input 2.5e-6, output 15e-6, cacheRead 2.5e-7.
  const expected = 800 * 2.5e-6 + 200 * 2.5e-7 + 1000 * 15e-6

  const { clearSessionCache, parseAllSessions } = await import('../src/parser.js')
  const autoReviewCost = (projects: Awaited<ReturnType<typeof parseAllSessions>>) => projects
    .flatMap(p => p.sessions).flatMap(s => s.turns).flatMap(t => t.assistantCalls)
    .filter(c => c.model === 'codex-auto-review')
    .reduce((sum, c) => sum + c.costUSD, 0)

  clearSessionCache()
  expect(autoReviewCost(await parseAllSessions(undefined, 'codex'))).toBeCloseTo(expected, 12)
  clearSessionCache()
  expect(autoReviewCost(await parseAllSessions(undefined, 'codex'))).toBeCloseTo(expected, 12)
})

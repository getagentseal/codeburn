// End-to-end regression for the dashboard Tok/s column (activeDurationMs /
// activeGeneratedTokens / toolWaitMs). providerCallToCachedCall used to drop
// the three throughput fields when converting a parsed codex call into a
// cached turn, so a mapper-level unit test passed while the aggregated
// modelBreakdown (and with it the dashboard column) stayed empty — the exact
// failure this test guards against. It drives the full parseAllSessions
// pipeline twice:
//
//   1. cold: the rollout is parsed and written to session-cache.json through
//      providerCallToCachedCall (the write hop);
//   2. warm: the file is byte-identical, so runParse serves the unchanged
//      file's turns from the on-disk cache via cachedCallToApiCall (the read
//      hop) without ever invoking the provider parser again.
//
// The fields must survive both hops to show up in modelBreakdown, which is the
// shape the dashboard aggregates (aggregateModelTotals) into its Tok/s column.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdir, rm, writeFile, appendFile } from 'fs/promises'
import { join } from 'path'

import { clearSessionCache, parseAllSessions } from '../src/parser.js'
import { aggregateModelTotals } from '../src/model-breakdown.js'

const testRoot = vi.hoisted(() => {
  const root = `${process.env['TMPDIR'] || '/tmp'}/codex-tps-roundtrip-${process.pid}-${Date.now()}`
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

// The single codex session in a parseAllSessions result, and its only
// modelBreakdown entry (keyed by the friendly short name, whatever it resolves
// to for the fixture model).
function firstModelEntry(projects: Awaited<ReturnType<typeof parseAllSessions>>) {
  expect(projects).toHaveLength(1)
  const sessions = projects[0]!.sessions
  expect(sessions).toHaveLength(1)
  const entries = Object.entries(sessions[0]!.modelBreakdown)
  expect(entries).toHaveLength(1)
  return entries[0]![1]
}

describe('codex active-throughput fields survive the session-cache round trip', () => {
  it('reaches modelBreakdown on a cold parse AND a warm cache read', async () => {
    const sessionDir = join(CODEX_HOME, 'sessions', '2026', '04', '14')
    await mkdir(sessionDir, { recursive: true })
    await mkdir(CACHE_DIR, { recursive: true })

    // Same shape as the fixture in tests/providers/codex.test.ts that yields
    // activeDurationMs 7000 / activeGeneratedTokens 120 / toolWaitMs 3000:
    // task_started -> 3s custom tool call (excluded as tool wait) ->
    // token_count (100 output + 20 reasoning) -> task_complete duration_ms 10s.
    const lines = [
      JSON.stringify({ type: 'session_meta', timestamp: '2026-04-14T10:00:00Z', payload: { session_id: 'sess-tps', model: 'gpt-5.5', cwd: '/Users/test/proj', originator: 'codex-cli' } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-04-14T10:00:00Z', payload: { type: 'task_started', turn_id: 'turn-1' } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-04-14T10:00:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run the tool' }] } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-04-14T10:00:02Z', payload: { type: 'custom_tool_call', call_id: 'call-1', name: 'exec' } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-04-14T10:00:05Z', payload: { type: 'custom_tool_call_output', call_id: 'call-1', output: 'done' } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-04-14T10:01:10Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, output_tokens: 100, reasoning_output_tokens: 20, total_tokens: 220 }, total_token_usage: { total_tokens: 220 } } } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-04-14T10:01:11Z', payload: { type: 'task_complete', duration_ms: 10_000 } }),
    ]
    await writeFile(join(sessionDir, 'rollout-tps.jsonl'), lines.join('\n') + '\n')

    // Run 1: cold cache. The fresh parse is immediately converted to cached
    // turns, so even this run crosses the providerCallToCachedCall write hop
    // before the query-time aggregation reads the cached turns back.
    clearSessionCache()
    const fresh = await parseAllSessions(undefined, 'codex')
    expect(firstModelEntry(fresh)).toMatchObject({
      activeDurationMs: 7000,
      activeGeneratedTokens: 120,
      toolWaitMs: 3000,
    })

    // Dashboard shape: aggregateModelTotals feeds the Tok/s column
    // (activeGeneratedTokens / (activeDurationMs / 1000)).
    const totals = aggregateModelTotals(fresh)
    expect(Object.values(totals)).toHaveLength(1)
    expect(Object.values(totals)[0]!).toMatchObject({ activeDurationMs: 7000, activeGeneratedTokens: 120 })

    // Run 2: warm cache. The rollout is byte-identical, so the unchanged file
    // is served straight from session-cache.json — the provider parser never
    // runs. These fields only exist if run 1 actually wrote them.
    clearSessionCache()
    const warm = await parseAllSessions(undefined, 'codex')
    expect(firstModelEntry(warm)).toMatchObject({
      activeDurationMs: 7000,
      activeGeneratedTokens: 120,
      toolWaitMs: 3000,
    })
  })

  it('reaches modelBreakdown on the append-resume path (mid-task cut then task_complete)', async () => {
    // The live-session case the cold/warm round trip does NOT cover: run 1
    // parses while a task is still running (token_count emitted, task_complete
    // not yet written), so the call is cached without timing. Run 2 re-parses
    // the GROWN file incrementally — the codex-results cache resumes from its
    // persisted state + byte offset and the carried task window attributes the
    // three throughput fields to the earlier-pass call. Without that window,
    // the fields stay missing exactly like they did before the mapper repair.
    const sessionDir = join(CODEX_HOME, 'sessions', '2026', '04', '15')
    // Hermetic: this `it` runs against whatever the previous one left behind
    // (its rollout file, both caches, and the in-memory result cache).
    await rm(join(CODEX_HOME, 'sessions'), { recursive: true, force: true })
    await mkdir(sessionDir, { recursive: true })
    await rm(join(CACHE_DIR, 'session-cache.v7.json'), { force: true })
    await rm(join(CACHE_DIR, 'codex-results.json'), { force: true })

    const midTaskLines = [
      JSON.stringify({ type: 'session_meta', timestamp: '2026-04-14T10:00:00Z', payload: { session_id: 'sess-append', model: 'gpt-5.5', cwd: '/Users/test/proj', originator: 'codex-cli' } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-04-14T10:00:00Z', payload: { type: 'task_started', turn_id: 'turn-1' } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-04-14T10:00:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run the tool' }] } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-04-14T10:00:02Z', payload: { type: 'custom_tool_call', call_id: 'call-1', name: 'exec' } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-04-14T10:00:05Z', payload: { type: 'custom_tool_call_output', call_id: 'call-1', output: 'done' } }),
      // NOTE: no task_complete yet — the rollout ends mid-task.
      JSON.stringify({ type: 'event_msg', timestamp: '2026-04-14T10:01:10Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, output_tokens: 100, reasoning_output_tokens: 20, total_tokens: 220 }, total_token_usage: { total_tokens: 220 } } } }),
    ]
    const filePath = join(sessionDir, 'rollout-append.jsonl')
    await writeFile(filePath, midTaskLines.join('\n') + '\n')

    // Run 1: mid-task parse — the call exists but has no timing yet.
    clearSessionCache()
    const midTask = await parseAllSessions(undefined, 'codex')
    expect(firstModelEntry(midTask)).not.toHaveProperty('activeDurationMs')

    // The task completes: Codex appends the task_complete line.
    await appendFile(filePath, JSON.stringify({ type: 'event_msg', timestamp: '2026-04-14T10:01:11Z', payload: { type: 'task_complete', duration_ms: 10_000 } }) + '\n')

    // Run 2: the grown file re-parses through the append-resume path; the
    // fields must now survive into modelBreakdown.
    clearSessionCache()
    const appended = await parseAllSessions(undefined, 'codex')
    expect(firstModelEntry(appended)).toMatchObject({
      activeDurationMs: 7000,
      activeGeneratedTokens: 120,
      toolWaitMs: 3000,
    })

    // Dashboard shape: the Tok/s column aggregates the same fields.
    const totals = aggregateModelTotals(appended)
    expect(Object.values(totals)).toHaveLength(1)
    expect(Object.values(totals)[0]!).toMatchObject({ activeDurationMs: 7000, activeGeneratedTokens: 120 })
  })
})

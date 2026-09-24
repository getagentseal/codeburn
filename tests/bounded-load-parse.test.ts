// End to end through parseProviderSources: a ranged parse holds out-of-range
// rollouts as stubs, and a stub must still do everything its entry would
// outside the summaries (claim its dedup keys in serve order, be evicted from
// disk when its source is deleted). Codex captures CODEX_HOME when its module
// is first imported, hence the env before the dynamic imports.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import type { DateRange } from '../src/types.js'

const tmpDir = mkdtempSync(join(tmpdir(), 'bounded-load-'))
const savedCodexHome = process.env['CODEX_HOME']
process.env['CODEX_HOME'] = join(tmpDir, 'codex')

const { cacheStubs, clearLoadCacheMemo, loadCache, markCacheDirty, monthScopeForRange, saveCache, sessionCacheDir } = await import('../src/session-cache.js')
const { clearSessionCache, parseAllSessions, withColdFirstPaintFloor } = await import('../src/parser.js')
const { clearCodexMemCaches } = await import('../src/codex-cache.js')

const ENV_KEYS = ['CODEBURN_CACHE_DIR', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CONFIG_DIRS', 'CODEBURN_DESKTOP_SESSIONS_DIR', 'CODEBURN_CACHE_SCOPE'] as const
const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
let run = 0

function rollout(day: string, sid: string, startIso: string, n: number): string {
  const dir = join(tmpDir, 'codex', 'sessions', '2099', day.slice(0, 2), day.slice(3))
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `rollout-2099-${day}T10-00-00-${sid}.jsonl`)
  const lines = [
    { type: 'session_meta', timestamp: startIso, payload: { id: sid, session_id: sid, cwd: `/work/${sid}`, originator: 'codex_cli_rs', model: 'gpt-5.3-codex', cli_version: '0.50.0' } },
    { type: 'turn_context', timestamp: startIso, payload: { cwd: `/work/${sid}`, model: 'gpt-5.3-codex' } },
  ]
  const total = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 }
  for (let i = 0; i < n; i++) {
    const ts = new Date(Date.parse(startIso) + i * 60_000).toISOString()
    const last = { input_tokens: 1000 + i, cached_input_tokens: 100, output_tokens: 50 + i, reasoning_output_tokens: 0, total_tokens: 1050 + 2 * i }
    for (const k of Object.keys(total) as Array<keyof typeof total>) total[k] += last[k]
    lines.push({ type: 'response_item', timestamp: ts, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `step ${i}` }] } } as never)
    lines.push({ type: 'event_msg', timestamp: ts, payload: { type: 'token_count', info: { last_token_usage: last, total_token_usage: { ...total } } } } as never)
  }
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  return path
}

const may1: DateRange = { start: new Date('2099-05-01T00:00:00.000Z'), end: new Date('2099-05-01T23:59:59.999Z') }
const calls = (projects: Awaited<ReturnType<typeof parseAllSessions>>): number => projects.reduce((n, p) => n + p.totalApiCalls, 0)
const cost = (projects: Awaited<ReturnType<typeof parseAllSessions>>): number => projects.reduce((n, p) => n + p.totalCostUSD, 0)

beforeEach(() => {
  rmSync(join(tmpDir, 'codex'), { recursive: true, force: true })
  process.env['CODEBURN_CACHE_DIR'] = join(tmpDir, `cache-${run++}`)
  process.env['CLAUDE_CONFIG_DIR'] = join(tmpDir, 'no-claude')
  process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] = join(tmpDir, 'no-desktop')
  delete process.env['CLAUDE_CONFIG_DIRS']
  delete process.env['CODEBURN_CACHE_SCOPE']
  clearSessionCache()
  clearLoadCacheMemo()
  clearCodexMemCaches()
})

afterAll(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  if (savedCodexHome === undefined) delete process.env['CODEX_HOME']
  else process.env['CODEX_HOME'] = savedCodexHome
  rmSync(tmpDir, { recursive: true, force: true })
})

async function reparse(range: DateRange, scope?: 'all'): Promise<Awaited<ReturnType<typeof parseAllSessions>>> {
  clearSessionCache()
  clearLoadCacheMemo()
  clearCodexMemCaches()
  if (scope) process.env['CODEBURN_CACHE_SCOPE'] = scope
  else delete process.env['CODEBURN_CACHE_SCOPE']
  return parseAllSessions(range, 'codex')
}

describe('bounded load through the provider parse', () => {
  it('replays a stub\'s dedup keys in serve order, exactly as its full entry would', async () => {
    const old = rollout('04-10', 'aaold', '2099-04-10T10:00:00.000Z', 3)
    const today = rollout('05-01', 'bbtoday', '2099-05-01T10:00:00.000Z', 2)
    await parseAllSessions(undefined, 'codex')

    // Give the in-range file a turn that carries one of the old file's keys, as
    // a file parsed before the other was cached can.
    clearLoadCacheMemo()
    const full = await loadCache()
    const section = full.providers['codex']!
    const oldKey = section.files[old]!.turns[0]!.calls[0]!.deduplicationKey
    section.files[today]!.turns[1]!.calls[0]!.deduplicationKey = oldKey
    markCacheDirty(full, 'codex', today)
    expect(await saveCache(full)).toBe(true)

    clearLoadCacheMemo()
    const scoped = await loadCache(monthScopeForRange(may1.start, may1.end))
    expect([...cacheStubs(scoped, 'codex')!.keys()]).toEqual([old])

    const bounded = await reparse(may1)
    const reference = await reparse(may1, 'all')
    expect(calls(bounded)).toBe(1)
    expect(calls(bounded)).toBe(calls(reference))
    expect(cost(bounded)).toBe(cost(reference))

    // The first-paint snapshot serves every cached entry as an orphan, in load
    // order: the stub has to take its full entry's place in that order too.
    const snapshot = async (scope?: 'all') => {
      clearSessionCache(); clearLoadCacheMemo(); clearCodexMemCaches()
      if (scope) process.env['CODEBURN_CACHE_SCOPE'] = scope
      else delete process.env['CODEBURN_CACHE_SCOPE']
      return (await withColdFirstPaintFloor(may1.start, () => parseAllSessions(may1, 'codex'), true, true)).result
    }
    const boundedSnapshot = await snapshot()
    expect(calls(boundedSnapshot)).toBe(1)
    expect(JSON.stringify(boundedSnapshot)).toBe(JSON.stringify(await snapshot('all')))
  })

  it('evicts a deleted transcript that was only a stub from its piece on disk', async () => {
    const doomed = rollout('04-10', 'aadoomed', '2099-04-10T10:00:00.000Z', 2)
    const kept = rollout('04-10', 'cckept', '2099-04-10T12:00:00.000Z', 2)
    rollout('05-01', 'bbtoday', '2099-05-01T10:00:00.000Z', 2)
    await parseAllSessions(undefined, 'codex')
    const aprilPiece = async (): Promise<string> => {
      const envelope = JSON.parse(await readFile(join(sessionCacheDir(), 'envelope.json'), 'utf-8'))
      const index = JSON.parse(await readFile(join(sessionCacheDir(), envelope.providers.codex.index), 'utf-8'))
      return readFile(join(sessionCacheDir(), index.pieces['2099-04-10']), 'utf-8')
    }
    const before = await aprilPiece()
    const line = (text: string, path: string) => text.split('\n').find(l => l.startsWith(JSON.stringify(path) + ':'))?.replace(/,$/, '')
    expect(line(before, doomed)).toBeDefined()

    clearLoadCacheMemo()
    const scoped = await loadCache(monthScopeForRange(may1.start, may1.end))
    expect([...cacheStubs(scoped, 'codex')!.keys()].sort()).toEqual([doomed, kept].sort())

    rmSync(doomed)
    await reparse(may1)
    const after = await aprilPiece()
    expect(after).not.toContain(doomed)
    expect(line(after, kept)).toBe(line(before, kept))
    expect(Object.keys(JSON.parse(after))).toEqual([kept])
  })
})

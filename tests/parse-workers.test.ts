import { spawnSync } from 'node:child_process'
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { decideParseWorkers, ParseWorkerPool, parseFilesInOrder, type ClaudeWorkerParse } from '../src/parse-workers.js'
import { clearSessionCache, parseAllSessions, parseClaudeFileFull } from '../src/parser.js'
import { parseCodexFileFull, type CodexFullParse } from '../src/providers/codex.js'
import type { SessionSource } from '../src/providers/types.js'

// Two full cold CLI parses of a multi-hundred-file corpus, plus in-process parses
// that spawn real threads.
vi.setConfig({ testTimeout: 60_000 })

const BIG_SYSTEM = { cores: 16, availableBytes: 32 * 1024 ** 3 }
const BIG_PENDING = { files: 5000, bytes: 6 * 1024 ** 3 }
const NO_ENV = {} as NodeJS.ProcessEnv

describe('decideParseWorkers', () => {
  it('scales with cores, memory budget and pending file count', () => {
    // 15 (cores-1) vs 8 (2 GB budget / 256 MB) vs 100 (5000/50) -> memory cap wins
    expect(decideParseWorkers(BIG_PENDING, BIG_SYSTEM, NO_ENV).workers).toBe(8)
    // Fewer cores than the memory budget allows -> cores-1 wins
    expect(decideParseWorkers(BIG_PENDING, { cores: 6, availableBytes: 32 * 1024 ** 3 }, NO_ENV).workers).toBe(5)
    // 8 GB reaches the same cap as 32 GB: a quarter of it is the 2 GB budget
    expect(decideParseWorkers(BIG_PENDING, { cores: 16, availableBytes: 8 * 1024 ** 3 }, NO_ENV).workers).toBe(8)
    // Under that, the quarter-of-available budget is the binding constraint
    expect(decideParseWorkers(BIG_PENDING, { cores: 16, availableBytes: 6 * 1024 ** 3 }, NO_ENV).workers).toBe(6)
    // The smallest machine that clears every gate still only earns 2 threads
    expect(decideParseWorkers({ files: 200, bytes: 300 * 1024 ** 2 }, { cores: 3, availableBytes: 4 * 1024 ** 3 }, NO_ENV).workers).toBe(2)
    // Big average file: the per-worker budget scales with it (2 x 260 MB + 128 MB),
    // so the same 2 GB buys 3 threads instead of the 8 a flat 256 MB would.
    expect(decideParseWorkers({ files: 250, bytes: 65 * 1024 ** 3 }, BIG_SYSTEM, NO_ENV).workers).toBe(3)
    // 300 files earn 6, but the 6 GB behind them earn 30 — bytes win, then the
    // memory budget caps it. A Codex corpus is exactly this shape.
    expect(decideParseWorkers({ files: 300, bytes: 6 * 1024 ** 3 }, BIG_SYSTEM, NO_ENV).workers).toBe(8)
    // Few enough files AND bytes that MIN_FILES_PER_WORKER is the binding constraint
    expect(decideParseWorkers({ files: 300, bytes: 700 * 1024 ** 2 }, BIG_SYSTEM, NO_ENV).workers).toBe(6)
  })

  it('stays serial on low-spec machines and on warm/small parses', () => {
    expect(decideParseWorkers(BIG_PENDING, { cores: 2, availableBytes: 32 * 1024 ** 3 }, NO_ENV).workers).toBe(0)
    // A 4 GB box: availableMemory() always reads a little under the nominal size
    expect(decideParseWorkers(BIG_PENDING, { cores: 16, availableBytes: 3.9 * 1024 ** 3 }, NO_ENV).workers).toBe(0)
    // Warm/incremental: the byte gate is not reached
    expect(decideParseWorkers({ files: 12, bytes: 10 * 1024 ** 2 }, BIG_SYSTEM, NO_ENV).workers).toBe(0)
  })

  it('gates on bytes alone, so a thin corpus never spawns threads it cannot pay for', () => {
    // 250 files holding under a megabyte between them: threads made this ~5% slower
    expect(decideParseWorkers({ files: 250, bytes: 917 * 1024 }, BIG_SYSTEM, NO_ENV).workers).toBe(0)
    expect(decideParseWorkers({ files: 5000, bytes: 10 * 1024 ** 2 }, BIG_SYSTEM, NO_ENV).workers).toBe(0)
    expect(decideParseWorkers({ files: 250, bytes: 917 * 1024 }, BIG_SYSTEM, NO_ENV).reason)
      .toContain('below 210 MB pending')
    // 150 rollouts over the byte gate: far under any file-count threshold, and the
    // biggest workload there is
    expect(decideParseWorkers({ files: 150, bytes: 4 * 1024 ** 3 }, BIG_SYSTEM, NO_ENV).workers).toBe(8)
  })

  it('honours CODEBURN_PARSE_WORKERS, which also bypasses the auto gates', () => {
    expect(decideParseWorkers(BIG_PENDING, BIG_SYSTEM, { CODEBURN_PARSE_WORKERS: '0' }).workers).toBe(0)
    expect(decideParseWorkers(BIG_PENDING, BIG_SYSTEM, { CODEBURN_PARSE_WORKERS: '4' }).workers).toBe(4)
    // Capped by the core count
    expect(decideParseWorkers(BIG_PENDING, { cores: 4, availableBytes: 32 * 1024 ** 3 }, { CODEBURN_PARSE_WORKERS: '32' }).workers).toBe(4)
    // A tiny fixture corpus still gets threads when forced — that is what makes
    // the determinism test below able to exercise them at all.
    expect(decideParseWorkers({ files: 3, bytes: 1000 }, BIG_SYSTEM, { CODEBURN_PARSE_WORKERS: '3' }).workers).toBe(3)
    expect(decideParseWorkers(BIG_PENDING, BIG_SYSTEM, { CODEBURN_PARSE_WORKERS: 'nonsense' }).workers).toBe(0)
  })

  it('reports the decision inputs in every reason, gate or not', () => {
    for (const d of [
      decideParseWorkers(BIG_PENDING, BIG_SYSTEM, NO_ENV),
      decideParseWorkers({ files: 12, bytes: 1000 }, BIG_SYSTEM, NO_ENV),
      decideParseWorkers(BIG_PENDING, BIG_SYSTEM, { CODEBURN_PARSE_WORKERS: '2' }),
    ]) {
      expect(d.reason).toContain('16 cores')
      expect(d.reason).toContain('GB available')
      expect(d.reason).toContain('pending files')
    }
  })
})

type Turn = { id: string; t: number }

function sessionLines(project: string, session: string, turns: Turn[]): string {
  const lines: string[] = []
  for (const { id, t } of turns) {
    const ts = new Date(Date.UTC(2026, 4, 4 + (t % 5), 9, t % 60, 0)).toISOString()
    const gitBranch = t % 3 === 0 ? 'main' : 'feature'
    lines.push(JSON.stringify({
      type: 'user', sessionId: session, timestamp: ts, cwd: `/tmp/proj${project}`, gitBranch,
      message: { role: 'user', content: `task ${t} in ${project}` },
    }))
    lines.push(JSON.stringify({
      type: 'assistant', sessionId: session, timestamp: ts, cwd: `/tmp/proj${project}`, gitBranch,
      message: {
        id, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
        content: [
          { type: 'text', text: 'x'.repeat(200) },
          { type: 'tool_use', id: `tu-${id}`, name: 'Edit', input: { file_path: '/tmp/x', old_string: 'a', new_string: 'b' } },
        ],
        usage: { input_tokens: 400 + t, output_tokens: 40 + t, cache_read_input_tokens: 9 },
      },
    }))
  }
  return lines.join('\n') + '\n'
}

const range = (n: number, from = 0): number[] => Array.from({ length: n }, (_, i) => i + from)

async function writeCorpus(claudeDir: string, projects: number, filesPerProject: number): Promise<string[]> {
  const written: string[] = []
  for (let p = 0; p < projects; p++) {
    const dir = join(claudeDir, 'projects', `-tmp-proj${p}`)
    await mkdir(dir, { recursive: true })
    for (let f = 0; f < filesPerProject; f++) {
      const session = `${p}${f}`.padStart(8, '0') + '-aaaa-bbbb-cccc-000000000000'
      const path = join(dir, `${session}.jsonl`)
      await writeFile(path, sessionLines(String(p), session, range(12).map(t => ({ id: `msg-${p}-${session}-${t}`, t }))))
      written.push(path)
    }
  }
  return written
}

/// A resumed Claude session: the new transcript restates the original's assistant
/// messages verbatim (same message ids) before adding its own. Cross-file dedup
/// means whichever file is installed FIRST keeps those turns and the other loses
/// them, so this fixture is only stable if worker results are installed in the
/// serial order — and it is the only fixture that drives the discard/re-parse path,
/// since a worker parses against an empty dedup set and cannot see the overlap.
async function writeResumedPair(claudeDir: string, tag: string, originalName: string, resumedName: string): Promise<void> {
  const dir = join(claudeDir, 'projects', `-tmp-${tag}`)
  await mkdir(dir, { recursive: true })
  const shared = range(6).map(t => ({ id: `${tag}-m${t}`, t }))
  await writeFile(join(dir, `${originalName}.jsonl`), sessionLines(tag, originalName, shared))
  await writeFile(
    join(dir, `${resumedName}.jsonl`),
    sessionLines(tag, resumedName, [...shared, ...range(4, 6).map(t => ({ id: `${tag}-n${t}`, t }))]),
  )
}

type CodexTask = { n: number; at: string }

/// One Codex rollout: session_meta plus a complete task cycle per entry. A
/// token_count dedup key is namespaced by the FORK PARENT when there is one and
/// keyed on the cumulative token breakdown, so a fork restating a parent's tasks
/// emits exactly the parent's keys — the cross-file overlap that only the
/// install-order check can resolve. The replayed tasks are timestamped well past
/// `metaTs + 5s` on purpose: inside that window the parser drops replays outright
/// and the dedup path would never be reached.
function codexRollout(sessionId: string, cwd: string, tasks: CodexTask[], forkedFrom?: string, metaTs = '2026-05-04T09:00:00.000Z'): string {
  const lines = [JSON.stringify({
    type: 'session_meta',
    timestamp: metaTs,
    payload: {
      cwd, originator: 'codex-cli', session_id: sessionId, model: 'gpt-5.3-codex',
      ...(forkedFrom ? { forked_from_id: forkedFrom } : {}),
    },
  })]
  lines.push(...codexTaskLines(tasks))
  return lines.join('\n') + '\n'
}

function codexTaskLines(tasks: CodexTask[]): string[] {
  const lines: string[] = []
  for (const { n, at } of tasks) {
    const ts = (s: number) => new Date(Date.parse(at) + s * 1000).toISOString()
    lines.push(
      JSON.stringify({ type: 'event_msg', timestamp: ts(0), payload: { type: 'task_started' } }),
      JSON.stringify({ type: 'response_item', timestamp: ts(1), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `codex task ${n}` }] } }),
      JSON.stringify({ type: 'response_item', timestamp: ts(2), payload: { type: 'function_call', name: 'shell', call_id: `c${n}`, arguments: JSON.stringify({ command: `ls ${n}` }) } }),
      JSON.stringify({ type: 'response_item', timestamp: ts(3), payload: { type: 'function_call_output', call_id: `c${n}` } }),
      JSON.stringify({ type: 'event_msg', timestamp: ts(4), payload: { type: 'patch_apply_end', success: true, changes: { [`/tmp/cx/f${n}.ts`]: { unified_diff: '@@ -1 +1,2 @@\n-old\n+new\n+extra\n' } } } }),
      JSON.stringify({ type: 'response_item', timestamp: ts(5), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'y'.repeat(120) }] } }),
      JSON.stringify({
        type: 'event_msg', timestamp: ts(6),
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 50, reasoning_output_tokens: 10, total_tokens: 180 },
            total_token_usage: { input_tokens: 100 * n, cached_input_tokens: 20 * n, output_tokens: 50 * n, reasoning_output_tokens: 10 * n, total_tokens: 160 * n },
          },
        },
      }),
      JSON.stringify({ type: 'event_msg', timestamp: ts(7), payload: { type: 'task_complete', duration_ms: 4000 } }),
    )
  }
  return lines
}

async function writeCodexRollout(codexHome: string, day: string, name: string, body: string): Promise<string> {
  const dir = join(codexHome, 'sessions', '2026', '05', day)
  await mkdir(dir, { recursive: true })
  const path = join(dir, `rollout-${name}.jsonl`)
  await writeFile(path, body)
  return path
}

/// A parent rollout and a fork that replays its tasks before adding its own.
/// `parentFirst` flips which file is created first, since discovery follows
/// directory order: the shared keys must land on whichever file the SERIAL loop
/// reaches first, in either order.
async function writeForkedCodexPair(codexHome: string, day: string, tag: string, parentFirst: boolean): Promise<void> {
  const shared = [1, 2, 3].map(n => ({ n, at: `2026-05-04T09:${String(10 + n).padStart(2, '0')}:00.000Z` }))
  const parent = codexRollout(`${tag}-parent`, `/tmp/cx${tag}`, shared)
  const fork = codexRollout(
    `${tag}-fork`,
    `/tmp/cx${tag}`,
    [...shared.map(t => ({ ...t, at: `2026-05-04T10:${String(10 + t.n).padStart(2, '0')}:00.000Z` })), { n: 4, at: '2026-05-04T10:30:00.000Z' }],
    `${tag}-parent`,
  )
  const order: Array<[string, string]> = parentFirst
    ? [[`${tag}-a-parent`, parent], [`${tag}-b-fork`, fork]]
    : [[`${tag}-a-fork`, fork], [`${tag}-b-parent`, parent]]
  for (const [name, body] of order) await writeCodexRollout(codexHome, day, name, body)
}

/// Cache shard file names carry a random nonce, so compare bodies keyed by
/// `<provider>.<month>` instead of by file name.
async function shardBodies(cacheDir: string): Promise<Record<string, string>> {
  const dir = join(cacheDir, 'session-cache.v9')
  const out: Record<string, string> = {}
  for (const name of (await readdir(dir).catch(() => []))) {
    if (name === 'envelope.json' || !name.endsWith('.json')) continue
    const key = name.split('.').slice(0, 2).join('.')
    out[key] = createHash('sha256').update(await readFile(join(dir, name))).digest('hex')
  }
  return out
}

/// The Codex incremental cache is a single JSON file; both runs read the same
/// rollouts, so it must come out identical byte for byte.
async function codexResults(cacheDir: string): Promise<string | null> {
  const { codexCacheFileName } = await import('../src/codex-cache.js')
  return readFile(join(cacheDir, codexCacheFileName()), 'utf-8').catch(() => null)
}

function runCli(args: string[], home: string, extraEnv: Record<string, string>) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      CODEX_HOME: join(home, '.codex'),
      CODEBURN_CACHE_DIR: join(home, '.cache', 'codeburn'),
      HOME: home,
      TZ: 'UTC',
      ...extraEnv,
    },
    encoding: 'utf-8',
    timeout: 60_000,
  })
}

function stripVolatile(payload: unknown): unknown {
  if (Array.isArray(payload)) return payload.map(stripVolatile)
  if (payload && typeof payload === 'object') {
    return Object.fromEntries(
      Object.entries(payload as Record<string, unknown>)
        .filter(([k]) => !k.toLowerCase().startsWith('generated'))
        .map(([k, v]) => [k, stripVolatile(v)]),
    )
  }
  if (typeof payload === 'number') return Math.round(payload * 1e9) / 1e9
  return payload
}

describe('parallel cold parse', () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'cb-cold-'))
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  /// Both runs read the SAME corpus, so the absolute paths embedded in the cache
  /// shards match and the bodies can be compared byte for byte.
  async function bothWays(extraParallelEnv: Record<string, string> = {}) {
    const serialCache = join(home, 'cache-serial')
    const parallelCache = join(home, 'cache-parallel')
    const args = ['status', '--format', 'menubar-json']
    const serial = runCli(args, home, { CODEBURN_PARSE_WORKERS: '0', CODEBURN_CACHE_DIR: serialCache })
    const parallel = runCli(args, home, { CODEBURN_PARSE_WORKERS: '3', CODEBURN_CACHE_DIR: parallelCache, ...extraParallelEnv })

    expect(serial.status, serial.stderr).toBe(0)
    expect(parallel.status, parallel.stderr).toBe(0)
    expect(stripVolatile(JSON.parse(parallel.stdout))).toEqual(stripVolatile(JSON.parse(serial.stdout)))

    const serialShards = await shardBodies(serialCache)
    expect(Object.keys(serialShards).length).toBeGreaterThan(0)
    expect(await shardBodies(parallelCache)).toEqual(serialShards)
    // Byte-compared, not deep-equalled: the Codex cache is written entry by entry
    // in install order, so the key order is itself a claim about that order.
    expect(await codexResults(parallelCache)).toEqual(await codexResults(serialCache))
    return parallel
  }

  // The whole point of the feature: threads may only ever be a speed change.
  it('produces an identical payload and byte-identical cache shards with and without workers', async () => {
    await writeCorpus(join(home, '.claude'), 4, 12)
    await bothWays()
  })

  // Resumed sessions in both filename orders: the restating file sorts after the
  // original in one project and before it in the other, so install order decides
  // which file keeps the shared turns either way. Out-of-order installation, or
  // any attempt to patch overlapping turns out of a worker result instead of
  // discarding the whole file, changes the answer.
  it("matches the serial parse when files restate each other's message ids", async () => {
    const claude = join(home, '.claude')
    await writeResumedPair(claude, 'fwd', '00000000-aaaa-bbbb-cccc-000000000000', '99999999-aaaa-bbbb-cccc-000000000000')
    await writeResumedPair(claude, 'rev', '99999999-dddd-bbbb-cccc-000000000000', '00000000-dddd-bbbb-cccc-000000000000')

    const parallel = await bothWays({ CODEBURN_VERBOSE: '1' })

    // Pin that the discard path actually ran rather than passing by luck.
    const overlaps = [...parallel.stderr.matchAll(/(\d+)\/\d+ results re-parsed in-process on id overlap/g)]
      .reduce((n, m) => n + Number(m[1]), 0)
    expect(overlaps).toBeGreaterThan(0)
  })

  // Codex is the bigger half of a real cold parse, and its cross-file dedup is
  // stronger than Claude's: a forked rollout replays its parent's token_count
  // history under the PARENT's key namespace, so two files claim the same keys
  // outright. Both fork orders are present, so install order decides which file
  // keeps the shared tasks either way.
  it('matches the serial parse for a mixed Claude + Codex corpus with forked rollouts', async () => {
    await writeCorpus(join(home, '.claude'), 2, 6)
    const codex = join(home, '.codex')
    await writeForkedCodexPair(codex, '04', 'fwd', true)
    await writeForkedCodexPair(codex, '05', 'rev', false)
    for (const n of range(4)) {
      await writeCodexRollout(codex, '06', `plain-${n}`, codexRollout(`plain-${n}`, `/tmp/cx${n}`, [1, 2].map(t => ({ n: t, at: `2026-05-06T0${n}:${t}0:00.000Z` }))))
    }

    const parallel = await bothWays({ CODEBURN_VERBOSE: '1' })

    expect(parallel.stderr).toContain('codeburn: codex parse workers=3')
    // Pin that the codex-cache comparison in bothWays was not vacuous.
    expect(await codexResults(join(home, 'cache-parallel'))).toContain('rollout-')
    // Pin that the codex discard path actually ran rather than passing by luck.
    const codexDiscards = [...parallel.stderr.matchAll(/codex parse workers done, (\d+)\/\d+ results/g)]
      .reduce((n, m) => n + Number(m[1]), 0)
    expect(codexDiscards).toBeGreaterThan(0)
  })

  // Workers only ever run WHOLE-file decodes. A rollout that grew by a few KB is
  // resumed from its last task boundary in-process: a thread hop would cost more
  // than it saves, and the resume state lives in the parent's codex cache.
  it('never hands a resumable rollout to a worker', async () => {
    const codex = join(home, '.codex')
    const path = await writeCodexRollout(codex, '04', 'grow', codexRollout('grow', '/tmp/cxg', [1, 2, 3].map(n => ({ n, at: `2026-05-04T09:${n}0:00.000Z` }))))
    const cache = join(home, 'cache-inc')
    const args = ['status', '--format', 'menubar-json']

    const cold = runCli(args, home, { CODEBURN_PARSE_WORKERS: '3', CODEBURN_CACHE_DIR: cache, CODEBURN_VERBOSE: '1' })
    expect(cold.status, cold.stderr).toBe(0)
    expect(cold.stderr).toContain('codeburn: codex parse workers=3')

    await appendFile(path, codexTaskLines([{ n: 4, at: '2026-05-04T09:40:00.000Z' }]).join('\n') + '\n')
    // `status --format menubar-json` now persists a corpus-fingerprint-keyed
    // snapshot of its rendered payload (see src/session-cache.ts's
    // loadStatusSnapshot/saveStatusSnapshot) and defers a fingerprint
    // mismatch for up to CODEBURN_STATUS_SNAPSHOT_SETTLE_MS before doing a
    // real recompute, so the appended line above would otherwise just be
    // served from the (correctly!) settling snapshot with no parse at all.
    // Force the window to 0 so this "warm" run actually reaches the parse
    // pipeline this test is exercising.
    const warm = runCli(args, home, { CODEBURN_PARSE_WORKERS: '3', CODEBURN_CACHE_DIR: cache, CODEBURN_VERBOSE: '1', CODEBURN_STATUS_SNAPSHOT_SETTLE_MS: '0' })
    expect(warm.status, warm.stderr).toBe(0)
    expect(warm.stderr).toContain('codeburn: codex parse workers=0 (no full parses pending)')
  })
})

describe('ParseWorkerPool', () => {
  let home: string
  let files: string[]
  let codexPath: string
  let codexSource: SessionSource

  beforeEach(async () => {
    clearSessionCache()
    home = await mkdtemp(join(tmpdir(), 'cb-pool-'))
    files = await writeCorpus(join(home, '.claude'), 2, 4)
    codexPath = await writeCodexRollout(
      join(home, '.codex'), '04', 'pool',
      codexRollout('pool-1', '/tmp/cx', [1, 2].map(n => ({ n, at: `2026-05-04T09:${n}0:00.000Z` }))),
    )
    codexSource = { provider: 'codex', path: codexPath, project: 'tmp-cx' }
    process.env['CLAUDE_CONFIG_DIR'] = join(home, '.claude')
    // Isolated so a parse in this process can never walk the developer's own
    // ~/.codex, and so the pool the Codex path opens is covered by the leak check.
    process.env['CODEX_HOME'] = join(home, '.codex')
    process.env['CODEBURN_CACHE_DIR'] = join(home, '.cache', 'codeburn')
  })

  afterEach(async () => {
    clearSessionCache()
    delete process.env['CODEBURN_PARSE_WORKERS']
    delete process.env['CODEX_HOME']
    await rm(home, { recursive: true, force: true })
  })

  function liveWorkers(): number {
    return process.getActiveResourcesInfo().filter(r => r === 'Worker').length
  }

  it('returns results in submission order and terminates every thread on close', async () => {
    const before = liveWorkers()
    const pool = new ParseWorkerPool(3)
    const results = []
    for await (const r of parseFilesInOrder<ClaudeWorkerParse>(pool, files.map(filePath => ({ kind: 'claude' as const, filePath })))) results.push(r)
    await pool.close()

    expect(results).toHaveLength(files.length)
    for (const r of results) expect(r.ok).toBe(true)
    // Each fixture session's first turn names its own project, which pins the
    // yielded order to the submitted order rather than to completion order.
    const projects = results.map(r => (r.ok && r.parsed ? r.parsed.turns[0]?.userMessage : undefined))
    expect(projects).toEqual(files.map((_, i) => `task 0 in ${Math.floor(i / 4)}`))
    expect(liveWorkers()).toBe(before)
  })

  // A worker that cannot answer must hand the file back, never drop it: the
  // caller's fallback is an in-process parse, and it has to land on the same
  // result the worker would have produced.
  it('reports failures instead of throwing, and the serial fallback matches', async () => {
    const pool = new ParseWorkerPool(1)
    const fromWorker = await pool.submit<ClaudeWorkerParse>({ kind: 'claude', filePath: files[0]! })
    await pool.close()

    const afterClose = await pool.submit({ kind: 'claude', filePath: files[1]! })
    expect(afterClose.ok).toBe(false)

    const serial = await parseClaudeFileFull(files[0]!, new Set<string>())
    expect(fromWorker.ok).toBe(true)
    if (!fromWorker.ok || !fromWorker.parsed) throw new Error('expected a parsed result')
    const { msgIds, path, ...worker } = fromWorker.parsed
    expect(msgIds.length).toBeGreaterThan(0)
    // Echoed back so the parent can assert the positional worker/file pairing.
    expect(path).toBe(files[0])
    expect(worker).toEqual(JSON.parse(JSON.stringify(serial)))
  })


  // Same contract for a Codex rollout: the off-thread decode is the serial
  // decode, including the cache entry the parent has to install, and a worker
  // that cannot answer hands the file back for an in-process parse.
  it('decodes a codex rollout off-thread exactly as the serial path does', async () => {
    const before = liveWorkers()
    const pool = new ParseWorkerPool(1)
    const fromWorker = await pool.submit<CodexFullParse & { keys: string[] }>({ kind: 'codex', source: codexSource })
    await pool.close()
    expect(liveWorkers()).toBe(before)

    const afterClose = await pool.submit({ kind: 'codex', source: codexSource })
    expect(afterClose.ok).toBe(false)

    const seen = new Set<string>()
    const serial = await parseCodexFileFull(codexSource, seen)
    if (!fromWorker.ok || !fromWorker.parsed) throw new Error('expected a parsed result')
    const { keys, path, ...worker } = fromWorker.parsed
    expect(keys.length).toBeGreaterThan(0)
    expect(new Set(keys)).toEqual(seen)
    // Echoed back so the parent can assert the positional worker/file pairing.
    expect(path).toBe(codexPath)
    expect(worker).toEqual(JSON.parse(JSON.stringify(serial)))
    // The decode itself must never have touched the codex cache file.
    expect(await codexResults(join(home, '.cache', 'codeburn'))).toBeNull()
  })

  // The resident `serve` child parses over and over in one process; a thread
  // that outlives its parse would accumulate across requests.
  it('leaves no live worker behind after back-to-back parses', async () => {
    const before = liveWorkers()
    process.env['CODEBURN_PARSE_WORKERS'] = '2'

    await parseAllSessions()
    expect(liveWorkers()).toBe(before)

    clearSessionCache()
    await parseAllSessions()
    expect(liveWorkers()).toBe(before)
  })
})

// The status-snapshot file (one `status-snapshot.<queryKeyHash>.json` per
// distinct query) is written by the same one-shot-CLI-process-per-poll model
// as the main session cache — a menubar poll and a manual refresh are two
// independent processes that can both be mid-write against the same cache
// dir at once. `session-cache-shards.test.ts` has a dedicated
// `describe('concurrent writers', ...)` block for the main cache's
// structurally identical tmp+rename atomic-write pattern; this file is the
// analogous coverage for the snapshot file (review finding D-G9), and
// exercises the locked publication fix for finding B-G1 directly: a slower,
// older-corpus write must not clobber a faster, newer one, and two distinct queryKeys
// must not evict each other.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { createHash } from 'crypto'
import { spawn, spawnSync } from 'child_process'
import { tmpdir } from 'os'
import { delimiter, join } from 'path'

import { acquireCacheRefreshLock } from '../src/cache-refresh-lock.js'
import { loadStatusSnapshot, saveStatusSnapshot } from '../src/session-cache.js'

let TMP_DIR: string
const SEMANTIC_KEY = 'test-render-v1'

beforeEach(async () => {
  TMP_DIR = join(tmpdir(), `codeburn-snapshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  process.env['CODEBURN_CACHE_DIR'] = TMP_DIR
  await mkdir(TMP_DIR, { recursive: true })
})

afterEach(async () => {
  if (existsSync(TMP_DIR)) await rm(TMP_DIR, { recursive: true })
})

async function readRawRecord(queryKey: string): Promise<Record<string, unknown> | null> {
  const hash = createHash('sha256').update(queryKey).digest('hex').slice(0, 16)
  try {
    const raw = await readFile(join(TMP_DIR, `status-snapshot.${hash}.json`), 'utf-8')
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
}

describe('concurrent writers (status snapshot)', () => {
  it('serializes genuinely concurrent same-query saves so an older observation cannot win', async () => {
    let staleWins = 0

    for (let round = 0; round < 50; round++) {
      const queryKey = `same-query-${round}`
      await saveStatusSnapshot('baseline', 1_000, 1_000, queryKey, SEMANTIC_KEY, { p: 'baseline' })

      // Both writes start from the same baseline. On the broken read/guard then
      // rename protocol they both pass the guard, and the slower older write is
      // free to rename over the fresh result.
      await Promise.all([
        saveStatusSnapshot('fresh', 3_000, 3_000, queryKey, SEMANTIC_KEY, { p: 'fresh' }),
        saveStatusSnapshot('stale', 2_000, 2_000, queryKey, SEMANTIC_KEY, { p: 'stale' }),
      ])

      const record = await readRawRecord(queryKey)
      if (record?.['corpusFingerprint'] === 'stale') staleWins++
    }

    expect(staleWins).toBe(0)
  })

  it('never lets a slower recompute against an older corpus clobber a faster, newer one', async () => {
    const queryKey = 'q1'
    // Baseline: both processes started from this on-disk state.
    await saveStatusSnapshot('f1', 1_000, 1_000, queryKey, SEMANTIC_KEY, { p: 'baseline' })

    // Process A observed the corpus at m=2_000 and is slow to finish.
    // Process B observed it LATER, at m=3_000, and finishes first.
    await saveStatusSnapshot('f3', 3_000, 3_000, queryKey, SEMANTIC_KEY, { p: 'B-fresh' })
    // A's write lands after B's despite being based on an older observation.
    await saveStatusSnapshot('f2', 2_000, 2_000, queryKey, SEMANTIC_KEY, { p: 'A-stale' })

    const record = await readRawRecord(queryKey)
    expect(record).toMatchObject({ corpusFingerprint: 'f3', newestMtimeMs: 3_000, payload: { p: 'B-fresh' } })

    // Confirmed via the public read path too.
    const served = await loadStatusSnapshot('f3', queryKey, SEMANTIC_KEY)
    expect(served).toEqual({ p: 'B-fresh' })
  })

  it('does not let a delayed mismatch-bookkeeping write reintroduce a payload a real recompute already superseded', async () => {
    const queryKey = 'q1'
    await saveStatusSnapshot('f1', 1_000, 1_000, queryKey, SEMANTIC_KEY, { p: 'v1' })

    // A load observes the corpus moved to f2 (within the settle window) and
    // would normally persist a bookkeeping mismatchFirstSeenAt timestamp —
    // but a real recompute for f2 lands first.
    const stale = await loadStatusSnapshot('f2', queryKey, SEMANTIC_KEY)
    expect(stale).toEqual({ p: 'v1' }) // served from the settle window

    await saveStatusSnapshot('f2', 1_500, 2_000, queryKey, SEMANTIC_KEY, { p: 'v2-real' })

    const record = await readRawRecord(queryKey)
    // The real recompute's record must be exactly what's on disk — no
    // mismatchFirstSeenAt bookkeeping should have overwritten it with the
    // stale v1 payload.
    expect(record).toMatchObject({ corpusFingerprint: 'f2', payload: { p: 'v2-real' } })
    expect((record as { mismatchFirstSeenAt?: number }).mismatchFirstSeenAt).toBeUndefined()
  })

  it('recomputes instead of extending stale forever when mismatch bookkeeping cannot be persisted', async () => {
    const queryKey = 'read-only-cache'
    process.env['CODEBURN_STATUS_SNAPSHOT_SETTLE_MS'] = '20'
    await saveStatusSnapshot('before', 1_000, 1_000, queryKey, SEMANTIC_KEY, { p: 'stale' })

    await chmod(TMP_DIR, 0o500)
    try {
      expect(await loadStatusSnapshot('after', queryKey, SEMANTIC_KEY)).toBeNull()
      await new Promise(resolve => { setTimeout(resolve, 40) })
      // The first mismatch timestamp could not land. Treat that as a miss;
      // resetting the settle clock on every poll serves stale indefinitely.
      expect(await loadStatusSnapshot('after', queryKey, SEMANTIC_KEY)).toBeNull()
    } finally {
      await chmod(TMP_DIR, 0o700)
      delete process.env['CODEBURN_STATUS_SNAPSHOT_SETTLE_MS']
    }
  })

  it('publishes a later corpus observation even when deleting the newest file lowers max mtime', async () => {
    const queryKey = 'deletion-lowers-max-mtime'
    process.env['CODEBURN_STATUS_SNAPSHOT_SETTLE_MS'] = '0'
    try {
      await saveStatusSnapshot('before-delete', 3_000, 1_000, queryKey, SEMANTIC_KEY, { p: 'old' })
      expect(await loadStatusSnapshot('after-delete', queryKey, SEMANTIC_KEY)).toBeNull()

      // max(mtime) is not an ordering relation: deleting the former maximum
      // legitimately makes it go backwards even though this observation is
      // newer and must replace the old snapshot.
      await saveStatusSnapshot('after-delete', 2_000, 2_000, queryKey, SEMANTIC_KEY, { p: 'new' })
      expect(await loadStatusSnapshot('after-delete', queryKey, SEMANTIC_KEY)).toEqual({ p: 'new' })
    } finally {
      delete process.env['CODEBURN_STATUS_SNAPSHOT_SETTLE_MS']
    }
  })

  it('never publishes a torn write and always leaves a subsequent read intact, even racing two distinct queryKeys', async () => {
    for (let round = 0; round < 15; round++) {
      await Promise.allSettled([
        saveStatusSnapshot(`a${round}`, round, round, 'query-a', SEMANTIC_KEY, { round, who: 'a' }),
        saveStatusSnapshot(`b${round}`, round, round, 'query-b', SEMANTIC_KEY, { round, who: 'b' }),
      ])
      // Whichever landed, EACH queryKey's own file must be valid JSON and
      // present — a shared single-slot file would have one evict the other
      // every round; distinct per-queryKey files never touch each other.
      expect(await readRawRecord('query-a')).toBeTruthy()
      expect(await readRawRecord('query-b')).toBeTruthy()
      // A subsequent read must not throw on whatever landed.
      await loadStatusSnapshot(`a${round}`, 'query-a', SEMANTIC_KEY)
      await loadStatusSnapshot(`b${round}`, 'query-b', SEMANTIC_KEY)
    }
    // No stray .tmp files left mid-directory after the last round settles.
    const leftoverTemps = (await readdir(TMP_DIR)).filter(f => f.endsWith('.tmp'))
    expect(leftoverTemps).toEqual([])
  })

  it('rejects an exact-corpus snapshot written under different render semantics', async () => {
    const queryKey = 'semantic-fence'
    await saveStatusSnapshot('same-corpus', 1_000, 1_000, queryKey, 'render-v1', { p: 'old-shape' })

    expect(await loadStatusSnapshot('same-corpus', queryKey, 'render-v2')).toBeNull()
  })
})

// Post-merge review of PR #999: a `status --format menubar-json --no-optimize`
// poll that runs while ANOTHER process holds `session-refresh.lock` parses
// read-only and serves a degraded corpus (payload.stale === true), and a later
// in-process parse — the payload builder's own history re-parse, running after
// the holder releases — flips the module-level hydration global back to
// complete before the save point. A save gate consulting only that global
// persists the under-reported payload under the CURRENT corpus fingerprint,
// poisoning every future poll. These cases spawn the real CLI; each one does
// genuine parse work plus a lock-hold window, so they get the same generous
// timeout as the CLI-spawning suites.
vi.setConfig({ testTimeout: 120_000 })

const SNAPSHOT_FILE_RE = /^status-snapshot\.[0-9a-f]+\.json$/
async function snapshotFileNames(cacheDir: string): Promise<string[]> {
  if (!existsSync(cacheDir)) return []
  return (await readdir(cacheDir)).filter(f => SNAPSHOT_FILE_RE.test(f))
}

function cliEnv(home: string, extraEnv: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    CODEBURN_CACHE_DIR: join(home, '.cache', 'codeburn'),
    HOME: home,
    TZ: 'UTC',
    ...extraEnv,
  }
}

function runCli(args: string[], home: string, extraEnv: Record<string, string> = {}): { status: number | null, stdout: string, stderr: string } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env: cliEnv(home, extraEnv),
    encoding: 'utf-8',
    timeout: 60_000,
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function runCliAsync(args: string[], home: string, extraEnv: Record<string, string> = {}): Promise<{ status: number | null, stdout: string, stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      cwd: process.cwd(),
      env: cliEnv(home, extraEnv),
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8') })
    child.once('error', reject)
    child.once('close', status => { resolve({ status, stdout, stderr }) })
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
      content: [{ type: 'text', text: 'done' }],
      usage: { input_tokens: 500, output_tokens: 50 },
    },
  })
}

const delay = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

describe('degraded read-only parse is never persisted as a status snapshot', () => {
  it('writes no snapshot for a lock-degraded poll, then resumes persisting on the clean pass', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-snapshot-degraded-'))
    const cacheDir = join(home, '.cache', 'codeburn')
    try {
      // Two Claude config roots: the query below is scoped to one of them via
      // --claude-config-source. The scoped path is what makes the PR #999
      // sequence reachable in a one-shot process: the payload builder captures
      // the hydration verdict right after the (degraded) primary parse, then
      // runs its OWN history re-parse over a wider range — a second, real
      // parse that re-acquires the lock once the holder releases and flips the
      // module-level hydration global back to complete before the save point.
      const work = join(home, 'claude-work')
      const personal = join(home, 'claude-personal')
      await mkdir(join(work, 'projects', 'app'), { recursive: true })
      await mkdir(join(personal, 'projects', 'app'), { recursive: true })

      // Two hours back, clamped inside the current UTC day (cliEnv pins
      // TZ=UTC), so every session falls inside the 'today' query.
      const now = new Date()
      const todayUtcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
      const base = new Date(Math.max(todayUtcMidnight, now.getTime() - 2 * 3600_000))
      const ts = (offset: number) => new Date(base.getTime() + offset).toISOString().replace(/\.\d+Z$/, 'Z')

      await writeFile(
        join(work, 'projects', 'app', 'w1.jsonl'),
        [userLine('w1', ts(0)), assistantLine('w1', ts(60_000), 'msg-w1')].join('\n') + '\n',
      )
      await writeFile(
        join(personal, 'projects', 'app', 'p1.jsonl'),
        [userLine('p1', ts(30_000)), assistantLine('p1', ts(90_000), 'msg-p1')].join('\n') + '\n',
      )
      const env = { CLAUDE_CONFIG_DIRS: [work, personal].join(delimiter) }

      // Warm the session cache through a default-optimize poll: it parses and
      // persists the corpus. #1135 part 2 also persisted the BASE payload
      // (with the optimize block stripped) on this path, so the warm-up
      // writes a snapshot at its own (no --claude-config-source) queryKey.
      // The assertions below only care about the scoped queryKey, so we
      // clear any warm-up snapshot files before the next call.
      const warmStart = Date.now()
      const warm = runCli(['status', '--format', 'menubar-json', '--period', 'today', '--provider', 'all'], home, env)
      const warmElapsedMs = Date.now() - warmStart
      expect(warm.status, `stderr: ${warm.stderr}`).toBe(0)
      const warmPayload = JSON.parse(warm.stdout) as {
        current: { calls: number }
        claudeConfigs: { options: Array<{ id: string, label: string }> }
      }
      expect(warmPayload.current.calls).toBe(2)
      const workSourceId = warmPayload.claudeConfigs.options.find(o => o.label === 'claude-work')?.id
      expect(workSourceId).toBeTruthy()
      for (const f of await snapshotFileNames(cacheDir)) await rm(join(cacheDir, f))

      // New activity in the SELECTED root that the warm cache has never seen.
      // A read-only parse has no cache entry for it and must skip it,
      // under-reporting the totals.
      await writeFile(
        join(work, 'projects', 'app', 'w2.jsonl'),
        [userLine('w2', ts(120_000)), assistantLine('w2', ts(180_000), 'msg-w2')].join('\n') + '\n',
      )

      const args = [
        'status', '--format', 'menubar-json', '--period', 'today', '--provider', 'all',
        '--claude-config-source', workSourceId!,
        '--no-optimize',
      ]

      // A live, heartbeating owner holding the refresh lock, exactly as in
      // cache-refresh-lock.test.ts: the pid answers signal 0 and the mtime
      // stays fresh, so the child's primary parse can neither acquire nor
      // take over — it parks in the wait loop.
      const held = await acquireCacheRefreshLock({ cacheDir })
      expect(held.outcome).toBe('acquired')
      if (held.outcome !== 'acquired') return

      let degraded
      try {
        const running = runCliAsync(args, home, env)
        // Release only once the child is certainly parked in its lock wait:
        // the warm run just did the same startup (tsx boot, pricing load,
        // corpus fingerprint) the child repeats before it ever touches the
        // lock, so its acquire attempt lands well inside this window.
        // Releasing earlier would let that FIRST acquire succeed and turn
        // this into a clean run; releasing is what reports
        // 'completed-by-other' and sends the primary parse down the read-only
        // path while leaving the lock free for the payload builder's later
        // history re-parse — the exact PR #999 sequence.
        await delay(warmElapsedMs + 1_500)
        await held.handle.release()
        degraded = await running
      } finally {
        await held.handle.release()
      }

      expect(degraded.status, `stderr: ${degraded.stderr}`).toBe(0)
      const degradedPayload = JSON.parse(degraded.stdout) as { stale?: boolean, current: { calls: number } }
      // The primary parse went read-only behind the held lock and served the
      // warm cache: w2 is missing from the totals and the payload says so.
      expect(degradedPayload.stale).toBe(true)
      expect(degradedPayload.current.calls).toBe(1)
      // The gate: no snapshot may be persisted from this degraded payload,
      // even though the history re-parse after the release flipped the
      // hydration global back to complete before the save point.
      expect(await snapshotFileNames(cacheDir)).toEqual([])

      // The gate reopens: the identical query on a clean pass recomputes and
      // persists a complete snapshot.
      const clean = runCli(args, home, env)
      expect(clean.status, `stderr: ${clean.stderr}`).toBe(0)
      const cleanPayload = JSON.parse(clean.stdout) as { stale?: boolean, current: { calls: number } }
      expect(cleanPayload.stale).toBeUndefined()
      expect(cleanPayload.current.calls).toBe(2)

      const snapshots = await snapshotFileNames(cacheDir)
      expect(snapshots).toHaveLength(1)
      const record = JSON.parse(await readFile(join(cacheDir, snapshots[0]!), 'utf-8')) as {
        payload: { stale?: boolean, current: { calls: number } }
      }
      expect(record.payload.stale).toBeUndefined()
      expect(record.payload.current.calls).toBe(2)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

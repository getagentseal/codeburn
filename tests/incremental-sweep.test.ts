// The resident process reuses a directory listing / file fingerprint the root
// watcher proved untouched, and coalesces shard publication. Both are freshness
// trades, so what is pinned here is when they are NOT taken.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, rm, rename } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import {
  clearSessionCache,
  flushPendingShardPublish,
  hasPendingShardPublish,
  parseAllSessions,
  setShardPublishCoalescing,
  setSweepWatchSource,
} from '../src/parser.js'
import { clearLoadCacheMemo, fingerprintFileCount, loadCache, markCacheDirty, saveCache, sessionCacheDir } from '../src/session-cache.js'

let tmpDir: string

// A watcher stub. `changed` is what the FSEvents layer would have recorded;
// null models an unscoped event (overflow, or a missing filename). Installed
// ONCE per test and then mutated, because installing a source is itself a
// reset of everything the sweep remembers.
let fake: { changed: string[] | null; healthy: boolean; startedAt: number; roots: string[] }
function installWatcher(): void {
  fake = { changed: [], healthy: true, startedAt: 0, roots: [tmpDir] }
  setSweepWatchSource({
    get startedAt() { return fake.startedAt },
    get roots() { return fake.roots },
    healthy: () => fake.healthy,
    changedSince: () => fake.changed,
  })
}

async function session(project: string, name: string, calls: number): Promise<string> {
  const dir = join(tmpDir, 'projects', project)
  await mkdir(dir, { recursive: true })
  const path = join(dir, name)
  const lines: string[] = []
  for (let i = 0; i < calls; i++) {
    lines.push(JSON.stringify({
      type: 'assistant',
      sessionId: name.replace('.jsonl', ''),
      timestamp: `2026-05-15T10:00:0${i}Z`,
      cwd: `/tmp/${project}`,
      message: {
        id: `msg-${project}-${name}-${i}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
        content: [], usage: { input_tokens: 100, output_tokens: 50 },
      },
    }))
  }
  await writeFile(path, lines.join('\n') + '\n')
  return path
}

async function appendOne(path: string, id: string): Promise<void> {
  await writeFile(path, JSON.stringify({
    type: 'assistant', sessionId: 's', timestamp: '2026-05-15T11:00:00Z', cwd: '/tmp/p',
    message: { id, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], usage: { input_tokens: 1, output_tokens: 1 } },
  }) + '\n', { flag: 'a' })
}

const totalCalls = (projects: Awaited<ReturnType<typeof parseAllSessions>>): number =>
  projects.reduce((n, p) => n + p.totalApiCalls, 0)

/// A fresh poll: the result memo is what a real serve process re-validates, and
/// this suite is about the sweep underneath it.
const poll = (): Promise<Awaited<ReturnType<typeof parseAllSessions>>> => {
  clearSessionCache()
  return parseAllSessions()
}

/// Fingerprint stats one poll performed — the number the sweep exists to cut.
async function statsForPoll(): Promise<number> {
  const before = fingerprintFileCount()
  await poll()
  return fingerprintFileCount() - before
}

beforeEach(async () => {
  clearSessionCache()
  clearLoadCacheMemo()
  tmpDir = await mkdtemp(join(tmpdir(), 'cb-sweep-'))
  process.env['CLAUDE_CONFIG_DIR'] = tmpDir
  process.env['CODEBURN_CACHE_DIR'] = join(tmpDir, 'cache')
  process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] = join(tmpDir, 'desktop-sessions')
  process.env['CODEBURN_PARSE_BURST_MS'] = '0'
})

afterEach(async () => {
  setSweepWatchSource(null)
  setShardPublishCoalescing(false)
  clearSessionCache()
  clearLoadCacheMemo()
  delete process.env['CODEBURN_PARSE_BURST_MS']
  delete process.env['CODEBURN_COPILOT_SESSION_STATE_DIR']
  delete process.env['CODEBURN_COPILOT_DISABLE_OTEL']
  await rm(tmpDir, { recursive: true, force: true })
})

describe('incremental discovery sweep', () => {
  it('re-stats a handful, not thousands, when exactly one transcript changed', async () => {
    for (let p = 0; p < 40; p++) await session(`proj${p}`, 'a.jsonl', 2)
    const hot = await session('proj0', 'hot.jsonl', 1)
    installWatcher()

    expect(await statsForPoll()).toBeGreaterThan(40)
    // Second poll, nothing touched: no transcript is stat'd at all.
    expect(await statsForPoll()).toBe(0)

    // One transcript appended and named by the watcher: only that file is
    // re-stat'd, plus whatever re-walking its one directory turns up.
    await appendOne(hot, 'msg-hot-2')
    fake.changed = [hot]
    expect(await statsForPoll()).toBeLessThanOrEqual(5)
  })

  it('reflects an append the watcher named', async () => {
    const path = await session('p', 's.jsonl', 1)
    installWatcher()
    expect(totalCalls(await poll())).toBe(1)

    await appendOne(path, 'msg-extra')
    fake.changed = [path]
    expect(totalCalls(await poll())).toBe(2)
  })

  it('reflects a brand-new transcript in an existing directory', async () => {
    await session('p', 's.jsonl', 1)
    installWatcher()
    expect(totalCalls(await poll())).toBe(1)

    fake.changed = [await session('p', 'new.jsonl', 3)]
    expect(totalCalls(await poll())).toBe(4)
  })

  it('reflects a transcript in a directory that did not exist at the last sweep', async () => {
    await session('p', 's.jsonl', 1)
    installWatcher()
    expect(totalCalls(await poll())).toBe(1)

    fake.changed = [await session('brand-new', 's.jsonl', 2)]
    expect(totalCalls(await poll())).toBe(3)
  })

  it('reflects a transcript replaced by rename (same path, new inode)', async () => {
    const path = await session('p', 's.jsonl', 1)
    installWatcher()
    expect(totalCalls(await poll())).toBe(1)

    const swap = await session('p', 'swap.jsonl.tmp', 4)
    await rename(swap, path)
    fake.changed = [path]
    expect(totalCalls(await poll())).toBe(4)
  })

  it('reflects a deleted transcript by re-walking its directory', async () => {
    await session('p', 'keep.jsonl', 1)
    const gone = await session('p', 'gone.jsonl', 3)
    installWatcher()
    expect(totalCalls(await poll())).toBe(4)

    await rm(gone)
    fake.changed = [gone]
    expect(totalCalls(await poll())).toBe(1)
  })

  // ── Force-full conditions ────────────────────────────────────────────────
  // Each is expressed the same way: a change the watcher does NOT name is still
  // picked up, because the sweep had to fall back to reading everything.
  const forcedFull: Array<[string, () => void]> = [
    ['no watcher at all (one-shot CLI)', () => setSweepWatchSource(null)],
    ['watcher unhealthy', () => { fake.healthy = false }],
    ['unscoped event (overflow / null filename)', () => { fake.changed = null }],
    ['watcher armed after the remembered sweep', () => { fake.startedAt = Date.now() + 60_000 }],
    ['path outside every armed root', () => { fake.roots = [join(tmpdir(), 'cb-sweep-elsewhere')] }],
  ]
  for (const [label, degrade] of forcedFull) {
    it(`falls back to a full sweep: ${label}`, async () => {
      const path = await session('p', 's.jsonl', 1)
      installWatcher()
      expect(totalCalls(await poll())).toBe(1)

      // The watcher keeps reporting quiet, which is now a lie.
      await appendOne(path, 'msg-unnamed')
      degrade()
      expect(totalCalls(await poll())).toBe(2)
    })
  }

  it('falls back to a full sweep after the process was suspended', async () => {
    const path = await session('p', 's.jsonl', 1)
    installWatcher()
    expect(totalCalls(await poll())).toBe(1)
    await appendOne(path, 'msg-slept')

    // Sleep/wake: wall time jumps while the monotonic clock — which stops with
    // the process — does not. The watcher claims quiet and is not believed.
    const realNow = Date.now
    Date.now = () => realNow() + 20_000
    try {
      expect(totalCalls(await poll())).toBe(2)
    } finally {
      Date.now = realNow
    }
  })
})

describe('coalesced shard publication', () => {
  // Read the published shards straight off disk: the usual test reader drops the
  // load memo, and dropping it is exactly what retires a held publish.
  const publishedFiles = async (provider = 'claude'): Promise<Record<string, { turns: unknown[] }>> => {
    const dir = sessionCacheDir()
    const envelope = JSON.parse(await readFile(join(dir, 'envelope.json'), 'utf-8')) as
      { providers: Record<string, { shards: Record<string, { name: string }> }> }
    const names = Object.values(envelope.providers[provider]?.shards ?? {}).map(s => s.name)
    const files: Record<string, { turns: unknown[] }> = {}
    for (const name of names) Object.assign(files, JSON.parse(await readFile(join(dir, name), 'utf-8')))
    return files
  }
  const claudeFiles = async (): Promise<string[]> => Object.keys(await publishedFiles())

  it('publishes the first time, holds the next, and flushes on shutdown', async () => {
    const path = await session('p', 's.jsonl', 1)
    installWatcher()
    setShardPublishCoalescing(true)

    await parseAllSessions()
    expect(hasPendingShardPublish()).toBe(false)
    expect(await claudeFiles()).toHaveLength(1)

    const extra = await session('p', 'later.jsonl', 2)
    fake.changed = [extra]
    expect(totalCalls(await poll())).toBe(3)
    // Held, not written: the answer is already correct, the disk is merely stale.
    expect(hasPendingShardPublish()).toBe(true)
    expect(await claudeFiles()).toHaveLength(1)

    await flushPendingShardPublish()
    expect(hasPendingShardPublish()).toBe(false)
    expect((await claudeFiles()).sort()).toEqual([path, extra].sort())
  })

  it('holds nothing when the corpus did not change', async () => {
    await session('p', 's.jsonl', 1)
    installWatcher()
    setShardPublishCoalescing(true)
    await parseAllSessions()

    await poll()
    expect(hasPendingShardPublish()).toBe(false)
  })

  it('a held publish never clobbers what another process published meanwhile', async () => {
    await session('p', 's.jsonl', 1)
    installWatcher()
    setShardPublishCoalescing(true)
    await parseAllSessions()

    const extra = await session('p', 'later.jsonl', 2)
    fake.changed = [extra]
    await poll()
    expect(hasPendingShardPublish()).toBe(true)

    // Another process (a one-shot CLI run) publishes while this one is still
    // holding its window.
    const foreign = await session('p', 'foreign.jsonl', 1)
    clearLoadCacheMemo()
    const other = await loadCache()
    const { statSync } = await import('node:fs')
    const st = statSync(foreign)
    other.providers['claude']!.files[foreign] = {
      fingerprint: { dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, sizeBytes: st.size },
      turns: [],
    }
    markCacheDirty(other, 'claude', foreign)
    expect(await saveCache(other)).toBe(true)

    // The held pre-image is now stale, so it is dropped rather than written
    // over the newer shard.
    await flushPendingShardPublish()
    expect(await claudeFiles()).toContain(foreign)
    expect(await claudeFiles()).not.toContain(extra)

    // Nothing is lost — for a provider whose transcripts are still on disk: the
    // dropped window is simply re-parsed and republished. That is NOT true of a
    // durable provider, whose cache entry is the only surviving record once it
    // prunes its own files; those windows are never held (see below).
    setShardPublishCoalescing(false)
    fake.changed = [extra, foreign]
    expect(totalCalls(await poll())).toBe(3)
    const merged = await claudeFiles()
    expect(merged).toContain(foreign)
    expect(merged).toContain(extra)
  })

  // Copilot's cache entry is the only record of that spend once Copilot prunes
  // its own files, so a window containing one may never be held: a kill -9
  // between the poll and the flush would lose it for good.
  const copilotEvents = async (name: string, calls: number): Promise<string> => {
    const dir = join(tmpDir, 'copilot', 'session-state', name)
    await mkdir(dir, { recursive: true })
    const path = join(dir, 'events.jsonl')
    const lines = [JSON.stringify({ type: 'session.start', timestamp: '2026-05-15T10:00:00Z', data: { selectedModel: 'gpt-4o' } })]
    for (let i = 0; i < calls; i++) {
      lines.push(JSON.stringify({
        type: 'assistant.message', timestamp: `2026-05-15T10:00:0${i}Z`,
        data: { messageId: `m-${name}-${i}`, model: 'gpt-4o', outputTokens: 1000 },
      }))
    }
    await writeFile(path, lines.join('\n') + '\n')
    return path
  }

  it('never holds a window that a durable provider dirtied', async () => {
    process.env['CODEBURN_COPILOT_SESSION_STATE_DIR'] = join(tmpDir, 'copilot', 'session-state')
    process.env['CODEBURN_COPILOT_DISABLE_OTEL'] = '1'
    const claude = await session('p', 's.jsonl', 1)
    const copilot = await copilotEvents('sess', 1)
    installWatcher()
    setShardPublishCoalescing(true)

    await parseAllSessions()
    expect(hasPendingShardPublish()).toBe(false)

    // A claude-only change inside the window is still held: nothing else keeps
    // that record, but the transcript itself does.
    const extra = await session('p', 'later.jsonl', 2)
    fake.changed = [extra]
    await poll()
    expect(hasPendingShardPublish()).toBe(true)
    await flushPendingShardPublish()

    // The same window, now also carrying new copilot turns, publishes on the
    // poll that parsed them — before any flush runs.
    await copilotEvents('sess', 3)
    fake.changed = [claude, copilot]
    await poll()
    expect(hasPendingShardPublish()).toBe(false)
    expect((await publishedFiles('copilot'))[copilot]?.turns).toHaveLength(3)

    // An UNCHANGED durable section must not defeat coalescing for everyone
    // else: only a dirtied one forces the publish.
    const third = await session('p', 'third.jsonl', 1)
    fake.changed = [third]
    await poll()
    expect(hasPendingShardPublish()).toBe(true)
  })

  // src/serve.ts's RSS guard clears the load memo. A held window that is not
  // published FIRST is not merely delayed — isCacheCurrent() no longer matches,
  // so the later flush drops it.
  it('flushing before the load memo is cleared publishes; after, it discards', async () => {
    const path = await session('p', 's.jsonl', 1)
    installWatcher()
    setShardPublishCoalescing(true)
    await parseAllSessions()

    const extra = await session('p', 'later.jsonl', 2)
    fake.changed = [extra]
    await poll()
    expect(hasPendingShardPublish()).toBe(true)

    // What serve.ts does: flush, then clear.
    await flushPendingShardPublish()
    clearLoadCacheMemo()
    expect((await claudeFiles()).sort()).toEqual([path, extra].sort())

    // The other order loses the window.
    const third = await session('p', 'third.jsonl', 1)
    fake.changed = [third]
    await poll()
    expect(hasPendingShardPublish()).toBe(true)
    clearLoadCacheMemo()
    await flushPendingShardPublish()
    expect(await claudeFiles()).not.toContain(third)
  })
})

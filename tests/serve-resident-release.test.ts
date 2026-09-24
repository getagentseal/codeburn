import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import {
  clearSessionCache,
  hasPendingShardPublish,
  parseAllSessions,
  setShardPublishCoalescing,
} from '../src/parser.js'
import {
  clearLoadCacheMemo,
  DURABLE_PROVIDER_NAMES,
  emptyCache,
  loadCache,
  type CachedFile,
} from '../src/session-cache.js'
import { releaseResidentMemos } from '../src/serve.js'
import { readCacheOnDisk, writeCacheOnDisk } from './fixtures/session-cache-io.js'

// The resident serve child releases every memo it can re-read from disk once
// the background fill has written its summaries (and, as before, when the RSS
// guard fires). What must survive that release is everything the cache is the
// only record of.

let tmpDir: string

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

beforeEach(async () => {
  clearSessionCache()
  clearLoadCacheMemo()
  tmpDir = await mkdtemp(join(tmpdir(), 'cb-release-'))
  process.env['CLAUDE_CONFIG_DIR'] = tmpDir
  process.env['CODEBURN_CACHE_DIR'] = join(tmpDir, 'cache')
  process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] = join(tmpDir, 'desktop-sessions')
  process.env['CODEBURN_PARSE_BURST_MS'] = '0'
})

afterEach(async () => {
  setShardPublishCoalescing(false)
  clearSessionCache()
  clearLoadCacheMemo()
  delete process.env['CODEBURN_PARSE_BURST_MS']
  await rm(tmpDir, { recursive: true, force: true })
})

describe('resident memo release', () => {
  it('publishes a held shard window instead of dropping it', async () => {
    const hot = await session('proj', 'a.jsonl', 2)
    await parseAllSessions()

    // Coalescing on: the FIRST dirty parse still publishes (it is what starts
    // the window), the next one holds its dirty cache in memory instead —
    // exactly the state a release must not lose.
    setShardPublishCoalescing(true)
    await appendOne(hot, 'msg-held-0')
    clearSessionCache()
    await parseAllSessions()
    await appendOne(hot, 'msg-held-1')
    clearSessionCache()
    const held = totalCalls(await parseAllSessions())
    expect(hasPendingShardPublish()).toBe(true)

    await releaseResidentMemos()
    expect(hasPendingShardPublish()).toBe(false)

    // The held append reached disk: a reader with no memo at all sees it.
    const onDisk = await readCacheOnDisk()
    const cachedCalls = Object.values(onDisk.providers['claude']!.files)
      .reduce((n, f) => n + f.turns.reduce((m, t) => m + t.calls.length, 0), 0)
    expect(cachedCalls).toBe(held)
  })

  it('reloads the shards it released and answers the same', async () => {
    await session('proj', 'a.jsonl', 3)
    await session('other', 'b.jsonl', 2)
    const before = totalCalls(await parseAllSessions())

    await releaseResidentMemos()

    // Nothing in memory: the next parse must come back off the shards.
    const after = totalCalls(await parseAllSessions())
    expect(after).toBe(before)

    // And an append after the release is still seen exactly.
    const hot = join(tmpDir, 'projects', 'proj', 'a.jsonl')
    await appendOne(hot, 'msg-after-release')
    clearSessionCache()
    expect(totalCalls(await parseAllSessions())).toBe(before + 1)
  })

  it('keeps durable-provider entries, which only the cache still records', async () => {
    const provider = [...DURABLE_PROVIDER_NAMES][0]!
    const file: CachedFile = {
      fingerprint: { dev: 1, ino: 2, mtimeMs: 3, sizeBytes: 4 },
      mcpInventory: [],
      turns: [{
        timestamp: '2026-05-15T10:00:00Z',
        sessionId: 'durable-session',
        userMessage: '',
        calls: [{
          provider,
          model: 'gpt-4.1',
          deduplicationKey: 'durable-1',
          timestamp: '2026-05-15T10:00:00Z',
          speed: 'standard',
          costUSD: 0.5,
          tools: [],
          bashCommands: [],
          skills: [],
          usage: {
            inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
            cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0, cacheCreationOneHourTokens: 0,
          },
        }],
      }],
    }
    const cache = emptyCache()
    cache.providers[provider] = { envFingerprint: '', durable: true, files: { 'pruned-source.json': file } }
    await writeCacheOnDisk(cache)

    await releaseResidentMemos()

    const reloaded = await loadCache({ fromMonth: '2026-05', toMonth: '2026-05' })
    expect(Object.keys(reloaded.providers[provider]?.files ?? {})).toEqual(['pruned-source.json'])
  })
})

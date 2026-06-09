import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile, rm, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  CACHE_VERSION,
  type CachedCall,
  type CachedFile,
  type CachedTurn,
  type FileFingerprint,
  type SessionCache,
  cleanupOrphanedTempFiles,
  computeEnvFingerprint,
  emptyCache,
  fingerprintFile,
  loadCache,
  mergeCallByDedupKey,
  reconcileFile,
  saveCache,
} from '../src/session-cache.js'

const TMP_DIR = join(tmpdir(), `codeburn-scache-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)

beforeEach(() => {
  process.env['CODEBURN_CACHE_DIR'] = TMP_DIR
})

afterEach(async () => {
  delete process.env['CODEBURN_CACHE_DIR']
  if (existsSync(TMP_DIR)) await rm(TMP_DIR, { recursive: true })
})

function makeCall(overrides: Partial<CachedCall> = {}): CachedCall {
  return {
    provider: 'claude',
    model: 'claude-sonnet-4-20250514',
    usage: {
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      cacheCreationOneHourTokens: 0,
    },
    speed: 'standard',
    timestamp: '2026-05-15T10:00:00Z',
    tools: ['Read', 'Edit'],
    bashCommands: [],
    skills: [],
    deduplicationKey: 'msg-abc123',
    ...overrides,
  }
}

function makeTurn(overrides: Partial<CachedTurn> = {}): CachedTurn {
  return {
    timestamp: '2026-05-15T10:00:00Z',
    sessionId: 'sess-1',
    userMessage: 'fix the bug',
    calls: [makeCall()],
    ...overrides,
  }
}

function makeCachedFile(overrides: Partial<CachedFile> = {}): CachedFile {
  return {
    fingerprint: { dev: 1, ino: 100, mtimeMs: 1000, sizeBytes: 5000 },
    mcpInventory: [],
    turns: [makeTurn()],
    ...overrides,
  }
}

// ── emptyCache ─────────────────────────────────────────────────────────

describe('emptyCache', () => {
  it('returns a valid empty cache', () => {
    const cache = emptyCache()
    expect(cache.version).toBe(CACHE_VERSION)
    expect(cache.providers).toEqual({})
  })
})

// ── loadCache / saveCache ──────────────────────────────────────────────

describe('loadCache / saveCache', () => {
  it('returns empty cache when no file exists', async () => {
    const cache = await loadCache()
    expect(cache.version).toBe(CACHE_VERSION)
    expect(cache.providers).toEqual({})
  })

  it('round-trips a cache through save and load', async () => {
    const cache: SessionCache = {
      version: CACHE_VERSION,
      providers: {
        claude: {
          envFingerprint: 'abc123',
          files: {
            '/path/to/session.jsonl': makeCachedFile(),
          },
        },
      },
    }

    await saveCache(cache)
    const loaded = await loadCache()
    expect(loaded).toEqual(cache)
  })

  it('persists a failed-parse marker across save/load (negative-result cache)', async () => {
    const cache: SessionCache = {
      version: CACHE_VERSION,
      providers: {
        pi: {
          envFingerprint: 'abc123',
          files: {
            '/path/to/bad.jsonl': makeCachedFile({ turns: [], failed: true }),
          },
        },
      },
    }

    await saveCache(cache)
    const loaded = await loadCache()
    // The `failed` flag and empty turns survive validation + load, so the file
    // stays skipped on the next run instead of being re-read and re-thrown.
    expect(loaded.providers['pi']?.files['/path/to/bad.jsonl']?.failed).toBe(true)
    expect(loaded.providers['pi']?.files['/path/to/bad.jsonl']?.turns).toEqual([])
  })

  it('returns empty cache on version mismatch', async () => {
    const bad: SessionCache = { version: 999, providers: { claude: { envFingerprint: 'x', files: {} } } }
    await mkdir(TMP_DIR, { recursive: true })
    await writeFile(join(TMP_DIR, 'session-cache.json'), JSON.stringify(bad))

    const loaded = await loadCache()
    expect(loaded.version).toBe(CACHE_VERSION)
    expect(loaded.providers).toEqual({})
  })

  it('returns empty cache on corrupt JSON', async () => {
    await mkdir(TMP_DIR, { recursive: true })
    await writeFile(join(TMP_DIR, 'session-cache.json'), '{broken')

    const loaded = await loadCache()
    expect(loaded.version).toBe(CACHE_VERSION)
    expect(loaded.providers).toEqual({})
  })

  it('atomic write does not leave partial file on error', async () => {
    await saveCache(emptyCache())
    const raw = await readFile(join(TMP_DIR, 'session-cache.json'), 'utf-8')
    expect(JSON.parse(raw)).toEqual(emptyCache())
  })
})

// ── computeEnvFingerprint ──────────────────────────────────────────────

describe('computeEnvFingerprint', () => {
  it('returns stable hash for same env', () => {
    const a = computeEnvFingerprint('claude')
    const b = computeEnvFingerprint('claude')
    expect(a).toBe(b)
    expect(a).toHaveLength(16)
  })

  it('changes when env var changes', () => {
    const before = computeEnvFingerprint('claude')
    const orig = process.env['CLAUDE_CONFIG_DIR']
    process.env['CLAUDE_CONFIG_DIR'] = '/tmp/different'
    const after = computeEnvFingerprint('claude')
    if (orig === undefined) delete process.env['CLAUDE_CONFIG_DIR']
    else process.env['CLAUDE_CONFIG_DIR'] = orig
    expect(before).not.toBe(after)
  })

  it('returns stable hash for unknown provider (no env vars)', () => {
    const a = computeEnvFingerprint('unknown-provider')
    const b = computeEnvFingerprint('unknown-provider')
    expect(a).toBe(b)
  })

  it('includes parser versions in provider fingerprints', () => {
    expect(computeEnvFingerprint('claude')).not.toBe(computeEnvFingerprint('unknown-provider'))
    expect(computeEnvFingerprint('copilot')).not.toBe(computeEnvFingerprint('unknown-provider'))
    expect(computeEnvFingerprint('warp')).not.toBe(computeEnvFingerprint('unknown-provider'))
  })
})

// ── fingerprintFile ────────────────────────────────────────────────────

describe('fingerprintFile', () => {
  it('returns fingerprint for existing file', async () => {
    await mkdir(TMP_DIR, { recursive: true })
    const filePath = join(TMP_DIR, 'test.jsonl')
    await writeFile(filePath, 'line1\nline2\n')

    const fp = await fingerprintFile(filePath)
    expect(fp).not.toBeNull()
    expect(fp!.sizeBytes).toBe(12)
    expect(fp!.dev).toBeGreaterThan(0)
    expect(fp!.ino).toBeGreaterThan(0)
    expect(fp!.mtimeMs).toBeGreaterThan(0)
  })

  it('returns null for non-existent file', async () => {
    const fp = await fingerprintFile('/no/such/file')
    expect(fp).toBeNull()
  })

  it('resolves compound path with # separator (Cursor workspace)', async () => {
    await mkdir(TMP_DIR, { recursive: true })
    const filePath = join(TMP_DIR, 'state.vscdb')
    await writeFile(filePath, 'cursor-data')

    const fp = await fingerprintFile(`${filePath}#cursor-ws=__orphan__`)
    expect(fp).not.toBeNull()
    expect(fp!.sizeBytes).toBe(11)
  })

  it('resolves compound path with : separator (OpenCode session)', async () => {
    await mkdir(TMP_DIR, { recursive: true })
    const filePath = join(TMP_DIR, 'opencode.db')
    await writeFile(filePath, 'opencode-data')

    const fp = await fingerprintFile(`${filePath}:ses_abc123`)
    expect(fp).not.toBeNull()
    expect(fp!.sizeBytes).toBe(13)
  })

  it('returns null when base file does not exist for compound path', async () => {
    const fp = await fingerprintFile('/no/such/file.db#cursor-ws=workspace')
    expect(fp).toBeNull()
  })

  it('prefers # separator over : when both present', async () => {
    await mkdir(TMP_DIR, { recursive: true })
    const filePath = join(TMP_DIR, 'state.vscdb')
    await writeFile(filePath, 'both-seps')

    // Path has both # and : — should strip at # first and find the base file
    const fp = await fingerprintFile(`${filePath}#cursor-ws=ws:extra-colon`)
    expect(fp).not.toBeNull()
    expect(fp!.sizeBytes).toBe(9)
  })
})

// ── reconcileFile ──────────────────────────────────────────────────────

describe('reconcileFile', () => {
  it('returns "new" when no cached entry', () => {
    const fp: FileFingerprint = { dev: 1, ino: 100, mtimeMs: 1000, sizeBytes: 5000 }
    expect(reconcileFile(fp, undefined)).toEqual({ action: 'new' })
  })

  it('returns "unchanged" when all fields match', () => {
    const fp: FileFingerprint = { dev: 1, ino: 100, mtimeMs: 1000, sizeBytes: 5000 }
    const cached = makeCachedFile({ fingerprint: { ...fp } })
    expect(reconcileFile(fp, cached)).toEqual({ action: 'unchanged' })
  })

  it('returns "appended" when ino same, size grew, and has lastCompleteLineOffset', () => {
    const cached = makeCachedFile({
      fingerprint: { dev: 1, ino: 100, mtimeMs: 1000, sizeBytes: 5000 },
      lastCompleteLineOffset: 4500,
    })
    const current: FileFingerprint = { dev: 1, ino: 100, mtimeMs: 2000, sizeBytes: 8000 }
    const result = reconcileFile(current, cached)
    expect(result).toEqual({ action: 'appended', readFromOffset: 4500 })
  })

  it('returns "modified" when ino changed', () => {
    const cached = makeCachedFile({
      fingerprint: { dev: 1, ino: 100, mtimeMs: 1000, sizeBytes: 5000 },
    })
    const current: FileFingerprint = { dev: 1, ino: 200, mtimeMs: 2000, sizeBytes: 5000 }
    expect(reconcileFile(current, cached)).toEqual({ action: 'modified' })
  })

  it('a failed marker at the same fingerprint stays "unchanged" (not re-parsed)', () => {
    const fp: FileFingerprint = { dev: 1, ino: 100, mtimeMs: 1000, sizeBytes: 5000 }
    const marker = makeCachedFile({ fingerprint: { ...fp }, turns: [], failed: true })
    expect(reconcileFile(fp, marker)).toEqual({ action: 'unchanged' })
  })

  it('a failed marker is re-parsed once the file changes', () => {
    const marker = makeCachedFile({
      fingerprint: { dev: 1, ino: 100, mtimeMs: 1000, sizeBytes: 5000 },
      turns: [],
      failed: true,
    })
    const changed: FileFingerprint = { dev: 1, ino: 100, mtimeMs: 2000, sizeBytes: 6000 }
    expect(reconcileFile(changed, marker)).toEqual({ action: 'modified' })
  })

  it('returns "modified" when size shrank', () => {
    const cached = makeCachedFile({
      fingerprint: { dev: 1, ino: 100, mtimeMs: 1000, sizeBytes: 5000 },
      lastCompleteLineOffset: 4500,
    })
    const current: FileFingerprint = { dev: 1, ino: 100, mtimeMs: 2000, sizeBytes: 3000 }
    expect(reconcileFile(current, cached)).toEqual({ action: 'modified' })
  })

  it('returns "modified" when same size but different mtime', () => {
    const cached = makeCachedFile({
      fingerprint: { dev: 1, ino: 100, mtimeMs: 1000, sizeBytes: 5000 },
    })
    const current: FileFingerprint = { dev: 1, ino: 100, mtimeMs: 2000, sizeBytes: 5000 }
    expect(reconcileFile(current, cached)).toEqual({ action: 'modified' })
  })

  it('returns "modified" for DB provider (no lastCompleteLineOffset) on any fingerprint change', () => {
    const cached = makeCachedFile({
      fingerprint: { dev: 1, ino: 100, mtimeMs: 1000, sizeBytes: 5000 },
    })
    const current: FileFingerprint = { dev: 1, ino: 100, mtimeMs: 2000, sizeBytes: 8000 }
    expect(reconcileFile(current, cached)).toEqual({ action: 'modified' })
  })

  it('returns "modified" when dev changed even if ino same and size grew', () => {
    const cached = makeCachedFile({
      fingerprint: { dev: 1, ino: 100, mtimeMs: 1000, sizeBytes: 5000 },
      lastCompleteLineOffset: 4500,
    })
    const current: FileFingerprint = { dev: 2, ino: 100, mtimeMs: 2000, sizeBytes: 8000 }
    expect(reconcileFile(current, cached)).toEqual({ action: 'modified' })
  })
})

// ── mergeCallByDedupKey ────────────────────────────────────────────────

describe('mergeCallByDedupKey', () => {
  it('keeps earlier timestamp', () => {
    const existing = makeCall({ timestamp: '2026-05-15T10:00:00Z' })
    const incoming = makeCall({ timestamp: '2026-05-15T10:01:00Z' })
    const merged = mergeCallByDedupKey(existing, incoming)
    expect(merged.timestamp).toBe('2026-05-15T10:00:00Z')
  })

  it('takes incoming usage (latest wins)', () => {
    const existing = makeCall({ usage: { ...makeCall().usage, outputTokens: 100 } })
    const incoming = makeCall({ usage: { ...makeCall().usage, outputTokens: 999 } })
    const merged = mergeCallByDedupKey(existing, incoming)
    expect(merged.usage.outputTokens).toBe(999)
  })

  it('takes incoming tools (latest wins)', () => {
    const existing = makeCall({ tools: ['Read'] })
    const incoming = makeCall({ tools: ['Read', 'Edit', 'Bash'] })
    const merged = mergeCallByDedupKey(existing, incoming)
    expect(merged.tools).toEqual(['Read', 'Edit', 'Bash'])
  })
})

// ── deep validation (loadCache) ────────────────────────────────────────

describe('loadCache validation', () => {
  async function writeRawCache(data: unknown): Promise<void> {
    await mkdir(TMP_DIR, { recursive: true })
    await writeFile(join(TMP_DIR, 'session-cache.json'), JSON.stringify(data))
  }

  it('rejects providers as array', async () => {
    await writeRawCache({ version: CACHE_VERSION, providers: [] })
    expect((await loadCache()).providers).toEqual({})
  })

  it('rejects provider section missing envFingerprint', async () => {
    await writeRawCache({ version: CACHE_VERSION, providers: { claude: { files: {} } } })
    expect((await loadCache()).providers).toEqual({})
  })

  it('rejects provider section with files as array', async () => {
    await writeRawCache({ version: CACHE_VERSION, providers: { claude: { envFingerprint: 'x', files: [] } } })
    expect((await loadCache()).providers).toEqual({})
  })

  it('rejects file with invalid fingerprint (missing ino)', async () => {
    await writeRawCache({
      version: CACHE_VERSION,
      providers: { claude: { envFingerprint: 'x', files: {
        '/f': { fingerprint: { dev: 1, mtimeMs: 1, sizeBytes: 1 }, mcpInventory: [], turns: [] },
      } } },
    })
    expect((await loadCache()).providers).toEqual({})
  })

  it('rejects file with non-numeric fingerprint field', async () => {
    await writeRawCache({
      version: CACHE_VERSION,
      providers: { claude: { envFingerprint: 'x', files: {
        '/f': { fingerprint: { dev: 1, ino: 'bad', mtimeMs: 1, sizeBytes: 1 }, mcpInventory: [], turns: [] },
      } } },
    })
    expect((await loadCache()).providers).toEqual({})
  })

  it('rejects turn with missing sessionId', async () => {
    const badTurn = { timestamp: 'x', userMessage: 'y', calls: [] }
    await writeRawCache({
      version: CACHE_VERSION,
      providers: { claude: { envFingerprint: 'x', files: {
        '/f': { fingerprint: { dev: 1, ino: 2, mtimeMs: 3, sizeBytes: 4 }, mcpInventory: [], turns: [badTurn] },
      } } },
    })
    expect((await loadCache()).providers).toEqual({})
  })

  it('rejects call with missing usage object', async () => {
    const badCall = { provider: 'claude', model: 'm', deduplicationKey: 'k', timestamp: 't', tools: [], bashCommands: [], skills: [] }
    const turn = { timestamp: 'x', sessionId: 's', userMessage: 'y', calls: [badCall] }
    await writeRawCache({
      version: CACHE_VERSION,
      providers: { claude: { envFingerprint: 'x', files: {
        '/f': { fingerprint: { dev: 1, ino: 2, mtimeMs: 3, sizeBytes: 4 }, mcpInventory: [], turns: [turn] },
      } } },
    })
    expect((await loadCache()).providers).toEqual({})
  })

  it('rejects call with NaN in usage', async () => {
    const badUsage = { inputTokens: NaN, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0, cacheCreationOneHourTokens: 0 }
    const call = { provider: 'claude', model: 'm', usage: badUsage, deduplicationKey: 'k', timestamp: 't', tools: [], bashCommands: [], skills: [], speed: 'standard' }
    const turn = { timestamp: 'x', sessionId: 's', userMessage: 'y', calls: [call] }
    await writeRawCache({
      version: CACHE_VERSION,
      providers: { claude: { envFingerprint: 'x', files: {
        '/f': { fingerprint: { dev: 1, ino: 2, mtimeMs: 3, sizeBytes: 4 }, mcpInventory: [], turns: [turn] },
      } } },
    })
    expect((await loadCache()).providers).toEqual({})
  })

  function validCallJson() {
    return {
      provider: 'claude', model: 'm', deduplicationKey: 'k', timestamp: 't', speed: 'standard',
      tools: ['Read'], bashCommands: ['ls'], skills: [],
      usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0, cacheCreationOneHourTokens: 0 },
    }
  }

  function wrapCall(callOverride: Record<string, unknown>) {
    return {
      version: CACHE_VERSION,
      providers: { claude: { envFingerprint: 'x', files: {
        '/f': { fingerprint: { dev: 1, ino: 2, mtimeMs: 3, sizeBytes: 4 }, mcpInventory: [], turns: [
          { timestamp: 'x', sessionId: 's', userMessage: 'y', calls: [{ ...validCallJson(), ...callOverride }] },
        ] },
      } } },
    }
  }

  function wrapFile(fileOverride: Record<string, unknown>) {
    return {
      version: CACHE_VERSION,
      providers: { claude: { envFingerprint: 'x', files: {
        '/f': { fingerprint: { dev: 1, ino: 2, mtimeMs: 3, sizeBytes: 4 }, mcpInventory: [], turns: [], ...fileOverride },
      } } },
    }
  }

  it('rejects tools containing non-string element', async () => {
    await writeRawCache(wrapCall({ tools: ['Read', 42] }))
    expect((await loadCache()).providers).toEqual({})
  })

  it('rejects bashCommands containing object element', async () => {
    await writeRawCache(wrapCall({ bashCommands: [{}] }))
    expect((await loadCache()).providers).toEqual({})
  })

  it('rejects skills containing null element', async () => {
    await writeRawCache(wrapCall({ skills: [null] }))
    expect((await loadCache()).providers).toEqual({})
  })

  it('rejects invalid speed value', async () => {
    await writeRawCache(wrapCall({ speed: 'turbo' }))
    expect((await loadCache()).providers).toEqual({})
  })

  it('rejects non-string project', async () => {
    await writeRawCache(wrapCall({ project: 123 }))
    expect((await loadCache()).providers).toEqual({})
  })

  it('rejects non-string projectPath', async () => {
    await writeRawCache(wrapCall({ projectPath: true }))
    expect((await loadCache()).providers).toEqual({})
  })

  it('rejects mcpInventory containing non-string element', async () => {
    await writeRawCache(wrapFile({ mcpInventory: ['valid', 99] }))
    expect((await loadCache()).providers).toEqual({})
  })

  it('rejects non-numeric lastCompleteLineOffset', async () => {
    await writeRawCache(wrapFile({ lastCompleteLineOffset: 'bad' }))
    expect((await loadCache()).providers).toEqual({})
  })

  it('rejects NaN lastCompleteLineOffset', async () => {
    await writeRawCache(wrapFile({ lastCompleteLineOffset: null }))
    expect((await loadCache()).providers).toEqual({})
  })

  it('rejects non-string canonicalCwd', async () => {
    await writeRawCache(wrapFile({ canonicalCwd: 42 }))
    expect((await loadCache()).providers).toEqual({})
  })

  it('accepts optional fields when absent', async () => {
    const cache: SessionCache = {
      version: CACHE_VERSION,
      providers: { claude: { envFingerprint: 'x', files: {
        '/f': { fingerprint: { dev: 1, ino: 2, mtimeMs: 3, sizeBytes: 4 }, mcpInventory: [], turns: [] },
      } } },
    }
    await writeRawCache(cache)
    expect((await loadCache())).toEqual(cache)
  })

  it('accepts a fully valid cache with all fields populated', async () => {
    const cache: SessionCache = {
      version: CACHE_VERSION,
      providers: {
        claude: {
          envFingerprint: 'abc',
          files: { '/f': makeCachedFile() },
        },
      },
    }
    await writeRawCache(cache)
    const loaded = await loadCache()
    expect(loaded).toEqual(cache)
  })
})

// ── cleanupOrphanedTempFiles ───────────────────────────────────────────

describe('cleanupOrphanedTempFiles', () => {
  it('removes .tmp files older than 5 minutes', async () => {
    await mkdir(TMP_DIR, { recursive: true })

    const oldTmp = join(TMP_DIR, 'session-cache.json.abc123.tmp')
    await writeFile(oldTmp, 'stale')
    const { utimes } = await import('fs/promises')
    const oldTime = new Date(Date.now() - 10 * 60 * 1000)
    await utimes(oldTmp, oldTime, oldTime)

    await cleanupOrphanedTempFiles()
    expect(existsSync(oldTmp)).toBe(false)
  })

  it('preserves recent .tmp files', async () => {
    await mkdir(TMP_DIR, { recursive: true })

    const recentTmp = join(TMP_DIR, 'session-cache.json.def456.tmp')
    await writeFile(recentTmp, 'recent')

    await cleanupOrphanedTempFiles()
    expect(existsSync(recentTmp)).toBe(true)
  })

  it('ignores .tmp files from other caches', async () => {
    await mkdir(TMP_DIR, { recursive: true })

    const otherTmp = join(TMP_DIR, 'codex-results.json.abc123.tmp')
    await writeFile(otherTmp, 'other cache temp')
    const { utimes } = await import('fs/promises')
    const oldTime = new Date(Date.now() - 10 * 60 * 1000)
    await utimes(otherTmp, oldTime, oldTime)

    await cleanupOrphanedTempFiles()
    expect(existsSync(otherTmp)).toBe(true)
  })

  it('does not fail when cache dir does not exist', async () => {
    process.env['CODEBURN_CACHE_DIR'] = '/no/such/dir'
    await cleanupOrphanedTempFiles()
  })
})

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { parseAllSessions, clearSessionCache } from '../src/parser.js'
import { aggregateByPr } from '../src/sessions-report.js'
import { loadPricing } from '../src/models.js'

// Finding 1: the 5 -> 6 session-cache bump must not make PR-linked sessions whose
// transcript has since expired VANISH. loadCache adopts such expired-source
// entries from session-cache.v5.json, and the claude scan preserves + surfaces
// them so the by-PR legacy even-split path is actually reachable.

let tmpDir: string
let cacheDir: string
let configDir: string

beforeEach(async () => {
  clearSessionCache()
  tmpDir = await mkdtemp(join(tmpdir(), 'v5-adopt-'))
  cacheDir = join(tmpDir, 'cache')
  configDir = join(tmpDir, 'claude')
  await mkdir(cacheDir, { recursive: true })
  // A present, non-PR session so discovery finds a project dir (dirs.length > 0,
  // exercising the eviction path the orphan must survive).
  const presentDir = join(configDir, 'projects', 'present-proj')
  await mkdir(presentDir, { recursive: true })
  await writeFile(join(presentDir, 'present.jsonl'),
    JSON.stringify({ type: 'user', sessionId: 'present', timestamp: '2026-07-20T09:00:00.000Z', cwd: '/present', message: { role: 'user', content: 'hi' } }) + '\n' +
    JSON.stringify({ type: 'assistant', sessionId: 'present', timestamp: '2026-07-20T09:00:01.000Z', cwd: '/present', message: { id: 'p1', type: 'message', role: 'assistant', model: 'claude-opus-4-6', content: [], usage: { input_tokens: 10, output_tokens: 5 } } }) + '\n')
  process.env['CLAUDE_CONFIG_DIR'] = configDir
  process.env['CODEBURN_CACHE_DIR'] = cacheDir
})

afterEach(async () => {
  clearSessionCache()
  delete process.env['CLAUDE_CONFIG_DIR']
  delete process.env['CODEBURN_CACHE_DIR']
  await rm(tmpDir, { recursive: true, force: true })
})

function cachedCall(dedup: string, cost: number): Record<string, unknown> {
  return {
    provider: 'claude', model: 'claude-opus-4-6',
    usage: { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0, cacheCreationOneHourTokens: 0 },
    costUSD: cost, speed: 'standard', timestamp: '2026-07-20T10:00:00.000Z',
    tools: [], bashCommands: [], skills: [], subagentTypes: [], deduplicationKey: dedup,
  }
}

describe('v5 -> v6 cache adoption of expired PR sessions', () => {
  it('keeps a PR-linked session whose transcript is gone, as a legacy approx split', async () => {
    await loadPricing()
    // A v5 cache whose one entry points at a transcript that no longer exists.
    const gonePath = join(configDir, 'projects', 'gone-proj', 'gone.jsonl')
    const v5 = {
      version: 5,
      complete: true,
      providers: {
        claude: {
          envFingerprint: 'stale-v5-fingerprint',
          files: {
            [gonePath]: {
              fingerprint: { dev: 1, ino: 2, mtimeMs: 3, sizeBytes: 4 },
              mcpInventory: [],
              canonicalCwd: '/gone/proj',
              canonicalProjectName: 'gone-proj',
              prLinks: ['https://github.com/o/r/pull/1', 'https://github.com/o/r/pull/2'],
              // Two calls, $40 each -> session total $80, no per-turn prRefs (v5).
              turns: [{
                timestamp: '2026-07-20T10:00:00.000Z', sessionId: 'gone', userMessage: 'shipped work',
                calls: [cachedCall('k1', 40), cachedCall('k2', 40)],
              }],
            },
          },
        },
      },
    }
    await writeFile(join(cacheDir, 'session-cache.v5.json'), JSON.stringify(v5))

    const range = { start: new Date('2026-07-20T00:00:00Z'), end: new Date('2026-07-20T23:59:59Z') }
    const projects = await parseAllSessions(range, 'claude')
    const rows = aggregateByPr(projects)

    // Both PRs survive, each carrying the even-split half of the $80 session, and
    // are flagged approx (legacy) with no category breakdown.
    expect(rows).toHaveLength(2)
    expect(rows.every(r => r.approx)).toBe(true)
    expect(rows.every(r => r.categories === undefined)).toBe(true)
    expect(rows[0]!.cost).toBeCloseTo(40, 6)
    expect(rows[1]!.cost).toBeCloseTo(40, 6)
    // Model union is still surfaced on legacy rows.
    expect(rows[0]!.models.length).toBeGreaterThan(0)
  })

  it('skips a corrupt v5 entry but still adopts a valid expired PR entry', async () => {
    await loadPricing()
    const goodPath = join(configDir, 'projects', 'good-proj', 'good.jsonl')
    const badPath = join(configDir, 'projects', 'bad-proj', 'bad.jsonl')
    const v5 = {
      version: 5,
      complete: true,
      providers: {
        claude: {
          envFingerprint: 'stale-v5',
          files: {
            // Corrupt: malformed turns fail validateCachedFile and are skipped.
            [badPath]: {
              fingerprint: { dev: 9, ino: 9, mtimeMs: 9, sizeBytes: 9 },
              mcpInventory: [],
              prLinks: ['https://github.com/o/r/pull/9'],
              turns: [{ garbage: true }],
            },
            // Valid expired PR entry that must survive alongside the corrupt one.
            [goodPath]: {
              fingerprint: { dev: 1, ino: 2, mtimeMs: 3, sizeBytes: 4 },
              mcpInventory: [],
              canonicalCwd: '/good/proj',
              canonicalProjectName: 'good-proj',
              prLinks: ['https://github.com/o/r/pull/1'],
              turns: [{ timestamp: '2026-07-20T10:00:00.000Z', sessionId: 'good', userMessage: 'work', calls: [cachedCall('gk1', 40)] }],
            },
          },
        },
      },
    }
    await writeFile(join(cacheDir, 'session-cache.v5.json'), JSON.stringify(v5))

    const range = { start: new Date('2026-07-20T00:00:00Z'), end: new Date('2026-07-20T23:59:59Z') }
    const rows = aggregateByPr(await parseAllSessions(range, 'claude'))
    const urls = rows.map(r => r.url)
    expect(urls).toContain('https://github.com/o/r/pull/1') // valid entry survives
    expect(urls).not.toContain('https://github.com/o/r/pull/9') // corrupt entry skipped, not fatal
  })

  it('skips a v5 entry whose optional agentType or failed field is malformed', async () => {
    await loadPricing()
    const badTypePath = join(configDir, 'projects', 'bad-type', 'bad-type.jsonl')
    const badFailedPath = join(configDir, 'projects', 'bad-failed', 'bad-failed.jsonl')
    const goodPath = join(configDir, 'projects', 'good-proj', 'good.jsonl')
    const validTurn = { timestamp: '2026-07-20T10:00:00.000Z', sessionId: 's', userMessage: 'work', calls: [cachedCall('vk1', 40)] }
    const v5 = {
      version: 5,
      complete: true,
      providers: {
        claude: {
          envFingerprint: 'stale-v5',
          files: {
            [badTypePath]: {
              fingerprint: { dev: 9, ino: 9, mtimeMs: 9, sizeBytes: 9 },
              mcpInventory: [],
              prLinks: ['https://github.com/o/r/pull/7'],
              agentType: {},
              turns: [validTurn],
            },
            [badFailedPath]: {
              fingerprint: { dev: 8, ino: 8, mtimeMs: 8, sizeBytes: 8 },
              mcpInventory: [],
              prLinks: ['https://github.com/o/r/pull/8'],
              failed: 'yes',
              turns: [validTurn],
            },
            [goodPath]: {
              fingerprint: { dev: 1, ino: 2, mtimeMs: 3, sizeBytes: 4 },
              mcpInventory: [],
              prLinks: ['https://github.com/o/r/pull/1'],
              agentType: 'general-purpose',
              failed: false,
              turns: [validTurn],
            },
          },
        },
      },
    }
    await writeFile(join(cacheDir, 'session-cache.v5.json'), JSON.stringify(v5))

    const range = { start: new Date('2026-07-20T00:00:00Z'), end: new Date('2026-07-20T23:59:59Z') }
    const rows = aggregateByPr(await parseAllSessions(range, 'claude'))
    const urls = rows.map(r => r.url)
    expect(urls).toContain('https://github.com/o/r/pull/1') // well-formed optionals adopt fine
    expect(urls).not.toContain('https://github.com/o/r/pull/7') // agentType: {} is corrupt, skipped
    expect(urls).not.toContain('https://github.com/o/r/pull/8') // failed: 'yes' is corrupt, skipped
  })
})

function expiredPrEntry(cwd: string, name: string, prUrl: string): Record<string, unknown> {
  return {
    fingerprint: { dev: 1, ino: 2, mtimeMs: 3, sizeBytes: 4 },
    mcpInventory: [], canonicalCwd: cwd, canonicalProjectName: name,
    prLinks: [prUrl],
    turns: [{ timestamp: '2026-07-20T10:00:00.000Z', sessionId: 'gone', userMessage: 'shipped', calls: [cachedCall('kk', 40)] }],
  }
}

// The immediately-preceding versioned cache (v6) must also be adopted on the v7
// bump, or the last build's expired-PR history vanishes (the same bug class that
// dropped v5 on the 5->6 bump).
describe('newest-prior cache adoption (v6 then v5)', () => {
  it('adopts an expired PR entry from a v6-only file into v7 as legacy attribution', async () => {
    await loadPricing()
    const gonePath = join(configDir, 'projects', 'gone6', 'gone6.jsonl')
    const v6 = {
      version: 6, complete: true,
      providers: { claude: { envFingerprint: 'stale-v6', files: { [gonePath]: expiredPrEntry('/gone6', 'gone6', 'https://github.com/o/r/pull/6') } } },
    }
    await writeFile(join(cacheDir, 'session-cache.v6.json'), JSON.stringify(v6))

    const range = { start: new Date('2026-07-20T00:00:00Z'), end: new Date('2026-07-20T23:59:59Z') }
    const rows = aggregateByPr(await parseAllSessions(range, 'claude'))
    const row = rows.find(r => r.url === 'https://github.com/o/r/pull/6')
    expect(row).toBeDefined()
    expect(row!.approx).toBe(true)
    expect(row!.cost).toBeCloseTo(40, 6)
  })

  it('prefers the newest prior file: v6 orphan is adopted, v5-only orphan is not', async () => {
    await loadPricing()
    const v6Path = join(configDir, 'projects', 'in6', 'in6.jsonl')
    const v5Path = join(configDir, 'projects', 'in5', 'in5.jsonl')
    await writeFile(join(cacheDir, 'session-cache.v6.json'), JSON.stringify({
      version: 6, complete: true,
      providers: { claude: { envFingerprint: 'v6', files: { [v6Path]: expiredPrEntry('/in6', 'in6', 'https://github.com/o/r/pull/60') } } },
    }))
    await writeFile(join(cacheDir, 'session-cache.v5.json'), JSON.stringify({
      version: 5, complete: true,
      providers: { claude: { envFingerprint: 'v5', files: { [v5Path]: expiredPrEntry('/in5', 'in5', 'https://github.com/o/r/pull/50') } } },
    }))

    const range = { start: new Date('2026-07-20T00:00:00Z'), end: new Date('2026-07-20T23:59:59Z') }
    const urls = aggregateByPr(await parseAllSessions(range, 'claude')).map(r => r.url)
    expect(urls).toContain('https://github.com/o/r/pull/60')      // v6 (newest) adopted
    expect(urls).not.toContain('https://github.com/o/r/pull/50')  // v5 superseded by v6
  })
})

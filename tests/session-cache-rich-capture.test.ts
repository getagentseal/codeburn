import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rm, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  CACHE_VERSION,
  type CachedCall,
  type CachedFile,
  type SessionCache,
  emptyCache,
  loadCache,
  saveCache,
  sessionCachePath,
} from '../src/session-cache.js'

const TMP_DIR = join(tmpdir(), `codeburn-rich-cache-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)

beforeEach(() => { process.env['CODEBURN_CACHE_DIR'] = TMP_DIR })
afterEach(async () => { if (existsSync(TMP_DIR)) await rm(TMP_DIR, { recursive: true }) })

function richCall(): CachedCall {
  return {
    provider: 'claude',
    model: 'claude-sonnet-4-20250514',
    usage: {
      inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0, cacheCreationOneHourTokens: 0,
    },
    speed: 'standard',
    timestamp: '2026-07-01T10:00:00Z',
    tools: ['Edit'],
    bashCommands: [],
    skills: [],
    subagentTypes: [],
    deduplicationKey: 'm1',
    locAdded: 12,
    locRemoved: 4,
    interrupted: true,
    userModified: true,
    toolErrors: 2,
    editFailed: 1,
  }
}

function richFile(): CachedFile {
  return {
    fingerprint: { dev: 1, ino: 2, mtimeMs: 3, sizeBytes: 4 },
    mcpInventory: [],
    title: 'A rich session',
    prLinks: ['https://github.com/o/r/pull/1', 'https://github.com/o/r/pull/2'],
    isSidechain: true,
    parentSessionId: 'parent-uuid',
    agentSpawnLinks: { a17e80ec626c9de38: 'toolu_spawn1' },
    ambiguousSpawnAgentIds: ['a999abcdef0123456'],
    turns: [
      { timestamp: '2026-07-01T10:00:00Z', sessionId: 's1', userMessage: 'hi', gitBranch: 'feature/x', prRefs: ['https://github.com/o/r/pull/1'], spawnToolUseIds: ['toolu_spawn1'], calls: [richCall()] },
    ],
  }
}

describe('session cache round-trip for rich-capture fields', () => {
  it('preserves per-call, per-turn, and per-session fields through save+load', async () => {
    const cache: SessionCache = {
      ...emptyCache(),
      providers: { claude: { envFingerprint: 'fp', files: { '/x/s1.jsonl': richFile() } } },
    }
    await saveCache(cache)

    const loaded = await loadCache()
    const file = loaded.providers['claude']!.files['/x/s1.jsonl']!
    expect(file.title).toBe('A rich session')
    expect(file.prLinks).toEqual(['https://github.com/o/r/pull/1', 'https://github.com/o/r/pull/2'])
    expect(file.isSidechain).toBe(true)
    expect(file.parentSessionId).toBe('parent-uuid')
    expect(file.agentSpawnLinks).toEqual({ a17e80ec626c9de38: 'toolu_spawn1' })
    expect(file.ambiguousSpawnAgentIds).toEqual(['a999abcdef0123456'])

    const turn = file.turns[0]!
    expect(turn.gitBranch).toBe('feature/x')
    expect(turn.prRefs).toEqual(['https://github.com/o/r/pull/1'])
    expect(turn.spawnToolUseIds).toEqual(['toolu_spawn1'])

    const call = turn.calls[0]!
    expect(call.locAdded).toBe(12)
    expect(call.locRemoved).toBe(4)
    expect(call.interrupted).toBe(true)
    expect(call.userModified).toBe(true)
    expect(call.toolErrors).toBe(2)
    expect(call.editFailed).toBe(1)
  })

  it('still loads an old cache written without any rich-capture fields', async () => {
    const oldCall = { ...richCall() }
    for (const k of ['locAdded', 'locRemoved', 'interrupted', 'userModified', 'toolErrors', 'editFailed'] as const) {
      delete (oldCall as Record<string, unknown>)[k]
    }
    const oldCache: SessionCache = {
      version: CACHE_VERSION,
      complete: true,
      providers: {
        claude: {
          envFingerprint: 'fp',
          files: {
            '/x/old.jsonl': {
              fingerprint: { dev: 1, ino: 2, mtimeMs: 3, sizeBytes: 4 },
              mcpInventory: [],
              turns: [{ timestamp: '2026-07-01T10:00:00Z', sessionId: 's1', userMessage: 'hi', calls: [oldCall] }],
            },
          },
        },
      },
    }
    if (!existsSync(TMP_DIR)) await mkdir(TMP_DIR, { recursive: true })
    await writeFile(sessionCachePath(), JSON.stringify(oldCache), 'utf-8')

    const loaded = await loadCache()
    const call = loaded.providers['claude']!.files['/x/old.jsonl']!.turns[0]!.calls[0]!
    expect(call.deduplicationKey).toBe('m1')
    expect(call.locAdded).toBeUndefined()
    expect(call.editFailed).toBeUndefined()
    expect(loaded.providers['claude']!.files['/x/old.jsonl']!.title).toBeUndefined()
  })
})

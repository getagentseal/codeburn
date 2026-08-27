import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { CACHE_VERSION, computeEnvFingerprint, loadCache, saveCache, type CachedFile, type SessionCache } from '../src/session-cache.js'
import { clearSessionCache, parseAllSessions } from '../src/parser.js'
import { setWslHomes } from '../src/wsl.js'
import type { DateRange } from '../src/types.js'

const ENV_KEYS = ['CODEBURN_CACHE_DIR', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CONFIG_DIRS', 'CODEBURN_DESKTOP_SESSIONS_DIR', 'CODEBURN_WSL'] as const
let saved: Record<string, string | undefined>
let tmpDir: string

// A transcript inside a WSL distro, and one whose file is genuinely deleted.
// Neither is discoverable, which is exactly the point: a stopped distro must
// not read as a deletion.
const WSL_PATH = '\\\\wsl$\\Ubuntu\\home\\me\\.claude\\projects\\-home-me-proj\\wsl-session.jsonl'
const GONE_PATH = '/tmp/codeburn-deleted-forever/gone-session.jsonl'

function cachedFile(sessionId: string, project: string, cost: number): CachedFile {
  return {
    fingerprint: { dev: 0, ino: 0, mtimeMs: 1000, sizeBytes: 100 },
    mcpInventory: [],
    canonicalProjectName: project,
    turns: [{
      timestamp: '2099-05-01T10:00:00.000Z',
      sessionId,
      userMessage: 'hi',
      calls: [{
        provider: 'claude',
        model: 'claude-sonnet-4-5',
        usage: {
          inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
          cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0, cacheCreationOneHourTokens: 0,
        },
        costUSD: cost,
        speed: 'standard',
        timestamp: '2099-05-01T10:00:00.000Z',
        tools: [], bashCommands: [], skills: [], subagentTypes: [],
        deduplicationKey: `dedup-${sessionId}`,
        project,
        projectPath: `/home/me/${project}`,
      }],
    }],
  }
}

function dayRange(day: string): DateRange {
  return { start: new Date(`${day}T00:00:00.000Z`), end: new Date(`${day}T23:59:59.999Z`) }
}

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
  tmpDir = await mkdtemp(join(tmpdir(), 'wsl-evict-'))
  process.env['CODEBURN_CACHE_DIR'] = join(tmpDir, 'cache')
  process.env['CLAUDE_CONFIG_DIR'] = join(tmpDir, 'claude')
  process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] = join(tmpDir, 'no-desktop')
  delete process.env['CLAUDE_CONFIG_DIRS']
  delete process.env['CODEBURN_WSL']
  setWslHomes([])
  clearSessionCache()
  // One real, discovered transcript: the eviction pass is gated on the run
  // having actually scanned something (a pruned-to-nothing config dir keeps
  // its orphans deliberately).
  const realDir = join(tmpDir, 'claude', 'projects', '-home-me-live')
  await mkdir(realDir, { recursive: true })
  await writeFile(join(realDir, 'live-session.jsonl'), JSON.stringify({
    type: 'assistant',
    sessionId: 'sess-live',
    timestamp: '2099-05-01T09:00:00.000Z',
    cwd: '/home/me/live',
    message: {
      id: 'msg-live',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  }) + '\n')

  const cache: SessionCache = {
    version: CACHE_VERSION,
    complete: true,
    providers: {
      claude: {
        envFingerprint: computeEnvFingerprint('claude'),
        files: {
          [WSL_PATH]: cachedFile('sess-wsl', 'wsl-proj', 4.25),
          [GONE_PATH]: cachedFile('sess-gone', 'gone-proj', 9.5),
        },
      },
    },
  }
  await saveCache(cache)
  clearSessionCache()
})

afterEach(async () => {
  setWslHomes(undefined)
  clearSessionCache()
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]!
  }
  await rm(tmpDir, { recursive: true, force: true })
})

describe('a stopped WSL distro is an offline root, not a deleted file (#1059)', () => {
  it('retains and serves the \\\\wsl$ entry while evicting a genuinely deleted one', async () => {
    const projects = await parseAllSessions(dayRange('2099-05-01'), 'claude')

    // Served: spend does not vanish for the length of a `wsl --shutdown`.
    expect(projects.map(p => p.project)).toContain('wsl-proj')
    expect(projects.filter(p => p.project === 'wsl-proj')).toHaveLength(1)
    expect(projects.find(p => p.project === 'wsl-proj')!.totalCostUSD).toBeCloseTo(4.25, 5)
    // Not widened: a normal path whose file is gone is still pruned.
    expect(projects.map(p => p.project)).not.toContain('gone-proj')

    clearSessionCache()
    const after = await loadCache()
    const files = Object.keys(after.providers['claude']?.files ?? {})
    expect(files).toContain(WSL_PATH)
    expect(files).not.toContain(GONE_PATH)
  })

  it('evicts a WSL orphan when its home is still active', async () => {
    setWslHomes(['\\\\wsl$\\Ubuntu\\home\\me'])
    await rm(join(tmpDir, 'claude'), { recursive: true, force: true })

    const projects = await parseAllSessions(dayRange('2099-05-01'), 'claude')
    expect(projects.map(p => p.project)).not.toContain('wsl-proj')

    clearSessionCache()
    const after = await loadCache()
    const files = Object.keys(after.providers['claude']?.files ?? {})
    expect(files).not.toContain(WSL_PATH)
  })

  it('keeps historical WSL usage while off disables discovery and UNC access', async () => {
    process.env['CODEBURN_WSL'] = 'off'

    const projects = await parseAllSessions(dayRange('2099-05-01'), 'claude')
    expect(projects.map(p => p.project)).toContain('wsl-proj')

    clearSessionCache()
    const after = await loadCache()
    expect(Object.keys(after.providers['claude']?.files ?? {})).toContain(WSL_PATH)
  })
})

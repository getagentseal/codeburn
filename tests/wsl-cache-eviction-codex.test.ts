// Same carve-out as wsl-cache-eviction.test.ts, but through
// parseProviderSources (every non-Claude provider) rather than
// scanProjectDirs. Separate file because the codex provider captures
// CODEX_HOME when its module is first imported, so the env has to be in place
// before anything pulls src/parser.ts in — hence the dynamic imports below.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import type { DateRange } from '../src/types.js'

const tmpDir = mkdtempSync(join(tmpdir(), 'wsl-evict-codex-'))
const savedCodexHome = process.env['CODEX_HOME']
process.env['CODEX_HOME'] = join(tmpDir, 'codex')

const { CACHE_VERSION, computeEnvFingerprint, loadCache, saveCache } = await import('../src/session-cache.js')
const { clearSessionCache, parseAllSessions } = await import('../src/parser.js')
const { setWslHomes } = await import('../src/wsl.js')
type CachedFile = Awaited<ReturnType<typeof loadCache>>['providers'][string]['files'][string]
type SessionCache = Awaited<ReturnType<typeof loadCache>>

const WSL_PATH = '\\\\wsl$\\Ubuntu\\home\\me\\.codex\\sessions\\2099\\05\\01\\rollout-2099-05-01T10-00-00-wsl.jsonl'
const GONE_PATH = '/tmp/codeburn-deleted-forever/rollout-2099-05-01T10-00-00-gone.jsonl'

const ENV_KEYS = ['CODEBURN_CACHE_DIR', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CONFIG_DIRS', 'CODEBURN_DESKTOP_SESSIONS_DIR'] as const
let saved: Record<string, string | undefined>

function cachedFile(sessionId: string, project: string, cost: number): CachedFile {
  return {
    fingerprint: { dev: 0, ino: 0, mtimeMs: 1000, sizeBytes: 100 },
    mcpInventory: [],
    turns: [{
      timestamp: '2099-05-01T10:00:00.000Z',
      sessionId,
      userMessage: 'hi',
      calls: [{
        provider: 'codex',
        model: 'gpt-5.3-codex',
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
  process.env['CODEBURN_CACHE_DIR'] = join(tmpDir, 'cache')
  process.env['CLAUDE_CONFIG_DIR'] = join(tmpDir, 'no-claude')
  process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] = join(tmpDir, 'no-desktop')
  delete process.env['CLAUDE_CONFIG_DIRS']
  setWslHomes([])
  clearSessionCache()

  // One discovered rollout: the eviction pass is gated on sources.length > 0.
  const dayDir = join(tmpDir, 'codex', 'sessions', '2099', '05', '01')
  mkdirSync(dayDir, { recursive: true })
  writeFileSync(join(dayDir, 'rollout-2099-05-01T09-00-00-live.jsonl'), JSON.stringify({
    type: 'session_meta',
    timestamp: '2099-05-01T09:00:00Z',
    payload: { cwd: '/home/me/live', originator: 'codex-cli', session_id: 'sess-live', model: 'gpt-5.3-codex' },
  }) + '\n')

  const cache: SessionCache = {
    version: CACHE_VERSION,
    complete: true,
    providers: {
      codex: {
        envFingerprint: computeEnvFingerprint('codex'),
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
  await rm(join(tmpDir, 'cache'), { recursive: true, force: true })
})

afterEach(async () => {
  if (savedCodexHome === undefined) delete process.env['CODEX_HOME']
  else process.env['CODEX_HOME'] = savedCodexHome
})

describe('parseProviderSources: a stopped WSL distro is not a deletion (#1059)', () => {
  it('retains and serves the \\\\wsl$ entry while evicting a genuinely deleted one', async () => {
    const projects = await parseAllSessions(dayRange('2099-05-01'), 'codex')

    expect(projects.map(p => p.project)).toContain('wsl-proj')
    expect(projects.find(p => p.project === 'wsl-proj')!.totalCostUSD).toBeCloseTo(4.25, 5)
    expect(projects.map(p => p.project)).not.toContain('gone-proj')

    clearSessionCache()
    const after = await loadCache()
    const files = Object.keys(after.providers['codex']?.files ?? {})
    expect(files).toContain(WSL_PATH)
    expect(files).not.toContain(GONE_PATH)
  })
})

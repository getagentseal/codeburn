/**
 * #1260 — preserve real cwd through the five issue providers
 * (claude, codex, hermes, kimicode, pi) and refuse basename-only false merges
 * when absolute parents differ. Also covers missing/ambiguous cwd, same-parent
 * fold, cold/warm cache, and supported path shapes.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

import {
  clearSessionCache,
  mergeProjectsByCrossProviderKey,
  parseAllSessions,
  parseProviderSources,
} from '../src/parser.js'
import { createPiProvider } from '../src/providers/pi.js'
import { createCodexProvider } from '../src/providers/codex.js'
import { createKimicodeProvider } from '../src/providers/kimicode.js'
import { CACHE_VERSION } from '../src/session-cache.js'
import { isSqliteAvailable } from '../src/sqlite.js'
import type { ProjectSummary } from '../src/types.js'

function summary(
  project: string,
  projectPath: string,
  opts: { cost?: number; wd?: string } = {},
): ProjectSummary {
  return {
    project,
    projectPath,
    sessions: opts.wd ? ([{ workingDirectory: opts.wd }] as ProjectSummary['sessions']) : [],
    totalCostUSD: opts.cost ?? 1,
    totalApiCalls: 1,
    totalProxiedCostUSD: 0,
  } as ProjectSummary
}

function norm(p: string | undefined): string {
  return (p ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
}

describe('merge: same parent vs different parents (#1260)', () => {
  it('folds five-provider same-parent labels into one abs key', () => {
    const merged = mergeProjectsByCrossProviderKey([
      summary('-root-vault', '/root/vault', { cost: 10 }), // claude
      summary('root-vault', 'root/vault', { cost: 5 }), // codex
      summary('root-vault', '/root/vault', { cost: 4 }), // hermes
      summary('vault', '/root/vault', { cost: 3 }), // kimicode (abs)
      summary('vault', '/root/vault', { cost: 2 }), // pi (abs after fix)
    ])
    expect(merged.size).toBe(1)
    expect([...merged.values()][0]!.totalCostUSD).toBe(24)
  })

  it('keeps /a/vault and /b/vault separate even when both display as vault', () => {
    const merged = mergeProjectsByCrossProviderKey([
      summary('vault', '/a/vault', { cost: 10 }),
      summary('vault', '/b/vault', { cost: 1 }),
    ])
    expect(merged.size).toBe(2)
    const costs = [...merged.values()].map(p => p.totalCostUSD).sort((a, b) => a - b)
    expect(costs).toEqual([1, 10])
  })

  it('does not attach basename-only vault to unique /a/vault when wd proves /b/vault', () => {
    // Session workingDirectory is an abs authority even if projectPath is slug.
    const merged = mergeProjectsByCrossProviderKey([
      summary('vault', '/a/vault', { cost: 10 }),
      summary('vault', 'vault', { cost: 1, wd: '/b/vault' }),
    ])
    expect(merged.size).toBe(2)
  })

  it('unique-basename empty path attaches to the sole abs parent (exact contract)', () => {
    const merged = mergeProjectsByCrossProviderKey([
      summary('vault', '/root/vault', { cost: 10 }),
      summary('vault', '', { cost: 1 }),
    ])
    // Intentional same-dir fallback: empty projectPath with display basename
    // "vault" uniquely matches the sole abs parent /root/vault.
    expect(merged.size).toBe(1)
    expect([...merged.values()][0]!.totalCostUSD).toBe(11)
  })

  it('empty path with non-matching label stays unresolved (no invented parent)', () => {
    const merged = mergeProjectsByCrossProviderKey([
      summary('vault', '/root/vault', { cost: 10 }),
      summary('orphan', '', { cost: 1 }),
    ])
    expect(merged.size).toBe(2)
    const costs = [...merged.values()].map(p => p.totalCostUSD).sort((a, b) => a - b)
    expect(costs).toEqual([1, 10])
  })

  it('ambiguous basename across two abs parents stays label-only', () => {
    const merged = mergeProjectsByCrossProviderKey([
      summary('a-vault', '/a/vault', { cost: 1 }),
      summary('b-vault', '/b/vault', { cost: 2 }),
      summary('vault', 'vault', { cost: 99 }),
    ])
    expect(merged.size).toBe(3)
  })

  it('supports Windows drive and POSIX abs shapes as path keys', () => {
    const merged = mergeProjectsByCrossProviderKey([
      summary('vault', 'C:/Users/x/vault', { cost: 1 }),
      summary('vault', 'C:\\Users\\x\\vault', { cost: 2 }),
      summary('vault', '/Users/x/vault', { cost: 3 }),
    ])
    // Drive-letter variants normalize together; POSIX stays separate.
    expect(merged.size).toBe(2)
    const costs = [...merged.values()].map(p => p.totalCostUSD).sort((a, b) => a - b)
    expect(costs).toEqual([3, 3])
  })
})

describe('pi: discovery → parse → cache preserves abs cwd', () => {
  it('cold parse keeps /b/vault as projectPath and workingDirectory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-cwd-cold-'))
    try {
      const dir = join(root, 'sessions', 'slug')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 's.jsonl'), [
        { type: 'session', version: 3, id: 's', cwd: '/b/vault', timestamp: '2026-04-14T10:00:00Z' },
        { type: 'message', id: 'm', timestamp: '2026-04-14T10:01:00Z', message: {
          role: 'assistant', model: 'gpt-5.4', content: [], responseId: 'r',
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
        } },
      ].map(JSON.stringify).join('\n') + '\n')

      const sources = await createPiProvider(join(root, 'sessions')).discoverSessions()
      expect(sources[0]!.sourcePath).toBe('/b/vault')

      const cache = { version: CACHE_VERSION, providers: {} }
      const cold = await parseProviderSources('pi', sources, new Set(), cache)
      expect(norm(cold[0]!.projectPath)).toBe('/b/vault')
      expect(norm(cold[0]!.sessions[0]!.workingDirectory)).toBe('/b/vault')

      // Warm: unchanged fingerprint serves from cache with cwd still present.
      const warm = await parseProviderSources('pi', sources, new Set(), cache)
      expect(norm(warm[0]!.projectPath)).toBe('/b/vault')
      expect(norm(warm[0]!.sessions[0]!.workingDirectory)).toBe('/b/vault')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('missing header cwd does not invent an abs parent from the leaf name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-cwd-missing-'))
    try {
      const dir = join(root, 'sessions', 'vault')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 's.jsonl'), [
        { type: 'session', version: 3, id: 's', timestamp: '2026-04-14T10:00:00Z' },
        { type: 'message', id: 'm', timestamp: '2026-04-14T10:01:00Z', message: {
          role: 'assistant', model: 'gpt-5.4', content: [], responseId: 'r',
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
        } },
      ].map(JSON.stringify).join('\n') + '\n')

      const sources = await createPiProvider(join(root, 'sessions')).discoverSessions()
      expect(sources[0]!.sourcePath).toBeUndefined()
      const projects = await parseProviderSources('pi', sources, new Set(), { version: CACHE_VERSION, providers: {} })
      // Without abs cwd, projectPath must not become a fabricated /…/vault.
      expect(norm(projects[0]!.projectPath)).not.toMatch(/^\/.+\/vault$/)
      expect(projects[0]!.sessions[0]!.workingDirectory).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('codex: session_meta cwd becomes projectPath', () => {
  it('preserves absolute cwd on ParsedProviderCall and through merge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-cwd-'))
    try {
      const sessions = join(root, 'sessions', '2026', '04', '14')
      await mkdir(sessions, { recursive: true })
      const file = join(sessions, 'rollout-codex-cwd.jsonl')
      await writeFile(file, [
        JSON.stringify({ type: 'session_meta', timestamp: '2026-04-14T10:00:00Z', payload: {
          session_id: 'codex-cwd', model: 'gpt-5.4', cwd: '/b/vault', originator: 'codex_cli_rs',
        } }),
        JSON.stringify({ type: 'response_item', timestamp: '2026-04-14T10:00:30Z', payload: {
          type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }],
        } }),
        JSON.stringify({ type: 'event_msg', timestamp: '2026-04-14T10:01:00Z', payload: {
          type: 'token_count', info: {
            last_token_usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
            total_token_usage: { total_tokens: 120 },
          },
        } }),
        '',
      ].join('\n'))

      const provider = createCodexProvider(root)
      const sources = await provider.discoverSessions()
      expect(sources.some(s => s.path === file)).toBe(true)
      const source = sources.find(s => s.path === file)!
      const calls = []
      for await (const call of provider.createSessionParser(source, new Set()).parse()) calls.push(call)
      expect(calls.length).toBeGreaterThanOrEqual(1)
      expect(norm(calls[0]!.projectPath)).toBe('/b/vault')
      expect(norm(calls[0]!.workingDirectory)).toBe('/b/vault')

      const projects = await parseProviderSources('codex', [source], new Set(), { version: CACHE_VERSION, providers: {} })
      expect(projects.some(p => norm(p.projectPath) === '/b/vault' || norm(p.projectPath) === 'b/vault')).toBe(true)

      const merged = mergeProjectsByCrossProviderKey([
        summary('vault', '/a/vault', { cost: 10 }),
        ...projects.map(p => ({ ...p, totalCostUSD: p.totalCostUSD || 1 })),
      ])
      expect(merged.size).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('claude: JSONL cwd is canonical projectPath', () => {
  let tmpDir: string
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'claude-cwd-1260-'))
    process.env['CLAUDE_CONFIG_DIR'] = tmpDir
    process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] = join(tmpDir, 'desktop-sessions')
    process.env['CODEBURN_CACHE_DIR'] = join(tmpDir, 'cache')
    clearSessionCache()
  })
  afterEach(async () => {
    clearSessionCache()
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('keeps /b/vault (not the -b-vault slug) as projectPath', async () => {
    const projectDir = join(tmpDir, 'projects', '-b-vault')
    await mkdir(projectDir, { recursive: true })
    const filePath = join(projectDir, 'claude-cwd.jsonl')
    await writeFile(filePath, JSON.stringify({
      type: 'assistant',
      sessionId: 'claude-cwd',
      timestamp: '2099-05-01T12:00:00.000Z',
      cwd: '/b/vault',
      message: {
        id: 'msg-1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
        content: [], usage: { input_tokens: 100, output_tokens: 50 },
      },
    }) + '\n')
    await utimes(filePath, new Date('2099-05-01T12:00:00.000Z'), new Date('2099-05-01T12:00:00.000Z'))

    const projects = await parseAllSessions({
      start: new Date('2099-05-01T00:00:00.000Z'),
      end: new Date('2099-05-01T23:59:59.999Z'),
    }, 'claude')
    expect(projects).toHaveLength(1)
    expect(norm(projects[0]!.projectPath)).toBe('/b/vault')
  })
})

describe('kimicode: state.json workDir becomes projectPath', () => {
  const fixtureHome = vi.hoisted(() => {
    const base = process.env['TMPDIR'] || '/tmp'
    return `${base.replace(/[\\/]+$/, '')}/kimicode-cwd-1260-${process.pid}-${Date.now()}`
  })

  beforeEach(async () => {
    await rm(fixtureHome, { recursive: true, force: true })
    await mkdir(fixtureHome, { recursive: true })
    process.env['KIMI_CODE_HOME'] = fixtureHome
    clearSessionCache()
  })
  afterEach(async () => {
    clearSessionCache()
    delete process.env['KIMI_CODE_HOME']
    await rm(fixtureHome, { recursive: true, force: true })
  })

  it('preserves abs workDir through discovery and parse', async () => {
    const workDir = '/b/vault'
    const hash = createHash('md5').update(workDir).digest('hex').slice(0, 12)
    const sessionDir = join(fixtureHome, 'sessions', `wd_vault_${hash}`, 'session_cwd1260')
    const agentDir = join(sessionDir, 'agents', 'main')
    await mkdir(agentDir, { recursive: true })
    await writeFile(join(sessionDir, 'state.json'), JSON.stringify({
      createdAt: '2026-07-01T10:00:00.000Z',
      updatedAt: '2026-07-01T10:05:00.000Z',
      workDir,
      agents: { main: { homedir: '/workspace', type: 'main', parentAgentId: null } },
    }))
    await writeFile(join(agentDir, 'wire.jsonl'), [
      JSON.stringify({ type: 'metadata', protocol_version: '1.4', created_at: 1782900000000 }),
      JSON.stringify({
        type: 'turn.prompt',
        input: [{ type: 'text', text: 'hi' }],
        origin: { kind: 'user' },
        time: 1782900000000,
      }),
      JSON.stringify({
        type: 'llm.request', kind: 'loop', provider: 'fixture-provider',
        model: 'kimi-k2', modelAlias: 'kimi-k2', maxTokens: 4096, messageCount: 2,
        turnStep: '0.1', time: 1782900001000,
      }),
      JSON.stringify({
        type: 'usage.record', model: 'kimi-k2',
        usage: { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 },
        usageScope: 'turn', time: 1782900002000,
      }),
      '',
    ].join('\n'))

    const provider = createKimicodeProvider(fixtureHome)
    const sources = await provider.discoverSessions()
    expect(sources.length).toBeGreaterThanOrEqual(1)
    expect(sources.every(s => s.sourcePath === workDir || s.project === 'vault')).toBe(true)

    const projects = await parseProviderSources('kimicode', sources, new Set(), { version: CACHE_VERSION, providers: {} })
    expect(projects.length).toBeGreaterThanOrEqual(1)
    expect(projects.some(p => norm(p.projectPath) === workDir)).toBe(true)
  })
})

const requireForTest = createRequire(import.meta.url)
const hermesRoot = vi.hoisted(() => {
  const base = process.env['TMPDIR'] || '/tmp'
  const root = `${base.replace(/[\\/]+$/, '')}/hermes-cwd-1260-${process.pid}-${Date.now()}`
  process.env['HERMES_HOME'] = `${root}/hermes`
  return root
})

const skipUnlessSqlite = isSqliteAvailable() ? describe : describe.skip

skipUnlessSqlite('hermes: cwd/git_repo_root becomes projectPath', () => {
  const HERMES_HOME = join(hermesRoot, 'hermes')
  const CACHE_DIR = join(hermesRoot, 'cache')

  beforeEach(async () => {
    clearSessionCache()
    await rm(hermesRoot, { recursive: true, force: true })
    await mkdir(HERMES_HOME, { recursive: true })
    process.env['HERMES_HOME'] = HERMES_HOME
    process.env['CODEBURN_CACHE_DIR'] = CACHE_DIR
  })
  afterEach(async () => {
    clearSessionCache()
    await rm(hermesRoot, { recursive: true, force: true })
  })

  it('preserves abs workspace through parseAllSessions', async () => {
    const { DatabaseSync: Database } = requireForTest('node:sqlite')
    const db = new Database(join(HERMES_HOME, 'state.db'))
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, source TEXT, model TEXT, cwd TEXT, git_repo_root TEXT,
        input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
        cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0,
        reasoning_tokens INTEGER DEFAULT 0, estimated_cost_usd REAL, actual_cost_usd REAL,
        api_call_count INTEGER DEFAULT 0, tool_call_count INTEGER DEFAULT 0,
        started_at REAL, title TEXT
      )
    `)
    db.exec(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
        content TEXT, tool_calls TEXT, timestamp REAL NOT NULL
      )
    `)
    const startedAt = Date.now() / 1000 - 3600
    db.prepare(
      `INSERT INTO sessions (id, source, model, cwd, input_tokens, output_tokens,
        estimated_cost_usd, api_call_count, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('cwd1260', 'cli', 'claude-opus-4-6', '/b/vault', 1000, 200, 0.5, 1, startedAt)
    db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
      .run('cwd1260', 'user', 'hello', startedAt)
    db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
      .run('cwd1260', 'assistant', 'world', startedAt + 1)
    db.close()

    const projects = await parseAllSessions(undefined, 'hermes')
    expect(projects.length).toBeGreaterThanOrEqual(1)
    expect(projects.some(p => norm(p.projectPath) === '/b/vault')).toBe(true)
  })
})

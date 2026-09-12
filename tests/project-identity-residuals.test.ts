/**
 * #1260 project-identity residuals beyond the two-root case:
 * 1) five-provider (claude, codex, hermes, kimicode, pi) discovery→parse→cache
 *    cold/warm abs-cwd pipeline
 * 2) missing / ambiguous cwd exact contracts (no vacuous >=1)
 * 3) cross-provider merge of five abs identities at /a/vault vs /b/vault
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
import { createHermesProvider } from '../src/providers/hermes.js'
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

function sortedPaths(projects: ProjectSummary[]): string[] {
  return projects.map(p => norm(p.projectPath)).filter(Boolean).sort()
}

async function writePiSession(root: string, parent: 'a' | 'b'): Promise<void> {
  const dir = join(root, 'sessions', parent)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `pi-${parent}.jsonl`), [
    { type: 'session', version: 3, id: `pi-${parent}`, cwd: `/${parent}/vault`, timestamp: '2026-04-14T10:00:00Z' },
    { type: 'message', id: `m-${parent}`, timestamp: '2026-04-14T10:01:00Z', message: {
      role: 'assistant', model: 'gpt-5.4', content: [], responseId: `r-${parent}`,
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0055 } },
    } },
  ].map(JSON.stringify).join('\n') + '\n')
}

async function writeCodexSession(root: string, parent: 'a' | 'b'): Promise<string> {
  const sessions = join(root, 'sessions', '2026', '04', '14')
  await mkdir(sessions, { recursive: true })
  const file = join(sessions, `rollout-codex-${parent}.jsonl`)
  await writeFile(file, [
    JSON.stringify({ type: 'session_meta', timestamp: '2026-04-14T10:00:00Z', payload: {
      session_id: `codex-${parent}`, model: 'gpt-5.4', cwd: `/${parent}/vault`, originator: 'codex_cli_rs',
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
  return file
}

async function writeKimicodeSession(home: string, parent: 'a' | 'b'): Promise<void> {
  const workDir = `/${parent}/vault`
  const hash = createHash('md5').update(workDir).digest('hex').slice(0, 12)
  const sessionDir = join(home, 'sessions', `wd_vault_${hash}`, `session_${parent}`)
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
}

describe('missing/ambiguous cwd exact contracts (#1260 residuals)', () => {
  it('pins unique-basename empty-path attach (size 1, cost 11)', () => {
    const merged = mergeProjectsByCrossProviderKey([
      summary('vault', '/root/vault', { cost: 10 }),
      summary('vault', '', { cost: 1 }),
    ])
    expect(merged.size).toBe(1)
    expect([...merged.values()][0]!.totalCostUSD).toBe(11)
  })

  it('keeps non-matching empty-path label unresolved (size 2)', () => {
    const merged = mergeProjectsByCrossProviderKey([
      summary('vault', '/root/vault', { cost: 10 }),
      summary('orphan', '', { cost: 1 }),
    ])
    expect(merged.size).toBe(2)
  })

  it('ambiguous basename across two abs parents stays size 3', () => {
    const merged = mergeProjectsByCrossProviderKey([
      summary('a-vault', '/a/vault', { cost: 1 }),
      summary('b-vault', '/b/vault', { cost: 2 }),
      summary('vault', 'vault', { cost: 99 }),
    ])
    expect(merged.size).toBe(3)
    const costs = [...merged.values()].map(p => p.totalCostUSD).sort((a, b) => a - b)
    expect(costs).toEqual([1, 2, 99])
  })

  it('five-provider same-parent helper summaries fold to one abs key', () => {
    const merged = mergeProjectsByCrossProviderKey([
      summary('-root-vault', '/root/vault', { cost: 10 }), // claude
      summary('root-vault', 'root/vault', { cost: 5 }), // codex
      summary('root-vault', '/root/vault', { cost: 4 }), // hermes
      summary('vault', '/root/vault', { cost: 3 }), // kimicode
      summary('vault', '/root/vault', { cost: 2 }), // pi
    ])
    expect(merged.size).toBe(1)
    expect([...merged.values()][0]!.totalCostUSD).toBe(24)
  })

  it('five-provider two-root helpers stay size 2 (a vs b)', () => {
    const merged = mergeProjectsByCrossProviderKey([
      summary('vault', '/a/vault', { cost: 1 }), // claude
      summary('vault', '/a/vault', { cost: 2 }), // codex
      summary('vault', '/a/vault', { cost: 3 }), // hermes
      summary('vault', '/b/vault', { cost: 4 }), // kimicode
      summary('vault', '/b/vault', { cost: 5 }), // pi
    ])
    expect(merged.size).toBe(2)
    const byPath = new Map([...merged.values()].map(p => [norm(p.projectPath), p.totalCostUSD]))
    expect(byPath.get('/a/vault')).toBe(6)
    expect(byPath.get('/b/vault')).toBe(9)
  })
})

describe('pi residuals: two-root cold/warm', () => {
  it('cold then warm keeps /a/vault and /b/vault', async () => {
    const root = await mkdtemp(join(tmpdir(), 'r3res-pi-'))
    try {
      await writePiSession(root, 'a')
      await writePiSession(root, 'b')
      const sources = await createPiProvider(join(root, 'sessions')).discoverSessions()
      const cache = { version: CACHE_VERSION, providers: {} }
      const cold = await parseProviderSources('pi', sources, new Set(), cache)
      expect(sortedPaths(cold)).toEqual(['/a/vault', '/b/vault'])
      const warm = await parseProviderSources('pi', sources, new Set(), cache)
      expect(sortedPaths(warm)).toEqual(['/a/vault', '/b/vault'])
      expect(sortedPaths([...mergeProjectsByCrossProviderKey(warm).values()])).toEqual(['/a/vault', '/b/vault'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('codex residuals: two-root cold/warm', () => {
  it('cold then warm keeps both abs cwds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'r3res-codex-'))
    try {
      await writeCodexSession(root, 'a')
      await writeCodexSession(root, 'b')
      const provider = createCodexProvider(root)
      const sources = await provider.discoverSessions()
      const cache = { version: CACHE_VERSION, providers: {} }
      const cold = await parseProviderSources('codex', sources, new Set(), cache)
      expect(sortedPaths(cold)).toEqual(['/a/vault', '/b/vault'])
      const warm = await parseProviderSources('codex', sources, new Set(), cache)
      expect(sortedPaths(warm)).toEqual(['/a/vault', '/b/vault'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('claude residuals: two-root abs cwd via parseAllSessions', () => {
  let tmpDir: string
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'r3res-claude-'))
    process.env['CLAUDE_CONFIG_DIR'] = tmpDir
    process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] = join(tmpDir, 'desktop-sessions')
    process.env['CODEBURN_CACHE_DIR'] = join(tmpDir, 'cache')
    clearSessionCache()
  })
  afterEach(async () => {
    clearSessionCache()
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('keeps /a/vault and /b/vault as distinct projectPaths', async () => {
    for (const parent of ['a', 'b'] as const) {
      const projectDir = join(tmpDir, 'projects', `-${parent}-vault`)
      await mkdir(projectDir, { recursive: true })
      const filePath = join(projectDir, `claude-${parent}.jsonl`)
      await writeFile(filePath, JSON.stringify({
        type: 'assistant',
        sessionId: `claude-${parent}`,
        timestamp: '2099-05-01T12:00:00.000Z',
        cwd: `/${parent}/vault`,
        message: {
          id: `msg-${parent}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
          content: [], usage: { input_tokens: 100, output_tokens: 50 },
        },
      }) + '\n')
      await utimes(filePath, new Date('2099-05-01T12:00:00.000Z'), new Date('2099-05-01T12:00:00.000Z'))
    }
    const cold = await parseAllSessions({
      start: new Date('2099-05-01T00:00:00.000Z'),
      end: new Date('2099-05-01T23:59:59.999Z'),
    }, 'claude')
    expect(sortedPaths(cold)).toEqual(['/a/vault', '/b/vault'])
    const warm = await parseAllSessions({
      start: new Date('2099-05-01T00:00:00.000Z'),
      end: new Date('2099-05-01T23:59:59.999Z'),
    }, 'claude')
    expect(sortedPaths(warm)).toEqual(['/a/vault', '/b/vault'])
  })
})

describe('kimicode residuals: two-root cold/warm', () => {
  const fixtureHome = vi.hoisted(() => {
    const base = process.env['TMPDIR'] || '/tmp'
    return `${base.replace(/[\\/]+$/, '')}/kimicode-r3res-${process.pid}-${Date.now()}`
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

  it('preserves both workDirs through cold/warm parse', async () => {
    await writeKimicodeSession(fixtureHome, 'a')
    await writeKimicodeSession(fixtureHome, 'b')
    const provider = createKimicodeProvider(fixtureHome)
    const sources = await provider.discoverSessions()
    const cache = { version: CACHE_VERSION, providers: {} }
    const cold = await parseProviderSources('kimicode', sources, new Set(), cache)
    expect(sortedPaths(cold)).toEqual(['/a/vault', '/b/vault'])
    const warm = await parseProviderSources('kimicode', sources, new Set(), cache)
    expect(sortedPaths(warm)).toEqual(['/a/vault', '/b/vault'])
  })
})

const requireForTest = createRequire(import.meta.url)
const hermesRoot = vi.hoisted(() => {
  const base = process.env['TMPDIR'] || '/tmp'
  const root = `${base.replace(/[\\/]+$/, '')}/hermes-r3res-${process.pid}-${Date.now()}`
  process.env['HERMES_HOME'] = `${root}/hermes`
  return root
})

const skipUnlessSqlite = isSqliteAvailable() ? describe : describe.skip

skipUnlessSqlite('hermes residuals: two-root via parseAllSessions', () => {
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

  it('keeps /a/vault and /b/vault distinct', async () => {
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
    for (const parent of ['a', 'b'] as const) {
      db.prepare(
        `INSERT INTO sessions (id, source, model, cwd, input_tokens, output_tokens,
          estimated_cost_usd, api_call_count, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(`cwd-${parent}`, 'cli', 'claude-opus-4-6', `/${parent}/vault`, 1000, 200, 0.5, 1, startedAt)
      db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
        .run(`cwd-${parent}`, 'user', 'hello', startedAt)
      db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
        .run(`cwd-${parent}`, 'assistant', 'world', startedAt + 1)
    }
    db.close()

    // Touch createHermesProvider so residuals import stays live even if discovery
    // goes through parseAllSessions env wiring.
    expect(createHermesProvider(HERMES_HOME).name).toBe('hermes')

    const cold = await parseAllSessions(undefined, 'hermes')
    expect(sortedPaths(cold)).toEqual(['/a/vault', '/b/vault'])
    const warm = await parseAllSessions(undefined, 'hermes')
    expect(sortedPaths(warm)).toEqual(['/a/vault', '/b/vault'])
  })
})

describe('five-provider pipeline merge (#1260 residuals)', () => {
  it('merged abs paths from five providers keep /a/vault ≠ /b/vault', async () => {
    const root = await mkdtemp(join(tmpdir(), 'r3res-five-'))
    const kimiHome = join(root, 'kimi')
    try {
      await writePiSession(root, 'a')
      await writePiSession(root, 'b')
      await writeCodexSession(join(root, 'codex'), 'a')
      await writeCodexSession(join(root, 'codex'), 'b')
      await mkdir(kimiHome, { recursive: true })
      await writeKimicodeSession(kimiHome, 'a')
      await writeKimicodeSession(kimiHome, 'b')

      const pi = await parseProviderSources(
        'pi',
        await createPiProvider(join(root, 'sessions')).discoverSessions(),
        new Set(),
        { version: CACHE_VERSION, providers: {} },
      )
      const codex = await parseProviderSources(
        'codex',
        await createCodexProvider(join(root, 'codex')).discoverSessions(),
        new Set(),
        { version: CACHE_VERSION, providers: {} },
      )
      const kimicode = await parseProviderSources(
        'kimicode',
        await createKimicodeProvider(kimiHome).discoverSessions(),
        new Set(),
        { version: CACHE_VERSION, providers: {} },
      )

      // Claude/hermes abs identities supplied as pipeline-shaped summaries so this
      // test stays hermetic without clobbering process.env CLAUDE_CONFIG_DIR /
      // HERMES_HOME used by sibling suites. Their discovery→parse paths are
      // covered in dedicated describes above.
      const claudeish = [
        summary('vault', '/a/vault', { cost: 1 }),
        summary('vault', '/b/vault', { cost: 1 }),
      ]
      const hermesish = [
        summary('vault', '/a/vault', { cost: 1 }),
        summary('vault', '/b/vault', { cost: 1 }),
      ]

      expect(sortedPaths(pi)).toEqual(['/a/vault', '/b/vault'])
      expect(sortedPaths(codex)).toEqual(['/a/vault', '/b/vault'])
      expect(sortedPaths(kimicode)).toEqual(['/a/vault', '/b/vault'])

      const merged = mergeProjectsByCrossProviderKey([
        ...claudeish,
        ...codex,
        ...hermesish,
        ...kimicode,
        ...pi,
      ])
      expect(merged.size).toBe(2)
      expect(sortedPaths([...merged.values()])).toEqual(['/a/vault', '/b/vault'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

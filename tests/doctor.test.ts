import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { collectDoctorReport, renderDoctorTable, renderDoctorJson } from '../src/doctor.js'
import { createCodexProvider } from '../src/providers/codex.js'
import { emptyCache, type SessionCache } from '../src/session-cache.js'
import type { Provider, ProbeRoot, SessionSource } from '../src/providers/types.js'

// ── Helpers ──────────────────────────────────────────────────────────────

// A valid single-line Codex rollout so real discovery + probeRoots + parse run
// end to end against a fixture directory.
function sessionMeta(): string {
  return JSON.stringify({
    type: 'session_meta',
    timestamp: '2026-04-14T10:00:00Z',
    payload: {
      cwd: '/Users/test/proj',
      originator: 'codex-cli',
      session_id: 'sess-001',
      model: 'gpt-5.3-codex',
    },
  })
}

function tokenCount(): string {
  return JSON.stringify({
    type: 'event_msg',
    timestamp: '2026-04-14T10:01:00Z',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 100,
          cached_input_tokens: 0,
          output_tokens: 50,
          reasoning_output_tokens: 0,
          total_tokens: 150,
        },
      },
    },
  })
}

async function writeCodexSession(codexDir: string): Promise<void> {
  const dayDir = join(codexDir, 'sessions', '2026', '04', '14')
  await mkdir(dayDir, { recursive: true })
  await writeFile(join(dayDir, 'rollout-sess-001.jsonl'), `${sessionMeta()}\n${tokenCount()}\n`)
}

// Fully controllable synthetic provider for the edge cases (network, throwing,
// parse failure) that on-disk fixtures cannot force deterministically.
function fakeProvider(over: Partial<Provider> & { name: string }): Provider {
  return {
    displayName: over.name,
    modelDisplayName: (m: string) => m,
    toolDisplayName: (t: string) => t,
    discoverSessions: async () => [],
    createSessionParser: () => ({ async *parse() {} }),
    ...over,
  }
}

function only(report: Awaited<ReturnType<typeof collectDoctorReport>>, name: string) {
  const r = report.providers.find(p => p.provider === name)
  if (!r) throw new Error(`no report row for ${name}`)
  return r
}

let tmpDir: string
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), 'doctor-test-')) })
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }) })

// ── Real-provider fixture-dir cases: found / empty / missing ───────────────

describe('collectDoctorReport - codex fixture dirs', () => {
  it('found: a real session file yields an OK verdict and a parsed sample', async () => {
    await writeCodexSession(tmpDir)
    const provider = createCodexProvider(tmpDir)
    const report = await collectDoctorReport('all', { providers: [provider], cache: emptyCache() })
    const r = only(report, 'codex')

    expect(r.status).toBe('ok')
    expect(r.candidatesFound).toBeGreaterThanOrEqual(1)
    expect(r.parsedOk).toBeGreaterThanOrEqual(1)
    expect(r.parseFailed).toBe(0)
    expect(r.verdict).toMatch(/^OK \(/)
    const sessions = r.probePaths.find(p => p.label === 'sessions')
    expect(sessions?.exists).toBe(true)
  })

  it('empty: sessions dir exists but holds nothing -> NOTHING FOUND (no sessions)', async () => {
    await mkdir(join(tmpDir, 'sessions'), { recursive: true })
    const provider = createCodexProvider(tmpDir)
    const report = await collectDoctorReport('all', { providers: [provider], cache: emptyCache() })
    const r = only(report, 'codex')

    expect(r.status).toBe('empty')
    expect(r.candidatesFound).toBe(0)
    expect(r.verdict).toContain('holds no sessions')
    expect(r.probePaths.find(p => p.label === 'sessions')?.exists).toBe(true)
  })

  it('missing: no sessions dir -> NOTHING FOUND names the missing path', async () => {
    // tmpDir has no `sessions` subdir at all.
    const provider = createCodexProvider(tmpDir)
    const report = await collectDoctorReport('all', { providers: [provider], cache: emptyCache() })
    const r = only(report, 'codex')

    expect(r.status).toBe('empty')
    expect(r.candidatesFound).toBe(0)
    // Mutation guard: if the exists-check is broken to always return true, this
    // flips to false and the verdict drops "does not exist".
    expect(r.probePaths.find(p => p.label === 'sessions')?.exists).toBe(false)
    expect(r.verdict).toContain('does not exist')
    expect(r.verdict).toContain(join(tmpDir, 'sessions'))
  })
})

// ── Override case ──────────────────────────────────────────────────────────

describe('collectDoctorReport - env override', () => {
  it('names a set override pointing at a missing dir', async () => {
    const prev = process.env['CODEX_HOME']
    const bogus = join(tmpDir, 'does-not-exist')
    process.env['CODEX_HOME'] = bogus
    try {
      // Construct after setting env so the provider resolves CODEX_HOME.
      const provider = createCodexProvider()
      const report = await collectDoctorReport('all', { providers: [provider], cache: emptyCache() })
      const r = only(report, 'codex')

      expect(r.envOverrides).toEqual([{ name: 'CODEX_HOME', value: bogus }])
      expect(r.status).toBe('empty')
      expect(r.verdict).toContain('override CODEX_HOME set')
      expect(r.verdict).toContain('does not exist')
    } finally {
      if (prev === undefined) delete process.env['CODEX_HOME']
      else process.env['CODEX_HOME'] = prev
    }
  })
})

// ── Synthetic edge cases ───────────────────────────────────────────────────

describe('collectDoctorReport - isolation and edge cases', () => {
  it('a provider that throws in discovery becomes an ERROR row, others survive', async () => {
    const boom = fakeProvider({
      name: 'boom',
      discoverSessions: async () => { throw new Error('disk on fire') },
    })
    const good = fakeProvider({
      name: 'good',
      discoverSessions: async () => [{ path: '/x/a.json', project: 'p', provider: 'good' }],
    })
    const report = await collectDoctorReport('all', { providers: [boom, good], cache: emptyCache() })

    const b = only(report, 'boom')
    expect(b.status).toBe('error')
    expect(b.error).toContain('disk on fire')
    expect(b.verdict).toMatch(/^ERROR \(/)
    expect(only(report, 'good').status).toBe('ok')
  })

  it('a parser that throws is counted and downgrades the verdict to ERRORS', async () => {
    const src: SessionSource = { path: '/x/a.json', project: 'p', provider: 'flaky' }
    const flaky = fakeProvider({
      name: 'flaky',
      discoverSessions: async () => [src],
      createSessionParser: () => ({
        // eslint-disable-next-line require-yield
        async *parse() { throw new Error('bad json') },
      }),
    })
    const r = only(await collectDoctorReport('all', { providers: [flaky], cache: emptyCache() }), 'flaky')

    expect(r.status).toBe('errors')
    expect(r.parseFailed).toBe(1)
    expect(r.parsedOk).toBe(0)
    expect(r.verdict).toMatch(/^ERRORS \(/)
  })

  it('network providers are never parsed offline', async () => {
    let parserCreated = false
    const net = fakeProvider({
      name: 'net',
      network: true,
      discoverSessions: async () => [{ path: 'net:report', project: 'p', provider: 'net' }],
      createSessionParser: () => { parserCreated = true; return { async *parse() {} } },
    })
    const r = only(await collectDoctorReport('all', { providers: [net], cache: emptyCache() }), 'net')

    expect(parserCreated).toBe(false)
    expect(r.status).toBe('network')
    expect(r.sampled).toBe(0)
    expect(r.verdict).toContain('NETWORK')
  })

  it('bounds the parse sample and flags it', async () => {
    const sources: SessionSource[] = Array.from({ length: 5 }, (_, i) => ({ path: `/x/${i}.json`, project: 'p', provider: 'many' }))
    const many = fakeProvider({
      name: 'many',
      discoverSessions: async () => sources,
      createSessionParser: () => ({ async *parse() { yield undefined as never } }),
    })
    const r = only(await collectDoctorReport('all', { providers: [many], cache: emptyCache(), sampleLimit: 2 }), 'many')

    expect(r.candidatesFound).toBe(5)
    expect(r.sampled).toBe(2)
    expect(r.bounded).toBe(true)
    expect(r.status).toBe('ok')
  })

  it('reports cache state from the injected snapshot', async () => {
    const cache: SessionCache = emptyCache()
    cache.providers['cached'] = {
      envFingerprint: 'x',
      files: {
        '/a.jsonl': { fingerprint: { dev: 1, ino: 1, mtimeMs: 1, sizeBytes: 1 }, mcpInventory: [], turns: [] },
        '/b.jsonl': { fingerprint: { dev: 1, ino: 2, mtimeMs: 1, sizeBytes: 1 }, mcpInventory: [], turns: [], failed: true },
      },
    }
    const provider = fakeProvider({ name: 'cached', discoverSessions: async () => [] })
    const r = only(await collectDoctorReport('all', { providers: [provider], cache }), 'cached')

    expect(r.cachedFiles).toBe(2)
    expect(r.cachedFailed).toBe(1)
  })

  it('filters to a single provider by name', async () => {
    const a = fakeProvider({ name: 'a' })
    const b = fakeProvider({ name: 'b' })
    const report = await collectDoctorReport('b', { providers: [a, b], cache: emptyCache() })
    expect(report.providers.map(p => p.provider)).toEqual(['b'])
  })
})

// ── Rendering ──────────────────────────────────────────────────────────────

describe('doctor rendering', () => {
  it('renders a plain-text table naming the override and missing path', async () => {
    const provider = fakeProvider({
      name: 'claude',
      displayName: 'Claude',
      probeRoots: async (): Promise<ProbeRoot[]> => [{ path: '/nonexistent/projects', label: 'projects' }],
      discoverSessions: async () => [],
    })
    const prev = process.env['CLAUDE_CONFIG_DIR']
    process.env['CLAUDE_CONFIG_DIR'] = '/nonexistent'
    try {
      const report = await collectDoctorReport('all', { providers: [provider], cache: emptyCache() })
      const out = renderDoctorTable(report, { color: false })
      expect(out).toContain('CodeBurn doctor')
      expect(out).toContain('NOTHING FOUND')
      expect(out).toContain('CLAUDE_CONFIG_DIR=/nonexistent')
      expect(out).toContain('/nonexistent/projects')
      expect(out).toContain('missing')
      // no-color mode emits no ANSI escapes
      // eslint-disable-next-line no-control-regex
      expect(out).not.toMatch(/\[/)
    } finally {
      if (prev === undefined) delete process.env['CLAUDE_CONFIG_DIR']
      else process.env['CLAUDE_CONFIG_DIR'] = prev
    }
  })

  it('emits valid, round-trippable JSON', async () => {
    const provider = fakeProvider({ name: 'a', discoverSessions: async () => [] })
    const report = await collectDoctorReport('all', { providers: [provider], cache: emptyCache() })
    const parsed = JSON.parse(renderDoctorJson(report))
    expect(parsed.providers[0].provider).toBe('a')
    expect(typeof parsed.generatedAt).toBe('string')
  })
})

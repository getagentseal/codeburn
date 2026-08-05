/**
 * CLI-level tests for `codeburn sync push --attribution`.
 *
 * Drives the real commander action against a mock IdP + collector:
 * - --dry-run --attribution: NO telemetry reaches the traces endpoint
 * - push WITHOUT the flag: no attribution span names on the wire
 * - push WITH the flag: attribution spans arrive alongside usage spans
 */

import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { Command } from 'commander'

import { startMockIdp, type MockIdp } from './fixtures/mock-idp.js'
import type { ProjectSummary, SessionSummary, ParsedApiCall, TokenUsage } from '../src/types.js'

const { parseAllSessionsMock } = vi.hoisted(() => ({ parseAllSessionsMock: vi.fn() }))
vi.mock('../src/parser.js', () => ({ parseAllSessions: parseAllSessionsMock }))

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', env: { ...process.env, ...env } }).trim()
}

function makeUsage(): TokenUsage {
  return { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0 }
}

function makeCall(key: string, ts: string): ParsedApiCall {
  return {
    provider: 'test', model: 'test-model', usage: makeUsage(), costUSD: 0.01,
    tools: [], mcpTools: [], skills: [], subagentTypes: [], hasAgentSpawn: false,
    hasPlanMode: false, speed: 'standard', timestamp: ts, bashCommands: [],
    deduplicationKey: key,
  }
}

function makeSession(id: string, first: string, last: string, calls: ParsedApiCall[]): SessionSummary {
  return {
    sessionId: id, project: 'app', firstTimestamp: first, lastTimestamp: last,
    totalCostUSD: 0.01, totalSavingsUSD: 0, totalInputTokens: 10, totalOutputTokens: 5,
    totalReasoningTokens: 0, totalCacheReadTokens: 0, totalCacheWriteTokens: 0,
    apiCalls: calls.length,
    turns: [{ userMessage: 'x', assistantCalls: calls, timestamp: first, sessionId: id, category: 'coding', retries: 0, hasEdits: false }],
    modelBreakdown: {}, toolBreakdown: {}, mcpBreakdown: {}, bashBreakdown: {},
    categoryBreakdown: {} as SessionSummary['categoryBreakdown'], skillBreakdown: {}, subagentBreakdown: {},
  }
}

let idp: MockIdp
let tmpHome: string
let repoDir: string
const originalHome = process.env.HOME
const originalXdg = process.env.XDG_CACHE_HOME
const originalStore = process.env.CODEBURN_SYNC_TOKEN_STORE

async function runPush(args: string[]): Promise<void> {
  const { registerSyncCommands } = await import('../src/sync/cli.js')
  const program = new Command()
  program.exitOverride() // throw instead of process.exit on commander errors
  registerSyncCommands(program)
  await program.parseAsync(['node', 'codeburn', 'sync', 'push', ...args])
}

beforeAll(async () => {
  idp = await startMockIdp({ rotateTokens: false })
  process.env.CODEBURN_SYNC_TOKEN_STORE = 'file'

  // Real git repo with a remote — a recent commit inside the session window
  repoDir = await mkdtemp(join(tmpdir(), 'codeburn-attr-cli-repo-'))
  git(repoDir, ['init', '-b', 'main'])
  git(repoDir, ['config', 'user.email', 't@e.com'])
  git(repoDir, ['config', 'user.name', 'T'])
  git(repoDir, ['remote', 'add', 'origin', 'git@github.com:acme/cli-widget.git'])
  await writeFile(join(repoDir, 'f.txt'), 'x\n')
  const commitIso = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  git(repoDir, ['add', '.'])
  git(repoDir, ['commit', '-m', 'feat: recent'], { GIT_AUTHOR_DATE: commitIso, GIT_COMMITTER_DATE: commitIso })
})

afterAll(async () => {
  await idp.close()
  await rm(repoDir, { recursive: true, force: true })
  if (originalStore === undefined) delete process.env.CODEBURN_SYNC_TOKEN_STORE
  else process.env.CODEBURN_SYNC_TOKEN_STORE = originalStore
})

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), 'codeburn-attr-cli-'))
  process.env.HOME = tmpHome
  process.env.XDG_CACHE_HOME = join(tmpHome, '.cache')
  idp.tracesRequests.length = 0

  // Configure sync against the mock IdP + store the refresh token
  const { writeSyncConfig } = await import('../src/sync/config.js')
  const { createCredentialStore } = await import('../src/sync/credentials.js')
  writeSyncConfig({ baseUrl: idp.baseUrl, clientId: 'mock-client-id', tracesPath: '/v1/traces', issuer: idp.baseUrl })
  createCredentialStore().store('mock-refresh-token-v1')

  // One session in the last hour, working in the real repo
  const now = Date.now()
  const first = new Date(now - 90 * 60 * 1000).toISOString()
  const last = new Date(now - 30 * 60 * 1000).toISOString()
  const session = makeSession('cli-sess-1', first, last, [makeCall(`call-${now}`, first)])
  parseAllSessionsMock.mockResolvedValue([
    { project: 'app', projectPath: repoDir, sessions: [session] } as ProjectSummary,
  ])

  // The push action reads process.cwd() for the attribution cwd — run from
  // a neutral non-repo dir so nothing can come from a cwd fallback.
  vi.spyOn(process, 'cwd').mockReturnValue(tmpHome)
})

afterEach(async () => {
  vi.restoreAllMocks()
  process.exitCode = 0
  process.env.HOME = originalHome
  if (originalXdg === undefined) delete process.env.XDG_CACHE_HOME
  else process.env.XDG_CACHE_HOME = originalXdg
  await rm(tmpHome, { recursive: true, force: true })
})

const spanNames = (): string[] =>
  idp.tracesRequests.flatMap(r => {
    const body = r.body as { resourceSpans?: Array<{ scopeSpans: Array<{ spans: Array<{ name: string }> }> }> }
    return (body.resourceSpans ?? []).flatMap(rs => rs.scopeSpans.flatMap(ss => ss.spans.map(s => s.name)))
  })

describe('sync push --attribution (CLI level)', () => {
  it('--dry-run --attribution sends nothing to the traces endpoint', async () => {
    await runPush(['--dry-run', '--attribution'])
    expect(idp.tracesRequests).toHaveLength(0)
  })

  it('push WITHOUT --attribution never emits attribution span names', async () => {
    await runPush([])
    expect(idp.tracesRequests.length).toBeGreaterThan(0)
    const names = spanNames()
    expect(names.length).toBeGreaterThan(0)
    expect(names).not.toContain('codeburn.session.attribution')
    expect(names).not.toContain('codeburn.commit')
    expect(JSON.stringify(idp.tracesRequests)).not.toContain('git.sha')
  })

  it('push WITH --attribution emits usage + attribution spans', async () => {
    await runPush(['--attribution'])
    const names = spanNames()
    expect(names).toContain('test/test-model')                // usage span
    expect(names).toContain('codeburn.session.attribution')   // session span
    expect(names).toContain('codeburn.commit')                // commit span
    const wire = JSON.stringify(idp.tracesRequests)
    expect(wire).toContain('github.com/acme/cli-widget')
  })
})

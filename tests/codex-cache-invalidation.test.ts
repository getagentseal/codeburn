// Regression for the codex stale-cache path (#478 follow-up, same class as
// the kiro bug #618/#619). session-cache.json serves unchanged session files
// without invoking the provider parser, so bumping CODEX_CACHE_VERSION alone
// does NOT re-attribute already-cached sessions. Registering `codex` in
// PROVIDER_PARSE_VERSIONS changes the provider envFingerprint, which discards
// the stale section and forces a re-parse. This exercises the full
// parseAllSessions pipeline against a cache seeded with the PRE-fix
// fingerprint and asserts the mcp-cli MCP attribution is recovered.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdir, rm, readFile, writeFile } from 'fs/promises'
import { createHash } from 'crypto'
import { join } from 'path'

import { clearSessionCache, parseAllSessions } from '../src/parser.js'
import type { SessionCache } from '../src/session-cache.js'
import { readCacheOnDisk, writeCacheOnDisk } from './fixtures/session-cache-io.js'

const testRoot = vi.hoisted(() => {
  const root = `${process.env['TMPDIR'] || '/tmp'}/codex-stale-repro-${process.pid}-${Date.now()}`
  process.env['HOME'] = `${root}/home`
  process.env['USERPROFILE'] = `${root}/home`
  process.env['CODEX_HOME'] = `${root}/codex`
  return root
})

const CODEX_HOME = join(testRoot, 'codex')
const CACHE_DIR = join(testRoot, 'cache')

// computeEnvFingerprint('codex') as staged (no PROVIDER_PARSE_VERSIONS entry):
// hash of just CODEX_HOME. This is what sits in every existing user cache.
function preFixFingerprint(): string {
  return createHash('sha256').update(`CODEX_HOME=${CODEX_HOME}`).digest('hex').slice(0, 16)
}

// Exact fingerprint emitted before token_usage_record accounting was added.
function preUsageRecordFingerprint(): string {
  const parseVersion = 'mcp-attribution-v5-est-cost-active-timing-mcp-wait-rich-capture-v1-cross-provider-pr-v1-session-meta-model-v1-session-meta-fields-v1-codex-pricing-v1-codex-tps-v1-codex-mcp-skills-v1-activity-price-v1'
  return createHash('sha256')
    .update(`CODEX_HOME=${CODEX_HOME}\0parser=${parseVersion}`)
    .digest('hex')
    .slice(0, 16)
}

beforeEach(async () => {
  await rm(CACHE_DIR, { recursive: true, force: true })
  await rm(CODEX_HOME, { recursive: true, force: true })
  process.env['HOME'] = join(testRoot, 'home')
  process.env['USERPROFILE'] = join(testRoot, 'home')
  process.env['CODEX_HOME'] = CODEX_HOME
  process.env['CODEBURN_CACHE_DIR'] = CACHE_DIR
})

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true })
})

function allMcpServers(projects: Awaited<ReturnType<typeof parseAllSessions>>): string[] {
  const servers: string[] = []
  for (const p of projects) {
    for (const s of p.sessions) {
      servers.push(...Object.keys(s.mcpBreakdown))
    }
  }
  return servers
}

describe('codex parser change invalidates stale session-cache (#478/#513)', () => {
  it('re-parses unchanged codex files after a parser attribution change', async () => {
    const sessionDir = join(CODEX_HOME, 'sessions', '2026', '04', '14')
    await mkdir(sessionDir, { recursive: true })
    await mkdir(CACHE_DIR, { recursive: true })
    const lines = [
      JSON.stringify({ type: 'session_meta', timestamp: '2026-04-14T10:00:00Z', payload: { session_id: 'sess-stale', model: 'gpt-5.5', cwd: '/Users/test/proj', originator: 'codex_cli_rs' } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-04-14T10:00:10Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'call mcp via cli' }] } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-04-14T10:00:30Z', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ command: "bash -lc \"mcp-cli call github get_issue '{}'\"" }) } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-04-14T10:01:00Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 300, output_tokens: 100 }, total_token_usage: { total_tokens: 400 } } } }),
    ]
    await writeFile(join(sessionDir, 'rollout-stale.jsonl'), lines.join('\n') + '\n')

    // Run 1: cold cache, fixed parser. MCP attribution present (sanity).
    clearSessionCache()
    const fresh = await parseAllSessions(undefined, 'codex')
    expect(allMcpServers(fresh)).toContain('github')

    // Simulate a user whose session-cache.json was written by the PRE-fix
    // release: pre-fix envFingerprint, unchanged file fingerprint, cached
    // turns lack the mcp__ tool. Also reset codex-results.json to v4 so the
    // provider (if it runs at all) must genuinely re-parse.
    const cache = await readCacheOnDisk() as any
    cache.providers.codex.envFingerprint = preFixFingerprint()
    for (const f of Object.values(cache.providers.codex.files) as any[]) {
      for (const turn of f.turns) {
        for (const call of turn.calls) {
          call.tools = call.tools.filter((t: string) => !t.startsWith('mcp__'))
          if (call.toolSequence) {
            call.toolSequence = call.toolSequence.filter((step: any[]) => !step.some(c => c.tool.startsWith('mcp__')))
          }
        }
      }
    }
    await writeCacheOnDisk(cache)
    const { codexCacheFileName } = await import('../src/codex-cache.js')
    const codexCachePath = join(CACHE_DIR, codexCacheFileName())
    const codexCache = JSON.parse(await readFile(codexCachePath, 'utf8'))
    codexCache.version = 4
    for (const f of Object.values(codexCache.files) as any[]) {
      for (const call of f.calls ?? []) {
        call.tools = (call.tools ?? []).filter((t: string) => !t.startsWith('mcp__'))
      }
    }
    await writeFile(codexCachePath, JSON.stringify(codexCache))

    clearSessionCache()
    const second = await parseAllSessions(undefined, 'codex')
    // FIXED: `codex` is now in PROVIDER_PARSE_VERSIONS, so the pre-fix
    // envFingerprint no longer matches, the stale section is discarded, the
    // unchanged file re-parses, and the mcp-cli attribution reappears.
    expect(allMcpServers(second)).toContain('github')
  })

  it('re-parses warm session-cache turns after token_usage_record accounting changes', async () => {
    const sessionDir = join(CODEX_HOME, 'sessions', '2026', '09', '27')
    await mkdir(sessionDir, { recursive: true })
    await mkdir(CACHE_DIR, { recursive: true })
    const lines = [
      JSON.stringify({ type: 'session_meta', timestamp: '2026-09-27T10:00:00Z', payload: { session_id: 'sess-usage-record-cache', model: 'gpt-5.5', cwd: '/Users/test/proj', originator: 'codex_cli_rs' } }),
      JSON.stringify({ type: 'token_usage_record', timestamp: '2026-09-27T10:01:00Z', payload: { response_id: 'resp-cache-migration', model: 'gpt-5.5', usage: { input_tokens: 1000, output_tokens: 200 } } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-09-27T10:01:01Z', payload: { type: 'token_count', info: { last_token_usage: {}, total_token_usage: { total_tokens: 0 } } } }),
    ]
    await writeFile(join(sessionDir, 'rollout-usage-record-cache.jsonl'), lines.join('\n') + '\n')

    clearSessionCache()
    const fresh = await parseAllSessions(undefined, 'codex')
    const freshSession = fresh.flatMap(project => project.sessions).find(session => session.sessionId === 'sess-usage-record-cache')
    expect(freshSession && freshSession.totalInputTokens + freshSession.totalOutputTokens).toBe(1200)

    // Simulate a warm v39-style session cache whose provider fingerprint still
    // matches the prior parser and whose turn was undercounted by the token_count
    // twin. The Codex raw cache may be warm too; session-cache must still notice
    // the parser suffix and re-derive the turn.
    const cache = await readCacheOnDisk() as SessionCache
    cache.providers['codex']!.envFingerprint = preUsageRecordFingerprint()
    for (const file of Object.values(cache.providers['codex']!.files)) {
      for (const turn of file.turns) turn.calls = []
    }
    await writeCacheOnDisk(cache)

    clearSessionCache()
    const migrated = await parseAllSessions(undefined, 'codex')
    const migratedSession = migrated.flatMap(project => project.sessions).find(session => session.sessionId === 'sess-usage-record-cache')
    expect(migratedSession && migratedSession.totalInputTokens + migratedSession.totalOutputTokens).toBe(1200)
  })
})

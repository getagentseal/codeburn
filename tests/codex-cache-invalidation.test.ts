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
import { sessionCachePath } from '../src/session-cache.js'

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

beforeEach(() => {
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
    const cachePath = sessionCachePath()
    const cache = JSON.parse(await readFile(cachePath, 'utf8'))
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
    await writeFile(cachePath, JSON.stringify(cache))
    const codexCachePath = join(CACHE_DIR, 'codex-results.json')
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
})

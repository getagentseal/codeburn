import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { parseAllSessions, clearSessionCache } from '../src/parser.js'
import { readCacheOnDisk } from './fixtures/session-cache-io.js'

let tmpDir: string
let savedCodexHome: string | undefined

beforeEach(async () => {
  clearSessionCache()
  tmpDir = await mkdtemp(join(tmpdir(), 'scoped-complete-'))
  process.env['CLAUDE_CONFIG_DIR'] = tmpDir
  process.env['CODEBURN_CACHE_DIR'] = join(tmpDir, 'cache')
  process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] = join(tmpDir, 'desktop-sessions')
  // Hermetic: Codex discovery defaults to CODEX_HOME / ~/.codex, so without this
  // the scoped 'codex' run below reads the developer's real local corpus. Point it
  // at an empty temp root and restore in teardown.
  savedCodexHome = process.env['CODEX_HOME']
  process.env['CODEX_HOME'] = join(tmpDir, 'codex-home')
  await mkdir(join(tmpDir, 'codex-home', 'sessions'), { recursive: true })
})

afterEach(async () => {
  clearSessionCache()
  if (savedCodexHome === undefined) delete process.env['CODEX_HOME']
  else process.env['CODEX_HOME'] = savedCodexHome
  await rm(tmpDir, { recursive: true, force: true })
})

async function writeClaudeSession(): Promise<void> {
  const dir = join(tmpDir, 'projects', 'proj')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'sess.jsonl'), JSON.stringify({
    type: 'assistant',
    sessionId: 'sess',
    timestamp: '2026-05-15T10:00:00Z',
    cwd: '/tmp/proj',
    message: {
      id: 'msg-1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
      content: [], usage: { input_tokens: 100, output_tokens: 50 },
    },
  }) + '\n')
}

describe('provider-scoped run and the whole-cache completeness marker', () => {
  // Regression for #912: the stamp now learns about scope. A run scoped to one provider
  // must not mark the whole cache complete while a provider it skipped still has sessions
  // on disk it never scanned.
  it('does not stamp the cache complete when providers were left out of scope', async () => {
    await writeClaudeSession()

    // Scoped to 'codex': discovery is filtered and the cached-provider loop skips every
    // other name, so the claude session on disk is never read by this run.
    await parseAllSessions(undefined, 'codex')

    const raw = await readCacheOnDisk()

    // Premise: claude really was left unscanned. If this fails the scoped run read it
    // anyway and the rest proves nothing.
    expect(Object.keys(raw?.providers?.claude?.files ?? {}).length).toBe(0)

    // The guard: the stamp at the end of runParseInner refuses to mark the whole cache
    // complete when a skipped provider (claude here) still has discoverable sessions.
    expect(raw?.complete ?? false).toBe(false)
  })

  it('a subsequent full run repairs the cache — the mislabel is transient, not persistent', async () => {
    // Honouring the maintainer review: an ordinary all-provider refresh rediscovers the
    // omitted provider, so the wrong flag does not strand it forever. Pinning the bound
    // keeps the claim accurate.
    await writeClaudeSession()

    await parseAllSessions(undefined, 'codex')      // scoped: claude unscanned
    clearSessionCache()
    await parseAllSessions()                         // full refresh: claude rediscovered

    const raw = await readCacheOnDisk()
    expect(Object.keys(raw?.providers?.claude?.files ?? {}).length).toBeGreaterThan(0)
  })
})

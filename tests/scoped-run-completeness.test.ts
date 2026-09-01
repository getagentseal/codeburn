import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { parseAllSessions, clearSessionCache } from '../src/parser.js'
import { readCacheOnDisk } from './fixtures/session-cache-io.js'

let tmpDir: string

beforeEach(async () => {
  clearSessionCache()
  tmpDir = await mkdtemp(join(tmpdir(), 'scoped-complete-'))
  process.env['CLAUDE_CONFIG_DIR'] = tmpDir
  process.env['CODEBURN_CACHE_DIR'] = join(tmpDir, 'cache')
  process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] = join(tmpDir, 'desktop-sessions')
})

afterEach(async () => {
  clearSessionCache()
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
  // `it.fails` on purpose: this pins CURRENT behaviour, which is wrong, without
  // turning the suite red while the defect is still open. When the stamp learns
  // about scope, this test starts passing and vitest will fail it here — that is
  // the signal to drop `.fails` and keep it as a normal regression test.
  it.fails('does not stamp the cache complete when providers were left out of scope', async () => {
    await writeClaudeSession()

    // A scoped run: discovery is filtered to `codex`, and the loop over cached
    // providers skips every name that is not the filter. Claude's session on disk
    // is therefore never read by this run.
    await parseAllSessions(undefined, 'codex')

    const raw = await readCacheOnDisk()
    const claudeFiles = Object.keys(raw?.providers?.claude?.files ?? {})

    // Premise of the test: claude really was left unscanned. If this fails the
    // scoped run read it anyway and the rest proves nothing.
    expect(claudeFiles.length).toBe(0)

    // The finding: `complete` is a whole-cache marker, and the stamp at the end of
    // runParseInner is guarded on readOnly / wasComplete / deferredForFirstPaint —
    // not on whether the run was scoped. A cache stamped complete here claims a
    // corpus this run never looked at.
    expect(raw?.complete ?? false).toBe(false)
  })
})

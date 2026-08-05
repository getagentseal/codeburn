import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { clearSessionCache, isSessionHydrationComplete, parseAllSessions } from '../src/parser.js'

let root: string
let sessionPath: string

function output(projects: Awaited<ReturnType<typeof parseAllSessions>>): number {
  return projects.flatMap(p => p.sessions).flatMap(s => s.turns)
    .flatMap(t => t.assistantCalls).reduce((sum, call) => sum + call.usage.outputTokens, 0)
}

function sessionBody(value: number): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: 'sess',
    timestamp: '2026-05-15T10:00:00Z',
    cwd: '/tmp/proj',
    message: {
      id: `msg-${value}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
      content: [], usage: { input_tokens: 100, output_tokens: value },
    },
  }) + '\n'
}

async function writeSession(value: number): Promise<void> {
  await writeFile(sessionPath, sessionBody(value))
}

// A rename gives the file a fresh inode, so reconcileFile classifies it
// 'modified' and re-parses it. A same-inode rewrite that only grows is
// classified 'appended' instead: the parse resumes at the cached byte offset
// and merges with the cached turns, which is not what this test needs.
async function replaceSession(value: number): Promise<void> {
  const incoming = sessionPath + '.incoming'
  await writeFile(incoming, sessionBody(value))
  await rename(incoming, sessionPath)
}

beforeEach(async () => {
  clearSessionCache()
  root = await mkdtemp(join(tmpdir(), 'cb-memo-completeness-'))
  const home = join(root, 'home')
  const project = join(home, 'projects', 'proj')
  await mkdir(project, { recursive: true })
  sessionPath = join(project, 'sess.jsonl')
  process.env['CLAUDE_CONFIG_DIR'] = home
  process.env['CODEBURN_CACHE_DIR'] = join(root, 'cache')
  process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] = join(home, 'desktop-sessions')
})

afterEach(async () => {
  clearSessionCache()
  await rm(root, { recursive: true, force: true })
})

// Completeness must travel WITH the data, not in a module global:
// parseAllSessions memoizes results per (range, provider) for 180 seconds, and
// a global set by whichever parse ran LAST would describe a different parse
// than the one a memo hit returns. A read-only stale serve memoizes PARTIAL
// data; a later full parse reports complete; a third call inside the memo
// window hits the partial data. The daily backfill reading a global would
// finalize history off the partial snapshot.
describe('parseAllSessions completeness travels with the memoized data', () => {
  it('a memoized incomplete snapshot keeps reporting incomplete after a later full parse', async () => {
    await writeSession(50)
    const first = await parseAllSessions(undefined, 'claude')
    expect(isSessionHydrationComplete(first)).toBe(true)

    // A lock that cannot be read (a directory at the lock path) forces the
    // read-only path, and the changed file makes that serve a stale snapshot:
    // an incomplete hydration, memoized under this (range, provider) key.
    await writeSession(5000)
    clearSessionCache()
    const lockDir = join(process.env['CODEBURN_CACHE_DIR']!, 'session-refresh.lock')
    await mkdir(lockDir)
    const stale = await parseAllSessions(undefined, 'claude')
    expect(output(stale)).toBe(50)
    expect(isSessionHydrationComplete(stale)).toBe(false)
    await rm(lockDir, { recursive: true, force: true })

    // With the lock obstacle gone, a later FULL parse (different range, so its
    // own memo key) ingests the change and reports complete.
    await replaceSession(7000)
    const full = await parseAllSessions({ start: new Date('2026-01-01'), end: new Date('2026-12-31') }, 'claude')
    expect(output(full)).toBe(7000)
    expect(isSessionHydrationComplete(full)).toBe(true)

    // Memo hit on the STALE key: the partial array comes back with its own
    // incomplete tag, not the full parse's state.
    const again = await parseAllSessions(undefined, 'claude')
    expect(again).toBe(stale)
    expect(isSessionHydrationComplete(again)).toBe(false)
  })
})

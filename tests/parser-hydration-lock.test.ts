// Advisory hydration-lock coordination in parseAllSessions. When the on-disk
// cache is cold and another LIVE process already holds a fresh lock, a second
// process waits for release then reads the now-warm cache instead of re-parsing.
// Stale / dead-pid locks are ignored and replaced. The lock is an optimization,
// never a correctness gate.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync } from 'fs'
import { mkdir, mkdtemp, rm, unlink, writeFile, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { clearSessionCache, parseAllSessions } from '../src/parser.js'
import { sessionCachePath } from '../src/session-cache.js'

let tmpHome: string
let cacheDir: string

function lockPath(): string {
  return join(cacheDir, 'hydrating.lock')
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

function totalOutput(projects: Awaited<ReturnType<typeof parseAllSessions>>): number {
  return projects
    .flatMap(p => p.sessions)
    .flatMap(s => s.turns)
    .flatMap(t => t.assistantCalls)
    .reduce((sum, c) => sum + c.usage.outputTokens, 0)
}

async function writeClaudeSession(output: number): Promise<void> {
  const dir = join(tmpHome, 'projects', 'proj')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'sess.jsonl'), JSON.stringify({
    type: 'assistant',
    sessionId: 'sess',
    timestamp: '2026-05-15T10:00:00Z',
    cwd: '/tmp/proj',
    message: {
      id: 'msg-1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
      content: [], usage: { input_tokens: 100, output_tokens: output },
    },
  }) + '\n')
}

beforeEach(async () => {
  clearSessionCache()
  tmpHome = await mkdtemp(join(tmpdir(), 'cb-hydlock-home-'))
  cacheDir = await mkdtemp(join(tmpdir(), 'cb-hydlock-cache-'))
  process.env['CLAUDE_CONFIG_DIR'] = tmpHome
  process.env['CODEBURN_CACHE_DIR'] = cacheDir
  process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] = join(tmpHome, 'desktop-sessions')
})

afterEach(async () => {
  clearSessionCache()
  await rm(tmpHome, { recursive: true, force: true })
  await rm(cacheDir, { recursive: true, force: true })
})

describe('parseAllSessions hydration lock', () => {
  it('waits for a live foreign lock, then serves the warm cache instead of re-parsing', async () => {
    // Warm the cache once from a real on-disk session (output 50), capture the
    // exact cache structure, then tamper the cached output to a sentinel (999)
    // that could ONLY come from reading the cache — a fresh parse of the
    // unchanged source file would yield 50.
    await writeClaudeSession(50)
    expect(totalOutput(await parseAllSessions(undefined, 'claude'))).toBe(50)

    const warm = JSON.parse(await readFile(sessionCachePath(), 'utf-8'))
    for (const section of Object.values(warm.providers) as Array<{ files: Record<string, { turns: Array<{ calls: Array<{ usage: { outputTokens: number } }> }> }> }>) {
      for (const file of Object.values(section.files)) {
        for (const turn of file.turns) for (const call of turn.calls) call.usage.outputTokens = 999
      }
    }
    const tampered = JSON.stringify(warm)

    // Go cold: remove the versioned cache and drop the in-memory cache so the
    // next parse genuinely cold-starts and consults the lock.
    await unlink(sessionCachePath())
    clearSessionCache()

    // A fresh lock held by another live process (pid 1 is always alive and is
    // not us). The cold parse must block on it.
    await writeFile(lockPath(), JSON.stringify({ pid: 1, at: Date.now() }))

    let resolved = false
    const promise = parseAllSessions(undefined, 'claude').then(r => { resolved = true; return r })

    await delay(50)
    // Still waiting on the foreign lock — it has not re-parsed and returned.
    expect(resolved).toBe(false)

    // The "first process" finishes: it leaves the warm (tampered) cache behind
    // and releases the lock. The waiter wakes, reloads, and serves the cache.
    await writeFile(sessionCachePath(), tampered)
    await unlink(lockPath())

    const result = await promise
    expect(resolved).toBe(true)
    expect(totalOutput(result)).toBe(999)
    // The waiter never held the lock, so nothing to clean up on its side.
    expect(existsSync(lockPath())).toBe(false)
  })

  it('ignores and replaces a stale lock, parsing normally and releasing in a finally', async () => {
    await writeClaudeSession(50)

    // A stale lock (timestamp well past the freshness window) must be ignored,
    // replaced, and the parse proceeds normally.
    await mkdir(cacheDir, { recursive: true })
    await writeFile(lockPath(), JSON.stringify({ pid: 1, at: Date.now() - 20 * 60_000 }))

    const result = await parseAllSessions(undefined, 'claude')
    expect(totalOutput(result)).toBe(50)
    // Lock released in the finally.
    expect(existsSync(lockPath())).toBe(false)
    // The parse warmed the versioned cache.
    expect(existsSync(sessionCachePath())).toBe(true)
  })

  it('ignores a fresh lock whose pid is dead', async () => {
    await writeClaudeSession(50)

    // Fresh timestamp but a pid that does not exist (ESRCH): treated as dead,
    // ignored, replaced, and the parse proceeds normally.
    await mkdir(cacheDir, { recursive: true })
    await writeFile(lockPath(), JSON.stringify({ pid: 2_147_483_646, at: Date.now() }))

    const result = await parseAllSessions(undefined, 'claude')
    expect(totalOutput(result)).toBe(50)
    expect(existsSync(lockPath())).toBe(false)
  })

  it('takes over a lock whose live holder dies mid-wait, then cleans it up', async () => {
    await writeClaudeSession(50)
    await mkdir(cacheDir, { recursive: true })

    // A fresh lock held by a live process (pid 1): the cold parse starts waiting.
    await writeFile(lockPath(), JSON.stringify({ pid: 1, at: Date.now() }))
    let resolved = false
    const promise = parseAllSessions(undefined, 'claude').then(r => { resolved = true; return r })
    await delay(60)
    expect(resolved).toBe(false) // still blocked on the live foreign lock

    // The holder is SIGKILLed mid-scan: its pid goes dead and its lock is left
    // behind (no clean release). The waiter must detect the dead pid, take over
    // (re-parse under its own lock), and remove the leftover on release.
    await writeFile(lockPath(), JSON.stringify({ pid: 2_147_483_646, at: Date.now() }))

    const result = await promise
    expect(resolved).toBe(true)
    // Took over and re-parsed the source (50) rather than trusting a partial cache.
    expect(totalOutput(result)).toBe(50)
    // No leftover lock: the takeover acquired it and released it in the finally.
    expect(existsSync(lockPath())).toBe(false)
  })
})

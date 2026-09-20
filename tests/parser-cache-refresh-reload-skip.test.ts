import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../src/cache-refresh-lock.js', () => ({
  acquireCacheRefreshLock: async () => {
    // A concurrent publication landing while the lock is acquired must force
    // the reload: rewrite the envelope nonce inside acquisition.
    if (process.env['CB_RELOAD_SKIP_REWRITE_NONCE'] === '1') {
      const { readFile, writeFile } = await import('fs/promises')
      const { join } = await import('path')
      const envelopePath = join(process.env['CODEBURN_CACHE_DIR']!, 'session-cache.v9', 'envelope.json')
      const envelope = JSON.parse(await readFile(envelopePath, 'utf-8'))
      envelope.nonce = 'deadbeefdeadbeef'
      await writeFile(envelopePath, JSON.stringify(envelope))
    }
    return {
      outcome: 'acquired' as const,
      handle: { release: async () => {} },
    }
  },
}))
import { clearSessionCache, parseAllSessions } from '../src/parser.js'
import type { ProjectSummary } from '../src/types.js'

let root: string
let sessionPath: string

function output(projects: ProjectSummary[]): number {
  return projects.flatMap(p => p.sessions).flatMap(s => s.turns)
    .flatMap(t => t.assistantCalls).reduce((sum, call) => sum + call.usage.outputTokens, 0)
}

async function writeSession(value: number): Promise<void> {
  await writeFile(sessionPath, JSON.stringify({
    type: 'assistant',
    sessionId: 'sess',
    timestamp: '2026-05-15T10:00:00Z',
    cwd: '/tmp/proj',
    message: {
      id: `msg-${value}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
      content: [], usage: { input_tokens: 100, output_tokens: value },
    },
  }) + '\n')
}

beforeEach(async () => {
  clearSessionCache()
  root = await mkdtemp(join(tmpdir(), 'cb-reload-skip-'))
  const home = join(root, 'home')
  const project = join(home, 'projects', 'proj')
  await mkdir(project, { recursive: true })
  sessionPath = join(project, 'sess.jsonl')
  process.env['CLAUDE_CONFIG_DIR'] = home
  process.env['CODEBURN_CACHE_DIR'] = join(root, 'cache')
  process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] = join(home, 'desktop-sessions')
  process.env['CODEBURN_VERBOSE'] = '1'
})

afterEach(async () => {
  delete process.env['CODEBURN_VERBOSE']
  clearSessionCache()
  await rm(root, { recursive: true, force: true })
})

describe('parseAllSessions refresh reload', () => {
  it('reuses the pre-lock snapshot when the envelope nonce is unchanged', async () => {
    await writeSession(50)
    expect(output(await parseAllSessions(undefined, 'claude'))).toBe(50)
    clearSessionCache()
    const writes: string[] = []
    const origWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: unknown) => { writes.push(String(chunk)); return true }) as typeof process.stderr.write
    try {
      expect(output(await parseAllSessions(undefined, 'claude'))).toBe(50)
    } finally {
      process.stderr.write = origWrite
    }
    expect(writes.some(w => w.includes('reload=skipped'))).toBe(true)
  })

  it('reloads when another publication changed the envelope nonce', async () => {
    await writeSession(50)
    expect(output(await parseAllSessions(undefined, 'claude'))).toBe(50)

    clearSessionCache()
    process.env['CB_RELOAD_SKIP_REWRITE_NONCE'] = '1'
    const writes: string[] = []
    const origWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: unknown) => { writes.push(String(chunk)); return true }) as typeof process.stderr.write
    try {
      expect(output(await parseAllSessions(undefined, 'claude'))).toBe(50)
    } finally {
      process.stderr.write = origWrite
      delete process.env['CB_RELOAD_SKIP_REWRITE_NONCE']
    }
    expect(writes.some(w => w.includes('reload=skipped'))).toBe(false)
  })
})

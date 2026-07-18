import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../src/cache-refresh-lock.js', () => ({
  acquireCacheRefreshLock: async () => ({ outcome: 'timed-out' as const }),
}))

import { clearSessionCache, parseAllSessions } from '../src/parser.js'
import { sessionCachePath } from '../src/session-cache.js'

let root: string
let sessionPath: string

function output(projects: Awaited<ReturnType<typeof parseAllSessions>>): number {
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
  root = await mkdtemp(join(tmpdir(), 'cb-refresh-timeout-'))
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

describe('parseAllSessions warm refresh timeout', () => {
  it('serves the prior complete snapshot and leaves the holder cache untouched', async () => {
    await writeSession(50)
    expect(output(await parseAllSessions(undefined, 'claude'))).toBe(50)
    const before = await readFile(sessionCachePath(), 'utf-8')

    await writeSession(5000)
    clearSessionCache()
    expect(output(await parseAllSessions(undefined, 'claude'))).toBe(50)
    expect(await readFile(sessionCachePath(), 'utf-8')).toBe(before)
  })
})

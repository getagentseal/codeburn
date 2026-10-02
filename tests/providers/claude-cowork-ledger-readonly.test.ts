import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../../src/cache-refresh-lock.js', () => ({
  acquireCacheRefreshLock: async () => ({ outcome: 'timed-out' as const }),
}))

import { clearSessionCache, parseAllSessions } from '../../src/parser.js'

let root: string

beforeEach(async () => {
  clearSessionCache()
  root = await mkdtemp(join(tmpdir(), 'cb-cowork-ledger-readonly-'))
  const home = join(root, 'home')
  const project = join(home, 'projects', 'proj')
  await mkdir(project, { recursive: true })
  await writeFile(join(project, 'sess.jsonl'), JSON.stringify({
    type: 'assistant',
    sessionId: 'sess',
    timestamp: '2026-05-15T10:00:00Z',
    cwd: '/tmp/proj',
    message: {
      id: 'msg-1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
      content: [], usage: { input_tokens: 100, output_tokens: 50 },
    },
  }) + '\n')
  const ledgerDir = join(home, 'desktop-sessions', 'app', 'workspace', 'usage-ledger')
  await mkdir(ledgerDir, { recursive: true })
  await writeFile(join(ledgerDir, '2026-05-15.ndjson'), JSON.stringify({
    ts: Date.parse('2026-05-15T11:00:00Z'),
    surface: 'cowork',
    sessionId: 'cowork-1',
    models: { 'claude-sonnet-4-5': { inputTokens: 10, outputTokens: 20, cost: { usd: 0.25 } } },
  }) + '\n')
  process.env['CLAUDE_CONFIG_DIR'] = home
  process.env['CODEBURN_CACHE_DIR'] = join(root, 'cache')
  process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] = join(home, 'desktop-sessions')
})

afterEach(async () => {
  clearSessionCache()
  await rm(root, { recursive: true, force: true })
})

function totals(projects: Awaited<ReturnType<typeof parseAllSessions>>) {
  return {
    cost: projects.reduce((sum, p) => sum + p.totalCostUSD, 0),
    calls: projects.reduce((sum, p) => sum + p.totalApiCalls, 0),
    names: projects.map(p => p.project).sort(),
  }
}

describe('Cowork ledger in a read-only refresh', () => {
  it('does not re-serve Claude transcripts through the ledger pass', async () => {
    const warm = totals(await parseAllSessions(undefined, 'claude'))
    expect(warm.calls).toBe(2)

    clearSessionCache()
    const readOnly = totals(await parseAllSessions(undefined, 'claude'))

    expect(readOnly).toEqual(warm)
    expect(readOnly.names).not.toContain('claude')
  })
})

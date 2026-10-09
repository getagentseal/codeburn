import { afterAll, beforeEach, expect, it, vi } from 'vitest'
import { appendFile, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'

const root = vi.hoisted(() => {
  const root = `${process.env['TMPDIR'] || '/tmp'}/codex-names-cache-${process.pid}-${Date.now()}`
  process.env['HOME'] = `${root}/home`
  process.env['USERPROFILE'] = `${root}/home`
  process.env['CODEX_HOME'] = `${root}/custom-codex`
  process.env['CODEBURN_CACHE_DIR'] = `${root}/cache`
  return root
})

afterAll(async () => { await rm(root, { recursive: true, force: true }) })
beforeEach(() => {
  process.env['HOME'] = join(root, 'home')
  process.env['USERPROFILE'] = join(root, 'home')
  process.env['CODEX_HOME'] = join(root, 'custom-codex')
  process.env['CODEBURN_CACHE_DIR'] = join(root, 'cache')
})

it('refreshes active and archived names on cold, memory and disk cache reports without changing accounting', async () => {
  const home = join(root, 'custom-codex')
  const index = join(home, 'session_index.jsonl')
  const activeId = '019a0000-1111-7000-8000-000000000001'
  const archivedId = '019a0000-1111-7000-8000-000000000002'
  const sessionId = (id: string) => `rollout-2026-10-01T10-00-00-${id}`
  const usage = { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 100, total_tokens: 1100 }
  for (const [id, directory] of [[activeId, 'sessions/2026/10/01'], [archivedId, 'archived_sessions']]) {
    await mkdir(join(home, directory!), { recursive: true })
    await writeFile(join(home, directory!, `${sessionId(id!)}.jsonl`), [
      { type: 'session_meta', timestamp: '2026-10-01T10:00:00Z', payload: { id, cwd: '/test/project', model: 'gpt-5.5', originator: 'Codex Desktop' } },
      { type: 'response_item', timestamp: '2026-10-01T10:00:10Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Example task' }] } },
      { type: 'event_msg', timestamp: '2026-10-01T10:01:00Z', payload: { type: 'token_count', info: { model: 'gpt-5.5', last_token_usage: usage, total_token_usage: usage } } },
    ].map(JSON.stringify).join('\n') + '\n')
  }
  await writeFile(index, [
    { id: activeId, thread_name: 'Original active name' },
    { id: archivedId, thread_name: 'Archived task' },
  ].map(JSON.stringify).join('\n') + '\n')

  const { clearSessionCache, parseAllSessions } = await import('../src/parser.js')
  const { aggregateSessions, sessionDisplayName } = await import('../src/sessions-report.js')
  clearSessionCache()
  const cold = aggregateSessions(await parseAllSessions(undefined, 'codex'))
  expect(cold).toHaveLength(2)
  expect(cold.find(s => s.sessionId === sessionId(activeId))?.title).toBe('Original active name')
  expect(cold.find(s => s.sessionId === sessionId(archivedId))?.title).toBe('Archived task')

  await appendFile(index, JSON.stringify({ id: activeId, thread_name: 'Renamed active task' }) + '\n')
  const bytes = await readFile(index, 'utf8')
  const warm = aggregateSessions(await parseAllSessions(undefined, 'codex'))
  expect(warm.find(s => s.sessionId === sessionId(activeId))?.title).toBe('Renamed active task')
  expect(cold.find(s => s.sessionId === sessionId(activeId))?.title).toBe('Original active name')
  const accounting = (rows: typeof cold) => rows.map(({ title, ...rest }) => rest)
  expect(accounting(warm)).toEqual(accounting(cold))

  clearSessionCache()
  expect(aggregateSessions(await parseAllSessions(undefined, 'codex'))).toEqual(warm)
  expect(await readFile(index, 'utf8')).toBe(bytes)

  await rm(index)
  const missing = aggregateSessions(await parseAllSessions(undefined, 'codex'))
  expect(missing.every(s => s.title === '')).toBe(true)
  expect(missing.map(sessionDisplayName)).toEqual(['Codex 019a0000', 'Codex 019a0000'])
  expect(accounting(missing)).toEqual(accounting(cold))
})

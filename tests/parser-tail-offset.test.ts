import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { clearSessionCache, parseAllSessions } from '../src/parser.js'
import { clearLoadCacheMemo } from '../src/session-cache.js'

let tmpDir: string

beforeEach(async () => {
  clearSessionCache()
  clearLoadCacheMemo()
  tmpDir = await mkdtemp(join(tmpdir(), 'cb-tail-'))
  process.env['CLAUDE_CONFIG_DIR'] = tmpDir
  process.env['CODEBURN_CACHE_DIR'] = join(tmpDir, 'cache')
  process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] = join(tmpDir, 'desktop-sessions')
  process.env['CODEBURN_PARSE_BURST_MS'] = '0'
})

afterEach(async () => {
  clearSessionCache()
  clearLoadCacheMemo()
  delete process.env['CODEBURN_PARSE_BURST_MS']
  await rm(tmpDir, { recursive: true, force: true })
})

const user = (text: string, ts: string) => JSON.stringify({ type: 'user', sessionId: 's', timestamp: ts, cwd: '/tmp/p', message: { role: 'user', content: text } })
const assistant = (id: string, ts: string) => JSON.stringify({
  type: 'assistant', sessionId: 's', timestamp: ts, cwd: '/tmp/p',
  message: { id, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], usage: { input_tokens: 100, output_tokens: 50 } },
})

describe('claude parse of a last line without its newline', () => {
  // Unlike the optimize facts, the session cache must re-read that line: a
  // prompt with no reply yet forms no turn in the cached region, so the resumed
  // read is what puts it back in front of the reply.
  it('an append after an unanswered prompt matches a fresh parse', async () => {
    const dir = join(tmpDir, 'projects', 'p')
    await mkdir(dir, { recursive: true })
    const file = join(dir, 's.jsonl')
    await writeFile(file, [user('hi', '2026-05-15T10:00:00Z'), assistant('m1', '2026-05-15T10:00:01Z'), user('next', '2026-05-15T10:01:00Z')].join('\n'))
    await parseAllSessions()
    await appendFile(file, '\n' + assistant('m2', '2026-05-15T10:01:01Z') + '\n')
    clearSessionCache()
    const resumed = await parseAllSessions()
    clearSessionCache()
    clearLoadCacheMemo()
    process.env['CODEBURN_CACHE_DIR'] = join(tmpDir, 'cache-fresh')
    const fresh = await parseAllSessions()
    expect(JSON.parse(JSON.stringify(resumed))).toEqual(JSON.parse(JSON.stringify(fresh)))
  })
})

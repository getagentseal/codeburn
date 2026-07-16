import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { parseAllSessions, clearSessionCache } from '../src/parser.js'
import { CACHE_VERSION, sessionCachePath } from '../src/session-cache.js'

let tmpDir: string
let cacheDir: string

beforeEach(async () => {
  clearSessionCache()
  tmpDir = await mkdtemp(join(tmpdir(), 'coldstart-'))
  cacheDir = join(tmpDir, 'cache')
  process.env['CLAUDE_CONFIG_DIR'] = tmpDir
  process.env['CODEBURN_CACHE_DIR'] = cacheDir
  process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] = join(tmpDir, 'desktop-sessions')
})

afterEach(async () => {
  clearSessionCache()
  delete process.env['CODEBURN_PROGRESS']
  await rm(tmpDir, { recursive: true, force: true })
})

async function writeSession(): Promise<void> {
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

describe('cold-start cache persistence', () => {
  // The desktop cold-start bug is "the cache never persists". This pins the
  // invariant the fix depends on: a run that reaches the end of parseAllSessions
  // writes the current-version session cache to disk, so the next launch is warm.
  it('a completed parseAllSessions persists the current-version cache to disk', async () => {
    await writeSession()
    const projects = await parseAllSessions()
    expect(projects.length).toBeGreaterThan(0)

    const raw = JSON.parse(await readFile(sessionCachePath(), 'utf-8'))
    expect(raw.version).toBe(CACHE_VERSION)
    const claudeFiles = Object.keys(raw.providers?.claude?.files ?? {})
    expect(claudeFiles.length).toBeGreaterThan(0)
    // The persisted entry carries the parsed turn, so a warm reload serves it
    // without re-reading the source file.
    expect(raw.providers.claude.files[claudeFiles[0]!].turns.length).toBeGreaterThan(0)
  })

  it('streams per-provider scan progress only when CODEBURN_PROGRESS=1', async () => {
    await writeSession()
    const lines: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      lines.push(String(chunk)); return true
    }) as typeof process.stderr.write)
    try {
      // Off by default: plain CLI/terminal output is untouched.
      await parseAllSessions()
      expect(lines.filter(l => l.startsWith('CODEBURN_PROGRESS ')).length).toBe(0)

      clearSessionCache()
      process.env['CODEBURN_PROGRESS'] = '1'
      await parseAllSessions()
      const progress = lines.filter(l => l.startsWith('CODEBURN_PROGRESS '))
      expect(progress.some(l => l.includes('"providers"'))).toBe(true)
      expect(progress.some(l => l.includes('"provider":"claude"') && l.includes('"start"'))).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })
})

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFile, mkdir, mkdtemp, readFile, rm, truncate, utimes, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  clearSessionCache,
  matchesClaudeCheckpointPrefix,
  parseAllSessions,
} from '../src/parser.js'
import { loadCache } from '../src/session-cache.js'

const user = (n: number): string => JSON.stringify({
  type: 'user',
  sessionId: 'incremental-parity',
  timestamp: `2026-05-01T00:00:${String(n * 2).padStart(2, '0')}Z`,
  cwd: '/repo/incremental-parity',
  message: { role: 'user', content: `turn ${n}` },
})

const assistant = (n: number, messageId = `msg-${n}`, outputTokens = 10): string => JSON.stringify({
  type: 'assistant',
  sessionId: 'incremental-parity',
  timestamp: `2026-05-01T00:00:${String(n * 2 + 1).padStart(2, '0')}Z`,
  cwd: '/repo/incremental-parity',
  message: {
    id: messageId,
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-5',
    content: [],
    usage: { input_tokens: 100, output_tokens: outputTokens },
  },
})

const jsonl = (...lines: string[]): string => `${lines.join('\n')}\n`

const mcpDelta = (n: number, ...names: string[]): string => JSON.stringify({
  type: 'user',
  sessionId: 'incremental-parity',
  timestamp: `2026-05-01T00:01:${String(n).padStart(2, '0')}Z`,
  cwd: '/repo/incremental-parity',
  message: { role: 'user', content: '' },
  attachment: { type: 'deferred_tools_delta', addedNames: names },
})

describe('Claude checkpoint incremental parse parity', () => {
  let root: string
  let cacheDir: string
  let configDir: string
  let sessionFile: string
  let oldCacheDir: string | undefined
  let oldConfigDirs: string | undefined
  let oldDesktopDir: string | undefined

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'codeburn-claude-incremental-'))
    cacheDir = join(root, 'cache')
    configDir = join(root, 'claude')
    sessionFile = join(configDir, 'projects', '-repo-incremental-parity', 'session.jsonl')
    await mkdir(join(configDir, 'projects', '-repo-incremental-parity'), { recursive: true })
    await mkdir(cacheDir, { recursive: true })

    oldCacheDir = process.env['CODEBURN_CACHE_DIR']
    oldConfigDirs = process.env['CLAUDE_CONFIG_DIRS']
    oldDesktopDir = process.env['CODEBURN_DESKTOP_SESSIONS_DIR']
    process.env['CODEBURN_CACHE_DIR'] = cacheDir
    process.env['CLAUDE_CONFIG_DIRS'] = configDir
    process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] = join(root, 'no-desktop-sessions')
    clearSessionCache()
  })

  afterEach(async () => {
    clearSessionCache()
    if (oldCacheDir === undefined) delete process.env['CODEBURN_CACHE_DIR']
    else process.env['CODEBURN_CACHE_DIR'] = oldCacheDir
    if (oldConfigDirs === undefined) delete process.env['CLAUDE_CONFIG_DIRS']
    else process.env['CLAUDE_CONFIG_DIRS'] = oldConfigDirs
    if (oldDesktopDir === undefined) delete process.env['CODEBURN_DESKTOP_SESSIONS_DIR']
    else process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] = oldDesktopDir
    await rm(root, { recursive: true, force: true })
  })

  async function parseFresh(): Promise<Awaited<ReturnType<typeof parseAllSessions>>> {
    await rm(cacheDir, { recursive: true, force: true })
    await mkdir(cacheDir, { recursive: true })
    clearSessionCache()
    return parseAllSessions(undefined, 'claude')
  }

  async function expectWarmRefreshMatchesFresh(
    initial: string,
    update: () => Promise<void>,
  ): Promise<void> {
    await writeFile(sessionFile, initial)
    await parseFresh()
    await update()
    clearSessionCache()
    const incremental = await parseAllSessions(undefined, 'claude')
    const full = await parseFresh()
    expect(incremental).toEqual(full)
  }

  it('matches full parsing when complete turns are appended', async () => {
    await expectWarmRefreshMatchesFresh(
      jsonl(user(1), assistant(1), user(2), assistant(2)),
      () => appendFile(sessionFile, jsonl(user(3), assistant(3), user(4))),
    )
  })

  it('re-parses an open turn from its beginning', async () => {
    await expectWarmRefreshMatchesFresh(
      jsonl(user(1)),
      () => appendFile(sessionFile, jsonl(assistant(1), user(2), assistant(2))),
    )
  })

  it('keeps last-wins streaming-id updates identical to a full parse', async () => {
    await expectWarmRefreshMatchesFresh(
      jsonl(user(1), assistant(1, 'streaming-id', 10)),
      () => appendFile(sessionFile, jsonl(assistant(1, 'streaming-id', 20), user(2), assistant(2))),
    )
  })

  it('full-parses when a later turn supersedes an id in a retained turn', async () => {
    await expectWarmRefreshMatchesFresh(
      jsonl(
        user(1), assistant(1, 'old-turn-id', 10),
        user(2), assistant(2, 'current-turn-id', 10),
      ),
      () => appendFile(sessionFile, jsonl(
        assistant(2, 'old-turn-id', 20),
        user(3), assistant(3),
      )),
    )
  })

  it('full-parses a same-length mutation', async () => {
    const initial = jsonl(user(1), assistant(1, 'msg-1', 10))
    await expectWarmRefreshMatchesFresh(initial, async () => {
      const mutated = (await readFile(sessionFile, 'utf8')).replace('"output_tokens":10', '"output_tokens":20')
      expect(Buffer.byteLength(mutated)).toBe(Buffer.byteLength(initial))
      await writeFile(sessionFile, mutated)
    })
  })

  it('full-parses a truncation', async () => {
    const retained = jsonl(user(1), assistant(1))
    await expectWarmRefreshMatchesFresh(
      `${retained}${jsonl(user(2), assistant(2))}`,
      () => truncate(sessionFile, Buffer.byteLength(retained)),
    )
  })

  it('prefix hash is load-bearing after a same-size rewrite followed by append', async () => {
    const initial = jsonl(
      user(1), assistant(1, 'msg-1', 10),
      user(2), assistant(2, 'msg-2', 10),
    )
    await writeFile(sessionFile, initial)
    await parseFresh()
    const cached = (await loadCache()).providers['claude']!.files[sessionFile]!

    const rewritten = initial.replace('"output_tokens":10', '"output_tokens":20')
    expect(Buffer.byteLength(rewritten)).toBe(Buffer.byteLength(initial))
    await writeFile(sessionFile, rewritten)
    await appendFile(sessionFile, jsonl(user(3), assistant(3)))

    // This pair is the red-first proof: bypassing validation accepts the
    // corrupted prefix, while the committed guarded path rejects it.
    expect(await matchesClaudeCheckpointPrefix(sessionFile, cached, false)).toBe(true)
    expect(await matchesClaudeCheckpointPrefix(sessionFile, cached)).toBe(false)

    clearSessionCache()
    const guarded = await parseAllSessions(undefined, 'claude')
    const full = await parseFresh()
    expect(guarded).toEqual(full)
  })

  it('keeps mcpInventory identical to a full parse across an incremental append', async () => {
    // Names deliberately arrive in non-alphabetical order: extractMcpInventory
    // sorts, so the incremental union must sort too or parity breaks.
    await writeFile(sessionFile, jsonl(
      mcpDelta(1, 'mcp__zeta__tool', 'mcp__alpha__tool'),
      user(1), assistant(1),
    ))
    await parseFresh()
    await appendFile(sessionFile, jsonl(
      mcpDelta(2, 'mcp__mid__tool'),
      user(2), assistant(2),
    ))
    clearSessionCache()
    await parseAllSessions(undefined, 'claude')
    const incrementalInventory = (await loadCache()).providers['claude']?.files[sessionFile]?.mcpInventory
    await parseFresh()
    const fullInventory = (await loadCache()).providers['claude']?.files[sessionFile]?.mcpInventory
    expect(incrementalInventory).toEqual(fullInventory)
    expect(fullInventory).toEqual(['mcp__alpha__tool', 'mcp__mid__tool', 'mcp__zeta__tool'])
  })

  it('keeps exact results for an empty append (mtime-only touch)', async () => {
    const initial = jsonl(user(1), assistant(1))
    await expectWarmRefreshMatchesFresh(initial, async () => {
      const future = new Date(Date.now() + 2_000)
      await utimes(sessionFile, future, future)
    })
  })
})

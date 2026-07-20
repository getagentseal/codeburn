import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm, stat, unlink } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

// Spy on readSessionLines so a test can PROVE the incremental path activates:
// only the appended-parse path passes a non-zero `startByteOffset`. The real
// implementation is preserved; we merely record the offset each call receives.
const readLineCalls: Array<{ filePath: string; startByteOffset?: number }> = []
vi.mock('../src/fs-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/fs-utils.js')>()
  return {
    ...actual,
    readSessionLines: (filePath: string, skip?: unknown, options?: { startByteOffset?: number }) => {
      readLineCalls.push({ filePath, startByteOffset: options?.startByteOffset })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (actual.readSessionLines as any)(filePath, skip, options)
    },
  }
})

import { parseAllSessions, clearSessionCache } from '../src/parser.js'
import { sessionCachePath } from '../src/session-cache.js'
import type { ProjectSummary } from '../src/types.js'

let tmpDir: string
let projectDir: string
let sessionPath: string
const CWD = '/tmp/incr-proj'

beforeEach(async () => {
  clearSessionCache()
  readLineCalls.length = 0
  tmpDir = await mkdtemp(join(tmpdir(), 'incr-append-'))
  projectDir = join(tmpDir, 'projects', 'incr-proj')
  await mkdir(projectDir, { recursive: true })
  sessionPath = join(projectDir, 'sess-1.jsonl')
  process.env['CLAUDE_CONFIG_DIR'] = tmpDir
  process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] = join(tmpDir, 'desktop-sessions')
})

afterEach(async () => {
  clearSessionCache()
  delete process.env['CODEBURN_CACHE_DIR']
  await rm(tmpDir, { recursive: true, force: true })
})

// ── fixture builders ───────────────────────────────────────────────────

function userLine(ts: string, text: string): string {
  return JSON.stringify({
    type: 'user', sessionId: 'sess-1', timestamp: ts, cwd: CWD,
    message: { role: 'user', content: text },
  })
}

function mcpLine(ts: string, addedNames: string[]): string {
  return JSON.stringify({
    type: 'user', sessionId: 'sess-1', timestamp: ts, cwd: CWD,
    attachment: { type: 'deferred_tools_delta', addedNames },
  })
}

function asstLine(
  id: string,
  ts: string,
  usage: Record<string, number>,
  blocks: Array<Record<string, unknown>> = [],
  model = 'claude-sonnet-4-5',
): string {
  return JSON.stringify({
    type: 'assistant', sessionId: 'sess-1', timestamp: ts, cwd: CWD,
    message: { id, type: 'message', role: 'assistant', model, content: blocks, usage },
  })
}

const readBlock = (file: string) => ({ type: 'tool_use', name: 'Read', input: { file_path: file } })
const bashBlock = (cmd: string) => ({ type: 'tool_use', name: 'Bash', input: { command: cmd } })

function prLinkLine(ts: string, url: string): string {
  return JSON.stringify({ type: 'pr-link', sessionId: 'sess-1', timestamp: ts, cwd: CWD, prUrl: url })
}

// A representative multi-turn session: MCP inventory, tools, bash, and a
// streaming re-emit of one assistant message (same id, updated usage) inside a
// turn — exercises dedup, breakdowns, and turn assembly.
function baseLines(): string[] {
  return [
    mcpLine('2026-05-01T10:00:00.000Z', ['mcp__ctx__search', 'mcp__ctx__fetch']),
    userLine('2026-05-01T10:00:01.000Z', 'first task please'),
    asstLine('msg-a', '2026-05-01T10:00:02.000Z', { input_tokens: 100, output_tokens: 20 }, [readBlock('/a.ts')]),
    // streaming re-emit of msg-a with grown usage (last one wins)
    asstLine('msg-a', '2026-05-01T10:00:03.000Z', { input_tokens: 100, output_tokens: 55, cache_read_input_tokens: 300 }, [readBlock('/a.ts')]),
    userLine('2026-05-01T10:05:00.000Z', 'second task please'),
    asstLine('msg-b', '2026-05-01T10:05:02.000Z', { input_tokens: 200, output_tokens: 80 }, [bashBlock('ls -la')]),
  ]
}

// ── helpers ────────────────────────────────────────────────────────────

async function parseWith(cacheDir: string): Promise<ProjectSummary[]> {
  clearSessionCache()
  process.env['CODEBURN_CACHE_DIR'] = cacheDir
  return parseAllSessions()
}

// A cold full re-parse of the file's CURRENT contents, using a pristine cache
// dir so nothing is served incrementally — the correctness oracle.
async function coldFullReparse(): Promise<ProjectSummary[]> {
  const freshCache = await mkdtemp(join(tmpdir(), 'incr-cold-'))
  try {
    return await parseWith(freshCache)
  } finally {
    await rm(freshCache, { recursive: true, force: true })
  }
}

function offsetsFor(path: string): Array<number | undefined> {
  return readLineCalls.filter(c => c.filePath === path).map(c => c.startByteOffset)
}

// ── tests ──────────────────────────────────────────────────────────────

describe('incremental append parsing', () => {
  it('CORE: warm append merge deep-equals a cold full re-parse (with torn final line)', async () => {
    const warmCache = await mkdtemp(join(tmpdir(), 'incr-warm-'))

    // 1) cold parse of the base file → warm cache seeded with offset+turns.
    await writeFile(sessionPath, baseLines().join('\n') + '\n')
    await parseWith(warmCache)

    const cachedOffset: number = JSON.parse(await readFile(sessionCachePath(), 'utf-8'))
      .providers.claude.files[sessionPath].lastCompleteLineOffset
    expect(cachedOffset).toBeGreaterThan(0)

    // 2) append a new complete turn plus a torn (invalid JSON, no newline) tail.
    const appended =
      userLine('2026-05-01T11:00:00.000Z', 'third task please') + '\n' +
      asstLine('msg-c', '2026-05-01T11:00:02.000Z', { input_tokens: 300, output_tokens: 90 }, [readBlock('/c.ts'), bashBlock('grep x')]) + '\n' +
      '{"type":"assistant","sessionId":"sess-1","timestamp":"2026-05-01T11:05'  // torn: invalid + no newline
    await appendFile(sessionPath, appended)

    // 3) warm parse (same cache) → must take the incremental path.
    readLineCalls.length = 0
    const warm = await parseWith(warmCache)

    // proof: the session file was read from the cached offset, not byte 0.
    expect(offsetsFor(sessionPath)).toContain(cachedOffset)

    // 4) oracle: cold full re-parse of the identical file.
    const cold = await coldFullReparse()

    expect(warm).toEqual(cold)
    await rm(warmCache, { recursive: true, force: true })
  })

  it('PR-REFS: survive the incremental append path (continuation merge unions refs)', async () => {
    const warmCache = await mkdtemp(join(tmpdir(), 'incr-pr-'))
    // Base: one turn that creates PR-1.
    await writeFile(sessionPath,
      userLine('2026-05-01T10:00:01.000Z', 'ship PR one') + '\n' +
      asstLine('msg-a', '2026-05-01T10:00:02.000Z', { input_tokens: 100, output_tokens: 20 }, [bashBlock('gh pr create')]) + '\n' +
      prLinkLine('2026-05-01T10:00:03.000Z', 'https://github.com/o/r/pull/1') + '\n')
    await parseWith(warmCache)

    // Append a continuation of that same turn (no leading user message) that
    // references PR-2, then a fresh turn that references PR-3.
    await appendFile(sessionPath,
      asstLine('msg-b', '2026-05-01T10:00:04.000Z', { input_tokens: 50, output_tokens: 10 }, [bashBlock('gh pr create')]) + '\n' +
      prLinkLine('2026-05-01T10:00:05.000Z', 'https://github.com/o/r/pull/2') + '\n' +
      userLine('2026-05-01T10:10:00.000Z', 'ship PR three') + '\n' +
      asstLine('msg-c', '2026-05-01T10:10:02.000Z', { input_tokens: 80, output_tokens: 20 }, [bashBlock('gh pr create')]) + '\n' +
      prLinkLine('2026-05-01T10:10:03.000Z', 'https://github.com/o/r/pull/3') + '\n')

    readLineCalls.length = 0
    const warm = await parseWith(warmCache)
    expect(offsetsFor(sessionPath).some(o => o !== undefined && o > 0)).toBe(true) // took the append path
    const cold = await coldFullReparse()
    expect(warm).toEqual(cold)

    const turns = warm[0]!.sessions[0]!.turns
    expect(turns[0]!.prRefs).toEqual(['https://github.com/o/r/pull/1', 'https://github.com/o/r/pull/2'])
    expect(turns[1]!.prRefs).toEqual(['https://github.com/o/r/pull/3'])
    await rm(warmCache, { recursive: true, force: true })
  })

  it('PR-REFS: survive when a straddled append falls back to a full re-parse', async () => {
    const warmCache = await mkdtemp(join(tmpdir(), 'incr-pr2-'))
    await writeFile(sessionPath,
      userLine('2026-05-01T10:00:01.000Z', 'ship PR one') + '\n' +
      asstLine('msg-a', '2026-05-01T10:00:02.000Z', { input_tokens: 100, output_tokens: 20 }, [bashBlock('gh pr create')]) + '\n' +
      prLinkLine('2026-05-01T10:00:03.000Z', 'https://github.com/o/r/pull/1') + '\n')
    await parseWith(warmCache)

    // Re-emit msg-a (an id already committed in the cached prefix) -> straddle ->
    // the shortcut is abandoned and the file re-parses from byte 0.
    await appendFile(sessionPath,
      asstLine('msg-a', '2026-05-01T10:00:02.500Z', { input_tokens: 100, output_tokens: 40 }, [bashBlock('gh pr create')]) + '\n' +
      prLinkLine('2026-05-01T10:00:06.000Z', 'https://github.com/o/r/pull/2') + '\n')

    const warm = await parseWith(warmCache)
    const cold = await coldFullReparse()
    expect(warm).toEqual(cold)
    expect(warm[0]!.sessions[0]!.turns[0]!.prRefs).toEqual([
      'https://github.com/o/r/pull/1', 'https://github.com/o/r/pull/2',
    ])
    await rm(warmCache, { recursive: true, force: true })
  })

  it('EDGE: append after a previously-torn line completes still equals cold', async () => {
    const warmCache = await mkdtemp(join(tmpdir(), 'incr-warm2-'))

    // Base file whose LAST line is a complete assistant entry WITHOUT a trailing
    // newline — cached as a turn, but the resume offset sits before it.
    const tail = asstLine('msg-b', '2026-05-01T10:05:02.000Z', { input_tokens: 200, output_tokens: 80 }, [bashBlock('ls -la')])
    const head = baseLines().slice(0, 5).join('\n') + '\n'
    await writeFile(sessionPath, head + tail) // no trailing newline
    await parseWith(warmCache)

    // Complete the boundary (newline terminates the former tail) and append more.
    // msg-b is re-read from the offset -> must dedup against the cached copy.
    const more = '\n' +
      asstLine('msg-c', '2026-05-01T11:00:02.000Z', { input_tokens: 300, output_tokens: 90 }, [readBlock('/c.ts')]) + '\n'
    await appendFile(sessionPath, more)

    const warm = await parseWith(warmCache)
    const cold = await coldFullReparse()
    expect(warm).toEqual(cold)
    await rm(warmCache, { recursive: true, force: true })
  })

  it('EDGE: only a torn partial appended (no new complete line) equals cold', async () => {
    const warmCache = await mkdtemp(join(tmpdir(), 'incr-warm3-'))
    await writeFile(sessionPath, baseLines().join('\n') + '\n')
    await parseWith(warmCache)

    // Append only an incomplete line (no newline) — nothing new to commit yet.
    await appendFile(sessionPath, '{"type":"assistant","partial":true')
    const warm = await parseWith(warmCache)
    const cold = await coldFullReparse()
    expect(warm).toEqual(cold)
    await rm(warmCache, { recursive: true, force: true })
  })

  it('EDGE: file replaced (inode change) falls back to a full re-parse', async () => {
    const warmCache = await mkdtemp(join(tmpdir(), 'incr-warm4-'))
    await writeFile(sessionPath, baseLines().join('\n') + '\n')
    await parseWith(warmCache)
    const inoBefore = (await stat(sessionPath)).ino

    // Replace the file (new inode) with different, LARGER content.
    await unlink(sessionPath)
    const replaced = [
      ...baseLines(),
      userLine('2026-05-01T12:00:00.000Z', 'brand new task'),
      asstLine('msg-z', '2026-05-01T12:00:02.000Z', { input_tokens: 500, output_tokens: 120 }, [readBlock('/z.ts')]),
    ].join('\n') + '\n'
    await writeFile(sessionPath, replaced)
    expect((await stat(sessionPath)).ino).not.toBe(inoBefore)

    readLineCalls.length = 0
    const warm = await parseWith(warmCache)
    // inode changed => modified => full re-parse from byte 0, never an offset.
    expect(offsetsFor(sessionPath).every(o => o === undefined || o === 0)).toBe(true)

    const cold = await coldFullReparse()
    expect(warm).toEqual(cold)
    await rm(warmCache, { recursive: true, force: true })
  })

  it('EDGE: cached offset beyond current EOF falls back to a full re-parse', async () => {
    const warmCache = await mkdtemp(join(tmpdir(), 'incr-warm5-'))
    await writeFile(sessionPath, baseLines().join('\n') + '\n')
    await parseWith(warmCache)

    // Corrupt the persisted offset to point far beyond the file, then grow it.
    const cachePath = sessionCachePath()
    const cache = JSON.parse(await readFile(cachePath, 'utf-8'))
    cache.providers.claude.files[sessionPath].lastCompleteLineOffset = 10_000_000
    await writeFile(cachePath, JSON.stringify(cache))

    await appendFile(sessionPath,
      userLine('2026-05-01T13:00:00.000Z', 'grow the file') + '\n' +
      asstLine('msg-y', '2026-05-01T13:00:02.000Z', { input_tokens: 400, output_tokens: 100 }, [bashBlock('pwd')]) + '\n')

    readLineCalls.length = 0
    const warm = await parseWith(warmCache)
    // guard: never resume from the stranded offset.
    expect(offsetsFor(sessionPath).some(o => o === 10_000_000)).toBe(false)

    const cold = await coldFullReparse()
    expect(warm).toEqual(cold)
    await rm(warmCache, { recursive: true, force: true })
  })
})

describe('straddle guard (streamed id restated across the append boundary)', () => {
  // A streamed assistant id whose first emission sits in the committed prefix
  // (and NOT in the last cached turn) can be restated in the appended region.
  // The boundary merge would splice it into the wrong turn and count it twice;
  // the guard must abandon the shortcut and re-parse the file from byte 0,
  // matching the cold-parse oracle exactly.
  it('falls back to a full re-parse when an appended id already exists in the cached turns', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'incr-straddle-'))
    try {
      await writeFile(sessionPath, baseLines().join('\n') + '\n')
      await parseWith(cacheDir)

      // Restatement of msg-a (first turn's id, grown usage) followed by a new
      // turn — the shape image-heavy sessions produce while streaming.
      const appended = [
        asstLine('msg-a', '2026-05-01T10:06:00.000Z', { input_tokens: 100, output_tokens: 90, cache_read_input_tokens: 300 }, [readBlock('/a.ts')]),
        userLine('2026-05-01T10:07:00.000Z', 'third task please'),
        asstLine('msg-c', '2026-05-01T10:07:02.000Z', { input_tokens: 50, output_tokens: 10 }, []),
      ]
      await appendFile(sessionPath, appended.join('\n') + '\n')

      readLineCalls.length = 0
      const incremental = await parseWith(cacheDir)
      const oracle = await coldFullReparse()

      const sum = (ps: ProjectSummary[]) => ({
        calls: ps.reduce((s, p) => s + p.totalApiCalls, 0),
        cost: ps.reduce((s, p) => s + p.totalCostUSD, 0),
        turns: ps.flatMap(p => p.sessions).reduce((s, x) => s + x.turns.length, 0),
      })
      expect(sum(incremental)).toEqual(sum(oracle))

      // The guard must have re-read the file from byte 0, not the append offset.
      const offsets = offsetsFor(sessionPath)
      expect(offsets.some(o => o === undefined || o === 0)).toBe(true)
    } finally {
      await rm(cacheDir, { recursive: true, force: true })
    }
  })
})

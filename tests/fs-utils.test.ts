import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  MAX_SESSION_FILE_BYTES,
  MAX_STREAM_SESSION_FILE_BYTES,
  readSessionFile,
  readSessionLines,
} from '../src/fs-utils.js'

describe('readSessionFile', () => {
  const tmpDirs: string[] = []

  afterEach(async () => {
    delete process.env.CODEBURN_VERBOSE
    while (tmpDirs.length > 0) {
      const d = tmpDirs.pop()
      if (d) await rm(d, { recursive: true, force: true })
    }
  })

  async function tmpPath(content: string | Buffer): Promise<string> {
    const base = await mkdtemp(join(tmpdir(), 'codeburn-fs-'))
    tmpDirs.push(base)
    const p = join(base, 'x.jsonl')
    await writeFile(p, content)
    return p
  }

  it('returns content for small files via readFile fast path', async () => {
    const p = await tmpPath('hello\nworld\n')
    expect(await readSessionFile(p)).toBe('hello\nworld\n')
  })

  it('returns content for large files under the full-file cap', async () => {
    const size = 8 * 1024 * 1024
    const p = await tmpPath(Buffer.alloc(size, 'a'))
    const got = await readSessionFile(p)
    expect(got).not.toBeNull()
    expect(got!.length).toBe(size)
  })

  it('returns null and skips files over the cap', async () => {
    const p = await tmpPath(Buffer.alloc(MAX_SESSION_FILE_BYTES + 1, 'b'))
    expect(await readSessionFile(p)).toBeNull()
  })

  it('emits stderr warning under CODEBURN_VERBOSE=1 for skipped file', async () => {
    process.env.CODEBURN_VERBOSE = '1'
    const p = await tmpPath(Buffer.alloc(MAX_SESSION_FILE_BYTES + 1, 'c'))
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    await readSessionFile(p)
    expect(spy).toHaveBeenCalled()
    const msg = (spy.mock.calls[0][0] as string)
    expect(msg).toContain('codeburn')
    expect(msg).toContain('oversize')
    spy.mockRestore()
  })

  it('returns null on stat failure without throwing', async () => {
    expect(await readSessionFile('/nonexistent/path/x.jsonl')).toBeNull()
  })
})

describe('readSessionLines', () => {
  const tmpDirs: string[] = []

  afterEach(async () => {
    while (tmpDirs.length > 0) {
      const d = tmpDirs.pop()
      if (d) await rm(d, { recursive: true, force: true })
    }
  })

  async function tmpPath(content: string): Promise<string> {
    const base = await mkdtemp(join(tmpdir(), 'codeburn-lines-'))
    tmpDirs.push(base)
    const p = join(base, 'session.jsonl')
    await writeFile(p, content)
    return p
  }

  it('yields all lines from a file', async () => {
    const p = await tmpPath('line1\nline2\nline3\n')
    const lines: string[] = []
    for await (const line of readSessionLines(p)) lines.push(line)
    expect(lines).toEqual(['line1', 'line2', 'line3'])
  })

  it('skips old large lines before materializing the full line', async () => {
    const oldLine = `{"type":"assistant","timestamp":"2026-01-01T00:00:00Z","payload":"${'x'.repeat(100_000)}"}`
    const newLine = '{"type":"assistant","timestamp":"2026-05-01T00:00:00Z"}'
    const p = await tmpPath(`${oldLine}\n${newLine}\n`)
    const lines: string[] = []
    for await (const line of readSessionLines(p, head => head.includes('2026-01-01'))) {
      lines.push(line)
    }
    expect(lines).toEqual([newLine])
  })

  it('yields large lines as Buffers when requested', async () => {
    const largeLine = `{"type":"assistant","timestamp":"2026-05-01T00:00:00Z","payload":"${'x'.repeat(100_000)}"}`
    const p = await tmpPath(`${largeLine}\nsmall\n`)
    const lines: Array<string | Buffer> = []
    for await (const line of readSessionLines(p, undefined, { largeLineAsBuffer: true })) {
      lines.push(line)
    }
    expect(Buffer.isBuffer(lines[0])).toBe(true)
    expect(lines[1]).toBe('small')
  })

  it('does not leak file descriptors when generator is abandoned early', async () => {
    const content = Array.from({ length: 1000 }, (_, i) => `line-${i}`).join('\n')
    const p = await tmpPath(content)
    const gen = readSessionLines(p)
    await gen.next()
    await gen.return(undefined)
  })

  it('reads from startByteOffset, yielding only lines after the offset', async () => {
    const content = 'line1\nline2\nline3\n'
    const p = await tmpPath(content)
    const offset = Buffer.byteLength('line1\n')
    const lines: string[] = []
    for await (const line of readSessionLines(p, undefined, { startByteOffset: offset })) {
      lines.push(line)
    }
    expect(lines).toEqual(['line2', 'line3'])
  })

  it('byteOffsetTracker tracks position after last complete newline', async () => {
    const content = 'aaa\nbbb\nccc\n'
    const p = await tmpPath(content)
    const tracker = { lastCompleteLineOffset: 0 }
    const lines: string[] = []
    for await (const line of readSessionLines(p, undefined, { byteOffsetTracker: tracker })) {
      lines.push(line)
    }
    expect(lines).toEqual(['aaa', 'bbb', 'ccc'])
    expect(tracker.lastCompleteLineOffset).toBe(Buffer.byteLength(content))
  })

  it('byteOffsetTracker accounts for startByteOffset', async () => {
    const content = 'line1\nline2\nline3\n'
    const p = await tmpPath(content)
    const offset = Buffer.byteLength('line1\n')
    const tracker = { lastCompleteLineOffset: 0 }
    for await (const _line of readSessionLines(p, undefined, { startByteOffset: offset, byteOffsetTracker: tracker })) {}
    expect(tracker.lastCompleteLineOffset).toBe(Buffer.byteLength(content))
  })

  it('byteOffsetTracker excludes trailing partial line (no final newline)', async () => {
    const content = 'line1\nline2\npartial'
    const p = await tmpPath(content)
    const tracker = { lastCompleteLineOffset: 0 }
    for await (const _line of readSessionLines(p, undefined, { byteOffsetTracker: tracker })) {}
    expect(tracker.lastCompleteLineOffset).toBe(Buffer.byteLength('line1\nline2\n'))
  })

  it('byteOffsetTracker updates for skipped lines too', async () => {
    const content = 'skip-me\nkeep-me\n'
    const p = await tmpPath(content)
    const tracker = { lastCompleteLineOffset: 0 }
    const lines: string[] = []
    for await (const line of readSessionLines(p, head => head.includes('skip-me'), { byteOffsetTracker: tracker })) {
      lines.push(line)
    }
    expect(lines).toEqual(['keep-me'])
    expect(tracker.lastCompleteLineOffset).toBe(Buffer.byteLength(content))
  })

  it('reads files at or under the stream cap', async () => {
    const p = await tmpPath('a\nb\nc\n')
    const lines: string[] = []
    for await (const line of readSessionLines(p, undefined, { maxBytes: 1024 })) lines.push(line)
    expect(lines).toEqual(['a', 'b', 'c'])
  })

  it('skips files over the stream cap and surfaces a notice without CODEBURN_VERBOSE', async () => {
    const p = await tmpPath('a\nb\nc\n')
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const lines: string[] = []
    for await (const line of readSessionLines(p, undefined, { maxBytes: 1 })) lines.push(line)
    expect(lines).toEqual([])
    expect(spy).toHaveBeenCalled()
    expect(spy.mock.calls[0][0] as string).toContain('skipped oversize session')
    spy.mockRestore()
  })

  it('stream cap is generous enough for multi-GB Codex sessions', () => {
    expect(MAX_STREAM_SESSION_FILE_BYTES).toBe(4 * 1024 * 1024 * 1024)
  })
})

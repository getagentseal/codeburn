import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return { ...actual, existsSync: vi.fn(), readFileSync: vi.fn() }
})

const mockExistsSync = vi.mocked(existsSync)
const mockReadFileSync = vi.mocked(readFileSync)

type ToolCall = {
  name: string
  input: Record<string, unknown>
  sessionId: string
  project: string
}

// Re-implement detector logic for isolated testing
// This avoids importing the module which has side-effect imports

function detectJunkReadsLogic(calls: ToolCall[]) {
  const JUNK_PATTERN = /\/(node_modules|\.git|dist|build|__pycache__|\.next|\.nuxt|\.output|coverage|\.cache|\.tsbuildinfo|\.venv|venv|\.svn|\.hg)\//
  const readCalls = calls.filter(c => c.name === 'Read' || c.name === 'FileReadTool')
  const dirCounts = new Map<string, number>()
  let total = 0
  for (const call of readCalls) {
    const fp = call.input.file_path as string | undefined
    if (!fp || !JUNK_PATTERN.test(fp)) continue
    total++
    const dirs = ['node_modules', '.git', 'dist', 'build', '__pycache__', '.next', '.venv', 'venv']
    for (const d of dirs) {
      if (fp.includes(`/${d}/`)) { dirCounts.set(d, (dirCounts.get(d) ?? 0) + 1); break }
    }
  }
  return { total, dirCounts }
}

function detectDuplicateReadsLogic(calls: ToolCall[]) {
  const JUNK_PATTERN = /\/(node_modules|\.git|dist|build|__pycache__|\.next)\//
  const readCalls = calls.filter(c => c.name === 'Read' || c.name === 'FileReadTool')
  const sessionFiles = new Map<string, Map<string, number>>()
  for (const call of readCalls) {
    const fp = call.input.file_path as string | undefined
    if (!fp || JUNK_PATTERN.test(fp)) continue
    const key = `${call.project}:${call.sessionId}`
    if (!sessionFiles.has(key)) sessionFiles.set(key, new Map())
    const fm = sessionFiles.get(key)!
    fm.set(fp, (fm.get(fp) ?? 0) + 1)
  }
  let totalDuplicates = 0
  for (const fm of sessionFiles.values()) {
    for (const [, count] of fm) {
      if (count > 1) totalDuplicates += count - 1
    }
  }
  return totalDuplicates
}

describe('optimize: junk reads detection', () => {
  it('detects node_modules reads', () => {
    const calls: ToolCall[] = [
      { name: 'Read', input: { file_path: '/project/node_modules/foo/index.js' }, sessionId: 's1', project: 'p1' },
      { name: 'Read', input: { file_path: '/project/node_modules/bar/package.json' }, sessionId: 's1', project: 'p1' },
      { name: 'Read', input: { file_path: '/project/node_modules/baz/lib.js' }, sessionId: 's1', project: 'p1' },
      { name: 'Read', input: { file_path: '/project/src/main.ts' }, sessionId: 's1', project: 'p1' },
    ]
    const result = detectJunkReadsLogic(calls)
    expect(result.total).toBe(3)
    expect(result.dirCounts.get('node_modules')).toBe(3)
  })

  it('detects .git reads', () => {
    const calls: ToolCall[] = [
      { name: 'Read', input: { file_path: '/project/.git/config' }, sessionId: 's1', project: 'p1' },
      { name: 'Read', input: { file_path: '/project/.git/HEAD' }, sessionId: 's1', project: 'p1' },
    ]
    const result = detectJunkReadsLogic(calls)
    expect(result.total).toBe(2)
    expect(result.dirCounts.get('.git')).toBe(2)
  })

  it('detects mixed junk directories', () => {
    const calls: ToolCall[] = [
      { name: 'Read', input: { file_path: '/project/node_modules/a.js' }, sessionId: 's1', project: 'p1' },
      { name: 'Read', input: { file_path: '/project/dist/bundle.js' }, sessionId: 's1', project: 'p1' },
      { name: 'Read', input: { file_path: '/project/.venv/lib/python/site.py' }, sessionId: 's1', project: 'p1' },
    ]
    const result = detectJunkReadsLogic(calls)
    expect(result.total).toBe(3)
    expect(result.dirCounts.get('node_modules')).toBe(1)
    expect(result.dirCounts.get('dist')).toBe(1)
    expect(result.dirCounts.get('.venv')).toBe(1)
  })

  it('ignores non-junk paths', () => {
    const calls: ToolCall[] = [
      { name: 'Read', input: { file_path: '/project/src/index.ts' }, sessionId: 's1', project: 'p1' },
      { name: 'Read', input: { file_path: '/project/README.md' }, sessionId: 's1', project: 'p1' },
    ]
    const result = detectJunkReadsLogic(calls)
    expect(result.total).toBe(0)
  })

  it('ignores non-Read tools', () => {
    const calls: ToolCall[] = [
      { name: 'Edit', input: { file_path: '/project/node_modules/foo.js' }, sessionId: 's1', project: 'p1' },
      { name: 'Bash', input: { command: 'ls node_modules' }, sessionId: 's1', project: 'p1' },
    ]
    const result = detectJunkReadsLogic(calls)
    expect(result.total).toBe(0)
  })

  it('handles missing file_path', () => {
    const calls: ToolCall[] = [
      { name: 'Read', input: {}, sessionId: 's1', project: 'p1' },
      { name: 'Read', input: { file_path: null as unknown as string }, sessionId: 's1', project: 'p1' },
    ]
    const result = detectJunkReadsLogic(calls)
    expect(result.total).toBe(0)
  })
})

describe('optimize: duplicate reads detection', () => {
  it('detects files read multiple times in same session', () => {
    const calls: ToolCall[] = [
      { name: 'Read', input: { file_path: '/project/src/main.ts' }, sessionId: 's1', project: 'p1' },
      { name: 'Read', input: { file_path: '/project/src/main.ts' }, sessionId: 's1', project: 'p1' },
      { name: 'Read', input: { file_path: '/project/src/main.ts' }, sessionId: 's1', project: 'p1' },
    ]
    expect(detectDuplicateReadsLogic(calls)).toBe(2)
  })

  it('does not count reads across different sessions', () => {
    const calls: ToolCall[] = [
      { name: 'Read', input: { file_path: '/project/src/main.ts' }, sessionId: 's1', project: 'p1' },
      { name: 'Read', input: { file_path: '/project/src/main.ts' }, sessionId: 's2', project: 'p1' },
    ]
    expect(detectDuplicateReadsLogic(calls)).toBe(0)
  })

  it('excludes junk directory reads from duplicate count', () => {
    const calls: ToolCall[] = [
      { name: 'Read', input: { file_path: '/project/node_modules/foo.js' }, sessionId: 's1', project: 'p1' },
      { name: 'Read', input: { file_path: '/project/node_modules/foo.js' }, sessionId: 's1', project: 'p1' },
    ]
    expect(detectDuplicateReadsLogic(calls)).toBe(0)
  })

  it('counts duplicates per file independently', () => {
    const calls: ToolCall[] = [
      { name: 'Read', input: { file_path: '/project/a.ts' }, sessionId: 's1', project: 'p1' },
      { name: 'Read', input: { file_path: '/project/a.ts' }, sessionId: 's1', project: 'p1' },
      { name: 'Read', input: { file_path: '/project/b.ts' }, sessionId: 's1', project: 'p1' },
      { name: 'Read', input: { file_path: '/project/b.ts' }, sessionId: 's1', project: 'p1' },
      { name: 'Read', input: { file_path: '/project/b.ts' }, sessionId: 's1', project: 'p1' },
    ]
    expect(detectDuplicateReadsLogic(calls)).toBe(3)
  })

  it('returns 0 for single reads', () => {
    const calls: ToolCall[] = [
      { name: 'Read', input: { file_path: '/project/a.ts' }, sessionId: 's1', project: 'p1' },
      { name: 'Read', input: { file_path: '/project/b.ts' }, sessionId: 's1', project: 'p1' },
      { name: 'Read', input: { file_path: '/project/c.ts' }, sessionId: 's1', project: 'p1' },
    ]
    expect(detectDuplicateReadsLogic(calls)).toBe(0)
  })

  it('handles empty calls', () => {
    expect(detectDuplicateReadsLogic([])).toBe(0)
  })
})

function detectReadEditRatioLogic(calls: ToolCall[]) {
  const READ_NAMES = new Set(['Read', 'Grep', 'Glob', 'FileReadTool', 'GrepTool', 'GlobTool'])
  const EDIT_NAMES = new Set(['Edit', 'Write', 'FileEditTool', 'FileWriteTool', 'NotebookEdit'])
  let reads = 0, edits = 0
  for (const c of calls) {
    if (READ_NAMES.has(c.name)) reads++
    else if (EDIT_NAMES.has(c.name)) edits++
  }
  return { reads, edits, ratio: edits > 0 ? reads / edits : Infinity }
}

describe('optimize: read:edit ratio detection', () => {
  it('detects low ratio (edit-heavy)', () => {
    const calls: ToolCall[] = [
      ...Array(5).fill(null).map(() => ({ name: 'Read', input: {}, sessionId: 's1', project: 'p1' })),
      ...Array(10).fill(null).map(() => ({ name: 'Edit', input: {}, sessionId: 's1', project: 'p1' })),
    ]
    const { ratio } = detectReadEditRatioLogic(calls)
    expect(ratio).toBe(0.5)
  })

  it('healthy ratio passes (4:1+)', () => {
    const calls: ToolCall[] = [
      ...Array(40).fill(null).map(() => ({ name: 'Read', input: {}, sessionId: 's1', project: 'p1' })),
      ...Array(10).fill(null).map(() => ({ name: 'Edit', input: {}, sessionId: 's1', project: 'p1' })),
    ]
    const { ratio } = detectReadEditRatioLogic(calls)
    expect(ratio).toBe(4)
  })

  it('counts Grep and Glob as reads', () => {
    const calls: ToolCall[] = [
      { name: 'Read', input: {}, sessionId: 's1', project: 'p1' },
      { name: 'Grep', input: {}, sessionId: 's1', project: 'p1' },
      { name: 'Glob', input: {}, sessionId: 's1', project: 'p1' },
      { name: 'Edit', input: {}, sessionId: 's1', project: 'p1' },
    ]
    const { reads, edits } = detectReadEditRatioLogic(calls)
    expect(reads).toBe(3)
    expect(edits).toBe(1)
  })

  it('counts Write as edit', () => {
    const calls: ToolCall[] = [
      { name: 'Write', input: {}, sessionId: 's1', project: 'p1' },
      { name: 'Edit', input: {}, sessionId: 's1', project: 'p1' },
    ]
    const { edits } = detectReadEditRatioLogic(calls)
    expect(edits).toBe(2)
  })

  it('ignores non-read non-edit tools', () => {
    const calls: ToolCall[] = [
      { name: 'Bash', input: {}, sessionId: 's1', project: 'p1' },
      { name: 'Agent', input: {}, sessionId: 's1', project: 'p1' },
      { name: 'mcp__foo__bar', input: {}, sessionId: 's1', project: 'p1' },
    ]
    const { reads, edits } = detectReadEditRatioLogic(calls)
    expect(reads).toBe(0)
    expect(edits).toBe(0)
  })
})

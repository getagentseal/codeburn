import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  const fs = await vi.importActual<typeof import('fs')>('fs')
  const fakeHome = fs.mkdtempSync(actual.tmpdir() + '/codeburn-home-')
  fs.mkdirSync(fakeHome + '/.augment', { recursive: true })
  process.env['CODEBURN_TEST_FAKE_HOME'] = fakeHome
  return { ...actual, homedir: () => fakeHome }
})

const FAKE_HOME_FOR_MOCK = process.env['CODEBURN_TEST_FAKE_HOME']!

import {
  detectBashBloat,
  scanJsonlFile,
  scanAndDetect,
} from '../src/optimize.js'
import {
  estimateContextBudget,
  discoverProjectCwd,
} from '../src/context-budget.js'

// ============================================================================
// Helpers for filesystem fixtures
// ============================================================================

const FIXTURE_ROOTS: string[] = [FAKE_HOME_FOR_MOCK]

function makeFixtureRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codeburn-test-'))
  FIXTURE_ROOTS.push(dir)
  return dir
}

function writeFile(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

function touchOld(path: string, daysAgo: number): void {
  const past = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000)
  utimesSync(path, past, past)
}

afterAll(() => {
  for (const dir of FIXTURE_ROOTS) {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ============================================================================
// detectBashBloat
// ============================================================================

describe('detectBashBloat', () => {
  const originalEnv = process.env['BASH_MAX_OUTPUT_LENGTH']

  beforeEach(() => {
    delete process.env['BASH_MAX_OUTPUT_LENGTH']
  })

  afterAll(() => {
    if (originalEnv !== undefined) process.env['BASH_MAX_OUTPUT_LENGTH'] = originalEnv
  })

  it('flags when env var is unset (uses default 30K)', () => {
    const finding = detectBashBloat()
    expect(finding).not.toBeNull()
    expect(finding!.impact).toBe('medium')
  })

  it('does not flag when env var is at recommended 15K', () => {
    process.env['BASH_MAX_OUTPUT_LENGTH'] = '15000'
    expect(detectBashBloat()).toBeNull()
  })

  it('does not flag when env var is below recommended', () => {
    process.env['BASH_MAX_OUTPUT_LENGTH'] = '10000'
    expect(detectBashBloat()).toBeNull()
  })

  it('flags when env var is above 15K', () => {
    process.env['BASH_MAX_OUTPUT_LENGTH'] = '50000'
    const finding = detectBashBloat()
    expect(finding).not.toBeNull()
  })
})

// ============================================================================
// scanJsonlFile
// ============================================================================

describe('scanJsonlFile', () => {
  it('returns empty result for nonexistent file', async () => {
    const result = await scanJsonlFile('/nonexistent/path.jsonl', 'p1', undefined)
    expect(result.calls).toEqual([])
    expect(result.cwds).toEqual([])
    expect(result.apiCalls).toEqual([])
    expect(result.userMessages).toEqual([])
  })

  it('parses tool_use blocks from assistant entries', async () => {
    const root = makeFixtureRoot()
    const filePath = join(root, 'session.jsonl')
    const now = new Date().toISOString()
    const lines = [
      JSON.stringify({
        type: 'assistant',
        timestamp: now,
        message: {
          content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/x/foo.ts' } }],
        },
      }),
    ]
    writeFile(filePath, lines.join('\n'))
    const result = await scanJsonlFile(filePath, 'p1', undefined)
    expect(result.calls).toHaveLength(1)
    expect(result.calls[0].name).toBe('Read')
  })

  it('skips malformed JSONL lines without crashing', async () => {
    const root = makeFixtureRoot()
    const filePath = join(root, 'session.jsonl')
    writeFile(filePath, 'this is not json\n{broken\n{"type":"assistant","message":{"content":[]}}\n')
    const result = await scanJsonlFile(filePath, 'p1', undefined)
    expect(result.calls).toEqual([])
  })

  it('respects date-range filter for assistant entries', async () => {
    const root = makeFixtureRoot()
    const filePath = join(root, 'session.jsonl')
    const old = '2020-01-01T00:00:00Z'
    const now = new Date().toISOString()
    writeFile(filePath, [
      JSON.stringify({
        type: 'assistant', timestamp: old,
        message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/old' } }] },
      }),
      JSON.stringify({
        type: 'assistant', timestamp: now,
        message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/new' } }] },
      }),
    ].join('\n'))
    const today = new Date()
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate())
    const result = await scanJsonlFile(filePath, 'p1', { start, end: today })
    expect(result.calls).toHaveLength(1)
    expect((result.calls[0].input as Record<string, unknown>).file_path).toBe('/new')
  })
})

// ============================================================================
// scanAndDetect (top-level integration)
// ============================================================================

describe('scanAndDetect', () => {
  it('returns healthy result for empty projects', async () => {
    const result = await scanAndDetect([])
    expect(result.findings).toEqual([])
    expect(result.healthScore).toBe(100)
    expect(result.healthGrade).toBe('A')
    expect(result.costRate).toBe(0)
  })
})

// ============================================================================
// context-budget
// ============================================================================

describe('estimateContextBudget', () => {
  it('returns only system base when project has no config', async () => {
    const root = makeFixtureRoot()
    const budget = await estimateContextBudget(root)
    expect(budget.total).toBeGreaterThan(0)
    expect(budget.mcpTools.count).toBe(0)
    expect(budget.skills.count).toBe(0)
  })

  it('includes MCP tools from project .mcp.json', async () => {
    const root = makeFixtureRoot()
    writeFile(join(root, '.mcp.json'), JSON.stringify({
      mcpServers: { a: { command: 'x' }, b: { command: 'x' } },
    }))
    const budget = await estimateContextBudget(root)
    expect(budget.mcpTools.count).toBeGreaterThan(0)
  })

  it('includes memory file tokens from CLAUDE.md', async () => {
    const root = makeFixtureRoot()
    writeFile(join(root, 'CLAUDE.md'), 'Project context for Claude.\n')
    const budget = await estimateContextBudget(root)
    expect(budget.memory.count).toBeGreaterThan(0)
    expect(budget.memory.tokens).toBeGreaterThan(0)
  })
})

describe('discoverProjectCwd', () => {
  it('returns null for empty directory', async () => {
    const root = makeFixtureRoot()
    expect(await discoverProjectCwd(root)).toBeNull()
  })

  it('returns null for directory with no jsonl files', async () => {
    const root = makeFixtureRoot()
    writeFile(join(root, 'readme.txt'), 'hi')
    expect(await discoverProjectCwd(root)).toBeNull()
  })

  it('extracts cwd from the first jsonl entry', async () => {
    const root = makeFixtureRoot()
    const entry = JSON.stringify({ type: 'assistant', cwd: '/Users/test/project', timestamp: new Date().toISOString() })
    writeFile(join(root, 'session.jsonl'), entry + '\n')
    expect(await discoverProjectCwd(root)).toBe('/Users/test/project')
  })
})

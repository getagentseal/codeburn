import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as fsUtils from '../src/fs-utils.js'

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  const fs = await vi.importActual<typeof import('fs')>('fs')
  const fakeHome = fs.mkdtempSync(actual.tmpdir() + '/codeburn-home-')
  fs.mkdirSync(fakeHome + '/.claude', { recursive: true })
  process.env['CODEBURN_TEST_FAKE_HOME'] = fakeHome
  return { ...actual, homedir: () => fakeHome }
})

const FAKE_HOME_FOR_MOCK = process.env['CODEBURN_TEST_FAKE_HOME']!

import {
  detectBloatedClaudeMd,
  detectUnusedMcp,
  detectBashBloat,
  detectGhostAgents,
  detectGhostSkills,
  detectGhostCommands,
  loadMcpConfigs,
  scanJsonlFile,
  scanAndDetect,
  type ToolCall,
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

beforeEach(() => {
  rmSync(join(FAKE_HOME_FOR_MOCK, '.claude.json'), { force: true })
})

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
// detectBloatedClaudeMd (including @-import expansion)
// ============================================================================

describe('detectBloatedClaudeMd', () => {
  it('flags a CLAUDE.md with more than 200 lines', () => {
    const root = makeFixtureRoot()
    const projectDir = join(root, 'myapp')
    mkdirSync(projectDir, { recursive: true })
    const content = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n')
    writeFile(join(projectDir, 'CLAUDE.md'), content)
    const finding = detectBloatedClaudeMd(new Set([projectDir]))
    expect(finding).not.toBeNull()
  })

  it('expands @-imports and counts transitive load', () => {
    const root = makeFixtureRoot()
    const projectDir = join(root, 'myapp')
    mkdirSync(projectDir, { recursive: true })
    writeFile(
      join(projectDir, 'CLAUDE.md'),
      'line 1\nline 2\n@./rules.md\n@./conventions.md\n',
    )
    writeFile(join(projectDir, 'rules.md'), Array.from({ length: 120 }, (_, i) => `rule ${i}`).join('\n'))
    writeFile(join(projectDir, 'conventions.md'), Array.from({ length: 120 }, (_, i) => `conv ${i}`).join('\n'))
    const finding = detectBloatedClaudeMd(new Set([projectDir]))
    expect(finding).not.toBeNull()
    expect(finding!.explanation).toContain('2 @-imports')
  })

  it('does not flag a lean CLAUDE.md under 200 lines with no imports', () => {
    const root = makeFixtureRoot()
    const projectDir = join(root, 'myapp')
    mkdirSync(projectDir, { recursive: true })
    writeFile(join(projectDir, 'CLAUDE.md'), 'just a few\nlines\nhere\n')
    expect(detectBloatedClaudeMd(new Set([projectDir]))).toBeNull()
  })

  it('does not recurse infinitely on circular @-imports', () => {
    const root = makeFixtureRoot()
    const projectDir = join(root, 'myapp')
    mkdirSync(projectDir, { recursive: true })
    writeFile(join(projectDir, 'CLAUDE.md'), '@./a.md\n')
    writeFile(join(projectDir, 'a.md'), '@./b.md\n')
    writeFile(join(projectDir, 'b.md'), '@./a.md\n')
    expect(() => detectBloatedClaudeMd(new Set([projectDir]))).not.toThrow()
  })

  it('ignores @ tokens that are not paths (emails, npm scopes)', () => {
    const root = makeFixtureRoot()
    const projectDir = join(root, 'myapp')
    mkdirSync(projectDir, { recursive: true })
    writeFile(
      join(projectDir, 'CLAUDE.md'),
      Array.from({ length: 250 }, (_, i) =>
        i === 10 ? '@user@example.com' :
        i === 20 ? '@org/package' :
        `line ${i}`
      ).join('\n'),
    )
    const finding = detectBloatedClaudeMd(new Set([projectDir]))
    expect(finding).not.toBeNull()
    // "with N @-imports" suffix appears only when non-zero imports were resolved
    expect(finding!.explanation).not.toMatch(/with \d+ @-import/)
  })
})

// ============================================================================
// loadMcpConfigs + detectUnusedMcp
// ============================================================================

describe('loadMcpConfigs', () => {
  it('returns empty map when no configs exist', () => {
    const root = makeFixtureRoot()
    const servers = loadMcpConfigs([root])
    expect(servers.size).toBe(0)
  })

  it('reads servers from project .mcp.json', () => {
    const root = makeFixtureRoot()
    const projectDir = join(root, 'myapp')
    mkdirSync(projectDir, { recursive: true })
    writeFile(join(projectDir, '.mcp.json'), JSON.stringify({
      mcpServers: { foo: { command: 'foo' }, bar: { command: 'bar' } },
    }))
    const servers = loadMcpConfigs([projectDir])
    expect(servers.has('foo')).toBe(true)
    expect(servers.has('bar')).toBe(true)
  })

  it('normalizes server names by replacing colons with underscores', () => {
    const root = makeFixtureRoot()
    const projectDir = join(root, 'myapp')
    mkdirSync(projectDir, { recursive: true })
    writeFile(join(projectDir, '.mcp.json'), JSON.stringify({
      mcpServers: { 'plugin:context7:context7': { command: 'ctx' } },
    }))
    const servers = loadMcpConfigs([projectDir])
    expect(servers.has('plugin_context7_context7')).toBe(true)
    expect(servers.get('plugin_context7_context7')!.original).toBe('plugin:context7:context7')
  })

  it('handles malformed JSON without crashing', () => {
    const root = makeFixtureRoot()
    const projectDir = join(root, 'myapp')
    mkdirSync(projectDir, { recursive: true })
    writeFile(join(projectDir, '.mcp.json'), '{ not valid json')
    expect(() => loadMcpConfigs([projectDir])).not.toThrow()
    expect(loadMcpConfigs([projectDir]).size).toBe(0)
  })

  describe('~/.claude.json support (claude mcp add flow)', () => {
    const claudeJsonPath = join(FAKE_HOME_FOR_MOCK, '.claude.json')

    beforeEach(() => {
      rmSync(claudeJsonPath, { force: true })
    })

    it('reads user-scope mcpServers from ~/.claude.json top-level', () => {
      writeFile(claudeJsonPath, JSON.stringify({
        mcpServers: { docker: { command: 'x' }, vault: { command: 'y' } },
      }))
      const servers = loadMcpConfigs([])
      expect(servers.has('docker')).toBe(true)
      expect(servers.has('vault')).toBe(true)
    })

    it('reads project-scope mcpServers from ~/.claude.json projects map', () => {
      const projectDir = join(makeFixtureRoot(), 'proj')
      mkdirSync(projectDir, { recursive: true })
      writeFile(claudeJsonPath, JSON.stringify({
        projects: { [projectDir]: { mcpServers: { local: { command: 'x' } } } },
      }))
      const servers = loadMcpConfigs([projectDir])
      expect(servers.has('local')).toBe(true)
    })

    it('matches projects map key with forward slashes on Windows paths', () => {
      const projectDir = join(makeFixtureRoot(), 'proj')
      mkdirSync(projectDir, { recursive: true })
      writeFile(claudeJsonPath, JSON.stringify({
        projects: { [projectDir.replace(/\\/g, '/')]: { mcpServers: { win: { command: 'x' } } } },
      }))
      const servers = loadMcpConfigs([projectDir])
      expect(servers.has('win')).toBe(true)
    })

    it('merges ~/.claude.json user-scope with project .mcp.json', () => {
      const projectDir = join(makeFixtureRoot(), 'proj')
      mkdirSync(projectDir, { recursive: true })
      writeFile(join(projectDir, '.mcp.json'), JSON.stringify({
        mcpServers: { proj_only: { command: 'x' } },
      }))
      writeFile(claudeJsonPath, JSON.stringify({
        mcpServers: { user_wide: { command: 'y' } },
      }))
      const servers = loadMcpConfigs([projectDir])
      expect(servers.has('proj_only')).toBe(true)
      expect(servers.has('user_wide')).toBe(true)
      expect(servers.size).toBe(2)
    })
  })
})

describe('detectUnusedMcp', () => {
  it('flags servers configured but never called', () => {
    const root = makeFixtureRoot()
    const projectDir = join(root, 'myapp')
    mkdirSync(projectDir, { recursive: true })
    writeFile(join(projectDir, '.mcp.json'), JSON.stringify({
      mcpServers: { ghost: { command: 'x' } },
    }))
    const configFile = join(projectDir, '.mcp.json')
    touchOld(configFile, 30)
    const finding = detectUnusedMcp([], [], new Set([projectDir]))
    expect(finding).not.toBeNull()
    expect(finding!.explanation).toContain('ghost')
  })

  it('does not flag servers configured within 24 hours', () => {
    const root = makeFixtureRoot()
    const projectDir = join(root, 'myapp')
    mkdirSync(projectDir, { recursive: true })
    writeFile(join(projectDir, '.mcp.json'), JSON.stringify({
      mcpServers: { freshly_added: { command: 'x' } },
    }))
    expect(detectUnusedMcp([], [], new Set([projectDir]))).toBeNull()
  })

  it('does not flag servers that were called', () => {
    const root = makeFixtureRoot()
    const projectDir = join(root, 'myapp')
    mkdirSync(projectDir, { recursive: true })
    writeFile(join(projectDir, '.mcp.json'), JSON.stringify({
      mcpServers: { used: { command: 'x' } },
    }))
    touchOld(join(projectDir, '.mcp.json'), 30)
    const calls: ToolCall[] = [
      { name: 'mcp__used__some_tool', input: {}, sessionId: 's1', project: 'p1' },
    ]
    expect(detectUnusedMcp(calls, [], new Set([projectDir]))).toBeNull()
  })

  it('explanation mentions tokens/session', () => {
    const root = makeFixtureRoot()
    const projectDir = join(root, 'myapp')
    mkdirSync(projectDir, { recursive: true })
    writeFile(join(projectDir, '.mcp.json'), JSON.stringify({
      mcpServers: { ghost: { command: 'x' } },
    }))
    touchOld(join(projectDir, '.mcp.json'), 30)
    const finding = detectUnusedMcp([], [], new Set([projectDir]))
    expect(finding).not.toBeNull()
    expect(finding!.explanation).toMatch(/tokens\/session/)
  })
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
// detectGhostCommands (the pure-function ghost detector)
// ============================================================================

describe('detectGhostCommands', () => {
  it('returns null when no commands are defined', async () => {
    expect(await detectGhostCommands([])).toBeNull()
  })

  it('does not match /tmp or /usr or other path prefixes as command usage', async () => {
    const messages = [
      'check /tmp/debug.log',
      'look at /usr/local/bin',
      'rm -rf /var/cache',
    ]
    expect(await detectGhostCommands(messages)).toBeNull()
  })

  it('matches <command-name> tags in user messages', async () => {
    const messages = ['<command-name>review</command-name>']
    expect(await detectGhostCommands(messages)).toBeNull()
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

  it('uses readSessionLines (streaming) rather than readSessionFile (full-string load)', async () => {
    const readSessionLinesSpy = vi.spyOn(fsUtils, 'readSessionLines')
    const readSessionFileSpy = vi.spyOn(fsUtils, 'readSessionFile')
    const root = makeFixtureRoot()
    const filePath = join(root, 'session.jsonl')
    const now = new Date().toISOString()
    writeFile(filePath, JSON.stringify({
      type: 'assistant', timestamp: now,
      message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] },
    }))
    await scanJsonlFile(filePath, 'p1', undefined)
    expect(readSessionLinesSpy).toHaveBeenCalledWith(filePath)
    expect(readSessionFileSpy).not.toHaveBeenCalled()
    readSessionLinesSpy.mockRestore()
    readSessionFileSpy.mockRestore()
  })

  it('processes all entries in a large multi-line file without truncation', async () => {
    const root = makeFixtureRoot()
    const filePath = join(root, 'session.jsonl')
    const now = new Date().toISOString()
    const ENTRY_COUNT = 500
    const lines = Array.from({ length: ENTRY_COUNT }, (_, i) =>
      JSON.stringify({
        type: 'assistant',
        timestamp: now,
        message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: `/file-${i}.ts` } }] },
      }),
    )
    writeFile(filePath, lines.join('\n'))
    const result = await scanJsonlFile(filePath, 'p1', undefined)
    expect(result.calls).toHaveLength(ENTRY_COUNT)
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

// ============================================================================
// estimateContextBudget with calledServers
// ============================================================================

describe('estimateContextBudget with calledServers', () => {
  it('reports unused servers when calledServers provided', async () => {
    const root = makeFixtureRoot()
    writeFile(join(root, '.mcp.json'), JSON.stringify({
      mcpServers: { used: { command: 'x' }, ghost: { command: 'y' } },
    }))
    const budget = await estimateContextBudget(root, 1_000_000, new Set(['used']))
    expect(budget.mcpTools.declared).toBe(2)
    expect(budget.mcpTools.used).toBe(1)
    expect(budget.mcpTools.unused).toEqual(['ghost'])
    expect(budget.mcpTools.unusedTokens).toBe(1 * 5 * 400)
  })

  it('reports zero unused when all called', async () => {
    const root = makeFixtureRoot()
    writeFile(join(root, '.mcp.json'), JSON.stringify({
      mcpServers: { a: { command: 'x' }, b: { command: 'y' } },
    }))
    const budget = await estimateContextBudget(root, 1_000_000, new Set(['a', 'b']))
    expect(budget.mcpTools.unused).toEqual([])
    expect(budget.mcpTools.unusedTokens).toBe(0)
  })

  it('treats calledServers=undefined as no usage data (backward compat)', async () => {
    const root = makeFixtureRoot()
    writeFile(join(root, '.mcp.json'), JSON.stringify({
      mcpServers: { x: { command: 'x' } },
    }))
    const budget = await estimateContextBudget(root)
    expect(budget.mcpTools.declared).toBe(1)
    expect(budget.mcpTools.used).toBe(0)
    expect(budget.mcpTools.unused).toEqual([])
    expect(budget.mcpTools.count).toBe(5)
    expect(budget.mcpTools.tokens).toBe(2000)
  })

  it('reports all servers unused when calledServers is empty set', async () => {
    const root = makeFixtureRoot()
    writeFile(join(root, '.mcp.json'), JSON.stringify({
      mcpServers: { alpha: { command: 'a' }, beta: { command: 'b' } },
    }))
    const budget = await estimateContextBudget(root, 1_000_000, new Set())
    expect(budget.mcpTools.declared).toBe(2)
    expect(budget.mcpTools.used).toBe(0)
    expect(budget.mcpTools.unused).toEqual(['alpha', 'beta'])
    expect(budget.mcpTools.unusedTokens).toBe(2 * 5 * 400)
  })

  it('normalizes plugin:foo:bar names before comparison', async () => {
    const root = makeFixtureRoot()
    writeFile(join(root, '.mcp.json'), JSON.stringify({
      mcpServers: { 'plugin:context7:context7': { command: 'ctx' } },
    }))
    const budget = await estimateContextBudget(root, 1_000_000, new Set(['plugin_context7_context7']))
    expect(budget.mcpTools.used).toBe(1)
    expect(budget.mcpTools.unused).toEqual([])
  })
})

describe('estimateContextBudget reading ~/.claude.json (claude mcp add flow)', () => {
  const claudeJsonPath = join(FAKE_HOME_FOR_MOCK, '.claude.json')

  beforeEach(() => {
    rmSync(claudeJsonPath, { force: true })
  })

  it('reads user-scope mcpServers from ~/.claude.json top-level', async () => {
    writeFile(claudeJsonPath, JSON.stringify({
      mcpServers: { docker: { command: 'x' }, vault: { command: 'y' } },
    }))
    const budget = await estimateContextBudget(undefined, 1_000_000, new Set(['docker']))
    expect(budget.mcpTools.declared).toBe(2)
    expect(budget.mcpTools.used).toBe(1)
    expect(budget.mcpTools.unused).toEqual(['vault'])
  })

  it('reads project-scope mcpServers from ~/.claude.json projects map', async () => {
    const projectDir = join(makeFixtureRoot(), 'proj')
    mkdirSync(projectDir, { recursive: true })
    writeFile(claudeJsonPath, JSON.stringify({
      mcpServers: {},
      projects: { [projectDir]: { mcpServers: { local: { command: 'x' } } } },
    }))
    const budget = await estimateContextBudget(projectDir, 1_000_000, new Set(['other']))
    expect(budget.mcpTools.declared).toBe(1)
    expect(budget.mcpTools.unused).toEqual(['local'])
  })

  it('matches projects map key with forward slashes on Windows paths', async () => {
    const projectDir = join(makeFixtureRoot(), 'proj')
    mkdirSync(projectDir, { recursive: true })
    writeFile(claudeJsonPath, JSON.stringify({
      projects: { [projectDir.replace(/\\/g, '/')]: { mcpServers: { win: { command: 'x' } } } },
    }))
    const budget = await estimateContextBudget(projectDir, 1_000_000, new Set(['other']))
    expect(budget.mcpTools.declared).toBe(1)
  })

  it('merges ~/.claude.json top-level with .mcp.json at project root', async () => {
    const projectDir = join(makeFixtureRoot(), 'proj')
    mkdirSync(projectDir, { recursive: true })
    writeFile(join(projectDir, '.mcp.json'), JSON.stringify({
      mcpServers: { proj_only: { command: 'x' } },
    }))
    writeFile(claudeJsonPath, JSON.stringify({
      mcpServers: { user_wide: { command: 'y' } },
    }))
    const budget = await estimateContextBudget(projectDir, 1_000_000, new Set(['proj_only']))
    expect(budget.mcpTools.declared).toBe(2)
    expect(budget.mcpTools.used).toBe(1)
    expect(budget.mcpTools.unused).toEqual(['user_wide'])
  })

  it('does nothing when ~/.claude.json is missing', async () => {
    const budget = await estimateContextBudget(undefined, 1_000_000, new Set())
    expect(budget.mcpTools.declared).toBe(0)
  })
})

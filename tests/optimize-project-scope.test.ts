import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scopeTest = vi.hoisted(() => ({
  home: '',
  sources: [] as Array<{ path: string; project: string; provider: string }>,
}))

vi.mock('os', async importOriginal => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, homedir: () => scopeTest.home }
})

vi.mock('../src/providers/index.js', async importOriginal => {
  type ProvidersModule = typeof import('../src/providers/index.js')
  const actual = await importOriginal<ProvidersModule>()
  return {
    ...actual,
    async discoverAllSessions() {
      return scopeTest.sources
    },
  }
})

import { cacheKey, runOptimize, scanAndDetect } from '../src/optimize.js'
import type { AppliedFix } from '../src/act/types.js'
import { statusSnapshotQueryKey } from '../src/status-snapshot-semantic.js'
import type { ProjectSummary, SessionSummary } from '../src/types.js'

const PROJECT_ID = 'path:/work/alpha'

const GLOBAL_MCP_INVENTORY = Array.from({ length: 20 }, (_, index) => `mcp__inventoryOnly__tool-${index}`)

function mcpSession(sessionId: string): SessionSummary {
  return {
    sessionId,
    project: 'alpha',
    firstTimestamp: '2026-09-01T00:00:00.000Z',
    lastTimestamp: '2026-09-01T00:00:00.000Z',
    totalCostUSD: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    apiCalls: 0,
    turns: [],
    modelBreakdown: {},
    toolBreakdown: {},
    mcpBreakdown: {},
    bashBreakdown: {},
    categoryBreakdown: {},
    skillBreakdown: {},
    mcpInventory: GLOBAL_MCP_INVENTORY,
  }
}

function project(cost: number): ProjectSummary {
  return {
    project: 'alpha',
    projectPath: '/work/alpha',
    sessions: [mcpSession('alpha-one'), mcpSession('alpha-two')],
    totalCostUSD: cost,
    totalSavingsUSD: 0,
    totalApiCalls: 3,
    totalProxiedCostUSD: 0,
  }
}

function seedScopeCorpus(): void {
  scopeTest.home = mkdtempSync(join(tmpdir(), 'codeburn-optimize-scope-home-'))
  const source = mkdtempSync(join(tmpdir(), 'codeburn-optimize-scope-source-'))
  mkdirSync(join(scopeTest.home, '.claude', 'skills', 'global-skill'), { recursive: true })
  mkdirSync(join(scopeTest.home, '.claude', 'agents'), { recursive: true })
  mkdirSync(join(scopeTest.home, '.claude', 'commands'), { recursive: true })
  writeFileSync(join(scopeTest.home, '.claude', 'skills', 'global-skill', 'SKILL.md'), '# global skill\n')
  writeFileSync(join(scopeTest.home, '.claude', 'agents', 'global-agent.md'), '# global agent\n')
  writeFileSync(join(scopeTest.home, '.claude', 'commands', 'global-command.md'), '# global command\n')
  const settingsPath = join(scopeTest.home, '.claude', 'settings.json')
  writeFileSync(settingsPath, JSON.stringify({
    mcpServers: { globalUnused: { command: 'node', args: ['server.js'] } },
  }))
  const oldConfigTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  utimesSync(settingsPath, oldConfigTime, oldConfigTime)

  const timestamp = new Date().toISOString()
  const mcpInventory = GLOBAL_MCP_INVENTORY
  const lines = [JSON.stringify({
    type: 'attachment',
    sessionId: 'alpha',
    timestamp,
    cwd: '/work/alpha',
    attachment: { type: 'deferred_tools_delta', addedNames: mcpInventory },
  }), ...Array.from({ length: 3 }, (_, index) => JSON.stringify({
    type: 'assistant',
    timestamp,
    cwd: '/work/alpha',
    message: {
      content: [{
        type: 'tool_use',
        name: 'Read',
        input: { file_path: `/work/alpha/node_modules/file-${index}.js` },
      }],
    },
  }))]
  writeFileSync(join(source, 'alpha.jsonl'), lines.join('\n') + '\n')
  writeFileSync(join(source, 'alpha-two.jsonl'), JSON.stringify({
    type: 'attachment',
    sessionId: 'alpha-two',
    timestamp,
    cwd: '/work/alpha',
    attachment: { type: 'deferred_tools_delta', addedNames: mcpInventory },
  }) + '\n')
  scopeTest.sources = [{ path: source, project: 'alpha', provider: 'claude' }]
}

function optimizeForProject(id: string, cost: number) {
  return scanAndDetect([project(cost)], undefined, 'claude', id)
}

function optimizeForAllProjects(cost: number) {
  return scanAndDetect([project(cost)], undefined, 'claude')
}

function scopedOptimizeKinds(id: string, cost: number): Promise<string[]> {
  return optimizeForProject(id, cost).then(result => result.findings.map(finding => finding.id))
}

function optimizeSnapshotKey(id?: string): string {
  return cacheKey([project(100)], undefined, 'claude', id)
}

function statusQueryKey(id: string): string {
  return statusSnapshotQueryKey({ desktopProjectId: id })
}

describe('Feature: scoped Optimize evidence and snapshot identity', () => {
  beforeEach(() => {
    seedScopeCorpus()
  })

  afterEach(() => {
    if (scopeTest.home) rmSync(scopeTest.home, { recursive: true, force: true })
    scopeTest.home = ''
    scopeTest.sources = []
  })

  it('Scenario: a file finding is emitted only when the file belongs to the selected project', async () => {
    const result = await optimizeForProject(PROJECT_ID, 1)

    expect(result.findings.length).toBeGreaterThan(0)
    expect(result.findings.every(finding => finding.projectId === PROJECT_ID)).toBe(true)
  })

  it('Scenario: global MCP, skill, command, and applied-action findings are omitted while scoped', async () => {
    const kinds = await scopedOptimizeKinds(PROJECT_ID, 2)

    expect(kinds).not.toEqual(expect.arrayContaining([
      'unused-mcp',
      'unused-agents',
      'unused-skills',
      'unused-commands',
      'bash-output-cap',
    ]))
  })

  it('Scenario: unscoped Optimize still includes global MCP and config evidence', async () => {
    const result = await optimizeForAllProjects(2)
    const kinds = result.findings.map(finding => finding.id)

    expect(kinds).toEqual(expect.arrayContaining(['unused-mcp', 'unused-skills', 'unused-agents', 'unused-commands']))
  })

  it('Scenario: applied-action evidence is omitted only for a scoped Optimize run', async () => {
    const applied: AppliedFix = {
      id: 'action-1',
      kind: 'archive-skill',
      findingId: 'unused-skills',
      appliedAt: '2026-09-01T00:00:00.000Z',
      ageDays: 31,
      verdict: 'worked',
      estimatedTokens: 100,
      realizedTokens: 90,
      note: '',
      undoCommand: 'codeburn act undo action-1',
    }
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await runOptimize([project(2)], 'All projects', undefined, {
        format: 'json',
        desktopProjectId: PROJECT_ID,
        appliedFixes: [applied],
      })
      const scoped = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as { appliedFixes?: AppliedFix[] }
      expect(scoped.appliedFixes).toEqual([])

      await runOptimize([project(2)], 'All projects', undefined, { format: 'json', appliedFixes: [applied] })
      const unscoped = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as { appliedFixes?: AppliedFix[] }
      expect(unscoped.appliedFixes).toHaveLength(1)
    } finally {
      log.mockRestore()
    }
  })

  it('Scenario: Optimize snapshots for All projects and one project never collide', () => {
    expect(optimizeSnapshotKey()).not.toBe(optimizeSnapshotKey(PROJECT_ID))
  })

  it('Scenario: status snapshots for two project IDs never reuse each other', () => {
    expect(statusQueryKey('path:/work/alpha')).not.toBe(statusQueryKey('path:/work/beta'))
  })
})

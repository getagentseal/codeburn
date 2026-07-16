import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { journalPath } from '../src/act/journal.js'
import {
  buildActReportJson,
  buildOptimizeAppliedHeader,
  computeActReport,
  renderActReport,
} from '../src/act/report.js'
import type { ActionRecord } from '../src/act/types.js'
import type { ClassifiedTurn, ProjectSummary } from '../src/types.js'

type Session = ProjectSummary['sessions'][number]

const roots: string[] = []
afterAll(async () => { for (const r of roots) await rm(r, { recursive: true, force: true }) })

const NOW = new Date('2026-07-01T00:00:00Z')
function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 86_400_000).toISOString()
}

async function writeJournal(records: unknown[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'codeburn-act-report-'))
  roots.push(root)
  const actionsDir = join(root, 'actions')
  await mkdir(actionsDir, { recursive: true })
  await writeFile(journalPath(actionsDir), records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''))
  return actionsDir
}

function makeSession(id: string, firstTimestamp: string, over: Partial<Session> = {}): Session {
  return {
    sessionId: id,
    project: 'app',
    firstTimestamp,
    lastTimestamp: firstTimestamp,
    totalCostUSD: 1,
    totalSavingsUSD: 0,
    totalInputTokens: 1000,
    totalOutputTokens: 0,
    totalReasoningTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    apiCalls: 1,
    turns: [],
    modelBreakdown: {},
    toolBreakdown: {},
    mcpBreakdown: {},
    bashBreakdown: {},
    categoryBreakdown: {} as Session['categoryBreakdown'],
    skillBreakdown: {},
    subagentBreakdown: {},
    ...over,
  }
}

function projectOf(
  sessions: Session[],
  over: { project?: string; projectPath?: string } = {},
): ProjectSummary {
  return {
    project: over.project ?? 'app',
    projectPath: over.projectPath ?? '/tmp/app',
    sessions,
    totalCostUSD: sessions.reduce((s, x) => s + x.totalCostUSD, 0),
    totalSavingsUSD: 0,
    totalApiCalls: sessions.length,
    totalProxiedCostUSD: 0,
  }
}

function sessionsAt(count: number, ts: string, over: Partial<Session> = {}): Session[] {
  return Array.from({ length: count }, (_, i) => makeSession(`s${i}`, ts, over))
}

function mcpRecord(over: Partial<ActionRecord> = {}): ActionRecord {
  const at = daysAgo(10)
  return {
    id: 'a1',
    at,
    kind: 'mcp-remove',
    findingId: 'unused-mcp',
    description: 'Remove an MCP server from config',
    changes: [],
    status: 'applied',
    baseline: { windowDays: 14, capturedAt: at, estimatedTokens: 56_000, sessions: 28, metrics: { 'brave-search': 2000 } },
    ...over,
  }
}

function modelEditTurns(model: string, editTurns: number, oneShotTurns: number): ClassifiedTurn[] {
  return Array.from({ length: editTurns }, (_, i) => ({
    userMessage: 'edit the code',
    timestamp: daysAgo(5),
    sessionId: `model-${model}-${i}`,
    category: 'coding',
    retries: i < oneShotTurns ? 0 : 1,
    hasEdits: true,
    assistantCalls: [{
      provider: 'claude',
      model,
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        webSearchRequests: 0,
      },
      costUSD: 1,
      tools: ['Edit'],
      mcpTools: [],
      skills: [],
      subagentTypes: [],
      hasAgentSpawn: false,
      hasPlanMode: false,
      speed: 'standard',
      timestamp: daysAgo(5),
      bashCommands: [],
      deduplicationKey: `model-${model}-${i}`,
    }],
  }))
}

function modelProject(
  project: string, projectPath: string, model: string, editTurns: number, oneShotTurns: number,
): ProjectSummary {
  const turns = modelEditTurns(model, editTurns, oneShotTurns)
  const session = makeSession(`model-${project}`, daysAgo(5), {
    project,
    apiCalls: turns.length,
    turns,
  })
  return projectOf([session], { project, projectPath })
}

function modelDefaultRecord(over: Partial<ActionRecord> = {}): ActionRecord {
  const at = daysAgo(10)
  return {
    id: 'md1',
    at,
    kind: 'model-default',
    findingId: 'model-default:app',
    description: 'Set Claude Code default model to candidate-model for app',
    changes: [{
      path: '/tmp/app/.claude/settings.json',
      backup: null,
      op: 'edit',
      afterHash: '',
    }],
    status: 'applied',
    baseline: {
      windowDays: 30,
      capturedAt: at,
      estimatedTokens: 0,
      sessions: 60,
      metrics: { 'candidate-model': 0.9, 'current-model': 0.95 },
    },
    ...over,
  }
}

const load = (projects: ProjectSummary[]) => async () => projects

describe('mcp realized delta', () => {
  it('multiplies baseline tokens-per-session by post-window sessions (exact)', async () => {
    const actionsDir = await writeJournal([mcpRecord()])
    const report = await computeActReport({ actionsDir, now: NOW, loadProjects: load([projectOf(sessionsAt(20, daysAgo(5)))]) })

    expect(report.rows).toHaveLength(1)
    const row = report.rows[0]!
    expect(row.status).toBe('measured')
    expect(row.realizedTokens).toBe(40_000) // 2000 tokens/session * 20 sessions
    expect(row.estimatedAtApply).toBe(56_000)
    expect(row.estimatedForWindow).toBe(40_000) // window-scaled: 2000 * 20
    expect(row.confidence).toBe('normal')
    expect(report.totalRealizedTokens).toBe(40_000)
  })

  it('subtracts keeper sessions that still load the server for project-scope, not a revert', async () => {
    const rec = mcpRecord({ kind: 'mcp-project-scope', findingId: 'mcp-project-scope', description: 'Project-scope an MCP server' })
    const actionsDir = await writeJournal([rec])
    const keepers = sessionsAt(5, daysAgo(4), { mcpInventory: ['mcp__brave-search__search'] })
    const cold = sessionsAt(15, daysAgo(5))
    const report = await computeActReport({ actionsDir, now: NOW, loadProjects: load([projectOf([...cold, ...keepers])]) })

    const row = report.rows[0]!
    expect(row.status).toBe('measured')
    expect(row.realizedTokens).toBe(30_000) // 2000 x (20 - 5 still loading)
    expect(row.estimatedForWindow).toBe(40_000) // 2000 x all 20 window sessions
  })

  it('reports "reverted" with zero savings when the server reappears in the window', async () => {
    const actionsDir = await writeJournal([mcpRecord()])
    const back = sessionsAt(20, daysAgo(5), { mcpInventory: ['mcp__brave-search__search'] })
    const report = await computeActReport({ actionsDir, now: NOW, loadProjects: load([projectOf(back)]) })

    const row = report.rows[0]!
    expect(row.status).toBe('reverted')
    expect(row.realizedTokens).toBe(0)
    expect(row.note).toMatch(/reverted by user/)
    expect(report.totalRealizedTokens).toBe(0)
  })
})

describe('model-default quality tripwire', () => {
  it('fires for a >5pp same-project regression even when another project would mask it globally', async () => {
    const actionsDir = await writeJournal([modelDefaultRecord()])
    const target = modelProject('app', '/tmp/app', 'candidate-model', 20, 10)
    const masking = modelProject('other', '/tmp/other', 'candidate-model', 80, 80)
    const report = await computeActReport({ actionsDir, now: NOW, loadProjects: load([target, masking]) })

    const row = report.rows[0]!
    expect(row.status).toBe('measured')
    // Scope-fix pin: pre-fix global aggregation reports 90.0% instead of 50.0%.
    expect(row.note).toBe('quality regression, consider undo: one-shot rate 90.0% -> 50.0%')
    expect(row.confidence).toBe('low')
  })

  it('reports correlation without a regression and uses the labeled candidate model', async () => {
    const rec = modelDefaultRecord({
      baseline: {
        windowDays: 30,
        capturedAt: daysAgo(10),
        estimatedTokens: 0,
        sessions: 60,
        candidateModel: 'candidate-model',
        metrics: { 'current-model': 0.95, 'candidate-model': 0.75 },
      },
    })
    const actionsDir = await writeJournal([rec])
    const target = modelProject('app', '/tmp/app', 'candidate-model', 20, 16)
    const report = await computeActReport({ actionsDir, now: NOW, loadProjects: load([target]) })

    const row = report.rows[0]!
    expect(row.status).toBe('measured')
    expect(row.confidence).toBe('low')
    expect(row.note).toBe('correlation, not attribution: one-shot rate 75.0% -> 80.0%')
    expect(renderActReport(report)).toMatch(/Set Claude Code default model to candidate-model for app\s+│\s+-\s+│\s+correlation\s+│/)
  })

  it('is not measurable with fewer than 20 candidate edit turns in the target project', async () => {
    const actionsDir = await writeJournal([modelDefaultRecord()])
    const target = modelProject('app', '/tmp/app', 'candidate-model', 19, 19)
    const unrelated = modelProject('other', '/tmp/other', 'candidate-model', 50, 50)
    const report = await computeActReport({ actionsDir, now: NOW, loadProjects: load([target, unrelated]) })

    const row = report.rows[0]!
    expect(row.status).toBe('not-measurable')
    expect(row.note).toBe('not measurable: < 20 edit turns for candidate-model since apply')
  })

  it('reports a missing scoped project separately from insufficient edit turns', async () => {
    const actionsDir = await writeJournal([modelDefaultRecord()])
    const unrelated = modelProject('other', '/tmp/other', 'candidate-model', 50, 50)
    const report = await computeActReport({ actionsDir, now: NOW, loadProjects: load([unrelated]) })

    const row = report.rows[0]!
    expect(row.status).toBe('not-measurable')
    expect(row.note).toBe('not measurable: project not found in current data (path may have changed)')
  })

  it('matches a backslash-separated journal path to a forward-slash project path', async () => {
    const rec = modelDefaultRecord({
      changes: [{
        path: 'C:\\work\\app\\.claude\\settings.json',
        backup: null,
        op: 'edit',
        afterHash: '',
      }],
    })
    const actionsDir = await writeJournal([rec])
    const target = modelProject('app', 'C:/work/app', 'candidate-model', 20, 10)
    const masking = modelProject('other', 'C:/work/other', 'candidate-model', 80, 80)
    const report = await computeActReport({ actionsDir, now: NOW, loadProjects: load([target, masking]) })

    expect(report.rows[0]!.note).toBe('quality regression, consider undo: one-shot rate 90.0% -> 50.0%')
  })
})

describe('confidence markers', () => {
  it('marks low when fewer than 20 post-window sessions', async () => {
    const actionsDir = await writeJournal([mcpRecord()])
    const report = await computeActReport({ actionsDir, now: NOW, loadProjects: load([projectOf(sessionsAt(10, daysAgo(5)))]) })

    const row = report.rows[0]!
    expect(row.status).toBe('measured')
    expect(row.realizedTokens).toBe(20_000) // 2000 * 10
    expect(row.confidence).toBe('low')
  })

  it('marks low when volume shifts more than 2x versus baseline', async () => {
    // 25 post-window sessions (>= 20, so not the count rule) over 10 days is
    // 2.5/day against a 1/day baseline (14 sessions / 14 days) -> 2.5x shift.
    const rec = mcpRecord({ baseline: { windowDays: 14, capturedAt: daysAgo(10), estimatedTokens: 56_000, sessions: 14, metrics: { 'brave-search': 2000 } } })
    const actionsDir = await writeJournal([rec])
    const report = await computeActReport({ actionsDir, now: NOW, loadProjects: load([projectOf(sessionsAt(25, daysAgo(5)))]) })

    const row = report.rows[0]!
    expect(row.status).toBe('measured')
    expect(row.confidence).toBe('low')
  })

  it('stays normal when volume is comparable to baseline', async () => {
    const actionsDir = await writeJournal([mcpRecord()]) // baseline 28/14 = 2/day
    const report = await computeActReport({ actionsDir, now: NOW, loadProjects: load([projectOf(sessionsAt(20, daysAgo(5)))]) }) // 20/10 = 2/day
    expect(report.rows[0]!.confidence).toBe('normal')
  })
})

describe('eligibility', () => {
  it('excludes undone actions and actions younger than 3 days', async () => {
    const records = [
      mcpRecord({ id: 'old', at: daysAgo(10) }),
      mcpRecord({ id: 'young', at: daysAgo(1) }),
      mcpRecord({ id: 'undone', at: daysAgo(20), status: 'undone' }),
    ]
    const actionsDir = await writeJournal(records)
    const report = await computeActReport({ actionsDir, now: NOW, loadProjects: load([projectOf(sessionsAt(20, daysAgo(5)))]) })

    expect(report.rows).toHaveLength(1)
    expect(report.rows[0]!.id).toBe('old')
    expect(report.activeCount).toBe(2) // old + young are applied; undone is not
  })
})

describe('read-edit realized delta', () => {
  it('credits the reduction in the read deficit using the detector estimate math', async () => {
    // Baseline ratio 1:1 (deficit 3 reads/edit). After window: 120 reads / 40
    // edits = 3:1 (deficit 1). Credit (3 - 1) * 40 edits * 600 = 48000.
    const at = daysAgo(10)
    const rec: ActionRecord = {
      id: 'r1', at, kind: 'claude-md-rule', findingId: 'read-edit-ratio',
      description: 'Add the read-edit-ratio rule block', changes: [], status: 'applied',
      baseline: { windowDays: 14, capturedAt: at, estimatedTokens: 12_000, sessions: 28, metrics: { reads: 10, edits: 10 } },
    }
    const actionsDir = await writeJournal([rec])
    const session = makeSession('s0', daysAgo(5), { toolBreakdown: { Read: { calls: 120 }, Edit: { calls: 40 } } })
    const filler = sessionsAt(19, daysAgo(4))
    const report = await computeActReport({ actionsDir, now: NOW, loadProjects: load([projectOf([session, ...filler])]) })

    const row = report.rows[0]!
    expect(row.status).toBe('measured')
    expect(row.realizedTokens).toBe(48_000)
    expect(row.estimatedAtApply).toBe(12_000)
    expect(row.estimatedForWindow).toBe(72_000) // deficitThen 3 x 40 edits x 600, same denominator as realized
    expect(row.realizedTokens).toBeLessThanOrEqual(row.estimatedForWindow)
    expect(row.note).toMatch(/1\.0:1 -> 3\.0:1/)
  })
})

describe('round-down discipline', () => {
  it('floors non-integer mcp products, never rounds up', async () => {
    const rec = mcpRecord({ baseline: { windowDays: 14, capturedAt: daysAgo(10), estimatedTokens: 5000, sessions: 3, metrics: { 'brave-search': 700.7 } } })
    const actionsDir = await writeJournal([rec])
    const report = await computeActReport({ actionsDir, now: NOW, loadProjects: load([projectOf(sessionsAt(3, daysAgo(5)))]) })

    const row = report.rows[0]!
    expect(row.status).toBe('measured')
    expect(row.realizedTokens).toBe(2102) // floor(700.7 x 3 = 2102.1); ceil would be 2103
    expect(row.estimatedForWindow).toBe(2102)
  })

  it('floors non-integer read-edit products, never rounds up', async () => {
    // deficitThen = 4 - 10/7 = 18/7; deficitNow = 4 - 20/10 = 2.
    // realized = floor((18/7 - 2) x 10 x 600) = floor(3428.57...) = 3428.
    // window estimate = floor(18/7 x 10 x 600) = floor(15428.57...) = 15428.
    const at = daysAgo(10)
    const rec: ActionRecord = {
      id: 'rf1', at, kind: 'claude-md-rule', findingId: 'read-edit-ratio',
      description: 'Add the read-edit-ratio rule block', changes: [], status: 'applied',
      baseline: { windowDays: 14, capturedAt: at, estimatedTokens: 9000, sessions: 28, metrics: { reads: 10, edits: 7 } },
    }
    const actionsDir = await writeJournal([rec])
    const session = makeSession('s0', daysAgo(5), { toolBreakdown: { Read: { calls: 20 }, Edit: { calls: 10 } } })
    const report = await computeActReport({ actionsDir, now: NOW, loadProjects: load([projectOf([session])]) })

    const row = report.rows[0]!
    expect(row.status).toBe('measured')
    expect(row.realizedTokens).toBe(3428) // ceil would be 3429
    expect(row.estimatedForWindow).toBe(15_428) // ceil would be 15429
  })
})

describe('archive realized delta', () => {
  it('measures per-item definition tokens times sessions and detects un-archive', async () => {
    const at = daysAgo(10)
    const kept = join(tmpdir(), 'codeburn-act-report-absent-skill-xyz') // absent -> not reverted
    const base = { windowDays: 14, capturedAt: at, estimatedTokens: 160, sessions: 28, metrics: { 'skill-a': 80, 'skill-b': 80 } }
    const rec: ActionRecord = {
      id: 'ar1', at, kind: 'archive-skill', findingId: 'unused-skills',
      description: 'Archive 2 unused skills', status: 'applied',
      changes: [{ path: kept, backup: null, op: 'move', movedTo: kept + '.archived', afterHash: '' }],
      baseline: base,
    }
    const actionsDir = await writeJournal([rec])
    const report = await computeActReport({ actionsDir, now: NOW, loadProjects: load([projectOf(sessionsAt(20, daysAgo(5)))]) })
    expect(report.rows[0]!.status).toBe('measured')
    expect(report.rows[0]!.realizedTokens).toBe(3200) // 160 tokens/session * 20
    // Tautology expected: estimate and realized share the formula when nothing
    // reverted; the measured signal is the session count and the revert check.
    expect(report.rows[0]!.estimatedForWindow).toBe(report.rows[0]!.realizedTokens)

    // Now the original path exists again -> reverted, zero savings.
    const restoredPath = join(actionsDir, 'restored-skill')
    await writeFile(restoredPath, 'x')
    const rec2: ActionRecord = { ...rec, changes: [{ path: restoredPath, backup: null, op: 'move', movedTo: restoredPath + '.archived', afterHash: '' }] }
    const dir2 = await writeJournal([rec2])
    const report2 = await computeActReport({ actionsDir: dir2, now: NOW, loadProjects: load([projectOf(sessionsAt(20, daysAgo(5)))]) })
    expect(report2.rows[0]!.status).toBe('reverted')
    expect(report2.rows[0]!.realizedTokens).toBe(0)
  })
})

describe('unmeasured kinds', () => {
  it('marks bash cap not measurable but keeps the estimate visible', async () => {
    const at = daysAgo(10)
    const rec: ActionRecord = {
      id: 'b1', at, kind: 'shell-config', findingId: 'bash-output-cap',
      description: 'Set the bash output cap', changes: [], status: 'applied',
      baseline: { windowDays: 14, capturedAt: at, estimatedTokens: 3750, sessions: 28, metrics: { calls: 200 } },
    }
    const actionsDir = await writeJournal([rec])
    const report = await computeActReport({ actionsDir, now: NOW, loadProjects: load([projectOf(sessionsAt(20, daysAgo(5)))]) })
    expect(report.rows[0]!.status).toBe('not-measurable')
    expect(report.rows[0]!.estimatedAtApply).toBe(3750)
    expect(report.rows[0]!.estimatedForWindow).toBe(3750) // no window scaling for unmeasured kinds
    expect(report.measuredCount).toBe(0)
  })

  it('marks mcp and archive not measurable when the window has no sessions yet', async () => {
    const at = daysAgo(10)
    const arch: ActionRecord = {
      id: 'z2', at, kind: 'archive-skill', findingId: 'unused-skills',
      description: 'Archive 1 unused skill', changes: [], status: 'applied',
      baseline: { windowDays: 14, capturedAt: at, estimatedTokens: 80, sessions: 28, metrics: { 'skill-a': 80 } },
    }
    const actionsDir = await writeJournal([mcpRecord(), arch])
    const report = await computeActReport({ actionsDir, now: NOW, loadProjects: load([]) })

    expect(report.rows).toHaveLength(2)
    for (const row of report.rows) {
      expect(row.status).toBe('not-measurable')
      expect(row.note).toMatch(/no sessions in the window yet/)
      expect(row.realizedTokens).toBe(0)
    }
    expect(report.measuredCount).toBe(0)
  })
})

describe('journal robustness', () => {
  const missingAt = { id: 'm1', kind: 'mcp-remove', status: 'applied', description: 'missing at', changes: [] }
  const numericAt = { id: 'm2', at: 12345, kind: 'mcp-remove', status: 'applied', description: 'numeric at', changes: [] }

  it('skips malformed records with a note instead of crashing, and drops the optimize header', async () => {
    const actionsDir = await writeJournal([missingAt, numericAt])
    const report = await computeActReport({
      actionsDir, now: NOW,
      loadProjects: async () => { throw new Error('should not scan when no eligible records remain') },
    })

    expect(report.malformedRecords).toBe(2)
    expect(report.rows).toHaveLength(0)
    expect(report.activeCount).toBe(0)
    expect(buildOptimizeAppliedHeader(report)).toBeNull()
    expect(renderActReport(report)).toMatch(/2 malformed records skipped/)
  })

  it('still measures valid records alongside malformed ones', async () => {
    const actionsDir = await writeJournal([missingAt, mcpRecord()])
    const report = await computeActReport({ actionsDir, now: NOW, loadProjects: load([projectOf(sessionsAt(20, daysAgo(5)))]) })

    expect(report.malformedRecords).toBe(1)
    expect(report.rows).toHaveLength(1)
    expect(report.rows[0]!.realizedTokens).toBe(40_000)
    expect(renderActReport(report)).toMatch(/1 malformed record skipped/)
  })
})

describe('optimize header', () => {
  it('appears only when a normal-confidence measured token action exists', async () => {
    const actionsDir = await writeJournal([mcpRecord()])
    const report = await computeActReport({ actionsDir, now: NOW, loadProjects: load([projectOf(sessionsAt(20, daysAgo(5)))]) })
    const header = buildOptimizeAppliedHeader(report)
    expect(header).toMatch(/^Applied fixes: 1 active, realized ~40\.0K tokens.*over 10 days\. Details: codeburn act report$/)
  })

  it('renders no header when every measured row is low confidence (under-claim)', async () => {
    const actionsDir = await writeJournal([mcpRecord()])
    const report = await computeActReport({ actionsDir, now: NOW, loadProjects: load([projectOf(sessionsAt(10, daysAgo(5)))]) })

    expect(report.rows[0]!.status).toBe('measured')
    expect(report.rows[0]!.confidence).toBe('low')
    expect(report.rows[0]!.realizedTokens).toBe(20_000) // still visible in act report
    expect(report.totalRealizedTokens).toBe(20_000)
    expect(buildOptimizeAppliedHeader(report)).toBeNull()
  })

  it('sums only normal-confidence rows into the header total', async () => {
    // r1: baseline 28/14d = 2/day vs post 20/10d = 2/day -> normal.
    // r2: baseline 100/14d = 7.1/day vs 2/day -> >2x shift -> low.
    const r1 = mcpRecord({ id: 'n1' })
    const r2 = mcpRecord({
      id: 'l1',
      baseline: { windowDays: 14, capturedAt: daysAgo(10), estimatedTokens: 56_000, sessions: 100, metrics: { 'other-server': 2000 } },
    })
    const actionsDir = await writeJournal([r1, r2])
    const report = await computeActReport({ actionsDir, now: NOW, loadProjects: load([projectOf(sessionsAt(20, daysAgo(5)))]) })

    expect(report.totalRealizedTokens).toBe(80_000) // both stay visible in act report
    const header = buildOptimizeAppliedHeader(report)
    expect(header).toMatch(/^Applied fixes: 2 active, realized ~40\.0K tokens/)
  })

  it('returns null and never scans when the journal has no eligible actions', async () => {
    const emptyDir = await writeJournal([])
    const report = await computeActReport({
      actionsDir: emptyDir, now: NOW,
      loadProjects: async () => { throw new Error('should not scan for an empty journal') },
    })
    expect(report.rows).toHaveLength(0)
    expect(report.activeCount).toBe(0)
    expect(buildOptimizeAppliedHeader(report)).toBeNull()
  })

  it('records the earliest apply date per finding for re-flagging', async () => {
    const records = [
      mcpRecord({ id: 'x1', at: daysAgo(9), findingId: 'unused-mcp' }),
      mcpRecord({ id: 'x2', at: daysAgo(4), findingId: 'unused-mcp' }),
    ]
    const actionsDir = await writeJournal(records)
    const report = await computeActReport({ actionsDir, now: NOW, loadProjects: load([projectOf(sessionsAt(20, daysAgo(3)))]) })
    expect(report.appliedByFinding['unused-mcp']).toBe(daysAgo(9).slice(0, 10))
  })
})

describe('json + render shape', () => {
  it('mirrors the rows and totals in --json', async () => {
    const actionsDir = await writeJournal([mcpRecord()])
    const report = await computeActReport({ actionsDir, now: NOW, loadProjects: load([projectOf(sessionsAt(20, daysAgo(5)))]) })
    const json = buildActReportJson(report) as {
      actions: Array<Record<string, unknown>>
      totals: Record<string, unknown>
      footer: string
      windowCapDays: number
    }

    expect(Array.isArray(json.actions)).toBe(true)
    expect(json.actions[0]).toMatchObject({
      kind: 'mcp-remove',
      estimatedAtApply: 56_000,
      estimatedForWindow: 40_000,
      realizedTokens: 40_000,
      status: 'measured',
      confidence: 'normal',
    })
    expect(json.totals).toMatchObject({ realizedTokens: 40_000, measuredActions: 1, activeActions: 1 })
    expect(json.windowCapDays).toBe(30)
    expect((json as { malformedRecords?: number }).malformedRecords).toBe(0)
    expect(typeof json.footer).toBe('string')
    expect(json.footer).toMatch(/correlation/)
  })

  it('renders an empty state without a table when nothing is measurable', async () => {
    const emptyDir = await writeJournal([])
    const report = await computeActReport({ actionsDir: emptyDir, now: NOW, loadProjects: async () => [] })
    const out = renderActReport(report)
    expect(out).toMatch(/No applied actions to measure yet/)
    expect(out).not.toMatch(/Total realized/)
  })

  it('renders a table with a total row when measurements exist', async () => {
    const actionsDir = await writeJournal([mcpRecord()])
    const report = await computeActReport({ actionsDir, now: NOW, loadProjects: load([projectOf(sessionsAt(20, daysAgo(5)))]) })
    const out = renderActReport(report)
    expect(out).toMatch(/Total realized/)
    expect(out).toMatch(/40\.0K/)
    expect(out).toMatch(/measures only its own metric/)
    expect(out).toMatch(/scaled to the measured window/)
  })
})

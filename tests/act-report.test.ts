import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { journalPath } from '../src/act/journal.js'
import {
  autoRevertNoEffect,
  buildActReportJson,
  buildOptimizeAppliedHeader,
  captureBaseline,
  captureBaselinesForPlans,
  computeActReport,
  renderActReport,
} from '../src/act/report.js'
import { formatAppliedFix, REPORT_MIN_AGE_DAYS } from '../src/act/types.js'
import type { ActionRecord } from '../src/act/types.js'
import type { FindingPlan } from '../src/act/plans.js'
import { aggregateMcpCoverage, detectMcpProfileAdvisor, detectMcpToolCoverage, type WasteFinding } from '../src/optimize.js'
import type { ClassifiedTurn, ProjectSummary } from '../src/types.js'
import { getModelCosts } from '../src/models.js'

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

// One call that writes the prompt cache, one that reads it.
function cachedTurns(): ClassifiedTurn[] {
  return modelEditTurns('claude-opus-4-6', 2, 2).map((turn, i) => ({
    ...turn,
    assistantCalls: turn.assistantCalls.map(call => ({
      ...call,
      usage: { ...call.usage, cacheCreationInputTokens: i === 0 ? 50_000 : 0, cacheReadInputTokens: i === 0 ? 0 : 50_000 },
    })),
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

describe('realized dollars', () => {
  const onModel = (model: string) => sessionsAt(20, daysAgo(5)).map(s => ({ ...s, turns: modelEditTurns(model, 1, 1) }))
  const OPUS = 'claude-opus-4-6'

  it('prices realized tokens at the session model rate of the token kind the finding priced', async () => {
    const opus = getModelCosts(OPUS)
    expect(opus).not.toBeNull()
    const projects = load([projectOf(onModel(OPUS))])
    for (const findingId of ['mcp-low-coverage', 'mcp-project-scope', 'unused-mcp']) {
      const kind = findingId === 'mcp-project-scope' ? 'mcp-project-scope' : 'mcp-remove'
      const actionsDir = await writeJournal([mcpRecord({ kind, findingId })])
      const report = await computeActReport({ actionsDir, now: NOW, loadProjects: projects })
      expect(report.rows[0]!.realizedTokens).toBe(40_000)
      expect(report.rows[0]!.estimatedAtApply).toBe(56_000)
      expect(report.rows[0]!.realizedCostUSD).toBeCloseTo(40_000 * opus!.inputCostPerToken, 10)
      expect(report.rows[0]!.realizedCostUSD).not.toBeCloseTo(40_000 * report.costRate, 6)
      const json = buildActReportJson(report) as { totals: { realizedCostUSD: number } }
      expect(json.totals.realizedCostUSD).toBeCloseTo(report.rows[0]!.realizedCostUSD, 10)
    }
  })

  it('keeps the blended rate for an unpriced model and for findings still on the blended rate', async () => {
    const unpriced = await writeJournal([mcpRecord({ findingId: 'mcp-low-coverage' })])
    const report = await computeActReport({ actionsDir: unpriced, now: NOW, loadProjects: load([projectOf(onModel('unpriced-test-model'))]) })
    expect(report.costRate).toBeGreaterThan(0)
    expect(report.rows[0]!.realizedTokens).toBe(40_000)
    expect(report.rows[0]!.estimatedAtApply).toBe(56_000)
    expect(report.rows[0]!.realizedCostUSD).toBeCloseTo(40_000 * report.costRate, 10)
    expect(report.totalRealizedCostUSD).toBeCloseTo(40_000 * report.costRate, 10)

    const archived = await writeJournal([mcpRecord({ findingId: 'unused-skills', kind: 'archive-skill' })])
    const onOpus = await computeActReport({ actionsDir: archived, now: NOW, loadProjects: load([projectOf(onModel(OPUS))]) })
    expect(onOpus.rows[0]!.status).toBe('measured')
    expect(onOpus.rows[0]!.realizedCostUSD).toBeCloseTo(onOpus.rows[0]!.realizedTokens * onOpus.costRate, 10)
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

// ---------------------------------------------------------------------------
// defer-* realized deltas (part 2 of #614)
// ---------------------------------------------------------------------------

function deferRecord(over: Partial<ActionRecord> = {}): ActionRecord {
  const at = daysAgo(10)
  return {
    id: 'd1',
    at,
    kind: 'defer-enable',
    findingId: 'mcp-deferral-off',
    description: 'Remove the ENABLE_TOOL_SEARCH=false override from settings.json',
    changes: [],
    status: 'applied',
    // 2 servers x 2000 tokens/session = 4000 prefix tokens/session.
    baseline: { windowDays: 14, capturedAt: at, estimatedTokens: 40_000, sessions: 5, metrics: { everything: 2000, 'fs-tools': 2000 } },
    ...over,
  }
}

// NOTE: an mcpInventory on a post-apply session means the OPPOSITE for defer-*
// vs mcp-remove. For mcp-remove it is "the server loaded again" (reverted);
// for defer-* it is "deferral became active" (saved). Same fixture, inverse
// meaning — exactly the design.
const DEFERRED = { mcpInventory: ['mcp__everything__get-sum'] }

describe('defer realized delta', () => {
  it('measures savings across post-apply sessions where deferral became active', async () => {
    const actionsDir = await writeJournal([deferRecord()])
    const report = await computeActReport({ actionsDir, now: NOW, loadProjects: load([projectOf(sessionsAt(5, daysAgo(5), DEFERRED))]) })

    const row = report.rows[0]!
    expect(row.status).toBe('measured')
    expect(row.realizedTokens).toBe(20_000) // 4000/session * 5 deferred sessions
    expect(row.estimatedForWindow).toBe(20_000)
    expect(report.totalRealizedTokens).toBe(20_000)
  })

  it('reports "not yet in effect" with zero savings when no post-apply session shows deferral', async () => {
    const actionsDir = await writeJournal([deferRecord()])
    // sessions with MCP activity but NO inventory = deferral still off
    const off = sessionsAt(4, daysAgo(5), { mcpBreakdown: { everything: { calls: 2, savingsUSD: 0, costUSD: 0 } } })
    const report = await computeActReport({ actionsDir, now: NOW, loadProjects: load([projectOf(off)]) })

    const row = report.rows[0]!
    expect(row.status).toBe('pending')
    expect(row.realizedTokens ?? 0).toBe(0)
    expect(row.note).toMatch(/not yet in effect/)
    expect(report.totalRealizedTokens).toBe(0)
  })

  it('counts only the sessions where deferral actually became active (partial)', async () => {
    const actionsDir = await writeJournal([deferRecord()])
    const active = sessionsAt(3, daysAgo(5), DEFERRED)
    const stillOff = sessionsAt(2, daysAgo(4))
    const report = await computeActReport({ actionsDir, now: NOW, loadProjects: load([projectOf([...active, ...stillOff])]) })

    const row = report.rows[0]!
    expect(row.status).toBe('measured')
    expect(row.realizedTokens).toBe(12_000) // 4000 * 3 active (2 still-off excluded)
    expect(row.estimatedForWindow).toBe(20_000) // 4000 * all 5 window sessions
  })

  it('is not measurable when no post-apply sessions exist yet', async () => {
    const actionsDir = await writeJournal([deferRecord()])
    const report = await computeActReport({ actionsDir, now: NOW, loadProjects: load([projectOf([])]) })
    expect(report.rows[0]!.note).toMatch(/no sessions in the window yet/)
  })

  it('is not measurable with an empty baseline (zero prefix tokens)', async () => {
    const rec = deferRecord({ baseline: { windowDays: 14, capturedAt: daysAgo(10), estimatedTokens: 0, sessions: 5, metrics: { everything: 0 } } })
    const actionsDir = await writeJournal([rec])
    const report = await computeActReport({ actionsDir, now: NOW, loadProjects: load([projectOf(sessionsAt(5, daysAgo(5), DEFERRED))]) })
    expect(report.rows[0]!.note).toMatch(/empty baseline/)
  })

  it('falls back to the no-baseline note for records applied before baselines existed', async () => {
    const rec = deferRecord({ baseline: undefined })
    const actionsDir = await writeJournal([rec])
    const report = await computeActReport({ actionsDir, now: NOW, loadProjects: load([projectOf(sessionsAt(5, daysAgo(5), DEFERRED))]) })
    expect(report.rows[0]!.note).toMatch(/no baseline captured at apply time/)
  })

  it('measures defer-alwaysload against its named servers', async () => {
    const rec = deferRecord({
      kind: 'defer-alwaysload',
      findingId: 'mcp-alwaysload-hygiene',
      description: 'Unpin an alwaysLoad MCP server',
      baseline: { windowDays: 14, capturedAt: daysAgo(10), estimatedTokens: 30_000, sessions: 6, metrics: { 'heavy-server': 5000 } },
    })
    const actionsDir = await writeJournal([rec])
    const report = await computeActReport({ actionsDir, now: NOW, loadProjects: load([projectOf(sessionsAt(6, daysAgo(5), DEFERRED))]) })
    const row = report.rows[0]!
    expect(row.status).toBe('measured')
    expect(row.realizedTokens).toBe(30_000) // 5000 * 6
  })

  it('measures defer-threshold like the other defer kinds', async () => {
    const rec = deferRecord({ kind: 'defer-threshold', findingId: 'mcp-defer-threshold', description: 'Tighten the auto threshold' })
    const actionsDir = await writeJournal([rec])
    const report = await computeActReport({ actionsDir, now: NOW, loadProjects: load([projectOf(sessionsAt(5, daysAgo(5), DEFERRED))]) })
    expect(report.rows[0]!.status).toBe('measured')
    expect(report.rows[0]!.realizedTokens).toBe(20_000)
  })

  it('excludes servers an mcp-remove row already claims, so the two rows never double count', async () => {
    const actionsDir = await writeJournal([
      mcpRecord({ baseline: { windowDays: 14, capturedAt: daysAgo(10), estimatedTokens: 10_000, sessions: 5, metrics: { everything: 2000 } } }),
      deferRecord(),
    ])
    const report = await computeActReport({ actionsDir, now: NOW, loadProjects: load([projectOf(sessionsAt(5, daysAgo(5), { mcpInventory: ['mcp__fs-tools__ls'] }))]) })

    const mcpRow = report.rows.find(r => r.kind === 'mcp-remove')!
    const deferRow = report.rows.find(r => r.kind === 'defer-enable')!
    expect(mcpRow.status).toBe('measured')
    expect(mcpRow.realizedTokens).toBe(10_000) // 2000 x 5 saved sessions
    expect(deferRow.status).toBe('measured')
    expect(deferRow.realizedTokens).toBe(10_000) // 'fs-tools' only; 'everything' is claimed by the mcp row
    expect(report.totalRealizedTokens).toBe(20_000) // disjoint sum; without dedup it would be 30_000
  })

  it('is not measurable when every deferred server is already claimed by an MCP row', async () => {
    const actionsDir = await writeJournal([
      mcpRecord({ baseline: { windowDays: 14, capturedAt: daysAgo(10), estimatedTokens: 20_000, sessions: 5, metrics: { everything: 2000, 'fs-tools': 2000 } } }),
      deferRecord(),
    ])
    const report = await computeActReport({ actionsDir, now: NOW, loadProjects: load([projectOf(sessionsAt(5, daysAgo(5)))]) })

    const deferRow = report.rows.find(r => r.kind === 'defer-enable')!
    expect(deferRow.status).toBe('not-measurable')
    expect(deferRow.realizedTokens ?? 0).toBe(0)
    expect(deferRow.note).toMatch(/already measured by an MCP remove\/scope row/)
  })

  it('surfaces the pending status to --json consumers instead of asserting a revert', async () => {
    const actionsDir = await writeJournal([deferRecord()])
    const off = sessionsAt(4, daysAgo(5), { mcpBreakdown: { everything: { calls: 2, savingsUSD: 0, costUSD: 0 } } })
    const json = buildActReportJson(await computeActReport({ actionsDir, now: NOW, loadProjects: load([projectOf(off)]) })) as { actions: Array<{ status: string; realizedTokens: number | null; note: string }> }
    expect(json.actions[0]!.status).toBe('pending')
    expect(json.actions[0]!.realizedTokens).toBeNull()
    expect(json.actions[0]!.note).toMatch(/not yet in effect/)
  })
})

describe('defer baseline capture', () => {
  const finding = (apply: WasteFinding['apply']): WasteFinding => ({
    id: 'mcp-deferral-off',
    title: 't', explanation: 'e', impact: 'medium', tokensSaved: 40_000,
    fix: { type: 'command', label: 'l', text: 'x' },
    apply,
  })
  const ctx = (projects: ProjectSummary[]) => ({ projects, coverage: [], windowDays: 14, now: NOW })

  it('derives servers from observed MCP usage for defer-enable', () => {
    const projects = [projectOf(sessionsAt(3, daysAgo(5), { mcpBreakdown: { everything: { calls: 2, savingsUSD: 0, costUSD: 0 }, 'fs-tools': { calls: 1, savingsUSD: 0, costUSD: 0 } } }))]
    const b = captureBaseline(finding({ kind: 'defer-enable', cause: 'env-false', settingPath: '/x', settingScope: 'project settings', value: 'false' }), 'defer-enable', ctx(projects))
    expect(b).toBeDefined()
    // no coverage -> 5 tools x 400 fallback per server
    expect(b!.metrics.everything).toBe(2000)
    expect(b!.metrics['fs-tools']).toBe(2000)
  })

  it('uses the named servers for defer-alwaysload', () => {
    const projects = [projectOf(sessionsAt(2, daysAgo(5)))]
    const b = captureBaseline(finding({ kind: 'defer-alwaysload', servers: [{ server: 'pinned', paths: ['/a/.mcp.json'] }] }), 'defer-alwaysload', ctx(projects))
    expect(b).toBeDefined()
    expect(Object.keys(b!.metrics)).toEqual(['pinned'])
  })

  it('returns undefined when there is no observed MCP surface to defer', () => {
    const projects = [projectOf(sessionsAt(3, daysAgo(5)))] // no mcpBreakdown, no inventory
    const b = captureBaseline(finding({ kind: 'defer-enable', cause: 'env-false', settingPath: '/x', settingScope: 'project settings', value: 'false' }), 'defer-enable', ctx(projects))
    expect(b).toBeUndefined()
  })
})

describe('partial-action baseline capture', () => {
  it('persists the savings attributable to the local mutation, not the full mixed finding', () => {
    const finding: WasteFinding = {
      id: 'mcp-low-coverage',
      title: '2 MCP servers with low tool coverage',
      explanation: '',
      impact: 'medium',
      tokensSaved: 40_000,
      applyTokensSaved: 20_000,
      fix: { type: 'command', label: '', text: "claude mcp remove 'filesystem'" },
      apply: { kind: 'mcp-remove', servers: ['filesystem'] },
    }
    const sessions = sessionsAt(2, daysAgo(1), {
      mcpInventory: Array.from({ length: 20 }, (_, i) => `mcp__filesystem__t${i}`),
      turns: cachedTurns(),
    })

    const baseline = captureBaseline(finding, 'mcp-remove', {
      projects: [projectOf(sessions)],
      coverage: [{
        server: 'filesystem',
        toolsAvailable: 20,
        toolsInvoked: 3,
        unusedTools: Array.from({ length: 17 }, (_, i) => `mcp__filesystem__t${i}`),
        invocations: 0,
        loadedSessions: 2,
        coverageRatio: 3 / 20,
      }],
      windowDays: 14,
      now: NOW,
    })

    expect(baseline).toMatchObject({
      estimatedTokens: 20_000,
      sessions: 2,
      metrics: { filesystem: 206.55 },
    })
    expect(finding.tokensSaved).toBe(40_000)
  })

  it('prices and measures only servers owned by the concrete mutation plan', () => {
    const finding: WasteFinding = {
      id: 'mcp-low-coverage',
      title: '2 MCP servers with low tool coverage',
      explanation: '',
      impact: 'medium',
      tokensSaved: 30_000,
      applyTokensSaved: 30_000,
      applyTokensSavedByServer: { filesystem: 10_000, managed: 20_000 },
      fix: { type: 'command', label: '', text: '' },
      apply: { kind: 'mcp-remove', servers: ['filesystem', 'managed'] },
    }
    const sessions = sessionsAt(2, daysAgo(1), {
      mcpInventory: [
        ...Array.from({ length: 17 }, (_, i) => `mcp__filesystem__t${i}`),
        ...Array.from({ length: 12 }, (_, i) => `mcp__managed__t${i}`),
      ],
      turns: cachedTurns(),
    })
    const coverage = [
      {
        server: 'filesystem', toolsAvailable: 20, toolsInvoked: 3,
        unusedTools: Array.from({ length: 17 }, (_, i) => `mcp__filesystem__t${i}`),
        invocations: 3, loadedSessions: 2, coverageRatio: 3 / 20,
      },
      {
        server: 'managed', toolsAvailable: 20, toolsInvoked: 8,
        unusedTools: Array.from({ length: 12 }, (_, i) => `mcp__managed__t${i}`),
        invocations: 8, loadedSessions: 2, coverageRatio: 8 / 20,
      },
    ]

    const baseline = captureBaseline(finding, 'mcp-remove', {
      projects: [projectOf(sessions)], coverage, windowDays: 14, now: NOW,
    }, ['filesystem'])

    expect(baseline).toMatchObject({
      estimatedTokens: 10_000,
      sessions: 2,
      metrics: { filesystem: 206.55 },
    })
    expect(baseline!.metrics).not.toHaveProperty('managed')
  })

  it('does not invent a low-coverage schema baseline when coverage is unavailable', () => {
    const finding: WasteFinding = {
      id: 'mcp-low-coverage',
      title: '1 MCP server with low tool coverage',
      explanation: '',
      impact: 'medium',
      tokensSaved: 10_000,
      applyTokensSavedByServer: { filesystem: 10_000 },
      fix: { type: 'command', label: '', text: '' },
      apply: { kind: 'mcp-remove', servers: ['filesystem'] },
    }

    const baseline = captureBaseline(finding, 'mcp-remove', {
      projects: [projectOf(sessionsAt(2, daysAgo(1)))],
      coverage: [],
      windowDays: 14,
      now: NOW,
    }, ['filesystem'])

    expect(baseline).toMatchObject({
      estimatedTokens: 10_000,
      metrics: { filesystem: 0 },
    })
  })

  it('stamps a narrowed plan with only its concrete server baseline', async () => {
    const finding: WasteFinding = {
      id: 'mcp-low-coverage', title: '2 MCP servers', explanation: '', impact: 'medium',
      tokensSaved: 30_000, applyTokensSaved: 30_000,
      applyTokensSavedByServer: { filesystem: 10_000, managed: 20_000 },
      fix: { type: 'command', label: '', text: '' },
      apply: { kind: 'mcp-remove', servers: ['filesystem', 'managed'] },
    }
    const plan: FindingPlan = {
      finding,
      notes: [],
      plan: {
        kind: 'mcp-remove', description: 'Remove filesystem', changes: [],
        affectedMcpServers: ['filesystem'],
      },
    }
    const sessions = sessionsAt(2, daysAgo(1), {
      mcpInventory: [
        ...Array.from({ length: 17 }, (_, i) => `mcp__filesystem__t${i}`),
        ...Array.from({ length: 12 }, (_, i) => `mcp__managed__t${i}`),
      ],
      turns: cachedTurns(),
    })

    await captureBaselinesForPlans([plan], {
      now: NOW,
      loadProjects: async () => [projectOf(sessions)],
    })

    expect(plan.plan?.baseline).toMatchObject({
      estimatedTokens: 10_000,
      metrics: { filesystem: 206.55 },
    })
    expect(plan.plan?.baseline?.metrics).not.toHaveProperty('managed')
  })

  it('stores the per-session schema tokens the mcp-low-coverage finding charges', () => {
    const sessions = sessionsAt(4, daysAgo(1), {
      mcpInventory: Array.from({ length: 20 }, (_, i) => `mcp__filesystem__t${i}`),
      turns: cachedTurns(),
    })
    const projects = [projectOf(sessions)]
    const coverage = aggregateMcpCoverage(projects)
    const finding = detectMcpToolCoverage(projects, coverage, new Set(['filesystem']))!
    expect(finding.id).toBe('mcp-low-coverage')

    const baseline = captureBaseline(finding, 'mcp-remove', { projects, coverage, windowDays: 14, now: NOW })
    // 20 deferred name lines at 9 tokens, one write (x1.25) and one read (x0.1)
    // per session: 243 per session, where the old 400-per-tool figure was 8,000.
    expect(baseline!.metrics.filesystem).toBeCloseTo(243, 10)
    expect(baseline!.metrics.filesystem! * sessions.length).toBeCloseTo(finding.tokensSaved, 0)
  })

  it('stores the per-session cold schema tokens the mcp-project-scope finding charges', () => {
    const inventory = Array.from({ length: 4 }, (_, i) => `mcp__github__t${i}`)
    const cold = (name: string) => projectOf(
      sessionsAt(2, daysAgo(1), { mcpInventory: inventory, turns: cachedTurns() }).map(s => ({ ...s, sessionId: `${name}-${s.sessionId}` })),
      { project: name, projectPath: `/tmp/${name}` },
    )
    const hot = projectOf(
      [makeSession('api-s0', daysAgo(1), { mcpInventory: inventory, mcpBreakdown: { github: { calls: 2 } }, turns: cachedTurns() })],
      { project: 'api', projectPath: '/tmp/api' },
    )
    const projects = [hot, cold('web'), cold('docs')]
    const coverage = aggregateMcpCoverage(projects)
    const finding = detectMcpProfileAdvisor(projects, coverage)!
    expect(finding.id).toBe('mcp-project-scope')

    const baseline = captureBaseline(finding, 'mcp-project-scope', { projects, coverage, windowDays: 14, now: NOW })
    // 4 name lines at 9 tokens, one write (x1.25) and one read (x0.1) per
    // cold session: 48.6 per session, where the old 400-per-tool figure was 1,600.
    expect(baseline!.metrics.github).toBeCloseTo(48.6, 10)
    expect(baseline!.metrics.github! * 4).toBeCloseTo(finding.tokensSaved, 0)
  })

  it('does not stamp a numeric baseline onto an uncertain partial mutation', async () => {
    const finding: WasteFinding = {
      id: 'mcp-low-coverage', title: '1 MCP server', explanation: '', impact: 'medium',
      tokensSaved: 10_000, applyTokensSavedByServer: { filesystem: 10_000 },
      fix: { type: 'command', label: '', text: '' },
      apply: { kind: 'mcp-remove', servers: ['filesystem'] },
    }
    const plan: FindingPlan = {
      finding,
      notes: ['could not parse .mcp.json'],
      plan: {
        kind: 'mcp-remove', description: 'Remove filesystem', changes: [],
        affectedMcpServers: ['filesystem'], mcpSavingsUncertain: true,
      },
    }

    await captureBaselinesForPlans([plan], {
      now: NOW,
      loadProjects: async () => [projectOf(sessionsAt(2, daysAgo(1)))],
    })

    expect(plan.plan?.baseline).toBeUndefined()
  })
})

describe('applied-fix verdicts', () => {
  const fixOf = async (records: ActionRecord[], projects: ProjectSummary[]) => {
    const actionsDir = await writeJournal(records)
    const report = await computeActReport({ actionsDir, now: NOW, loadProjects: load(projects) })
    return { report, fixes: report.appliedFixes, actionsDir }
  }

  it('calls a fix that realized its whole window estimate "worked"', async () => {
    const { fixes } = await fixOf([mcpRecord()], [projectOf(sessionsAt(20, daysAgo(5)))])
    expect(fixes).toHaveLength(1)
    expect(fixes[0]!.verdict).toBe('worked')
    expect(fixes[0]!.estimatedTokens).toBe(40_000)
    expect(fixes[0]!.realizedTokens).toBe(40_000)
    expect(fixes[0]!.undoCommand).toBe('codeburn act undo a1')
  })

  it('holds the worked/partial boundary at the 70% ratio', async () => {
    const rec = mcpRecord({ kind: 'mcp-project-scope' })
    // 14 of 20 sessions saved = exactly 70% of the window estimate.
    const at70 = await fixOf(
      [rec],
      [projectOf([...sessionsAt(14, daysAgo(5)), ...sessionsAt(6, daysAgo(4), { mcpInventory: ['mcp__brave-search__search'] })])],
    )
    expect(at70.fixes[0]!.verdict).toBe('worked')

    const below = await fixOf(
      [rec],
      [projectOf([...sessionsAt(13, daysAgo(5)), ...sessionsAt(7, daysAgo(4), { mcpInventory: ['mcp__brave-search__search'] })])],
    )
    expect(below.fixes[0]!.verdict).toBe('partial')
    expect(formatAppliedFix(below.fixes[0]!)).toContain('-35% vs estimate')
  })

  it('calls a fix that realized nothing "no-effect" and offers the undo', async () => {
    const rec = mcpRecord({ kind: 'mcp-project-scope' })
    const stillLoading = sessionsAt(20, daysAgo(5), { mcpInventory: ['mcp__brave-search__search'] })
    const { fixes } = await fixOf([rec], [projectOf(stillLoading)])
    expect(fixes[0]!.verdict).toBe('no-effect')
    expect(fixes[0]!.realizedTokens).toBe(0)
    expect(formatAppliedFix(fixes[0]!)).toContain('did not help. Revert: codeburn act undo a1')
  })

  it('treats an estimate of zero as worked only when something was realized', async () => {
    const zeroEstimate = { windowDays: 14, capturedAt: daysAgo(10), estimatedTokens: 0, sessions: 0, metrics: {} }
    const { fixes } = await fixOf(
      [mcpRecord({ baseline: { ...zeroEstimate, metrics: { 'brave-search': 2000 } } })],
      [projectOf(sessionsAt(20, daysAgo(5)))],
    )
    expect(fixes[0]!.estimatedTokens).toBe(40_000)
    expect(fixes[0]!.verdict).toBe('worked')
  })

  it('leaves entries younger than the measurement window pending', async () => {
    const { fixes } = await fixOf([mcpRecord({ at: daysAgo(1) })], [projectOf(sessionsAt(20, daysAgo(1)))])
    expect(fixes[0]!.verdict).toBe('pending')
    expect(formatAppliedFix(fixes[0]!)).toBe(`unused-mcp (1d ago): measuring, check back after ${REPORT_MIN_AGE_DAYS} days`)
  })

  it('keeps a user-reverted entry out of the verdicts and carries its note', async () => {
    const back = sessionsAt(20, daysAgo(5), { mcpInventory: ['mcp__brave-search__search'] })
    const { fixes } = await fixOf([mcpRecord()], [projectOf(back)])
    expect(fixes[0]!.verdict).toBe('pending')
    expect(fixes[0]!.note).toMatch(/reverted by user/)
  })

  it('drops undone journal entries entirely', async () => {
    const rec = mcpRecord()
    const { fixes } = await fixOf(
      [rec, { ...rec, status: 'undone', undoneAt: daysAgo(2) }],
      [projectOf(sessionsAt(20, daysAgo(5)))],
    )
    expect(fixes).toHaveLength(0)
  })

  it('never judges a correlation-only kind, so --auto-revert can never touch it', async () => {
    const { fixes } = await fixOf([modelDefaultRecord()], [modelProject('app', '/tmp/app', 'candidate-model', 20, 19)])
    expect(fixes[0]!.verdict).toBe('pending')
  })
})

describe('autoRevertNoEffect', () => {
  const noEffect = (over: Partial<ActionRecord> = {}) => ({
    ...mcpRecord({ kind: 'mcp-project-scope', ...over }),
  })

  it('undoes the no-effect entries and leaves the rest alone', async () => {
    const worked = noEffect({ id: 'keep1', findingId: 'kept' })
    const actionsDir = await writeJournal([noEffect(), worked])
    const stillLoading = sessionsAt(20, daysAgo(5), { mcpInventory: ['mcp__brave-search__search'] })
    const report = await computeActReport({ actionsDir, now: NOW, loadProjects: load([projectOf(stillLoading)]) })
    // Both are no-effect here; pin that only the ones we hand over get undone.
    const target = report.appliedFixes.filter(f => f.id === 'a1')
    const { lines, revertedIds } = await autoRevertNoEffect(target, { actionsDir })

    expect([...revertedIds]).toEqual(['a1'])
    expect(lines).toEqual(['Reverted a1: Remove an MCP server from config'])
    const after = await computeActReport({ actionsDir, now: NOW, loadProjects: load([projectOf(stillLoading)]) })
    expect(after.appliedFixes.map(f => f.id)).toEqual(['keep1'])
  })

  it('never auto-reverts a CLAUDE.md rule, it prints the undo command instead', async () => {
    const rec = mcpRecord({
      id: 'cm1',
      kind: 'claude-md-rule',
      findingId: 'read-edit-ratio',
      baseline: { windowDays: 14, capturedAt: daysAgo(10), estimatedTokens: 10_000, sessions: 20, metrics: { reads: 10, edits: 10 } },
    })
    const actionsDir = await writeJournal([rec])
    const sessions = sessionsAt(20, daysAgo(5), { toolBreakdown: { Edit: { calls: 10, tokens: 0 }, Read: { calls: 10, tokens: 0 } } as never })
    const report = await computeActReport({ actionsDir, now: NOW, loadProjects: load([projectOf(sessions)]) })

    expect(report.appliedFixes[0]!.verdict).toBe('no-effect')
    const { lines, revertedIds } = await autoRevertNoEffect(report.appliedFixes, { actionsDir })
    expect(revertedIds.size).toBe(0)
    expect(lines).toEqual(['Not auto-reverted: read-edit-ratio edits a CLAUDE.md. Revert: codeburn act undo cm1'])
  })

  it('ignores partial and pending entries', async () => {
    const actionsDir = await writeJournal([mcpRecord({ at: daysAgo(1) })])
    const report = await computeActReport({ actionsDir, now: NOW, loadProjects: load([projectOf(sessionsAt(20, daysAgo(1)))]) })
    const { lines, revertedIds } = await autoRevertNoEffect(report.appliedFixes, { actionsDir })
    expect(lines).toEqual([])
    expect(revertedIds.size).toBe(0)
  })
})

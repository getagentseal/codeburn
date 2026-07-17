import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { runAction } from '../src/act/apply.js'
import { undoAction } from '../src/act/undo.js'
import { buildApplyModelDefaultPlan, recommendModelDefault } from '../src/act/model-defaults.js'
import type { ClassifiedTurn, ProjectSummary, SessionSummary, TaskCategory } from '../src/types.js'

const NOW = new Date('2026-07-04T12:00:00.000Z')
const RECENT = '2026-07-03T12:00:00.000Z'
const OLD = '2026-06-18T12:00:00.000Z'

function usage() {
  return {
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
  }
}

function turn(opts: {
  model: string
  provider?: string
  timestamp?: string
  costUSD?: number
  category?: TaskCategory
  retries?: number
  hasEdits?: boolean
}): ClassifiedTurn {
  return {
    userMessage: 'edit the code',
    timestamp: opts.timestamp ?? RECENT,
    sessionId: `session-${opts.model}-${opts.timestamp ?? RECENT}-${opts.retries ?? 0}`,
    category: opts.category ?? 'feature',
    retries: opts.retries ?? 0,
    hasEdits: opts.hasEdits ?? true,
    assistantCalls: [{
      provider: opts.provider ?? 'claude',
      model: opts.model,
      usage: usage(),
      costUSD: opts.costUSD ?? 1,
      tools: [],
      mcpTools: [],
      skills: [],
      subagentTypes: [],
      hasAgentSpawn: false,
      hasPlanMode: false,
      speed: 'standard',
      timestamp: opts.timestamp ?? RECENT,
      bashCommands: [],
      deduplicationKey: `key-${opts.model}-${Math.random()}`,
    }],
  }
}

function repeatTurns(count: number, opts: Parameters<typeof turn>[0]): ClassifiedTurn[] {
  return Array.from({ length: count }, (_, i) => turn({ ...opts, timestamp: opts.timestamp ?? `2026-07-03T12:${String(i).padStart(2, '0')}:00.000Z` }))
}

function modelTurns(opts: {
  model: string
  provider?: string
  editTurns: number
  oneShotTurns: number
  editCost: number
  timestamp?: string
  category?: TaskCategory
}): ClassifiedTurn[] {
  const costPerEdit = opts.editCost / opts.editTurns
  const oneShot = repeatTurns(opts.oneShotTurns, {
    model: opts.model,
    provider: opts.provider,
    timestamp: opts.timestamp,
    costUSD: costPerEdit,
    retries: 0,
    category: opts.category,
  })
  const retried = repeatTurns(opts.editTurns - opts.oneShotTurns, {
    model: opts.model,
    provider: opts.provider,
    timestamp: opts.timestamp,
    costUSD: costPerEdit,
    retries: 1,
    category: opts.category,
  })
  return [...oneShot, ...retried]
}

function emptyCategoryBreakdown(): SessionSummary['categoryBreakdown'] {
  return {
    coding: { turns: 0, costUSD: 0, savingsUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
    debugging: { turns: 0, costUSD: 0, savingsUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
    feature: { turns: 0, costUSD: 0, savingsUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
    refactoring: { turns: 0, costUSD: 0, savingsUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
    testing: { turns: 0, costUSD: 0, savingsUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
    exploration: { turns: 0, costUSD: 0, savingsUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
    planning: { turns: 0, costUSD: 0, savingsUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
    delegation: { turns: 0, costUSD: 0, savingsUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
    git: { turns: 0, costUSD: 0, savingsUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
    'build/deploy': { turns: 0, costUSD: 0, savingsUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
    conversation: { turns: 0, costUSD: 0, savingsUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
    brainstorming: { turns: 0, costUSD: 0, savingsUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
    general: { turns: 0, costUSD: 0, savingsUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
  }
}

function projectWithTurns(turns: ClassifiedTurn[], opts: { project?: string; projectPath?: string; debuggingTurns?: number } = {}): ProjectSummary {
  const categoryBreakdown = emptyCategoryBreakdown()
  const totalTurns = turns.length
  const debuggingTurns = opts.debuggingTurns ?? turns.filter(t => t.category === 'debugging').length
  categoryBreakdown.debugging.turns = debuggingTurns
  categoryBreakdown.debugging.editTurns = debuggingTurns
  categoryBreakdown.feature.turns = Math.max(0, totalTurns - debuggingTurns)
  categoryBreakdown.feature.editTurns = Math.max(0, totalTurns - debuggingTurns)

  return {
    project: opts.project ?? 'demo-project',
    projectPath: opts.projectPath ?? '/tmp/demo-project',
    totalCostUSD: turns.reduce((sum, t) => sum + t.assistantCalls.reduce((s, c) => s + c.costUSD, 0), 0),
    totalSavingsUSD: 0,
    totalApiCalls: turns.reduce((sum, t) => sum + t.assistantCalls.length, 0),
    totalProxiedCostUSD: 0,
    sessions: [{
      sessionId: 'session-1',
      project: opts.project ?? 'demo-project',
      firstTimestamp: turns[0]?.timestamp ?? RECENT,
      lastTimestamp: turns.at(-1)?.timestamp ?? RECENT,
      totalCostUSD: turns.reduce((sum, t) => sum + t.assistantCalls.reduce((s, c) => s + c.costUSD, 0), 0),
      totalSavingsUSD: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalReasoningTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      apiCalls: turns.reduce((sum, t) => sum + t.assistantCalls.length, 0),
      turns,
      modelBreakdown: {},
      toolBreakdown: {},
      mcpBreakdown: {},
      bashBreakdown: {},
      categoryBreakdown,
      skillBreakdown: {},
      subagentBreakdown: {},
    }],
  }
}

function recommendationProject(overrides: {
  candidateEditTurns?: number
  candidateOneShotTurns?: number
  candidateEditCost?: number
  candidateProvider?: string
  candidateTimestamp?: string
  debuggingTurns?: number
} = {}): ProjectSummary {
  return projectWithTurns([
    ...modelTurns({ model: 'claude-sonnet-4-20250514', provider: 'claude', editTurns: 35, oneShotTurns: 32, editCost: 70 }),
    ...modelTurns({
      model: 'claude-haiku-3-5-20241022',
      provider: overrides.candidateProvider ?? 'claude',
      editTurns: overrides.candidateEditTurns ?? 32,
      oneShotTurns: overrides.candidateOneShotTurns ?? 29,
      editCost: overrides.candidateEditCost ?? 30,
      timestamp: overrides.candidateTimestamp,
    }),
  ], { debuggingTurns: overrides.debuggingTurns })
}

describe('model default recommendations', () => {
  it('recommends a same-provider candidate with enough volume, recent data, similar quality, and <=60% cost per edit', () => {
    const recommendation = recommendModelDefault(recommendationProject(), { now: NOW })

    expect(recommendation).toMatchObject({
      project: 'demo-project',
      currentModel: 'claude-sonnet-4-20250514',
      candidateModel: 'claude-haiku-3-5-20241022',
      provider: 'claude',
    })
    expect(recommendation?.currentOneShotRate).toBeCloseTo(32 / 35, 5)
    expect(recommendation?.candidateOneShotRate).toBeCloseTo(29 / 32, 5)
    expect(recommendation?.savingsPct).toBeGreaterThan(50)
  })

  it('rejects candidates below the 30 edit-turn minimum', () => {
    expect(recommendModelDefault(recommendationProject({ candidateEditTurns: 29, candidateOneShotTurns: 27 }), { now: NOW })).toBeNull()
  })

  it('rejects candidates more than 3pp below the current model one-shot rate', () => {
    expect(recommendModelDefault(recommendationProject({ candidateOneShotTurns: 28 }), { now: NOW })).toBeNull()
  })

  it('rejects candidates that cost more than 60% of the current model per edit', () => {
    expect(recommendModelDefault(recommendationProject({ candidateEditCost: 43 }), { now: NOW })).toBeNull()
  })

  it('rejects candidates last seen more than 14 days ago', () => {
    expect(recommendModelDefault(recommendationProject({ candidateTimestamp: OLD }), { now: NOW })).toBeNull()
  })

  it('rejects cross-provider candidates in v1', () => {
    expect(recommendModelDefault(recommendationProject({ candidateProvider: 'openai' }), { now: NOW })).toBeNull()
  })

  it('uses zero tolerance for debugging-heavy projects', () => {
    const project = recommendationProject({ debuggingTurns: 40 })

    expect(recommendModelDefault(project, { now: NOW })).toBeNull()
  })
})

describe('model default apply plan', () => {
  it('writes only the model key while preserving existing Claude settings and journals model-default', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeburn-model-default-'))
    const actionsDir = join(dir, '.codeburn-actions')
    const projectPath = join(dir, 'project')
    const settingsPath = join(projectPath, '.claude', 'settings.json')
    const original = '{\n  "enabledTools": ["Bash"],\n  "model": "claude-sonnet-4-20250514"\n}\n'

    try {
      await mkdir(dirname(settingsPath), { recursive: true })
      await writeFile(settingsPath, original, { encoding: 'utf-8' })
      const recommendation = recommendModelDefault(recommendationProject(), { now: NOW })!
      const plan = await buildApplyModelDefaultPlan({ ...recommendation, projectPath })
      const record = await runAction(plan, actionsDir)

      const updated = JSON.parse(await readFile(settingsPath, 'utf-8'))
      expect(updated).toEqual({ enabledTools: ['Bash'], model: 'claude-haiku-3-5-20241022' })
      expect(record.kind).toBe('model-default')
      expect(record.findingId).toBe('model-default:demo-project')

      await undoAction({ id: record.id }, { actionsDir })
      expect(await readFile(settingsPath, 'utf-8')).toBe(original)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

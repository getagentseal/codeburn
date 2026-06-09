import { describe, expect, it } from 'vitest'

import { buildMenubarPayload, type LocalModelSavings, type PeriodData } from '../src/menubar-json.js'

function basePeriod(overrides: Partial<PeriodData> = {}): PeriodData {
  return {
    label: '7 Days',
    cost: 0,
    savingsUSD: 0,
    calls: 0,
    sessions: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    categories: [],
    models: [],
    ...overrides,
  }
}

describe('buildMenubarPayload: local-model savings', () => {
  it('defaults localModelSavings to an empty block when no breakdown is provided', () => {
    const payload = buildMenubarPayload(basePeriod(), [], null)
    expect(payload.current.localModelSavings).toEqual({ totalUSD: 0, calls: 0, byModel: [], byProvider: [] })
  })

  it('threads the localModelSavings breakdown into the payload when supplied', () => {
    const breakdown: LocalModelSavings = {
      totalUSD: 12.34,
      calls: 7,
      byModel: [
        { name: 'llama3.1:8b', calls: 4, actualUSD: 0, savingsUSD: 7.21, baselineModel: 'gpt-4o', inputTokens: 1234, outputTokens: 567 },
        { name: 'qwen2.5:32b', calls: 3, actualUSD: 0, savingsUSD: 5.13, baselineModel: 'claude-opus-4-6', inputTokens: 4321, outputTokens: 876 },
      ],
      byProvider: [
        { name: 'ollama', calls: 7, savingsUSD: 12.34 },
      ],
    }
    const payload = buildMenubarPayload(basePeriod(), [], null, undefined, undefined, undefined, {
      localModelSavings: breakdown,
    })
    expect(payload.current.localModelSavings).toEqual(breakdown)
  })

  it('exposes savingsUSD and savingsBaselineModel on top models', () => {
    const payload = buildMenubarPayload(basePeriod({
      models: [
        { name: 'Local Model', cost: 0, savingsUSD: 5, calls: 1 },
        { name: 'gpt-4o', cost: 2, savingsUSD: 0, calls: 1 },
      ],
    }), [], null)
    const local = payload.current.topModels.find(m => m.name === 'Local Model')!
    expect(local.savingsUSD).toBe(5)
    expect(local.cost).toBe(0)
    const paid = payload.current.topModels.find(m => m.name === 'gpt-4o')!
    expect(paid.savingsUSD).toBe(0)
  })

  it('surfaces savingsUSD on top projects and top sessions', () => {
    const payload = buildMenubarPayload(basePeriod({
      cost: 2,
      savingsUSD: 5,
      projects: [
        { name: 'p', cost: 2, savingsUSD: 5, sessions: 1, sessionDetails: [{ cost: 2, savingsUSD: 5, calls: 1, inputTokens: 0, outputTokens: 0, date: '2026-04-10', models: [{ name: 'Local Model', cost: 0, savingsUSD: 5 }] }] },
      ],
      topSessions: [{ project: 'p', cost: 2, savingsUSD: 5, calls: 1, date: '2026-04-10' }],
    }), [], null)
    const proj = payload.current.topProjects[0]!
    expect(proj.savingsUSD).toBe(5)
    expect(proj.sessionDetails[0]!.savingsUSD).toBe(5)
    expect(proj.sessionDetails[0]!.models[0]!.savingsUSD).toBe(5)
    const session = payload.current.topSessions[0]!
    expect(session.savingsUSD).toBe(5)
  })

  it('emits savingsUSD and per-model breakdown in history entries', () => {
    const payload = buildMenubarPayload(basePeriod(), [], null, [
      { date: '2026-04-10', cost: 2, savingsUSD: 5, calls: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, topModels: [{ name: 'Local Model', cost: 0, savingsUSD: 5, calls: 1, inputTokens: 0, outputTokens: 0 }] },
    ])
    expect(payload.history.daily[0]!.savingsUSD).toBe(5)
    expect(payload.history.daily[0]!.topModels[0]!.savingsUSD).toBe(5)
  })

  it('keeps topActivities savingsUSD aligned with category rollups', () => {
    const payload = buildMenubarPayload(basePeriod({
      categories: [{ name: 'Coding', cost: 0, savingsUSD: 5, turns: 1, editTurns: 0, oneShotTurns: 0 }],
    }), [], null)
    expect(payload.current.topActivities[0]!.savingsUSD).toBe(5)
  })
})

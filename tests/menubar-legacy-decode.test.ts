import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { buildMenubarPayload, type PeriodData } from '../src/menubar-json.js'
import { buildLiveSessions } from '../src/live-sessions.js'
import { summarizeDeviceUsage } from '../src/sharing/host.js'

// Keys each released menubar app decodes as required, per tag. Derived by
// compiling that tag's MenubarPayload.swift and deleting each key from a full
// payload in turn: a key is listed when its absence makes the decode throw.
// Released apps never change, so this table is frozen history. The Homebrew
// and npm CLI updates independently of the app, so every newer CLI must keep
// emitting these (#1541).
const REQUIRED = JSON.parse(readFileSync(new URL('./fixtures/menubar-legacy-required-keys.json', import.meta.url), 'utf-8')) as Record<string, string[]>

// Worst case for conditional keys: lower-bound session counts, no ids, no
// optional token counts, nulls wherever the payload allows them.
function fullPayload() {
  const period: PeriodData = {
    label: 'Today', cost: 4, savingsUSD: 0, calls: 4, sessions: 2, sessionCountBasis: 'partial',
    inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0,
    categories: [{ name: 'Coding', cost: 4, savingsUSD: 0, turns: 2, editTurns: 0, oneShotTurns: 0 }],
    models: [{ name: 'claude-sonnet-4-5', cost: 4, savingsUSD: 0, calls: 4 }],
    projects: [{
      name: 'vault', cost: 4, savingsUSD: 0, sessions: 2, sessionCountBasis: 'partial',
      sessionDetails: [{ cost: 4, savingsUSD: 0, calls: 4, inputTokens: 10, outputTokens: 5, date: '2026-09-24', models: [{ name: 'Sonnet 4.5', cost: 4, savingsUSD: 0 }] }],
    }],
    modelEfficiency: [{ name: 'Sonnet 4.5', costPerEdit: 1, oneShotRate: null }],
    topSessions: [{ project: 'vault', cost: 4, savingsUSD: 0, calls: 4, date: '2026-09-24' }],
    workflow: { corrections: 0, correctionRate: null, medianTimeToFirstEditMs: null },
    topReworkedFiles: [{ path: 'a/b.ts', sessions: 1, edits: 2 }],
  }
  const payload = buildMenubarPayload(
    period,
    [{ name: 'claude', displayName: 'Claude', cost: 4 }],
    { findings: [{ id: 'x', title: 'T', explanation: 'E', impact: 'high', tokensSaved: 1000 }], costRate: 0.000001, healthScore: 90, healthGrade: 'A' } as never,
    [{ date: '2026-09-24', cost: 4, savingsUSD: 0, calls: 4, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, topModels: [{ name: 'Sonnet 4.5', cost: 4, savingsUSD: 0, calls: 4, inputTokens: 10, outputTokens: 5 }] }],
    { totalUSD: 0, retries: 0, editTurns: 0, byModel: [{ name: 'Sonnet 4.5', taxUSD: 0, retries: 0, retriesPerEdit: null }] },
    { totalSavingsUSD: 0, baselineModel: 'Sonnet 4.5', baselineCostPerEdit: 1, byModel: [{ name: 'Sonnet 4.5', costPerEdit: 1, editTurns: 1, actualUSD: 1, counterfactualUSD: 1, savingsUSD: 0 }] },
    {
      tools: [{ name: 'Edit', calls: 1 }],
      skills: [{ name: 's', turns: 1, cost: 0 }],
      subagents: [{ name: 'a', calls: 1, cost: 0 }],
      mcpServers: [{ name: 'm', calls: 1 }],
      localModelSavings: { totalUSD: 0, calls: 1, byModel: [{ name: 'q', calls: 1, actualUSD: 0, savingsUSD: 0, baselineModel: 'b', inputTokens: 1, outputTokens: 1 }], byProvider: [{ name: 'ollama', calls: 1, savingsUSD: 0 }] },
    },
    { selectedId: null, options: [{ id: 'a', label: 'A', path: '/a' }, { id: 'b', label: 'B', path: '/b' }] },
  )
  payload.combined = summarizeDeviceUsage([
    { id: 'local', name: 'Mac', local: true, payload: payload as never },
    { id: 'peer', name: 'Peer', local: false, error: 'unreachable' },
  ])
  const now = Date.now()
  payload.liveSessions = buildLiveSessions([{ id: 's', provider: 'claude', project: 'vault', branch: null, model: null, contextTokens: null, contextWindow: null, startedMs: now - 60_000, lastActivityMs: now, subagentActivityMs: [] }], now)
  return JSON.parse(JSON.stringify(payload)) as unknown
}

function missing(value: unknown, parts: string[], at: string): string[] {
  if (parts.length === 0) return []
  const [head, ...rest] = parts
  const isArray = head!.endsWith('[]')
  const key = isArray ? head!.slice(0, -2) : head!
  const obj = value as Record<string, unknown>
  if (!(key in obj)) return [`${at}${key}`]
  if (!isArray) return missing(obj[key], rest, `${at}${key}.`)
  const items = obj[key] as unknown[]
  // An empty array would pass vacuously and hide a missing nested key.
  if (items.length === 0) return [`${at}${key}[] (empty in fixture)`]
  return items.flatMap((item, i) => missing(item, rest, `${at}${key}[${i}].`))
}

describe('menubar payload stays decodable by released menubar apps', () => {
  const payload = fullPayload()
  for (const [tags, paths] of Object.entries(REQUIRED)) {
    it(tags, () => {
      expect(paths.flatMap(p => missing(payload, p.split('.'), ''))).toEqual([])
    })
  }
})

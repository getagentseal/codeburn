import { describe, expect, it } from 'vitest'

import { buildAccountReport, filterProjectsByAccount } from '../src/accounts.js'
import type { ProjectSummary, SessionSummary, TaskCategory } from '../src/types.js'

const categories: TaskCategory[] = [
  'coding',
  'debugging',
  'feature',
  'refactoring',
  'testing',
  'exploration',
  'planning',
  'delegation',
  'git',
  'build/deploy',
  'conversation',
  'brainstorming',
  'general',
]

function makeSession(project: string, sessionId: string, costUSD: number, model = 'claude-sonnet-4-5'): SessionSummary {
  return {
    sessionId,
    project,
    firstTimestamp: '2099-04-20T10:00:00.000Z',
    lastTimestamp: '2099-04-20T10:01:00.000Z',
    totalCostUSD: costUSD,
    totalInputTokens: 100,
    totalOutputTokens: 50,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    apiCalls: 1,
    turns: [],
    modelBreakdown: {
      [model]: {
        calls: 1,
        costUSD,
        tokens: {
          inputTokens: 100,
          outputTokens: 50,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          cachedInputTokens: 0,
          reasoningTokens: 0,
          webSearchRequests: 0,
        },
      },
    },
    toolBreakdown: {},
    mcpBreakdown: {},
    bashBreakdown: {},
    categoryBreakdown: Object.fromEntries(categories.map(category => [
      category,
      { turns: category === 'feature' ? 1 : 0, costUSD: category === 'feature' ? costUSD : 0, retries: 0, editTurns: category === 'feature' ? 1 : 0, oneShotTurns: category === 'feature' ? 1 : 0 },
    ])) as SessionSummary['categoryBreakdown'],
    skillBreakdown: {},
  }
}

function makeProject(account: string | undefined, projectPath: string, costUSD: number): ProjectSummary {
  const project = projectPath.split('/').pop() ?? projectPath
  return {
    project,
    projectPath,
    ...(account ? { account, accountPath: `/tmp/claude-${account}` } : {}),
    sessions: [makeSession(project, `${account ?? 'default'}-${project}`, costUSD)],
    totalCostUSD: costUSD,
    totalApiCalls: 1,
  }
}

describe('account reporting', () => {
  it('aggregates spend by account with subscription and budget signals', () => {
    const report = buildAccountReport([
      makeProject('work', '/Users/alice/work/app', 12),
      makeProject('personal', '/Users/alice/work/app', 1),
    ], {
      work: { plan: 'Claude Max', monthlyUsd: 100, budgetUsd: 10 },
      personal: { plan: 'Claude Pro', monthlyUsd: 20 },
    })

    expect(report.accounts.map(a => a.account)).toEqual(['work', 'personal'])
    expect(report.accounts[0]).toMatchObject({
      account: 'work',
      totalCostUSD: 12,
      sessions: 1,
      projects: 1,
      subscriptionUtilizationPercent: 12,
      budgetUtilizationPercent: 120,
    })
    expect(report.risks.map(r => r.type)).toContain('duplicate-project')
    expect(report.risks.map(r => r.type)).toContain('path-account-mismatch')
    expect(report.risks.map(r => r.type)).toContain('over-budget')
    expect(report.risks.map(r => r.type)).toContain('underused-subscription')
  })

  it('keeps configured but unused subscriptions visible', () => {
    const report = buildAccountReport([], {
      idle: { plan: 'Claude Pro', monthlyUsd: 20 },
    })

    expect(report.accounts).toHaveLength(1)
    expect(report.accounts[0]).toMatchObject({
      account: 'idle',
      totalCostUSD: 0,
      sessions: 0,
      subscriptionUtilizationPercent: 0,
    })
    expect(report.risks).toContainEqual(expect.objectContaining({
      type: 'underused-subscription',
      account: 'idle',
    }))
  })

  it('matches configured accounts case-insensitively', () => {
    const report = buildAccountReport([
      makeProject('work', '/Users/alice/work/app', 12),
    ], {
      Work: { plan: 'Claude Max', monthlyUsd: 100 },
    })

    expect(report.accounts).toHaveLength(1)
    expect(report.accounts[0]).toMatchObject({
      account: 'work',
      configured: { plan: 'Claude Max' },
      subscriptionUtilizationPercent: 12,
    })
  })

  it('does not warn when an account-labelled project also has unlabelled provider usage', () => {
    const report = buildAccountReport([
      makeProject('work', '/Users/alice/work/app', 12),
      makeProject(undefined, '/Users/alice/work/app', 3),
    ])

    expect(report.accounts.map(a => a.account)).toEqual(['work', 'unlabelled'])
    expect(report.risks.map(r => r.type)).not.toContain('duplicate-project')
  })

  it('uses account-label tokens for wrong-account warnings', () => {
    const report = buildAccountReport([
      makeProject('homework', '/Users/alice/work/app', 1),
      makeProject('personal-home', '/Users/alice/work/app', 1),
    ])

    const mismatches = report.risks.filter(r => r.type === 'path-account-mismatch')
    expect(mismatches.map(r => r.account)).toEqual(['personal-home'])
  })

  it('filters projects by account label, path, and account-prefixed project', () => {
    const projects = [
      makeProject('work', '/Users/alice/work/app', 12),
      makeProject('personal', '/Users/alice/work/app', 1),
    ]

    expect(filterProjectsByAccount(projects, ['work']).map(p => p.account)).toEqual(['work'])
    expect(filterProjectsByAccount(projects, ['claude-personal']).map(p => p.account)).toEqual(['personal'])
    expect(filterProjectsByAccount(projects, ['work:/users/alice/work']).map(p => p.account)).toEqual(['work'])
  })
})

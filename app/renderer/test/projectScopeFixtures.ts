import { vi } from 'vitest'

import type { MenubarPayload } from '../lib/types'

export const PROJECT_ALPHA: { id: string; name: string; path: string | null } = {
  id: 'path:/work/alpha',
  name: 'Alpha',
  path: '/work/alpha',
}

export const PROJECT_ALPHA_SAME_NAME: { id: string; name: string; path: string | null } = {
  id: 'path:/work/alpha-ui',
  name: 'Alpha',
  path: '/work/alpha-ui',
}

export const PROJECT_PATHLESS: { id: string; name: string; path: string | null } = {
  id: 'label:Alpha',
  name: 'Alpha',
  path: null,
}

const PROJECT_OPTIONS = [PROJECT_ALPHA, PROJECT_ALPHA_SAME_NAME, PROJECT_PATHLESS]

export function payloadForScope(projectId?: string): MenubarPayload {
  const selected = PROJECT_OPTIONS.find(option => option.id === projectId)
  const cost = projectId === PROJECT_ALPHA.id ? 1 : projectId === PROJECT_ALPHA_SAME_NAME.id ? 2 : projectId === PROJECT_PATHLESS.id ? 3 : 6
  const projectRows = selected
    ? [{ id: selected.id, name: selected.name, cost, savingsUSD: 0, sessions: 1, sessionDetails: [] }]
    : []

  return {
    generated: '2026-10-02T12:00:00.000Z',
    current: {
      label: selected?.name ?? 'All projects',
      cost,
      calls: selected ? 1 : 3,
      sessions: selected ? 1 : 3,
      oneShotRate: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheHitPercent: 0,
      codexCredits: 0,
      topActivities: [],
      topModels: [],
      localModelSavings: { totalUSD: 0, calls: 0, byModel: [], byProvider: [] },
      providers: { claude: cost },
      topProjects: projectRows,
      modelEfficiency: [],
      topSessions: [],
      retryTax: { totalUSD: 0, retries: 0, editTurns: 0, byModel: [] },
      routingWaste: { totalSavingsUSD: 0, baselineModel: '', baselineCostPerEdit: 0, byModel: [] },
      tools: [],
      skills: [],
      subagents: [],
      mcpServers: [],
    },
    optimize: { findingCount: 0, savingsUSD: 0, topFindings: [] },
    history: { daily: [] },
  }
}

export function bridgeForProjectScope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const catalog = {
    revision: 'settings-revision-2026-10-02',
    options: PROJECT_OPTIONS,
  }
  const mocks = {
    getProjectScopeCatalog: vi.fn(async () => catalog),
    getOverview: vi.fn(async () => payloadForScope()),
  }
  const validateProjectScope = vi.fn((id: unknown, revision: unknown) => (
    revision === catalog.revision && typeof id === 'string' && catalog.options.some(option => option.id === id)
  ))

  return {
    catalog,
    mocks,
    validateProjectScope,
    ...mocks,
    ...overrides,
  }
}

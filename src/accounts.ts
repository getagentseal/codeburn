import type { AccountConfig } from './config.js'
import type { ProjectSummary } from './types.js'

export type AccountModelSummary = {
  name: string
  calls: number
  costUSD: number
}

export type AccountProjectSummary = {
  project: string
  projectPath: string
  costUSD: number
  sessions: number
}

export type AccountSummary = {
  account: string
  accountPath?: string
  configured?: AccountConfig
  totalCostUSD: number
  totalApiCalls: number
  sessions: number
  projects: number
  editTurns: number
  oneShotTurns: number
  costPerSessionUSD: number | null
  costPerEditUSD: number | null
  subscriptionCostPerSessionUSD: number | null
  subscriptionCostPerEditUSD: number | null
  budgetUtilizationPercent: number | null
  subscriptionUtilizationPercent: number | null
  topModels: AccountModelSummary[]
  topProjects: AccountProjectSummary[]
}

export type AccountRisk = {
  type: 'duplicate-project' | 'path-account-mismatch' | 'underused-subscription' | 'over-budget'
  account?: string
  projectPath?: string
  accounts?: string[]
  message: string
}

export type AccountReport = {
  accounts: AccountSummary[]
  risks: AccountRisk[]
}

const UNLABELLED_ACCOUNT = 'unlabelled'
const TOP_LIMIT = 5
const UNDERUSED_SUBSCRIPTION_PERCENT = 10
const WORK_MARKERS = ['work', 'client', 'company', 'corp', 'office']
const PERSONAL_MARKERS = ['personal', 'private', 'home']

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export function projectAccount(project: Pick<ProjectSummary, 'account'>): string {
  return project.account?.trim() || UNLABELLED_ACCOUNT
}

export function filterProjectsByAccount(projects: ProjectSummary[], include?: string[]): ProjectSummary[] {
  const patterns = include?.map(s => s.trim().toLowerCase()).filter(Boolean) ?? []
  if (patterns.length === 0) return projects

  return projects.filter(project => {
    const account = projectAccount(project).toLowerCase()
    const accountPath = (project.accountPath ?? '').toLowerCase()
    return patterns.some(pattern => {
      const accountScopedProject = pattern.includes(':') && (
        `${account}:${project.project.toLowerCase()}`.includes(pattern)
        || `${account}:${project.projectPath.toLowerCase()}`.includes(pattern)
      )
      return account.includes(pattern) || accountPath.includes(pattern) || accountScopedProject
    })
  })
}

function sortedEntries<T extends { costUSD: number }>(map: Map<string, T>): T[] {
  return [...map.values()].sort((a, b) => b.costUSD - a.costUSD).slice(0, TOP_LIMIT)
}

function utilization(spendUSD: number, configuredUSD?: number): number | null {
  if (configuredUSD === undefined || configuredUSD <= 0) return null
  return round2((spendUSD / configuredUSD) * 100)
}

function addModelCost(
  map: Map<string, AccountModelSummary>,
  name: string,
  calls: number,
  costUSD: number,
) {
  const existing = map.get(name) ?? { name, calls: 0, costUSD: 0 }
  existing.calls += calls
  existing.costUSD += costUSD
  map.set(name, existing)
}

function accountLooksLike(account: string, markers: string[]): boolean {
  const tokens = account.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  return markers.some(marker => tokens.includes(marker))
}

function pathLooksLike(path: string, markers: string[]): boolean {
  const lower = path.toLowerCase()
  return markers.some(marker => lower.includes(`/${marker}/`) || lower.includes(`-${marker}-`) || lower.endsWith(`/${marker}`))
}

export function buildAccountReport(
  projects: ProjectSummary[],
  accountConfig: Record<string, AccountConfig> = {},
): AccountReport {
  type Accum = {
    account: string
    accountPaths: Set<string>
    totalCostUSD: number
    totalApiCalls: number
    sessions: number
    projectPaths: Set<string>
    editTurns: number
    oneShotTurns: number
    models: Map<string, AccountModelSummary>
    projects: Map<string, AccountProjectSummary>
  }

  const byAccount = new Map<string, Accum>()
  const projectAccounts = new Map<string, Set<string>>()
  const risks: AccountRisk[] = []
  const configByAccount = new Map(Object.entries(accountConfig).map(([account, config]) => [account.toLowerCase(), config]))

  for (const project of projects) {
    const account = projectAccount(project)
    const existing = byAccount.get(account) ?? {
      account,
      accountPaths: new Set<string>(),
      totalCostUSD: 0,
      totalApiCalls: 0,
      sessions: 0,
      projectPaths: new Set<string>(),
      editTurns: 0,
      oneShotTurns: 0,
      models: new Map<string, AccountModelSummary>(),
      projects: new Map<string, AccountProjectSummary>(),
    }

    if (project.accountPath) existing.accountPaths.add(project.accountPath)
    existing.totalCostUSD += project.totalCostUSD
    existing.totalApiCalls += project.totalApiCalls
    existing.sessions += project.sessions.length
    existing.projectPaths.add(project.projectPath)

    if (project.account?.trim()) {
      const projectKey = project.projectPath.toLowerCase()
      const accountsForProject = projectAccounts.get(projectKey) ?? new Set<string>()
      accountsForProject.add(account)
      projectAccounts.set(projectKey, accountsForProject)
    }

    const projectSummary = existing.projects.get(project.projectPath) ?? {
      project: project.project,
      projectPath: project.projectPath,
      costUSD: 0,
      sessions: 0,
    }
    projectSummary.costUSD += project.totalCostUSD
    projectSummary.sessions += project.sessions.length
    existing.projects.set(project.projectPath, projectSummary)

    if (accountLooksLike(account, PERSONAL_MARKERS) && pathLooksLike(project.projectPath, WORK_MARKERS)) {
      risks.push({
        type: 'path-account-mismatch',
        account,
        projectPath: project.projectPath,
        message: `${project.projectPath} looks work/client-related but ran on ${account}.`,
      })
    }
    if (accountLooksLike(account, WORK_MARKERS) && pathLooksLike(project.projectPath, PERSONAL_MARKERS)) {
      risks.push({
        type: 'path-account-mismatch',
        account,
        projectPath: project.projectPath,
        message: `${project.projectPath} looks personal/private but ran on ${account}.`,
      })
    }

    for (const session of project.sessions) {
      for (const [model, data] of Object.entries(session.modelBreakdown)) {
        addModelCost(existing.models, model, data.calls, data.costUSD)
      }
      for (const breakdown of Object.values(session.categoryBreakdown)) {
        existing.editTurns += breakdown.editTurns
        existing.oneShotTurns += breakdown.oneShotTurns
      }
    }

    byAccount.set(account, existing)
  }

  for (const [projectPath, accounts] of projectAccounts) {
    if (accounts.size <= 1) continue
    const list = [...accounts].sort()
    risks.push({
      type: 'duplicate-project',
      projectPath,
      accounts: list,
      message: `${projectPath} appears on multiple accounts: ${list.join(', ')}.`,
    })
  }

  for (const account of Object.keys(accountConfig)) {
    const lower = account.toLowerCase()
    if ([...byAccount.keys()].some(existing => existing.toLowerCase() === lower)) continue
    byAccount.set(account, {
      account,
      accountPaths: new Set<string>(),
      totalCostUSD: 0,
      totalApiCalls: 0,
      sessions: 0,
      projectPaths: new Set<string>(),
      editTurns: 0,
      oneShotTurns: 0,
      models: new Map<string, AccountModelSummary>(),
      projects: new Map<string, AccountProjectSummary>(),
    })
  }

  const accounts = [...byAccount.values()]
    .map(acc => {
      const configured = configByAccount.get(acc.account.toLowerCase())
      const subscriptionUtilizationPercent = utilization(acc.totalCostUSD, configured?.monthlyUsd)
      const budgetUtilizationPercent = utilization(acc.totalCostUSD, configured?.budgetUsd)
      const summary: AccountSummary = {
        account: acc.account,
        ...(acc.accountPaths.size > 0 ? { accountPath: [...acc.accountPaths].sort().join(',') } : {}),
        ...(configured ? { configured } : {}),
        totalCostUSD: acc.totalCostUSD,
        totalApiCalls: acc.totalApiCalls,
        sessions: acc.sessions,
        projects: acc.projectPaths.size,
        editTurns: acc.editTurns,
        oneShotTurns: acc.oneShotTurns,
        costPerSessionUSD: acc.sessions > 0 ? acc.totalCostUSD / acc.sessions : null,
        costPerEditUSD: acc.editTurns > 0 ? acc.totalCostUSD / acc.editTurns : null,
        subscriptionCostPerSessionUSD: configured?.monthlyUsd && acc.sessions > 0 ? configured.monthlyUsd / acc.sessions : null,
        subscriptionCostPerEditUSD: configured?.monthlyUsd && acc.editTurns > 0 ? configured.monthlyUsd / acc.editTurns : null,
        budgetUtilizationPercent,
        subscriptionUtilizationPercent,
        topModels: sortedEntries(acc.models),
        topProjects: sortedEntries(acc.projects),
      }

      if (configured?.monthlyUsd && subscriptionUtilizationPercent !== null && subscriptionUtilizationPercent < UNDERUSED_SUBSCRIPTION_PERCENT) {
        risks.push({
          type: 'underused-subscription',
          account: acc.account,
          message: `${acc.account} used ${subscriptionUtilizationPercent}% of its ${configured.plan ?? 'subscription'} monthly price in API-equivalent spend.`,
        })
      }
      if (configured?.budgetUsd && budgetUtilizationPercent !== null && budgetUtilizationPercent > 100) {
        risks.push({
          type: 'over-budget',
          account: acc.account,
          message: `${acc.account} is at ${budgetUtilizationPercent}% of its monthly budget.`,
        })
      }

      return summary
    })
    .sort((a, b) => b.totalCostUSD - a.totalCostUSD)

  return { accounts, risks }
}

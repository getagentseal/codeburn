import type { BranchSpendCoverage, BranchSpendProjectReport, BranchSpendRow } from './types'

/** A repository, however many checkouts of it this machine has. */
export type ProjectGroup = {
  id: string
  label: string
  /** Muted qualifier for the picker: checkout count, "temporary", or both. */
  note: string
  paths: string[]
  totalCost: number
  branches: BranchSpendRow[]
  coverage: BranchSpendCoverage
}

const TEMP_ROOTS = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders']
export const TEMPORARY_GROUP = '__temporary__'

function isTempPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  // The root itself counts, not only what is under it: a session that recorded
  // /private/tmp as its cwd is as temporary as one a level down.
  return TEMP_ROOTS.some(root => normalized === root || normalized.startsWith(`${root}/`))
}

function segments(path: string): string[] {
  return path.replace(/\\/g, '/').split('/').filter(Boolean)
}

/** Whether the identity is a recorded working directory at all. Providers that
 *  record no cwd fall back to the session's own title, which is not a project
 *  and belongs only to Sessions. */
function isPath(id: string): boolean {
  return id.includes('/') || id.includes('\\') || /^[a-zA-Z]:/.test(id)
}

/** A throwaway checkout: somewhere under a temp root, or an agent's scratch
 *  directory (`agent-<hex>`). Only reached when the checkout has no origin to
 *  fold it into its repository. */
function isThrowaway(path: string): boolean {
  return isTempPath(path) || /^agent-[0-9a-f]{6,}$/i.test(segments(path).at(-1) ?? '')
}

/** Two segments keep sibling checkouts named "clone" apart without a full path. */
function pathIdentity(path: string): string {
  return segments(path).slice(-2).join('/') || path
}

/** Repo name from a normalized origin key ("github.com/org/repo" -> "repo"). */
function repoName(originKey: string): string {
  return originKey.split('/').filter(Boolean).pop() ?? originKey
}

function earliest(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return a < b ? a : b
}

function latest(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return a > b ? a : b
}

/// Map key for the Unknown row, which is a real branch value of `null`.
const UNKNOWN_BRANCH = '__unknown__'

function mergeRows(rows: BranchSpendRow[], projectId: string, projectLabel: string): BranchSpendRow[] {
  const byBranch = new Map<string, BranchSpendRow>()
  for (const row of rows) {
    const key = row.branch ?? UNKNOWN_BRANCH
    const held = byBranch.get(key)
    if (!held) {
      byBranch.set(key, { ...row, projectId, projectLabel })
      continue
    }
    held.cost += row.cost
    held.calls += row.calls
    held.sessions += row.sessions
    held.tokens = {
      inputTokens: held.tokens.inputTokens + row.tokens.inputTokens,
      outputTokens: held.tokens.outputTokens + row.tokens.outputTokens,
      reasoningTokens: held.tokens.reasoningTokens + row.tokens.reasoningTokens,
      cacheReadTokens: held.tokens.cacheReadTokens + row.tokens.cacheReadTokens,
      cacheWriteTokens: held.tokens.cacheWriteTokens + row.tokens.cacheWriteTokens,
    }
    held.firstActive = earliest(held.firstActive, row.firstActive)
    held.lastActive = latest(held.lastActive, row.lastActive)
    held.worktrees = [...held.worktrees, ...row.worktrees]
    held.sessionRows = [...held.sessionRows, ...row.sessionRows]
  }
  return [...byBranch.values()].sort((a, b) => {
    if (a.branch === null && b.branch !== null) return 1
    if (b.branch === null && a.branch !== null) return -1
    const byCost = b.cost - a.cost
    return byCost !== 0 ? byCost : (a.branch ?? '').localeCompare(b.branch ?? '')
  })
}

function mergeCoverage(members: BranchSpendProjectReport[]): BranchSpendCoverage {
  const providers = new Set<string>()
  for (const member of members) for (const provider of member.coverage.noBranchDataProviders) providers.add(provider)
  return {
    branchKnownCost: members.reduce((sum, m) => sum + m.coverage.branchKnownCost, 0),
    branchUnknownCost: members.reduce((sum, m) => sum + m.coverage.branchUnknownCost, 0),
    noBranchDataCost: members.reduce((sum, m) => sum + m.coverage.noBranchDataCost, 0),
    noBranchDataSessions: members.reduce((sum, m) => sum + m.coverage.noBranchDataSessions, 0),
    noBranchDataProviders: [...providers],
    // Sessions live in one checkout each, so distinct counts add up across them.
    distinctSessions: members.reduce((sum, m) => sum + m.coverage.distinctSessions, 0),
  }
}

/**
 * Fold every checkout of a repository into one entry. A review worktree and a
 * benchmark clone of the same repo are the same work, and listing them as a
 * dozen identically-named rows makes the picker unusable; they share an `origin`
 * remote, so that is the grouping key. A checkout without one keeps its own
 * canonical path as its identity.
 */
export function groupProjects(projects: BranchSpendProjectReport[]): ProjectGroup[] {
  // A project with no branch row has nothing to show in this lens; offering it
  // in the picker only leads to an empty card.
  projects = projects.filter(project => project.branches.length > 0 && isPath(project.id))
  const groups = new Map<string, BranchSpendProjectReport[]>()
  for (const project of projects) {
    const key = project.originKey || (isThrowaway(project.id) ? TEMPORARY_GROUP : pathIdentity(project.id))
    const held = groups.get(key)
    if (held) held.push(project)
    else groups.set(key, [project])
  }

  return [...groups.entries()]
    .map(([key, members]) => {
      const lead = [...members].sort((a, b) => b.totalCost - a.totalCost)[0]
      const paths = members.map(m => m.id)
      const temporary = key === TEMPORARY_GROUP
      // A checkout with no origin is named by its parent and folder, so two
      // clones that share a basename are told apart in the list.
      const label = temporary ? 'Temporary checkouts' : members[0].originKey ? repoName(key) : pathIdentity(lead.id)
      const note = temporary
        ? `${members.length} ${members.length === 1 ? 'project' : 'projects'}`
        : [
          members.length > 1 ? `${members.length} checkouts` : '',
          paths.every(isTempPath) ? 'temporary' : '',
        ].filter(Boolean).join(' · ')
      return {
        id: key,
        label,
        note,
        paths,
        totalCost: members.reduce((sum, m) => sum + m.totalCost, 0),
        // A row that spans checkouts can only be named by the group; a single
        // checkout keeps its own name, which is what the rows already read.
        branches: mergeRows(members.flatMap(m => m.branches), key, members.length > 1 ? label : lead.label),
        coverage: mergeCoverage(members),
      }
    })
    // The throwaway bucket sinks to the bottom however much it cost.
    .sort((a, b) => Number(a.id === TEMPORARY_GROUP) - Number(b.id === TEMPORARY_GROUP) || b.totalCost - a.totalCost)
}

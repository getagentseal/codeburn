import { cachedProjectIdentitiesForRange } from './daily-cache.js'
import { reportUnmatchedProjectPatterns } from './project-filter-warnings.js'
import { filterProjectsByName, foldIdentifiedWindowsPath, parseAllSessions } from './parser.js'
import { toDateString } from './daily-cache.js'
import type { DateRange } from './types.js'

export type SpendFlowNode = { id: string; label: string; cost: number }
export type SpendFlowLink = { model: string; project: string; cost: number }
export type SpendFlow = {
  period: { label: string; start: string; end: string }
  models: SpendFlowNode[]
  projects: SpendFlowNode[]
  links: SpendFlowLink[]
}

const TOP_NODE_LIMIT = 8
const OTHER_ID = '__other__'

function periodLabel(range: DateRange): string {
  return `${toDateString(range.start)} to ${toDateString(range.end)}`
}

function addToMap<K>(map: Map<K, number>, key: K, cost: number): void {
  map.set(key, (map.get(key) ?? 0) + cost)
}

/** #1260: identity for spend nodes — abs projectPath when present, else display label. */
export function spendProjectIdentity(project: { project: string; projectPath?: string }): { id: string; label: string } {
  const raw = (project.projectPath ?? '').trim().replace(/\\/g, '/')
  const looksAbs = raw.startsWith('/') || /^[a-zA-Z]:\//.test(raw) || (raw.includes('/') && !raw.startsWith('-'))
  if (looksAbs && raw) {
    const trimmed = raw.replace(/\/+$/, '')
    const base = trimmed.split('/').filter(Boolean).pop() || project.project
    return { id: foldIdentifiedWindowsPath(trimmed), label: base }
  }
  return { id: project.project, label: project.project }
}

function sortedEntries(totals: Map<string, number>): Array<[string, number]> {
  return [...totals.entries()].sort(([aName, aCost], [bName, bCost]) => {
    const byCost = bCost - aCost
    return byCost !== 0 ? byCost : aName.localeCompare(bName)
  })
}

function buildNodes(totals: Map<string, number>): { nodes: SpendFlowNode[]; keep: Set<string> } {
  const sorted = sortedEntries(totals)
  const top = sorted.slice(0, TOP_NODE_LIMIT)
  const rest = sorted.slice(TOP_NODE_LIMIT)
  const keep = new Set(top.map(([id]) => id))
  const nodes = top.map(([id, cost]) => ({ id, label: id, cost }))
  const otherCost = rest.reduce((sum, [, cost]) => sum + cost, 0)
  if (otherCost > 0) nodes.push({ id: OTHER_ID, label: 'Other', cost: otherCost })
  return { nodes, keep }
}

function looksAbsId(id: string): boolean {
  return id.startsWith('/') || /^[a-zA-Z]:\//.test(id)
}

function pathParts(id: string): string[] {
  return id.replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean)
}

/// Visible chart labels keep the literal basename (hyphens stay hyphens).
/// Same-basename abs cwds pick up enough parent segments to distinguish.
/// Legacy slug ids and Other are left as-is.
function assignDistinguishingProjectLabels(nodes: SpendFlowNode[], labels: Map<string, string>): void {
  const visible = nodes.filter(node => node.id !== OTHER_ID)
  for (const node of visible) {
    if (!looksAbsId(node.id)) {
      node.label = labels.get(node.id) ?? node.id
      continue
    }
    const parts = pathParts(node.id)
    const base = parts.at(-1) || labels.get(node.id) || node.id
    const collisions = visible.filter(other => other.id !== node.id && looksAbsId(other.id) && pathParts(other.id).at(-1) === base)
    if (collisions.length === 0) {
      node.label = base
      continue
    }
    let label = base
    for (let n = 2; n <= parts.length; n++) {
      label = parts.slice(-n).join('/')
      const clash = collisions.some(other => pathParts(other.id).slice(-n).join('/') === label)
      if (!clash) break
    }
    node.label = label
  }
}

export async function computeSpendFlow(range: DateRange, provider: string, projectFilter?: string[], excludeFilter?: string[]): Promise<SpendFlow> {
  const parsed = await parseAllSessions(range, provider)
  await reportUnmatchedProjectPatterns(parsed, projectFilter, excludeFilter, () => cachedProjectIdentitiesForRange(range))
  const projects = filterProjectsByName(parsed, projectFilter, excludeFilter)
  const matrix = new Map<string, Map<string, number>>()
  const projectTotals = new Map<string, number>()
  const modelTotals = new Map<string, number>()

  const projectLabels = new Map<string, string>()
  for (const project of projects) {
    const { id: projectId, label: projectLabel } = spendProjectIdentity(project)
    if (!projectLabels.has(projectId)) projectLabels.set(projectId, projectLabel)
    for (const session of project.sessions) {
      for (const [model, breakdown] of Object.entries(session.modelBreakdown)) {
        const cost = breakdown.costUSD
        if (cost <= 0) continue
        let modelCosts = matrix.get(projectId)
        if (!modelCosts) {
          modelCosts = new Map<string, number>()
          matrix.set(projectId, modelCosts)
        }
        addToMap(modelCosts, model, cost)
        addToMap(projectTotals, projectId, cost)
        addToMap(modelTotals, model, cost)
      }
    }
  }

  const { nodes: models, keep: keptModels } = buildNodes(modelTotals)
  const { nodes: projectsNodes, keep: keptProjects } = buildNodes(projectTotals)
  assignDistinguishingProjectLabels(projectsNodes, projectLabels)
  const rolledLinks = new Map<string, SpendFlowLink>()

  for (const [project, modelCosts] of matrix.entries()) {
    const rolledProject = keptProjects.has(project) ? project : OTHER_ID
    for (const [model, cost] of modelCosts.entries()) {
      const rolledModel = keptModels.has(model) ? model : OTHER_ID
      const key = `${rolledModel}\u0000${rolledProject}`
      const existing = rolledLinks.get(key)
      if (existing) existing.cost += cost
      else rolledLinks.set(key, { model: rolledModel, project: rolledProject, cost })
    }
  }

  const modelOrder = new Map(models.map((node, index) => [node.id, index]))
  const projectOrder = new Map(projectsNodes.map((node, index) => [node.id, index]))
  const links = [...rolledLinks.values()].sort((a, b) => {
    const byModel = (modelOrder.get(a.model) ?? Number.MAX_SAFE_INTEGER) - (modelOrder.get(b.model) ?? Number.MAX_SAFE_INTEGER)
    if (byModel !== 0) return byModel
    return (projectOrder.get(a.project) ?? Number.MAX_SAFE_INTEGER) - (projectOrder.get(b.project) ?? Number.MAX_SAFE_INTEGER)
  })

  return {
    period: {
      label: periodLabel(range),
      start: range.start.toISOString(),
      end: range.end.toISOString(),
    },
    models,
    projects: projectsNodes,
    links,
  }
}

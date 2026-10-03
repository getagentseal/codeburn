import { CliError } from './cli'

export type Period = 'today' | 'week' | '30days' | 'month' | 'all' | 'lifetime'
export type Scope = 'local' | 'combined'
export type DateRange = { from: string; to: string }

export type DesktopReportQuery = {
  period: Period
  provider: string
  range?: DateRange | null
  background?: boolean
  deviceScope?: Scope
  projectId?: string | null
}

export type DesktopOverviewQuery = DesktopReportQuery & { configSource?: string | null }
export type DesktopModelsQuery = DesktopReportQuery & { byTask: boolean }
export type DesktopCompareQuery = DesktopReportQuery & { modelA?: string; modelB?: string }
export type DesktopCohortQuery = DesktopReportQuery & { modelA?: string; modelB?: string; projects?: string[]; category?: string }
export type DesktopPeriodQuery = Omit<DesktopReportQuery, 'period' | 'range'> & { rangeA: DateRange; rangeB: DateRange }
export type DesktopPeriodSessionsQuery = DesktopPeriodQuery & { dimension: 'project' | 'model'; key: string }
export type DesktopOptimizeSnapshotQuery = DesktopReportQuery & { configSource?: string | null; maxAgeMs?: number }

export type ProjectScopeOption = {
  id: string
  name: string
  path: string | null
}

export type ProjectScopeCatalog = {
  revision: string
  options: ProjectScopeOption[]
}

const PERIODS = new Set<Period>(['today', 'week', '30days', 'month', 'all', 'lifetime'])

function badArgs(message: string): never {
  throw new CliError('bad-args', message)
}

function invalidCatalog(): never {
  throw new CliError('bad-json', 'invalid Desktop project scope catalog')
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) badArgs('invalid Desktop report query')
  return value as Record<string, unknown>
}

function validateProjectId(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    badArgs('invalid Desktop project id')
  }
  return value
}

function validateRange(value: unknown, message: string): DateRange {
  if (!value || typeof value !== 'object' || Array.isArray(value)) badArgs(message)
  const range = value as { from?: unknown; to?: unknown }
  if (typeof range.from !== 'string' || typeof range.to !== 'string'
    || !/^\d{4}-\d{2}-\d{2}$/.test(range.from)
    || !/^\d{4}-\d{2}-\d{2}$/.test(range.to)) {
    badArgs(message)
  }
  return { from: range.from, to: range.to }
}

function validateQueryBase(value: unknown, requirePeriod: boolean): Record<string, unknown> {
  const query = asRecord(value)
  if (requirePeriod && (typeof query.period !== 'string' || !PERIODS.has(query.period as Period))) {
    badArgs('invalid period')
  }
  if (typeof query.provider !== 'string' || !/^[a-z0-9-]+$/.test(query.provider)) {
    badArgs('invalid provider')
  }
  if (query.range !== undefined && query.range !== null) validateRange(query.range, 'invalid date range')
  if (query.background !== undefined && typeof query.background !== 'boolean') {
    badArgs('invalid background flag')
  }
  if (query.deviceScope !== undefined && query.deviceScope !== 'local' && query.deviceScope !== 'combined') {
    badArgs('invalid scope')
  }
  const projectId = validateProjectId(query.projectId)
  if (projectId !== undefined && projectId !== null && query.deviceScope === 'combined') {
    badArgs('Combined scope cannot be combined with a Desktop project id')
  }
  return query
}

export function validateDesktopReportQuery(query: DesktopReportQuery): DesktopReportQuery {
  validateQueryBase(query, true)
  return query
}

/** Validate the shared portion of compare-periods queries, which has no period field. */
export function validateDesktopPeriodQuery(query: DesktopPeriodQuery): DesktopPeriodQuery {
  validateQueryBase(query, false)
  validateRange(query.rangeA, 'invalid A date range')
  validateRange(query.rangeB, 'invalid B date range')
  return query
}

export function desktopProjectArg(projectId: string | null | undefined): string[] {
  const id = validateProjectId(projectId)
  return id === undefined || id === null ? [] : [`--desktop-project-id=${id}`]
}

export function decodeProjectScopeCatalog(value: unknown): ProjectScopeCatalog {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidCatalog()
  const raw = value as { revision?: unknown; options?: unknown }
  if (typeof raw.revision !== 'string' || raw.revision.length === 0 || raw.revision.includes('\0') || !Array.isArray(raw.options)) {
    invalidCatalog()
  }

  const ids = new Set<string>()
  const options: ProjectScopeOption[] = []
  for (const item of raw.options) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) invalidCatalog()
    const option = item as { id?: unknown; name?: unknown; path?: unknown }
    if (typeof option.id !== 'string' || option.id.trim() === '' || option.id.includes('\0')
      || typeof option.name !== 'string' || (option.path !== null && typeof option.path !== 'string')
      || ids.has(option.id)) {
      invalidCatalog()
    }
    ids.add(option.id)
    options.push({ id: option.id, name: option.name, path: option.path as string | null })
  }
  return { revision: raw.revision, options }
}

export function validateCatalogSelection(catalog: ProjectScopeCatalog, projectId: string, revision: string): ProjectScopeOption {
  const id = validateProjectId(projectId)
  if (id === undefined || id === null || typeof revision !== 'string' || revision !== catalog.revision) {
    badArgs('Desktop project scope catalog is stale')
  }
  const option = catalog.options.find(candidate => candidate.id === id)
  if (!option) badArgs('invalid Desktop project scope selection')
  return option
}

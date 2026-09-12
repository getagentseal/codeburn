import { filterChipLabel, type FilterDimension, type InvestigationFilters, withoutFilterValue } from '../lib/investigation'

/** Chip descriptor: one active filter value. */
export type FilterChip = {
  dimension: FilterDimension
  value: string | { project: string; branch: string } | { provider: string; sessionId: string }
}

const DIMENSION_LABELS: Record<FilterDimension, string> = {
  days: 'Day',
  providers: 'Provider',
  projects: 'Project',
  models: 'Model',
  categories: 'Category',
  prs: 'PR',
  branches: 'Branch',
  sessions: 'Session',
}

/** Flatten the selection into chips in a stable display order. */
export function filterChips(filters: InvestigationFilters): FilterChip[] {
  return [
    ...filters.sessions.map(value => ({ dimension: 'sessions' as const, value })),
    ...filters.days.map(value => ({ dimension: 'days' as const, value })),
    ...filters.providers.map(value => ({ dimension: 'providers' as const, value })),
    ...filters.projects.map(value => ({ dimension: 'projects' as const, value })),
    ...filters.models.map(value => ({ dimension: 'models' as const, value })),
    ...filters.categories.map(value => ({ dimension: 'categories' as const, value })),
    ...filters.branches.map(value => ({ dimension: 'branches' as const, value })),
    ...filters.prs.map(value => ({ dimension: 'prs' as const, value })),
  ]
}

/**
 * The active-selection chip bar at a drill-through destination. Each chip is
 * individually removable; Clear empties every dimension. The bar explains the
 * current selection even when the list below is empty or still loading.
 */
export function FilterChips({ filters, onChange }: {
  filters: InvestigationFilters
  onChange: (next: InvestigationFilters) => void
}) {
  const chips = filterChips(filters)
  if (chips.length === 0) return null
  return (
    <div className="drill-chips" role="group" aria-label="Active investigation filters">
      <span className="drill-chips-label">Investigating</span>
      {chips.map(chip => (
        <span className={`drill-chip d-${chip.dimension}`} key={`${chip.dimension}:${filterChipLabel(chip.dimension, chip.value)}`}>
          <span className="drill-chip-dim">{DIMENSION_LABELS[chip.dimension]}</span>
          <span className="drill-chip-value" title={chip.dimension === 'prs' ? String(chip.value) : undefined}>
            {filterChipLabel(chip.dimension, chip.value)}
          </span>
          <button
            type="button"
            className="drill-chip-x"
            aria-label={`Remove ${DIMENSION_LABELS[chip.dimension]} filter ${filterChipLabel(chip.dimension, chip.value)}`}
            onClick={() => onChange(withoutFilterValue(filters, chip.dimension, chip.value))}
          >
            ×
          </button>
        </span>
      ))}
      <button type="button" className="drill-chips-clear" onClick={() => onChange({ ...filters, days: [], providers: [], projects: [], models: [], categories: [], prs: [], branches: [], sessions: [] })}>
        Clear
      </button>
    </div>
  )
}

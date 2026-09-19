import { t } from '../i18n'
import { filterChipKey, filterChipLabel, type FilterDimension, type InvestigationFilters, withoutFilterValue } from '../lib/investigation'
import { Icon } from './icons'

/** Chip descriptor: one active filter value. */
export type FilterChip = {
  dimension: FilterDimension
  value: string | { project: string; branch: string } | { provider: string; sessionId: string }
}

function dimensionLabels(): Record<FilterDimension, string> {
  return {
    days: t('shared.filterChips.dimension.day'),
    providers: t('shared.filterChips.dimension.provider'),
    projects: t('shared.filterChips.dimension.project'),
    models: t('shared.filterChips.dimension.model'),
    categories: t('shared.filterChips.dimension.category'),
    prs: t('shared.filterChips.dimension.pr'),
    branches: t('shared.filterChips.dimension.branch'),
    sessions: t('shared.filterChips.dimension.session'),
  }
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
  const dimLabels = dimensionLabels()
  return (
    <div className="drill-chips" role="group" aria-label={t('shared.filterChips.ariaLabel')}>
      <span className="drill-chips-label">{t('shared.filterChips.investigating')}</span>
      {/* Keyed by the chip's identity, never by its label: the label truncates
          a session id and shortens a project path, so two chips in the same
          dimension can read identically while selecting different things. */}
      {chips.map(chip => (
        <span className={`drill-chip d-${chip.dimension}`} key={`${chip.dimension}:${filterChipKey(chip.dimension, chip.value)}`}>
          <span className="drill-chip-dim">{dimLabels[chip.dimension]}</span>
          <span className="drill-chip-value" title={chip.dimension === 'prs' ? String(chip.value) : undefined}>
            {filterChipLabel(chip.dimension, chip.value)}
          </span>
          <button
            type="button"
            className="drill-chip-x"
            aria-label={t('shared.filterChips.removeAria', { dimension: dimLabels[chip.dimension], value: filterChipLabel(chip.dimension, chip.value) })}
            onClick={() => onChange(withoutFilterValue(filters, chip.dimension, chip.value))}
          >
            <Icon name="x" />
          </button>
        </span>
      ))}
      <button type="button" className="drill-chips-clear" onClick={() => onChange({ ...filters, days: [], providers: [], projects: [], models: [], categories: [], prs: [], branches: [], sessions: [] })}>
        {t('shared.filterChips.clear')}
      </button>
    </div>
  )
}

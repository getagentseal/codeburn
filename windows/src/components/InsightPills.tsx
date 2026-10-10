import { t } from '../i18n'
export type InsightMode = 'plan' | 'trend' | 'forecast' | 'calendar' | 'pulse' | 'stats' | 'optimize'

export const INSIGHT_LABELS: Record<InsightMode, string> = {
  plan: 'Plan',
  trend: 'Trend',
  forecast: 'Forecast',
  calendar: 'Calendar',
  pulse: 'Pulse',
  stats: 'Stats',
  optimize: 'Optimize',
}

/// Same order as the macOS InsightMode enum: Plan first when it is visible.
export const INSIGHT_ORDER: InsightMode[] = [
  'plan', 'trend', 'forecast', 'calendar', 'pulse', 'stats', 'optimize',
]

export function isInsightMode(value: string | null): value is InsightMode {
  return value !== null && value in INSIGHT_LABELS
}

type Props = {
  selected: InsightMode
  onSelect: (m: InsightMode) => void
  modes: InsightMode[]
}

export function InsightPills({ selected, onSelect, modes }: Props) {
  return (
    <div className="insight-pills" role="tablist" aria-label={t('Insight')}>
      {modes.map(m => (
        <button
          key={m}
          type="button"
          role="tab"
          id={`insight-tab-${m}`}
          aria-selected={selected === m}
          aria-controls="insight-panel"
          className={`insight-pill ${selected === m ? 'insight-pill-active' : ''}`}
          onClick={() => onSelect(m)}
        >
          {t(INSIGHT_LABELS[m])}
        </button>
      ))}
    </div>
  )
}

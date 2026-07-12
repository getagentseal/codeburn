import { formatUsd } from '../lib/format'
import { SERIES_HEX, SERIES_LABELS, type SeriesKey, seriesClassForModel, seriesKeyForModel } from '../lib/modelSeries'
import type { DailyHistoryEntry } from '../lib/types'

export function StackedBars({ daily }: { daily: DailyHistoryEntry[] }) {
  const presentSeries = new Set<SeriesKey>()
  const maxTotal = Math.max(
    1,
    ...daily.map(day => day.topModels.reduce((sum, model) => sum + Math.max(0, model.cost), 0)),
  )
  for (const day of daily) {
    for (const model of day.topModels) {
      if (model.cost > 0) presentSeries.add(seriesKeyForModel(model.name))
    }
  }
  const legendSeries = (['opus', 'sonnet', 'haiku', 'gpt', 'other'] as const).filter(series => presentSeries.has(series))

  return (
    <div className="sbars-wrap">
      <div className="sbars" aria-label="Daily spend by model">
        {daily.map(day => (
          <div className="c" key={day.date} data-date={day.date} title={`${day.date} · ${formatUsd(day.cost)}`}>
            {day.topModels.map(model => {
              const pct = Math.max(1, (Math.max(0, model.cost) / maxTotal) * 100)
              return (
                <span
                  key={`${day.date}-${model.name}`}
                  className={`s ${seriesClassForModel(model.name)}`}
                  style={{ height: `${pct}%` }}
                  title={`${model.name} · ${formatUsd(model.cost)}`}
                />
              )
            })}
          </div>
        ))}
      </div>
      <div className="legend">
        {legendSeries.map(series => (
          <span key={series}>
            <i style={{ background: SERIES_HEX[series] }} />
            {SERIES_LABELS[series]}
          </span>
        ))}
      </div>
    </div>
  )
}

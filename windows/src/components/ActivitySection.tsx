import type { MenubarPayload } from '../lib/payload'
import type { CurrencyState } from '../lib/currency'
import { formatCompactCurrency } from '../lib/currency'
import { t } from '../i18n'
import { CollapsibleSection } from './CollapsibleSection'

/// Column widths shared with the header captions (mac: Cost 54 / Turns 52 / 1-shot 44).
export const COL_COST = 54
export const COL_COUNT = 52
export const COL_ONESHOT = 44

type Props = {
  payload: MenubarPayload
  currency: CurrencyState
}

export function ActivitySection({ payload, currency }: Props) {
  const activities = payload.current.topActivities
  if (activities.length === 0) return null
  const maxCost = Math.max(...activities.map(a => a.cost), 0.01)

  return (
    <CollapsibleSection
      caption={t('Activity')}
      columns={[
        { label: t('Cost'), width: COL_COST },
        { label: t('Turns'), width: COL_COUNT },
        { label: t('1-shot'), width: COL_ONESHOT },
      ]}
    >
      {activities.map(a => (
        <div key={a.name} className="data-row">
          <FixedBar fraction={a.cost / maxCost} />
          <span className="row-name">{a.name}</span>
          <span className="row-cost" style={{ minWidth: COL_COST }}>{formatCompactCurrency(a.cost, currency)}</span>
          <span className="row-count" style={{ minWidth: COL_COUNT }}>{a.turns}</span>
          <span className="row-oneshot" style={{ minWidth: COL_ONESHOT }}>
            {a.oneShotRate == null ? '-' : `${Math.round(a.oneShotRate * 100)}%`}
          </span>
        </div>
      ))}
    </CollapsibleSection>
  )
}

export function FixedBar({ fraction }: { fraction: number }) {
  const pct = Math.min(Math.max(fraction, 0), 1) * 100
  return (
    <span className="fixed-bar" aria-hidden="true">
      <span className="fixed-bar-fill" style={{ width: `${pct}%` }} />
    </span>
  )
}

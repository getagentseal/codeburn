import type { ReactNode } from 'react'

import { ProviderPop } from './ProviderPop'
import { SegTabs, type SegOption } from './SegTabs'

/** Full period vocabulary per the wireframe. 6M/Custom (date ranges) land in T8. */
export const PERIOD_OPTIONS: SegOption[] = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: '7D' },
  { value: '30days', label: '30D' },
  { value: 'month', label: 'Month' },
  { value: '6m', label: '6M' },
  { value: 'custom', label: 'Custom' },
]

/** The `.bar` top bar: title, scope caption, period SegTabs, provider ProviderPop. */
export function TopBar({
  title,
  scope,
  period,
  onPeriodChange,
  providerLabel,
  onProviderClick,
}: {
  title: ReactNode
  scope?: ReactNode
  period: string
  onPeriodChange: (value: string) => void
  providerLabel: string
  onProviderClick?: () => void
}) {
  return (
    <div className="bar">
      <div className="t">{title}</div>
      {scope !== undefined && <span className="scope">{scope}</span>}
      <div className="sp" />
      <SegTabs options={PERIOD_OPTIONS} value={period} onChange={onPeriodChange} />
      <ProviderPop label={providerLabel} onClick={onProviderClick} />
    </div>
  )
}

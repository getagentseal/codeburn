import { useEffect, useRef, useState, type ReactNode } from 'react'

import type { ClaudeConfigSelector, DateRange } from '../lib/types'
import { Dropdown } from './Dropdown'
import { ProviderPop, type ProviderOption } from './ProviderPop'
import { RangeCalendar } from './RangeCalendar'
import { SegTabs, type SegOption } from './SegTabs'

/** Sentinel option value: no --claude-config-source flag (aggregate all configs). */
const ALL_CONFIGS = ''

/** The real CLI period vocabulary (`codeburn ... --period`, src/cli-date.ts). */
export const PERIOD_OPTIONS: SegOption[] = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: '7D' },
  { value: '30days', label: '30D' },
  { value: 'month', label: 'Month' },
  { value: 'all', label: '6M' },
  { value: 'lifetime', label: 'Life' },
]

/** The `.bar` top bar: title, scope caption, period SegTabs, provider ProviderPop. */
export function TopBar({
  title,
  scope,
  period,
  onPeriodChange,
  customRange,
  onRangeSelect,
  provider,
  providerLabel,
  providerOptions,
  onProviderSelect,
  claudeConfigs,
  configSource,
  onConfigSelect,
}: {
  title: ReactNode
  scope?: ReactNode
  period: string
  onPeriodChange: (value: string) => void
  customRange: DateRange | null
  onRangeSelect: (range: DateRange) => void
  provider: string
  providerLabel: string
  providerOptions: ProviderOption[]
  onProviderSelect: (value: string) => void
  claudeConfigs?: ClaudeConfigSelector
  configSource: string | null
  onConfigSelect: (id: string) => void
}) {
  return (
    <div className="bar">
      <div className="t">{title}</div>
      {scope !== undefined && <span className="scope">{scope}</span>}
      <div className="sp" />
      <SegTabs options={PERIOD_OPTIONS} value={customRange ? '' : period} onChange={onPeriodChange} />
      <CalendarPop value={customRange} onSelect={onRangeSelect} />
      <ProviderPop value={provider} label={providerLabel} options={providerOptions} onSelect={onProviderSelect} />
      {claudeConfigs && <ConfigPicker configs={claudeConfigs} value={configSource} onSelect={onConfigSelect} />}
    </div>
  )
}

/** Claude config source switcher. Only getOverview honors the selection, so the
 * footer names the limit; the active label is also echoed in the scope line. */
function ConfigPicker({ configs, value, onSelect }: { configs: ClaudeConfigSelector; value: string | null; onSelect: (id: string) => void }) {
  const options = [
    { value: ALL_CONFIGS, label: 'All Claude configs' },
    ...configs.options.map(option => ({ value: option.id, label: option.label })),
  ]
  return (
    <Dropdown
      id="claude-config-select"
      ariaLabel="Claude config source"
      value={value ?? ALL_CONFIGS}
      options={options}
      onChange={onSelect}
      width={168}
      footer="Applies to the overview data. Manage config folders with the codeburn CLI."
    />
  )
}

function formatRange(range: DateRange): string {
  const from = new Date(`${range.from}T12:00:00`)
  const to = new Date(`${range.to}T12:00:00`)
  const sameYear = from.getFullYear() === to.getFullYear()
  const sameMonth = sameYear && from.getMonth() === to.getMonth()
  const left = from.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric' })
  const right = to.toLocaleDateString('en-US', { month: sameMonth ? undefined : 'short', day: 'numeric', year: sameYear ? undefined : 'numeric' })
  return `${left} – ${right}`
}

export function rangeLabel(range: DateRange): string {
  return formatRange(range)
}

function CalendarPop({ value, onSelect }: { value: DateRange | null; onSelect: (range: DateRange) => void }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const label = value ? formatRange(value) : 'Choose date range'
  return (
    <div className="calendar-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`calendar-trigger${value ? ' on' : ''}`}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(current => !current)}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <rect x="2.25" y="3.25" width="11.5" height="10.5" rx="1.5" />
          <path d="M5 1.75v3M11 1.75v3M2.5 6.25h11" />
        </svg>
        {value && <span>{label}</span>}
      </button>
      {open && (
        <div className="calendar-popover" role="dialog" aria-label="Choose date range">
          <RangeCalendar
            value={value}
            onSelect={range => {
              onSelect(range)
              setOpen(false)
            }}
          />
        </div>
      )}
    </div>
  )
}

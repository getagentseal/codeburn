import { useEffect, useRef, useState, type ReactNode } from 'react'

import { useEscape } from '../hooks/useEscape'
import type { ClaudeConfigSelector, DateRange } from '../lib/types'
import { Dropdown } from './Dropdown'
import { Icon } from './icons'
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

/** Back/Forward history controls. Rendered on every screen so the title
 *  keeps one position; the sections without history show them disabled. */
export function BarNav({ canBack = false, canForward = false, onBack, onForward }: {
  canBack?: boolean
  canForward?: boolean
  onBack?: () => void
  onForward?: () => void
}) {
  return (
    <div className="bar-nav" role="group" aria-label="Navigation history">
      <button
        type="button"
        className="bar-nav-btn"
        aria-label="Back"
        title="Back"
        disabled={!canBack}
        onClick={() => { if (canBack) onBack?.() }}
      >
        <Icon name="chevron-left" />
      </button>
      <button
        type="button"
        className="bar-nav-btn"
        aria-label="Forward"
        title="Forward"
        disabled={!canForward}
        onClick={() => { if (canForward) onForward?.() }}
      >
        <Icon name="chevron-right" />
      </button>
    </div>
  )
}

/** The `.bar` top bar: back/forward history controls, title, scope caption,
 *  period SegTabs, provider ProviderPop. */
export function TopBar({
  title,
  canBack = false,
  canForward = false,
  onBack,
  onForward,
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
  /** In-app Back/Forward history (drill-through restores filters, sort,
   *  page depth, and the open drawer). Hidden when no handler is provided. */
  canBack?: boolean
  canForward?: boolean
  onBack?: () => void
  onForward?: () => void
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
      <BarNav canBack={canBack} canForward={canForward} onBack={onBack} onForward={onForward} />
      <h1 className="t">{title}</h1>
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
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  useEscape(open, () => setOpen(false))

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
        <Icon name="calendar" />
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

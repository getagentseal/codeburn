import { useEffect, useRef, useState, type ReactNode } from 'react'

import { localeTag, t } from '../i18n'
import { useEscape } from '../hooks/useEscape'
import type { ClaudeConfigSelector, DateRange } from '../lib/types'
import { AnchoredSurface } from './AnchoredSurface'
import { Dropdown } from './Dropdown'
import { Icon } from './icons'
import { ProviderPop, type ProviderOption } from './ProviderPop'
import { RangeCalendar } from './RangeCalendar'
import { SegTabs, type SegOption } from './SegTabs'

/** Sentinel option value: no --claude-config-source flag (aggregate all configs). */
const ALL_CONFIGS = ''

/** The real CLI period vocabulary (`codeburn ... --period`, src/cli-date.ts).
 *  A function, not a module-level constant: it must re-read t() on every call
 *  so a language switch (which remounts the app subtree, not the module) is
 *  reflected. */
function periodOptions(): SegOption[] {
  return [
    { value: 'today', label: t('shell.period.today') },
    { value: 'week', label: t('shell.period.week') },
    { value: '30days', label: t('shell.period.30days') },
    { value: 'month', label: t('shell.period.month') },
    { value: 'all', label: t('shell.period.all') },
    { value: 'lifetime', label: t('shell.period.lifetime') },
  ]
}

/** Back/Forward history controls. Rendered on every screen so the title
 *  keeps one position; the sections without history show them disabled. */
export function BarNav({ canBack = false, canForward = false, onBack, onForward }: {
  canBack?: boolean
  canForward?: boolean
  onBack?: () => void
  onForward?: () => void
}) {
  return (
    <div className="bar-nav" role="group" aria-label={t('shell.topbar.historyGroup')}>
      <button
        type="button"
        className="bar-nav-btn"
        aria-label={t('shell.action.back')}
        title={t('shell.action.back')}
        disabled={!canBack}
        onClick={() => { if (canBack) onBack?.() }}
      >
        <Icon name="chevron-left" />
      </button>
      <button
        type="button"
        className="bar-nav-btn"
        aria-label={t('shell.action.forward')}
        title={t('shell.action.forward')}
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
      <SegTabs options={periodOptions()} value={customRange ? '' : period} onChange={onPeriodChange} />
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
    { value: ALL_CONFIGS, label: t('shell.config.all') },
    ...configs.options.map(option => ({ value: option.id, label: option.label })),
  ]
  return (
    <Dropdown
      id="claude-config-select"
      ariaLabel={t('shell.config.ariaLabel')}
      value={value ?? ALL_CONFIGS}
      options={options}
      onChange={onSelect}
      width={168}
      footer={t('shell.config.footer')}
    />
  )
}

function formatRange(range: DateRange): string {
  const from = new Date(`${range.from}T12:00:00`)
  const to = new Date(`${range.to}T12:00:00`)
  const sameYear = from.getFullYear() === to.getFullYear()
  const sameMonth = sameYear && from.getMonth() === to.getMonth()
  const left = from.toLocaleDateString(localeTag(), { month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric' })
  const right = to.toLocaleDateString(localeTag(), { month: sameMonth ? undefined : 'short', day: 'numeric', year: sameYear ? undefined : 'numeric' })
  return `${left} – ${right}`
}

export function rangeLabel(range: DateRange): string {
  return formatRange(range)
}

function CalendarPop({ value, onSelect }: { value: DateRange | null; onSelect: (range: DateRange) => void }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (!wrapRef.current?.contains(target) && !popoverRef.current?.contains(target)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  useEscape(open, () => setOpen(false))

  const label = value ? formatRange(value) : t('shell.calendar.choose')
  return (
    <div className="calendar-wrap" ref={wrapRef}>
      <button
        ref={triggerRef}
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
        <AnchoredSurface anchor={triggerRef} surfaceRef={popoverRef} className="calendar-popover" role="dialog" aria-label={t('shell.calendar.choose')}>
          <RangeCalendar
            value={value}
            onSelect={range => {
              onSelect(range)
              setOpen(false)
            }}
          />
        </AnchoredSurface>
      )}
    </div>
  )
}

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { addDays, formatDateKey, startOfDay, todayKey } from '../lib/dates'
import { CalendarIcon, ChevronLeft, ChevronRight } from './Icons'
import { localeTag, t } from '../i18n'

export type Period = 'today' | 'week' | '30days' | 'month' | 'all' | 'lifetime'

/// Compact labels, as on the mac: six segments plus the calendar button share one narrow
/// popover row, so "6 Months" and "Lifetime" would wrap.
export const PERIOD_LABELS: Record<Period, string> = {
  today: 'Today', week: '7D', '30days': '30D', month: 'Month', all: '6M', lifetime: 'Life',
}

/// Short phrase used in sentences ("Sessions (7 days)", "No Claude data for this month").
export const PERIOD_PHRASES: Record<Period, string> = {
  today: 'today',
  week: 'the last 7 days',
  '30days': 'the last 30 days',
  month: 'this month',
  all: 'the last 6 months',
  lifetime: 'all time',
}

const PERIODS = Object.keys(PERIOD_LABELS) as Period[]

/// The days the reader picked in the calendar, sorted, empty when the period governs. One
/// day goes to the CLI as `--day`, several as `--days`.
export type DaySelection = string[]

export function daySelectionLabel(days: DaySelection): string | null {
  if (days.length === 0) return null
  if (days.length === 1) return t('Day (%@)', days[0])
  return t('%1$lld days (%2$@ .. %3$@)', days.length, days[0], days[days.length - 1])
}

type Props = {
  selected: Period
  days: DaySelection
  onSelect: (p: Period) => void
  onSelectDays: (days: DaySelection) => void
}

export function PeriodTabs({ selected, days, onSelect, onSelectDays }: Props) {
  const [calendarOpen, setCalendarOpen] = useState(false)
  const dayMode = days.length > 0
  const radios = useRef<HTMLDivElement>(null)
  const activeIndex = dayMode ? 0 : Math.max(0, PERIODS.indexOf(selected))

  // The radio-group pattern in full: one tab stop for the strip, arrow keys between the
  // segments. Six tab stops for one choice is what a plain row of buttons gives, and it is
  // why a reader ends up pressing Tab six times to leave a control they already answered.
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1
      : 0
    if (step === 0) return
    event.preventDefault()
    const index = (activeIndex + step + PERIODS.length) % PERIODS.length
    onSelect(PERIODS[index])
    radios.current?.querySelectorAll('button')[index]?.focus()
  }

  return (
    <div className="period-wrap">
      <nav className="period-tabs" aria-label={t('Period')}>
        {/* One choice out of six, which is a radio group rather than six toggles: a screen
            reader then says "3 of 6" and the arrow keys mean what they look like. */}
        <div className="period-radios" role="radiogroup" aria-label={t('Period')} ref={radios} onKeyDown={onKeyDown}>
          {PERIODS.map((p, i) => (
            <button
              key={p}
              type="button"
              role="radio"
              className={`period ${!dayMode && selected === p ? 'period-active' : ''}`}
              aria-checked={!dayMode && selected === p}
              tabIndex={i === activeIndex ? 0 : -1}
              onClick={() => onSelect(p)}
            >
              {t(PERIOD_LABELS[p])}
            </button>
          ))}
        </div>
        <div className="period-calendar-anchor">
          <button
            type="button"
            className={`period period-calendar ${dayMode ? 'period-active is-day-mode' : ''}`}
            aria-label={t('Pick days')}
            aria-expanded={calendarOpen}
            onClick={() => setCalendarOpen(o => !o)}
          >
            <CalendarIcon size={11} />
          </button>
          {calendarOpen && (
            <CalendarPopover
              days={days}
              onDone={next => { onSelectDays(next); setCalendarOpen(false) }}
              onDismiss={() => setCalendarOpen(false)}
            />
          )}
        </div>
      </nav>
    </div>
  )
}

function weekdayLabels(): string[] {
  const fmt = new Intl.DateTimeFormat(localeTag(), { weekday: 'narrow' })
  const monday = new Date(2026, 0, 5)
  return Array.from({ length: 7 }, (_, i) => fmt.format(addDays(monday, i)))
}

type DayCell = { key: string; day: number; date: string; currentMonth: boolean }

/// Port of CalendarPopover in mac/.../Views/PeriodSegmentedControl.swift. Days go into a
/// pending set and are only applied on Done, so choosing five days costs one CLI run
/// rather than five.
function CalendarPopover({ days, onDone, onDismiss }: {
  days: DaySelection
  onDone: (days: DaySelection) => void
  onDismiss: () => void
}) {
  const [pending, setPending] = useState<Set<string>>(() => new Set(days))
  const [month, setMonth] = useState(() => {
    const base = days[0] ? new Date(`${days[0]}T00:00:00`) : new Date()
    return new Date(base.getFullYear(), base.getMonth(), 1)
  })
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      // The calendar button toggles on click, so a press on it must not also dismiss here
      // or the popover would close and reopen in the same gesture.
      if (ref.current && !ref.current.contains(target) && !ref.current.parentElement?.contains(target)) {
        onDismiss()
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [onDismiss])

  const today = todayKey()
  const forwardOk = new Date(month.getFullYear(), month.getMonth() + 1, 1) <= startOfDay(new Date())

  const toggle = (date: string) => {
    setPending(prev => {
      const next = new Set(prev)
      if (next.has(date)) next.delete(date)
      else next.add(date)
      return next
    })
  }

  const summary = pending.size === 0 ? t('Pick dates') : pending.size === 1 ? t('1 day') : t('%lld days', pending.size)

  return (
    <div className="calendar-popover" ref={ref} role="dialog" aria-label={t('Pick days')}>
      <div className="calendar-head">
        <button
          type="button"
          className="calendar-nav"
          aria-label={t('Previous month')}
          onClick={() => setMonth(m => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
        >
          <ChevronLeft size={10} />
        </button>
        <span className="calendar-title">
          {month.toLocaleDateString(localeTag(), { month: 'long', year: 'numeric' })}
        </span>
        <button
          type="button"
          className="calendar-nav"
          aria-label={t('Next month')}
          disabled={!forwardOk}
          onClick={() => setMonth(m => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
        >
          <ChevronRight size={10} />
        </button>
      </div>
      <div className="calendar-weekdays">
        {weekdayLabels().map(d => <span key={d}>{d}</span>)}
      </div>
      <div className="calendar-grid" role="group" aria-label={t('Days')}>
        {monthCells(month).map(cell => {
          const selected = pending.has(cell.date)
          const cls = [
            'calendar-day',
            selected ? 'is-selected' : '',
            cell.date === today ? 'is-today' : '',
            cell.currentMonth ? '' : 'is-outside',
          ].join(' ')
          return (
            <button
              key={cell.key}
              type="button"
              className={cls}
              disabled={cell.date > today}
              // The number alone says nothing out of context: a reader arriving on a cell
              // needs the date it belongs to, which is what the mac's own cells announce.
              aria-label={dayLabel(cell.date)}
              aria-pressed={selected}
              onClick={() => toggle(cell.date)}
            >
              {cell.day}
            </button>
          )
        })}
      </div>
      <div className="calendar-foot">
        {pending.size > 0 && (
          <button type="button" className="calendar-clear" onClick={() => setPending(new Set())}>{t('Clear')}</button>
        )}
        <span className="calendar-summary">{summary}</span>
        <button
          type="button"
          className={`calendar-done ${pending.size === 0 ? 'is-idle' : ''}`}
          onClick={() => onDone([...pending].sort())}
        >
          Done
        </button>
      </div>
    </div>
  )
}

/// "Wednesday, 2 September 2026", in the reader's own locale.
function dayLabel(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString(localeTag(), {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
}

/// Whole weeks of cells starting on Monday, padded with the neighbouring months' days so
/// the grid is always rectangular.
function monthCells(month: Date): DayCell[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const length = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  // getDay() is Sunday-first; the grid is Monday-first.
  const lead = (first.getDay() + 6) % 7
  const cells: DayCell[] = []
  for (let i = lead; i > 0; i--) {
    const d = addDays(first, -i)
    cells.push({ key: `prev-${i}`, day: d.getDate(), date: formatDateKey(d), currentMonth: false })
  }
  for (let day = 1; day <= length; day++) {
    const d = new Date(month.getFullYear(), month.getMonth(), day)
    cells.push({ key: `cur-${day}`, day, date: formatDateKey(d), currentMonth: true })
  }
  const last = new Date(month.getFullYear(), month.getMonth(), length)
  for (let i = 1; cells.length % 7 !== 0; i++) {
    const d = addDays(last, i)
    cells.push({ key: `next-${i}`, day: d.getDate(), date: formatDateKey(d), currentMonth: false })
  }
  return cells
}

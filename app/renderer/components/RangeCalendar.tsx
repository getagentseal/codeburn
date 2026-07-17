import { useEffect, useMemo, useRef, useState } from 'react'

import type { DateRange } from '../lib/types'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function normalize(from: string, to: string): DateRange {
  return from <= to ? { from, to } : { from: to, to: from }
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)
}

export function RangeCalendar({ value, onSelect }: { value: DateRange | null; onSelect: (range: DateRange) => void }) {
  const today = useMemo(() => new Date(), [])
  const todayKey = dateKey(today)
  const [month, setMonth] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1))
  const [preview, setPreview] = useState<DateRange | null>(value)
  const dragAnchor = useRef<string | null>(null)
  const clickAnchor = useRef<string | null>(null)

  useEffect(() => setPreview(value), [value])
  useEffect(() => {
    const finishDrag = () => {
      dragAnchor.current = null
    }
    document.addEventListener('mouseup', finishDrag)
    return () => document.removeEventListener('mouseup', finishDrag)
  }, [])

  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const gridStart = addDays(first, -first.getDay())
  const days = Array.from({ length: 42 }, (_, index) => addDays(gridStart, index))
  const shown = preview ?? value

  const commit = (from: string, to: string) => {
    const range = normalize(from, to)
    clickAnchor.current = null
    dragAnchor.current = null
    setPreview(range)
    onSelect(range)
  }

  return (
    <div className="range-calendar" aria-label="Date range calendar">
      <div className="calendar-head">
        <button
          type="button"
          className="calendar-nav"
          aria-label="Previous month"
          onClick={() => setMonth(current => new Date(current.getFullYear(), current.getMonth() - 1, 1))}
        >
          ‹
        </button>
        <strong>{month.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</strong>
        <button
          type="button"
          className="calendar-nav"
          aria-label="Next month"
          disabled={month.getFullYear() === today.getFullYear() && month.getMonth() === today.getMonth()}
          onClick={() => setMonth(current => new Date(current.getFullYear(), current.getMonth() + 1, 1))}
        >
          ›
        </button>
      </div>
      <div className="calendar-grid">
        {WEEKDAYS.map(day => <span className="calendar-weekday" key={day}>{day}</span>)}
        {days.map(day => {
          const key = dateKey(day)
          const outside = day.getMonth() !== month.getMonth()
          const disabled = key > todayKey
          const endpoint = shown ? key === shown.from || key === shown.to : false
          const inRange = shown ? key >= shown.from && key <= shown.to : false
          const className = [
            'calendar-day',
            outside ? 'outside' : '',
            inRange ? 'in-range' : '',
            endpoint ? 'endpoint' : '',
          ].filter(Boolean).join(' ')

          return (
            <button
              type="button"
              key={key}
              className={className}
              disabled={disabled}
              aria-label={day.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
              onMouseDown={event => {
                event.preventDefault()
                dragAnchor.current = key
                if (!clickAnchor.current) setPreview({ from: key, to: key })
              }}
              onMouseEnter={() => {
                if (dragAnchor.current) setPreview(normalize(dragAnchor.current, key))
              }}
              onMouseUp={() => {
                const start = dragAnchor.current
                if (start && start !== key) {
                  commit(start, key)
                } else if (clickAnchor.current) {
                  commit(clickAnchor.current, key)
                } else {
                  clickAnchor.current = key
                  dragAnchor.current = null
                  setPreview({ from: key, to: key })
                }
              }}
            >
              {day.getDate()}
            </button>
          )
        })}
      </div>
    </div>
  )
}

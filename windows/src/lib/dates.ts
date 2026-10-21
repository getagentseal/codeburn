/// All calendar math is in the machine's local time zone. The CLI buckets `history.daily`
/// by local date, so "today" here must be the same local day or the trend chart and the
/// hero disagree around midnight.

import { localeTag, t } from '../i18n'

export const MS_PER_DAY = 86_400_000

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

export function todayKey(): string {
  return formatDateKey(new Date())
}

export function formatDateKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

export function parseDateKey(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function addDays(d: Date, n: number): Date {
  const r = new Date(d.getTime())
  r.setDate(r.getDate() + n)
  return r
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

export function prettyDate(ymd: string): string {
  return parseDateKey(ymd).toLocaleDateString(localeTag(), { weekday: 'short', month: 'short', day: 'numeric' })
}

export function monthDay(ymd: string): string {
  return parseDateKey(ymd).toLocaleDateString(localeTag(), { month: 'short', day: 'numeric' })
}

export function shortDate(ymd: string): string {
  const parts = ymd.split('-')
  return `${parts[1]}/${parts[2]}`
}

export function firstOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

export function daysInMonth(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
}

export function dayOfMonth(d: Date): number {
  return d.getDate()
}

export function previousMonthRange(d: Date): { first: string; last: string } {
  const first = new Date(d.getFullYear(), d.getMonth() - 1, 1)
  const last = new Date(d.getFullYear(), d.getMonth(), 0)
  return { first: formatDateKey(first), last: formatDateKey(last) }
}

/// "in 42m", "in 3h", "in 2d", or "now".
export function relativeFuture(target: Date, now = new Date()): string {
  const secs = (target.getTime() - now.getTime()) / 1000
  if (secs <= 0) return t('now')
  if (secs < 3600) return t('in %lldm', Math.ceil(secs / 60))
  if (secs < 86_400) return t('in %lldh', Math.ceil(secs / 3600))
  return t('in %lldd', Math.ceil(secs / 86_400))
}

/// "just now", "2 min ago", "1 h ago".
export function relativePast(target: Date, now = new Date()): string {
  const secs = Math.max(0, (now.getTime() - target.getTime()) / 1000)
  if (secs < 45) return t('just now')
  if (secs < 3600) return t('%lldm ago', Math.round(secs / 60))
  if (secs < 86_400) return t('%lldh ago', Math.round(secs / 3600))
  return t('%lldd ago', Math.round(secs / 86_400))
}

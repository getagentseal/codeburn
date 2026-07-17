import { Fragment, useEffect, useMemo, useState } from 'react'

import { CliErrorPanel } from '../components/CliErrorPanel'
import { EmptyNote } from '../components/EmptyState'
import { Panel } from '../components/Panel'
import { ProviderLogo } from '../components/ProviderLogo'
import { SectionSkeleton } from '../components/Skeleton'
import { SegTabs } from '../components/SegTabs'
import { StaleBanner } from '../components/StaleBanner'
import { Stat } from '../components/Stat'
import { usePolled } from '../hooks/usePolled'
import { formatCompact, formatDayLong, formatDayShort, formatDuration, formatUsd, shortenProjectPath } from '../lib/format'
import { codeburn } from '../lib/ipc'
import type { DateRange, Period, SessionRow } from '../lib/types'

export const INITIAL_VISIBLE = 120
const STEP = 120

type SessionSort = 'cost' | 'recent' | 'turns' | 'tokens'
type SequenceEntry =
  | { type: 'header'; provider: string; count: number; cost: number }
  | { type: 'row'; row: SessionRow }

const SORT_OPTIONS = [
  { value: 'cost', label: 'Cost' },
  { value: 'recent', label: 'Recent' },
  { value: 'turns', label: 'Turns' },
  { value: 'tokens', label: 'Tokens' },
]

function providerName(provider: string): string {
  return provider
    .split(/[-\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function endedAtTime(row: SessionRow): number {
  const time = new Date(row.endedAt).getTime()
  return Number.isNaN(time) ? 0 : time
}

function compareRows(sort: SessionSort, a: SessionRow, b: SessionRow): number {
  if (sort === 'cost') return b.cost - a.cost
  if (sort === 'turns') return b.turns - a.turns
  if (sort === 'tokens') {
    return (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens)
  }
  return endedAtTime(b) - endedAtTime(a)
}

function groupSortValue(sort: SessionSort, rows: SessionRow[]): number {
  if (sort === 'cost') return rows.reduce((sum, row) => sum + row.cost, 0)
  if (sort === 'turns') return rows.reduce((sum, row) => sum + row.turns, 0)
  if (sort === 'tokens') {
    return rows.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0)
  }
  return rows.reduce((latest, row) => Math.max(latest, endedAtTime(row)), 0)
}

function ProviderFilterRow({
  provider,
  detectedProviders,
  onProviderChange,
}: {
  provider: string
  detectedProviders: Array<{ id: string; label: string }>
  onProviderChange: (value: string) => void
}) {
  if (detectedProviders.length === 0) return null
  return (
    <div className="seg session-provider-filter" role="group" aria-label="Filter sessions by provider">
      <button
        type="button"
        className={provider === 'all' ? 'on' : undefined}
        aria-pressed={provider === 'all'}
        onClick={() => onProviderChange('all')}
      >
        All
      </button>
      {detectedProviders.map(entry => (
        <button
          key={entry.id}
          type="button"
          className={provider === entry.id ? 'on' : undefined}
          aria-pressed={provider === entry.id}
          onClick={() => onProviderChange(entry.id)}
        >
          <ProviderLogo provider={entry.id} size={14} />
          {entry.label}
        </button>
      ))}
    </div>
  )
}

export function Sessions({
  period,
  provider,
  range = null,
  refreshToken = 0,
  detectedProviders = [],
  onProviderChange = () => {},
  ready = true,
}: {
  period: Period
  provider: string
  range?: DateRange | null
  refreshToken?: number
  detectedProviders?: Array<{ id: string; label: string }>
  onProviderChange?: (value: string) => void
  ready?: boolean
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SessionSort>('cost')
  const [grouped, setGrouped] = useState(true)
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE)
  const report = usePolled<SessionRow[]>(
    () => range ? codeburn.getSessions(period, provider, range) : codeburn.getSessions(period, provider),
    [period, provider, range?.from, range?.to, refreshToken],
    { enabled: ready, memoKey: `sessions|${period}|${provider}|${range?.from ?? ''}-${range?.to ?? ''}` },
  )
  const rows = report.data ?? []
  const q = query.trim().toLowerCase()
  const filtered = rows.filter(row => q === '' || [
    row.project,
    row.sessionId,
    row.models.join(' '),
  ].some(value => value.toLowerCase().includes(q)))

  useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE)
  }, [query, sort, grouped, report.data])

  const sequence = useMemo<SequenceEntry[]>(() => {
    if (!grouped) {
      return [...filtered]
        .sort((a, b) => compareRows(sort, a, b))
        .map(row => ({ type: 'row' as const, row }))
    }

    const byProvider = filtered.reduce((map, row) => {
      const providerRows = map.get(row.provider) ?? []
      providerRows.push(row)
      map.set(row.provider, providerRows)
      return map
    }, new Map<string, SessionRow[]>())

    return [...byProvider.entries()]
      .map(([providerName, providerRows]) => ({
        provider: providerName,
        rows: [...providerRows].sort((a, b) => compareRows(sort, a, b)),
        cost: providerRows.reduce((sum, row) => sum + row.cost, 0),
        sortValue: groupSortValue(sort, providerRows),
      }))
      .sort((a, b) => b.sortValue - a.sortValue || a.provider.localeCompare(b.provider))
      .flatMap(group => [
        { type: 'header' as const, provider: group.provider, count: group.rows.length, cost: group.cost },
        ...group.rows.map(row => ({ type: 'row' as const, row })),
      ])
  }, [filtered, grouped, sort])

  const renderedSequence: SequenceEntry[] = []
  let renderedRows = 0
  let pendingHeader: SequenceEntry | null = null
  for (const entry of sequence) {
    if (entry.type === 'header') {
      pendingHeader = entry
      continue
    }
    if (renderedRows >= visibleCount) break
    if (pendingHeader) {
      renderedSequence.push(pendingHeader)
      pendingHeader = null
    }
    renderedSequence.push(entry)
    renderedRows++
  }

  if (!report.data) {
    if (report.error) return <CliErrorPanel error={report.error} subject="sessions" />
    return <SectionSkeleton label="Scanning sessions…" rows={5} />
  }

  if (!report.data.length) {
    return (
      <Panel title="Sessions">
        <ProviderFilterRow provider={provider} detectedProviders={detectedProviders} onProviderChange={onProviderChange} />
        <EmptyNote>No sessions in this range yet.</EmptyNote>
      </Panel>
    )
  }

  const totalCost = filtered.reduce((sum, row) => sum + row.cost, 0)
  const totalTokens = filtered.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0)
  const remaining = filtered.length - renderedRows

  return (
    <div className="sessions-list-view">
      {report.error && <StaleBanner error={report.error} />}
      <ProviderFilterRow provider={provider} detectedProviders={detectedProviders} onProviderChange={onProviderChange} />
      <div className="sessions-toolbar">
        <input
          className="sessions-search"
          aria-label="Search sessions"
          placeholder="Search project, model, or id…"
          value={query}
          onChange={event => setQuery(event.target.value)}
        />
        <SegTabs
          options={SORT_OPTIONS}
          value={sort}
          onChange={value => setSort(value as SessionSort)}
        />
        <button
          className="sessions-toggle"
          type="button"
          aria-pressed={grouped}
          onClick={() => setGrouped(value => !value)}
        >
          Group by provider
        </button>
      </div>
      <div className="sessions-summary">
        {filtered.length} sessions · {formatUsd(totalCost)} · {formatCompact(totalTokens)} tokens
      </div>
      {filtered.length === 0 ? (
        <div className="sessions-empty">
          <EmptyNote>No sessions match &quot;{query}&quot;.</EmptyNote>
          <button className="sessions-clear" type="button" onClick={() => setQuery('')}>Clear search</button>
        </div>
      ) : (
        <>
          <div className="session-list">
            {renderedSequence.map(entry => entry.type === 'header' ? (
              <div className="provider-h" key={`provider-${entry.provider}`}>
                <span>{providerName(entry.provider)}</span>
                <span className="provider-count">{entry.count.toLocaleString('en-US')} sessions</span>
                <span className="provider-cost">{formatUsd(entry.cost)}</span>
              </div>
            ) : (
              <Fragment key={entry.row.sessionId}>
                <button
                  className="session-row"
                  type="button"
                  aria-expanded={selectedId === entry.row.sessionId}
                  onClick={() => setSelectedId(current => current === entry.row.sessionId ? null : entry.row.sessionId)}
                >
                  <span className="session-primary">
                    <span className="session-chevron" aria-hidden="true">›</span>
                    <span className="session-project-copy">
                      <span className="session-title">{shortenProjectPath(entry.row.project)}</span>
                      <span className="session-project">{entry.row.sessionId.slice(0, 18)}</span>
                    </span>
                  </span>
                  <span className="session-when">{formatDayShort(entry.row.endedAt)}</span>
                  <span className="session-models">{entry.row.models.join(', ')}</span>
                  <span>{entry.row.turns}</span>
                  <span>{formatUsd(entry.row.cost)}</span>
                  <span>{formatCompact(entry.row.inputTokens + entry.row.outputTokens)}</span>
                </button>
                {selectedId === entry.row.sessionId && (
                  <SessionDetail session={entry.row} onCollapse={() => setSelectedId(null)} />
                )}
              </Fragment>
            ))}
          </div>
          <div className="sessions-more-caption">Showing {renderedRows} of {filtered.length}</div>
          {remaining > 0 && (
            <button className="sessions-more" type="button" onClick={() => setVisibleCount(value => value + STEP)}>
              Show {Math.min(STEP, remaining)} more · {remaining} remaining
            </button>
          )}
        </>
      )}
    </div>
  )
}

function SessionDetail({ session, onCollapse }: { session: SessionRow; onCollapse: () => void }) {
  const cacheTotal = session.inputTokens + session.cacheReadTokens
  const cacheHit = cacheTotal > 0 ? Math.round(session.cacheReadTokens / cacheTotal * 100) : 0

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCollapse()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onCollapse])

  return (
    <div className="session-inline-detail" role="region" aria-label={`${shortenProjectPath(session.project)} session details`}>
      <div className="detail-head">
        <h3 className="detail-title">{shortenProjectPath(session.project)}</h3>
        <div className="detail-line">{session.provider} · {session.models.join(', ')}</div>
        <div className="detail-line">
          {formatDayLong(session.startedAt)} → {formatDayLong(session.endedAt)} · {formatDuration(session.durationMs)}
        </div>
      </div>
      <div className="stats">
        <Stat label="Cost" value={formatUsd(session.cost)} delta="this session" />
        <Stat label="Calls" value={session.calls.toLocaleString()} delta="API calls" />
        <Stat label="Turns" value={session.turns.toLocaleString()} delta="assistant turns" />
        <Stat label="Saved" value={formatUsd(session.savingsUSD)} delta="vs baseline" />
        <Stat label="Input" value={formatCompact(session.inputTokens)} delta="tokens sent" />
        <Stat label="Output" value={formatCompact(session.outputTokens)} delta="tokens generated" />
        <Stat label="Cache read" value={formatCompact(session.cacheReadTokens)} delta={`${cacheHit}% hit`} />
        <Stat label="Cache write" value={formatCompact(session.cacheWriteTokens)} delta="tokens cached" />
      </div>
    </div>
  )
}

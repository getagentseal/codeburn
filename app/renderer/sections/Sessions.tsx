import { Fragment, useEffect, useMemo, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'

import { CliErrorPanel } from '../components/CliErrorPanel'
import { EmptyNote } from '../components/EmptyState'
import { Panel } from '../components/Panel'
import { ProviderLogo } from '../components/ProviderLogo'
import { SectionSkeleton } from '../components/Skeleton'
import { SegTabs } from '../components/SegTabs'
import { StaleBanner } from '../components/StaleBanner'
import { Stat } from '../components/Stat'
import { SwitchingBanner } from '../components/SwitchingBanner'
import { usePolled } from '../hooks/usePolled'
import { formatCompact, formatDayLong, formatDayShort, formatDuration, formatUsd, shortenProjectPath } from '../lib/format'
import { codeburn } from '../lib/ipc'
import { reportMemoKey } from '../lib/reportMemoKey'
import { buildWorkUnitEntries, rowKey, sortWorkUnitEntries, summarizeWorkUnitEntries } from '../lib/workUnits'
import type { DateRange, Period, SessionRow, WorkUnitReport } from '../lib/types'
import type { WorkUnitSort } from '../lib/workUnits'

export const INITIAL_VISIBLE = 120
const STEP = 120

type SessionSort = 'cost' | 'recent' | 'turns' | 'tokens'
// flat = the plain list; provider = the list under provider headers;
// agents = sessions grouped by provider-recorded orchestration (work units).
type SessionView = 'flat' | 'provider' | 'agents'
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
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SessionSort>('cost')
  const [view, setView] = useState<SessionView>('provider')
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE)
  const report = usePolled<SessionRow[]>(
    () => range ? codeburn.getSessions(period, provider, range) : codeburn.getSessions(period, provider),
    [period, provider, range?.from, range?.to, refreshToken],
    { enabled: ready && view !== 'agents', memoKey: reportMemoKey('sessions', period, provider, range) },
  )
  const workUnits = usePolled<WorkUnitReport>(
    () => range ? codeburn.getWorkUnits(period, provider, range) : codeburn.getWorkUnits(period, provider),
    [period, provider, range?.from, range?.to, refreshToken],
    { enabled: ready && view === 'agents', memoKey: reportMemoKey('work-units', period, provider, range) },
  )
  const rows = report.data ?? []
  const q = query.trim().toLowerCase()
  const filtered = rows.filter(row => q === '' || [
    row.title ?? '',
    row.project,
    row.sessionId,
    row.models.join(' '),
    row.agentType ?? '',
  ].some(value => value.toLowerCase().includes(q)))

  // A population switch (period/provider/range/refresh) must never leave a
  // detail or expansion open over members that are no longer on screen.
  useEffect(() => {
    setSelectedKey(null)
    setExpandedKey(null)
  }, [period, provider, range?.from, range?.to, refreshToken])

  useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE)
  }, [query, sort, view, report.data, workUnits.data])

  const sequence = useMemo<SequenceEntry[]>(() => {
    if (view === 'agents') return []
    if (view === 'flat') {
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
  }, [filtered, view, sort])

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

  if (view !== 'agents') {
    if (!report.data) {
      if (report.error) return <CliErrorPanel error={report.error} subject="sessions" />
      return <SectionSkeleton label="Scanning sessions…" rows={5} />
    }

    if (!report.data.length) {
      return (
        <>
          {report.switching && <SwitchingBanner />}
          <Panel title="Sessions">
            <ProviderFilterRow provider={provider} detectedProviders={detectedProviders} onProviderChange={onProviderChange} />
            <EmptyNote>No sessions in this range yet.</EmptyNote>
          </Panel>
        </>
      )
    }
  }

  if (view === 'agents') {
    return (
      <div className="sessions-list-view">
        {workUnits.switching && <SwitchingBanner />}
        {workUnits.error && <StaleBanner error={workUnits.error} />}
        <ProviderFilterRow provider={provider} detectedProviders={detectedProviders} onProviderChange={onProviderChange} />
        <SessionsToolbar
          query={query}
          onQuery={setQuery}
          sort={sort}
          onSort={value => setSort(value as SessionSort)}
          view={view}
          onView={setView}
        />
        {!workUnits.data ? (
          workUnits.error
            ? <CliErrorPanel error={workUnits.error} subject="session groups" />
            : <SectionSkeleton label="Scanning sessions…" rows={5} />
        ) : (
          <WorkUnitList
            report={workUnits.data}
            query={q}
            sort={sort}
            visibleCount={visibleCount}
            onShowMore={() => setVisibleCount(count => count + STEP)}
            selectedKey={selectedKey}
            onSelect={setSelectedKey}
            expandedKey={expandedKey}
            onToggleExpand={setExpandedKey}
            onClearSearch={() => setQuery('')}
          />
        )}
      </div>
    )
  }

  const totalCost = filtered.reduce((sum, row) => sum + row.cost, 0)
  const totalTokens = filtered.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0)
  const remaining = filtered.length - renderedRows

  return (
    <div className="sessions-list-view">
      {report.switching && <SwitchingBanner />}
      {report.error && <StaleBanner error={report.error} />}
      <ProviderFilterRow provider={provider} detectedProviders={detectedProviders} onProviderChange={onProviderChange} />
      <SessionsToolbar
        query={query}
        onQuery={setQuery}
        sort={sort}
        onSort={value => setSort(value as SessionSort)}
        view={view}
        onView={setView}
      />
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
                <span>{entry.count.toLocaleString('en-US')} sessions</span>
                <span className="provider-cost">{formatUsd(entry.cost)}</span>
              </div>
            ) : (
              <Fragment key={rowKey(entry.row)}>
                <button
                  className="session-row"
                  type="button"
                  aria-expanded={selectedKey === rowKey(entry.row)}
                  onClick={() => setSelectedKey(current => current === rowKey(entry.row) ? null : rowKey(entry.row))}
                >
                  <span className="session-primary">
                    <span className="session-chevron" aria-hidden="true">›</span>
                    <span className="session-project-copy">
                      <span className="session-title" title={entry.row.title || undefined}>{entry.row.title || shortenProjectPath(entry.row.project)}</span>
                      <span className="session-project">{entry.row.sessionId.slice(0, 18)}</span>
                    </span>
                  </span>
                  <span className="session-when">{formatDayShort(entry.row.endedAt)}</span>
                  <span className="session-models">{entry.row.models.join(', ')}</span>
                  <span>{entry.row.turns}</span>
                  <span>{formatUsd(entry.row.cost)}</span>
                  <span>{formatCompact(entry.row.inputTokens + entry.row.outputTokens)}</span>
                </button>
                {selectedKey === rowKey(entry.row) && (
                  <SessionDetail session={entry.row} onCollapse={() => setSelectedKey(null)} />
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

function SessionsToolbar({
  query,
  onQuery,
  sort,
  onSort,
  view,
  onView,
}: {
  query: string
  onQuery: (value: string) => void
  sort: SessionSort
  onSort: (value: string) => void
  view: SessionView
  onView: (view: SessionView) => void
}) {
  return (
    <div className="sessions-toolbar" role="group" aria-label="Session list controls">
      <input
        className="sessions-search"
        aria-label="Search sessions"
        placeholder="Search project, model, or id…"
        value={query}
        onChange={event => onQuery(event.target.value)}
      />
      <SegTabs
        options={SORT_OPTIONS}
        value={sort}
        onChange={onSort}
      />
      <button
        className="sessions-toggle"
        type="button"
        aria-pressed={view === 'provider'}
        onClick={() => onView(view === 'provider' ? 'flat' : 'provider')}
      >
        Group by provider
      </button>
      <button
        className="sessions-toggle"
        type="button"
        aria-pressed={view === 'agents'}
        onClick={() => onView(view === 'agents' ? 'flat' : 'agents')}
      >
        Group by work units
      </button>
    </div>
  )
}

/// The member label is only ever what the data records: the provider's
/// subagent type when it captured one, otherwise the resolver role. Nothing is
/// invented for providers that have no agent-type notion.
function memberAgentLabel(row: SessionRow, role: 'root' | 'child' | 'unknown' | undefined): string {
  if (row.agentType) return row.agentType
  if (role === 'root') return 'root session'
  if (role === 'child') return 'subagent'
  return 'session'
}

function WorkUnitList({
  report,
  query,
  sort,
  visibleCount,
  onShowMore,
  selectedKey,
  onSelect,
  expandedKey,
  onToggleExpand,
  onClearSearch,
}: {
  report: WorkUnitReport
  query: string
  sort: SessionSort
  visibleCount: number
  onShowMore: () => void
  selectedKey: string | null
  onSelect: Dispatch<SetStateAction<string | null>>
  expandedKey: string | null
  onToggleExpand: Dispatch<SetStateAction<string | null>>
  onClearSearch: () => void
}) {
  // The CLI is the sole authority on lineage: an envelope without workUnits
  // (an older staged CLI) degrades to the plain list instead of pretending.
  const units = Array.isArray(report.workUnits) ? report.workUnits : []

  const matches = useMemo(() => (row: SessionRow): boolean => query === '' || [
    row.title ?? '',
    row.project,
    row.sessionId,
    row.models.join(' '),
    row.agentType ?? '',
  ].some(value => value.toLowerCase().includes(query)), [query])

  const sortedEntries = useMemo(
    () => sortWorkUnitEntries(buildWorkUnitEntries(report.sessions, units, matches), sort as WorkUnitSort),
    [report.sessions, units, matches, sort],
  )
  const summary = summarizeWorkUnitEntries(sortedEntries)
  const visibleEntries = sortedEntries.slice(0, visibleCount)
  const remaining = sortedEntries.length - visibleEntries.length
  const groupCount = sortedEntries.filter(entry => entry.kind === 'group' && entry.children.length > 0).length

  if (!report.sessions.length) {
    return (
      <>
        <div className="sessions-summary">0 sessions</div>
        <Panel title="Sessions">
          <EmptyNote>No sessions in this range yet.</EmptyNote>
        </Panel>
      </>
    )
  }

  return (
    <>
      <div className="sessions-summary">
        {summary.sessions.toLocaleString('en-US')} session{summary.sessions === 1 ? '' : 's'} · {groupCount.toLocaleString('en-US')} group{groupCount === 1 ? '' : 's'} · {formatUsd(summary.cost)} · {formatCompact(summary.tokens)} tokens
      </div>
      {sortedEntries.length === 0 ? (
        <div className="sessions-empty">
          <EmptyNote>No sessions match &quot;{query}&quot;.</EmptyNote>
          <button className="sessions-clear" type="button" onClick={onClearSearch}>Clear search</button>
        </div>
      ) : (
        <>
          <div className="session-list">
            {visibleEntries.map(entry => entry.kind === 'group' ? (
              <Fragment key={entry.key}>
                <button
                  className="session-row work-unit-row"
                  type="button"
                  aria-expanded={expandedKey === entry.key}
                  aria-controls={`work-unit-${entry.key}`}
                  onClick={() => {
                    onSelect(null)
                    onToggleExpand(expandedKey === entry.key ? null : entry.key)
                  }}
                >
                  <span className="session-primary">
                    <span className="session-chevron" aria-hidden="true">›</span>
                    <span className="session-project-copy">
                      <span className="session-title" title={entry.root.title || undefined}>{entry.root.title || shortenProjectPath(entry.root.project)}</span>
                      <span className="session-project">
                        {shortenProjectPath(entry.root.project)} · {entry.children.length} agent{entry.children.length === 1 ? '' : 's'} · root {formatUsd(entry.rootCost)} + agents {formatUsd(entry.childrenCost)}
                      </span>
                    </span>
                  </span>
                  <span className="session-when">{formatDayShort(entry.row.endedAt)}</span>
                  <span className="session-models">{entry.row.models.join(', ')}</span>
                  <span>{entry.row.turns}</span>
                  <span>{formatUsd(entry.row.cost)}</span>
                  <span>{formatCompact(entry.row.inputTokens + entry.row.outputTokens)}</span>
                </button>
                {expandedKey === entry.key && (
                  <div className="work-unit-members" id={`work-unit-${entry.key}`} role="region" aria-label={`${entry.root.title || shortenProjectPath(entry.root.project)} group members`}>
                    {[entry.root, ...entry.children].map(member => {
                      const key = rowKey(member)
                      const role = member === entry.root ? 'root' as const : 'child' as const
                      return (
                        <Fragment key={key}>
                          <button
                            className="session-row member-row"
                            type="button"
                            aria-expanded={selectedKey === key}
                            onClick={() => onSelect(current => current === key ? null : key)}
                          >
                            <span className="session-primary">
                              <span className="session-chevron member-chevron" aria-hidden="true">↳</span>
                              <span className="session-project-copy">
                                <span className="session-title" title={member.title || undefined}>{member.title || shortenProjectPath(member.project)}</span>
                                <span className="session-project">
                                  {memberAgentLabel(member, role)}
                                  {query !== '' && entry.matchedMemberKeys.has(key) && <span className="member-match"> · search match</span>}
                                </span>
                              </span>
                            </span>
                            <span className="session-when">{formatDayShort(member.endedAt)}</span>
                            <span className="session-models">{member.models.join(', ')}</span>
                            <span>{member.turns}</span>
                            <span>{formatUsd(member.cost)}</span>
                            <span>{formatCompact(member.inputTokens + member.outputTokens)}</span>
                          </button>
                          {selectedKey === key && (
                            <SessionDetail session={member} onCollapse={() => onSelect(null)} />
                          )}
                        </Fragment>
                      )
                    })}
                  </div>
                )}
              </Fragment>
            ) : (
              <Fragment key={entry.key}>
                <button
                  className="session-row"
                  type="button"
                  aria-expanded={selectedKey === entry.key}
                  onClick={() => onSelect(current => current === entry.key ? null : entry.key)}
                >
                  <span className="session-primary">
                    <span className="session-chevron" aria-hidden="true">›</span>
                    <span className="session-project-copy">
                      <span className="session-title" title={entry.root.title || undefined}>{entry.root.title || shortenProjectPath(entry.root.project)}</span>
                      <span className="session-project">{entry.root.sessionId.slice(0, 18)}</span>
                    </span>
                  </span>
                  <span className="session-when">{formatDayShort(entry.row.endedAt)}</span>
                  <span className="session-models">{entry.row.models.join(', ')}</span>
                  <span>{entry.row.turns}</span>
                  <span>{formatUsd(entry.row.cost)}</span>
                  <span>{formatCompact(entry.row.inputTokens + entry.row.outputTokens)}</span>
                </button>
                {selectedKey === entry.key && (
                  <SessionDetail session={entry.root} onCollapse={() => onSelect(null)} />
                )}
              </Fragment>
            ))}
          </div>
          {groupCount === 0 && (
            <div className="sessions-more-caption">
              No agent groups in this range — sessions without recorded lineage stay standalone.
            </div>
          )}
          <div className="sessions-more-caption">Showing {visibleEntries.length} of {sortedEntries.length}</div>
          {remaining > 0 && (
            <button className="sessions-more" type="button" onClick={onShowMore}>
              Show {Math.min(STEP, remaining)} more · {remaining} remaining
            </button>
          )}
        </>
      )}
    </>
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

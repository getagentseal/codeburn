import { Fragment, useEffect, useMemo, useRef, useState } from 'react'

import { CliErrorPanel } from '../components/CliErrorPanel'
import { EmptyNote } from '../components/EmptyState'
import { FilterChips } from '../components/FilterChips'
import { Panel } from '../components/Panel'
import { ProviderLogo } from '../components/ProviderLogo'
import { SectionSkeleton } from '../components/Skeleton'
import { SegTabs } from '../components/SegTabs'
import { SessionDrawer } from '../components/SessionDrawer'
import { StaleBanner } from '../components/StaleBanner'
import { SwitchingBanner } from '../components/SwitchingBanner'
import { usePolled } from '../hooks/usePolled'
import { formatCompact, formatDayShort, formatUsd, shortenProjectPath } from '../lib/format'
import { codeburn } from '../lib/ipc'
import {
  applyInvestigation,
  EMPTY_FILTERS,
  filtersActive,
  filtersToKey,
  type IncludedRow,
  type InvestigationFilters,
} from '../lib/investigation'
import { reportMemoKey } from '../lib/reportMemoKey'
import type { DateRange, Period, SessionDrillRow, SessionRow } from '../lib/types'

export const INITIAL_VISIBLE = 120
const STEP = 120

export type SessionSort = 'cost' | 'recent' | 'turns' | 'tokens'

const SORT_OPTIONS = [
  { value: 'cost', label: 'Cost' },
  { value: 'recent', label: 'Recent' },
  { value: 'turns', label: 'Turns' },
  { value: 'tokens', label: 'Tokens' },
]

/** Composite identity of a session row: provider + project + sessionId. An id
 *  alone is not globally unique (another provider, or an imported transcript,
 *  can reuse it), so drawer selection and history restore key on the triple. */
export function sessionRowKey(row: Pick<SessionRow, 'provider' | 'project' | 'sessionId'>): string {
  return `${row.provider}\u0000${row.project}\u0000${row.sessionId}`
}

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

function rowTokens(row: SessionRow): number {
  return row.inputTokens + row.outputTokens
}

/** Under a selection the Cost column (and the sort) mean the row's
 *  CONTRIBUTION to the selection; otherwise the plain row cost. */
function entryCost(entry: IncludedRow, filtered: boolean): number {
  return filtered ? entry.cost : entry.row.cost
}

function compareEntries(sort: SessionSort, filtered: boolean, a: IncludedRow, b: IncludedRow): number {
  if (sort === 'cost') return entryCost(b, filtered) - entryCost(a, filtered)
  if (sort === 'turns') return b.row.turns - a.row.turns
  if (sort === 'tokens') return rowTokens(b.row) - rowTokens(a.row)
  return endedAtTime(b.row) - endedAtTime(a.row)
}

function groupSortValue(sort: SessionSort, filtered: boolean, entries: IncludedRow[]): number {
  if (sort === 'cost') return entries.reduce((sum, entry) => sum + entryCost(entry, filtered), 0)
  if (sort === 'turns') return entries.reduce((sum, entry) => sum + entry.row.turns, 0)
  if (sort === 'tokens') return entries.reduce((sum, entry) => sum + rowTokens(entry.row), 0)
  return entries.reduce((latest, entry) => Math.max(latest, endedAtTime(entry.row)), 0)
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
  filters = EMPTY_FILTERS,
  onFiltersChange,
  openSessionId,
  onSessionOpen,
  onSessionClose,
  sort: controlledSort,
  onSortChange,
  visibleCount: controlledVisibleCount,
  onVisibleCountChange,
}: {
  period: Period
  provider: string
  range?: DateRange | null
  refreshToken?: number
  detectedProviders?: Array<{ id: string; label: string }>
  onProviderChange?: (value: string) => void
  ready?: boolean
  /** Shared investigation selection (drill-through). Optional so standalone
   *  renders keep working unfiltered. */
  filters?: InvestigationFilters
  onFiltersChange?: (next: InvestigationFilters) => void
  /** Composite sessionRowKey of the open drawer (controlled). Falls back to
   *  internal state when the app does not own it. */
  openSessionId?: string | null
  onSessionOpen?: (key: string) => void
  onSessionClose?: () => void
  /** Controlled sort/pagination depth (restorable via Back/Forward). Falls
   *  back to local state when the props are absent. */
  sort?: SessionSort
  onSortChange?: (sort: SessionSort) => void
  visibleCount?: number
  onVisibleCountChange?: (count: number) => void
}) {
  const [internalSort, setInternalSort] = useState<SessionSort>('cost')
  const sort = controlledSort ?? internalSort
  const setSort = (value: SessionSort) => {
    setInternalSort(value)
    onSortChange?.(value)
  }
  const [internalVisibleCount, setInternalVisibleCount] = useState(INITIAL_VISIBLE)
  const visibleCount = controlledVisibleCount ?? internalVisibleCount
  const setVisibleCount = (value: number) => {
    setInternalVisibleCount(value)
    onVisibleCountChange?.(value)
  }
  const [internalOpenSessionId, setInternalOpenSessionId] = useState<string | null>(null)
  const effectiveOpenSessionId = openSessionId !== undefined ? openSessionId : internalOpenSessionId
  const closeDrawer = () => {
    setInternalOpenSessionId(null)
    onSessionClose?.()
  }
  const [grouped, setGrouped] = useState(true)
  const [query, setQuery] = useState('')
  const investigating = filtersActive(filters)
  const filterKey = filtersToKey(filters)
  const lastOpenerRef = useRef<HTMLButtonElement | null>(null)

  const plainReport = usePolled<SessionRow[]>(
    () => range ? codeburn.getSessions(period, provider, range) : codeburn.getSessions(period, provider),
    [period, provider, range?.from, range?.to, refreshToken],
    { enabled: ready && !investigating, memoKey: reportMemoKey('sessions', period, provider, range) },
  )
  // The contributions report is fetched only while a selection is active: one
  // CLI read per population. The population must COVER the selection: a day
  // chip can point outside the top-bar period (the overview chart always
  // shows the trailing 30 days), so the fetch range widens to the selected
  // days. Every chip combination is then computed client-side over the FULL
  // population — a chip change never respawns the CLI, and usePolled's epoch
  // guard keeps a late response from painting under a newer selection.
  const fetchRange = useMemo<DateRange | null>(() => {
    if (filters.days.length === 0) return range ?? null
    const days = [...filters.days].sort()
    const from = [days[0]!, range?.from].filter((v): v is string => !!v).sort()[0]!
    const to = [days[days.length - 1]!, range?.to].filter((v): v is string => !!v).sort().at(-1)!
    return { from, to }
  }, [filters.days, range?.from, range?.to])
  const contributionReport = usePolled<SessionDrillRow[]>(
    () => fetchRange
      ? codeburn.getSessionsContributions(period, provider, fetchRange)
      : codeburn.getSessionsContributions(period, provider),
    [period, provider, fetchRange?.from, fetchRange?.to, refreshToken],
    { enabled: ready && investigating, memoKey: reportMemoKey('sessioncontrib-v2', period, provider, fetchRange) },
  )

  const report = investigating ? contributionReport : plainReport
  const rows = (report.data ?? []) as SessionDrillRow[]

  // Selection math over the full population, memoized on the normalized
  // selection key + the report identity.
  const selection = useMemo(() => applyInvestigation(rows, filters), [rows, filterKey])

  // The search box is a view-level narrowing on top of the selection (it is
  // not part of the investigation state): it filters the list AND the summary
  // totals, exactly like the pre-drill sessions list did.
  const q = query.trim().toLowerCase()
  const searched = useMemo(() => {
    if (q === '') return selection.included
    return selection.included.filter(({ row }) => [
      row.title ?? '',
      row.project,
      row.sessionId,
      row.models.join(' '),
    ].some(value => value.toLowerCase().includes(q)))
  }, [selection, q])

  const summary = useMemo(() => {
    if (investigating) {
      return {
        included: searched,
        cost: searched.reduce((sum, entry) => sum + entry.cost, 0),
        calls: searched.reduce((sum, entry) => sum + entry.calls, 0),
        tokens: searched.reduce((sum, entry) => sum + entry.tokens, 0),
        fullCost: searched.reduce((sum, entry) => sum + entry.row.cost, 0),
        unattributable: selection.unattributable,
      }
    }
    return {
      included: searched,
      cost: searched.reduce((sum, entry) => sum + entry.row.cost, 0),
      calls: 0,
      tokens: searched.reduce((sum, entry) => sum + rowTokens(entry.row), 0),
      fullCost: 0,
      unattributable: 0,
    }
  }, [investigating, searched, selection.unattributable])
  const included = summary.included

  useEffect(() => {
    setInternalVisibleCount(INITIAL_VISIBLE)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, sort, report.data, q])

  const sequence = useMemo(() => {
    const entries = included
    if (!grouped) {
      return [...entries]
        .sort((a, b) => compareEntries(sort, investigating, a, b))
        .map(entry => ({ type: 'row' as const, entry }))
    }

    const byProvider = entries.reduce((map, entry) => {
      const providerRows = map.get(entry.row.provider) ?? []
      providerRows.push(entry)
      map.set(entry.row.provider, providerRows)
      return map
    }, new Map<string, IncludedRow[]>())

    return [...byProvider.entries()]
      .map(([groupProvider, providerRows]) => ({
        provider: groupProvider,
        rows: [...providerRows].sort((a, b) => compareEntries(sort, investigating, a, b)),
        cost: providerRows.reduce((sum, entry) => sum + entryCost(entry, investigating), 0),
        sortValue: groupSortValue(sort, investigating, providerRows),
      }))
      .sort((a, b) => b.sortValue - a.sortValue || a.provider.localeCompare(b.provider))
      .flatMap(group => [
        { type: 'header' as const, provider: group.provider, count: group.rows.length, cost: group.cost },
        ...group.rows.map(entry => ({ type: 'row' as const, entry })),
      ])
  }, [included, grouped, sort, investigating])

  const renderedSequence: Array<SequenceEntry> = []
  let renderedRows = 0
  let pendingHeader: { type: 'header'; provider: string; count: number; cost: number } | null = null
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

  // Drawer validity: when the open session is no longer part of the loaded
  // population (data refreshed away, provider/project scope changed), the
  // drawer closes rather than showing a session that no longer reconciles.
  useEffect(() => {
    if (!effectiveOpenSessionId || !report.data) return
    const stillPresent = rows.some(row => sessionRowKey(row) === effectiveOpenSessionId)
    if (!stillPresent) closeDrawer()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveOpenSessionId, report.data, rows])

  // Focus returns to the row control that opened the drawer when it closes.
  useEffect(() => {
    if (effectiveOpenSessionId) return
    const opener = lastOpenerRef.current
    if (opener) {
      lastOpenerRef.current = null
      opener.focus()
    }
  }, [effectiveOpenSessionId])

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
          {investigating && <FilterChips filters={filters} onChange={next => onFiltersChange?.(next)} />}
          <EmptyNote>
            {investigating
              ? 'No sessions match the current selection. Remove a chip above to widen it.'
              : 'No sessions in this range yet.'}
          </EmptyNote>
        </Panel>
      </>
    )
  }

  const selectionCost = summary.cost
  const remaining = included.length - renderedRows
  const openRow = effectiveOpenSessionId ? rows.find(row => sessionRowKey(row) === effectiveOpenSessionId) ?? null : null

  return (
    <div className="sessions-list-view">
      {report.switching && <SwitchingBanner />}
      {report.error && <StaleBanner error={report.error} />}
      <ProviderFilterRow provider={provider} detectedProviders={detectedProviders} onProviderChange={onProviderChange} />
      {investigating && <FilterChips filters={filters} onChange={next => onFiltersChange?.(next)} />}
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
        {investigating
          ? (
              <>
                {included.length.toLocaleString('en-US')} sessions in selection · <strong>{formatUsd(selectionCost)}</strong> in selection
                {summary.fullCost > selectionCost + 1e-9 && <> · full cost of these sessions {formatUsd(summary.fullCost)}</>}
                {summary.tokens > 0 && <> · {formatCompact(summary.tokens)} tokens in selection</>}
                {summary.unattributable > 0 && (
                  <span className="sessions-unattributed"> · {summary.unattributable.toLocaleString('en-US')} {summary.unattributable === 1 ? 'session' : 'sessions'} could not be attributed to this selection</span>
                )}
              </>
            )
          : (
              <>
                {included.length} sessions · {formatUsd(selectionCost)} · {formatCompact(summary.tokens)} tokens
              </>
            )}
      </div>
      {included.length === 0 ? (
        <div className="sessions-empty">
          <EmptyNote>
            {investigating
              ? 'No sessions contribute to the current selection.'
              : q
                ? <>No sessions match &quot;{query}&quot;.</>
                : 'No sessions in this range yet.'}
          </EmptyNote>
          {investigating && onFiltersChange && (
            <button className="sessions-clear" type="button" onClick={() => onFiltersChange(EMPTY_FILTERS)}>Clear selection</button>
          )}
          {!investigating && q && (
            <button className="sessions-clear" type="button" onClick={() => setQuery('')}>Clear search</button>
          )}
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
              <Fragment key={sessionRowKey(entry.entry.row)}>
                <button
                  className="session-row"
                  type="button"
                  aria-expanded={effectiveOpenSessionId === sessionRowKey(entry.entry.row)}
                  onClick={event => {
                    lastOpenerRef.current = event.currentTarget
                    setInternalOpenSessionId(sessionRowKey(entry.entry.row))
                    onSessionOpen?.(sessionRowKey(entry.entry.row))
                  }}
                >
                  <span className="session-primary">
                    <span className="session-chevron" aria-hidden="true">›</span>
                    <span className="session-project-copy">
                      <span className="session-title" title={entry.entry.row.title || undefined}>{entry.entry.row.title || shortenProjectPath(entry.entry.row.project)}</span>
                      <span className="session-project">{entry.entry.row.sessionId.slice(0, 18)}</span>
                    </span>
                  </span>
                  <span className="session-when">{formatDayShort(entry.entry.row.endedAt)}</span>
                  <span className="session-models">{entry.entry.row.models.join(', ')}</span>
                  <span>{entry.entry.row.turns}</span>
                  {investigating ? (
                    <span className="session-cost-split">
                      <strong>{formatUsd(entry.entry.cost)}</strong>
                      {entry.entry.cost < entry.entry.row.cost - 1e-9 && (
                        <small title="Full cost of the whole session"> of {formatUsd(entry.entry.row.cost)}</small>
                      )}
                    </span>
                  ) : (
                    <span>{formatUsd(entry.entry.row.cost)}</span>
                  )}
                  <span>{formatCompact(rowTokens(entry.entry.row))}</span>
                </button>
              </Fragment>
            ))}
          </div>
          <div className="sessions-more-caption">Showing {renderedRows} of {included.length}</div>
          {remaining > 0 && (
            <button className="sessions-more" type="button" onClick={() => setVisibleCount(visibleCount + STEP)}>
              Show {Math.min(STEP, remaining)} more · {remaining} remaining
            </button>
          )}
        </>
      )}
      {openRow && (
        <SessionDrawer
          row={openRow}
          filters={filters}
          onClose={closeDrawer}
        />
      )}
    </div>
  )
}

type SequenceEntry =
  | { type: 'header'; provider: string; count: number; cost: number }
  | { type: 'row'; entry: IncludedRow }

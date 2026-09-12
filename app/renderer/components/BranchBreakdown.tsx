import { Fragment, useEffect, useState } from 'react'

import { CliErrorText } from './CliErrorPanel'
import { EmptyNote } from './EmptyState'
import { Dropdown } from './Dropdown'
import { ListRow } from './ListRow'
import { Panel } from './Panel'
import { SectionSkeleton } from './Skeleton'
import { usePolled } from '../hooks/usePolled'
import { formatCompact, formatDayShort, formatUsd } from '../lib/format'
import { codeburn } from '../lib/ipc'
import { reportMemoKey } from '../lib/reportMemoKey'
import type { BranchSpendProjectReport, BranchSpendReport, BranchSpendRow, BranchSpendSessionRow, BranchTokenSplit, DateRange, Period } from '../lib/types'

const ALL_PROJECTS = '__all__'

/// Row label for a session id, mirroring the CLI's shortSessionId conventions
/// (src/sessions-report.ts): agent/codex prefixes and UUID head…tail trimming.
/// A session id alone is not globally unique — it labels the row, the full id
/// stays in the detail view and the tooltip.
function shortSessionId(value: string): string {
  const id = value.trim()
  if (id.startsWith('agent-')) return `Agent ${id.slice(6, 14)}`
  if (id.startsWith('rollout-')) {
    const tail = id.match(/([0-9a-f]{8})-[0-9a-f-]{27,}$/i)?.[1]
    return `Codex ${tail ?? id.slice(-8)}`
  }
  if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id)) return `${id.slice(0, 8)}…${id.slice(-4)}`
  return id.length > 24 ? `${id.slice(0, 12)}…${id.slice(-6)}` : id || 'Unknown session'
}

/** "Jul 3" from an ISO timestamp; local noon keeps the calendar day stable. */
function activityDay(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return formatDayShort(d.toISOString())
}

/** One day collapses to its label, otherwise the two endpoints joined by "-". */
function activitySpan(first: string | null, last: string | null): string {
  const a = activityDay(first)
  const b = activityDay(last)
  if (a === '—' && b === '—') return '—'
  return a === b ? a : `${a} - ${b}`
}

function tokenSummary(tokens: BranchTokenSplit): string {
  return [
    `in ${formatCompact(tokens.inputTokens)}`,
    `out ${formatCompact(tokens.outputTokens)}`,
    ...(tokens.reasoningTokens > 0 ? [`reason ${formatCompact(tokens.reasoningTokens)}`] : []),
    `cacheR ${formatCompact(tokens.cacheReadTokens)}`,
    ...(tokens.cacheWriteTokens > 0 ? [`cacheW ${formatCompact(tokens.cacheWriteTokens)}`] : []),
  ].join(' · ')
}

/** The recorded historical working directory, shown under its display
 *  conventions: basename in the row, full path on the tooltip. */
function pathLabel(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.at(-1) || path
}

function BranchSessionDetail({ session }: { session: BranchSpendSessionRow }) {
  return (
    <div className="spend-proj-detail branch-session-detail" role="region" aria-label={`Session ${session.sessionId} detail`}>
      <div className="branch-detail-line"><span>Session</span><code>{session.sessionId}</code></div>
      <div className="branch-detail-line"><span>Provider</span><span>{session.provider}{session.isSidechain ? ' (subagent)' : ''}</span></div>
      <div className="branch-detail-line"><span>Working directory</span><span title={session.workingDirectory}>{session.workingDirectory ? pathLabel(session.workingDirectory) : 'Not recorded'}</span></div>
      <div className="branch-detail-line"><span>Models</span><span>{session.models.length ? session.models.join(', ') : '—'}</span></div>
      <div className="branch-detail-line"><span>Tokens</span><span>{tokenSummary(session.tokens)}</span></div>
      <div className="branch-detail-line"><span>Activity</span><span>{activitySpan(session.firstActive, session.lastActive)} · {session.calls.toLocaleString('en-US')} calls</span></div>
    </div>
  )
}

function BranchRowView({ row, index, showProject, expanded, onToggle }: {
  row: BranchSpendRow
  index: number
  showProject: boolean
  expanded: boolean
  onToggle: () => void
}) {
  const [openSession, setOpenSession] = useState<string | null>(null)
  // An expansion must never survive onto different data: the session ids here
  // belong to this report snapshot.
  useEffect(() => { setOpenSession(null) }, [row.projectId, row.branch])
  const title = showProject ? `${row.projectLabel} / ${row.branch ?? 'Unknown'}` : (row.branch ?? 'Unknown')
  return (
    <Fragment key={`${row.projectId}|${row.branch ?? '__unknown__'}`}>
      <ListRow
        no={String(index + 1).padStart(2, '0')}
        title={title}
        sub={`${row.sessions.toLocaleString('en-US')} ${row.sessions === 1 ? 'session' : 'sessions'} · ${row.calls.toLocaleString('en-US')} calls · ${activitySpan(row.firstActive, row.lastActive)}`}
        value={formatUsd(row.cost)}
        expanded={expanded}
        onClick={onToggle}
      />
      {expanded && (
        <div className="spend-proj-detail" role="region" aria-label={`${title} detail`}>
          <div className="branch-detail-line"><span>Tokens</span><span>{tokenSummary(row.tokens)}</span></div>
          {row.worktrees.map(wt => (
            <div className="branch-detail-line" key={wt.path}>
              <span>Worktree</span>
              <span title={wt.path}>{pathLabel(wt.path)} · {wt.sessions} {wt.sessions === 1 ? 'session' : 'sessions'} · {formatUsd(wt.cost)}</span>
            </div>
          ))}
          {row.sessionRows.map(session => {
            const sessionKey = `${row.projectId}|${row.branch}|${session.sessionId}`
            const open = openSession === sessionKey
            return (
              <Fragment key={sessionKey}>
                <div
                  className={open ? 'spend-proj-session li-clickable is-open-row' : 'spend-proj-session li-clickable'}
                  role="button"
                  tabIndex={0}
                  aria-expanded={open}
                  aria-label={`Inspect session ${session.title ?? session.sessionId}`}
                  onClick={() => setOpenSession(current => current === sessionKey ? null : sessionKey)}
                  onKeyDown={event => {
                    if (event.target !== event.currentTarget) return
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      setOpenSession(current => current === sessionKey ? null : sessionKey)
                    }
                  }}
                >
                  <span className="sps-date" title={session.sessionId}>{session.title ?? shortSessionId(session.sessionId)}</span>
                  <span className="sps-model">{session.models[0] ?? session.provider}</span>
                  <span className="sps-calls">{session.calls.toLocaleString('en-US')} calls</span>
                  <span className="sps-cost">{formatUsd(session.cost)}</span>
                </div>
                {open && <BranchSessionDetail session={session} />}
              </Fragment>
            )
          })}
          {row.sessionRows.length === 0 && <div className="spend-proj-empty">No session detail for this branch.</div>}
        </div>
      )}
    </Fragment>
  )
}

function CoverageNote({ scope }: { scope: BranchSpendProjectReport['coverage'] }) {
  const providers = scope.noBranchDataProviders
  return (
    <div className="branch-coverage" role="note" aria-label="Branch metadata coverage">
      <span>On branches {formatUsd(scope.branchKnownCost)}</span>
      <span>Unknown, before first branch {formatUsd(scope.branchUnknownCost)}</span>
      <span>
        No branch data {formatUsd(scope.noBranchDataCost)}
        {scope.noBranchDataSessions > 0 ? ` (${scope.noBranchDataSessions} ${scope.noBranchDataSessions === 1 ? 'session' : 'sessions'}${providers.length ? `: ${providers.join(', ')}` : ''})` : ''}
      </span>
      <span className="branch-coverage-note">
        {scope.distinctSessions.toLocaleString('en-US')} distinct {scope.distinctSessions === 1 ? 'session' : 'sessions'} — a session that switched branches appears on each one, so rows are not summed.
      </span>
    </div>
  )
}

function BranchPage({ report }: { report: BranchSpendReport }) {
  // `null` = auto (the top project by spend). The user's explicit choice —
  // including "All projects" — persists across refreshes and only falls back
  // when the chosen project no longer appears in a new report snapshot.
  const [selected, setSelected] = useState<string | null>(null)
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const projectOptions = [
    { value: ALL_PROJECTS, label: 'All projects' },
    ...report.projects.map(p => ({ value: p.id, label: p.label })),
  ]
  const chosen = selected !== null && selected !== ALL_PROJECTS
    ? report.projects.find(p => p.id === selected)
    : undefined
  const effectiveId = selected === ALL_PROJECTS
    ? ALL_PROJECTS
    : chosen ? chosen.id : report.projects[0]?.id ?? ALL_PROJECTS

  const scope: BranchSpendProjectReport['coverage'] = effectiveId === ALL_PROJECTS
    ? report.totals
    : report.projects.find(p => p.id === effectiveId)?.coverage ?? report.totals
  const rows: BranchSpendRow[] = effectiveId === ALL_PROJECTS
    ? report.projects.flatMap(p => p.branches)
    : report.projects.find(p => p.id === effectiveId)?.branches ?? []
  const showProject = effectiveId === ALL_PROJECTS

  // Reset any open expansion when the visible row set changes (project or
  // filter switch, refresh that alters the list): a stale expandedKey would
  // otherwise point at a row that is no longer present.
  useEffect(() => { setExpandedKey(null) }, [effectiveId, rows.map(r => `${r.projectId}|${r.branch}`).join('|')])

  return (
    <Panel
      title="By branch"
      right="spend per project and branch"
      className="spend-scroll"
    >
      <div className="branch-picker">
        <Dropdown
          id="branch-project"
          ariaLabel="Project for the By branch lens"
          value={effectiveId}
          options={projectOptions}
          onChange={value => setSelected(value)}
        />
      </div>
      {rows.length ? (
        rows.map((row, i) => {
          const rowKey = `${row.projectId}|${row.branch ?? '__unknown__'}`
          return (
            <BranchRowView
              key={rowKey}
              row={row}
              index={i}
              showProject={showProject}
              expanded={expandedKey === rowKey}
              onToggle={() => setExpandedKey(current => current === rowKey ? null : rowKey)}
            />
          )
        })
      ) : (
        <EmptyNote>No branch activity for this project in the selected range yet. Branch metadata is captured per turn (Claude transcripts carry it today); sources without it are listed in the coverage note.</EmptyNote>
      )}
      <CoverageNote scope={scope} />
    </Panel>
  )
}

/** Spend "By branch" lens: canonical project × branch rows with per-session
 *  contributions and recorded worktree evidence, filtered by the app-wide
 *  period/provider/range controls (the CLI report computes the full filtered
 *  population; this panel only narrows the display to the chosen project). */
export function BranchBreakdown({ period, provider, range = null }: { period: Period; provider: string; range?: DateRange | null }) {
  const report = usePolled<BranchSpendReport>(
    () => range ? codeburn.getBranchSpend(period, provider, range) : codeburn.getBranchSpend(period, provider),
    [period, provider, range?.from, range?.to],
    { memoKey: reportMemoKey('branchspend', period, provider, range) },
  )
  if (!report.data) {
    if (report.error) {
      return (
        <Panel title="By branch" className="spend-scroll">
          <CliErrorText error={report.error} />
        </Panel>
      )
    }
    return <SectionSkeleton label="Scanning branches…" rows={4} />
  }
  return <BranchPage report={report.data} />
}

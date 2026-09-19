import { Fragment, useEffect, useMemo, useState } from 'react'

import { CliErrorText } from './CliErrorPanel'
import { EmptyNote } from './EmptyState'
import { Dropdown } from './Dropdown'
import { ListRow } from './ListRow'
import { Panel } from './Panel'
import { SectionSkeleton } from './Skeleton'
import { usePolled } from '../hooks/usePolled'
import { t } from '../i18n'
import { formatCompact, formatCount, formatDayShort, formatUsd } from '../lib/format'
import { codeburn } from '../lib/ipc'
import { groupProjects } from '../lib/projectGroups'
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
  return id.length > 24 ? `${id.slice(0, 12)}…${id.slice(-6)}` : id || t('shared.branch.unknownSession')
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
    `${t('shared.branch.tokens.in')} ${formatCompact(tokens.inputTokens)}`,
    `${t('shared.branch.tokens.out')} ${formatCompact(tokens.outputTokens)}`,
    ...(tokens.reasoningTokens > 0 ? [`${t('shared.branch.tokens.reasoning')} ${formatCompact(tokens.reasoningTokens)}`] : []),
    `${t('shared.branch.tokens.cacheRead')} ${formatCompact(tokens.cacheReadTokens)}`,
    ...(tokens.cacheWriteTokens > 0 ? [`${t('shared.branch.tokens.cacheWrite')} ${formatCompact(tokens.cacheWriteTokens)}`] : []),
  ].join(' · ')
}

/** The recorded historical working directory, shown under its display
 *  conventions: basename in the row, full path on the tooltip. */
function pathLabel(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.at(-1) || path
}

/** Parent directory plus name, so sibling checkouts named "clone" are told
 *  apart without printing a full home path. */
function homeRelativePath(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.slice(-2).join('/') || path
}

function BranchSessionDetail({ session }: { session: BranchSpendSessionRow }) {
  return (
    <div className="spend-proj-detail branch-session-detail" role="region" aria-label={t('shared.branch.sessionDetailAria', { id: session.sessionId })}>
      <div className="branch-detail-line"><span>{t('shared.branch.session')}</span><code>{session.sessionId}</code></div>
      <div className="branch-detail-line"><span>{t('shared.branch.provider')}</span><span>{session.provider}{session.isSidechain ? t('shared.branch.subagentSuffix') : ''}</span></div>
      <div className="branch-detail-line"><span>{t('shared.branch.workingDirectory')}</span><span title={session.workingDirectory}>{session.workingDirectory ? pathLabel(session.workingDirectory) : t('shared.branch.notRecorded')}</span></div>
      <div className="branch-detail-line"><span>{t('shared.branch.models')}</span><span>{session.models.length ? session.models.join(', ') : '—'}</span></div>
      <div className="branch-detail-line"><span>{t('shared.branch.tokens')}</span><span>{tokenSummary(session.tokens)}</span></div>
      <div className="branch-detail-line"><span>{t('shared.branch.activity')}</span><span>{activitySpan(session.firstActive, session.lastActive)} · {formatCount(session.calls, 'call')}</span></div>
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
  const title = showProject ? `${row.projectLabel} / ${row.branch ?? t('shared.branch.unknownBranch')}` : (row.branch ?? t('shared.branch.unknownBranch'))
  return (
    <Fragment key={`${row.projectId}|${row.branch ?? '__unknown__'}`}>
      <ListRow
        no={String(index + 1).padStart(2, '0')}
        title={title}
        sub={`${formatCount(row.sessions, 'session')} · ${formatCount(row.calls, 'call')} · ${activitySpan(row.firstActive, row.lastActive)}`}
        value={formatUsd(row.cost)}
        expanded={expanded}
        onClick={onToggle}
      />
      {expanded && (
        <div className="spend-proj-detail" role="region" aria-label={t('shared.branch.rowDetailAria', { title })}>
          <div className="branch-detail-line"><span>{t('shared.branch.tokens')}</span><span>{tokenSummary(row.tokens)}</span></div>
          {row.worktrees.map(wt => (
            <div className="branch-detail-line" key={wt.path}>
              <span>{t('shared.branch.worktree')}</span>
              <span title={wt.path}>{homeRelativePath(wt.path)} · {formatCount(wt.sessions, 'session')} · {formatUsd(wt.cost)}</span>
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
                  aria-label={t('shared.branch.inspectSessionAria', { name: session.title ?? session.sessionId })}
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
                  <span className="sps-calls">{formatCount(session.calls, 'call')}</span>
                  <span className="sps-cost">{formatUsd(session.cost)}</span>
                </div>
                {open && <BranchSessionDetail session={session} />}
              </Fragment>
            )
          })}
          {row.sessionRows.length === 0 && <div className="spend-proj-empty">{t('shared.branch.noSessionDetail')}</div>}
        </div>
      )}
    </Fragment>
  )
}

function CoverageNote({ scope }: { scope: BranchSpendProjectReport['coverage'] }) {
  const providers = scope.noBranchDataProviders
  return (
    <div className="branch-coverage" role="note" aria-label={t('shared.branch.coverageAriaLabel')}>
      <span>{t('shared.branch.coverage.onBranches', { amount: formatUsd(scope.branchKnownCost) })}</span>
      <span>{t('shared.branch.coverage.beforeFirstBranch', { amount: formatUsd(scope.branchUnknownCost) })}</span>
      <span>
        {t('shared.branch.coverage.noBranchData', { amount: formatUsd(scope.noBranchDataCost) })}
        {scope.noBranchDataSessions > 0 ? ` (${formatCount(scope.noBranchDataSessions, 'session')}${providers.length ? `: ${providers.join(', ')}` : ''})` : ''}
      </span>
      <span className="branch-coverage-note">
        {formatCount(scope.distinctSessions, 'distinct session')}. {t('shared.branch.coverage.distinctNote')}
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
  const groups = useMemo(() => groupProjects(report.projects), [report.projects])
  const projectOptions = [
    { value: ALL_PROJECTS, label: t('shared.branch.allProjects') },
    ...groups.map(group => ({ value: group.id, label: group.label, note: group.note })),
  ]
  const chosen = selected !== null && selected !== ALL_PROJECTS
    ? groups.find(group => group.id === selected)
    : undefined
  const effectiveId = selected === ALL_PROJECTS
    ? ALL_PROJECTS
    : chosen ? chosen.id : groups[0]?.id ?? ALL_PROJECTS

  const scope: BranchSpendProjectReport['coverage'] = effectiveId === ALL_PROJECTS
    ? report.totals
    : groups.find(group => group.id === effectiveId)?.coverage ?? report.totals
  const rows: BranchSpendRow[] = effectiveId === ALL_PROJECTS
    ? groups.flatMap(group => group.branches)
    : groups.find(group => group.id === effectiveId)?.branches ?? []
  const showProject = effectiveId === ALL_PROJECTS

  // Reset any open expansion when the visible row set changes (project or
  // filter switch, refresh that alters the list): a stale expandedKey would
  // otherwise point at a row that is no longer present.
  useEffect(() => { setExpandedKey(null) }, [effectiveId, rows.map(r => `${r.projectId}|${r.branch}`).join('|')])

  return (
    <Panel
      title={t('shared.branch.title')}
      right={t('shared.branch.subtitle')}
      className="spend-scroll"
    >
      {groups.length > 0 && (
        <div className="branch-picker">
          <Dropdown
            id="branch-project"
            ariaLabel={t('shared.branch.projectAriaLabel')}
            value={effectiveId}
            options={projectOptions}
            onChange={value => setSelected(value)}
          />
        </div>
      )}
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
        <EmptyNote>{t('shared.branch.empty')}</EmptyNote>
      )}
      {groups.length > 0 && <CoverageNote scope={scope} />}
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
        <Panel title={t('shared.branch.title')} className="spend-scroll">
          <CliErrorText error={report.error} />
        </Panel>
      )
    }
    return <SectionSkeleton label={t('shared.branch.scanning')} rows={4} />
  }
  return <BranchPage report={report.data} />
}

import type { KeyboardEvent, MouseEvent } from 'react'
import { useEffect, useState } from 'react'

import { CliErrorPanel } from '../components/CliErrorPanel'
import { EmptyNote } from '../components/EmptyState'
import { Panel } from '../components/Panel'
import { SectionSkeleton } from '../components/Skeleton'
import { StaleBanner } from '../components/StaleBanner'
import { type Polled, usePolled } from '../hooks/usePolled'
import { formatDayShort, formatUsd } from '../lib/format'
import { codeburn } from '../lib/ipc'
import type { CliError, DateRange, MenubarPayload, Period } from '../lib/types'

type PullRequests = NonNullable<MenubarPayload['current']['pullRequests']>
type PrRow = PullRequests['rows'][number]

// A PR's active window: one day collapses to a single label, otherwise the two
// endpoints joined with a hyphen (never an en/em dash, per repo copy rules).
function spanLabel(firstStarted: string, lastEnded: string): string {
  const start = formatDayShort(firstStarted)
  const end = formatDayShort(lastEnded)
  if (start === '—' && end === '—') return '—'
  return start === end ? start : `${start} - ${end}`
}

function sessionWord(n: number): string {
  return n === 1 ? 'session' : 'sessions'
}

// Up to two short model names, then a "+N" overflow tag; empty for no models.
function modelsLabel(models: string[]): string {
  if (models.length <= 2) return models.join(', ')
  return `${models.slice(0, 2).join(', ')} +${models.length - 2}`
}

function openPr(event: MouseEvent<HTMLAnchorElement>, url: string): void {
  event.preventDefault()
  event.stopPropagation()
  void codeburn.openExternal(url)
}

// Keyboard activation for the button-role row, guarded so Enter/Space fired on
// the inner link (its own control) never doubles up as a row toggle.
function rowKeyDown(event: KeyboardEvent<HTMLTableRowElement>, toggle: () => void): void {
  if (event.target !== event.currentTarget) return
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    toggle()
  }
}

/** Standalone entry: self-fetches the overview payload (used in tests). The App
 *  passes its shared overview poll straight into PullRequestsContent instead. */
export function PullRequests({ period, provider, range = null }: { period: Period; provider: string; range?: DateRange | null }) {
  const overview = usePolled<MenubarPayload>(
    () => range ? codeburn.getOverview(period, provider, range) : codeburn.getOverview(period, provider),
    [period, provider, range?.from, range?.to],
  )
  return <PullRequestsContent overview={overview} />
}

export function PullRequestsContent({ overview }: { overview: Polled<MenubarPayload> }) {
  if (!overview.data) {
    if (overview.error) return <CliErrorPanel error={overview.error} subject="pull requests" />
    return <SectionSkeleton label="Scanning pull requests…" rows={5} />
  }
  return <PullRequestsPage pullRequests={overview.data.current.pullRequests} staleError={overview.error} />
}

function PullRequestsPage({ pullRequests, staleError }: { pullRequests?: PullRequests; staleError: CliError | null }) {
  return (
    <>
      {staleError && <StaleBanner error={staleError} />}
      <Panel title="Spend by pull request">
        {pullRequests && pullRequests.rows.length > 0
          ? <PrTable pullRequests={pullRequests} />
          : <EmptyNote>PR links are captured as sessions are parsed. Once a session references a pull request, it appears here.</EmptyNote>}
      </Panel>
    </>
  )
}

function PrTable({ pullRequests }: { pullRequests: PullRequests }) {
  const { rows, distinctCost, distinctSessions, attributedCost, unattributedCost, otherPrCount, otherPrCost } = pullRequests
  const [expandedUrl, setExpandedUrl] = useState<string | null>(null)
  // Reset any open expansion when the PR set changes (a period/provider switch or
  // a refresh that alters the list): a stale expandedUrl would otherwise linger
  // pointing at a row that is no longer present.
  const rowKey = rows.map(row => row.url).join('|')
  useEffect(() => { setExpandedUrl(null) }, [rowKey])

  // A new-attribution payload carries `attributedCost`; an older by-reference
  // payload omits it, so the rows are not summable and the footer must differ.
  const summable = attributedCost !== undefined
  const unattributed = unattributedCost ?? 0
  const otherCount = otherPrCount ?? 0
  const otherCost = otherPrCost ?? 0
  // Reconcile to the visible numbers: sum the rounded row costs (plus any
  // capped-away remainder) so the footer total equals what the eye adds up.
  const displayedAttributed = rows.reduce((sum, row) => sum + Number(row.cost.toFixed(2)), 0) + otherCost

  return (
    <>
      <div className="pr-scroll">
        <table className="ov-models pr-table" aria-label="Spend by pull request">
          <thead>
            <tr>
              <th>Pull request</th>
              <th className="pr-models">Models</th>
              <th className="num">Cost</th>
              <th className="num">Sessions</th>
              <th className="num">Calls</th>
              <th className="num">Active</th>
              <th className="pr-chevron-cell" aria-hidden="true"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(pr => (
              <PrRowView
                key={pr.url}
                pr={pr}
                expanded={expandedUrl === pr.url}
                onToggle={() => setExpandedUrl(current => current === pr.url ? null : pr.url)}
              />
            ))}
          </tbody>
          {otherCount > 0 && (
            // A muted summary line, kept out of the sorted rows: its cost is an
            // aggregate of the capped-away PRs and can exceed a visible row.
            <tfoot>
              <tr className="pr-other-row">
                <td className="pr-other-label">Other ({otherCount.toLocaleString('en-US')} more PRs)</td>
                <td className="pr-models"></td>
                <td className="num mono">{formatUsd(otherCost)}</td>
                <td className="num"></td>
                <td className="num"></td>
                <td className="num pr-span"></td>
                <td className="pr-chevron-cell"></td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {summable ? (
        <p className="pr-footnote">
          {formatUsd(displayedAttributed)} attributed to the rows above, across {distinctSessions.toLocaleString('en-US')} PR-linked {sessionWord(distinctSessions)}.
          {' '}Each turn's cost goes to the PR it was working on, so the rows are summable.
        </p>
      ) : (
        <p className="pr-footnote">
          {formatUsd(distinctCost)} across {distinctSessions.toLocaleString('en-US')} distinct {sessionWord(distinctSessions)} produced pull requests.
          {' '}Attribution is by reference: a session referencing several PRs counts toward each, so the rows above are not summed.
        </p>
      )}
      {unattributed > 0 && (
        <p className="pr-unattributed">Not tied to a specific PR: {formatUsd(unattributed)}</p>
      )}
    </>
  )
}

const APPROX_TITLE = 'Approximate: the transcript expired before per-turn capture, so this PR’s share is an even split of the whole session.'

function PrRowView({ pr, expanded, onToggle }: { pr: PrRow; expanded: boolean; onToggle: () => void }) {
  const models = pr.models ?? []
  const categories = pr.categories ?? []
  const catMax = categories.length ? Math.max(...categories.map(cat => cat.cost)) : 0

  return (
    <>
      <tr
        className="pr-row"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={onToggle}
        onKeyDown={event => rowKeyDown(event, onToggle)}
      >
        <td className="ov-model-name">
          <a className="pr-link" href={pr.url} title={pr.url} onClick={event => openPr(event, pr.url)}>{pr.label}</a>
        </td>
        <td className="pr-models">{models.length ? modelsLabel(models) : ''}</td>
        <td className="num mono" {...(pr.approx ? { title: APPROX_TITLE } : {})}>
          {pr.approx ? '~' : ''}{formatUsd(pr.cost)}
        </td>
        <td className="num">{pr.sessions.toLocaleString('en-US')}</td>
        <td className="num">{pr.calls.toLocaleString('en-US')}</td>
        <td className="num pr-span">{spanLabel(pr.firstStarted, pr.lastEnded)}</td>
        <td className="pr-chevron-cell"><span className="pr-chevron" aria-hidden="true">›</span></td>
      </tr>
      {expanded && (
        <tr className="pr-detail-row">
          <td className="pr-detail-cell" colSpan={7}>
            {categories.length > 0 ? (
              <div className="pr-cats" role="region" aria-label={`${pr.label} cost breakdown`}>
                {categories.map(cat => (
                  <div className="pr-cat" key={cat.name}>
                    <div className="pr-cat-bar" aria-hidden="true">
                      <span style={{ width: `${catMax > 0 ? cat.cost / catMax * 100 : 0}%` }} />
                    </div>
                    <div className="pr-cat-main">
                      <span className="pr-cat-name">{cat.name}</span>
                      <strong>{formatUsd(cat.cost)}</strong>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="pr-cat-empty">No per-turn detail (estimated from a whole-session split).</p>
            )}
          </td>
        </tr>
      )}
    </>
  )
}

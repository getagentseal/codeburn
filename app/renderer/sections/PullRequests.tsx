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

function ModelChips({ models }: { models: string[] }) {
  return (
    <div className="pr-model-list" aria-label={models.length ? `Models used: ${models.join(', ')}` : 'No model data'}>
      {models.map(model => <span className="pr-model-chip" key={model}>{model}</span>)}
    </div>
  )
}

function openPr(event: MouseEvent<HTMLAnchorElement>, url: string): void {
  event.preventDefault()
  event.stopPropagation()
  void codeburn.openExternal(url)
}

// Keyboard activation for the button-role row, guarded so Enter/Space fired on
// the inner link (its own control) never doubles up as a row toggle.
function rowKeyDown(event: KeyboardEvent<HTMLDivElement>, toggle: () => void): void {
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
  // The key remounts the content on a period/provider/range switch so row state
  // (an open expansion) never survives onto the same PR rendered from new data.
  return <PullRequestsContent key={`${period}|${provider}|${range?.from ?? ''}|${range?.to ?? ''}`} overview={overview} />
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
      <Panel title="Pull request spend">
        {pullRequests && pullRequests.rows.length > 0
          ? <PrTable pullRequests={pullRequests} />
          : <EmptyNote>PR links are captured as sessions are parsed. Once a session references a pull request, it appears here.</EmptyNote>}
      </Panel>
    </>
  )
}

function PrTable({ pullRequests }: { pullRequests: PullRequests }) {
  const { rows, distinctCost, distinctSessions, subagentSessions, attributedCost, unattributedCost } = pullRequests
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
  // Reconcile to the visible numbers: every PR is present, so the summary is
  // exactly the sum of the rounded cards a person can inspect below.
  const displayedAttributed = rows.reduce((sum, row) => sum + Number(row.cost.toFixed(2)), 0)

  return (
    <>
      <div className="pr-summary" aria-label="Pull request attribution summary">
        <div className="pr-summary-item">
          <span>Attributed spend</span>
          <strong>{formatUsd(summable ? displayedAttributed : distinctCost)}</strong>
        </div>
        <div className="pr-summary-item">
          <span>Pull requests</span>
          <strong>{rows.length.toLocaleString('en-US')}</strong>
        </div>
        <div className="pr-summary-item">
          <span>Linked sessions</span>
          <strong>{distinctSessions.toLocaleString('en-US')}</strong>
        </div>
        <div className="pr-summary-item">
          <span>Folded agent runs</span>
          <strong>{(subagentSessions ?? 0).toLocaleString('en-US')}</strong>
        </div>
      </div>
      <div className="pr-list-head">
        <div>
          <strong>Attributed pull requests</strong>
          <span>Sorted by spend, highest first</span>
        </div>
        <span className="pr-list-count">{rows.length.toLocaleString('en-US')} total</span>
      </div>
      <div className="pr-list" aria-label="Spend by pull request">
        {rows.map(pr => (
          <PrRowView
            key={pr.url}
            pr={pr}
            expanded={expandedUrl === pr.url}
            onToggle={() => setExpandedUrl(current => current === pr.url ? null : pr.url)}
          />
        ))}
      </div>
      {summable ? (
        <p className="pr-footnote">
          Costs are attributed turn by turn, so every row adds up without double counting.
          {subagentSessions ? ` ${subagentSessions.toLocaleString('en-US')} subagent ${subagentSessions === 1 ? 'run is' : 'runs are'} included in the PR where the work happened.` : ''}
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
    <article className={expanded ? 'pr-card is-open' : 'pr-card'}>
      <div
        className="pr-card-trigger"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={onToggle}
        onKeyDown={event => rowKeyDown(event, onToggle)}
      >
        <div className="pr-card-identity">
          <span className="pr-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24"><circle cx="6" cy="5" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M6 7.5V19M11 5h4a3 3 0 0 1 3 3v8.5"/></svg>
          </span>
          <div>
            <a className="pr-link" href={pr.url} title={pr.url} onClick={event => openPr(event, pr.url)}>{pr.label}</a>
            <div className="pr-card-meta">
              <span>{spanLabel(pr.firstStarted, pr.lastEnded)}</span>
              <span>{pr.sessions.toLocaleString('en-US')} {sessionWord(pr.sessions)}</span>
              <span>{pr.calls.toLocaleString('en-US')} calls</span>
            </div>
          </div>
        </div>
        <div className="pr-card-models">
          <span className="pr-card-label">Models</span>
          <ModelChips models={models} />
        </div>
        <div className="pr-card-cost">
          <span className="pr-card-label">Spend</span>
          <strong {...(pr.approx ? { title: APPROX_TITLE } : {})}>{pr.approx ? '~' : ''}{formatUsd(pr.cost)}</strong>
        </div>
        <span className="pr-chevron" aria-hidden="true">›</span>
      </div>
      {expanded && (
        <div className="pr-detail-cell">
            {categories.length > 0 ? (
              <div className="pr-detail" role="region" aria-label={`${pr.label} cost breakdown`}>
                <div className="pr-detail-head">
                  <span>Work breakdown</span>
                  <strong>{formatUsd(pr.cost)} total</strong>
                </div>
                <div className="pr-cats">
                  {categories.map(cat => (
                    <div className="pr-cat" key={cat.name}>
                      <span className="pr-cat-name">{cat.name}</span>
                      <div className="pr-cat-bar" aria-hidden="true">
                        <span style={{ width: `${catMax > 0 ? cat.cost / catMax * 100 : 0}%` }} />
                      </div>
                      <strong>{formatUsd(cat.cost)}</strong>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="pr-cat-empty">No per-turn detail (estimated from a whole-session split).</p>
            )}
        </div>
      )}
    </article>
  )
}

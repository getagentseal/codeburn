import type { MouseEvent } from 'react'

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

function openPr(event: MouseEvent<HTMLAnchorElement>, url: string): void {
  event.preventDefault()
  void codeburn.openExternal(url)
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
  const { rows, distinctCost, distinctSessions } = pullRequests
  const sessionWord = distinctSessions === 1 ? 'session' : 'sessions'
  return (
    <>
      <div className="ov-model-scroll">
        <table className="ov-models pr-table" aria-label="Spend by pull request">
          <thead>
            <tr>
              <th>Pull request</th>
              <th className="num">Cost</th>
              <th className="num">Sessions</th>
              <th className="num">Calls</th>
              <th className="num">Active</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(pr => <PrRowView key={pr.url} pr={pr} />)}
          </tbody>
        </table>
      </div>
      <p className="pr-footnote">
        {formatUsd(distinctCost)} across {distinctSessions.toLocaleString('en-US')} distinct {sessionWord} produced pull requests.
        {' '}Attribution is by reference: a session referencing several PRs counts toward each, so the rows above are not summed.
      </p>
    </>
  )
}

function PrRowView({ pr }: { pr: PrRow }) {
  return (
    <tr>
      <td className="ov-model-name">
        <a className="pr-link" href={pr.url} title={pr.url} onClick={event => openPr(event, pr.url)}>{pr.label}</a>
      </td>
      <td className="num mono">{formatUsd(pr.cost)}</td>
      <td className="num">{pr.sessions.toLocaleString('en-US')}</td>
      <td className="num">{pr.calls.toLocaleString('en-US')}</td>
      <td className="num pr-span">{spanLabel(pr.firstStarted, pr.lastEnded)}</td>
    </tr>
  )
}

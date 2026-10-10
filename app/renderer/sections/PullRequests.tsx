import type { KeyboardEvent, MouseEvent } from 'react'
import { useEffect, useState } from 'react'

import { CliErrorPanel } from '../components/CliErrorPanel'
import { EmptyNote } from '../components/EmptyState'
import { Panel } from '../components/Panel'
import { TruncTip } from '../components/TruncTip'
import { SectionSkeleton } from '../components/Skeleton'
import { StaleBanner } from '../components/StaleBanner'
import { type Polled, usePolled } from '../hooks/usePolled'
import { formatCount, formatDayShort, formatDuration, formatUsd } from '../lib/format'
import { codeburn } from '../lib/ipc'
import { PERIOD_LABELS } from '../lib/period'
import type { CliError, DateRange, MenubarPayload, Period } from '../lib/types'
import { prFilters } from '../lib/investigation'
import { rangeLabel } from '../components/TopBar'
import type { InvestigateRequest } from './Overview'
import { Icon } from '../components/icons'
import { localeTag, t } from '../i18n'

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

// Facts read from local commands. Each one states its unknown instead of
// disappearing; a field an older CLI does not send stays out.
function prFacts(pr: PrRow): string[] {
  const facts: string[] = []
  if (pr.state === 'merged' || (!pr.state && pr.mergedAt)) facts.push(pr.mergedAt ? t('pullRequests.facts.mergedOn', { date: formatDayShort(pr.mergedAt) }) : t('pullRequests.facts.status.merged'))
  else if (pr.state) facts.push(t(`pullRequests.facts.status.${pr.state}`))
  const rounds = pr.followUpRounds ?? null
  if (pr.oneShot === true) facts.push(t('pullRequests.facts.oneShot'))
  else if (pr.oneShot === false && rounds !== null) facts.push(t(`pullRequests.facts.rounds.${rounds === 1 ? 'one' : 'other'}`, { count: rounds }))
  else if (rounds !== null) facts.push(t('pullRequests.facts.yourFollowUps', { count: rounds }))
  else if (pr.oneShot !== undefined) facts.push(t('pullRequests.facts.notTracked'))
  const reviews = pr.reviewRuns
  const only = reviews?.length === 1 ? reviews[0]! : null
  if (only?.kind === 'you') facts.push(t('pullRequests.facts.reviewedByYou', { amount: formatUsd(only.costUSD) }))
  else if (only?.model) facts.push(t('pullRequests.facts.reviewedBy', { model: only.model, amount: formatUsd(only.costUSD) }))
  else if (reviews?.length) facts.push(t(`pullRequests.facts.reviewRuns.${reviews.length === 1 ? 'one' : 'other'}`, { count: reviews.length, amount: formatUsd(pr.reviewCostUSD ?? 0) }))
  else if (reviews) facts.push(t('pullRequests.facts.noReview'))
  return facts
}

function carriedNote(pr: PrRow): string | null {
  const carried = pr.carriedUSD ?? 0
  return carried > 0 && carried >= Math.max(0.5, pr.cost * 0.2) ? t('pullRequests.facts.carried', { amount: formatUsd(carried) }) : null
}

function timeLabel(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(localeTag(), { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function timeline(pr: PrRow): Array<{ label: string; at: string; note?: string }> {
  const events: Array<{ label: string; at: string; note?: string }> = []
  if (pr.openedAt) events.push({ label: t('pullRequests.timeline.opened'), at: pr.openedAt })
  const firstReview = pr.reviewRuns?.[0]?.at
  if (firstReview) events.push({ label: t('pullRequests.timeline.firstReview'), at: firstReview })
  pr.followUpAt?.forEach((at, i) => events.push({ label: t('pullRequests.timeline.round', { count: i + 1 }), at }))
  if (pr.mergedAt) events.push({ label: t('pullRequests.timeline.merged'), at: pr.mergedAt, ...(pr.timeToMergeMs != null ? { note: t('pullRequests.timeline.afterOpen', { duration: formatDuration(pr.timeToMergeMs) }) } : {}) })
  return events.sort((a, b) => a.at.localeCompare(b.at))
}

const share = (cost: number, total: number): string => `${total > 0 ? Math.round(cost / total * 100) : 0}%`

// Label, amount and share of the PR's cost, in the app's plain table style.
function CostTable({ rows, total }: { rows: Array<{ key: string; label: string; cost: number }>; total: number }) {
  return (
    <table className="pr-table">
      <tbody>
        {rows.map(row => (
          <tr key={row.key}>
            <TruncTip as="td" text={row.label} />
            <td>{formatUsd(row.cost)}</td>
            <td className="pr-share">{share(row.cost, total)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function ModelChips({ models }: { models: string[] }) {
  return (
    <div className="pr-model-list" aria-label={models.length ? t('pullRequests.models.usedAria', { models: models.join(', ') }) : t('pullRequests.models.noneAria')}>
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
export function PullRequests({ period, provider, range = null, onInvestigate }: {
  period: Period
  provider: string
  range?: DateRange | null
  onInvestigate?: (request: InvestigateRequest) => void
}) {
  const overview = usePolled<MenubarPayload>(
    () => range ? codeburn.getOverview(period, provider, range) : codeburn.getOverview(period, provider),
    [period, provider, range?.from, range?.to],
  )
  // The key remounts the content on a period/provider/range switch so row state
  // (an open expansion) never survives onto the same PR rendered from new data.
  return <PullRequestsContent key={`${period}|${provider}|${range?.from ?? ''}|${range?.to ?? ''}`} overview={overview} period={period} provider={provider} range={range} onInvestigate={onInvestigate} />
}

export function PullRequestsContent({ overview, period, provider, range = null, onInvestigate }: {
  overview: Polled<MenubarPayload>
  period: Period
  provider: string
  range?: DateRange | null
  onInvestigate?: (request: InvestigateRequest) => void
}) {
  if (!overview.data) {
    if (overview.error) return <CliErrorPanel error={overview.error} subject={t('pullRequests.errorSubject')} />
    return <SectionSkeleton label={t('pullRequests.loading')} rows={5} />
  }
  return <PullRequestsPage
    pullRequests={overview.data.current.pullRequests}
    staleError={overview.error}
    period={period}
    provider={provider}
    range={range}
    onInvestigate={onInvestigate}
  />
}

function PullRequestsPage({ pullRequests, staleError, period, provider, range, onInvestigate }: {
  pullRequests?: PullRequests
  staleError: CliError | null
  period: Period
  provider: string
  range: DateRange | null
  onInvestigate?: (request: InvestigateRequest) => void
}) {
  const empty = !pullRequests || pullRequests.rows.length === 0
  return (
    <>
      {staleError && <StaleBanner error={staleError} />}
      {empty ? (
        <Panel title={t('pullRequests.summary.title')}>
          <PrEmptyNote period={period} provider={provider} range={range} />
        </Panel>
      ) : (
        <PrTable pullRequests={pullRequests} onInvestigate={onInvestigate} />
      )}
    </>
  )
}

function PrEmptyNote({ period, provider, range }: { period: Period; provider: string; range: DateRange | null }) {
  const [widerCount, setWiderCount] = useState<number | null>(null)
  const canProbeWider = !range && period !== 'lifetime'
  useEffect(() => {
    if (!canProbeWider) return
    let cancelled = false
    void codeburn.getOverview('lifetime', provider).then(payload => {
      if (cancelled) return
      setWiderCount(payload.current.pullRequests?.rows.length ?? 0)
    }).catch(() => {
      if (!cancelled) setWiderCount(null)
    })
    return () => { cancelled = true }
  }, [canProbeWider, provider])

  const periodLabel = range ? rangeLabel(range) : PERIOD_LABELS[period]
  const widerHint = widerCount && widerCount > 0
    ? t('pullRequests.empty.widerHint', { count: widerCount.toLocaleString('en-US') })
    : ''
  return (
    <EmptyNote>
      {t('pullRequests.empty.body', { period: periodLabel })}
      {widerHint}
    </EmptyNote>
  )
}

function PrTable({ pullRequests, onInvestigate }: { pullRequests: PullRequests; onInvestigate?: (request: InvestigateRequest) => void }) {
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
    <div className="pr-page">
      <Panel title={t('pullRequests.summary.title')}>
        <div className="pr-summary" aria-label={t('pullRequests.summary.aria')}>
          <div className="pr-summary-item">
            <span>{t('pullRequests.summary.attributedSpend')}</span>
            <TruncTip as="strong" text={formatUsd(summable ? displayedAttributed : distinctCost)} />
          </div>
          <div className="pr-summary-item">
            <span>{t('pullRequests.summary.pullRequests')}</span>
            <TruncTip as="strong" text={rows.length.toLocaleString('en-US')} />
          </div>
          <div className="pr-summary-item">
            <span>{t('pullRequests.summary.linkedSessions')}</span>
            <TruncTip as="strong" text={distinctSessions.toLocaleString('en-US')} />
          </div>
          <div className="pr-summary-item">
            <span>{t('pullRequests.summary.foldedAgentRuns')}</span>
            <TruncTip as="strong" text={(subagentSessions ?? 0).toLocaleString('en-US')} />
          </div>
        </div>
      </Panel>
      <Panel
        title={t('pullRequests.list.title')}
        right={<>{t('pullRequests.list.sortedHint')} <span className="pr-list-count">{t('pullRequests.list.total', { count: rows.length.toLocaleString('en-US') })}</span></>}
      >
          <div className="pr-list" aria-label={t('pullRequests.list.aria')}>
          {rows.map(pr => (
            <PrRowView
              key={pr.url}
              pr={pr}
              expanded={expandedUrl === pr.url}
              onToggle={() => setExpandedUrl(current => current === pr.url ? null : pr.url)}
              onInvestigate={onInvestigate}
            />
          ))}
        </div>
        {summable ? (
          <p className="pr-footnote">
            {t('pullRequests.footnote.turnByTurn')}
            {subagentSessions ? t(`pullRequests.footnote.subagentIncluded.${subagentSessions === 1 ? 'one' : 'other'}`, { count: subagentSessions.toLocaleString('en-US') }) : ''}
          </p>
        ) : (
          <p className="pr-footnote">
            {t('pullRequests.footnote.byReference.summary', { amount: formatUsd(distinctCost), sessionCount: formatCount(distinctSessions, 'distinct session') })}
            {' '}{t('pullRequests.footnote.byReference.detail')}
          </p>
        )}
        {unattributed > 0 && (
          <p className="pr-unattributed">{t('pullRequests.unattributed', { amount: formatUsd(unattributed) })}</p>
        )}
      </Panel>
    </div>
  )
}

function PrRowView({ pr, expanded, onToggle, onInvestigate }: { pr: PrRow; expanded: boolean; onToggle: () => void; onInvestigate?: (request: InvestigateRequest) => void }) {
  const models = pr.models ?? []
  const categories = pr.categories ?? []
  const facts = prFacts(pr)
  const carried = carriedNote(pr)

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
            <Icon name="git-pull-request" />
          </span>
          <div>
            <TruncTip as="a" text={pr.label} className="pr-link" href={pr.url} title={pr.url} onClick={(event: MouseEvent<HTMLAnchorElement>) => openPr(event, pr.url)} />
            <div className="pr-card-meta">
              <span>{spanLabel(pr.firstStarted, pr.lastEnded)}</span>
              <span>{pr.runs !== undefined ? formatCount(pr.runs, 'run') : formatCount(pr.sessions, 'session')}</span>
              <span>{formatCount(pr.calls, 'call')}</span>
            </div>
            {(facts.length > 0 || carried || pr.linkEvidence === 'pr-link-only') && (
              <div className="pr-card-meta pr-card-facts">
                {facts.map(fact => <span key={fact}>{fact}</span>)}
                {carried && <span title={t('pullRequests.facts.carriedTitle')}>{carried}</span>}
                {pr.linkEvidence === 'pr-link-only' && <span title={t('pullRequests.facts.prLinkOnlyTitle')}>{t('pullRequests.facts.prLinkOnly')}</span>}
              </div>
            )}
          </div>
        </div>
        <div className="pr-card-models">
          <span className="pr-card-label">{t('pullRequests.card.modelsLabel')}</span>
          <ModelChips models={models} />
        </div>
        <div className="pr-card-cost">
          <span className="pr-card-label">{t('pullRequests.card.spendLabel')}</span>
          <strong {...(pr.approx ? { title: t('pullRequests.card.approxTitle') } : {})}>{pr.approx ? '~' : ''}{formatUsd(pr.cost)}</strong>
        </div>
        <span className="pr-chevron" aria-hidden="true"><Icon name="chevron-right" /></span>
      </div>
      {expanded && <PrDetail pr={pr} categories={categories} onInvestigate={onInvestigate} />}
    </article>
  )
}

function PrDetail({ pr, categories, onInvestigate }: { pr: PrRow; categories: NonNullable<PrRow['categories']>; onInvestigate?: (request: InvestigateRequest) => void }) {
  const events = timeline(pr)
  const carried = carriedNote(pr)
  const runs = pr.runList ?? []
  const split = pr.costSplit
  const top = categories.slice(0, 5)
  const rest = categories.slice(5).reduce((sum, cat) => sum + cat.cost, 0)
  const work = [
    ...top.map(cat => ({ key: cat.name, label: cat.name, cost: cat.cost })),
    ...(rest > 0 ? [{ key: 'other', label: t('pullRequests.work.other'), cost: rest }] : []),
  ]
  return (
    <div className="pr-detail-cell">
      <div className="pr-detail-grid">
        {pr.openedAt !== undefined && (
          <div className="pr-detail" role="region" aria-label={t('pullRequests.timeline.aria', { label: pr.label })}>
            <div className="pr-detail-head"><span>{t('pullRequests.timeline.title')}</span></div>
            {events.length > 0 ? (
              <table className="pr-table">
                <tbody>
                  {events.map(event => (
                    <tr key={`${event.label}-${event.at}`}>
                      <TruncTip as="td" text={event.label} />
                      <td>{timeLabel(event.at)}{event.note ? ` · ${event.note}` : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="pr-cat-empty">{t('pullRequests.timeline.none')}</p>}
          </div>
        )}
        {runs.length > 0 && (
          <div className="pr-detail" role="region" aria-label={t('pullRequests.runs.aria', { label: pr.label })}>
            <div className="pr-detail-head">
              <span>{t('pullRequests.runs.title')}</span>
              {carried && <strong>{carried}</strong>}
            </div>
            <table className="pr-table pr-runs">
              <tbody>
                {runs.map((run, i) => (
                  <tr key={i}>
                    <TruncTip as="td" text={run.description ?? t(run.kind === 'session' ? 'pullRequests.runs.mainSession' : 'pullRequests.runs.agentRun')} />
                    <td className="pr-run-why">{t(`pullRequests.runs.link.${run.link}`)}</td>
                    <td>{run.model ?? ''}</td>
                    <td>{formatUsd(run.costUSD)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {split && (
          <div className="pr-detail" role="region" aria-label={t('pullRequests.split.aria', { label: pr.label })}>
            <div className="pr-detail-head"><span>{t('pullRequests.split.title')}</span></div>
            <CostTable total={pr.cost} rows={[
              { key: 'build', label: t('pullRequests.split.build'), cost: Math.max(0, split.buildUSD) },
              { key: 'review', label: t('pullRequests.split.review'), cost: split.reviewUSD },
              { key: 'after', label: t('pullRequests.split.after'), cost: split.fixesUSD },
            ]} />
          </div>
        )}
        <div className="pr-detail" role="region" aria-label={t('pullRequests.card.costBreakdownAria', { label: pr.label })}>
          <div className="pr-detail-head">
            <span>{t('pullRequests.card.workBreakdownTitle')}</span>
            <strong>{t('pullRequests.card.workBreakdownTotal', { amount: formatUsd(pr.cost) })}</strong>
          </div>
          {work.length > 0 ? <CostTable rows={work} total={pr.cost} /> : <p className="pr-cat-empty">{t('pullRequests.card.noPerTurnDetail')}</p>}
        </div>
      </div>
      {/* Drill-through entry: a control of its own, never the row. The row
          is a toggle, so hanging the investigation off it would cost the
          expansion; this opens the sessions that composed the PR while the
          row stays exactly as the reader left it. The PR URL is the
          aggregation key of the by-PR report, so it selects at the
          destination without a lookup. */}
      {onInvestigate && (
        <button
          className="ov-link pr-drill"
          type="button"
          title={t('pullRequests.drill.viewSessionsTitle', { label: pr.label })}
          onClick={() => onInvestigate({ filters: prFilters(pr.url) })}
        >
          {t('pullRequests.drill.viewSessionsButton')}
        </button>
      )}
    </div>
  )
}

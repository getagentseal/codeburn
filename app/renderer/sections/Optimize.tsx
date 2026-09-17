import { Fragment, useState } from 'react'

import { CliErrorPanel } from '../components/CliErrorPanel'
import { EmptyNote } from '../components/EmptyState'
import { Panel } from '../components/Panel'
import { SectionSkeleton } from '../components/Skeleton'
import { SegTabs } from '../components/SegTabs'
import { StaleBanner } from '../components/StaleBanner'
import { type Polled, usePolled } from '../hooks/usePolled'
import { formatCompact, formatCount, formatUsd } from '../lib/format'
import { codeburn } from '../lib/ipc'
import { reportMemoKey } from '../lib/reportMemoKey'
import { trackEvent } from '../lib/track'
import type { DateRange, FindingClass, MenubarPayload, OptimizeJsonReport, Period, SessionYieldJson, WasteAction, YieldJsonReport } from '../lib/types'
import { Icon, type IconName } from '../components/icons'

type OptimizeTab = 'waste' | 'reverts' | 'abandoned' | 'fixes'

/** The card's header title: the tab the list below is showing. */
const TAB_TITLES: Record<OptimizeTab, string> = { waste: 'Waste', reverts: 'Reverts', abandoned: 'Abandoned', fixes: 'Fixes' }

export function Optimize({ period, provider, range = null }: { period: Period; provider: string; range?: DateRange | null }) {
  const overview = usePolled<MenubarPayload>(
    () => range ? codeburn.getOverview(period, provider, range) : codeburn.getOverview(period, provider),
    [period, provider, range?.from, range?.to],
  )
  return <OptimizeContent period={period} provider={provider} range={range} overview={overview} />
}

export function OptimizeContent({
  period,
  provider = 'all',
  range = null,
  overview,
  refreshToken = 0,
  ready = true,
}: {
  period: Period
  provider?: string
  range?: DateRange | null
  overview: Polled<MenubarPayload>
  refreshToken?: number
  ready?: boolean
}) {
  // Gate on app-level readiness so boot hydrates the cache once (default true
  // keeps standalone renders/tests polling normally).
  const optimizeReport = usePolled<OptimizeJsonReport>(
    () => range ? codeburn.getOptimizeReport(period, provider, range) : codeburn.getOptimizeReport(period, provider),
    [period, provider, range?.from, range?.to, refreshToken],
    { enabled: ready, memoKey: reportMemoKey('optimize', period, provider, range) },
  )
  const yieldReport = usePolled<YieldJsonReport>(
    () => range ? codeburn.getYield(period, provider, range) : codeburn.getYield(period, provider),
    [period, provider, range?.from, range?.to, refreshToken],
    { enabled: ready, memoKey: reportMemoKey('yield', period, provider, range) },
  )
  const [tab, setTab] = useState<OptimizeTab>('waste')

  if (!overview.data) {
    if (overview.error) return <CliErrorPanel error={overview.error} subject="optimize findings" />
    return <SectionSkeleton label="Scanning optimize findings…" rows={5} />
  }

  const yieldData = yieldReport.error ? null : yieldReport.data
  const revertedTotal = yieldData ? formatUsd(yieldData.summary.reverted.costUSD) : '—'
  const abandonedTotal = yieldData ? formatUsd(yieldData.summary.abandoned.costUSD) : '—'
  const options = [
    { value: 'waste', label: `Waste ${formatUsd(overview.data.optimize.savingsUSD)}` },
    { value: 'reverts', label: `Reverts ${revertedTotal}` },
    { value: 'abandoned', label: `Abandoned ${abandonedTotal}` },
    // The Fixes tab renders topFindings (capped list), so label the count that shows.
    { value: 'fixes', label: `Fixes ${overview.data.optimize.topFindings.length.toLocaleString('en-US')}` },
  ]

  return (
    <>
      {overview.error && <StaleBanner error={overview.error} />}
      <Panel
        title={TAB_TITLES[tab]}
        right={<SegTabs options={options} value={tab} onChange={value => setTab(value as OptimizeTab)} />}
      >
        {tab === 'waste' ? (
          <WasteRows report={optimizeReport} />
        ) : tab === 'reverts' ? (
          <YieldRows report={yieldReport} category="reverted" empty="No reverted sessions in this range yet." />
        ) : tab === 'abandoned' ? (
          <YieldRows report={yieldReport} category="abandoned" empty="No abandoned sessions in this range yet." />
        ) : (
          <FixesRows data={overview.data} />
        )}
      </Panel>
    </>
  )
}

function WasteRows({ report }: { report: Polled<OptimizeJsonReport> }) {
  if (!report.data) {
    if (report.error) return <CliErrorPanel error={report.error} subject="optimize findings" />
    return <EmptyNote>Scanning optimize findings…</EmptyNote>
  }

  return (
    <div className="opt-waste">
      <div className="opt-summary">
        {formatCount(report.data.summary.findingCount, 'finding')} · {formatUsd(report.data.summary.potentialSavingsCostUSD)} potential · health {report.data.summary.healthScore}/100
      </div>
      <ActionableFindingRows findings={report.data.findings} byClass={report.data.summary.byClass} />
      <AppliedFixRows fixes={report.data.appliedFixes ?? []} />
    </div>
  )
}

type AppliedFix = NonNullable<OptimizeJsonReport['appliedFixes']>[number]

const VERDICT_GLYPH: Record<AppliedFix['verdict'], string> = {
  worked: '\u2713',
  partial: '~',
  'no-effect': '\u2717',
  pending: '\u2026',
}

const VERDICT_LABEL: Record<AppliedFix['verdict'], string> = {
  worked: 'worked',
  partial: 'under estimate',
  'no-effect': 'did not help',
  pending: 'measuring',
}

// Closes the loop after `optimize --apply`: what each applied fix actually
// measured, and for the ones that did nothing, how to put them back.
function AppliedFixRows({ fixes }: { fixes: AppliedFix[] }) {
  if (!fixes.length) return null

  return (
    <div className="opt-findings opt-applied">
      <div className="opt-group">Applied fixes</div>
      {fixes.map(fix => (
        <div className={`opt-applied-row opt-applied-${fix.verdict}`} key={fix.id}>
          <span className="opt-applied-glyph" aria-hidden="true">{VERDICT_GLYPH[fix.verdict]}</span>
          <b className="opt-finding-title">{fix.findingId ?? fix.kind}</b>
          <span className="opt-applied-verdict">{VERDICT_LABEL[fix.verdict]}</span>
          <span className="opt-finding-tokens">
            {fix.verdict === 'pending'
              ? '\u2014'
              : `est. ${formatCompact(fix.estimatedTokens)} \u2192 ${formatCompact(fix.realizedTokens)}`}
          </span>
        </div>
      ))}
      {fixes.some(fix => fix.verdict === 'no-effect') && (
        <div className="opt-summary opt-applied-hint">Revert one that did not help: <code>{fixes.find(fix => fix.verdict === 'no-effect')!.undoCommand}</code></div>
      )}
    </div>
  )
}

type OptimizeFinding = OptimizeJsonReport['findings'][number]

const IMPACT_ICON: Record<'high' | 'medium' | 'low', IconName> = {
  high: 'arrow-up',
  medium: 'arrow-right',
  low: 'arrow-down',
}

const CLASS_HEADERS: Record<FindingClass, string> = {
  fix: 'Fix now (apply-able)',
  nudge: 'Habits',
  keep: 'FYI',
}

function actionText(fix: WasteAction): string {
  return fix.type === 'file-content' ? fix.content : fix.text
}

function ActionableFindingRows({ findings, byClass }: { findings: OptimizeFinding[]; byClass: OptimizeJsonReport['summary']['byClass'] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  if (!findings.length) return <EmptyNote>No waste findings in this range yet.</EmptyNote>

  const copyFix = async (finding: OptimizeFinding) => {
    await navigator.clipboard.writeText(actionText(finding.fix))
    // Taking a fix is the closest thing the app has to applying one. The id is a
    // fixed detector name (`claude-md-too-long`, `unused-mcp`, ...), never text
    // from the finding.
    trackEvent('optimize_apply', { kind: finding.id, fixType: finding.fix.type })
    setCopiedId(finding.id)
    window.setTimeout(() => setCopiedId(current => current === finding.id ? null : current), 1_500)
  }

  return (
    <div className="opt-findings">
      {findings.map((finding, i) => {
        const expanded = expandedId === finding.id
        // Findings arrive class-sorted from the CLI, so a header goes in
        // wherever the class changes.
        const showHeader = finding.class !== findings[i - 1]?.class
        return (
          <Fragment key={finding.id}>
            {showHeader && (
              <div className="opt-group">
                {CLASS_HEADERS[finding.class]} · {formatCompact(byClass[finding.class].tokensSaved)} tokens · {formatUsd(byClass[finding.class].savingsUSD)} · {byClass[finding.class].count} {byClass[finding.class].count === 1 ? 'finding' : 'findings'}
              </div>
            )}
            <button
              className="opt-finding opt-finding-toggle"
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpandedId(current => current === finding.id ? null : finding.id)}
            >
              <span className={`opt-impact opt-impact-${finding.severity}`}>
                <Icon name={IMPACT_ICON[finding.severity]} className="opt-impact-mark" />
                {finding.severity.charAt(0).toUpperCase() + finding.severity.slice(1)}
              </span>
              <span className="opt-finding-titlewrap">
                <b className="opt-finding-title">{finding.title}</b>
                {finding.trend === 'improving' && (
                  <span className="opt-trend opt-trend-improving">improving<Icon name="arrow-down" className="opt-impact-mark" /></span>
                )}
              </span>
              <span className="opt-finding-savings">{formatUsd(finding.estimatedSavingsUSD)}</span>
              <span className="opt-finding-tokens">{formatCompact(finding.tokensSaved)} tokens · {finding.basis}</span>
              <span className="opt-finding-chevron" aria-hidden="true"><Icon name="chevron-right" /></span>
            </button>
            {expanded && (
              <div className="opt-finding-detail" role="region" aria-label={`${finding.title} details`}>
                <p className="opt-explanation">{finding.explanation}</p>
                <div className={`opt-fix opt-fix-${finding.fix.type}`}>
                  <div className="opt-fix-head">
                    <div>
                      <b>{finding.fix.label}</b>
                      {finding.fix.type === 'file-content' && <span className="opt-fix-path">{finding.fix.path}</span>}
                    </div>
                    <button className="opt-copy" type="button" onClick={() => void copyFix(finding)}>
                      {copiedId === finding.id ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <pre className="opt-fix-code"><code>{actionText(finding.fix)}</code></pre>
                </div>
              </div>
            )}
          </Fragment>
        )
      })}
    </div>
  )
}

type Finding = MenubarPayload['optimize']['topFindings'][number]

function FindingRows({ findings, empty }: { findings: Finding[]; empty: string }) {
  if (!findings.length) return <EmptyNote>{empty}</EmptyNote>

  return (
    <div className="opt-findings">
      {findings.map((finding, i) => (
        <div className="opt-finding opt-finding-legacy" key={`${finding.title}-${i}`}>
          <span className="opt-finding-rank">{String(i + 1).padStart(2, '0')}</span>
          <b className="opt-finding-title">{finding.title}</b>
          <span className={`opt-impact opt-impact-${finding.impact}`}>
            <Icon name={IMPACT_ICON[finding.impact]} className="opt-impact-mark" />
            {finding.impact.charAt(0).toUpperCase() + finding.impact.slice(1)}
          </span>
          <span className="opt-finding-savings">{formatUsd(finding.savingsUSD)}</span>
        </div>
      ))}
    </div>
  )
}

function YieldRows({
  report,
  category,
  empty,
}: {
  report: Polled<YieldJsonReport>
  category: SessionYieldJson['category']
  empty: string
}) {
  if (report.error || !report.data) return <EmptyNote>Yield data is unavailable right now.</EmptyNote>

  const rows = report.data.details.filter(row => row.category === category)
  if (!rows.length) return <EmptyNote>{empty}</EmptyNote>

  return (
    <>
      {rows.map((row, i) => (
        <div className="li" style={{ alignItems: 'flex-start' }} key={row.sessionId}>
          <span className="no">{String(i + 1).padStart(2, '0')}</span>
          <div className="lx">
            <b>{row.project}</b>
            <span>
              {row.commitCount.toLocaleString('en-US')} {row.commitCount === 1 ? 'commit' : 'commits'} · {row.sessionId}
            </span>
          </div>
          <span className="val">{formatUsd(row.costUSD)}</span>
        </div>
      ))}
    </>
  )
}

function FixesRows({ data }: { data: MenubarPayload }) {
  return <FindingRows findings={data.optimize.topFindings} empty="No fixes in this range yet." />
}

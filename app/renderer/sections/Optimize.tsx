import { Fragment, useState } from 'react'

import { CliErrorPanel } from '../components/CliErrorPanel'
import { EmptyNote } from '../components/EmptyState'
import { Panel } from '../components/Panel'
import { SectionSkeleton } from '../components/Skeleton'
import { SegTabs } from '../components/SegTabs'
import { StaleBanner } from '../components/StaleBanner'
import { type Polled, usePolled } from '../hooks/usePolled'
import { formatCompact, formatUsd } from '../lib/format'
import { codeburn } from '../lib/ipc'
import { optimizeReportKey, yieldReportKey } from '../lib/reportKeys'
import type { DateRange, MenubarPayload, OptimizeJsonReport, Period, SessionYieldJson, WasteAction, YieldJsonReport } from '../lib/types'

type OptimizeTab = 'waste' | 'reverts' | 'abandoned' | 'fixes'

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
    { enabled: ready, memoKey: optimizeReportKey(period, provider, range) },
  )
  const yieldReport = usePolled<YieldJsonReport>(
    () => range ? codeburn.getYield(period, provider, range) : codeburn.getYield(period, provider),
    [period, provider, range?.from, range?.to, refreshToken],
    { enabled: ready, memoKey: yieldReportKey(period, provider, range) },
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
    { value: 'waste', label: `Waste ${optimizeReport.data ? formatUsd(optimizeReport.data.summary.potentialSavingsCostUSD) : '—'}` },
    { value: 'reverts', label: `Reverts ${revertedTotal}` },
    { value: 'abandoned', label: `Abandoned ${abandonedTotal}` },
    // The Fixes tab renders the complete optimize report, so use its full count.
    { value: 'fixes', label: `Fixes ${optimizeReport.data ? optimizeReport.data.summary.findingCount.toLocaleString('en-US') : '—'}` },
  ]

  return (
    <>
      {overview.error && <StaleBanner error={overview.error} />}
      <SegTabs
        options={options}
        value={tab}
        onChange={value => setTab(value as OptimizeTab)}
        style={{ alignSelf: 'flex-start' }}
      />
      <Panel>
        {tab === 'waste' ? (
          <WasteRows report={optimizeReport} />
        ) : tab === 'reverts' ? (
          <YieldRows report={yieldReport} category="reverted" empty="No reverted sessions in this range yet." />
        ) : tab === 'abandoned' ? (
          <YieldRows report={yieldReport} category="abandoned" empty="No abandoned sessions in this range yet." />
        ) : (
          <FixesRows report={optimizeReport} />
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
        {report.data.summary.findingCount.toLocaleString('en-US')} findings · {formatUsd(report.data.summary.potentialSavingsCostUSD)} potential · health {report.data.summary.healthScore}/100
      </div>
      <ActionableFindingRows findings={report.data.findings} />
    </div>
  )
}

type OptimizeFinding = OptimizeJsonReport['findings'][number]

const IMPACT_ICON: Record<'high' | 'medium' | 'low', string> = {
  high: '↑',
  medium: '→',
  low: '↓',
}

function actionText(fix: WasteAction): string {
  return fix.type === 'file-content' ? fix.content : fix.text
}

function ActionableFindingRows({ findings }: { findings: OptimizeFinding[] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  if (!findings.length) return <EmptyNote>No waste findings in this range yet.</EmptyNote>

  const copyFix = async (finding: OptimizeFinding) => {
    await navigator.clipboard.writeText(actionText(finding.fix))
    setCopiedId(finding.id)
    window.setTimeout(() => setCopiedId(current => current === finding.id ? null : current), 1_500)
  }

  return (
    <div className="opt-findings">
      {findings.map(finding => {
        const expanded = expandedId === finding.id
        return (
          <Fragment key={finding.id}>
            <button
              className="opt-finding opt-finding-toggle"
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpandedId(current => current === finding.id ? null : finding.id)}
            >
              <span className={`opt-impact opt-impact-${finding.severity}`}>
                <span aria-hidden="true">{IMPACT_ICON[finding.severity]}</span>
                {finding.severity.charAt(0).toUpperCase() + finding.severity.slice(1)}
              </span>
              <span className="opt-finding-titlewrap">
                <b className="opt-finding-title">{finding.title}</b>
                {finding.trend === 'improving' && (
                  <span className="opt-trend opt-trend-improving">improving<span aria-hidden="true"> ↓</span></span>
                )}
              </span>
              <span className="opt-finding-savings">{formatUsd(finding.estimatedSavingsUSD)}</span>
              <span className="opt-finding-tokens">{formatCompact(finding.tokensSaved)} tokens</span>
              <span className="opt-finding-chevron" aria-hidden="true">›</span>
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
            <span aria-hidden="true">{IMPACT_ICON[finding.impact]}</span>
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

function FixesRows({ report }: { report: Polled<OptimizeJsonReport> }) {
  if (!report.data) {
    if (report.error) return <CliErrorPanel error={report.error} subject="optimize findings" />
    return <EmptyNote>Scanning optimize findings…</EmptyNote>
  }
  const findings: Finding[] = report.data.findings.map(finding => ({
    title: finding.title,
    impact: finding.severity,
    savingsUSD: finding.estimatedSavingsUSD,
  }))
  return <FindingRows findings={findings} empty="No fixes in this range yet." />
}

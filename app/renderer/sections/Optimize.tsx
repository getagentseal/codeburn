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
import { t } from '../i18n'

type OptimizeTab = 'waste' | 'reverts' | 'abandoned' | 'fixes'

/** The card's header title: the tab the list below is showing. Computed at
 *  call time (not a module-level const) so it re-reads the current locale. */
function tabTitle(tab: OptimizeTab): string {
  return {
    waste: t('spend.optimize.tabTitle.waste'),
    reverts: t('spend.optimize.tabTitle.reverts'),
    abandoned: t('spend.optimize.tabTitle.abandoned'),
    fixes: t('spend.optimize.tabTitle.fixes'),
  }[tab]
}

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
    if (overview.error) return <CliErrorPanel error={overview.error} subject={t('common.subject.optimize')} />
    return <SectionSkeleton label={t('spend.optimize.loading.scanning')} rows={5} />
  }

  const yieldData = yieldReport.error ? null : yieldReport.data
  const revertedTotal = yieldData ? formatUsd(yieldData.summary.reverted.costUSD) : '—'
  const abandonedTotal = yieldData ? formatUsd(yieldData.summary.abandoned.costUSD) : '—'
  const options = [
    { value: 'waste', label: t('spend.optimize.tabOption.waste', { amount: formatUsd(overview.data.optimize.savingsUSD) }) },
    { value: 'reverts', label: t('spend.optimize.tabOption.reverts', { amount: revertedTotal }) },
    { value: 'abandoned', label: t('spend.optimize.tabOption.abandoned', { amount: abandonedTotal }) },
    // The Fixes tab renders topFindings (capped list), so label the count that shows.
    { value: 'fixes', label: t('spend.optimize.tabOption.fixes', { count: overview.data.optimize.topFindings.length.toLocaleString('en-US') }) },
  ]

  return (
    <>
      {overview.error && <StaleBanner error={overview.error} />}
      <Panel
        title={tabTitle(tab)}
        right={<SegTabs options={options} value={tab} onChange={value => setTab(value as OptimizeTab)} />}
      >
        {tab === 'waste' ? (
          <WasteRows report={optimizeReport} />
        ) : tab === 'reverts' ? (
          <YieldRows report={yieldReport} category="reverted" empty={t('spend.optimize.reverts.empty')} />
        ) : tab === 'abandoned' ? (
          <YieldRows report={yieldReport} category="abandoned" empty={t('spend.optimize.abandoned.empty')} />
        ) : (
          <FixesRows data={overview.data} />
        )}
      </Panel>
    </>
  )
}

function WasteRows({ report }: { report: Polled<OptimizeJsonReport> }) {
  if (!report.data) {
    if (report.error) return <CliErrorPanel error={report.error} subject={t('common.subject.optimize')} />
    return <EmptyNote>{t('spend.optimize.waste.scanning')}</EmptyNote>
  }

  return (
    <div className="opt-waste">
      <div className="opt-summary">
        {t('spend.optimize.waste.summary', {
          count: formatCount(report.data.summary.findingCount, 'finding'),
          savings: formatUsd(report.data.summary.potentialSavingsCostUSD),
          health: report.data.summary.healthScore,
        })}
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

/** Computed at call time (not a module-level const) so it re-reads the current locale. */
function verdictLabel(verdict: AppliedFix['verdict']): string {
  return {
    worked: t('spend.optimize.verdict.worked'),
    partial: t('spend.optimize.verdict.partial'),
    'no-effect': t('spend.optimize.verdict.noEffect'),
    pending: t('spend.optimize.verdict.pending'),
  }[verdict]
}

// Closes the loop after `optimize --apply`: what each applied fix actually
// measured, and for the ones that did nothing, how to put them back.
function AppliedFixRows({ fixes }: { fixes: AppliedFix[] }) {
  if (!fixes.length) return null

  return (
    <div className="opt-findings opt-applied">
      <div className="opt-group">{t('spend.optimize.applied.header')}</div>
      {fixes.map(fix => (
        <div className={`opt-applied-row opt-applied-${fix.verdict}`} key={fix.id}>
          <span className="opt-applied-glyph" aria-hidden="true">{VERDICT_GLYPH[fix.verdict]}</span>
          <b className="opt-finding-title">{fix.findingId ?? fix.kind}</b>
          <span className="opt-applied-verdict">{verdictLabel(fix.verdict)}</span>
          <span className="opt-finding-tokens">
            {fix.verdict === 'pending'
              ? '\u2014'
              : t('spend.optimize.applied.estimate', { est: formatCompact(fix.estimatedTokens), realized: formatCompact(fix.realizedTokens) })}
          </span>
        </div>
      ))}
      {fixes.some(fix => fix.verdict === 'no-effect') && (
        <div className="opt-summary opt-applied-hint">{t('spend.optimize.applied.hint')}<code>{fixes.find(fix => fix.verdict === 'no-effect')!.undoCommand}</code></div>
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

/** Computed at call time (not a module-level const) so it re-reads the current locale. */
function classHeader(cls: FindingClass): string {
  return {
    fix: t('spend.optimize.class.fix'),
    nudge: t('spend.optimize.class.nudge'),
    keep: t('spend.optimize.class.keep'),
  }[cls]
}

function severityLabel(severity: 'high' | 'medium' | 'low'): string {
  return {
    high: t('spend.optimize.severity.high'),
    medium: t('spend.optimize.severity.medium'),
    low: t('spend.optimize.severity.low'),
  }[severity]
}

function actionText(fix: WasteAction): string {
  return fix.type === 'file-content' ? fix.content : fix.text
}

function ActionableFindingRows({ findings, byClass }: { findings: OptimizeFinding[]; byClass: OptimizeJsonReport['summary']['byClass'] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  if (!findings.length) return <EmptyNote>{t('spend.optimize.waste.empty')}</EmptyNote>

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
                {t('spend.optimize.class.summary', {
                  header: classHeader(finding.class),
                  tokens: formatCompact(byClass[finding.class].tokensSaved),
                  savings: formatUsd(byClass[finding.class].savingsUSD),
                  findings: formatCount(byClass[finding.class].count, 'finding'),
                })}
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
                {severityLabel(finding.severity)}
              </span>
              <span className="opt-finding-titlewrap">
                <b className="opt-finding-title">{finding.title}</b>
                {finding.trend === 'improving' && (
                  <span className="opt-trend opt-trend-improving">{t('spend.optimize.trend.improving')}<Icon name="arrow-down" className="opt-impact-mark" /></span>
                )}
              </span>
              <span className="opt-finding-savings">{formatUsd(finding.estimatedSavingsUSD)}</span>
              <span className="opt-finding-tokens">{t('spend.optimize.finding.tokensBasis', { tokens: formatCompact(finding.tokensSaved), basis: finding.basis })}</span>
              <span className="opt-finding-chevron" aria-hidden="true"><Icon name="chevron-right" /></span>
            </button>
            {expanded && (
              <div className="opt-finding-detail" role="region" aria-label={t('spend.optimize.findingDetailsAria', { title: finding.title })}>
                <p className="opt-explanation">{finding.explanation}</p>
                <div className={`opt-fix opt-fix-${finding.fix.type}`}>
                  <div className="opt-fix-head">
                    <div>
                      <b>{finding.fix.label}</b>
                      {finding.fix.type === 'file-content' && <span className="opt-fix-path">{finding.fix.path}</span>}
                    </div>
                    <button className="opt-copy" type="button" onClick={() => void copyFix(finding)}>
                      {copiedId === finding.id ? t('spend.optimize.copy.done') : t('spend.optimize.copy.label')}
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
            {severityLabel(finding.impact)}
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
  if (report.error || !report.data) return <EmptyNote>{t('spend.optimize.yield.unavailable')}</EmptyNote>

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
              {row.commitCount === 1
                ? t('spend.optimize.yield.commit.one', { count: row.commitCount.toLocaleString('en-US') })
                : t('spend.optimize.yield.commit.other', { count: row.commitCount.toLocaleString('en-US') })} · {row.sessionId}
            </span>
          </div>
          <span className="val">{formatUsd(row.costUSD)}</span>
        </div>
      ))}
    </>
  )
}

function FixesRows({ data }: { data: MenubarPayload }) {
  return <FindingRows findings={data.optimize.topFindings} empty={t('spend.optimize.fixes.empty')} />
}

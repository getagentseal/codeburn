import { useEffect, useMemo, useRef } from 'react'

import { Stat } from './Stat'
import { useEscape } from '../hooks/useEscape'
import { formatCompact, formatDayLong, formatDuration, formatUsd, shortenProjectPath } from '../lib/format'
import { DUR, useExitAnimation } from '../lib/motion'
import { codeburn } from '../lib/ipc'
import type { InvestigationFilters } from '../lib/investigation'
import { contributeRow } from '../lib/investigation'
import type { SessionDrillRow } from '../lib/types'
import { Icon } from './icons'

/**
 * The drill-through side drawer: a plain-language read of one session, then the
 * cost/token figures and every link the report carries (PR URLs). All content
 * derives from the already-loaded contributions report: no transcript text
 * ever crosses the IPC boundary and the heavy breakdowns below only render
 * while the drawer is open (lazy by mount, not by fetch), so the list behind it
 * stays responsive.
 *
 * A11y contract: role="dialog", Escape closes, focus moves into the panel on
 * open and the PARENT returns focus to the control that opened it (the opener
 * element is still alive behind the drawer). Tab is trapped inside.
 */
export function SessionDrawer({ row, openKey, filters, medianCost, onClose }: {
  row: SessionDrillRow
  /** Row identity, so a drawer still exiting on the old row disarms its close
   *  when the user picks a new one. */
  openKey: string
  filters: InvestigationFilters
  /** Median cost of the sessions the list is currently showing (the searched
   *  and filtered set). Absent when the population is too small for the
   *  comparison to mean anything. */
  medianCost?: number
  onClose: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const { closing, beginExit } = useExitAnimation(onClose, DUR.slow, openKey)

  useEscape(true, beginExit)

  useEffect(() => {
    const panel = panelRef.current
    panel?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !panel) return
      // Keep Tab cycling inside the drawer while it is open.
      const focusable = panel.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
      if (focusable.length === 0) return
      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  const contribution = useMemo(() => contributeRow(row, filters), [row, filters])
  const breakdown = useMemo(() => buildBreakdowns(row), [row])
  const cacheTotal = row.inputTokens + row.cacheReadTokens
  const cacheHit = cacheTotal > 0 ? Math.round(row.cacheReadTokens / cacheTotal * 100) : 0
  const median = medianCost !== undefined && medianCost > 0 ? medianCost : null
  const selectedCost = contribution !== null && contribution.cost < row.cost - 1e-9 ? contribution.cost : null
  const leadCost = selectedCost ?? row.cost
  // Past 100x the multiple says nothing the dollar figure has not already said.
  const ratio = median === null || leadCost / median > 100 ? null : leadCost / median
  const foldLabel = branchPrLabel(breakdown)

  return (
    <>
      <div className={closing ? 'drawer-scrim closing' : 'drawer-scrim'} aria-hidden="true" onClick={beginExit} />
      <aside
        ref={panelRef}
        className={closing ? 'session-drawer closing' : 'session-drawer'}
        role="dialog"
        aria-modal="true"
        aria-label={`Session details: ${row.title || shortenProjectPath(row.project)}`}
        tabIndex={-1}
      >
        <div className="drawer-head">
          <div>
            <h3 className="drawer-title">{row.title || shortenProjectPath(row.project)}</h3>
            <div className="drawer-sub">
              {row.provider} · {shortenProjectPath(row.project)} · <span className="mono">{row.sessionId.slice(0, 18)}</span>
            </div>
            <div className="drawer-sub">
              {formatDayLong(row.startedAt)} → {formatDayLong(row.endedAt)}
              {row.durationMs > 0 && <> · {formatDuration(row.durationMs)}</>}
            </div>
          </div>
          <button type="button" className="drawer-close" aria-label="Close session details" onClick={beginExit}><Icon name="x" /></button>
        </div>

        <p className="drawer-lead">
          {selectedCost === null ? 'This session cost ' : 'Your selection of this session cost '}
          <b>{formatUsd(leadCost)}</b>
          {ratio === null ? '.' : ratio < 0.1 ? ', a fraction of your usual.' : <>, about <b>{formatRatio(ratio)}x</b> your usual.</>}
        </p>

        <div className="stats drawer-tiles">
          <Stat
            label="Cost"
            value={formatUsd(leadCost)}
            delta={selectedCost !== null
              ? `of ${formatUsd(row.cost)} total`
              : ratio === null
                ? 'full session'
                : ratio < 0.1
                  ? <span className="down">well below median</span>
                  : <span className={ratio >= 1 ? 'up' : 'down'}>{formatRatio(ratio)}x your median</span>}
          />
          <Stat label="Turns" value={row.turns.toLocaleString()} delta={`${row.calls.toLocaleString()} ${row.calls === 1 ? 'call' : 'calls'}`} />
          {row.durationMs > 0
            ? <Stat label="Duration" value={formatDuration(row.durationMs)} delta="wall clock" />
            : <Stat label="Calls" value={row.calls.toLocaleString()} delta="API calls" />}
        </div>

        {row.isSidechain && row.parentSessionId && (
          <p className="drawer-note">Subagent run of session <span className="mono">{row.parentSessionId.slice(0, 18)}</span>.</p>
        )}

        <DrawerBreakdown label="Models" rows={breakdown.models} />
        <DrawerBreakdown label="Task categories" rows={breakdown.categories} />

        <details className="drawer-fold">
          <summary>
            Tokens: {formatCompact(row.inputTokens)} in, {formatCompact(row.outputTokens)} out,{' '}
            {formatCompact(row.cacheWriteTokens)} written to cache, {cacheHit}% cache hits
          </summary>
          <div className="drawer-fold-body">
            <div className="stats">
              <Stat label="Input" value={formatCompact(row.inputTokens)} delta="tokens sent" />
              <Stat label="Output" value={formatCompact(row.outputTokens)} delta="tokens generated" />
              <Stat label="Cache read" value={formatCompact(row.cacheReadTokens)} delta={`${cacheHit}% hit`} />
              <Stat label="Cache write" value={formatCompact(row.cacheWriteTokens)} delta="tokens cached" />
            </div>
          </div>
        </details>

        {foldLabel !== null && (
          <details className="drawer-fold">
            <summary>Branches and pull requests: {foldLabel}</summary>
            <div className="drawer-fold-body">
              <DrawerBreakdown label="Branches" rows={breakdown.branches} caption="Git branch carried across turns (Claude sessions only)." />
              {breakdown.days.length > 1 && <DrawerBreakdown label="Days" rows={breakdown.days} />}
              <DrawerBreakdown label="Pull requests" rows={breakdown.prs} caption="A turn that touched several PRs counts toward each of them, so the rows can add up to more than the total." link />
              {breakdown.unattributedPrCost > 0 && (
                <p className="drawer-note">Not tied to a specific PR: {formatUsd(breakdown.unattributedPrCost)}</p>
              )}
            </div>
          </details>
        )}

        <p className="drawer-note">
          {row.savingsUSD > 0 ? `Saved vs baseline: ${formatUsd(row.savingsUSD)}.` : 'Saved vs baseline: none this session.'}
        </p>
      </aside>
    </>
  )
}

function formatRatio(ratio: number): string {
  return (ratio >= 10 ? Math.round(ratio) : Math.round(ratio * 10) / 10).toLocaleString('en-US')
}

function branchPrLabel({ branches, prs }: { branches: BreakdownRow[]; prs: BreakdownRow[] }): string | null {
  const parts: string[] = []
  // A lone `main` with no PRs is every session's default: nothing to unfold.
  if (branches.length > 0 && !(branches.length === 1 && branches[0]!.label === 'main' && prs.length === 0)) {
    const named = branches.slice(0, 2).map(entry => entry.label).join(', ')
    parts.push(branches.length > 2 ? `${named}, +${branches.length - 2} more` : named)
  }
  if (prs.length > 0) parts.push(`${prs.length} PR${prs.length === 1 ? '' : 's'}`)
  return parts.length > 0 ? parts.join(', ') : null
}

type BreakdownRow = { key: string; label: string; cost: number; approx?: boolean; url?: string }

function buildBreakdowns(row: SessionDrillRow): {
  models: BreakdownRow[]
  categories: BreakdownRow[]
  branches: BreakdownRow[]
  days: BreakdownRow[]
  prs: BreakdownRow[]
  unattributedPrCost: number
} {
  const models = new Map<string, number>()
  const categories = new Map<string, number>()
  const branches = new Map<string, number>()
  const days = new Map<string, number>()
  const prs = new Map<string, { cost: number; approx: boolean }>()
  let unattributedPrCost = 0
  const segments = row.contributions?.segments ?? []
  for (const segment of segments) {
    for (const [model, cost] of Object.entries(segment.models)) {
      if (cost === 0) continue
      models.set(model, (models.get(model) ?? 0) + cost)
    }
    if (segment.category && segment.cost > 0) categories.set(segment.category, (categories.get(segment.category) ?? 0) + segment.cost)
    if (segment.branch && segment.cost > 0) branches.set(segment.branch, (branches.get(segment.branch) ?? 0) + segment.cost)
    if (segment.day && segment.cost > 0) days.set(segment.day, (days.get(segment.day) ?? 0) + segment.cost)
    if (segment.prs.length === 0) {
      unattributedPrCost += segment.cost
    } else {
      const share = 1 / segment.prs.length
      for (const url of segment.prs) {
        const entry = prs.get(url) ?? { cost: 0, approx: false }
        entry.cost += segment.cost * share
        entry.approx = entry.approx || segment.approx === true
        prs.set(url, entry)
      }
    }
  }
  const toRows = (map: Map<string, number>): BreakdownRow[] =>
    [...map.entries()]
      .map(([key, cost]) => ({ key, label: key, cost }))
      .sort((a, b) => b.cost - a.cost)
  return {
    models: toRows(models).map(entry => ({ ...entry, label: entry.key === '' ? 'Unknown model' : entry.key })),
    categories: toRows(categories),
    branches: toRows(branches).map(entry => ({ ...entry, label: entry.key })),
    days: toRows(days),
    prs: [...prs.entries()]
      .map(([url, entry]) => ({ key: url, label: prLabel(url), cost: entry.cost, approx: entry.approx || undefined, url }))
      .sort((a, b) => b.cost - a.cost),
    unattributedPrCost,
  }
}

/** Short `owner/repo#123` form for GitHub URLs, else the URL itself — the same
 *  rule the by-PR report uses for labels. */
function prLabel(url: string): string {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url)
  return match ? `${match[1]}/${match[2]}#${match[3]}` : url
}

function DrawerBreakdown({ label, rows, caption, link = false }: {
  label: string
  rows: BreakdownRow[]
  caption?: string
  link?: boolean
}) {
  if (rows.length === 0) return null
  const max = rows[0]!.cost
  return (
    <div className="drawer-breakdown" role="group" aria-label={`${label} breakdown`}>
      <div className="drawer-breakdown-head">{label}</div>
      {rows.map(entry => (
        <div className="drawer-breakdown-row" key={entry.key}>
          <span className="drawer-breakdown-label" title={entry.url ?? entry.label}>{entry.label}</span>
          <div className="drawer-breakdown-bar" aria-hidden="true"><span style={{ width: `${max > 0 ? entry.cost / max * 100 : 0}%` }} /></div>
          {link && entry.url
            ? (
                <a
                  className="drawer-breakdown-cost drawer-link"
                  href={entry.url}
                  onClick={event => {
                    event.preventDefault()
                    void codeburn.openExternal(entry.url!)
                  }}
                >
                  {entry.approx ? '~' : ''}{formatUsd(entry.cost)}
                </a>
              )
            : <span className="drawer-breakdown-cost">{formatUsd(entry.cost)}</span>}
        </div>
      ))}
      {caption && <p className="drawer-caption">{caption}</p>}
    </div>
  )
}

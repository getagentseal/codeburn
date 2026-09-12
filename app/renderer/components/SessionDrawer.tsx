import { useEffect, useMemo, useRef } from 'react'

import { Stat } from './Stat'
import { formatCompact, formatDayLong, formatDuration, formatUsd, shortenProjectPath } from '../lib/format'
import { codeburn } from '../lib/ipc'
import type { InvestigationFilters } from '../lib/investigation'
import { contributeRow } from '../lib/investigation'
import type { SessionDrillRow } from '../lib/types'

/**
 * The drill-through side drawer: a session's metadata, the cost/token figures
 * that matter in the CURRENT selection next to its full totals, and every link
 * the report carries (PR URLs). All content derives from the already-loaded
 * contributions report — no transcript text ever crosses the IPC boundary and
 * the heavy breakdowns below only render while the drawer is open (lazy by
 * mount, not by fetch), so the list behind it stays responsive.
 *
 * A11y contract: role="dialog", Escape closes, focus moves into the panel on
 * open and the PARENT returns focus to the control that opened it (the opener
 * element is still alive behind the drawer). Tab is trapped inside.
 */
export function SessionDrawer({ row, filters, onClose }: {
  row: SessionDrillRow
  filters: InvestigationFilters
  onClose: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const panel = panelRef.current
    panel?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        return
      }
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
  }, [onClose])

  const contribution = useMemo(() => contributeRow(row, filters), [row, filters])
  const breakdown = useMemo(() => buildBreakdowns(row), [row])
  const cacheTotal = row.inputTokens + row.cacheReadTokens
  const cacheHit = cacheTotal > 0 ? Math.round(row.cacheReadTokens / cacheTotal * 100) : 0

  return (
    <>
      <div className="drawer-scrim" aria-hidden="true" onClick={onClose} />
      <aside
        ref={panelRef}
        className="session-drawer"
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
              {formatDayLong(row.startedAt)} → {formatDayLong(row.endedAt)} · {formatDuration(row.durationMs)}
            </div>
          </div>
          <button type="button" className="drawer-close" aria-label="Close session details" onClick={onClose}>×</button>
        </div>

        <div className="stats">
          <Stat label="Cost" value={formatUsd(row.cost)} delta="full session" />
          {contribution !== null && (
            <Stat label="In selection" value={formatUsd(contribution.cost)} delta={contribution.cost < row.cost - 1e-9 ? 'part of this session' : 'whole session'} />
          )}
          <Stat label="Calls" value={row.calls.toLocaleString()} delta="API calls" />
          <Stat label="Turns" value={row.turns.toLocaleString()} delta="assistant turns" />
          <Stat label="Saved" value={formatUsd(row.savingsUSD)} delta="vs baseline" />
          <Stat label="Input" value={formatCompact(row.inputTokens)} delta="tokens sent" />
          <Stat label="Output" value={formatCompact(row.outputTokens)} delta="tokens generated" />
          <Stat label="Cache read" value={formatCompact(row.cacheReadTokens)} delta={`${cacheHit}% hit`} />
          <Stat label="Cache write" value={formatCompact(row.cacheWriteTokens)} delta="tokens cached" />
        </div>

        {row.isSidechain && row.parentSessionId && (
          <p className="drawer-note">Subagent run of session <span className="mono">{row.parentSessionId.slice(0, 18)}</span>.</p>
        )}

        <DrawerBreakdown label="Models" rows={breakdown.models} />
        <DrawerBreakdown label="Task categories" rows={breakdown.categories} />
        <DrawerBreakdown label="Branches" rows={breakdown.branches} caption="Git branch carried across turns (Claude sessions only)." />
        {breakdown.days.length > 1 && <DrawerBreakdown label="Days" rows={breakdown.days} />}
        <DrawerBreakdown label="Pull requests" rows={breakdown.prs} caption="A turn split across several PRs contributes its share to each — rows are not an exclusive partition." link />
        {breakdown.unattributedPrCost > 0 && (
          <p className="drawer-note">Not tied to a specific PR: {formatUsd(breakdown.unattributedPrCost)}</p>
        )}
      </aside>
    </>
  )
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

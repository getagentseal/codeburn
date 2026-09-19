import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type WheelEvent } from 'react'
import type { MenubarPayload } from '../lib/payload'
import type { CurrencyState } from '../lib/currency'
import { formatCompactCurrency, formatCurrency, plural } from '../lib/currency'
import { severity, summaryFor, type QuotaState, type QuotaSummary } from '../lib/quota'
import { WATCHED_TOOLS, watchedSource } from '../lib/watched'
import { ChevronRight } from './Icons'
import { QuotaPopover } from './QuotaPopover'

/// Any provider id the CLI reports, plus `all`. The CLI's own ids are what `--provider`
/// accepts, so a tab built from the payload is directly usable as a filter argument.
export type Provider = string

export const ALL_PROVIDER: Provider = 'all'

/// The popover's horizontal gutter, which the strip and the hover cards share.
const GUTTER = 12

export type ProviderTab = {
  id: Provider
  label: string
  cost: number
  /// False only for a known tool the payload never mentioned: it stays visible, dimmed,
  /// so a first-time reader can see what CodeBurn watches for.
  detected: boolean
  /// Where CodeBurn would find this tool, shown in the hover preview when it is missing.
  source: string | null
}

/// The tools the app can describe without any help from the payload. Used only when the CLI
/// reports no provider with activity, which is the first-run case the copy is written for.
/// Both the label and the location come from lib/watched, which the empty state reads too.
const KNOWN_TOOLS: Array<{ id: Provider; label: string; source: string }> = WATCHED_TOOLS.map(t => ({
  id: t.id,
  label: t.label,
  source: watchedSource(t),
}))

/// Provider marks from mac/Sources/CodeBurnMenubar/Views/AgentTabStrip.swift (ProviderFilter
/// .color), keyed by the CLI provider id rather than the Swift case name. Kept for the
/// surfaces that still want a brand colour; the tab chips themselves carry none.
const PROVIDER_COLORS: Record<string, string> = {
  all: '#C9521D',
  claude: '#C9521D',
  cline: '#238A7E',
  codewhale: '#38BDF8',
  codex: '#4A7D5C',
  cursor: '#3F6B8C',
  'cursor-agent': '#4EC9B0',
  copilot: '#6D8FA6',
  devin: '#25A08D',
  droid: '#7C3AED',
  gemini: '#4485F4',
  'ibm-bob': '#0F62FE',
  'kilo-code': '#009688',
  kiro: '#4A9EC4',
  kimi: '#A4C639',
  kimicode: '#A3E635',
  'lingtai-tui': '#22A7A0',
  openclaw: '#DA7056',
  openclaude: '#C2416B',
  opencode: '#5B835B',
  pi: '#B26B3D',
  qwen: '#615EEB',
  omp: '#8B5CB0',
  'roo-code': '#4CAF50',
  crush: '#E06C9F',
  antigravity: '#FF7A45',
  goose: '#B78D52',
  grok: '#8E8E93',
  hermes: '#C7523E',
  zcode: '#526ED6',
  workbuddy: '#2563EB',
  workbuddyai: '#06B6D4',
}

export function providerColor(id: Provider): string {
  return PROVIDER_COLORS[id] ?? 'var(--label-3)'
}

/// The tabs for a payload: All first, then every provider the CLI saw activity for, dearest
/// first. Falls back to the known-tool list only when the payload names nobody, so a fresh
/// machine still shows what is being watched.
export function providerTabs(payload: MenubarPayload | null): ProviderTab[] {
  const details = payload?.current.providerDetails ?? []
  const active = details.filter(d => d.hasUsage ?? (d.cost > 0 || (d.calls ?? 0) > 0))
  if (active.length > 0) {
    const sorted = [...active].sort((a, b) => (b.cost - a.cost) || a.label.localeCompare(b.label))
    const total = sorted.reduce((sum, d) => sum + d.cost, 0)
    return [
      { id: ALL_PROVIDER, label: 'All', cost: total, detected: true, source: 'every detected tool' },
      ...sorted.map(d => ({ id: d.id, label: d.label, cost: d.cost, detected: true, source: null })),
    ]
  }
  const legacy = payload?.current.providers ?? {}
  const known = KNOWN_TOOLS.map(t => ({
    id: t.id,
    label: t.label,
    cost: legacy[t.id] ?? 0,
    detected: t.id in legacy,
    source: t.source,
  }))
  const total = known.reduce((sum, t) => sum + t.cost, 0)
  return [
    { id: ALL_PROVIDER, label: 'All', cost: total, detected: known.some(t => t.detected), source: 'every detected tool' },
    ...known,
  ]
}

export function providerLabel(tabs: ProviderTab[], id: Provider): string {
  return tabs.find(t => t.id === id)?.label ?? id
}

/// Hover delays from AgentTab in AgentTabStrip.swift.
const QUOTA_HOVER_IN_MS = 250
const QUOTA_HOVER_OUT_MS = 150
const QUOTA_CARD_WIDTH = 260

type Props = {
  selected: Provider
  onSelect: (p: Provider) => void
  payload: MenubarPayload | null
  currency: CurrencyState
  quota: QuotaState
}

export function AgentTabStrip({ selected, onSelect, payload, currency, quota }: Props) {
  const [hovered, setHovered] = useState<Provider | null>(null)
  const [quotaCard, setQuotaCard] = useState<{ provider: Provider; left: number } | null>(null)
  const [overflowing, setOverflowing] = useState(false)
  const row = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const hoverTimer = useRef<number>(0)
  // A click dismisses the card and holds it dismissed until the pointer leaves the tab, so
  // switching provider does not leave a card sitting over the view you just switched to.
  const clickDismissed = useRef(false)
  const tabs = providerTabs(payload)

  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    if (scroller.current && e.deltaY !== 0 && e.deltaX === 0) {
      scroller.current.scrollLeft += e.deltaY
    }
  }

  /// The mac calls the strip overflowing 30pt before the content actually clips, so the
  /// chevrons appear while there is still room for them. Both measurements are of elements
  /// the chevrons do not resize, so showing them cannot feed back into the decision.
  const measure = useCallback(() => {
    if (row.current && content.current) {
      setOverflowing(content.current.scrollWidth > row.current.clientWidth - 30)
    }
  }, [])

  useLayoutEffect(measure)
  useEffect(() => {
    const el = row.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [measure])

  // Keep the active tab in view, the way the mac scrolls it to centre on every change.
  useEffect(() => {
    scroller.current?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  }, [selected, tabs.length])

  useEffect(() => () => window.clearTimeout(hoverTimer.current), [])

  const index = Math.max(0, tabs.findIndex(t => t.id === selected))
  const step = (direction: -1 | 1) => {
    const target = tabs[Math.min(Math.max(index + direction, 0), tabs.length - 1)]
    if (target && target.detected) onSelect(target.id)
  }

  const enter = (tab: ProviderTab, event: ReactMouseEvent<HTMLElement>) => {
    setHovered(tab.id)
    window.clearTimeout(hoverTimer.current)
    if (clickDismissed.current || summaryFor(quota, tab.id) === null) return
    // Centre the card under its tab, then keep it inside the popover's gutters.
    const chip = event.currentTarget.getBoundingClientRect()
    const strip = row.current?.getBoundingClientRect()
    const span = strip ? strip.width - 2 * GUTTER : QUOTA_CARD_WIDTH
    const centred = chip.left + chip.width / 2 - (strip?.left ?? 0) - GUTTER - QUOTA_CARD_WIDTH / 2
    const left = Math.min(Math.max(centred, 0), Math.max(0, span - QUOTA_CARD_WIDTH))
    hoverTimer.current = window.setTimeout(() => setQuotaCard({ provider: tab.id, left }), QUOTA_HOVER_IN_MS)
  }

  const leave = () => {
    setHovered(null)
    clickDismissed.current = false
    window.clearTimeout(hoverTimer.current)
    hoverTimer.current = window.setTimeout(() => setQuotaCard(null), QUOTA_HOVER_OUT_MS)
  }

  const preview = hovered ? previewFor(hovered, tabs, currency) : null
  const card = quotaCard ? summaryFor(quota, quotaCard.provider) : null

  return (
    <div className="agent-tabs-wrap" onMouseLeave={leave}>
      <div className="agent-tabs-row" ref={row}>
        {overflowing && (
          <button
            type="button"
            className="tab-chevron"
            disabled={index <= 0}
            aria-label="Show previous providers"
            onClick={() => step(-1)}
          >
            <ChevronRight size={11} style={{ transform: 'rotate(180deg)' }} />
          </button>
        )}
        <nav className="agent-tabs" aria-label="Provider" ref={scroller} onWheel={onWheel}>
          <div className="agent-tabs-content" ref={content}>
            {tabs.map(tab => {
              const active = selected === tab.id
              const summary = summaryFor(quota, tab.id)
              return (
                <button
                  key={tab.id}
                  type="button"
                  data-active={active}
                  className={`tab ${active ? 'tab-active' : ''} ${tab.detected ? '' : 'tab-muted'}`}
                  aria-pressed={active}
                  aria-disabled={!tab.detected}
                  onMouseEnter={event => enter(tab, event)}
                  onFocus={() => setHovered(tab.id)}
                  onClick={() => {
                    clickDismissed.current = true
                    window.clearTimeout(hoverTimer.current)
                    setQuotaCard(null)
                    if (tab.detected) onSelect(tab.id)
                  }}
                >
                  <span className="tab-chip">
                    <span className="tab-label">{tab.label}</span>
                    {tab.detected && tab.cost > 0 && (
                      <span className="tab-cost">{formatCompactCurrency(tab.cost, currency)}</span>
                    )}
                  </span>
                  {summary && <QuotaCapsule quota={summary} active={active} />}
                </button>
              )
            })}
          </div>
        </nav>
        {overflowing && (
          <button
            type="button"
            className="tab-chevron"
            disabled={index >= tabs.length - 1}
            aria-label="Show next providers"
            onClick={() => step(1)}
          >
            <ChevronRight size={11} />
          </button>
        )}
      </div>
      {(preview || card) && (
        <div className="tab-hover">
          {preview && (
            <div className="tab-preview" role="tooltip">
              <div className="tab-preview-title">{preview.title}</div>
              <div className="tab-preview-body">{preview.body}</div>
            </div>
          )}
          {card && quotaCard && (
            <div className="quota-anchor" style={{ marginLeft: quotaCard.left }} role="tooltip">
              <QuotaPopover quota={card} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/// AgentTabQuotaBar: the 3px capsule under a tab whose provider reports live quota. Solid red
/// when the credential needs re-connecting, so a broken provider reads as broken at a glance.
function QuotaCapsule({ quota, active }: { quota: QuotaSummary; active: boolean }) {
  const percent = quota.headline?.usedPct
  const broken = quota.connection === 'terminalFailure'
  const tone = percent === undefined ? 'normal' : severity(percent)
  return (
    <span className={`tab-quota ${active ? 'tab-quota-active' : ''}`}>
      {broken ? (
        <span className="tab-quota-fill is-danger" style={{ width: '100%' }} />
      ) : percent !== undefined ? (
        <span
          className={`tab-quota-fill is-${tone} ${active && tone === 'normal' ? 'tab-quota-fill-active' : ''}`}
          style={{ width: `${Math.min(100, Math.max(2, percent))}%` }}
        />
      ) : null}
    </span>
  )
}

function previewFor(id: Provider, tabs: ProviderTab[], currency: CurrencyState): { title: string; body: string } | null {
  const tab = tabs.find(t => t.id === id)
  if (!tab) return null
  const others = tabs.filter(t => t.id !== ALL_PROVIDER && t.detected)
  const total = tabs.find(t => t.id === ALL_PROVIDER)?.cost ?? 0
  if (id === ALL_PROVIDER) {
    if (others.length === 0) return { title: 'No tools detected yet', body: 'Run one of the supported tools once, then refresh.' }
    return {
      title: `${formatCurrency(total, currency)} today across ${plural(others.length, 'tool')}`,
      body: others.map(t => `${t.label} ${formatCompactCurrency(t.cost, currency)}`).join(' · '),
    }
  }
  if (!tab.detected) {
    return { title: `${tab.label} not detected on this machine`, body: `CodeBurn watches ${tab.source ?? 'this tool'}.` }
  }
  const share = total > 0 ? Math.round((tab.cost / total) * 100) : 0
  return {
    title: `${tab.label} · ${formatCurrency(tab.cost, currency)} today`,
    body: tab.cost > 0 ? `${share}% of today's spend · click to filter every view` : 'No spend yet today · click to filter every view',
  }
}

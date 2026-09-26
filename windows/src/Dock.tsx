import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { ProviderGlyph } from './providerIcons'
import { providerColor } from './components/AgentTabStrip'
import {
  ACCEPTS_KEY,
  EMPTY_QUOTA,
  connectionFor,
  refreshQuota,
  subscribeQuota,
  visibleFooterLines,
  type Connection,
  type QuotaState,
} from './lib/quota'
import {
  DEFAULT_DOCK_PREFS,
  autoSeed,
  loadDockPrefs,
  normalizedPreferred,
  onDockPrefsChanged,
  writeDockPrefs,
  type DockPrefs,
} from './lib/dockPrefs'
import {
  EMPTY_GLANCE,
  compactTokens,
  contextFraction,
  contextRemaining,
  isIdle,
  runningLabel,
  sessionSubtitle,
  sessionTitle,
  sessionsFor,
  subscribeDailyBudget,
  subscribeGlance,
  thousands,
  usd,
  type Glance,
  type LiveSession,
} from './lib/glance'
import {
  MAX_WINDOW_COLUMNS,
  MOTION,
  alongPad,
  bezier,
  bubblePath,
  clampFraction,
  detailPadding,
  displayLabel,
  gaugeClipPath,
  gaugePath,
  glanceMetrics,
  glanceSeverity,
  headlineWindow,
  isVertical,
  opposite,
  pct,
  railLength,
  metrics,
  railPath,
  resetsIn,
  sessionListHeight,
  severity,
  type Curve,
  type Edge,
  type GaugeShape,
  type GlanceMetrics,
  type Metrics,
  type QuotaWindow,
  type Severity,
} from './dockGeometry'
import { track } from './lib/telemetry'
import './dock.css'

const PROVIDER_NAMES: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  copilot: 'GitHub Copilot',
  antigravity: 'Antigravity',
  kimi: 'Kimi',
}

type Provider = {
  id: string
  name: string
  available: boolean
  plan?: string
  windows: QuotaWindow[]
  error?: string
}

type Rect = { x: number; y: number; w: number; h: number }
type DockFrame = {
  rail: Rect
  edge: Edge
  vertical: boolean
  docked: boolean
  alongPad: number
  anchor: 'start' | 'end'
  bubbleSide: Edge
  detail: (Rect & { tail: number }) | null
  nativePointer: boolean
}
type PointerSnapshot = { railHovered: boolean; row: number | null; detailHovered: boolean }
const NO_POINTER: PointerSnapshot = { railHovered: false, row: null, detailHovered: false }

/// Port of CapacityDockInteractionState: the immediate truth that decides whether a delayed
/// hover action is still valid when its timer fires.
type Interaction = {
  railHovered: boolean
  detailHovered: boolean
  pinned: boolean
  collapseGrace: boolean
  dragging: boolean
}
const REST: Interaction = { railHovered: false, detailHovered: false, pinned: false, collapseGrace: false, dragging: false }
const isExpanded = (i: Interaction) => i.pinned || i.railHovered || i.detailHovered || i.collapseGrace
const canCollapse = (i: Interaction) => !i.pinned && !i.railHovered && !i.detailHovered && !i.collapseGrace && !i.dragging

type DetailPhase = 'entering' | 'shown' | 'dismissing'

function useTimers() {
  const timers = useRef<Record<string, number>>({})
  const cancel = useCallback((name: string) => {
    window.clearTimeout(timers.current[name])
    delete timers.current[name]
  }, [])
  const schedule = useCallback(
    (name: string, ms: number, fn: () => void) => {
      cancel(name)
      timers.current[name] = window.setTimeout(() => {
        delete timers.current[name]
        fn()
      }, ms)
    },
    [cancel]
  )
  useEffect(() => {
    const all = timers.current
    return () => Object.values(all).forEach((id) => window.clearTimeout(id))
  }, [])
  return { schedule, cancel }
}

type Motion = { duration: number; curve: Curve }

/// A value eased toward its target with the mac's curves. A retarget restarts from the current
/// value so a quick reversal never snaps.
function useEased(target: number, motionFor: (from: number, to: number) => Motion, onSettled?: (value: number) => void): number {
  const [value, setValue] = useState(target)
  const live = useRef<{ value: number; raf: number }>({ value: target, raf: 0 })
  const settled = useRef(onSettled)
  settled.current = onSettled
  const pick = useRef(motionFor)
  pick.current = motionFor
  useEffect(() => {
    const from = live.current.value
    if (from === target) return
    const motion = pick.current(from, target)
    const start = performance.now()
    const step = (now: number) => {
      const linear = Math.min(1, (now - start) / motion.duration)
      const next = from + (target - from) * bezier(motion.curve, linear)
      live.current.value = next
      setValue(next)
      if (linear < 1) {
        live.current.raf = requestAnimationFrame(step)
      } else {
        settled.current?.(target)
      }
    }
    cancelAnimationFrame(live.current.raf)
    live.current.raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(live.current.raf)
  }, [target])
  return value
}

const RING_COLORS: Record<Severity, string> = {
  normal: '#30D158',
  warning: '#FFD60A',
  critical: '#FF9F0A',
  danger: '#FF453A',
}

function Ring({ m, shape, percent }: { m: Metrics; shape: GaugeShape; percent: number | null }) {
  const size = m.ringSize
  const stroke = m.ringStroke
  // Strokes are centred on the gauge path like SwiftUI's, so the box gets a margin for them.
  const box = size + m.ringMargin * 2
  const path = gaugePath(shape, box, size)
  // The arc is trimmed by a dash pattern over a normalized path length, which is the one
  // measure a circle and a squircle share.
  const amount = percent === null ? 0 : Math.min(1, Math.max(0, percent / 100))
  return (
    <svg className="dock-ring" width={box} height={box} viewBox={`0 0 ${box} ${box}`} aria-hidden="true">
      <defs>
        <linearGradient id="dock-ring-sheen" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.16" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0.07" />
          <stop offset="1" stopColor="#fff" stopOpacity="0.12" />
        </linearGradient>
      </defs>
      <path d={path} fill="none" stroke="rgba(0,0,0,0.74)" strokeWidth={stroke + 2 * m.scale} />
      <path d={path} fill="none" stroke="url(#dock-ring-sheen)" strokeWidth={stroke + 0.6 * m.scale} />
      {percent === null ? (
        <path d={path} fill="none" stroke="rgba(255,255,255,0.24)" strokeWidth={2 * m.scale} strokeDasharray={`${3 * m.scale} ${4 * m.scale}`} />
      ) : (
        <path
          d={path}
          fill="none"
          stroke={RING_COLORS[severity(percent)]}
          strokeWidth={stroke}
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray={`${(amount * 100).toFixed(2)} 100`}
          className="dock-ring-arc"
        />
      )}
    </svg>
  )
}

type RowProps = {
  m: Metrics
  shape: GaugeShape
  provider: Provider
  loading: boolean
  style: CSSProperties
  onEnter: () => void
  onLeave: () => void
  onClick: () => void
}

function Row({ m, shape, provider, loading, style, onEnter, onLeave, onClick }: RowProps) {
  const headline = provider.available ? headlineWindow(provider.windows) : null
  const percent = headline ? pct(headline.usedPct) : null
  const sev = percent === null ? null : severity(percent)
  return (
    <button
      type="button"
      className="dock-row"
      style={style}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={onClick}
      aria-label={`${provider.name} usage`}
    >
      <span className="dock-gauge">
        <Ring m={m} shape={shape} percent={percent} />
        <span className={`dock-glyph${loading ? ' is-loading' : ''}`}>
          <ProviderGlyph id={provider.id} size={m.providerIconSize} />
        </span>
        {provider.error ? <span className="dock-row-alert" /> : null}
      </span>
      <span className={`dock-pct${sev ? ` is-${sev}` : ' is-empty'}`}>{percent === null ? '--' : `${percent}%`}</span>
    </button>
  )
}

/// CapacityDockConnectionAction.resolve: the one recovery the bubble offers. A provider the
/// CLI could not read at all needs connecting; one it read and was refused needs reconnecting.
function connectionAction(provider: Provider): 'Connect' | 'Reconnect' | null {
  if (provider.available) return null
  return provider.error ? 'Reconnect' : 'Connect'
}

/// The mac says "Add API Key" where the provider's only credential is a token. Here that is
/// the same two providers whose settings pane offers a paste field.
function actionTitle(provider: Provider, action: 'Connect' | 'Reconnect'): string {
  return ACCEPTS_KEY.includes(provider.id) ? 'Add API Key' : action
}

function checkedLabel(fetchedAt: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - fetchedAt) / 60_000)
  if (minutes < 1) return 'Checked just now'
  if (minutes < 60) return `Checked ${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return `Checked ${hours}h ${minutes % 60}m ago`
}

/// The mac's footer carries provider facts its own adapters return. The CLI's `quota` output
/// drops those, so the two the dock can still tell honestly are how old the reading is and
/// what the bubble had no room to show.
function footerLines(provider: Provider, fetchedAt: number | null, now: number): string[] {
  const lines: string[] = []
  if (fetchedAt !== null) lines.push(checkedLabel(fetchedAt, now))
  const hidden = provider.windows.length - MAX_WINDOW_COLUMNS
  if (hidden > 0) lines.push(`${hidden} more window${hidden === 1 ? '' : 's'} not shown`)
  return visibleFooterLines(lines, provider.error ?? null).slice(0, 2)
}

function instruction(provider: Provider, quota: QuotaState): string {
  if (quota.cliOutdated) return 'CLI update needed for live quota. Run npm install -g codeburn.'
  if (quota.error) return quota.error
  return `Sign in with the ${provider.name} app or CLI. The dock checks again on the quota refresh cadence.`
}

/// A percentage drawn as its own gauge (PercentGaugeText): the glyphs sit dim, and the
/// value's own severity colour fills them left to right up to the value, wiped off on a
/// slant. One band colour, so the fill says how bad it is and the wipe says how far along.
function GaugeText({
  label,
  fraction,
  lineHeight,
  className,
}: {
  label: string
  fraction: number
  lineHeight: number
  className: string
}) {
  return (
    <span className={`dock-gauge-text ${className}`}>
      {/* The wipe is measured against the glyph run, as it is on the mac, so the run gets a
          box of its own rather than being clipped against the column it is centred in. */}
      <span className="dock-gauge-run">
        <span className="dock-gauge-base">{label}</span>
        <span
          className={`dock-gauge-fill is-${glanceSeverity(fraction)}`}
          style={{ clipPath: gaugeClipPath(fraction, lineHeight) }}
          aria-hidden="true"
        >
          {label}
        </span>
      </span>
    </span>
  )
}

/// One running session. The pill itself is the context gauge: a tinted band over the first
/// N% of its width, faded out at the leading edge so the boundary reads as a gradient rather
/// than a rule. A session waiting on the user recedes; one that is generating does not.
function SessionPill({ g, session, now }: { g: GlanceMetrics; session: LiveSession; now: number }) {
  const fraction = contextFraction(session)
  const remaining = contextRemaining(session)
  const tint = fraction === null ? '' : ` is-${glanceSeverity(fraction)}`
  return (
    <div className={`dock-pill${tint}${isIdle(session) ? ' is-idle' : ''}`}>
      {fraction === null ? null : (
        <span className="dock-pill-fill" style={{ width: `${(clampFraction(fraction) * 100).toFixed(2)}%` }} />
      )}
      <span className="dock-pill-text">
        <span className="dock-pill-title">{sessionTitle(session)}</span>
        <span className="dock-pill-sub">{sessionSubtitle(session, now)}</span>
      </span>
      {fraction === null ? null : (
        <span className="dock-pill-right">
          <GaugeText
            className="dock-pill-pct"
            label={`${Math.round(fraction * 100)}%`}
            fraction={fraction}
            lineHeight={g.pillTitleLine}
          />
          {remaining === null ? null : (
            <span className="dock-pill-left">{compactTokens(remaining)} left</span>
          )}
        </span>
      )}
    </div>
  )
}

/// A provider that is not connected has no quota and no spend to stand in for one, so the
/// windows row gives way to the reconnect guidance entirely (CapacityDockGlance.drawsWindows).
function drawsWindows(connection: Connection): boolean {
  return connection !== 'disconnected' && connection !== 'terminalFailure'
}

/// The glance popover. Sections stack at fixed heights, every one a whole pixel, separated by
/// hairlines drawn as overlays so a rule never adds a pixel the height did not reserve. The
/// page measures the result and Rust lays the window out around it.
function Detail({
  m,
  provider,
  quota,
  glance,
  budget,
  loading,
  fetchedAt,
}: {
  m: Metrics
  provider: Provider
  quota: QuotaState
  glance: Glance
  budget: number | null
  loading: boolean
  fetchedAt: number | null
}) {
  const g = glanceMetrics(m.detailScale)
  const now = Date.now()
  const connection: Connection = loading ? 'loading' : connectionFor(provider, quota)
  const sessions = sessionsFor(glance, provider.id)
  const today = glance.today
  const windows = provider.windows.slice(0, MAX_WINDOW_COLUMNS)
  const footer = footerLines(provider, fetchedAt, now)
  const action = loading ? null : connectionAction(provider)
  // A single window has no siblings to line up with, so it reads as a left-aligned figure
  // rather than as a lone centred digit.
  const windowAlign = windows.length === 1 ? 'start' : 'center'
  return (
    <div className="dock-glance">
      <header className="dock-glance-head has-rule">
        <span className="dock-glance-glyph">
          <ProviderGlyph id={provider.id} size={m.detailGlyphSize} />
        </span>
        <span className="dock-glance-name">{provider.name}</span>
        {provider.plan ? <span className="dock-glance-plan">{provider.plan}</span> : null}
      </header>

      {connection === 'loading' ? <p className="dock-conn is-loading">Refreshing…</p> : null}
      {connection === 'stale' ? <p className="dock-conn is-stale">Last known usage · refreshing</p> : null}
      {connection === 'transientFailure' ? (
        <p className="dock-conn is-retrying">Last known usage · retrying</p>
      ) : null}
      {connection === 'disconnected' ? (
        <div className="dock-conn-block is-disconnected">
          <p className="dock-conn is-disconnected">Not connected</p>
          <p className="dock-conn-instruction">{instruction(provider, quota)}</p>
        </div>
      ) : null}
      {connection === 'terminalFailure' ? (
        <div className="dock-conn-block is-failed">
          <p className="dock-conn is-failed">Reconnect required</p>
          <p className="dock-conn-reason">{provider.error}</p>
          <p className="dock-conn-hint">{instruction(provider, quota)}</p>
        </div>
      ) : null}

      {sessions ? (
        <section className="dock-glance-block has-rule">
          <div className="dock-glance-caption">
            <span>Sessions</span>
            <span className="dock-glance-caption-end">{runningLabel(sessions.length)}</span>
          </div>
          {sessions.length > 0 ? (
            <div className="dock-pills" style={{ height: sessionListHeight(g, sessions.length) }}>
              {sessions.map((session) => (
                <SessionPill key={session.id} g={g} session={session} now={now} />
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {today ? (
        <section className="dock-glance-block has-rule">
          <div className="dock-glance-caption">
            <span>Today</span>
          </div>
          <div className="dock-today">
            <span className="dock-today-figure">
              <span className="dock-today-cost">{usd(today.cost)}</span>
              <span className="dock-today-burned">burned</span>
            </span>
            <span className="dock-today-stack">
              <span className="dock-today-token">
                <span className="dock-today-arrow">&darr;</span>
                {compactTokens(today.inputTokens)}
              </span>
              <span className="dock-today-token">
                <span className="dock-today-arrow">&uarr;</span>
                {compactTokens(today.outputTokens)}
              </span>
              <span className="dock-today-calls">{thousands(today.calls)} calls</span>
            </span>
          </div>
        </section>
      ) : null}

      {drawsWindows(connection) ? (
        <section className={`dock-glance-windows${footer.length > 0 ? ' has-rule' : ''}`}>
          {windows.length === 0 ? (
            <p className="dock-budget-line">
              {budget && budget > 0 ? `today ${usd(today?.cost ?? 0)} of ${usd(budget)}` : 'no budget set'}
            </p>
          ) : (
            <div className="dock-window-row" style={{ textAlign: windowAlign }}>
              {windows.map((row) => {
                const used = pct(row.usedPct)
                const resets = resetsIn(row.resetsAt)
                return (
                  <div className="dock-window-col" key={`${provider.id}-${row.label}`}>
                    <GaugeText
                      className="dock-window-pct"
                      label={`${used}%`}
                      fraction={used / 100}
                      lineHeight={g.windowPercent}
                    />
                    <span className="dock-window-label">{displayLabel(row.label)}</span>
                    <span className="dock-window-reset">{resets}</span>
                  </div>
                )
              })}
            </div>
          )}
        </section>
      ) : null}

      {footer.length > 0 ? (
        <section className="dock-footer">
          {footer.map((line) => (
            <p className="dock-footer-line" key={line}>
              {line}
            </p>
          ))}
        </section>
      ) : null}

      {action ? (
        <div className="dock-connect-row">
          <button
            type="button"
            className="dock-connect"
            style={{ background: providerColor(provider.id) }}
            onClick={() => void invoke('open_settings_window', { section: provider.id })}
          >
            {actionTitle(provider, action)}
          </button>
        </div>
      ) : null}
    </div>
  )
}

/// The metrics the stylesheet needs. Everything the page can set inline is set inline; these
/// are the ones that belong to a rule (gaps, type sizes, the alert dot's corner, and every
/// block height of the glance popover).
function dockVars(m: Metrics): CSSProperties {
  const g = glanceMetrics(m.detailScale)
  return {
    '--dock-row-gap': `${m.rowSpacing}px`,
    '--dock-ring-gap': `${m.ringLabelSpacing}px`,
    '--dock-gauge-size': `${m.ringSize}px`,
    '--dock-ring-margin': `${m.ringMargin}px`,
    '--dock-pct-size': `${m.percentTextSize}px`,
    '--dock-alert-size': `${m.alertSize}px`,
    // The mac hangs the badge 19 points out from the ring centre, at 12 points across.
    '--dock-alert-inset': `${Math.round(m.ringSize / 2 - m.alertOffset - m.alertSize / 2)}px`,
    '--glance-inset': `${g.inset}px`,
    '--glance-head-title': `${g.headerTitle}px`,
    '--glance-head-pad-bottom': `${g.headerPadBottom}px`,
    '--glance-head-gap': `${g.headGap}px`,
    '--glance-pad-top': `${g.sectionPadTop}px`,
    '--glance-pad-bottom': `${g.sectionPadBottom}px`,
    '--glance-caption': `${g.captionLine}px`,
    '--glance-line-gap': `${g.lineGap}px`,
    '--glance-block-gap': `${g.blockGap}px`,
    '--glance-pill-h': `${g.pillHeight}px`,
    '--glance-pill-gap': `${g.pillGap}px`,
    '--glance-pill-radius': `${g.pillRadius}px`,
    '--glance-pill-pad-x': `${g.pillPadX}px`,
    '--glance-pill-title': `${g.pillTitleLine}px`,
    '--glance-pill-sub': `${g.pillSubLine}px`,
    '--glance-pill-fade': `${g.pillFade}px`,
    '--glance-today-content': `${g.todayContent}px`,
    '--glance-today-line': `${g.todayLine}px`,
    '--glance-today-calls': `${g.todayCallsLine}px`,
    '--glance-today-line-gap': `${g.todayLineGap}px`,
    '--glance-today-cost-gap': `${g.todayCostGap}px`,
    '--glance-window-pct': `${g.windowPercent}px`,
    '--glance-window-reset': `${g.windowReset}px`,
    '--glance-window-gap': `${g.windowGap}px`,
    '--glance-connect-h': `${g.connectHeight}px`,
    '--glance-conn-loading': `${g.connLoading}px`,
    '--glance-conn-title': `${g.connTitle}px`,
    '--glance-conn-line': `${g.connLine}px`,
    '--glance-conn-terminal': `${g.connTerminal}px`,
  } as CSSProperties
}

const RAIL_MOTION = (_from: number, to: number) => (to === 1 ? MOTION.railExpand : MOTION.railCollapse)
const ATTACH_MOTION = (_from: number, to: number) => (to === 1 ? MOTION.dockAttach : MOTION.dockDetach)

/// Coming out of the edge, resting, or going back into it.
type Presence = 'entering' | 'present' | 'leaving'

/// Somebody who has asked for less movement gets the rail placed rather than played.
function motionAllowed(): boolean {
  return typeof window.matchMedia === 'function'
    && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/// How far the rail sits outside the window while it is tucked away: its whole cross extent,
/// pushed toward the edge it is docked to, so nothing of it shows. A floating rail has no edge
/// to hide behind, so it fades and scales instead.
function tuckedTransform(docked: boolean, edge: Edge, cross: number): string {
  if (!docked) return 'scale(0.92)'
  switch (edge) {
    case 'left': return `translateX(${-cross}px)`
    case 'right': return `translateX(${cross}px)`
    case 'top': return `translateY(${-cross}px)`
    default: return `translateY(${cross}px)`
  }
}

export function Dock() {
  const [quota, setQuota] = useState<QuotaState>(EMPTY_QUOTA)
  // What the glance bubble draws beside the quota: the sessions running now and today's
  // totals. Rust caches the slice of every payload the popover's own fetch goes past.
  const [glance, setGlance] = useState<Glance>(EMPTY_GLANCE)
  const [budget, setBudget] = useState<number | null>(null)
  const [prefs, setPrefs] = useState<DockPrefs>(DEFAULT_DOCK_PREFS)
  // Nothing may be written back before the stored preferences have arrived: the defaults say
  // nobody has chosen a provider set yet, and acting on that would overwrite one.
  const [prefsLoaded, setPrefsLoaded] = useState(false)
  const [interaction, setInteraction] = useState<Interaction>(REST)
  const [presentationExpanded, setPresentationExpanded] = useState(false)
  const [hovered, setHovered] = useState<string | null>(null)
  const [detailPhase, setDetailPhase] = useState<DetailPhase>('entering')
  const [detailHeight, setDetailHeight] = useState(0)
  const [frame, setFrame] = useState<DockFrame | null>(null)
  // The scale the current frame was laid out for; see the metrics comment below.
  const [layoutScale, setLayoutScale] = useState(DEFAULT_DOCK_PREFS.scale)
  // Attachment while dragging comes straight from the cursor poll; otherwise it eases. The
  // edge it refers to matters: a flare only makes sense on an edge of the rail's own
  // orientation, so nearing a perpendicular edge shows the loose pill until the drop.
  const [drag, setDrag] = useState<{ attachment: number; edge: Edge | null } | null>(null)
  // Where the rail was before a settle, relative to the new window, so it can glide in.
  const [glide, setGlide] = useState<{ dx: number; dy: number; key: number } | null>(null)
  // The rail's whole life in this window, which is created for it and destroyed with it: it
  // opens tucked behind its edge and leaves the same way, and the window itself never moves.
  const [presence, setPresence] = useState<Presence>('entering')
  const { schedule, cancel } = useTimers()

  const interactionRef = useRef(interaction)
  interactionRef.current = interaction
  const hoveredRef = useRef(hovered)
  hoveredRef.current = hovered
  const phaseRef = useRef(detailPhase)
  phaseRef.current = detailPhase
  const pointerRef = useRef<PointerSnapshot>(NO_POINTER)
  const orderedRef = useRef<Provider[]>([])
  const detailRef = useRef<HTMLDivElement>(null)
  const press = useRef<{ x: number; y: number; dragged: boolean } | null>(null)
  const suppressClick = useRef(false)
  // The retract's own timer, cleared when the dock comes back on before it has run out.
  const closeTimer = useRef(0)

  // The same store the popover and the settings window use: it polls on the quota refresh
  // cadence with the mac's backoff and jitter, rather than the fixed five minutes this window
  // used to keep to itself, and it stops while nobody could see the rail.
  useEffect(() => subscribeQuota(setQuota), [])
  useEffect(() => subscribeGlance(setGlance), [])
  useEffect(() => subscribeDailyBudget(setBudget), [])

  // The settings window writes these, so the rail follows a switch, a resting provider or a
  // size the moment it is changed rather than at the next refresh.
  useEffect(() => {
    void loadDockPrefs().then((stored) => {
      setPrefs(stored)
      setLayoutScale(stored.scale)
      setPrefsLoaded(true)
    })
    return onDockPrefsChanged(setPrefs)
  }, [])
  // The size the rail is drawn at follows the frame rather than the preference: a rail drawn
  // at a size the window it sits in was not laid out for hangs off its own edge for as long
  // as it takes a round trip to correct. Rust sends the new size and the new frame in one
  // event and they are applied in one render, below.
  const m = metrics(layoutScale)

  // Until the user edits the set in the settings window, the dock follows what is connected,
  // up to the mac's five. The write reaches the settings window through the same event, so a
  // window open on the Capacity Dock section fills its switches in as the answer arrives.
  useEffect(() => {
    if (!prefsLoaded || quota.fetchedAt === null) return
    const connected = quota.providers.filter((p) => p.available).map((p) => p.id)
    const patch = autoSeed(prefs, connected)
    if (patch) void writeDockPrefs(patch).then(setPrefs)
  }, [prefsLoaded, quota, prefs])

  // Providers: the ones the CLI reports signed in, narrowed to the settings window's choice
  // when one has been made, else the preferred one as a dashed stand-in. An empty choice is
  // "nobody has picked yet", which is why it means everything rather than nothing.
  const all = quota.providers
  const signedIn = all.filter((p) => p.available)
  const chosenIds = prefs.providers
  // A chosen provider stays on the rail after it drops out, as it does on the mac: a dashed
  // ring and a Reconnect button say more than a row that quietly disappeared. Nothing chosen
  // yet means everything signed in, which is what the empty set is for until the seed runs.
  const available = chosenIds.length > 0 ? all.filter((p) => chosenIds.includes(p.id)) : signedIn
  const resolvedPreferredId =
    normalizedPreferred(prefs.preferred, available.map((p) => p.id)) ?? prefs.preferred ?? all[0]?.id ?? 'claude'
  const preferred: Provider = all.find((p) => p.id === resolvedPreferredId) ?? {
    id: resolvedPreferredId,
    name: PROVIDER_NAMES[resolvedPreferredId] ?? resolvedPreferredId,
    available: false,
    windows: [],
  }
  const selected = available.length > 0 ? available : [preferred]
  const displayed = presentationExpanded
    ? [preferred, ...selected.filter((p) => p.id !== preferred.id)]
    : [preferred]
  const anchor = frame?.anchor ?? 'start'
  const ordered = anchor === 'end' ? [...displayed].reverse() : displayed
  orderedRef.current = ordered
  const loading = quota.fetchedAt === null && quota.error === null

  // With the preference on the rail never rests on one ring: it reads as pinned, so every
  // selected row stays out and the hover-out collapse has nothing to do.
  const expanded = prefs.keepExpanded || isExpanded(interaction)
  useEffect(() => {
    if (expanded) setPresentationExpanded(true)
  }, [expanded])
  const progress = useEased(expanded ? 1 : 0, RAIL_MOTION, (value) => {
    if (value === 0) setPresentationExpanded(false)
  })

  // Detail lifecycle, port of showDetail / hideDetail / dismissDetail.
  const showDetail = useCallback(
    (id: string) => {
      cancel('detailDismiss')
      if (hoveredRef.current === id) {
        if (phaseRef.current === 'dismissing') setDetailPhase('shown')
        return
      }
      // Past the guard above, so a bubble already on screen for this provider is not a
      // second opening of it.
      track('glance_open')
      setHovered(id)
      setDetailPhase(hoveredRef.current && phaseRef.current === 'shown' ? 'shown' : 'entering')
    },
    [cancel]
  )
  const hideDetail = useCallback(
    (animated = true) => {
      if (!hoveredRef.current) return
      if (!animated) {
        cancel('detailDismiss')
        setHovered(null)
        setDetailPhase('entering')
        return
      }
      setDetailPhase('dismissing')
      schedule('detailDismiss', MOTION.detailDismiss.duration, () => {
        setHovered(null)
        setDetailPhase('entering')
      })
    },
    [cancel, schedule]
  )

  const scheduleCollapse = useCallback(() => {
    schedule('collapse', MOTION.railHoverCloseDelay, () => {
      setInteraction((i) => ({ ...i, collapseGrace: false }))
      const next = { ...interactionRef.current, collapseGrace: false }
      if (canCollapse(next)) hideDetail()
    })
  }, [schedule, hideDetail])

  const railHoverChanged = useCallback(
    (hovering: boolean) => {
      if (interactionRef.current.dragging) return
      cancel('expand')
      cancel('collapse')
      if (hovering) {
        schedule('expand', MOTION.railHoverOpenDelay, () => {
          if (!pointerRef.current.railHovered) return
          setInteraction((i) => ({ ...i, railHovered: true, collapseGrace: false }))
        })
      } else {
        setInteraction((i) => ({ ...i, railHovered: false, collapseGrace: true }))
        scheduleCollapse()
      }
    },
    [cancel, schedule, scheduleCollapse]
  )
  const rowHoverChanged = useCallback(
    (id: string, hovering: boolean) => {
      if (interactionRef.current.dragging) return
      cancel('detailShow')
      cancel('detailExit')
      if (hovering) {
        // Re-entering a row aborts a pending collapse; a row exit must not touch it.
        cancel('collapse')
        schedule('detailShow', MOTION.detailShowDelay, () => showDetail(id))
      } else if (hoveredRef.current === id) {
        // Enough time to cross the transparent gap into the bubble.
        schedule('detailExit', MOTION.detailExitDelay, () => {
          if (interactionRef.current.detailHovered) return
          hideDetail()
          scheduleCollapse()
        })
      }
    },
    [cancel, schedule, showDetail, hideDetail, scheduleCollapse]
  )
  const detailHoverChanged = useCallback(
    (hovering: boolean) => {
      if (interactionRef.current.dragging) return
      cancel('collapse')
      cancel('detailExit')
      setInteraction((i) => ({ ...i, detailHovered: hovering }))
      if (hovering && phaseRef.current === 'dismissing') {
        cancel('detailDismiss')
        setDetailPhase('shown')
      } else if (!hovering) {
        scheduleCollapse()
      }
    },
    [cancel, scheduleCollapse]
  )

  // One entry point for hover, fed by the cursor poll on Windows and by DOM events elsewhere,
  // the way the mac synthesizes hover from its event monitor.
  const applyPointer = useCallback(
    (next: PointerSnapshot) => {
      const prev = pointerRef.current
      pointerRef.current = next
      const rows = orderedRef.current
      if (next.detailHovered !== prev.detailHovered) detailHoverChanged(next.detailHovered)
      if (next.railHovered !== prev.railHovered) railHoverChanged(next.railHovered)
      if (next.row !== prev.row) {
        const before = prev.row === null ? null : rows[prev.row]
        const after = next.row === null ? null : rows[next.row]
        if (before) rowHoverChanged(before.id, false)
        if (after) rowHoverChanged(after.id, true)
      }
    },
    [detailHoverChanged, railHoverChanged, rowHoverChanged]
  )
  const nativePointer = frame?.nativePointer ?? false
  const domPointer = (patch: Partial<PointerSnapshot>) => {
    if (nativePointer) return
    applyPointer({ ...pointerRef.current, ...patch })
  }

  const dismiss = useCallback(() => {
    ;['expand', 'collapse', 'detailShow', 'detailExit'].forEach(cancel)
    setInteraction((i) => ({ ...REST, dragging: i.dragging }))
    hideDetail()
  }, [cancel, hideDetail])

  // The rail emerges once there is a frame to emerge into: before the first layout it has no
  // edge and no size, so there is nothing to tuck it behind. One frame later the transform is
  // released and the transition carries it out. Reduced motion places it and skips the play.
  useEffect(() => {
    if (frame === null || presence !== 'entering') return
    if (!motionAllowed()) {
      setPresence('present')
      return
    }
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setPresence('present')))
    return () => cancelAnimationFrame(raf)
  }, [frame, presence])

  // Rust asks before it destroys the window, so the rail can go back into the edge rather than
  // vanish. The bubble goes first, then the rail retracts, then the window is released. Rust
  // keeps its own timer, so a page that never gets here costs a moment, not a stuck window.
  //
  // The generation the dismiss carries goes back with the answer. A dock switched off and
  // straight back on reuses this very window, and the retract already under way still finishes:
  // without the number, its answer would destroy the rail that was just switched back on.
  useEffect(() => {
    const listeners = [
      listen<{ generation: number }>('codeburn://dock-dismiss', (event) => {
        const { generation } = event.payload
        hideDetail()
        setPresence('leaving')
        window.clearTimeout(closeTimer.current)
        const wait = motionAllowed() ? MOTION.dockDetach.duration : 0
        closeTimer.current = window.setTimeout(() => { void invoke('dock_close', { generation }) }, wait)
      }),
      // The window was kept rather than rebuilt, so the retract is called off here too and the
      // rail comes back out of its edge instead of staying tucked behind it.
      listen('codeburn://dock-present', () => {
        window.clearTimeout(closeTimer.current)
        closeTimer.current = 0
        setPresence((current) => (current === 'present' ? current : 'entering'))
      }),
    ]
    return () => {
      window.clearTimeout(closeTimer.current)
      listeners.forEach((p) => void p.then((stop) => stop()))
    }
  }, [hideDetail])

  useEffect(() => {
    const listeners = [
      listen('codeburn://dock-refresh', () => void refreshQuota()),
      listen<PointerSnapshot>('codeburn://dock-pointer', (event) => applyPointer(event.payload)),
      listen<{ attachment: number; edge: Edge | null; frame?: DockFrame }>('codeburn://dock-drag', (event) => {
        setDrag({ attachment: event.payload.attachment, edge: event.payload.edge })
        // A rail that has just turned is in a different window, painting a different shape.
        if (event.payload.frame) setFrame(event.payload.frame)
      }),
      listen<{ scale: number; frame: DockFrame }>('codeburn://dock-metrics', (event) => {
        // One render for both, so the rail is never drawn at a size its window was not laid
        // out for. No glide: the rail is changing size in place, not moving home.
        setFrame(event.payload.frame)
        setLayoutScale(event.payload.scale)
      }),
      listen<{ from: Rect; frame: DockFrame }>('codeburn://dock-settled', (event) => {
        const { from, frame: next } = event.payload
        track('dock_drag_end', { edge: next.edge })
        setFrame(next)
        setDrag(null)
        // Glide from centre to centre: the rail may have changed orientation on the way.
        setGlide({
          dx: from.x + from.w / 2 - (next.rail.x + next.rail.w / 2),
          dy: from.y + from.h / 2 - (next.rail.y + next.rail.h / 2),
          key: Date.now(),
        })
        // A re-homed rail starts from a clean hover: the bubble is gone on the Rust side, and
        // the poll re-derives hover from the settled geometry on its next tick.
        ;['expand', 'collapse', 'detailShow', 'detailExit'].forEach(cancel)
        hideDetail(false)
        setInteraction((i) => ({ ...REST, pinned: i.pinned }))
        pointerRef.current = NO_POINTER
      }),
    ]
    return () => {
      listeners.forEach((p) => void p.then((unlisten) => unlisten()))
    }
  }, [applyPointer, cancel, hideDetail])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isExpanded(interactionRef.current)) dismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dismiss])

  // Dragging: the page owns the 3 px threshold, the cursor poll owns the rest.
  const onPointerDown = (event: ReactPointerEvent) => {
    if (event.button !== 0) return
    suppressClick.current = false
    press.current = { x: event.clientX, y: event.clientY, dragged: false }
    // The rail is narrow; the first move often lands outside it, so keep the pointer here.
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onClickCapture = (event: ReactMouseEvent) => {
    if (!suppressClick.current) return
    suppressClick.current = false
    event.stopPropagation()
  }
  const onPointerMove = (event: ReactPointerEvent) => {
    const start = press.current
    if (!start || start.dragged) return
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) <= MOTION.dragThreshold) return
    start.dragged = true
    suppressClick.current = true
    ;['expand', 'collapse', 'detailShow', 'detailExit'].forEach(cancel)
    hideDetail(false)
    setInteraction((i) => ({ ...i, dragging: true, railHovered: false, detailHovered: false, collapseGrace: false }))
    // The press point, not the cursor when the command lands: the rail must stay under the
    // finger exactly where it was grabbed.
    void invoke('dock_begin_drag', { x: Math.round(start.x), y: Math.round(start.y) })
  }
  const onPointerUp = () => {
    press.current = null
  }

  const onRowClick = (provider: Provider) => {
    if (interactionRef.current.dragging) return
    cancel('expand')
    cancel('collapse')
    if (provider.id !== resolvedPreferredId) {
      track('dock_provider_switch', { provider: provider.id })
      setPrefs((current) => ({ ...current, preferred: provider.id }))
      void invoke('dock_set_preferred', { id: provider.id })
      setInteraction((i) => (i.pinned ? i : { ...i, pinned: true }))
    } else {
      setInteraction((i) => ({ ...i, pinned: !i.pinned }))
    }
    showDetail(provider.id)
  }

  // The bubble is laid out at its natural height first; its frame is computed from that.
  useLayoutEffect(() => {
    if (!hovered) {
      setDetailHeight(0)
      return
    }
    const el = detailRef.current
    if (el) setDetailHeight(Math.ceil(el.offsetHeight))
  }, [hovered, quota, glance, budget, m])

  const rows = ordered.length
  const totalRows = Math.max(selected.length, 1)
  const detailRow = hovered ? ordered.findIndex((p) => p.id === hovered) : -1
  const detailRequest = hovered && detailHeight > 0 && detailRow >= 0 ? { row: detailRow, height: detailHeight } : null
  useEffect(() => {
    let stale = false
    void invoke<DockFrame>('dock_set_layout', {
      request: { rows, totalRows, expanded: presentationExpanded, detail: detailRequest },
    }).then((next) => {
      if (!stale) setFrame(next)
    })
    return () => {
      stale = true
    }
    // detailRequest is derived from the two scalars below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, totalRows, presentationExpanded, detailRow, detailHeight, m])

  // Entering: the card is placed while invisible, then slides in on the next frame.
  const detailPlaced = frame?.detail != null && detailRequest != null
  useEffect(() => {
    if (detailPhase !== 'entering' || !detailPlaced) return
    const raf = requestAnimationFrame(() => setDetailPhase('shown'))
    return () => cancelAnimationFrame(raf)
  }, [detailPhase, detailPlaced])

  // Attachment: 1 docked, 0 loose. Eases home after a drop; tracks the poll during a drag.
  const attachmentTarget = frame?.docked ? 1 : 0
  const easedAttachment = useEased(attachmentTarget, ATTACH_MOTION)
  const railVertical = frame?.vertical ?? true
  const dragEdgeFits = drag?.edge != null && isVertical(drag.edge) === railVertical
  const attachment = drag ? (dragEdgeFits ? drag.attachment : 0) : easedAttachment
  const flareEdge: Edge = dragEdgeFits && drag?.edge ? drag.edge : (frame?.edge ?? 'right')

  // Glide: after a settle the rail starts where it was dropped and eases into place.
  const glideKey = glide?.key ?? 0
  const glideProgress = useEased(glideKey ? 1 : 0, () => (frame?.docked ? MOTION.dockAttach : MOTION.dockDetach))
  const glideDx = glide ? glide.dx * (1 - glideProgress) : 0
  const glideDy = glide ? glide.dy * (1 - glideProgress) : 0
  useEffect(() => {
    if (glide && glideProgress >= 1) setGlide(null)
  }, [glide, glideProgress])

  // The mac's second appearance. Windows cannot shape its acrylic material, so the glass is
  // painted inside the same outline as the graphite surface: translucent enough for the
  // desktop to move behind it, dark enough to carry the warm off-white type over any
  // wallpaper, with a brighter rim than graphite gets.
  const glass = prefs.theme === 'glass'
  const surfaceFill = glass ? 'url(#dock-glass-fill)' : 'url(#dock-rail-fill)'
  const edge = flareEdge
  const vertical = railVertical
  const cross = vertical ? m.railWidth : m.horizontalRailWidth
  const pad = alongPad(m, attachment)
  const restLength = railLength(m, 1, attachment)
  const targetLength = railLength(m, rows, attachment)
  const bodyLength = Math.round(restLength + (targetLength - restLength) * progress)
  const railRect = frame?.rail ?? { x: 0, y: 0, w: cross, h: restLength }
  // The frame's rail is the target; the visual rail grows from the anchored end toward it.
  const railTarget = vertical ? railRect.h : railRect.w
  const alongOffset = anchor === 'end' ? railTarget - bodyLength : 0
  const railLeft = (vertical ? railRect.x : railRect.x + alongOffset) + glideDx
  const railTop = (vertical ? railRect.y + alongOffset : railRect.y) + glideDy
  const railW = vertical ? cross : bodyLength
  const railH = vertical ? bodyLength : cross
  const shape = railPath(m, edge, cross, bodyLength, attachment)
  // A docked rail's outer edge is the window's own edge, because the window is sized from the
  // rail. Pinning it there with `right`/`bottom` rather than `left`/`top` is what keeps it
  // flush while the window is resized underneath it: a size change moves the window before
  // the page can repaint, and a left-anchored rail rides that move away from its edge for a
  // frame, which reads as the rail coming loose.
  const railPosition: CSSProperties =
    frame?.docked && frame.edge === 'right'
      ? { right: -glideDx, top: railTop }
      : frame?.docked && frame.edge === 'bottom'
        ? { left: railLeft, bottom: -glideDy }
        : { left: railLeft, top: railTop }

  // Tucked behind the edge before the entrance plays and again once the retract starts.
  const tucked = presence !== 'present'

  const hoveredProvider = hovered ? (ordered.find((p) => p.id === hovered) ?? null) : null
  const detailFrame = frame?.detail ?? null
  const tailEdge = opposite(frame?.bubbleSide ?? 'left')
  const detailW = m.detailWidth
  const detailH = detailHeight
  const tail = detailFrame ? detailFrame.tail : (isVertical(tailEdge) ? detailH : detailW) / 2

  // Rows hug the reveal origin: the anchored end gets the along padding, the other end floats.
  const rowsStyle: CSSProperties = vertical
    ? {
        flexDirection: 'column',
        left: m.railCrossPad,
        right: m.railCrossPad,
        top: anchor === 'end' ? 'auto' : pad,
        bottom: anchor === 'end' ? pad : 'auto',
      }
    : {
        flexDirection: 'row',
        top: m.railCrossPad,
        bottom: m.railCrossPad,
        left: anchor === 'end' ? 'auto' : pad,
        right: anchor === 'end' ? pad : 'auto',
      }

  return (
    <div
      className="dock"
      style={dockVars(m)}
      onContextMenu={(e) => {
        e.preventDefault()
        void invoke('dock_context_menu')
      }}
    >
      <div
        className={`dock-rail${interaction.dragging ? ' is-dragging' : ''}${tucked ? ' is-tucked' : ''}${presence === 'leaving' ? ' is-leaving' : ''}`}
        style={{
          ...railPosition,
          width: railW,
          height: railH,
          clipPath: `path('${shape}')`,
          ...(tucked ? { transform: tuckedTransform(Boolean(frame?.docked), edge, cross), opacity: frame?.docked ? 1 : 0 } : {}),
        }}
        onMouseEnter={() => domPointer({ railHovered: true })}
        onMouseLeave={() => domPointer({ railHovered: false, row: null })}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClickCapture={onClickCapture}
      >
        <svg className="dock-surface" width={railW} height={railH} viewBox={`0 0 ${railW} ${railH}`} aria-hidden="true">
          <defs>
            <linearGradient id="dock-rail-fill" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#131416" />
              <stop offset="0.46" stopColor="#09090A" />
              <stop offset="1" stopColor="#030304" />
            </linearGradient>
            <linearGradient id="dock-glass-fill" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#2A2C31" stopOpacity="0.60" />
              <stop offset="0.46" stopColor="#131416" stopOpacity="0.66" />
              <stop offset="1" stopColor="#060607" stopOpacity="0.74" />
            </linearGradient>
            <linearGradient id="dock-glass-edge" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#fff" stopOpacity="0.22" />
              <stop offset="0.55" stopColor="#fff" stopOpacity="0.14" />
              <stop offset="1" stopColor="#fff" stopOpacity="0.20" />
            </linearGradient>
            <radialGradient id="dock-rail-glow" cx="0" cy="0" r="180" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#fff" stopOpacity="0.055" />
              <stop offset="1" stopColor="#fff" stopOpacity="0" />
            </radialGradient>
            <linearGradient id="dock-rail-edge" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#fff" stopOpacity="0.05" />
              <stop offset="0.55" stopColor="#fff" stopOpacity="0.09" />
              <stop offset="0.86" stopColor="#fff" stopOpacity="0.14" />
              <stop offset="1" stopColor="#fff" stopOpacity="0.08" />
            </linearGradient>
          </defs>
          <path d={shape} fill={surfaceFill} />
          <path d={shape} fill="url(#dock-rail-glow)" />
          <path
            d={shape}
            fill="none"
            stroke={glass ? 'url(#dock-glass-edge)' : 'url(#dock-rail-edge)'}
            strokeWidth={Math.max(0.6, m.scale * 0.8)}
          />
        </svg>
        <div className="dock-rows" style={rowsStyle}>
          {ordered.map((provider, index) => {
            const isPreferred = provider.id === preferred.id
            const reveal = isPreferred ? 0 : m.rowReveal * (1 - progress)
            return (
              <Row
                key={provider.id}
                m={m}
                shape={prefs.gaugeShape}
                provider={provider}
                loading={loading}
                style={{
                  width: vertical ? cross - m.railCrossPad * 2 : m.rowHeight,
                  height: vertical ? m.rowHeight : cross - m.railCrossPad * 2,
                  opacity: isPreferred ? 1 : progress,
                  transform: vertical ? `translateY(${reveal}px)` : `translateX(${reveal}px)`,
                }}
                onEnter={() => domPointer({ row: index })}
                onLeave={() => domPointer({ row: null })}
                onClick={() => onRowClick(provider)}
              />
            )
          })}
        </div>
      </div>

      {hoveredProvider ? (
        <div
          ref={detailRef}
          className={`dock-detail is-${detailPhase} is-tail-${tailEdge}${detailPlaced ? '' : ' is-measuring'}`}
          style={{ left: detailFrame?.x ?? 0, top: detailFrame?.y ?? 0, width: detailW, padding: detailPadding(m, tailEdge) }}
          onMouseEnter={() => domPointer({ detailHovered: true })}
          onMouseLeave={() => domPointer({ detailHovered: false })}
        >
          {detailH > 0 ? (
            <svg className="dock-surface" width={detailW} height={detailH} viewBox={`0 0 ${detailW} ${detailH}`} aria-hidden="true">
              <path d={bubblePath(tailEdge, detailW, detailH, tail)} fill={surfaceFill} />
              <path d={bubblePath(tailEdge, detailW, detailH, tail)} fill="url(#dock-rail-glow)" />
              <path
                d={bubblePath(tailEdge, detailW, detailH, tail)}
                fill="none"
                stroke={glass ? 'rgba(255,255,255,0.20)' : 'rgba(255,255,255,0.09)'}
                strokeWidth={Math.max(0.5, m.detailScale)}
              />
            </svg>
          ) : null}
          <Detail
            m={m}
            provider={hoveredProvider}
            quota={quota}
            glance={glance}
            budget={budget}
            loading={loading}
            fetchedAt={quota.fetchedAt}
          />
        </div>
      ) : null}
    </div>
  )
}

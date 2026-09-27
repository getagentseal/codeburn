/// Pure geometry and presentation rules for the Capacity Dock, ported from
/// mac/Sources/CodeBurnMenubar/Views/CapacityDockView.swift, CapacityDockMotion.swift and
/// Data/QuotaSummary.swift. Every metric is a mac base value times the settings window's size
/// scale, rounded to a whole pixel the way CapacityDockMetrics.points does;
/// src-tauri/src/dock.rs rebuilds the same numbers from the same scale and the two must stay
/// in step.

import type { Severity } from './lib/quota'

/// CapacityDockPreferences.scaleRange and its default.
export const MIN_SCALE = 0.6
export const MAX_SCALE = 1.2
export const DEFAULT_SCALE = MIN_SCALE
/// The bubble never shrinks with the rail: below 90% its type stops being readable.
const MIN_DETAIL_SCALE = 0.9

/// Fractional sizes cost the mac 5 to 7 percent idle CPU by making the hosting view re-lay
/// itself out forever, so every metric lands on a whole pixel.
function points(base: number, scale: number): number {
  return Math.max(1, Math.round(base * scale))
}

export type Metrics = {
  scale: number
  detailScale: number
  railWidth: number
  horizontalRailWidth: number
  rowHeight: number
  rowSpacing: number
  /// A profile row's caption line box and its gap under the percentage (#1523). Added to
  /// every row's height when the rail draws one ring per Claude config directory; src-tauri
  /// dock.rs mirrors both and grows its rows by the same amount.
  captionLine: number
  captionGap: number
  railAlongPad: number
  flareCompensation: number
  railCrossPad: number
  shoulderDepth: number
  ringSize: number
  ringStroke: number
  ringMargin: number
  ringLabelSpacing: number
  providerIconSize: number
  percentTextSize: number
  captionTextSize: number
  alertSize: number
  alertOffset: number
  detailWidth: number
  detailGap: number
  detailGlyphSize: number
  rowReveal: number
}

function build(scale: number): Metrics {
  const detailScale = Math.max(scale, MIN_DETAIL_SCALE)
  return {
    scale,
    detailScale,
    railWidth: points(88, scale),
    horizontalRailWidth: points(106, scale),
    rowHeight: points(84, scale),
    rowSpacing: points(12, scale),
    captionLine: points(13, scale),
    captionGap: points(4, scale),
    railAlongPad: points(20, scale),
    // Docked rails add 60% of the shoulder depth so content never crowds the concave flare.
    flareCompensation: Math.round(points(52, scale) * 0.6),
    railCrossPad: points(12, scale),
    shoulderDepth: points(52, scale),
    ringSize: points(52, scale),
    ringStroke: points(4, scale),
    // SVG strokes are centred on the path, so the ring box carries a margin for half of one.
    ringMargin: points(5, scale),
    ringLabelSpacing: points(6, scale),
    providerIconSize: points(26, scale),
    percentTextSize: points(17, scale),
    captionTextSize: points(11, scale),
    alertSize: points(12, scale),
    alertOffset: points(19, scale),
    detailWidth: points(350, detailScale),
    // The gap between rail and bubble is a placement constant on the mac, not a scaled metric.
    detailGap: 10,
    // The glance header's mark matches the 17pt title's cap height plus a little, so it reads
    // as the title's equal rather than as a bullet.
    detailGlyphSize: points(18, detailScale),
    rowReveal: -8 * scale,
  }
}

const CACHE = new Map<number, Metrics>()

/// Metrics for a size scale. Cached because the dock passes them through effect dependencies,
/// where a fresh object on every render would restart the layout round trip forever.
export function metrics(scale: number): Metrics {
  const value = Number.isFinite(scale) ? scale : DEFAULT_SCALE
  const key = Math.round(Math.min(MAX_SCALE, Math.max(MIN_SCALE, value)) * 100) / 100
  let found = CACHE.get(key)
  if (!found) {
    found = build(key)
    CACHE.set(key, found)
  }
  return found
}

/// The glance bubble's block heights, ported from the CapacityDockGlance enum. The mac sums
/// them into a panel frame it computes, because its hosting view does not size itself; here
/// the page measures the bubble it has drawn and Rust lays the window out around it, so the
/// same numbers are set as explicit heights and the measured total is their sum. Every one is
/// a whole pixel at any detail scale, which is what keeps the window metrics whole.
export type GlanceMetrics = {
  /// The bubble's padding on all four sides, applied by each block rather than by the bubble
  /// so a block's own fill can still run edge to edge.
  inset: number
  tail: number
  headerTitle: number
  headerPadBottom: number
  sectionPadTop: number
  sectionPadBottom: number
  /// A 10.5pt caption's line box, shared by every section header.
  captionLine: number
  headGap: number
  lineGap: number
  blockGap: number
  /// 8 padding + a 12pt line + 2 + a 10.5pt line + 8 padding.
  pillHeight: number
  pillGap: number
  pillRadius: number
  pillPadX: number
  pillTitleLine: number
  pillSubLine: number
  /// The tint's fade tail, so a short band fades over its whole length instead of inverting.
  pillFade: number
  /// Three stacked lines, 13 + 13 + 12, with two 3pt gaps. Taller than the 17pt burned figure
  /// beside it, so it sets the row.
  todayContent: number
  todayLine: number
  todayCallsLine: number
  todayLineGap: number
  todayCostGap: number
  windowPercent: number
  windowReset: number
  windowGap: number
  connectHeight: number
  /// A 10pt refreshing/retrying line, an 11pt state title, a 10pt guidance line, and the
  /// mac's fixed allowance for the whole reconnect card.
  connLoading: number
  connTitle: number
  connLine: number
  connTerminal: number
}

/// The list scrolls past this many pills rather than truncating.
export const MAX_VISIBLE_SESSION_ROWS = 4
export const MAX_WINDOW_COLUMNS = 4

function buildGlance(detailScale: number): GlanceMetrics {
  const p = (base: number) => points(base, detailScale)
  return {
    inset: p(16),
    tail: p(18),
    headerTitle: p(20),
    headerPadBottom: p(8),
    sectionPadTop: p(8),
    sectionPadBottom: p(10),
    captionLine: p(13),
    headGap: p(8),
    lineGap: p(2),
    blockGap: p(3),
    pillHeight: p(46),
    pillGap: p(6),
    pillRadius: p(8),
    pillPadX: p(12),
    pillTitleLine: p(15),
    pillSubLine: p(13),
    pillFade: p(12),
    todayContent: p(44),
    todayLine: p(13),
    todayCallsLine: p(12),
    todayLineGap: p(3),
    todayCostGap: p(5),
    windowPercent: p(24),
    windowReset: p(12),
    windowGap: p(2),
    connectHeight: p(22),
    connLoading: p(16),
    connTitle: p(18),
    connLine: p(13),
    connTerminal: p(90),
  }
}

const GLANCE_CACHE = new Map<number, GlanceMetrics>()

export function glanceMetrics(detailScale: number): GlanceMetrics {
  const key = Math.round(detailScale * 100) / 100
  let found = GLANCE_CACHE.get(key)
  if (!found) {
    found = buildGlance(key)
    GLANCE_CACHE.set(key, found)
  }
  return found
}

/// Height of the scrolling pill list: every pill up to the visible cap, then it scrolls.
export function sessionListHeight(g: GlanceMetrics, count: number): number {
  const visible = Math.min(count, MAX_VISIBLE_SESSION_ROWS)
  if (visible <= 0) return 0
  return visible * g.pillHeight + (visible - 1) * g.pillGap
}

/// Four bands, matching the rail's own sense of escalation: comfortable, watch it, nearly
/// out, over. The glance ramps later than a rail row does, so a healthy row of window
/// percentages reads as text rather than as a wall of colour.
export function glanceSeverity(fraction: number): Severity {
  if (fraction >= 0.9) return 'danger'
  if (fraction >= 0.8) return 'critical'
  if (fraction >= 0.7) return 'warning'
  return 'normal'
}

/// Anything outside 0...1 is a bad reading, not a reason to paint past the box.
export function clampFraction(fraction: number): number {
  return Math.min(Math.max(fraction, 0), 1)
}

/// How far the reveal edge leans, as a share of the text's height.
export const GAUGE_SLANT_RATIO = 0.35

/// The slanted wipe over a percentage's glyphs (PercentGaugeReveal). The mac solves the edge
/// in points against a measured text box; here the box is the element, so the same edge is
/// written as a share of its width plus the fixed slant in pixels. Both ends are clamped into
/// the box, which turns the parallelogram into a triangle at the two extremes rather than
/// letting it fold over itself.
export function gaugeClipPath(fraction: number, lineHeight: number): string {
  const f = clampFraction(fraction)
  const slant = lineHeight * GAUGE_SLANT_RATIO
  const edge = (offset: number) =>
    `max(0px, min(100%, calc(${(f * 100).toFixed(3)}% + ${offset.toFixed(2)}px)))`
  return `polygon(0 0, ${edge(slant * f - slant)} 0, ${edge(slant * f)} 100%, 0 100%)`
}

export type Edge = 'left' | 'right' | 'top' | 'bottom'

export type GaugeShape = 'circle' | 'squircle'

export function isVertical(edge: Edge): boolean {
  return edge === 'left' || edge === 'right'
}

export function opposite(edge: Edge): Edge {
  switch (edge) {
    case 'left':
      return 'right'
    case 'right':
      return 'left'
    case 'top':
      return 'bottom'
    case 'bottom':
      return 'top'
  }
}

function smoothstep(p: number): number {
  const t = Math.min(Math.max(p, 0), 1)
  return t * t * (3 - 2 * t)
}

/// Along-axis padding for a given attachment progress, the mac's railAlongPad.
export function alongPad(m: Metrics, attachment: number): number {
  return m.railAlongPad + m.flareCompensation * smoothstep(attachment)
}

export function railLength(m: Metrics, rows: number, attachment: number): number {
  const count = Math.max(rows, 1)
  return alongPad(m, attachment) * 2 + count * m.rowHeight + (count - 1) * m.rowSpacing
}

/// Motion: durations in ms and cubic-bezier control points, verbatim from CapacityDockMotion.
export const MOTION = {
  railExpand: { duration: 520, curve: [0.22, 1, 0.36, 1] as const },
  railCollapse: { duration: 440, curve: [0.32, 0, 0.2, 1] as const },
  dockAttach: { duration: 280, curve: [0.16, 1, 0.3, 1] as const },
  dockDetach: { duration: 240, curve: [0.2, 0.8, 0.2, 1] as const },
  detailPresent: { duration: 200, curve: [0.16, 1, 0.3, 1] as const },
  detailFollow: { duration: 220, curve: [0.25, 0.1, 0.25, 1] as const },
  detailDismiss: { duration: 140, curve: [0.4, 0, 1, 1] as const },
  railHoverOpenDelay: 80,
  railHoverCloseDelay: 180,
  detailShowDelay: 180,
  detailExitDelay: 240,
  detailAppearOffset: 10,
  dragThreshold: 3,
} as const

export type Curve = readonly [number, number, number, number]

/// Cubic bezier easing solved by Newton iteration, matching CapacityDockMotion.cubicBezier.
export function bezier(curve: Curve, x: number): number {
  const [p1x, p1y, p2x, p2y] = curve
  const sampleX = (t: number) => ((1 - 3 * p2x + 3 * p1x) * t + (3 * p2x - 6 * p1x)) * t * t + 3 * p1x * t
  const sampleY = (t: number) => ((1 - 3 * p2y + 3 * p1y) * t + (3 * p2y - 6 * p1y)) * t * t + 3 * p1y * t
  const sampleDx = (t: number) => (3 * (1 - 3 * p2x + 3 * p1x) * t + 2 * (3 * p2x - 6 * p1x)) * t + 3 * p1x
  if (x <= 0) return 0
  if (x >= 1) return 1
  let t = x
  for (let i = 0; i < 8; i += 1) {
    const dx = sampleX(t) - x
    if (Math.abs(dx) < 1e-5) break
    const d = sampleDx(t)
    if (Math.abs(d) < 1e-6) break
    t -= dx / d
  }
  return sampleY(Math.min(1, Math.max(0, t)))
}

// The quota vocabulary the dock shares with the popover now lives in lib/quota, beside the
// store that fetches it. Re-exported so the dock still has one import for a row's geometry.
export {
  displayLabel,
  headlineWindow,
  pct,
  resetsIn,
  severity,
  type QuotaWindow,
  type Severity,
} from './lib/quota'

/// Shapes are drawn once for a right-edge rail in a canonical box (cross by along) and mapped
/// to the other edges with the same affine transforms the mac applies. `cross` is the
/// canonical width.
type Pt = readonly [number, number]

function mapper(edge: Edge, cross: number): (p: Pt) => Pt {
  switch (edge) {
    case 'right':
      return (p) => p
    case 'left':
      return ([x, y]) => [cross - x, y]
    case 'bottom':
      return ([x, y]) => [y, x]
    case 'top':
      return ([x, y]) => [y, cross - x]
  }
}

class PathBuilder {
  private parts: string[] = []
  constructor(private map: (p: Pt) => Pt) {}
  private f(p: Pt): string {
    const [x, y] = this.map(p)
    return `${x.toFixed(2)} ${y.toFixed(2)}`
  }
  move(p: Pt) {
    this.parts.push(`M ${this.f(p)}`)
    return this
  }
  line(p: Pt) {
    this.parts.push(`L ${this.f(p)}`)
    return this
  }
  quad(control: Pt, to: Pt) {
    this.parts.push(`Q ${this.f(control)} ${this.f(to)}`)
    return this
  }
  cubic(c1: Pt, c2: Pt, to: Pt) {
    this.parts.push(`C ${this.f(c1)} ${this.f(c2)} ${this.f(to)}`)
    return this
  }
  close(): string {
    this.parts.push('Z')
    return this.parts.join(' ')
  }
}

function roundedRect(b: PathBuilder, w: number, h: number, r: number): string {
  return b
    .move([r, 0])
    .line([w - r, 0])
    .quad([w, 0], [w, r])
    .line([w, h - r])
    .quad([w, h], [w - r, h])
    .line([r, h])
    .quad([0, h], [0, h - r])
    .line([0, r])
    .quad([0, 0], [r, 0])
    .close()
}

/// The gauge outline (CapacityDockGaugePath), drawn inside `box` at `size` across. Both
/// shapes start at twelve o'clock and run clockwise, so a usage arc trimmed from the start
/// fills the way the mac's does after its -90 degree rotation.
export function gaugePath(kind: GaugeShape, box: number, size: number): string {
  const min = (box - size) / 2
  const max = min + size
  const mid = box / 2
  const r = size / 2
  if (kind === 'circle') {
    return `M ${mid} ${min} A ${r} ${r} 0 1 1 ${mid} ${max} A ${r} ${r} 0 1 1 ${mid} ${min} Z`
  }
  // The mac's continuous rounded rectangle at a 30 percent corner radius. A continuous corner
  // reaches about one and a half radii along each edge and is drawn as one cubic whose control
  // points sit a further 55 percent of that reach toward the corner; a circular quarter-arc
  // would kink where it meets the straight edge, which is the whole difference from a circle.
  const reach = Math.min(size * 0.3 * 1.5, size / 2)
  const pull = reach * 0.45
  const f = (n: number) => n.toFixed(2)
  return [
    `M ${f(mid)} ${f(min)}`,
    `L ${f(max - reach)} ${f(min)}`,
    `C ${f(max - pull)} ${f(min)} ${f(max)} ${f(min + pull)} ${f(max)} ${f(min + reach)}`,
    `L ${f(max)} ${f(max - reach)}`,
    `C ${f(max)} ${f(max - pull)} ${f(max - pull)} ${f(max)} ${f(max - reach)} ${f(max)}`,
    `L ${f(min + reach)} ${f(max)}`,
    `C ${f(min + pull)} ${f(max)} ${f(min)} ${f(max - pull)} ${f(min)} ${f(max - reach)}`,
    `L ${f(min)} ${f(min + reach)}`,
    `C ${f(min)} ${f(min + pull)} ${f(min + pull)} ${f(min)} ${f(min + reach)} ${f(min)}`,
    'Z',
  ].join(' ')
}

/// The rail outline (CapacityDockRailShape): a plain rounded pill while loose, and once more
/// than half attached, convex corners on the free side with concave shoulders necking into the
/// flush contact edge, the system-notch technique. `len` runs along the edge.
export function railPath(m: Metrics, edge: Edge, cross: number, len: number, attachment: number): string {
  const eased = smoothstep(attachment)
  const b = new PathBuilder(mapper(edge, cross))
  const freeR = Math.min(22, len / 2, cross * 0.45)
  if (eased < 0.5) return roundedRect(b, cross, len, freeR)
  const contactR = Math.min(m.shoulderDepth * 0.6, len * 0.22, Math.max(0, len / 2 - freeR)) * eased
  return b
    .move([cross, 0])
    .quad([cross, contactR], [cross - contactR, contactR])
    .line([freeR, contactR])
    .quad([0, contactR], [0, contactR + freeR])
    .line([0, len - contactR - freeR])
    .quad([0, len - contactR], [freeR, len - contactR])
    .line([cross - contactR, len - contactR])
    .quad([cross, len - contactR], [cross, len])
    .close()
}

/// Detail bubble (CapacityDockBubbleShape) with its tail on `tailEdge`, pointing at `tail`
/// measured along that edge. `w` and `h` are the bubble's final box.
export function bubblePath(tailEdge: Edge, w: number, h: number, tail: number): string {
  const vertical = isVertical(tailEdge)
  const cross = vertical ? w : h
  const along = vertical ? h : w
  const b = new PathBuilder(mapper(tailEdge, cross))
  const tailWidth = Math.min(22, Math.max(14, cross * 0.055))
  const bodyRight = cross - tailWidth
  const radius = Math.min(20, along * 0.18)
  const midY = along * Math.min(Math.max(tail / Math.max(along, 1), 0.18), 0.82)
  const neck = Math.min(32, along * 0.19)
  return b
    .move([radius, 0])
    .line([bodyRight - radius, 0])
    .quad([bodyRight, 0], [bodyRight, radius])
    .line([bodyRight, midY - neck])
    .cubic([bodyRight, midY - neck * 0.55], [cross, midY - tailWidth * 0.42], [cross, midY])
    .cubic([cross, midY + tailWidth * 0.42], [bodyRight, midY + neck * 0.55], [bodyRight, midY + neck])
    .line([bodyRight, along - radius])
    .quad([bodyRight, along], [bodyRight - radius, along])
    .line([radius, along])
    .quad([0, along], [0, along - radius])
    .line([0, radius])
    .quad([0, 0], [radius, 0])
    .close()
}

/// Bubble content insets. Every glance block carries its own padding, so the bubble adds only
/// the tail's allowance on whichever side the tail points (the mac's `detailInsets`).
export function detailPadding(m: Metrics, tailEdge: Edge): string {
  const t = glanceMetrics(m.detailScale).tail
  const top = tailEdge === 'top' ? t : 0
  const right = tailEdge === 'right' ? t : 0
  const bottom = tailEdge === 'bottom' ? t : 0
  const left = tailEdge === 'left' ? t : 0
  return `${top}px ${right}px ${bottom}px ${left}px`
}

import { useLayoutEffect, useRef, useState } from 'react'

import { formatUsd, shortenProjectPath } from '../lib/format'
import { isOtherNode, seriesColorForModel } from '../lib/modelSeries'
import type { SpendFlow, SpendFlowNode } from '../lib/types'

type LayoutNode = SpendFlowNode & {
  x: number
  y: number
  h: number
  fill: string
  displayLabel: string
  axLabel: string
}

const VIEW_H = 190
const TOP = 14
const BOTTOM = 18
const NODE_W = 5
const GAP = 8
const MIN_RIBBON_W = 2
/** Clear space between a label and the node bar it belongs to. */
const LABEL_GAP = 10
/** Width used before the container has been measured (server render, tests). */
const FALLBACK_W = 760
const FALLBACK_GUTTER = 150
/** No single label may eat more than this share of the card. */
const LABEL_SHARE = 0.4

export function Sankey({ flow }: { flow: SpendFlow }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [width, setWidth] = useState(FALLBACK_W)
  const [gutters, setGutters] = useState({ left: FALLBACK_GUTTER, right: FALLBACK_GUTTER })
  const [nameCap, setNameCap] = useState<Record<string, number>>({})

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    const fit = () => {
      const measured = host.clientWidth
      if (measured > 0) setWidth(measured)
    }
    fit()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit)
    observer?.observe(host)
    return () => observer?.disconnect()
  }, [])

  const leftX = gutters.left
  const rightX = Math.max(leftX + 60, width - gutters.right - NODE_W)
  const models = layoutNodes(flow.models, leftX - NODE_W, true, nameCap)
  const projects = layoutNodes(flow.projects, rightX, false, nameCap)

  // Gutters are sized from the labels actually drawn, so nothing is cropped and
  // the ribbons take every pixel the labels do not need.
  useLayoutEffect(() => {
    const svg = svgRef.current
    if (!svg || width <= 0) return
    const labels = [...svg.querySelectorAll<SVGTextElement>('text[data-node]')]
    if (!labels.length || typeof labels[0].getComputedTextLength !== 'function') return
    const cap = width * LABEL_SHARE
    const nextCap: Record<string, number> = {}
    let left = 0
    let right = 0
    for (const label of labels) {
      const drawn = (label.textContent ?? '').length
      const measured = label.getComputedTextLength()
      if (!drawn || !measured) continue
      const perChar = measured / drawn
      if (measured > cap) {
        const drop = Math.ceil((measured - cap) / perChar) + 1
        const name = label.dataset.name ?? ''
        nextCap[label.dataset.node ?? ''] = Math.max(4, name.length - drop)
      }
      const final = Math.min(measured, cap)
      if (label.dataset.side === 'left') left = Math.max(left, final)
      else right = Math.max(right, final)
    }
    const next = { left: Math.ceil(left) + LABEL_GAP + NODE_W, right: Math.ceil(right) + LABEL_GAP }
    setGutters(prev => (Math.abs(prev.left - next.left) < 1 && Math.abs(prev.right - next.right) < 1 ? prev : next))
    setNameCap(prev => (sameCaps(prev, nextCap) ? prev : nextCap))
  }, [flow, width, gutters.left, gutters.right, nameCap])

  const modelById = new Map(models.map(node => [node.id, node]))
  const projectById = new Map(projects.map(node => [node.id, node]))
  const sourceOffset = new Map<string, number>()
  const targetOffset = new Map<string, number>()
  const bend = (rightX - leftX) * 0.42

  const ribbons = flow.links.flatMap((link, i) => {
    const source = modelById.get(link.model)
    const target = projectById.get(link.project)
    if (!source || !target || link.cost <= 0) return []

    const sourceSegment = segmentSize(source, link.cost)
    const targetSegment = segmentSize(target, link.cost)
    const strokeWidth = Math.max(MIN_RIBBON_W, (sourceSegment + targetSegment) / 2)
    const sy = source.y + (sourceOffset.get(source.id) ?? 0) + sourceSegment / 2
    const ty = target.y + (targetOffset.get(target.id) ?? 0) + targetSegment / 2
    sourceOffset.set(source.id, (sourceOffset.get(source.id) ?? 0) + sourceSegment)
    targetOffset.set(target.id, (targetOffset.get(target.id) ?? 0) + targetSegment)

    return [
      <path
        key={`${link.model}-${link.project}-${i}`}
        data-testid="sankey-ribbon"
        data-model={source.id}
        data-project={target.id}
        d={`M ${round(leftX + 1)} ${round(sy)} C ${round(leftX + bend)} ${round(sy)} ${round(rightX - bend)} ${round(ty)} ${round(rightX - 1)} ${round(ty)}`}
        stroke={`url(#${gradientId(source.id)})`}
        strokeWidth={round(strokeWidth)}
        fill="none"
        strokeOpacity=".40"
      />,
    ]
  })

  return (
    <div className="sankey" ref={hostRef}>
      <svg ref={svgRef} viewBox={`0 0 ${round(width)} ${VIEW_H}`} width="100%" height={VIEW_H} style={{ display: 'block' }}>
        <defs>
          {models.map(model => (
            <linearGradient key={model.id} id={gradientId(model.id)} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor={model.fill} />
              <stop offset="1" stopColor={model.fill} stopOpacity=".25" />
            </linearGradient>
          ))}
        </defs>

        {ribbons}

        {[...models, ...projects].map(node => (
          <rect
            key={node.id}
            data-testid="sankey-node"
            data-node-id={node.id}
            x={round(node.x)}
            y={round(node.y)}
            width={NODE_W}
            height={round(node.h)}
            rx="2.5"
            fill={node.fill}
          />
        ))}

        {models.map(node => (
          <g key={node.id}>
            {node.displayLabel !== node.axLabel && <title>{node.axLabel}</title>}
            <text
              data-node={node.id}
              data-side="left"
              data-name={node.displayLabel}
              x={round(leftX - NODE_W - LABEL_GAP)}
              y={round(node.y + node.h / 2 + 3)}
              textAnchor="end"
              aria-label={`${node.axLabel} ${formatUsd(node.cost)}`}
            >
              <tspan>{node.displayLabel} · </tspan>
              <tspan className="sankey-amount">{formatUsd(node.cost)}</tspan>
            </text>
          </g>
        ))}
        {projects.map(node => (
          <g key={node.id}>
            <title>{node.id}</title>
            <text
              data-node={node.id}
              data-side="right"
              data-name={node.displayLabel}
              x={round(rightX + NODE_W + LABEL_GAP)}
              y={round(node.y + node.h / 2 + 3)}
              aria-label={`${node.axLabel} ${formatUsd(node.cost)}`}
            >
              <tspan>{node.displayLabel} · </tspan>
              <tspan className="sankey-amount">{formatUsd(node.cost)}</tspan>
            </text>
          </g>
        ))}
      </svg>
    </div>
  )
}

function sameCaps(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) if (a[key] !== b[key]) return false
  return true
}

function layoutNodes(nodes: SpendFlowNode[], x: number, modelSide: boolean, nameCap: Record<string, number>): LayoutNode[] {
  if (nodes.length === 0) return []
  const usable = VIEW_H - TOP - BOTTOM - GAP * Math.max(0, nodes.length - 1)
  const total = nodes.reduce((sum, node) => sum + Math.max(0, node.cost), 0)
  const rawHeights = nodes.map(node => (total > 0 ? (Math.max(0, node.cost) / total) * usable : usable / nodes.length))
  const minH = Math.min(10, usable / nodes.length)
  const inflated = rawHeights.map(h => Math.max(minH, h))
  const scale = inflated.reduce((sum, h) => sum + h, 0) > usable ? usable / inflated.reduce((sum, h) => sum + h, 0) : 1

  let y = TOP
  return nodes.map((node, i) => {
    const h = Math.max(2, inflated[i] * scale)
    const neutral = isOtherNode(node.id) || isOtherNode(node.label)
    const fill = modelSide && !neutral ? seriesColorForModel(node.label || node.id) : neutral ? 'var(--s-other)' : 'var(--mut2)'
    const source = node.label || node.id
    const axLabel = modelSide ? modelDisplayLabel(source) : projectCanonicalLabel(source)
    const cap = nameCap[node.id]
    const displayLabel = cap === undefined ? axLabel : ellipsize(axLabel, cap)
    const laidOut = { ...node, x, y, h, fill, displayLabel, axLabel }
    y += h + GAP
    return laidOut
  })
}

function segmentSize(node: LayoutNode, cost: number): number {
  return node.cost > 0 ? (Math.max(0, cost) / node.cost) * node.h : 0
}

function gradientId(id: string): string {
  return `sankey-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}`
}

function round(n: number): number {
  return Math.round(n * 10) / 10
}

function modelDisplayLabel(raw: string): string {
  return shortenId(raw.trim())
}

function projectCanonicalLabel(raw: string): string {
  const value = raw.trim()
  if (isOtherNode(value)) return 'Other'
  // Abs cwd still sent as the label (older payloads) may shorten. Canonical
  // CLI labels already include the parent context that distinguishes collisions
  // — do not drop it with a 3-segment tail.
  if (value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value)) return shortenProjectPath(value)
  return value
}

function shortenId(value: string): string {
  return value.replace(/^claude[-_]/i, '').replace(/^openai[-_]/i, '')
}

function ellipsize(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

import { formatUsd, shortenProjectPath } from '../lib/format'
import { isOtherNode, seriesColorForModel } from '../lib/modelSeries'
import type { SpendFlow, SpendFlowNode } from '../lib/types'

type LayoutNode = SpendFlowNode & {
  x: number
  y: number
  h: number
  fill: string
  displayLabel: string
}

const VIEW_W = 760
const VIEW_H = 190
const TOP = 14
const BOTTOM = 18
const LEFT_X = 126
const RIGHT_X = 520
const NODE_W = 5
const GAP = 8
const MIN_RIBBON_W = 2

export function Sankey({ flow }: { flow: SpendFlow }) {
  const models = layoutNodes(flow.models, LEFT_X, true)
  const projects = layoutNodes(flow.projects, RIGHT_X, false)
  const modelById = new Map(models.map(node => [node.id, node]))
  const projectById = new Map(projects.map(node => [node.id, node]))
  const sourceOffset = new Map<string, number>()
  const targetOffset = new Map<string, number>()

  const ribbons = flow.links.flatMap((link, i) => {
    const source = modelById.get(link.model)
    const target = projectById.get(link.project)
    if (!source || !target || link.cost <= 0) return []

    const sourceSegment = segmentSize(source, link.cost)
    const targetSegment = segmentSize(target, link.cost)
    const width = Math.max(MIN_RIBBON_W, (sourceSegment + targetSegment) / 2)
    const sy = source.y + (sourceOffset.get(source.id) ?? 0) + sourceSegment / 2
    const ty = target.y + (targetOffset.get(target.id) ?? 0) + targetSegment / 2
    sourceOffset.set(source.id, (sourceOffset.get(source.id) ?? 0) + sourceSegment)
    targetOffset.set(target.id, (targetOffset.get(target.id) ?? 0) + targetSegment)

    const gradId = gradientId(source.id)
    return [
      <path
        key={`${link.model}-${link.project}-${i}`}
        data-testid="sankey-ribbon"
        data-model={source.id}
        data-project={target.id}
        d={`M ${LEFT_X + NODE_W + 1} ${round(sy)} C 300 ${round(sy)} 380 ${round(ty)} ${RIGHT_X - 1} ${round(ty)}`}
        stroke={`url(#${gradId})`}
        strokeWidth={round(width)}
        fill="none"
        strokeOpacity=".40"
      />,
    ]
  })

  return (
    <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} width="100%" style={{ minWidth: 560, display: 'block' }}>
      <defs>
        {models.map(model => (
          <linearGradient key={model.id} id={gradientId(model.id)} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor={model.fill} />
            <stop offset="1" stopColor={model.fill} stopOpacity=".25" />
          </linearGradient>
        ))}
      </defs>

      {ribbons}

      {models.map(node => (
        <rect
          key={node.id}
          data-testid="sankey-node"
          data-node-id={node.id}
          x={node.x}
          y={round(node.y)}
          width={NODE_W}
          height={round(node.h)}
          rx="2.5"
          fill={node.fill}
        />
      ))}
      {projects.map(node => (
        <rect
          key={node.id}
          data-testid="sankey-node"
          data-node-id={node.id}
          x={node.x}
          y={round(node.y)}
          width={NODE_W}
          height={round(node.h)}
          rx="2.5"
          fill={node.fill}
        />
      ))}

      {models.map(node => (
        <text key={node.id} x="118" y={round(node.y + node.h / 2 + 3)} textAnchor="end" fontSize="10" fill="var(--mut)">
          {node.displayLabel} · {formatUsd(node.cost)}
        </text>
      ))}
      {projects.map(node => (
        <text key={node.id} x="534" y={round(node.y + node.h / 2 + 3)} fontSize="10" fill="var(--mut)">
          {node.displayLabel} · {formatUsd(node.cost)}
        </text>
      ))}
    </svg>
  )
}

function layoutNodes(nodes: SpendFlowNode[], x: number, modelSide: boolean): LayoutNode[] {
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
    const displayLabel = modelSide ? modelDisplayLabel(node.label || node.id) : projectDisplayLabel(node.label || node.id)
    const laidOut = { ...node, x, y, h, fill, displayLabel }
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
  const value = raw.trim()
  return ellipsize(shortenId(value), 18)
}

function projectDisplayLabel(raw: string): string {
  const value = raw.trim()
  if (isOtherNode(value)) return 'Other'
  return ellipsize(shortenProjectPath(value), 24)
}

function shortenId(value: string): string {
  return value.replace(/^claude[-_]/i, '').replace(/^openai[-_]/i, '')
}

function ellipsize(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value
}

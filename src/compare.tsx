import React, { useState } from 'react'
import { render, Box, Text, useInput, useApp } from 'ink'

import type { ModelStats, ComparisonRow } from './compare-stats.js'
import { aggregateModelStats, computeComparison, scanSelfCorrections } from './compare-stats.js'
import { formatCost } from './format.js'
import { parseAllSessions } from './parser.js'
import { getAllProviders } from './providers/index.js'
import type { ProjectSummary, DateRange } from './types.js'

const ORANGE = '#FF8C42'
const GREEN = '#5BF5A0'
const DIM = '#555555'
const GOLD = '#FFD700'
const LOW_DATA_THRESHOLD = 20
const LABEL_WIDTH = 20
const VALUE_WIDTH = 14
const WINNER_WIDTH = 12
const MODEL_NAME_COL = 24
const MS_PER_DAY = 24 * 60 * 60 * 1000

function formatValue(value: number | null, fmt: ComparisonRow['formatFn']): string {
  if (value === null) return '-'
  switch (fmt) {
    case 'cost': return formatCost(value)
    case 'number': return Math.round(value).toLocaleString()
    case 'percent': return `${value.toFixed(1)}%`
    case 'decimal': return value.toFixed(2)
  }
}

function shortName(model: string): string {
  return model.replace(/^claude-/, '')
}

function daysOfData(first: string, last: string): number {
  if (!first || !last) return 0
  const ms = new Date(last).getTime() - new Date(first).getTime()
  return Math.max(1, Math.ceil(ms / MS_PER_DAY))
}

type ModelSelectorProps = {
  models: ModelStats[]
  onSelect: (a: ModelStats, b: ModelStats) => void
  onBack: () => void
}

function ModelSelector({ models, onSelect, onBack }: ModelSelectorProps) {
  const { exit } = useApp()
  const [cursor, setCursor] = useState(0)
  const [selected, setSelected] = useState<Set<number>>(new Set())

  useInput((input, key) => {
    if (input === 'q') { exit(); return }
    if (key.escape) { onBack(); return }

    if (key.upArrow) {
      setCursor(c => (c - 1 + models.length) % models.length)
      return
    }
    if (key.downArrow) {
      setCursor(c => (c + 1) % models.length)
      return
    }

    if (input === ' ') {
      setSelected(prev => {
        const next = new Set(prev)
        if (next.has(cursor)) {
          next.delete(cursor)
        } else if (next.size < 2) {
          next.add(cursor)
        }
        return next
      })
      return
    }

    if (key.return && selected.size === 2) {
      const indices = [...selected].sort((a, b) => a - b)
      onSelect(models[indices[0]!]!, models[indices[1]!]!)
    }
  })

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color={ORANGE}>Model Comparison</Text>
      <Text> </Text>
      <Text dimColor>Select two models to compare:</Text>
      <Text> </Text>
      {models.map((m, i) => {
        const isCursor = i === cursor
        const isSelected = selected.has(i)
        const lowData = m.calls < LOW_DATA_THRESHOLD
        const prefix = isCursor ? '> ' : '  '
        return (
          <Text key={m.model}>
            <Text color={isCursor ? ORANGE : undefined}>{prefix}</Text>
            <Text bold={isSelected} color={isSelected ? GREEN : undefined}>
              {m.model.padEnd(MODEL_NAME_COL)}
            </Text>
            <Text>{m.calls.toLocaleString().padStart(8)} calls</Text>
            <Text color={GOLD}>{formatCost(m.cost).padStart(10)}</Text>
            {isSelected && <Text color={GREEN}>   [selected]</Text>}
            {lowData && <Text color={DIM}>   low data</Text>}
          </Text>
        )
      })}
      <Text> </Text>
      <Text>
        <Text color={ORANGE} bold>[space]</Text><Text dimColor> select  </Text>
        <Text color={ORANGE} bold>[enter]</Text><Text dimColor> compare  </Text>
        <Text color={ORANGE} bold>[esc]</Text><Text dimColor> back  </Text>
        <Text color={ORANGE} bold>[q]</Text><Text dimColor> quit</Text>
      </Text>
    </Box>
  )
}

type ComparisonResultsProps = {
  modelA: ModelStats
  modelB: ModelStats
  rows: ComparisonRow[]
  onBack: () => void
}

function ComparisonResults({ modelA, modelB, rows, onBack }: ComparisonResultsProps) {
  const { exit } = useApp()
  const nameA = shortName(modelA.model)
  const nameB = shortName(modelB.model)
  const lowDataA = modelA.calls < LOW_DATA_THRESHOLD
  const lowDataB = modelB.calls < LOW_DATA_THRESHOLD

  useInput((input, key) => {
    if (input === 'q') { exit(); return }
    if (key.escape) { onBack(); return }
  })

  const contextRows: { label: string; valueA: string; valueB: string }[] = [
    { label: 'Calls', valueA: modelA.calls.toLocaleString(), valueB: modelB.calls.toLocaleString() },
    { label: 'Total cost', valueA: formatCost(modelA.cost), valueB: formatCost(modelB.cost) },
    { label: 'Days of data', valueA: String(daysOfData(modelA.firstSeen, modelA.lastSeen)), valueB: String(daysOfData(modelB.firstSeen, modelB.lastSeen)) },
    { label: 'Edit turns', valueA: modelA.editTurns.toLocaleString(), valueB: modelB.editTurns.toLocaleString() },
  ]

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text>
        <Text bold color={ORANGE}>{modelA.model}</Text>
        <Text dimColor>  vs  </Text>
        <Text bold color={ORANGE}>{modelB.model}</Text>
      </Text>
      <Text> </Text>
      <Text>
        <Text>{''.padEnd(LABEL_WIDTH)}</Text>
        <Text bold>{nameA.padStart(VALUE_WIDTH)}</Text>
        <Text bold>{nameB.padStart(VALUE_WIDTH)}</Text>
      </Text>
      {rows.map(row => {
        const fmtA = formatValue(row.valueA, row.formatFn)
        const fmtB = formatValue(row.valueB, row.formatFn)
        const winnerLabel = row.winner === 'a' ? `${nameA} wins`
          : row.winner === 'b' ? `${nameB} wins`
          : row.winner === 'tie' ? 'tie' : ''

        return (
          <Text key={row.label}>
            <Text dimColor>{row.label.padEnd(LABEL_WIDTH)}</Text>
            <Text color={row.winner === 'a' ? GREEN : undefined}>{fmtA.padStart(VALUE_WIDTH)}</Text>
            <Text color={row.winner === 'b' ? GREEN : undefined}>{fmtB.padStart(VALUE_WIDTH)}</Text>
            <Text color={DIM}>{winnerLabel.padStart(WINNER_WIDTH)}</Text>
          </Text>
        )
      })}
      <Text> </Text>
      <Text dimColor>{'-- Context '.padEnd(LABEL_WIDTH + VALUE_WIDTH * 2 + WINNER_WIDTH, '-')}</Text>
      {contextRows.map(row => (
        <Text key={row.label}>
          <Text color={DIM}>{row.label.padEnd(LABEL_WIDTH)}</Text>
          <Text color={DIM}>{row.valueA.padStart(VALUE_WIDTH)}</Text>
          <Text color={DIM}>{row.valueB.padStart(VALUE_WIDTH)}</Text>
        </Text>
      ))}
      {(lowDataA || lowDataB) && (
        <>
          <Text> </Text>
          <Text color={GOLD}>
            Note: {[lowDataA && modelA.model, lowDataB && modelB.model].filter(Boolean).join(' and ')} ha{lowDataA && lowDataB ? 've' : 's'} fewer than {LOW_DATA_THRESHOLD} calls -- results may not be representative.
          </Text>
        </>
      )}
      <Text> </Text>
      <Text>
        <Text color={ORANGE} bold>[esc]</Text><Text dimColor> back  </Text>
        <Text color={ORANGE} bold>[q]</Text><Text dimColor> quit</Text>
      </Text>
    </Box>
  )
}

type CompareViewProps = {
  projects: ProjectSummary[]
  onBack: () => void
}

export function CompareView({ projects, onBack }: CompareViewProps) {
  const { exit } = useApp()
  const [phase, setPhase] = useState<'select' | 'loading' | 'results'>('select')
  const [models] = useState(() => aggregateModelStats(projects))
  const [selectedA, setSelectedA] = useState<ModelStats | null>(null)
  const [selectedB, setSelectedB] = useState<ModelStats | null>(null)
  const [rows, setRows] = useState<ComparisonRow[]>([])

  useInput((input, key) => {
    if (phase !== 'select') return
    if (models.length < 2) {
      if (input === 'q') { exit(); return }
      if (key.escape) { onBack(); return }
    }
  })

  if (models.length < 2) {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color={ORANGE}>Model Comparison</Text>
        <Text> </Text>
        <Text dimColor>Need at least 2 models to compare. Found {models.length}.</Text>
        <Text> </Text>
        <Text>
          <Text color={ORANGE} bold>[esc]</Text><Text dimColor> back  </Text>
          <Text color={ORANGE} bold>[q]</Text><Text dimColor> quit</Text>
        </Text>
      </Box>
    )
  }

  const handleSelect = async (a: ModelStats, b: ModelStats) => {
    setPhase('loading')

    const providers = await getAllProviders()
    const dirs: string[] = []
    for (const p of providers) {
      const sessions = await p.discoverSessions()
      for (const s of sessions) dirs.push(s.path)
    }

    const corrections = await scanSelfCorrections(dirs)
    const aCopy = { ...a, selfCorrections: corrections.get(a.model) ?? 0 }
    const bCopy = { ...b, selfCorrections: corrections.get(b.model) ?? 0 }

    const comparisonRows = computeComparison(aCopy, bCopy)
    setSelectedA(aCopy)
    setSelectedB(bCopy)
    setRows(comparisonRows)
    setPhase('results')
  }

  if (phase === 'loading') {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color={ORANGE}>Model Comparison</Text>
        <Text> </Text>
        <Text dimColor>Scanning self-corrections...</Text>
      </Box>
    )
  }

  if (phase === 'results' && selectedA && selectedB) {
    return (
      <ComparisonResults
        modelA={selectedA}
        modelB={selectedB}
        rows={rows}
        onBack={() => setPhase('select')}
      />
    )
  }

  return (
    <ModelSelector
      models={models}
      onSelect={handleSelect}
      onBack={onBack}
    />
  )
}

export async function renderCompare(range: DateRange, provider: string): Promise<void> {
  const isTTY = process.stdin.isTTY && process.stdout.isTTY
  if (!isTTY) {
    process.stdout.write('Model comparison requires an interactive terminal.\n')
    return
  }

  const projects = await parseAllSessions(range, provider)
  const { waitUntilExit } = render(
    <CompareView projects={projects} onBack={() => process.exit(0)} />
  )
  await waitUntilExit()
}

import React, { useState, useEffect, useRef } from 'react'
import { render, Box, Text, useInput, useApp, useStdout } from 'ink'

import type { ModelStats, ComparisonRow, CategoryComparison, WorkingStyleRow } from './compare-stats.js'
import { aggregateModelStats, computeComparison, computeCategoryComparison, computeWorkingStyle, scanSelfCorrections } from './compare-stats.js'
import { formatCost } from './format.js'
import { parseAllSessions } from './parser.js'
import { getAllProviders } from './providers/index.js'
import type { ProjectSummary, DateRange } from './types.js'

const ORANGE = '#FF8C42'
const GREEN = '#5BF5A0'
const DIM = '#888888'
const GOLD = '#FFD700'
const BAR_A = '#6495ED'
const BAR_B = '#5BF5A0'
const LOW_DATA_THRESHOLD = 20
const LABEL_WIDTH = 20
const VALUE_WIDTH = 14
const MODEL_NAME_COL = 24
const BAR_MAX_WIDTH = 30
const MIN_WIDE = 90
const PANEL_CHROME = 4
const MS_PER_DAY = 24 * 60 * 60 * 1000
const FULL_BLOCK = '\u2588'

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
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '')
}

function daysOfData(first: string, last: string): number {
  if (!first || !last) return 0
  const ms = new Date(last).getTime() - new Date(first).getTime()
  return Math.max(1, Math.ceil(ms / MS_PER_DAY))
}

function barWidth(rate: number): number {
  return Math.round((rate / 100) * BAR_MAX_WIDTH)
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
      <Box flexDirection="column" borderStyle="round" borderColor={ORANGE} paddingX={1}>
        <Text bold color={ORANGE}>Model Comparison</Text>
        <Text> </Text>
        <Text color={DIM}>Select two models to compare:</Text>
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
                {shortName(m.model).padEnd(MODEL_NAME_COL)}
              </Text>
              <Text>{m.calls.toLocaleString().padStart(8)} calls</Text>
              <Text color={GOLD}>{formatCost(m.cost).padStart(10)}</Text>
              {isSelected && <Text color={GREEN}>   [selected]</Text>}
              {lowData && <Text color={DIM}>   low data</Text>}
            </Text>
          )
        })}
      </Box>
      <Text> </Text>
      <Text>
        <Text color={ORANGE} bold>[space]</Text><Text dimColor> select  </Text>
        <Text color={ORANGE} bold>[enter]</Text><Text dimColor> compare  </Text>
        <Text color={ORANGE} bold>{'<>'}</Text><Text dimColor> switch period  </Text>
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
  categories: CategoryComparison[]
  workingStyle: WorkingStyleRow[]
  onBack: () => void
}

function MetricPanel({ title, rows, nameA, nameB, pw }: { title: string; rows: ComparisonRow[]; nameA: string; nameB: string; pw: number }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ORANGE} paddingX={1} width={pw}>
      <Text bold color={ORANGE}>{title}</Text>
      <Text>
        <Text>{''.padEnd(LABEL_WIDTH)}</Text>
        <Text bold>{nameA.padStart(VALUE_WIDTH)}</Text>
        <Text bold>{nameB.padStart(VALUE_WIDTH)}</Text>
      </Text>
      {rows.map(row => {
        const fmtA = formatValue(row.valueA, row.formatFn)
        const fmtB = formatValue(row.valueB, row.formatFn)
        return (
          <Text key={row.label}>
            <Text color={DIM}>{row.label.padEnd(LABEL_WIDTH)}</Text>
            <Text color={row.winner === 'a' ? GREEN : undefined}>{fmtA.padStart(VALUE_WIDTH)}</Text>
            <Text color={row.winner === 'b' ? GREEN : undefined}>{fmtB.padStart(VALUE_WIDTH)}</Text>
          </Text>
        )
      })}
    </Box>
  )
}

function ContextPanel({ title, rows, nameA, nameB, pw, lowDataWarning }: { title: string; rows: { label: string; valueA: string; valueB: string }[]; nameA: string; nameB: string; pw: number; lowDataWarning?: string }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ORANGE} paddingX={1} width={pw}>
      <Text bold color={ORANGE}>{title}</Text>
      <Text>
        <Text>{''.padEnd(LABEL_WIDTH)}</Text>
        <Text bold>{nameA.padStart(VALUE_WIDTH)}</Text>
        <Text bold>{nameB.padStart(VALUE_WIDTH)}</Text>
      </Text>
      {rows.map(row => (
        <Text key={row.label}>
          <Text color={DIM}>{row.label.padEnd(LABEL_WIDTH)}</Text>
          <Text color={DIM}>{row.valueA.padStart(VALUE_WIDTH)}</Text>
          <Text color={DIM}>{row.valueB.padStart(VALUE_WIDTH)}</Text>
        </Text>
      ))}
      {lowDataWarning && <Text color={GOLD}>{lowDataWarning}</Text>}
    </Box>
  )
}

function ComparisonResults({ modelA, modelB, rows, categories, workingStyle, onBack }: ComparisonResultsProps) {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const termWidth = stdout?.columns || 80
  const dashWidth = Math.min(160, termWidth)
  const wide = dashWidth >= MIN_WIDE
  const halfWidth = wide ? Math.floor(dashWidth / 2) : dashWidth

  const nameA = shortName(modelA.model)
  const nameB = shortName(modelB.model)
  const lowDataA = modelA.calls < LOW_DATA_THRESHOLD
  const lowDataB = modelB.calls < LOW_DATA_THRESHOLD

  useInput((input, key) => {
    if (input === 'q') { exit(); return }
    if (key.escape) { onBack(); return }
  })

  const sectionOrder: string[] = []
  const sectionRows = new Map<string, ComparisonRow[]>()
  for (const row of rows) {
    if (!sectionRows.has(row.section)) {
      sectionOrder.push(row.section)
      sectionRows.set(row.section, [])
    }
    sectionRows.get(row.section)!.push(row)
  }

  const fmtTokens = (n: number) => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
    return String(n)
  }

  const contextRows: { label: string; valueA: string; valueB: string }[] = [
    { label: 'Calls', valueA: modelA.calls.toLocaleString(), valueB: modelB.calls.toLocaleString() },
    { label: 'Total cost', valueA: formatCost(modelA.cost), valueB: formatCost(modelB.cost) },
    { label: 'Input tokens', valueA: fmtTokens(modelA.inputTokens), valueB: fmtTokens(modelB.inputTokens) },
    { label: 'Output tokens', valueA: fmtTokens(modelA.outputTokens), valueB: fmtTokens(modelB.outputTokens) },
    { label: 'Days of data', valueA: String(daysOfData(modelA.firstSeen, modelA.lastSeen)), valueB: String(daysOfData(modelB.firstSeen, modelB.lastSeen)) },
    { label: 'Edit turns', valueA: modelA.editTurns.toLocaleString(), valueB: modelB.editTurns.toLocaleString() },
    { label: 'Self-corrections', valueA: modelA.selfCorrections.toLocaleString(), valueB: modelB.selfCorrections.toLocaleString() },
  ]

  const lowDataWarning = (lowDataA || lowDataB)
    ? `Note: ${[lowDataA && shortName(modelA.model), lowDataB && shortName(modelB.model)].filter(Boolean).join(' and ')} ha${lowDataA && lowDataB ? 've' : 's'} fewer than ${LOW_DATA_THRESHOLD} calls`
    : undefined

  const pw = wide ? halfWidth : dashWidth

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box flexDirection="column" borderStyle="round" borderColor={ORANGE} paddingX={1} width={dashWidth}>
        <Text>
          <Text bold color={ORANGE}>{nameA}</Text>
          <Text dimColor>  vs  </Text>
          <Text bold color={ORANGE}>{nameB}</Text>
        </Text>
      </Box>

      <Box width={dashWidth}>
        <MetricPanel title={sectionOrder[0] ?? 'Performance'} rows={sectionRows.get(sectionOrder[0] ?? '') ?? []} nameA={nameA} nameB={nameB} pw={pw} />
        <MetricPanel title={sectionOrder[1] ?? 'Efficiency'} rows={sectionRows.get(sectionOrder[1] ?? '') ?? []} nameA={nameA} nameB={nameB} pw={pw} />
      </Box>

      {categories.length > 0 && (
        <Box flexDirection="column" borderStyle="round" borderColor={ORANGE} paddingX={1} width={dashWidth}>
          <Text bold color={ORANGE}>Category Head-to-Head</Text>
          <Text color={DIM}>one-shot rate per category</Text>
          <Text>
            <Text>{'  '}</Text>
            <Text color={BAR_A}>{FULL_BLOCK + FULL_BLOCK}</Text>
            <Text> {nameA}    </Text>
            <Text color={BAR_B}>{FULL_BLOCK + FULL_BLOCK}</Text>
            <Text> {nameB}</Text>
          </Text>
          {categories.map(cat => {
            const bwA = cat.oneShotRateA !== null ? barWidth(cat.oneShotRateA) : 0
            const bwB = cat.oneShotRateB !== null ? barWidth(cat.oneShotRateB) : 0
            const rateA = cat.oneShotRateA !== null ? `${cat.oneShotRateA.toFixed(1)}%` : '-'
            const rateB = cat.oneShotRateB !== null ? `${cat.oneShotRateB.toFixed(1)}%` : '-'
            const turnsA = cat.editTurnsA > 0 ? `(${cat.editTurnsA})` : ''
            const turnsB = cat.editTurnsB > 0 ? `(${cat.editTurnsB})` : ''

            return (
              <React.Fragment key={cat.category}>
                <Text> </Text>
                <Text color={DIM}>{'  '}{cat.category}</Text>
                <Text>
                  <Text>{'  '}</Text>
                  <Text color={cat.winner === 'a' ? BAR_A : DIM}>{FULL_BLOCK.repeat(Math.max(bwA, 1))}</Text>
                  <Text>{' '.repeat(Math.max(0, BAR_MAX_WIDTH - bwA))} </Text>
                  <Text color={cat.winner === 'a' ? GREEN : undefined}>{rateA.padStart(6)}</Text>
                  <Text color={DIM}> {turnsA}</Text>
                </Text>
                <Text>
                  <Text>{'  '}</Text>
                  <Text color={cat.winner === 'b' ? BAR_B : DIM}>{FULL_BLOCK.repeat(Math.max(bwB, 1))}</Text>
                  <Text>{' '.repeat(Math.max(0, BAR_MAX_WIDTH - bwB))} </Text>
                  <Text color={cat.winner === 'b' ? GREEN : undefined}>{rateB.padStart(6)}</Text>
                  <Text color={DIM}> {turnsB}</Text>
                </Text>
              </React.Fragment>
            )
          })}
        </Box>
      )}

      <Box width={dashWidth}>
        {workingStyle.length > 0 && (
          <ContextPanel title="Working Style" rows={workingStyle.map(r => ({ label: r.label, valueA: formatValue(r.valueA, r.formatFn), valueB: formatValue(r.valueB, r.formatFn) }))} nameA={nameA} nameB={nameB} pw={pw} />
        )}
        <ContextPanel title="Context" rows={contextRows} nameA={nameA} nameB={nameB} pw={pw} lowDataWarning={lowDataWarning} />
      </Box>

      <Text>
        <Text color={ORANGE} bold>{'<>'}</Text><Text dimColor> switch period  </Text>
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
  const [models, setModels] = useState<ModelStats[]>(() => aggregateModelStats(projects))
  const [pickedNames, setPickedNames] = useState<[string, string] | null>(null)
  const [selectedA, setSelectedA] = useState<ModelStats | null>(null)
  const [selectedB, setSelectedB] = useState<ModelStats | null>(null)
  const [rows, setRows] = useState<ComparisonRow[]>([])
  const [categories, setCategories] = useState<CategoryComparison[]>([])
  const [style, setStyle] = useState<WorkingStyleRow[]>([])
  const [loadTrigger, setLoadTrigger] = useState(0)
  const projectsRef = useRef(projects)
  projectsRef.current = projects

  useEffect(() => {
    const newModels = aggregateModelStats(projects)
    setModels(newModels)

    if (pickedNames) {
      const hasA = newModels.some(m => m.model === pickedNames[0])
      const hasB = newModels.some(m => m.model === pickedNames[1])
      if (hasA && hasB) {
        setLoadTrigger(t => t + 1)
      } else {
        setPickedNames(null)
        setPhase('select')
      }
    }
  }, [projects])

  useEffect(() => {
    if (loadTrigger === 0 || !pickedNames) return
    let cancelled = false
    setPhase('loading')

    const currentModels = aggregateModelStats(projectsRef.current)
    const a = currentModels.find(m => m.model === pickedNames[0])
    const b = currentModels.find(m => m.model === pickedNames[1])
    if (!a || !b) { setPhase('select'); return }

    async function run() {
      const providers = await getAllProviders()
      const dirs: string[] = []
      for (const p of providers) {
        const sessions = await p.discoverSessions()
        for (const s of sessions) dirs.push(s.path)
      }
      const corrections = await scanSelfCorrections(dirs)
      if (cancelled) return

      const currentProjects = projectsRef.current
      const aCopy = { ...a!, selfCorrections: corrections.get(a!.model) ?? 0 }
      const bCopy = { ...b!, selfCorrections: corrections.get(b!.model) ?? 0 }
      setSelectedA(aCopy)
      setSelectedB(bCopy)
      setRows(computeComparison(aCopy, bCopy))
      setCategories(computeCategoryComparison(currentProjects, a!.model, b!.model))
      setStyle(computeWorkingStyle(currentProjects, a!.model, b!.model))
      setPhase('results')
    }

    run()
    return () => { cancelled = true }
  }, [loadTrigger])

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
        <Box flexDirection="column" borderStyle="round" borderColor={ORANGE} paddingX={1}>
          <Text bold color={ORANGE}>Model Comparison</Text>
          <Text> </Text>
          <Text color={DIM}>Need at least 2 models to compare. Found {models.length}.</Text>
        </Box>
        <Text> </Text>
        <Text>
          <Text color={ORANGE} bold>[esc]</Text><Text dimColor> back  </Text>
          <Text color={ORANGE} bold>[q]</Text><Text dimColor> quit</Text>
        </Text>
      </Box>
    )
  }

  const handleSelect = (a: ModelStats, b: ModelStats) => {
    setPickedNames([a.model, b.model])
    setLoadTrigger(t => t + 1)
  }

  if (phase === 'loading') {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Box flexDirection="column" borderStyle="round" borderColor={ORANGE} paddingX={1}>
          <Text bold color={ORANGE}>Model Comparison</Text>
          <Text> </Text>
          <Text color={DIM}>Scanning self-corrections...</Text>
        </Box>
      </Box>
    )
  }

  if (phase === 'results' && selectedA && selectedB) {
    return (
      <ComparisonResults
        modelA={selectedA}
        modelB={selectedB}
        rows={rows}
        categories={categories}
        workingStyle={style}
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

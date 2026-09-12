import { readdir, readFile } from 'fs/promises'
import { basename, join } from 'path'

import type { ClassifiedTurn, ProjectSummary } from './types.js'
import { isBehavioralCall } from './behavioral-weight.js'
import { getShortModelName } from './models.js'
import { callBillableOutputTokens } from './session-output.js'

const PLANNING_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TodoWrite', 'EnterPlanMode', 'ExitPlanMode'])

/// The turn's primary model: the model of its FIRST BEHAVIORAL call. Undefined
/// when the turn has none — accounting-only turns carry no behavioral evidence,
/// so they are excluded from efficiency comparisons (their spend still appears
/// in every spend report).
function primaryTurnModel(turn: ClassifiedTurn): string | undefined {
  return turn.assistantCalls.find(isBehavioralCall)?.model
}

export type ModelStats = {
  model: string
  calls: number
  cost: number
  outputTokens: number
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTurns: number
  editTurns: number
  oneShotTurns: number
  retries: number
  selfCorrections: number
  editCost: number
  firstSeen: string
  lastSeen: string
}

export function aggregateModelStats(projects: ProjectSummary[]): ModelStats[] {
  const byModel = new Map<string, ModelStats>()

  const ensure = (model: string): ModelStats => {
    let s = byModel.get(model)
    if (!s) {
      s = { model, calls: 0, cost: 0, outputTokens: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTurns: 0, editTurns: 0, oneShotTurns: 0, retries: 0, selfCorrections: 0, editCost: 0, firstSeen: '', lastSeen: '' }
      byModel.set(model, s)
    }
    return s
  }

  for (const project of projects) {
    for (const session of project.sessions) {
      for (const turn of session.turns) {
        const primaryModel = primaryTurnModel(turn)
        if (primaryModel === undefined || primaryModel === '<synthetic>') continue

        const ms = ensure(primaryModel)
        ms.totalTurns++
        if (turn.hasEdits) {
          ms.editTurns++
          if (turn.retries === 0) ms.oneShotTurns++
          for (const c of turn.assistantCalls) {
            if (c.model !== '<synthetic>') ms.editCost += c.costUSD
          }
        }
        ms.retries += turn.retries

        for (const call of turn.assistantCalls) {
          if (call.model === '<synthetic>') continue
          const cs = call.model === primaryModel ? ms : ensure(call.model)
          if (isBehavioralCall(call)) cs.calls++
          cs.cost += call.costUSD
          cs.outputTokens += callBillableOutputTokens(call)
          cs.inputTokens += call.usage.inputTokens
          cs.cacheReadTokens += call.usage.cacheReadInputTokens
          cs.cacheWriteTokens += call.usage.cacheCreationInputTokens

          if (!cs.firstSeen || call.timestamp < cs.firstSeen) cs.firstSeen = call.timestamp
          if (!cs.lastSeen || call.timestamp > cs.lastSeen) cs.lastSeen = call.timestamp
        }
      }
    }
  }

  return [...byModel.values()].sort((a, b) => b.cost - a.cost)
}

/// Look up a model by the exact canonical id (what --model-a/--model-b has
/// always accepted) or, failing that, by its display name (what the compare
/// picker actually shows the user, e.g. "Opus 4.8") - case-insensitively.
/// Reuses getShortModelName, the existing canonical -> display mapping,
/// rather than a new alias table.
export function findModelStat(models: ModelStats[], input: string): ModelStats | undefined {
  return models.find(m => m.model === input)
    ?? models.find(m => getShortModelName(m.model).toLowerCase() === input.toLowerCase())
}

export type ComparisonRow = {
  section: string
  label: string
  valueA: number | null
  valueB: number | null
  formatFn: 'cost' | 'number' | 'percent' | 'decimal'
  winner: 'a' | 'b' | 'tie' | 'none'
}

export type CategoryComparison = {
  category: string
  turnsA: number
  editTurnsA: number
  oneShotRateA: number | null
  turnsB: number
  editTurnsB: number
  oneShotRateB: number | null
  winner: 'a' | 'b' | 'tie' | 'none'
}

export type WorkingStyleRow = {
  label: string
  valueA: number | null
  valueB: number | null
  formatFn: ComparisonRow['formatFn']
}

export type CompareJsonReport = {
  period: {
    label: string
    provider: string
  }
  modelA: ModelStats
  modelB: ModelStats
  metrics: ComparisonRow[]
  categories: CategoryComparison[]
  workingStyle: WorkingStyleRow[]
}

type MetricDef = {
  section: string
  label: string
  formatFn: ComparisonRow['formatFn']
  higherIsBetter: boolean
  compute: (s: ModelStats) => number | null
}

const METRICS: MetricDef[] = [
  {
    section: 'Performance',
    label: 'One-shot rate',
    formatFn: 'percent',
    higherIsBetter: true,
    compute: s => s.editTurns > 0 ? (s.oneShotTurns / s.editTurns) * 100 : null,
  },
  {
    section: 'Performance',
    label: 'Retry rate',
    formatFn: 'decimal',
    higherIsBetter: false,
    compute: s => s.editTurns > 0 ? s.retries / s.editTurns : null,
  },
  {
    section: 'Performance',
    label: 'Self-correction',
    formatFn: 'percent',
    higherIsBetter: false,
    compute: s => s.totalTurns > 0 ? (s.selfCorrections / s.totalTurns) * 100 : null,
  },
  {
    section: 'Efficiency',
    label: 'Cost / call',
    formatFn: 'cost',
    higherIsBetter: false,
    compute: s => s.calls > 0 ? s.cost / s.calls : null,
  },
  {
    section: 'Efficiency',
    label: 'Cost / edit',
    formatFn: 'cost',
    higherIsBetter: false,
    compute: s => s.editTurns > 0 ? s.editCost / s.editTurns : null,
  },
  {
    section: 'Efficiency',
    label: 'Output tok / call',
    formatFn: 'number',
    higherIsBetter: false,
    compute: s => s.calls > 0 ? Math.round(s.outputTokens / s.calls) : null,
  },
  {
    section: 'Efficiency',
    label: 'Cache hit rate',
    formatFn: 'percent',
    higherIsBetter: true,
    compute: s => {
      // Cache-hit = reads over reads + fresh input (excludes cache writes), to
      // match src/menubar-json.ts:cacheHitPercent and the rest of the app.
      const total = s.inputTokens + s.cacheReadTokens
      return total > 0 ? (s.cacheReadTokens / total) * 100 : null
    },
  },
]

function pickWinner(valueA: number | null, valueB: number | null, higherIsBetter: boolean): ComparisonRow['winner'] {
  if (valueA === null || valueB === null) return 'none'
  if (valueA === valueB) return 'tie'
  if (higherIsBetter) return valueA > valueB ? 'a' : 'b'
  return valueA < valueB ? 'a' : 'b'
}

export function computeComparison(a: ModelStats, b: ModelStats): ComparisonRow[] {
  return METRICS.map(m => {
    const valueA = m.compute(a)
    const valueB = m.compute(b)
    return {
      section: m.section,
      label: m.label,
      valueA,
      valueB,
      formatFn: m.formatFn,
      winner: pickWinner(valueA, valueB, m.higherIsBetter),
    }
  })
}

export function computeCategoryComparison(projects: ProjectSummary[], modelA: string, modelB: string): CategoryComparison[] {
  type Accum = { turns: number; editTurns: number; oneShotTurns: number }
  const mapA = new Map<string, Accum>()
  const mapB = new Map<string, Accum>()

  const ensure = (map: Map<string, Accum>, cat: string): Accum => {
    let a = map.get(cat)
    if (!a) { a = { turns: 0, editTurns: 0, oneShotTurns: 0 }; map.set(cat, a) }
    return a
  }

  for (const project of projects) {
    for (const session of project.sessions) {
      for (const turn of session.turns) {
        const primary = primaryTurnModel(turn)
        if (primary !== modelA && primary !== modelB) continue

        const acc = ensure(primary === modelA ? mapA : mapB, turn.category)
        acc.turns++
        if (turn.hasEdits) {
          acc.editTurns++
          if (turn.retries === 0) acc.oneShotTurns++
        }
      }
    }
  }

  const allCats = new Set([...mapA.keys(), ...mapB.keys()])
  const result: CategoryComparison[] = []

  for (const category of allCats) {
    const a = mapA.get(category)
    const b = mapB.get(category)
    if ((!a || a.editTurns === 0) && (!b || b.editTurns === 0)) continue

    const rateA = a && a.editTurns > 0 ? (a.oneShotTurns / a.editTurns) * 100 : null
    const rateB = b && b.editTurns > 0 ? (b.oneShotTurns / b.editTurns) * 100 : null

    result.push({
      category,
      turnsA: a?.turns ?? 0,
      editTurnsA: a?.editTurns ?? 0,
      oneShotRateA: rateA,
      turnsB: b?.turns ?? 0,
      editTurnsB: b?.editTurns ?? 0,
      oneShotRateB: rateB,
      winner: pickWinner(rateA, rateB, true),
    })
  }

  return result.sort((a, b) => (b.turnsA + b.turnsB) - (a.turnsA + a.turnsB))
}

export function computeWorkingStyle(projects: ProjectSummary[], modelA: string, modelB: string): WorkingStyleRow[] {
  type StyleAccum = { totalTurns: number; agentSpawns: number; planModeUses: number; totalToolCalls: number; fastModeCalls: number }
  const sA: StyleAccum = { totalTurns: 0, agentSpawns: 0, planModeUses: 0, totalToolCalls: 0, fastModeCalls: 0 }
  const sB: StyleAccum = { totalTurns: 0, agentSpawns: 0, planModeUses: 0, totalToolCalls: 0, fastModeCalls: 0 }

  for (const project of projects) {
    for (const session of project.sessions) {
      for (const turn of session.turns) {
        const primary = primaryTurnModel(turn)
        if (primary !== modelA && primary !== modelB) continue

        const s = primary === modelA ? sA : sB
        s.totalTurns++
        const behavioralCalls = turn.assistantCalls.filter(isBehavioralCall)
        const turnTools = behavioralCalls.flatMap(c => c.tools)
        if (turnTools.some(t => PLANNING_TOOLS.has(t)) || behavioralCalls.some(c => c.hasPlanMode)) {
          s.planModeUses++
        }
        for (const call of behavioralCalls) {
          s.totalToolCalls += call.tools.length
          if (call.hasAgentSpawn) s.agentSpawns++
          if (call.speed === 'fast') s.fastModeCalls++
        }
      }
    }
  }

  const pct = (num: number, den: number) => den > 0 ? (num / den) * 100 : null
  const avg = (num: number, den: number) => den > 0 ? num / den : null

  return [
    { label: 'Delegation rate', valueA: pct(sA.agentSpawns, sA.totalTurns), valueB: pct(sB.agentSpawns, sB.totalTurns), formatFn: 'percent' as const },
    { label: 'Planning rate', valueA: pct(sA.planModeUses, sA.totalTurns), valueB: pct(sB.planModeUses, sB.totalTurns), formatFn: 'percent' as const },
    { label: 'Avg tools / turn', valueA: avg(sA.totalToolCalls, sA.totalTurns), valueB: avg(sB.totalToolCalls, sB.totalTurns), formatFn: 'decimal' as const },
    { label: 'Fast mode usage', valueA: pct(sA.fastModeCalls, sA.totalTurns), valueB: pct(sB.fastModeCalls, sB.totalTurns), formatFn: 'percent' as const },
  ]
}

export function buildCompareJson(
  projects: ProjectSummary[],
  modelA: ModelStats,
  modelB: ModelStats,
  label: string,
  provider: string,
): CompareJsonReport {
  return {
    period: { label, provider },
    modelA,
    modelB,
    metrics: computeComparison(modelA, modelB),
    categories: computeCategoryComparison(projects, modelA.model, modelB.model),
    workingStyle: computeWorkingStyle(projects, modelA.model, modelB.model),
  }
}

export function renderCompareJson(report: CompareJsonReport): string {
  return JSON.stringify(report, null, 2)
}

const SELF_CORRECTION_PATTERNS = [
  /\bmy mistake\b/i,
  /\bmy bad\b/i,
  /\bmy apolog/i,
  /\bI apologize\b/i,
  /\bI was wrong\b/i,
  /\bI was incorrect\b/i,
  /\bI made (a |an )?(error|mistake)\b/i,
  /\bI incorrectly\b/i,
  /\bI mistakenly\b/i,
  /\bthat was (incorrect|wrong|an error)\b/i,
  /\blet me correct that\b/i,
  /\bI need to correct\b/i,
  /\byou're right[.,]? I/i,
  /\bsorry about that\b/i,
]

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: string; text: string } => b !== null && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join(' ')
}

function isCompactFile(name: string): boolean {
  return name.includes('compact')
}

async function collectJsonlFiles(sessionDir: string): Promise<string[]> {
  const entries = await readdir(sessionDir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.jsonl') && !isCompactFile(entry.name)) {
      files.push(join(sessionDir, entry.name))
    } else if (entry.isDirectory() && entry.name === 'subagents') {
      const subEntries = await readdir(join(sessionDir, entry.name), { withFileTypes: true })
      for (const sub of subEntries) {
        if (sub.isFile() && sub.name.endsWith('.jsonl') && !isCompactFile(sub.name)) {
          files.push(join(sessionDir, entry.name, sub.name))
        }
      }
    }
  }
  return files
}

/// Session ids of every session in `projects`. For Claude transcripts the id IS
/// the `.jsonl` stem, which is what lets a project-filtered compare scope the
/// self-correction scan to the sessions it actually reported on.
export function projectSessionIds(projects: readonly ProjectSummary[]): Set<string> {
  return new Set(projects.flatMap(p => p.sessions.map(s => s.sessionId)))
}

/// `sessionIds`, when given, restricts the scan to transcripts whose file stem
/// is one of them; omitted, every file under `projectDirs` is read as before.
export async function scanSelfCorrections(projectDirs: string[], sessionIds?: ReadonlySet<string>): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  const seen = new Set<string>()

  for (const dir of projectDirs) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }

    const allFiles: string[] = []

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl') && !isCompactFile(entry.name)) {
        allFiles.push(join(dir, entry.name))
      } else if (entry.isDirectory()) {
        try {
          const sessionFiles = await collectJsonlFiles(join(dir, entry.name))
          allFiles.push(...sessionFiles)
        } catch {
          continue
        }
      }
    }

    for (const file of allFiles) {
      if (sessionIds && !sessionIds.has(basename(file, '.jsonl'))) continue
      let raw: string
      try {
        raw = await readFile(file, 'utf8')
      } catch {
        continue
      }

      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue

        let parsed: unknown
        try {
          parsed = JSON.parse(trimmed)
        } catch {
          continue
        }

        const rec = parsed as Record<string, unknown>
        if (!rec || typeof rec !== 'object' || rec['type'] !== 'assistant') continue

        const ts = rec['timestamp']
        const msg = rec['message']
        if (msg === null || typeof msg !== 'object') continue

        const msgRec = msg as Record<string, unknown>
        const model = msgRec['model']
        if (typeof model !== 'string' || model === '<synthetic>') continue

        const dedupeKey = `${model}:${ts}`
        if (seen.has(dedupeKey)) continue
        seen.add(dedupeKey)

        const text = extractText(msgRec['content'])
        if (SELF_CORRECTION_PATTERNS.some(p => p.test(text))) {
          counts.set(model, (counts.get(model) ?? 0) + 1)
        }
      }
    }
  }

  return counts
}

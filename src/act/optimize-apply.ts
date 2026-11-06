import { createInterface } from 'node:readline/promises'
import { homedir } from 'os'
import chalk from 'chalk'
import type { DateRange, ProjectSummary } from '../types.js'
import { findingUSD, scanAndDetect, type WasteFinding } from '../optimize.js'
import { formatCost } from '../currency.js'
import { formatTokens } from '../format.js'
import { runAction } from './apply.js'
import { sha256File } from './backup.js'
import { shortId } from './journal.js'
import { REPORT_MIN_AGE_DAYS, type ActionPlan } from './types.js'
import { planFindings, type FindingPlan, type PlanContext } from './plans.js'

export type ApplyOptions = {
  yes?: boolean
  dryRun?: boolean
  only?: string
  // Mirrors `optimize --provider`. The scan below only reads Claude
  // transcripts, and this path does not just report findings, it plans and
  // applies them - a Codex-scoped run must never offer to edit ~/.claude.
  provider?: string
  actionsDir?: string
  ctx?: PlanContext
  // Test seams: crafted findings skip the session scan; streams default to
  // the real stdio.
  findings?: WasteFinding[]
  costRate?: number
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
  errorOutput?: NodeJS.WritableStream
}

function short(p: string): string {
  const home = homedir()
  return p.startsWith(home) ? '~' + p.slice(home.length) : p
}

function changeLines(fp: FindingPlan): string[] {
  return fp.plan!.changes.map(c => {
    const base = c.op === 'move' ? `${short(c.path)} -> ${short(c.movedTo)}` : short(c.path)
    const note = fp.pathNotes?.[c.path]
    return note ? `${base} (${note})` : base
  })
}

function planTokensSaved(fp: FindingPlan): number {
  if (fp.plan?.mcpSavingsUncertain) return Number.NaN
  const byServer = fp.finding.applyTokensSavedByServer
  const affected = fp.plan?.affectedMcpServers
  if (byServer && affected) return affected.reduce((sum, server) => sum + (byServer[server] ?? 0), 0)
  return fp.finding.applyTokensSaved ?? fp.finding.tokensSaved
}

function manualActionLines(fp: FindingPlan): string[] {
  if (fp.finding.manualFollowUp) {
    return [fp.finding.manualFollowUp.label, fp.finding.manualFollowUp.text]
  }
  const action = fp.finding.fix
  if (action.type === 'paste' && action.destination === 'manual') {
    return [action.label, action.text]
  }
  return []
}

export function renderApplyList(appliable: FindingPlan[], manual: FindingPlan[], costRate: number): string {
  const lines: string[] = ['']
  lines.push(chalk.bold('  Appliable config-class fixes:'))
  appliable.forEach((fp, i) => {
    const f = fp.finding
    const actionTokensSaved = planTokensSaved(fp)
    const savings = Number.isFinite(actionTokensSaved)
      ? `~${formatTokens(actionTokensSaved)} tokens${costRate > 0 ? `, ~${formatCost(findingUSD(f, costRate, actionTokensSaved))}` : ''}`
      : 'Savings not estimated'
    lines.push('')
    lines.push(`  ${i + 1}. ${f.title}  ${chalk.hex('#FFD700')(`(${savings})`)}`)
    if (fp.plan?.affectedMcpServers?.length) {
      const servers = fp.plan.affectedMcpServers.join(', ')
      lines.push(chalk.yellow(`       Removes local MCP server${fp.plan.affectedMcpServers.length === 1 ? '' : 's'}: ${servers}`))
    }
    for (const line of changeLines(fp)) lines.push(chalk.dim(`       ${line}`))
    for (const note of fp.notes) lines.push(chalk.yellow(`       ! ${note}`))
    const manualLines = manualActionLines(fp)
    if (manualLines.length > 0) {
      lines.push(chalk.cyan('       Manual follow-up (not applied):'))
      for (const line of manualLines) lines.push(chalk.cyan(`         ${line}`))
    }
  })
  if (manual.length > 0) {
    lines.push('')
    lines.push(chalk.dim('  Not auto-appliable (apply by hand):'))
    for (const fp of manual) {
      lines.push(chalk.dim(`    - ${fp.finding.title}  [${fp.finding.id}]  manual`))
      for (const note of fp.notes) lines.push(chalk.yellow(`        ! ${note}`))
      for (const line of manualActionLines(fp)) lines.push(chalk.cyan(`        ${line}`))
    }
  }
  lines.push('')
  return lines.join('\n')
}

function selectPlans(answer: string, appliable: FindingPlan[]): FindingPlan[] {
  const a = answer.trim().toLowerCase()
  if (a === 'a' || a === 'all' || a === 'y' || a === 'yes') return appliable
  if (a === '' || a === 'q' || a === 'quit' || a === 'n' || a === 'no') return []
  const picked: FindingPlan[] = []
  for (const token of a.split(/[\s,]+/)) {
    const n = Number.parseInt(token, 10)
    if (Number.isInteger(n) && n >= 1 && n <= appliable.length && !picked.includes(appliable[n - 1]!)) {
      picked.push(appliable[n - 1]!)
    }
  }
  return picked
}

async function ask(question: string, input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<string> {
  const rl = createInterface({ input, output })
  try {
    // EOF (piped stdin) closes the interface with the question pending;
    // treat it as "quit" instead of hanging or dying silently. The close
    // fallback is deferred one tick so an answer that arrived together with
    // EOF still wins the race.
    return await new Promise<string>(resolve => {
      rl.question(question).then(resolve, () => resolve(''))
      rl.once('close', () => setImmediate(() => resolve('')))
    })
  } finally {
    rl.close()
  }
}

// Rebuild a plan only when an earlier fix in this run rewrote one of its files
// and nothing else changed them; any other change keeps the original plan, so
// runAction's stale-plan guard rejects it.
async function planForApply(fp: FindingPlan, written: Map<string, string>, ctx: PlanContext | undefined): Promise<ActionPlan> {
  const original = fp.plan!
  let rewritten = false
  for (const c of original.changes) {
    if (c.op === 'move' || c.expectedHash === undefined) continue
    const current = await sha256File(c.path)
    if (current === c.expectedHash) continue
    if (current !== null && written.get(c.path) === current) rewritten = true
    else return original
  }
  if (!rewritten) return original
  const plan = planFindings([fp.finding], ctx)[0]!.plan ?? original
  if (original.baseline) plan.baseline = original.baseline
  return plan
}

export async function runOptimizeApply(
  projects: ProjectSummary[],
  dateRange: DateRange | undefined,
  opts: ApplyOptions = {},
): Promise<void> {
  const output = opts.output ?? process.stdout
  const errout = opts.errorOutput ?? process.stderr
  const print = (line = ''): void => { output.write(line + '\n') }

  let findings = opts.findings
  let costRate = opts.costRate ?? 0
  if (!findings) {
    errout.write(chalk.dim('  Analyzing your sessions...\n'))
    const scanned = await scanAndDetect(projects, dateRange, opts.provider)
    findings = scanned.findings
    costRate = scanned.costRate
  }
  const plans = planFindings(findings, opts.ctx)

  let appliable = plans.filter(p => p.plan !== null)
  const manual = plans.filter(p => p.plan === null)

  const onlyIds = opts.only ? opts.only.split(',').map(s => s.trim()).filter(Boolean) : []
  if (onlyIds.length > 0) {
    const valid = new Set<string>(appliable.map(p => p.finding.id))
    const bad = onlyIds.filter(id => !valid.has(id))
    if (bad.length > 0) {
      const validList = valid.size > 0 ? [...valid].join(', ') : '(none)'
      errout.write(`codeburn optimize --apply: unknown or not-appliable finding id${bad.length === 1 ? '' : 's'}: ${bad.join(', ')}. Appliable ids for this run: ${validList}\n`)
      process.exitCode = 2
      return
    }
    appliable = appliable.filter(p => onlyIds.includes(p.finding.id))
  }

  if (appliable.length === 0) {
    print(chalk.dim('\n  No appliable config-class fixes for this period.'))
    for (const fp of manual) {
      for (const note of fp.notes) print(chalk.yellow(`  ! ${fp.finding.id}: ${note}`))
      for (const line of manualActionLines(fp)) print(chalk.cyan(`  ${line}`))
    }
    print()
    return
  }

  print(renderApplyList(appliable, manual, costRate))

  if (opts.dryRun) {
    print(chalk.dim('  Dry run: nothing was changed.\n'))
    return
  }

  let selected: FindingPlan[]
  if (opts.yes) {
    // CLAUDE.md rules land in the cwd's file; blanket --yes from an unrelated
    // directory would write advice into the wrong project. They need the
    // interactive picker or an explicit --only selection.
    const explicit = new Set(onlyIds)
    const skipped = appliable.filter(fp => fp.plan!.kind === 'claude-md-rule' && !explicit.has(fp.finding.id))
    selected = appliable.filter(fp => !skipped.includes(fp))
    for (const fp of skipped) {
      print(chalk.yellow(`  Skipped ${fp.finding.id}: CLAUDE.md edits are not applied with --yes; use the interactive picker or --only ${fp.finding.id}.`))
    }
  } else {
    const answer = await ask('  Apply all / pick numbers / quit  [a / 1 2 3 / q]: ', opts.input ?? process.stdin, output)
    selected = selectPlans(answer, appliable)
  }

  if (selected.length === 0) {
    print(chalk.dim('  Nothing applied.\n'))
    return
  }

  // Stamp a trailing-14-day before-baseline onto each plan so runAction
  // persists it and `act report` can measure realized savings later. Best
  // effort: a scan failure leaves the baseline absent (reported "not
  // measurable"), never blocking the apply.
  try {
    const { captureBaselinesForPlans } = await import('./report.js')
    await captureBaselinesForPlans(selected)
  } catch { /* baseline is optional; apply proceeds without it */ }

  print()
  let applied = 0
  const written = new Map<string, string>()
  for (const fp of selected) {
    try {
      const record = await runAction(await planForApply(fp, written, opts.ctx), opts.actionsDir)
      for (const change of record.changes) if (change.op !== 'move') written.set(change.path, change.afterHash)
      applied++
      print(`  Applied ${chalk.bold(shortId(record.id))}  ${record.description}`)
      print(chalk.dim(`    Undo anytime: codeburn act undo ${shortId(record.id)}`))
      const manualLines = manualActionLines(fp)
      if (manualLines.length > 0) {
        print(chalk.cyan('    Still requires manual action:'))
        for (const line of manualLines) print(chalk.cyan(`      ${line}`))
      }
    } catch (e) {
      errout.write(chalk.red(`  Failed to apply ${fp.finding.id}: ${e instanceof Error ? e.message : String(e)}`) + '\n')
      process.exitCode = 1
    }
  }
  if (applied > 0) {
    print(chalk.dim(`  CodeBurn will re-measure these on your next optimize run after ${REPORT_MIN_AGE_DAYS} days.`))
  }
  print()
}

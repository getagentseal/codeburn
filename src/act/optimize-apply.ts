import { createInterface } from 'node:readline/promises'
import { homedir } from 'os'
import chalk from 'chalk'
import type { DateRange, ProjectSummary } from '../types.js'
import { scanAndDetect, type WasteFinding } from '../optimize.js'
import { formatCost } from '../currency.js'
import { formatTokens } from '../format.js'
import { runAction } from './apply.js'
import { shortId } from './journal.js'
import { planFindings, type FindingPlan, type PlanContext } from './plans.js'

export type ApplyOptions = {
  yes?: boolean
  dryRun?: boolean
  only?: string
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

export function renderApplyList(appliable: FindingPlan[], manual: FindingPlan[], costRate: number): string {
  const lines: string[] = ['']
  lines.push(chalk.bold('  Appliable config-class fixes:'))
  appliable.forEach((fp, i) => {
    const f = fp.finding
    const savings = `~${formatTokens(f.tokensSaved)} tokens${costRate > 0 ? `, ~${formatCost(f.tokensSaved * costRate)}` : ''}`
    lines.push('')
    lines.push(`  ${i + 1}. ${f.title}  ${chalk.hex('#FFD700')(`(${savings})`)}`)
    for (const line of changeLines(fp)) lines.push(chalk.dim(`       ${line}`))
    for (const note of fp.notes) lines.push(chalk.yellow(`       ! ${note}`))
  })
  if (manual.length > 0) {
    lines.push('')
    lines.push(chalk.dim('  Not auto-appliable (apply by hand):'))
    for (const fp of manual) {
      lines.push(chalk.dim(`    - ${fp.finding.title}  [${fp.finding.id}]  manual`))
      for (const note of fp.notes) lines.push(chalk.yellow(`        ! ${note}`))
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
    const scanned = await scanAndDetect(projects, dateRange)
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
  for (const fp of selected) {
    try {
      const record = await runAction(fp.plan!, opts.actionsDir)
      print(`  Applied ${chalk.bold(shortId(record.id))}  ${record.description}`)
      print(chalk.dim(`    Undo anytime: codeburn act undo ${shortId(record.id)}`))
    } catch (e) {
      errout.write(chalk.red(`  Failed to apply ${fp.finding.id}: ${e instanceof Error ? e.message : String(e)}`) + '\n')
      process.exitCode = 1
    }
  }
  print()
}

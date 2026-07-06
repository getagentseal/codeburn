import type { Command } from 'commander'
import { renderTable } from '../text-table.js'
import { defaultActionsDir, readRecords, shortId } from './journal.js'
import { DriftError, undoAction } from './undo.js'
import { buildActReportJson, computeActReport, renderActReport } from './report.js'

function formatWhen(at: string): string {
  return at.replace('T', ' ').slice(0, 16)
}

export function registerActCommands(program: Command): void {
  const act = program
    .command('act')
    .description('Review and undo changes codeburn has applied')

  act
    .command('list')
    .description('List applied actions, newest first')
    .option('--json', 'Output the full records as JSON')
    .action(async (opts: { json?: boolean }) => {
      try {
        const records = (await readRecords(defaultActionsDir())).reverse()
        if (opts.json) {
          console.log(JSON.stringify(records, null, 2))
          return
        }
        if (records.length === 0) {
          console.log('No actions recorded yet.')
          return
        }
        const rows = records.map(r => [shortId(r.id), formatWhen(r.at), r.description, r.status])
        console.log(renderTable(
          [{ header: 'ID' }, { header: 'When' }, { header: 'Description' }, { header: 'Status' }],
          rows,
        ))
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err))
        process.exitCode = 1
      }
    })

  act
    .command('undo [id]')
    .description('Undo an action by id (8-char prefix accepted), or the most recent with --last')
    .option('--last', 'Undo the most recent action')
    .option('--force', 'Undo even if the target files changed since they were applied')
    .action(async (id: string | undefined, opts: { last?: boolean; force?: boolean }) => {
      if (!id && !opts.last) {
        console.error('Specify an action id or --last.')
        process.exitCode = 1
        return
      }
      try {
        const record = await undoAction(opts.last ? { last: true } : { id: id! }, { force: opts.force })
        console.log(`Undid ${shortId(record.id)}: ${record.description}`)
      } catch (err) {
        if (err instanceof DriftError) {
          console.error(err.message + ':')
          for (const f of err.drifted) console.error(`  ${f}`)
          console.error('Re-run with --force to undo anyway.')
        } else {
          console.error(err instanceof Error ? err.message : String(err))
        }
        process.exitCode = 1
      }
    })

  act
    .command('report')
    .description('Realized vs estimated savings for applied actions older than 3 days')
    .option('--json', 'Output the realized report as JSON')
    .action(async (opts: { json?: boolean }) => {
      try {
        const report = await computeActReport()
        if (opts.json) {
          console.log(JSON.stringify(buildActReportJson(report), null, 2))
          return
        }
        console.log(renderActReport(report))
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err))
        process.exitCode = 1
      }
    })
}

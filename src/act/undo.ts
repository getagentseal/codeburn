import type { ActionRecord, FileChange } from './types.js'
import { appendRecord, defaultActionsDir, readRecords, shortId, withLock } from './journal.js'
import { revertChange, sha256File } from './backup.js'

export class DriftError extends Error {
  constructor(public record: ActionRecord, public drifted: string[]) {
    super(`Refusing to undo ${shortId(record.id)}: ${drifted.length} file(s) changed since they were applied`)
    this.name = 'DriftError'
  }
}

export function findRecord(records: ActionRecord[], idOrPrefix: string): ActionRecord | undefined {
  const exact = records.find(r => r.id === idOrPrefix)
  if (exact) return exact
  const matches = records.filter(r => r.id.startsWith(idOrPrefix))
  return matches.length === 1 ? matches[0] : undefined
}

// A move leaves the bytes at movedTo, so that is the path to hash for drift.
function currentPath(change: FileChange): string {
  return change.op === 'move' ? change.movedTo! : change.path
}

async function driftedFiles(record: ActionRecord): Promise<string[]> {
  const drifted: string[] = []
  for (const change of record.changes) {
    const p = currentPath(change)
    if ((await sha256File(p)) !== change.afterHash) drifted.push(p)
  }
  return drifted
}

export type UndoSelector = { id: string } | { last: true }

export async function undoAction(
  selector: UndoSelector,
  opts: { actionsDir?: string; force?: boolean } = {},
): Promise<ActionRecord> {
  const actionsDir = opts.actionsDir ?? defaultActionsDir()
  return withLock(actionsDir, async () => {
    const records = await readRecords(actionsDir)
    const record = 'last' in selector ? records[records.length - 1] : findRecord(records, selector.id)
    if (!record) {
      throw new Error('last' in selector ? 'No actions to undo.' : `No action matches "${selector.id}".`)
    }
    if (record.status === 'undone') {
      throw new Error(`Action ${shortId(record.id)} is already undone.`)
    }
    if (!opts.force) {
      const drifted = await driftedFiles(record)
      if (drifted.length > 0) throw new DriftError(record, drifted)
    }
    for (let i = record.changes.length - 1; i >= 0; i--) {
      await revertChange(actionsDir, record.changes[i]!)
    }
    const undone: ActionRecord = { ...record, status: 'undone', undoneAt: new Date().toISOString() }
    await appendRecord(actionsDir, undone)
    return undone
  })
}

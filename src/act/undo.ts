import type { ActionRecord, FileChange } from './types.js'
import { appendRecord, defaultActionsDir, readRecords, shortId, withLock } from './journal.js'
import { pathExists, revertChange, sha256File } from './backup.js'

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
  if (matches.length > 1) {
    throw new Error(`"${idOrPrefix}" matches ${matches.length} actions; use more characters.`)
  }
  return matches[0]
}

// A move leaves the bytes at movedTo, so that is the path to hash for drift.
function currentPath(change: FileChange): string {
  return change.op === 'move' ? change.movedTo! : change.path
}

async function driftedFiles(record: ActionRecord): Promise<string[]> {
  const drifted: string[] = []
  for (const change of record.changes) {
    // Undo of a move renames back onto the original path; refuse if something
    // now occupies it rather than silently overwriting.
    if (change.op === 'move' && await pathExists(change.path)) {
      drifted.push(`${change.path} (occupied, undo would overwrite it)`)
    }
    if (change.afterHash === '') continue // no content hash (directories)
    const p = currentPath(change)
    try {
      if ((await sha256File(p)) !== change.afterHash) drifted.push(p)
    } catch (err) {
      drifted.push(`${p} (unreadable: ${(err as NodeJS.ErrnoException).code ?? 'unknown'})`)
    }
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
    let record: ActionRecord | undefined
    if ('last' in selector) {
      record = records.filter(r => r.status === 'applied').at(-1)
      if (!record) throw new Error('Nothing to undo.')
    } else {
      record = findRecord(records, selector.id)
      if (!record) throw new Error(`No action matches "${selector.id}".`)
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

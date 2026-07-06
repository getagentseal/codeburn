import { lstat, mkdir, rename, rm, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import type { ActionPlan, ActionRecord, FileChange } from './types.js'
import { appendRecord, defaultActionsDir, withLock } from './journal.js'
import { backupDirFor, relBackupPath, revertChange, sha256File, snapshotFile } from './backup.js'

// The only mutation path. Order: back up every file the plan touches, apply
// the mutations, hash the results, then journal. If a mutation or the journal
// append throws, the steps already applied are rolled back (newest first) and
// nothing is journaled.
export async function runAction(plan: ActionPlan, actionsDir: string = defaultActionsDir()): Promise<ActionRecord> {
  return withLock(actionsDir, async () => {
    const id = randomUUID()
    const at = new Date().toISOString()
    const backupDir = backupDirFor(actionsDir, id)
    await mkdir(backupDir, { recursive: true })

    // One snapshot per unique path (first occurrence wins), so a path touched
    // twice still reverts to its true pre-action bytes.
    const snapshots = new Map<string, string | null>()
    let n = 0
    const snapshot = async (p: string): Promise<string | null> => {
      if (!snapshots.has(p)) {
        const existed = await snapshotFile(p, join(backupDir, `${n}.bak`))
        snapshots.set(p, existed ? relBackupPath(id, n++) : null)
      }
      return snapshots.get(p)!
    }

    const changes: FileChange[] = []
    for (const pc of plan.changes) {
      changes.push({
        path: pc.path,
        backup: await snapshot(pc.path),
        op: pc.op,
        ...(pc.op === 'move' ? { movedTo: pc.movedTo, destBackup: await snapshot(pc.movedTo) } : {}),
        afterHash: '',
      })
    }

    const done: number[] = []
    try {
      // Stale-plan guard: plans carry full post-edit content computed at
      // build time, so refuse if a target changed between preview and
      // confirm. Runs before any mutation; failure needs no rollback (the
      // catch below only removes the backup dir).
      for (const pc of plan.changes) {
        if (pc.op === 'move' || pc.expectedHash === undefined) continue
        if ((await sha256File(pc.path)) !== pc.expectedHash) {
          throw new Error(`${pc.path} changed since the plan was built; re-run codeburn optimize --apply`)
        }
      }
      for (let i = 0; i < plan.changes.length; i++) {
        const pc = plan.changes[i]!
        if (pc.op === 'move') {
          await mkdir(dirname(pc.movedTo), { recursive: true })
          try {
            await rename(pc.path, pc.movedTo)
          } catch (err) {
            // rename cannot replace a directory destination. It is already
            // snapshotted (destBackup), so clear it and retry. Other codes
            // (e.g. a missing source) rethrow before any destination damage.
            const code = (err as NodeJS.ErrnoException).code
            if (code !== 'ENOTEMPTY' && code !== 'EEXIST' && code !== 'EISDIR' && code !== 'ENOTDIR') throw err
            await rm(pc.movedTo, { recursive: true, force: true })
            await rename(pc.path, pc.movedTo)
          }
        } else {
          await mkdir(dirname(pc.path), { recursive: true })
          await writeFile(pc.path, pc.content)
        }
        done.push(i)
      }
      // Hash after ALL mutations so overlapping changes carry the final state.
      // Directories get '' (no content hash); drift detection skips them.
      for (const change of changes) {
        const p = change.op === 'move' ? change.movedTo! : change.path
        const st = await lstat(p).catch(() => null)
        change.afterHash = st && !st.isDirectory() ? (await sha256File(p)) ?? '' : ''
      }
      const record: ActionRecord = {
        id,
        at,
        kind: plan.kind,
        findingId: plan.findingId ?? null,
        description: plan.description,
        changes,
        status: 'applied',
        ...(plan.baseline ? { baseline: plan.baseline } : {}),
      }
      await appendRecord(actionsDir, record)
      return record
    } catch (err) {
      for (const i of done.reverse()) await revertChange(actionsDir, changes[i]!)
      await rm(backupDir, { recursive: true, force: true })
      throw err
    }
  })
}

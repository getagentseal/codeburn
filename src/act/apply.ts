import { mkdir, rename, rm, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import type { ActionPlan, ActionRecord, FileChange } from './types.js'
import { appendRecord, defaultActionsDir, withLock } from './journal.js'
import { backupDirFor, relBackupPath, revertChange, sha256File, snapshotFile } from './backup.js'

// The only mutation path. Order: back up every planned file, apply the
// mutations, then journal. A mutation that throws mid-way rolls back the
// steps already applied and journals nothing.
export async function runAction(plan: ActionPlan, actionsDir: string = defaultActionsDir()): Promise<ActionRecord> {
  return withLock(actionsDir, async () => {
    const id = randomUUID()
    const at = new Date().toISOString()
    const backupDir = backupDirFor(actionsDir, id)
    await mkdir(backupDir, { recursive: true })

    const changes: FileChange[] = []
    for (let i = 0; i < plan.changes.length; i++) {
      const pc = plan.changes[i]!
      const existed = await snapshotFile(pc.path, join(backupDir, `${i}.bak`))
      changes.push({
        path: pc.path,
        backup: existed ? relBackupPath(id, i) : null,
        op: pc.op,
        ...(pc.op === 'move' ? { movedTo: pc.movedTo } : {}),
        afterHash: '',
      })
    }

    const done: number[] = []
    try {
      for (let i = 0; i < plan.changes.length; i++) {
        const pc = plan.changes[i]!
        if (pc.op === 'move') {
          await mkdir(dirname(pc.movedTo), { recursive: true })
          await rename(pc.path, pc.movedTo)
        } else {
          await mkdir(dirname(pc.path), { recursive: true })
          await writeFile(pc.path, pc.content)
        }
        done.push(i)
        const resultPath = pc.op === 'move' ? pc.movedTo : pc.path
        changes[i]!.afterHash = (await sha256File(resultPath)) ?? ''
      }
    } catch (err) {
      for (const i of done.reverse()) await revertChange(actionsDir, changes[i]!)
      await rm(backupDir, { recursive: true, force: true })
      throw err
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
  })
}

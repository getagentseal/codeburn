import { copyFile, cp, lstat, mkdir, readFile, rename, rm } from 'fs/promises'
import { createHash } from 'crypto'
import { dirname, join } from 'path'
import type { FileChange } from './types.js'

export function backupDirFor(actionsDir: string, id: string): string {
  return join(actionsDir, 'backups', id)
}

export function relBackupPath(id: string, index: number): string {
  return `backups/${id}/${index}.bak`
}

// Snapshot src (file or directory tree) to dest if it exists; return whether
// it existed so the caller can record backup: null for a create.
export async function snapshotFile(src: string, dest: string): Promise<boolean> {
  try {
    const st = await lstat(src)
    if (st.isDirectory()) await cp(src, dest, { recursive: true })
    else await copyFile(src, dest)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

export async function sha256File(path: string): Promise<string | null> {
  try {
    return sha256(await readFile(path))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

// Reverse a single applied change. Shared by mid-apply rollback and undo.
// Non-move reverts key on backup presence, not the op label, so a create that
// overwrote an existing file and an edit of a missing file restore correctly.
export async function revertChange(actionsDir: string, change: FileChange): Promise<void> {
  const restore = async (backup: string, to: string): Promise<void> => {
    const src = join(actionsDir, backup)
    await mkdir(dirname(to), { recursive: true })
    if ((await lstat(src)).isDirectory()) {
      await rm(to, { recursive: true, force: true })
      await cp(src, to, { recursive: true })
    } else {
      await copyFile(src, to)
    }
  }
  if (change.op === 'move') {
    if (await pathExists(change.movedTo!)) {
      await rm(change.path, { recursive: true, force: true })
      await mkdir(dirname(change.path), { recursive: true })
      await rename(change.movedTo!, change.path)
      if (change.destBackup) await restore(change.destBackup, change.movedTo!)
    } else if (change.backup) {
      // The moved file is gone; fall back to the source snapshot.
      await restore(change.backup, change.path)
    }
    return
  }
  if (change.backup) await restore(change.backup, change.path)
  else await rm(change.path, { recursive: true, force: true })
}

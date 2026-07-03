import { copyFile, mkdir, readFile, rename, rm } from 'fs/promises'
import { createHash } from 'crypto'
import { dirname, join } from 'path'
import type { FileChange } from './types.js'

export function backupDirFor(actionsDir: string, id: string): string {
  return join(actionsDir, 'backups', id)
}

export function relBackupPath(id: string, index: number): string {
  return `backups/${id}/${index}.bak`
}

// Copy src to dest if src exists; return whether it existed so the caller can
// record backup: null for a create.
export async function snapshotFile(src: string, dest: string): Promise<boolean> {
  try {
    await copyFile(src, dest)
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

// Reverse a single applied change. Shared by mid-apply rollback and undo.
export async function revertChange(actionsDir: string, change: FileChange): Promise<void> {
  if (change.op === 'create') {
    await rm(change.path, { force: true })
    return
  }
  if (change.op === 'move') {
    await mkdir(dirname(change.path), { recursive: true })
    await rename(change.movedTo!, change.path)
    return
  }
  if (change.backup) {
    await mkdir(dirname(change.path), { recursive: true })
    await copyFile(join(actionsDir, change.backup), change.path)
  }
}

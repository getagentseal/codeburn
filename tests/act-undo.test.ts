import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAction } from '../src/act/apply.js'
import { readRecords } from '../src/act/journal.js'
import { DriftError, undoAction } from '../src/act/undo.js'

const roots: string[] = []

async function makeRoot(): Promise<{ actionsDir: string; files: string }> {
  const root = await mkdtemp(join(tmpdir(), 'codeburn-act-undo-'))
  roots.push(root)
  const files = join(root, 'files')
  await mkdir(files, { recursive: true })
  return { actionsDir: join(root, 'actions'), files }
}

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

describe('undoAction', () => {
  it('restores byte-identical content for edit, create, and move, then refuses a second undo', async () => {
    const { actionsDir, files } = await makeRoot()
    const editPath = join(files, 'edit.bin')
    const createPath = join(files, 'created.bin')
    const movePath = join(files, 'move.bin')
    const moveDest = join(files, 'sub', 'move.bin')
    const editOriginal = Buffer.from([0, 1, 2, 3, 255, 254])
    const moveOriginal = Buffer.from([10, 20, 30, 40])
    await writeFile(editPath, editOriginal)
    await writeFile(movePath, moveOriginal)

    const rec = await runAction({
      kind: 'archive-skill',
      description: 'undo test',
      changes: [
        { op: 'edit', path: editPath, content: Buffer.from([9, 9, 9]) },
        { op: 'create', path: createPath, content: Buffer.from([7, 7]) },
        { op: 'move', path: movePath, movedTo: moveDest },
      ],
    }, actionsDir)

    // 8-char prefix is accepted
    await undoAction({ id: rec.id.slice(0, 8) }, { actionsDir })

    expect(Buffer.compare(await readFile(editPath), editOriginal)).toBe(0)
    expect(existsSync(createPath)).toBe(false)
    expect(existsSync(moveDest)).toBe(false)
    expect(Buffer.compare(await readFile(movePath), moveOriginal)).toBe(0)

    const records = await readRecords(actionsDir)
    expect(records).toHaveLength(1)
    expect(records[0]!.status).toBe('undone')
    expect(records[0]!.undoneAt).toBeTruthy()

    await expect(undoAction({ id: rec.id }, { actionsDir })).rejects.toThrow(/already undone/)
  })

  it('undoes the most recent action with --last and leaves earlier actions applied', async () => {
    const { actionsDir, files } = await makeRoot()
    const first = join(files, 'first.txt')
    const second = join(files, 'second.txt')
    await writeFile(first, 'first-old')
    await writeFile(second, 'second-old')

    const recFirst = await runAction({
      kind: 'claude-md-rule', description: 'first', changes: [{ op: 'edit', path: first, content: 'first-new' }],
    }, actionsDir)
    await runAction({
      kind: 'claude-md-rule', description: 'second', changes: [{ op: 'edit', path: second, content: 'second-new' }],
    }, actionsDir)

    const undone = await undoAction({ last: true }, { actionsDir })
    expect(undone.description).toBe('second')
    expect(await readFile(second, 'utf-8')).toBe('second-old')
    expect(await readFile(first, 'utf-8')).toBe('first-new')

    const records = await readRecords(actionsDir)
    expect(records.find(r => r.id === recFirst.id)!.status).toBe('applied')
  })

  it('refuses to undo a drifted file, but --force proceeds', async () => {
    const { actionsDir, files } = await makeRoot()
    const p = join(files, 'drift.txt')
    await writeFile(p, 'original')
    const rec = await runAction({
      kind: 'claude-md-rule', description: 'drift', changes: [{ op: 'edit', path: p, content: 'applied' }],
    }, actionsDir)

    await writeFile(p, 'user-modified')

    await expect(undoAction({ id: rec.id }, { actionsDir })).rejects.toBeInstanceOf(DriftError)
    expect((await readRecords(actionsDir))[0]!.status).toBe('applied')
    expect(await readFile(p, 'utf-8')).toBe('user-modified')

    await undoAction({ id: rec.id }, { actionsDir, force: true })
    expect(await readFile(p, 'utf-8')).toBe('original')
    expect((await readRecords(actionsDir))[0]!.status).toBe('undone')
  })
})

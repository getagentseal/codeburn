import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAction } from '../src/act/apply.js'
import { appendRecord, readRecords } from '../src/act/journal.js'
import { DriftError, undoAction } from '../src/act/undo.js'
import type { ActionRecord } from '../src/act/types.js'

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

  it('reverts changes newest-first so overlapping changes restore the original state', async () => {
    const { actionsDir, files } = await makeRoot()
    const src = join(files, 'a.txt')
    const dest = join(files, 'b.txt')
    await writeFile(src, 'orig')

    const rec = await runAction({
      kind: 'shell-config',
      description: 'move then edit',
      changes: [
        { op: 'move', path: src, movedTo: dest },
        { op: 'edit', path: dest, content: 'edited' },
      ],
    }, actionsDir)

    await undoAction({ id: rec.id }, { actionsDir })
    expect(await readFile(src, 'utf-8')).toBe('orig')
    expect(existsSync(dest)).toBe(false)
  })

  it('refuses to undo a move when the original path is occupied, then --force overwrites', async () => {
    const { actionsDir, files } = await makeRoot()
    const src = join(files, 'a.txt')
    const dest = join(files, 'b.txt')
    await writeFile(src, 'moved-bytes')
    const rec = await runAction({
      kind: 'archive-skill', description: 'occupied', changes: [{ op: 'move', path: src, movedTo: dest }],
    }, actionsDir)

    await writeFile(src, 'squatter')

    const err = await undoAction({ id: rec.id }, { actionsDir }).catch(e => e)
    expect(err).toBeInstanceOf(DriftError)
    expect((err as DriftError).drifted.some(d => d.includes(src))).toBe(true)

    await undoAction({ id: rec.id }, { actionsDir, force: true })
    expect(await readFile(src, 'utf-8')).toBe('moved-bytes')
    expect(existsSync(dest)).toBe(false)
  })

  it('snapshots an existing move destination and restores both files on undo', async () => {
    const { actionsDir, files } = await makeRoot()
    const src = join(files, 'a.txt')
    const dest = join(files, 'b.txt')
    await writeFile(src, 'src-bytes')
    await writeFile(dest, 'dest-bytes')

    const rec = await runAction({
      kind: 'archive-agent', description: 'move onto dest', changes: [{ op: 'move', path: src, movedTo: dest }],
    }, actionsDir)
    expect(rec.changes[0]!.destBackup).not.toBeNull()
    expect(await readFile(dest, 'utf-8')).toBe('src-bytes')
    expect(await readFile(join(actionsDir, rec.changes[0]!.destBackup!), 'utf-8')).toBe('dest-bytes')

    await undoAction({ id: rec.id }, { actionsDir })
    expect(await readFile(src, 'utf-8')).toBe('src-bytes')
    expect(await readFile(dest, 'utf-8')).toBe('dest-bytes')
  })

  it('force-undo of a move whose moved file is gone restores from backup and flips status', async () => {
    const { actionsDir, files } = await makeRoot()
    const src = join(files, 'a.txt')
    const dest = join(files, 'b.txt')
    await writeFile(src, 'precious')
    const rec = await runAction({
      kind: 'archive-command', description: 'gone', changes: [{ op: 'move', path: src, movedTo: dest }],
    }, actionsDir)

    await rm(dest)

    await expect(undoAction({ id: rec.id }, { actionsDir })).rejects.toBeInstanceOf(DriftError)
    const undone = await undoAction({ id: rec.id }, { actionsDir, force: true })
    expect(undone.status).toBe('undone')
    expect(await readFile(src, 'utf-8')).toBe('precious')
  })

  it('undoing a create that overwrote an existing file restores the prior bytes', async () => {
    const { actionsDir, files } = await makeRoot()
    const p = join(files, 'exists.txt')
    await writeFile(p, 'prior')

    const rec = await runAction({
      kind: 'guard-install', description: 'create over existing', changes: [{ op: 'create', path: p, content: 'new' }],
    }, actionsDir)
    expect(rec.changes[0]!.backup).not.toBeNull()

    await undoAction({ id: rec.id }, { actionsDir })
    expect(await readFile(p, 'utf-8')).toBe('prior')
  })

  it('undoes a plan that touches the same path twice back to the original bytes', async () => {
    const { actionsDir, files } = await makeRoot()
    const p = join(files, 'twice.txt')
    await writeFile(p, 'v0')

    const rec = await runAction({
      kind: 'claude-md-rule',
      description: 'same path twice',
      changes: [
        { op: 'edit', path: p, content: 'v1' },
        { op: 'edit', path: p, content: 'v2' },
      ],
    }, actionsDir)
    expect(rec.changes[0]!.afterHash).toBe(rec.changes[1]!.afterHash)

    await undoAction({ id: rec.id }, { actionsDir })
    expect(await readFile(p, 'utf-8')).toBe('v0')
  })

  it('rejects an ambiguous id prefix with the match count', async () => {
    const { actionsDir } = await makeRoot()
    await appendRecord(actionsDir, bareRecord('aaaaaaaa-1111-4111-8111-111111111111', 'one'))
    await appendRecord(actionsDir, bareRecord('aaaaaaaa-2222-4222-8222-222222222222', 'two'))

    await expect(undoAction({ id: 'aaaaaaaa' }, { actionsDir })).rejects.toThrow(/matches 2 actions/)
  })

  it('archives a directory and undo restores the tree with nested content byte-identical', async () => {
    const { actionsDir, files } = await makeRoot()
    const dir = join(files, 'skill')
    const dest = join(files, '.archived', 'skill')
    const nestedBytes = Buffer.from([1, 2, 3, 250, 0])
    await mkdir(join(dir, 'nested'), { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), 'skill body')
    await writeFile(join(dir, 'nested', 'data.bin'), nestedBytes)

    const rec = await runAction({
      kind: 'archive-skill',
      description: 'archive dir',
      changes: [{ op: 'move', path: dir, movedTo: dest }],
    }, actionsDir)
    expect(rec.changes[0]!.afterHash).toBe('')
    expect(rec.changes[0]!.backup).not.toBeNull()
    expect(existsSync(dir)).toBe(false)
    expect(await readFile(join(dest, 'SKILL.md'), 'utf-8')).toBe('skill body')

    await undoAction({ id: rec.id }, { actionsDir })
    expect(existsSync(dest)).toBe(false)
    expect(await readFile(join(dir, 'SKILL.md'), 'utf-8')).toBe('skill body')
    expect(Buffer.compare(await readFile(join(dir, 'nested', 'data.bin')), nestedBytes)).toBe(0)
  })

  it('moves a directory onto an existing destination directory and undo restores both trees', async () => {
    const { actionsDir, files } = await makeRoot()
    const src = join(files, 'agent')
    const dest = join(files, 'agent-archived')
    await mkdir(src, { recursive: true })
    await mkdir(dest, { recursive: true })
    await writeFile(join(src, 'agent.md'), 'src tree')
    await writeFile(join(dest, 'old.md'), 'dest tree')

    const rec = await runAction({
      kind: 'archive-agent',
      description: 'dir onto dir',
      changes: [{ op: 'move', path: src, movedTo: dest }],
    }, actionsDir)
    expect(rec.changes[0]!.destBackup).not.toBeNull()
    expect(await readFile(join(dest, 'agent.md'), 'utf-8')).toBe('src tree')
    expect(existsSync(join(dest, 'old.md'))).toBe(false)

    await undoAction({ id: rec.id }, { actionsDir })
    expect(await readFile(join(src, 'agent.md'), 'utf-8')).toBe('src tree')
    expect(await readFile(join(dest, 'old.md'), 'utf-8')).toBe('dest tree')
    expect(existsSync(join(dest, 'agent.md'))).toBe(false)
  })

  it('refuses dir-move undo when the original path is occupied, then --force overwrites', async () => {
    const { actionsDir, files } = await makeRoot()
    const src = join(files, 'cmd')
    const dest = join(files, 'cmd-archived')
    await mkdir(src, { recursive: true })
    await writeFile(join(src, 'cmd.md'), 'body')
    const rec = await runAction({
      kind: 'archive-command',
      description: 'occupied dir',
      changes: [{ op: 'move', path: src, movedTo: dest }],
    }, actionsDir)

    await mkdir(src, { recursive: true })
    await writeFile(join(src, 'squatter.md'), 'squatter')

    const err = await undoAction({ id: rec.id }, { actionsDir }).catch(e => e)
    expect(err).toBeInstanceOf(DriftError)
    expect((err as DriftError).drifted.some(d => d.includes(src))).toBe(true)

    await undoAction({ id: rec.id }, { actionsDir, force: true })
    expect(await readFile(join(src, 'cmd.md'), 'utf-8')).toBe('body')
    expect(existsSync(join(src, 'squatter.md'))).toBe(false)
    expect(existsSync(dest)).toBe(false)
  })
})

function bareRecord(id: string, description: string): ActionRecord {
  return {
    id,
    at: new Date().toISOString(),
    kind: 'mcp-remove',
    findingId: null,
    description,
    changes: [],
    status: 'applied',
  }
}

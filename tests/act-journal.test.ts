import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAction } from '../src/act/apply.js'
import { journalPath, readRecords } from '../src/act/journal.js'
import { sha256 } from '../src/act/backup.js'
import type { ActionRecord } from '../src/act/types.js'

const roots: string[] = []

async function makeRoot(): Promise<{ actionsDir: string; files: string }> {
  const root = await mkdtemp(join(tmpdir(), 'codeburn-act-journal-'))
  roots.push(root)
  const files = join(root, 'files')
  await mkdir(files, { recursive: true })
  return { actionsDir: join(root, 'actions'), files }
}

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

describe('runAction journaling', () => {
  it('journals backups and afterHash for edit, create, and move ops', async () => {
    const { actionsDir, files } = await makeRoot()
    const editPath = join(files, 'edit.txt')
    const createPath = join(files, 'new.txt')
    const movePath = join(files, 'move.txt')
    const moveDest = join(files, 'archive', 'move.txt')
    await writeFile(editPath, 'old-edit')
    await writeFile(movePath, 'move-body')

    const rec = await runAction({
      kind: 'claude-md-rule',
      description: 'test action',
      changes: [
        { op: 'edit', path: editPath, content: 'new-edit' },
        { op: 'create', path: createPath, content: 'created' },
        { op: 'move', path: movePath, movedTo: moveDest },
      ],
    }, actionsDir)

    expect(rec.status).toBe('applied')
    expect(rec.findingId).toBeNull()
    expect(rec.changes).toHaveLength(3)
    const [edit, create, move] = rec.changes

    expect(edit!.backup).not.toBeNull()
    expect(await readFile(join(actionsDir, edit!.backup!), 'utf-8')).toBe('old-edit')
    expect(edit!.afterHash).toBe(sha256(Buffer.from('new-edit')))
    expect(await readFile(editPath, 'utf-8')).toBe('new-edit')

    expect(create!.backup).toBeNull()
    expect(create!.afterHash).toBe(sha256(Buffer.from('created')))
    expect(await readFile(createPath, 'utf-8')).toBe('created')

    expect(move!.backup).not.toBeNull()
    expect(await readFile(join(actionsDir, move!.backup!), 'utf-8')).toBe('move-body')
    expect(move!.movedTo).toBe(moveDest)
    expect(move!.afterHash).toBe(sha256(Buffer.from('move-body')))
    expect(await readFile(moveDest, 'utf-8')).toBe('move-body')
    expect(existsSync(movePath)).toBe(false)

    const records = await readRecords(actionsDir)
    expect(records).toHaveLength(1)
    expect(records[0]!.id).toBe(rec.id)
  })

  it('rolls back completed mutations and writes no record when a mutation fails', async () => {
    const { actionsDir, files } = await makeRoot()
    const editPath = join(files, 'edit.txt')
    await writeFile(editPath, 'original')
    const missingSrc = join(files, 'does-not-exist.txt')

    await expect(runAction({
      kind: 'shell-config',
      description: 'failing action',
      changes: [
        { op: 'edit', path: editPath, content: 'changed' },
        { op: 'move', path: missingSrc, movedTo: join(files, 'dest.txt') },
      ],
    }, actionsDir)).rejects.toThrow()

    expect(await readFile(editPath, 'utf-8')).toBe('original')
    expect(existsSync(journalPath(actionsDir))).toBe(false)
  })

  it('skips corrupt journal lines and still loads valid records', async () => {
    const { actionsDir } = await makeRoot()
    await mkdir(actionsDir, { recursive: true })
    const recA = sampleRecord('11111111-1111-1111-1111-111111111111', 'first')
    const recB = sampleRecord('22222222-2222-2222-2222-222222222222', 'second')
    await writeFile(
      journalPath(actionsDir),
      JSON.stringify(recA) + '\n' + '{ this is not json\n' + JSON.stringify(recB) + '\n',
    )

    const records = await readRecords(actionsDir)
    expect(records.map(r => r.id)).toEqual([recA.id, recB.id])
    expect(records.map(r => r.description)).toEqual(['first', 'second'])
  })

  it('round-trips a record through JSON (act list --json shape)', async () => {
    const { actionsDir, files } = await makeRoot()
    const p = join(files, 'f.txt')
    await writeFile(p, 'before')
    const rec = await runAction({
      kind: 'model-default',
      description: 'json shape',
      changes: [{ op: 'edit', path: p, content: 'after' }],
    }, actionsDir)

    const records = await readRecords(actionsDir)
    const roundTripped = JSON.parse(JSON.stringify(records)) as ActionRecord[]
    expect(roundTripped).toEqual(records)

    const only = roundTripped[0]!
    expect(only).toMatchObject({ id: rec.id, kind: 'model-default', description: 'json shape', status: 'applied' })
    expect(typeof only.at).toBe('string')
    expect(only.findingId).toBeNull()
    expect(only.changes[0]).toMatchObject({ path: p, op: 'edit' })
    expect(only.changes[0]!.backup).not.toBeNull()
    expect(typeof only.changes[0]!.afterHash).toBe('string')
  })
})

describe('action lock', () => {
  it('refuses to run while a fresh foreign lock is held', async () => {
    const { actionsDir, files } = await makeRoot()
    await mkdir(actionsDir, { recursive: true })
    await writeFile(join(actionsDir, '.lock'), '')
    const target = join(files, 'blocked.txt')

    await expect(runAction({
      kind: 'shell-config',
      description: 'blocked by lock',
      changes: [{ op: 'create', path: target, content: 'x' }],
    }, actionsDir)).rejects.toThrow(/in progress/)

    expect(existsSync(target)).toBe(false)
  })

  it('takes over a lock whose mtime is older than 60s', async () => {
    const { actionsDir, files } = await makeRoot()
    await mkdir(actionsDir, { recursive: true })
    const lock = join(actionsDir, '.lock')
    await writeFile(lock, JSON.stringify({ pid: 1, at: 0 }))
    const past = new Date(Date.now() - 61_000)
    await utimes(lock, past, past)
    const target = join(files, 'takeover.txt')

    const rec = await runAction({
      kind: 'shell-config',
      description: 'stale takeover',
      changes: [{ op: 'create', path: target, content: 'x' }],
    }, actionsDir)

    expect(rec.status).toBe('applied')
    expect(await readFile(target, 'utf-8')).toBe('x')
    expect(existsSync(lock)).toBe(false)
  })
})

describe('act list --json (CLI)', () => {
  it('prints full records as JSON, newest first', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-act-cli-'))
    roots.push(home)
    const actionsDir = join(home, '.config', 'codeburn', 'actions')
    const files = join(home, 'work')
    await mkdir(files, { recursive: true })
    const p1 = join(files, 'a.txt')
    const p2 = join(files, 'b.txt')
    await writeFile(p1, 'a')
    await writeFile(p2, 'b')
    const recOlder = await runAction({
      kind: 'mcp-remove', description: 'older', changes: [{ op: 'edit', path: p1, content: 'a2' }],
    }, actionsDir)
    const recNewer = await runAction({
      kind: 'mcp-remove', description: 'newer', changes: [{ op: 'edit', path: p2, content: 'b2' }],
    }, actionsDir)

    // Anchor the spawn to this checkout so running vitest from another cwd
    // cannot execute a different checkout's cli.ts.
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
    const res = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'act', 'list', '--json'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: home, USERPROFILE: home, HOMEPATH: home, HOMEDRIVE: '' },
      encoding: 'utf-8',
    })

    expect(res.status).toBe(0)
    const parsed = JSON.parse(res.stdout) as ActionRecord[]
    expect(parsed.map(r => r.id)).toEqual([recNewer.id, recOlder.id])
    expect(parsed[0]).toMatchObject({ kind: 'mcp-remove', description: 'newer', status: 'applied', findingId: null })
    expect(parsed[0]!.changes[0]).toMatchObject({ path: p2, op: 'edit' })
    expect(typeof parsed[0]!.changes[0]!.afterHash).toBe('string')
    expect(parsed[0]!.changes[0]!.backup).not.toBeNull()
  }, 20_000)
})

function sampleRecord(id: string, description: string): ActionRecord {
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { collectStorageReport, measureStorage, renderStorageTable } from '../src/storage.js'
import type { Provider } from '../src/providers/types.js'

vi.mock('fs/promises', async importOriginal => ({ ...await importOriginal<typeof fs>() }))
let root: string
beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codeburn-storage-'))) })
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})
const target = (provider: string, ...paths: string[]) => ({ provider, roots: paths.map(path => ({ path, label: 'fixture' })) })

describe('metadata-only storage footprint', () => {
  it('deduplicates overlapping roots, hard links, shared stores and nested caches', async () => {
    const data = join(root, 'data'), nested = join(data, 'nested'), cache = join(data, 'cache')
    await fs.mkdir(nested, { recursive: true })
    await fs.mkdir(cache)
    await fs.writeFile(join(data, 'one.jsonl'), 'a'.repeat(10))
    await fs.writeFile(join(nested, 'two.jsonl'), 'b'.repeat(20))
    await fs.link(join(data, 'one.jsonl'), join(data, 'hardlink.jsonl'))
    await fs.writeFile(join(cache, 'cache.json'), 'c'.repeat(30))
    const read = vi.spyOn(fs, 'readFile')
    const report = await measureStorage([target('first', data, nested), target('second', nested)], cache)
    expect(report.sources).toEqual({ files: 2, bytes: 30 })
    expect(report.cache).toMatchObject({ files: 1, bytes: 30 })
    expect(report.providers.map(p => [p.provider, p.files, p.bytes])).toEqual([['first', 1, 10], ['second', 0, 0]])
    expect(report.shared).toEqual([{ providers: ['first', 'second'], files: 1, bytes: 20 }])
    expect(report.largestFiles.map(f => f.bytes)).toEqual([20, 10])
    expect(read).not.toHaveBeenCalled()
    expect(JSON.parse(JSON.stringify(report))).toEqual(report)
  })

  it('measures SQLite file roots and existing WAL/SHM files without opening them', async () => {
    const db = join(root, 'sessions.db')
    for (const [suffix, length] of [['', 100], ['-wal', 40], ['-shm', 20]] as const) await fs.writeFile(db + suffix, 'x'.repeat(length))
    const before = await fs.readdir(root)
    const report = await measureStorage([target('sqlite-provider', db, root)], join(root, 'absent-cache'))
    expect(report.sources).toEqual({ files: 3, bytes: 160 })
    expect(await fs.readdir(root)).toEqual(before)
  })

  it('follows an explicit root link once but skips nested symlinks and cycles', async () => {
    const data = join(root, 'data'), alias = join(root, 'alias')
    await fs.mkdir(data)
    await fs.writeFile(join(data, 'log'), '12345')
    await fs.symlink(data, alias, 'junction')
    await fs.symlink(data, join(data, 'cycle'), 'junction')
    const report = await measureStorage([target('one', alias, data)], join(root, 'cache'))
    expect(report.sources).toEqual({ files: 1, bytes: 5 })
    expect(report.omissions).toContainEqual({ provider: 'one', path: join(data, 'cycle'), reason: 'symlink skipped' })
  })

  it('continues past missing, denied, busy and disappearing paths and unavailable disk space', async () => {
    await fs.mkdir(join(root, 'denied'))
    await fs.mkdir(join(root, 'busy'))
    await fs.writeFile(join(root, 'gone'), 'gone')
    await fs.writeFile(join(root, 'good'), 'good')
    const originalReaddir = fs.readdir
    vi.spyOn(fs, 'readdir').mockImplementation(async (...args: Parameters<typeof fs.readdir>) => {
      const path = String(args[0])
      if (path.endsWith('denied') || path.endsWith('busy')) throw Object.assign(new Error(), { code: path.endsWith('denied') ? 'EACCES' : 'EBUSY' })
      return originalReaddir(...args)
    })
    const originalLstat = fs.lstat
    vi.spyOn(fs, 'lstat').mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
      if (String(args[0]).endsWith('gone')) throw Object.assign(new Error(), { code: 'ENOENT' })
      return originalLstat(...args)
    })
    vi.spyOn(fs, 'statfs').mockRejectedValue(Object.assign(new Error(), { code: 'ENOSYS' }))
    const report = await measureStorage([target('test', root)], join(root, 'missing'))
    expect(report.sources).toEqual({ files: 1, bytes: 4 })
    expect(report.omissions.map(o => o.reason)).toEqual(expect.arrayContaining(['EACCES', 'EBUSY', 'ENOENT']))
    expect(report.filesystems[0]).toMatchObject({ availableBytes: null, error: 'ENOSYS' })
    expect(renderStorageTable(report)).toContain('unavailable (ENOSYS)')
  })

  it('never calls discovery/parsing and discloses excluded or failed providers', async () => {
    const discover = vi.fn(() => { throw new Error('must not read source content') })
    const providers = ['codex', 'copilot', 'claude'].map(name => ({
      name, displayName: name, modelDisplayName: (s: string) => s, toolDisplayName: (s: string) => s,
      discoverSessions: discover, createSessionParser: discover,
      probeRoots: async () => { if (name === 'claude') throw Object.assign(new Error(), { code: 'EACCES' }); return target(name, root).roots },
    } satisfies Provider))
    const report = await collectStorageReport('all', providers)
    expect(discover).not.toHaveBeenCalled()
    expect(report.excludedProviders.map(p => p.provider)).toEqual(['copilot', 'claude'])
    expect(report.readOnly).toBe(true)
    expect(report.coverage).toContain('Partial coverage')
  })
})

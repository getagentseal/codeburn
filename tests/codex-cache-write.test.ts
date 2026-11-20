import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ParsedProviderCall } from '../src/providers/types.js'

const faults = vi.hoisted(() => ({ stage: '', bytes: 0, target: 'codex-results.' }))
vi.mock('fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('fs/promises')>()
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args)
      const inject = String(args[0]).includes(faults.target)
      return {
        writeFile: async (payload: string, options: { encoding: BufferEncoding }) => {
          if (inject && faults.stage === 'write') {
            await handle.writeFile(payload.slice(0, faults.bytes), options)
            throw new Error('injected write EIO')
          }
          await handle.writeFile(payload, options)
        },
        sync: async () => {
          if (inject && faults.stage === 'sync') throw new Error('injected sync EIO')
          await handle.sync()
        },
        close: async () => {
          await handle.close()
          if (inject && faults.stage === 'close') throw new Error('injected close EIO')
        },
      }
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      if (String(args[0]).includes(faults.target) && faults.stage === 'rename') throw new Error('injected rename EACCES')
      return fs.rename(...args)
    },
  }
})

let dir: string
let session: string
let finalPath: string
let previous: string
let mod: typeof import('../src/codex-cache.js')
let warning: ReturnType<typeof vi.spyOn>
const calls = (costUSD: number) => [{ costUSD }] as ParsedProviderCall[]

beforeEach(async () => {
  vi.resetModules()
  faults.stage = ''
  faults.bytes = 0
  faults.target = 'codex-results.'
  dir = await mkdtemp(join(tmpdir(), 'codeburn-codex-write-'))
  vi.stubEnv('CODEBURN_CACHE_DIR', dir)
  warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  session = join(dir, 'session.jsonl')
  await writeFile(session, '{}\n')
  mod = await import('../src/codex-cache.js')
  finalPath = join(dir, mod.codexCacheFileName())
  const fp = (await mod.fingerprintFile(session))!
  await mod.writeCachedCodexResults(session, 'project', calls(1), fp)
  await mod.flushCodexCache()
  previous = await readFile(finalPath, 'utf8')
  await mod.writeCachedCodexResults(session, 'updated-project', calls(2), fp)
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await rm(dir, { recursive: true, force: true })
})

describe('Codex cache write failures', () => {
  it.each([
    ['write', 0],
    ['write', 64],
    ['sync', 0],
    ['close', 0],
    ['rename', 0],
  ])('cleans up after %s failure with %i bytes written and allows retry', async (stage, bytes) => {
    faults.stage = stage
    faults.bytes = bytes
    await mod.flushCodexCache()
    expect(await readFile(finalPath, 'utf8')).toBe(previous)
    expect((await readdir(dir)).filter(name => name.endsWith('.tmp'))).toEqual([])
    faults.stage = ''
    await mod.flushCodexCache()
    expect(JSON.parse(await readFile(finalPath, 'utf8')).files[session].calls[0].costUSD).toBe(2)
    expect(warning).not.toHaveBeenCalled()
  })

  it.each(['write', 'sync', 'close', 'rename'])('cleans up after project-index %s failure', async (stage) => {
    const indexPath = join(dir, mod.codexProjectsFileName())
    const previousIndex = await readFile(indexPath, 'utf8')
    faults.target = 'codex-projects.'
    faults.stage = stage
    await mod.flushCodexCache()
    expect(await readFile(indexPath, 'utf8')).toBe(previousIndex)
    expect(JSON.parse(await readFile(finalPath, 'utf8')).files[session].calls[0].costUSD).toBe(2)
    expect((await readdir(dir)).filter(name => name.endsWith('.tmp'))).toEqual([])
    faults.stage = ''
    await mod.flushCodexCache()
    expect(JSON.parse(await readFile(indexPath, 'utf8')).files[session].project).toBe('updated-project')
    expect(warning).not.toHaveBeenCalled()
  })

  it.each(['load', 'flush'])('silently sweeps only old cache temps on %s', async (operation) => {
    const oldNames = [
      'codex-results.json.0123456789abcdef.tmp',
      `${mod.codexCacheFileName()}.fedcba9876543210.tmp`,
      `${mod.codexProjectsFileName()}.2222222222222222.tmp`,
    ]
    const recent = `${mod.codexCacheFileName()}.1111111111111111.tmp`
    const unrelated = 'other.tmp'
    const old = new Date(Date.now() - 6 * 60 * 1000)
    for (const [i, name] of [...oldNames, unrelated].entries()) {
      await writeFile(join(dir, name), i === 0 ? '' : '{"partial":')
      await utimes(join(dir, name), old, old)
    }
    await writeFile(join(dir, recent), 'in progress')
    if (operation === 'load') {
      mod.clearCodexMemCaches()
      expect(await mod.readCachedCodexResults(session)).toEqual({ kind: 'exact', calls: calls(1) })
      expect(await readFile(finalPath, 'utf8')).toBe(previous)
    } else {
      await mod.flushCodexCache()
      expect(JSON.parse(await readFile(finalPath, 'utf8')).files[session].calls[0].costUSD).toBe(2)
    }
    expect((await readdir(dir)).filter(name => name.endsWith('.tmp')).sort()).toEqual([recent, unrelated].sort())
    expect(await readFile(join(dir, recent), 'utf8')).toBe('in progress')
    expect(warning).not.toHaveBeenCalled()
  })
})

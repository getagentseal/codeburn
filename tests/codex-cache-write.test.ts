import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'fs/promises'
import { join, resolve } from 'path'
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
  await mkdir(resolve('.cache'), { recursive: true })
  dir = await mkdtemp(resolve('.cache/codex-write-'))
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
  await mod.writeCachedCodexResults(session, 'project', calls(2), fp)
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
  ])('reports %s failure after %i bytes and preserves the complete cache', async (stage, bytes) => {
    faults.stage = stage
    faults.bytes = bytes
    await mod.flushCodexCache()
    expect(warning.mock.calls.flat().join(' ')).toContain(`injected ${stage}`)
    expect(warning.mock.calls.flat().join(' ')).toContain('stale')
    expect(warning.mock.calls.flat().join(' ')).toContain(finalPath)
    expect(await readFile(finalPath, 'utf8')).toBe(previous)
    expect((await readdir(dir)).filter(name => name.endsWith('.tmp'))).toEqual([])
    faults.stage = ''
    await mod.flushCodexCache()
    expect(JSON.parse(await readFile(finalPath, 'utf8')).files[session].calls[0].costUSD).toBe(2)
  })

  it.each(['write', 'sync', 'close', 'rename'])('reports project-index %s failures and cleans up', async (stage) => {
    const indexPath = join(dir, mod.codexProjectsFileName())
    const previousIndex = await readFile(indexPath, 'utf8')
    faults.target = 'codex-projects.'
    faults.stage = stage
    await mod.flushCodexCache()
    expect(warning.mock.calls.flat().join(' ')).toContain(`injected ${stage}`)
    expect(warning.mock.calls.flat().join(' ')).toContain(indexPath)
    expect(await readFile(indexPath, 'utf8')).toBe(previousIndex)
    expect(JSON.parse(await readFile(finalPath, 'utf8')).files[session].calls[0].costUSD).toBe(2)
    expect((await readdir(dir)).filter(name => name.endsWith('.tmp'))).toEqual([])
    faults.stage = ''
    await mod.flushCodexCache()
    expect(warning.mock.calls.flat().join(' ')).toContain('stale')
  })

  it('reports and removes old empty and partial orphans on a cache read', async () => {
    const empty = join(dir, 'codex-results.json.0123456789abcdef.tmp')
    const partial = join(dir, 'codex-results.json.fedcba9876543210.tmp')
    const recent = join(dir, 'codex-results.json.1111111111111111.tmp')
    const unrelated = join(dir, 'other.tmp')
    for (const [path, content] of [[empty, ''], [partial, '{"version":'], [recent, 'in progress'], [unrelated, 'keep']]) {
      await writeFile(path, content)
    }
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000)
    await utimes(empty, old, old)
    await utimes(partial, old, old)
    vi.resetModules()
    mod = await import('../src/codex-cache.js')
    expect(await mod.readCachedCodexResults(session)).toEqual({ kind: 'exact', calls: calls(1) })
    expect(warning.mock.calls.flat().join(' ')).toContain('unfinished')
    expect(await readdir(dir)).not.toContain(empty.split('/').at(-1))
    expect(await readdir(dir)).not.toContain(partial.split('/').at(-1))
    expect(await readFile(recent, 'utf8')).toBe('in progress')
    expect(await readFile(unrelated, 'utf8')).toBe('keep')
    expect(await readFile(finalPath, 'utf8')).toBe(previous)
  })

  it('reclaims a dead writer immediately but leaves a live writer alone', async () => {
    const dead = join(dir, `${mod.codexProjectsFileName()}.2222222222222222.2147483647.tmp`)
    const live = join(dir, `${mod.codexCacheFileName()}.3333333333333333.${process.pid}.tmp`)
    await writeFile(dead, 'partial')
    await writeFile(live, 'active')
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000)
    await utimes(live, old, old)
    vi.resetModules()
    mod = await import('../src/codex-cache.js')
    await mod.readCachedCodexResults(session)
    expect(await readdir(dir)).not.toContain(dead.split('/').at(-1))
    expect(await readFile(live, 'utf8')).toBe('active')
    expect(warning.mock.calls.flat().join(' ')).toContain('unfinished')
  })

  it('does not serve the old entry when a session changes after a failed flush', async () => {
    faults.stage = 'write'
    faults.bytes = 64
    await mod.flushCodexCache()
    await writeFile(session, '{"new":"session data"}\n')
    vi.resetModules()
    mod = await import('../src/codex-cache.js')
    expect(await mod.readCachedCodexResults(session)).toBeNull()
    expect(await mod.getCachedCodexProject(session)).toBeNull()
    expect((await stat(finalPath)).size).toBe(Buffer.byteLength(previous))
  })

  it('writes a cache larger than 60 MB completely', async () => {
    await mod.writeCachedCodexResults(session, 'project', [
      { costUSD: 3, userMessage: 'x'.repeat(60_543_405) } as ParsedProviderCall,
    ], (await mod.fingerprintFile(session))!)
    await mod.flushCodexCache()
    const raw = await readFile(finalPath, 'utf8')
    expect(raw.length).toBeGreaterThan(60_543_405)
    expect(JSON.parse(raw).files[session].calls[0].userMessage.length).toBe(60_543_405)
    expect((await readdir(dir)).filter(name => name.endsWith('.tmp'))).toEqual([])
    expect(warning).not.toHaveBeenCalled()
  })
})

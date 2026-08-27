import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const statCalls = vi.hoisted(() => [] as string[])

// Keep real fs/promises behavior for the cache file while recording source
// probes. The regression must prove that flush never asks the OS about a WSL
// UNC path, because a stopped distro can make that call hang.
vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises')
  return {
    ...actual,
    stat: (...args: Parameters<typeof actual.stat>) => {
      const source = String(args[0])
      statCalls.push(source)
      // Never touch a real share from the regression itself. If the flush
      // loop regresses, fail fast instead of inheriting the Windows UNC
      // timeout this test is intended to prevent.
      if (/^\\\\wsl(\$|\.localhost)\\/i.test(source)) {
        return Promise.reject(new Error('stubbed WSL share'))
      }
      return actual.stat(...args)
    },
  }
})

const {
  clearCodexMemCaches,
  codexCacheFileName,
  flushCodexCache,
  withCodexCacheDirectory,
  writeCachedCodexResults,
} = await import('../src/codex-cache.js')

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'codeburn-codex-wsl-flush-'))
  statCalls.length = 0
  clearCodexMemCaches()
})

afterEach(async () => {
  clearCodexMemCaches()
  await rm(root, { recursive: true, force: true })
})

describe('Codex cache flush with WSL sources', () => {
  it('retains WSL UNC entries without statting them, while evicting missing paths', async () => {
    const cacheDir = join(root, 'cache')
    const missingPath = join(root, 'missing.jsonl')
    const wslPath = String.raw`\\wsl$\Ubuntu\home\alice\.codex\sessions\rollout.jsonl`
    const fingerprint = { dev: 1, ino: 2, mtimeMs: 3, sizeBytes: 4 }

    await withCodexCacheDirectory(cacheDir, async () => {
      await writeCachedCodexResults(wslPath, 'wsl-project', [], fingerprint)
      await writeCachedCodexResults(missingPath, 'native-project', [], fingerprint)
      await flushCodexCache()
    })

    const disk = JSON.parse(await readFile(join(cacheDir, codexCacheFileName()), 'utf8'))
    expect(disk.files[wslPath]).toMatchObject({ project: 'wsl-project' })
    expect(disk.files[missingPath]).toBeUndefined()
    expect(statCalls).toContain(missingPath)
    expect(statCalls).not.toContain(wslPath)
  })
})

// Codex discovery needs only each rollout's project, so it reads a small
// index flushCodexCache writes beside the results file instead of the whole
// (hundreds-of-MB) results cache.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  clearCodexMemCaches,
  codexCacheFileName,
  codexProjectsFileName,
  fingerprintFile,
  flushCodexCache,
  getCachedCodexProject,
  withCodexCacheDirectory,
  writeCachedCodexResults,
} from '../src/codex-cache.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codex-projects-'))
  clearCodexMemCaches()
})

afterEach(() => {
  clearCodexMemCaches()
  rmSync(dir, { recursive: true, force: true })
})

describe('codex projects index', () => {
  it('serves discovery without the results file', async () => {
    const rollout = join(dir, 'rollout-2099-05-01T10-00-00-a.jsonl')
    writeFileSync(rollout, '{}\n')
    const fp = (await fingerprintFile(rollout))!
    await withCodexCacheDirectory(dir, async () => {
      await writeCachedCodexResults(rollout, 'indexed-project', [], fp)
      await flushCodexCache()
    })
    expect(existsSync(join(dir, codexProjectsFileName()))).toBe(true)

    clearCodexMemCaches()
    writeFileSync(join(dir, codexCacheFileName()), 'not the results cache')
    expect(await withCodexCacheDirectory(dir, () => getCachedCodexProject(rollout))).toBe('indexed-project')

    // An index that lags the file (it grew since) only misses.
    writeFileSync(rollout, '{}\n{}\n')
    clearCodexMemCaches()
    expect(await withCodexCacheDirectory(dir, () => getCachedCodexProject(rollout))).toBeNull()
    expect(readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([])
  })

  it('builds the index from the results file when it is missing', async () => {
    const rollout = join(dir, 'rollout-2099-05-01T10-00-00-b.jsonl')
    writeFileSync(rollout, '{}\n')
    const fp = (await fingerprintFile(rollout))!
    await withCodexCacheDirectory(dir, async () => {
      await writeCachedCodexResults(rollout, 'from-results', [], fp)
      await flushCodexCache()
    })
    rmSync(join(dir, codexProjectsFileName()))
    clearCodexMemCaches()
    expect(await withCodexCacheDirectory(dir, () => getCachedCodexProject(rollout))).toBe('from-results')
    expect(existsSync(join(dir, codexProjectsFileName()))).toBe(true)
  })
})

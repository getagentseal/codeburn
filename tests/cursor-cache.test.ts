import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { readCachedResults } from '../src/cursor-cache.js'

let tmpDir: string
let oldCacheDir: string | undefined

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'cursor-cache-'))
  oldCacheDir = process.env['CODEBURN_CACHE_DIR']
  process.env['CODEBURN_CACHE_DIR'] = join(tmpDir, 'cache')
})

afterEach(async () => {
  if (oldCacheDir === undefined) {
    delete process.env['CODEBURN_CACHE_DIR']
  } else {
    process.env['CODEBURN_CACHE_DIR'] = oldCacheDir
  }
  await rm(tmpDir, { recursive: true, force: true })
})

describe('cursor result cache', () => {
  it('invalidates v3 caches written before the missing-createdAt fix', async () => {
    const dbPath = join(tmpDir, 'state.vscdb')
    await writeFile(dbPath, 'cursor db')
    const fp = await stat(dbPath)

    const cacheDir = process.env['CODEBURN_CACHE_DIR']!
    await mkdir(cacheDir, { recursive: true })
    await writeFile(
      join(cacheDir, 'cursor-results.json'),
      JSON.stringify({
        version: 3,
        dbMtimeMs: fp.mtimeMs,
        dbSizeBytes: fp.size,
        calls: [],
      }),
    )

    await expect(readCachedResults(dbPath)).resolves.toBeNull()
  })
})

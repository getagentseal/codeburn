import { existsSync } from 'fs'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'

import { acquireCacheRefreshLock } from '../../src/cache-refresh-lock.js'
import { loadCache, saveCache } from '../../src/session-cache.js'

const [cacheDir, barrierDir, id, sourcePath, bypass = 'false'] = process.argv.slice(2)
if (!cacheDir || !barrierDir || !id || !sourcePath) throw new Error('missing worker argument')

async function waitFor(name: string): Promise<void> {
  const path = join(barrierDir!, name)
  while (!existsSync(path)) await new Promise(resolve => { setTimeout(resolve, 5) })
}

process.env['CODEBURN_CACHE_DIR'] = cacheDir
await mkdir(barrierDir, { recursive: true })

const refresh = bypass === 'true' ? null : await acquireCacheRefreshLock({ cacheDir, waitMs: 2_000, pollMs: 5 })
if (refresh && refresh.outcome !== 'acquired') {
  await writeFile(join(barrierDir, `${id}.${refresh.outcome}`), '')
  process.exit(0)
}

try {
  const cache = await loadCache()
  // Parsing is deliberately tiny; the files and barrier make the transaction
  // interleaving deterministic rather than relying on parser runtime variance.
  const parsed = JSON.parse(await readFile(sourcePath, 'utf-8')) as { output: number }
  cache.providers['regression'] ??= { parseVersion: 'test', envFingerprint: 'test', files: {} }
  cache.providers['regression'].files[sourcePath] = {
    fingerprint: { dev: 1, ino: parsed.output, mtimeMs: parsed.output, sizeBytes: parsed.output },
    mcpInventory: [],
    turns: [],
  }
  ;(cache as { _dirty?: boolean })._dirty = true
  await writeFile(join(barrierDir, `${id}.parsed`), '')
  await waitFor(`${id}.save`)
  const published = await saveCache(cache, refresh?.handle.verifyStillOwner)
  await writeFile(join(barrierDir, `${id}.${published ? 'published' : 'fenced'}`), '')
} finally {
  await refresh?.handle.release()
}

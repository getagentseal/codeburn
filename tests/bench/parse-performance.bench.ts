import { bench, describe } from 'vitest'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openCache } from '../../src/session-cache.js'
import { parseSessionFile } from '../../src/parser.js'

// R15: use fixture files from tests/fixtures/bench/
const FIXTURE_DIR = new URL('../../tests/fixtures/bench', import.meta.url).pathname

function makeTempCacheDir(): string {
  const dir = join(tmpdir(), `codeburn-bench-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const fixtureFiles = [
  join(FIXTURE_DIR, 'session-coding.jsonl'),
  join(FIXTURE_DIR, 'session-debugging.jsonl'),
  join(FIXTURE_DIR, 'session-testing.jsonl'),
  join(FIXTURE_DIR, 'session-refactoring.jsonl'),
  join(FIXTURE_DIR, 'session-feature.jsonl'),
]

describe('parse performance', () => {
  // R13, AC13: cold cache - under 200ms median
  bench('parse cold', async () => {
    const cacheDir = makeTempCacheDir()
    try {
      const db = await openCache(join(cacheDir, 'session-cache.db'))
      const seenMsgIds = new Set<string>()
      for (const filePath of fixtureFiles) {
        await parseSessionFile(filePath, 'bench-project', seenMsgIds, undefined, false, db)
      }
      db?.close()
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
    }
  }, { time: 1000 })

  // R13, AC14: warm cache - under 20ms median, at least 3x faster than cold
  bench('parse warm', async () => {
    const cacheDir = makeTempCacheDir()
    try {
      const db = await openCache(join(cacheDir, 'session-cache.db'))

      // Warm up: populate cache
      const warmupIds = new Set<string>()
      for (const filePath of fixtureFiles) {
        await parseSessionFile(filePath, 'bench-project', warmupIds, undefined, false, db)
      }

      // Benchmark: all cache hits
      const seenMsgIds = new Set<string>()
      for (const filePath of fixtureFiles) {
        await parseSessionFile(filePath, 'bench-project', seenMsgIds, undefined, false, db)
      }
      db?.close()
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
    }
  }, { time: 1000 })
})

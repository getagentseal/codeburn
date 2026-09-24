import { mkdir, mkdtemp, readdir, symlink, utimes, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it } from 'vitest'

import { sweepSupersededCacheFiles } from '../src/cache-sweep.js'
import { CACHE_VERSION } from '../src/session-cache.js'

const DAY_MS = 24 * 60 * 60 * 1000

describe('sweepSupersededCacheFiles', () => {
  let dir: string

  async function seed(name: string, ageDays: number): Promise<void> {
    const path = join(dir, name)
    await writeFile(path, 'x')
    const when = new Date(Date.now() - ageDays * DAY_MS)
    await utimes(path, when, when)
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'codeburn-sweep-'))
    process.env['CODEBURN_CACHE_DIR'] = dir
  })

  it('deletes only superseded cache files that have gone stale', async () => {
    await seed('session-cache.v5.json', 30)
    await seed('session-cache.json', 30)
    await seed('session-cache.json.v7.bak', 30)
    await seed('daily-cache.json.v7.bak', 30)
    await seed('daily-cache.v1.json', 30)
    await seed('hermes-session-ledger.v1.json', 30)
    await seed('codex-results.v1.json', 3)
    await seed(`session-cache.v${CACHE_VERSION}.json`, 30)
    await seed('menubar-status.json', 30)
    await seed('claude-credentials.v1.json', 30)
    await mkdir(join(dir, 'session-cache.v8'))
    await symlink('/etc/hosts', join(dir, 'cursor-results.v1.json'))

    await sweepSupersededCacheFiles()

    expect((await readdir(dir)).sort()).toEqual([
      'cache-sweep.stamp',
      'claude-credentials.v1.json',
      'codex-results.v1.json',
      'cursor-results.v1.json',
      'daily-cache.json.v7.bak',
      'daily-cache.v1.json',
      'hermes-session-ledger.v1.json',
      'menubar-status.json',
      'session-cache.v8',
      `session-cache.v${CACHE_VERSION}.json`,
    ].sort())
  })

  it('runs at most once a day', async () => {
    await sweepSupersededCacheFiles()
    await seed('session-cache.v5.json', 30)

    await sweepSupersededCacheFiles()
    expect(await readdir(dir)).toContain('session-cache.v5.json')

    await sweepSupersededCacheFiles(Date.now() + 2 * DAY_MS)
    expect(await readdir(dir)).not.toContain('session-cache.v5.json')
  })
})

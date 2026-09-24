import { lstat, readdir, stat, unlink, writeFile } from 'fs/promises'
import { join } from 'path'

import { getCodeburnCacheDir } from './cache-dir.js'
import { CODEX_CACHE_VERSION } from './codex-cache.js'
import { CURSOR_CACHE_VERSION } from './cursor-cache.js'
import { CACHE_VERSION } from './session-cache.js'

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000
const STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000
const STAMP_FILE = 'cache-sweep.stamp'

/// `<family>.v<n>.json`, plus the two shapes a family's own history takes: the
/// pre-versioning `<family>.json` and the `<family>.json.v<n>.bak` copies.
/// The family part admits no digits or dots, so `status-snapshot.<hash>.json`
/// and every credential file fall outside it.
const CACHE_FILENAME = /^([a-z-]+)(?:\.v(\d+))?\.json(?:\.v(\d+)\.bak)?$/

/// Only caches that re-derive in full from the session files. daily-cache and
/// hermes-session-ledger are left out on purpose: they hold sealed days whose
/// sources may be gone, and a version bump reads every older copy to carry them.
function currentVersions(): Record<string, number> {
  return {
    'session-cache': CACHE_VERSION,
    'codex-results': CODEX_CACHE_VERSION,
    'cursor-results': CURSOR_CACHE_VERSION,
  }
}

/// True only for a KNOWN cache family at a version this binary has moved past
/// (the unversioned legacy name counts as the oldest version there is).
export function isSupersededCacheFile(name: string): boolean {
  const match = CACHE_FILENAME.exec(name)
  if (!match) return false
  const current = currentVersions()[match[1]!]
  if (current === undefined) return false
  const version = match[2] ?? match[3]
  return version === undefined || Number(version) < current
}

/// Delete cache files a version bump left behind — a single superseded
/// session-cache runs to 100MB+ and nothing ever reclaimed them. Deliberately
/// timid: known filenames only, strictly older versions only, plain files
/// only (never a directory or a symlink), inside the resolved cache dir only,
/// and only once a file has gone untouched for a fortnight — an older CLI or
/// menubar still in use keeps writing its own files, so they survive.
export async function sweepSupersededCacheFiles(now = Date.now()): Promise<void> {
  try {
    const dir = getCodeburnCacheDir()
    const stamp = join(dir, STAMP_FILE)
    const lastSweep = await stat(stamp).then(s => s.mtimeMs, () => 0)
    if (now - lastSweep < SWEEP_INTERVAL_MS) return
    // Stamped before the pass, so a failure mid-sweep waits for tomorrow
    // rather than retrying on every save.
    await writeFile(stamp, '')
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !isSupersededCacheFile(entry.name)) continue
      const path = join(dir, entry.name)
      const stats = await lstat(path).catch(() => null)
      if (!stats?.isFile() || now - stats.mtimeMs < STALE_AFTER_MS) continue
      await unlink(path).catch(() => {})
    }
  } catch {
    // Housekeeping never fails a save.
  }
}

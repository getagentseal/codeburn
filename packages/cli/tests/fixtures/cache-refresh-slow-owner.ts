import { pbkdf2 } from 'crypto'
import { writeFile } from 'fs/promises'
import { join } from 'path'

import { acquireCacheRefreshLock } from '../../src/cache-refresh-lock.js'

// Saturate the (size-1) libuv threadpool so every fs operation inside
// createExclusive queues behind a pbkdf2 round. No test hook and no patched
// module: this is what an ordinary process looks like mid cold parse, and it
// widens the window in which the lock exists at zero bytes -- between
// open(path,'wx') and the awaited body write -- to something observable.
const [cacheDir, barrierDir] = process.argv.slice(2)
if (!cacheDir || !barrierDir) throw new Error('missing owner argument')

let stop = false
const churn = (): void => { if (stop) return; pbkdf2('p', 's', 400_000, 32, 'sha512', () => churn()) }
churn()

const refresh = await acquireCacheRefreshLock({ cacheDir, heartbeatMs: 10_000 })
stop = true
await writeFile(join(barrierDir, `owner.${refresh.outcome}`), refresh.outcome === 'acquired' ? refresh.handle.token : '')
if (refresh.outcome === 'acquired') {
  await writeFile(join(barrierDir, `owner.verify.${await refresh.handle.verifyStillOwner()}`), '')
  await refresh.handle.release()
}

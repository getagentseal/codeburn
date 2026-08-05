import { writeFile } from 'fs/promises'
import { join } from 'path'

import { acquireCacheRefreshLock } from '../../src/cache-refresh-lock.js'

// A plain owner in its own process. It records its outcome, its token, and the
// result of the publication fence into the barrier directory so the parent can
// assert what the owner itself believed while a contender was racing it.
const [cacheDir, barrierDir, holdMs, heartbeatMs = '200'] = process.argv.slice(2)
if (!cacheDir || !barrierDir || !holdMs) throw new Error('missing owner argument')

const refresh = await acquireCacheRefreshLock({ cacheDir, heartbeatMs: Number(heartbeatMs) })
if (refresh.outcome !== 'acquired') {
  await writeFile(join(barrierDir, `owner.${refresh.outcome}`), '')
  process.exit(0)
}
await writeFile(join(barrierDir, 'owner.acquired'), refresh.handle.token)
await new Promise(resolve => { setTimeout(resolve, Number(holdMs)) })
// The publication fence, exactly as parser.ts uses it before saving.
await writeFile(join(barrierDir, `owner.verify.${await refresh.handle.verifyStillOwner()}`), '')
await refresh.handle.release()
await writeFile(join(barrierDir, 'owner.done'), '')

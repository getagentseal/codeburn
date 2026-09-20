import { parentPort, workerData } from 'worker_threads'
import { restorePricingState, type PricingSnapshot } from './models.js'
import type { ParseJob } from './parse-workers.js'
import { parseClaudeFileFull } from './parser.js'
import { parseCodexFileFull } from './providers/codex.js'
import { DedupSet } from './session-cache.js'

const port = parentPort
if (!port) throw new Error('parse-worker must be started as a worker thread')

restorePricingState((workerData as { pricing: PricingSnapshot }).pricing)

// The parsed turns go back as a JSON string rather than as a live object graph:
// structured-cloning a whole corpus of turns costs more than the parallel parse
// saves, while a string is a single copy the parent re-parses at memcpy speed.
// `msgIds` / `keys` is every dedup key this file claimed; the parent uses it to
// prove no earlier file already owned one before installing the result. A Codex
// job also carries back the cache entry it would have written, because the cache
// module's per-directory state belongs to the parent, not to a thread.
port.on('message', (msg: ParseJob) => {
  void (async () => {
    try {
      const seen = new DedupSet()
      if (msg.kind === 'codex') {
        const parsed = await parseCodexFileFull(msg.source, seen)
        port.postMessage({ json: JSON.stringify({ ...parsed, keys: [...seen.values()], path: msg.source.path }) })
        return
      }
      const parsed = await parseClaudeFileFull(msg.filePath, seen)
      port.postMessage({ json: parsed === null ? null : JSON.stringify({ ...parsed, msgIds: [...seen.values()], path: msg.filePath }) })
    } catch (err) {
      port.postMessage({ error: err instanceof Error ? err.message : String(err) })
    }
  })()
})

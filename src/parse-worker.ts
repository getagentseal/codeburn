import { parentPort, workerData, type MessagePort } from 'worker_threads'
import { routeCodexParentReplay } from './codex-fork-replay.js'
import { restorePricingState, type PricingSnapshot } from './models.js'
import type { ParentReplayReply, ParentReplayRequest, ParseJob } from './parse-workers.js'
import { parseClaudeFileFull } from './parser.js'
import { parseCodexFileFull } from './providers/codex.js'

const port = parentPort
if (!port) throw new Error('parse-worker must be started as a worker thread')

const { pricing, replayPort } = workerData as { pricing: PricingSnapshot; replayPort: MessagePort }
restorePricingState(pricing)

const replayReplies = new Map<number, { resolve: (ids: Set<string> | null) => void; reject: (err: Error) => void }>()
let nextReplayRequest = 0
replayPort.on('message', (msg: ParentReplayReply) => {
  const reply = replayReplies.get(msg.id)
  replayReplies.delete(msg.id)
  if (msg.error !== undefined) reply?.reject(new Error(msg.error))
  else reply?.resolve(msg.ids ?? null)
})
routeCodexParentReplay((...args) => new Promise((resolve, reject) => {
  const id = nextReplayRequest++
  replayReplies.set(id, { resolve, reject })
  replayPort.postMessage({ id, args } satisfies ParentReplayRequest)
}))

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
      const seen = new Set<string>()
      if (msg.kind === 'codex') {
        const parsed = await parseCodexFileFull(msg.source, seen)
        port.postMessage({ json: JSON.stringify({ ...parsed, keys: [...seen], path: msg.source.path }) })
        return
      }
      const parsed = await parseClaudeFileFull(msg.filePath, seen)
      port.postMessage({ json: parsed === null ? null : JSON.stringify({ ...parsed, msgIds: [...seen], path: msg.filePath }) })
    } catch (err) {
      port.postMessage({ error: err instanceof Error ? err.message : String(err) })
    }
  })()
})

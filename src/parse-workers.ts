import { availableParallelism, totalmem } from 'os'
import { MessageChannel, Worker, type MessagePort } from 'worker_threads'
import { loadCodexParentReplay } from './codex-fork-replay.js'
import { snapshotPricingState } from './models.js'
import type { ClaudeFileParse } from './parser.js'
import type { SessionSource } from './providers/types.js'

// A worker holds one file's entries plus its serialized result, and the parent
// buffers up to `pool.size` finished results while it installs one — both are in
// this budget. A flat 256 MB was measured wrong on Codex: a 260 MB rollout peaks
// near 430 MB per worker and scales linearly with the pool. So derive it from the
// average pending file instead, floored at the small-transcript figure and capped
// at 1 GB. Going over the budget is what turns a parallel parse into a swapping one.
const MIN_PER_WORKER_RSS_BYTES = 256 * 1024 * 1024
const MAX_PER_WORKER_RSS_BYTES = 1024 * 1024 * 1024
const PER_WORKER_RSS_OVERHEAD_BYTES = 128 * 1024 * 1024
const MEMORY_BUDGET_CAP_BYTES = 2 * 1024 * 1024 * 1024
const MIN_AVAILABLE_BYTES = 4 * 1024 * 1024 * 1024
const MIN_FILES_PER_WORKER = 50
const MIN_BYTES_PER_WORKER = 200 * 1024 * 1024
// Below this a parse is warm/incremental and the thread startup + result transfer
// costs more than the parallelism buys. Bytes, not file count: 250 pending files
// holding under a megabyte between them spawn threads that make the run ~5%
// SLOWER, and the file count only starts paying for itself around 400.
const MIN_PENDING_BYTES = 200 * 1024 * 1024

export type ParseWorkerDecision = { workers: number; reason: string }

export type SystemCapacity = { cores: number; availableBytes: number }

// `process.availableMemory()` respects a container's cgroup / rlimit, which is the
// case this gate exists for; where it is absent it falls back to total RAM. Free
// memory is deliberately NOT used: on macOS `os.freemem()` counts free pages, not
// available memory, and reads as a few hundred MB on an idle 128 GB machine — a
// gate built on it turns the feature on and off at random.
function currentSystemCapacity(): SystemCapacity {
  return {
    cores: availableParallelism(),
    availableBytes: typeof process.availableMemory === 'function' ? process.availableMemory() : totalmem(),
  }
}

/// Decide how many parse worker threads a pending workload earns. Returning 0
/// means "parse serially" — the only behaviour before this existed, and still
/// the behaviour for every warm run, every small corpus, and every low-spec box.
export function decideParseWorkers(
  pending: { files: number; bytes: number },
  sys: SystemCapacity = currentSystemCapacity(),
  env: NodeJS.ProcessEnv = process.env,
): ParseWorkerDecision {
  // Every reason carries the full decision input, so a support log line explains
  // itself without a second run.
  const inputs = `${sys.cores} cores, ${Math.round(sys.availableBytes / 1e9 * 10) / 10} GB available, ${pending.files} pending files / ${Math.round(pending.bytes / 1e6)} MB`

  const override = env['CODEBURN_PARSE_WORKERS']
  if (override !== undefined && override !== '') {
    const n = Number(override)
    if (!Number.isFinite(n) || n < 0) return { workers: 0, reason: `invalid CODEBURN_PARSE_WORKERS=${override}` }
    const capped = Math.min(Math.floor(n), sys.cores)
    return { workers: capped, reason: `${capped === 0 ? 'forced serial' : 'forced'} by CODEBURN_PARSE_WORKERS=${override}; ${inputs}` }
  }

  // Workload gates first, so a warm run's log line says "warm", not whatever the
  // machine happened to look like at that moment.
  if (pending.bytes < MIN_PENDING_BYTES) return { workers: 0, reason: `below ${Math.round(MIN_PENDING_BYTES / 1e6)} MB pending; ${inputs}` }
  if (sys.cores <= 2) return { workers: 0, reason: `too few cores; ${inputs}` }
  if (sys.availableBytes < MIN_AVAILABLE_BYTES) return { workers: 0, reason: `below ${Math.round(MIN_AVAILABLE_BYTES / 1e9)} GB available memory; ${inputs}` }

  const memoryBudget = Math.min(0.25 * sys.availableBytes, MEMORY_BUDGET_CAP_BYTES)
  const perWorker = Math.min(
    MAX_PER_WORKER_RSS_BYTES,
    Math.max(MIN_PER_WORKER_RSS_BYTES, 2 * (pending.bytes / Math.max(1, pending.files)) + PER_WORKER_RSS_OVERHEAD_BYTES),
  )
  // Files and bytes each earn threads on their own: a few hundred huge rollouts
  // are as parallelisable as a few thousand small transcripts, and gating the
  // count on files alone would hand a 6 GB / 60-file workload a single thread.
  const workers = Math.min(
    sys.cores - 1,
    Math.floor(memoryBudget / perWorker),
    Math.max(
      Math.floor(pending.files / MIN_FILES_PER_WORKER),
      Math.floor(pending.bytes / MIN_BYTES_PER_WORKER),
    ),
  )
  return { workers, reason: inputs }
}

// In dist the entry is the bundled sibling of this module and a worker can load
// it directly. Running from source (tsx, vitest) the entry is TypeScript, and a
// worker thread inherits none of the parent's loader hooks — so register tsx's
// inside the thread before importing. tsx is a devDependency, which is exactly
// the only situation where the entry can be a .ts file at all.
function workerBootstrap(entryUrl: string): { source: string | URL; eval: boolean } {
  if (!entryUrl.endsWith('.ts')) return { source: new URL(entryUrl), eval: false }
  return {
    eval: true,
    // Chained, not awaited: the eval scope is CommonJS, and a top-level await of
    // the entry re-enters it as a require(esm) cycle.
    source: `
process.noDeprecation = true
import('tsx/esm/api').then(tsx => { tsx.register(); return import(${JSON.stringify(entryUrl)}) })
`,
  }
}

function workerEntryUrl(): string {
  const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js'
  return new URL(`./parse-worker${ext}`, import.meta.url).href
}

/// One whole-file parse for a worker to run. Both kinds carry exactly what the
/// serial per-file parse takes, so the worker can run that same function.
export type ParseJob =
  | { kind: 'claude'; filePath: string }
  | { kind: 'codex'; source: SessionSource }

export type ParseWorkerResult<T> =
  | { ok: true; parsed: T | null }
  | { ok: false; error: string }

export type ClaudeWorkerParse = ClaudeFileParse & { msgIds: string[]; path: string }

type Task = { job: ParseJob; resolve: (r: ParseWorkerResult<unknown>) => void }

type WorkerMessage = { json?: string | null; error?: string }

export type ParentReplayRequest = { id: number; args: Parameters<typeof loadCodexParentReplay> }
export type ParentReplayReply = { id: number; ids?: Set<string> | null; error?: string }

function serveParentReplay(port: MessagePort): void {
  port.on('message', ({ id, args }: ParentReplayRequest) => {
    loadCodexParentReplay(...args).then(
      ids => port.postMessage({ id, ids } satisfies ParentReplayReply),
      (err: unknown) => port.postMessage({ id, error: err instanceof Error ? err.message : String(err) } satisfies ParentReplayReply),
    )
  })
  port.unref()
}

export class ParseWorkerPool {
  private readonly workers: Worker[] = []
  private readonly idle: Worker[] = []
  private readonly inflight = new Map<Worker, Task>()
  private readonly queue: Task[] = []
  private readonly replayPorts: MessagePort[] = []
  private closed = false

  constructor(size: number) {
    const boot = workerBootstrap(workerEntryUrl())
    const workerData = { pricing: snapshotPricingState() }
    try {
      for (let i = 0; i < size; i++) {
        const { port1, port2 } = new MessageChannel()
        serveParentReplay(port1)
        this.replayPorts.push(port1)
        const worker = new Worker(boot.source, { eval: boot.eval, workerData: { ...workerData, replayPort: port2 }, transferList: [port2] })
        worker.on('message', (msg: WorkerMessage) => this.settle(worker, msg))
        worker.on('error', (err: Error) => this.settle(worker, { error: err.message }, true))
        worker.on('exit', () => this.drop(worker))
        this.workers.push(worker)
        this.idle.push(worker)
      }
    } catch (err) {
      for (const w of this.workers) void w.terminate()
      for (const p of this.replayPorts) p.close()
      this.workers.length = 0
      this.idle.length = 0
      throw err
    }
  }

  get size(): number {
    return this.workers.length
  }

  /// Parse one file off-thread. Never rejects: a worker-side failure (or a dead
  /// pool) comes back as `ok: false` so the caller can fall back to an in-process
  /// parse and never lose a file to a crashed thread.
  submit<T>(job: ParseJob): Promise<ParseWorkerResult<T>> {
    return new Promise<ParseWorkerResult<T>>((resolve) => {
      if (this.closed || this.workers.length === 0) {
        resolve({ ok: false, error: 'parse worker pool unavailable' })
        return
      }
      this.queue.push({ job, resolve: resolve as (r: ParseWorkerResult<unknown>) => void })
      this.pump()
    })
  }

  async close(): Promise<void> {
    this.closed = true
    const pending = [...this.queue]
    this.queue.length = 0
    for (const task of pending) task.resolve({ ok: false, error: 'parse worker pool closed' })
    await Promise.all(this.workers.map(w => w.terminate()))
    for (const p of this.replayPorts) p.close()
    this.workers.length = 0
    this.idle.length = 0
    this.inflight.clear()
  }

  private pump(): void {
    while (this.queue.length > 0 && this.idle.length > 0) {
      const worker = this.idle.pop()!
      const task = this.queue.shift()!
      this.inflight.set(worker, task)
      worker.postMessage(task.job)
    }
  }

  private settle(worker: Worker, msg: WorkerMessage, fatal = false): void {
    const task = this.inflight.get(worker)
    this.inflight.delete(worker)
    if (task) {
      if (msg.error !== undefined) task.resolve({ ok: false, error: msg.error })
      else task.resolve({ ok: true, parsed: msg.json == null ? null : JSON.parse(msg.json) })
    }
    if (fatal) return
    if (!this.closed) {
      this.idle.push(worker)
      this.pump()
    }
  }

  // A thread that died takes its queue slot with it; the remaining files are
  // handed back for a serial parse rather than being lost.
  private drop(worker: Worker): void {
    const i = this.workers.indexOf(worker)
    if (i >= 0) this.workers.splice(i, 1)
    const j = this.idle.indexOf(worker)
    if (j >= 0) this.idle.splice(j, 1)
    const task = this.inflight.get(worker)
    if (task) {
      this.inflight.delete(worker)
      task.resolve({ ok: false, error: 'parse worker exited' })
    }
    if (this.workers.length === 0) {
      const pending = [...this.queue]
      this.queue.length = 0
      for (const t of pending) t.resolve({ ok: false, error: 'all parse workers exited' })
    }
  }
}

/// Yield results for `jobs` in the SAME order they were given, no matter which
/// worker finishes first. Keeps exactly `pool.size` files in flight, so at most
/// that many parsed results are buffered while the caller installs one.
export async function* parseFilesInOrder<T>(
  pool: ParseWorkerPool,
  jobs: readonly ParseJob[],
): AsyncGenerator<ParseWorkerResult<T>, void, void> {
  const inflight: Array<Promise<ParseWorkerResult<T>>> = []
  let next = 0
  const fill = (): void => {
    while (inflight.length < Math.max(1, pool.size) && next < jobs.length) {
      inflight.push(pool.submit<T>(jobs[next++]!))
    }
  }
  fill()
  for (let i = 0; i < jobs.length; i++) {
    const result = await inflight.shift()!
    fill()
    yield result
  }
}

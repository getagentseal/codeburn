import { useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { compressToUTF16, decompressFromUTF16 } from 'lz-string'

import { normalizeCliError } from '../lib/ipc'
import { RefreshCadenceContext } from '../lib/refreshCadence'
import type { CliError } from '../lib/types'

export type Polled<T> = {
  data: T | null
  /** Memo key that produced `data`. During a dependency change React may render
   *  once with the previous result before the load effect clears or replaces it;
   *  consumers that persist data under the active key must compare this first. */
  dataKey?: string | null
  error: CliError | null
  loading: boolean
  /** True while a fresh fetch runs behind instantly-served memoized data (a
   *  provider/period switch). Sections use it for a subtle in-flight indicator. */
  switching: boolean
  /** Wall-clock timestamp for the most recent successful fetch. */
  lastSuccessAt: number | null
  /** The most recent result that was refused for being partial or stale while a
   *  complete one was already on screen. `data` still holds the complete answer;
   *  this is only here so the UI can say indexing is still running. */
  degraded?: T | null
  /** Re-run the fetcher immediately (period/provider change, manual refresh). */
  refresh: () => void
}

// Last successful result per memoKey. The bounded in-memory LRU makes switches
// instant; the versioned localStorage copy makes the same guarantee survive a
// renderer restart. These are report snapshots only (never credentials), bounded
// by both entry count and serialized size, and cleared after settings mutations.
//
// Entries carry the wall-clock of the fetch that produced them. When the memoKey
// CHANGES (a period/provider/scope switch) a cached entry younger than
// POLLED_FRESH_MS is served as-is with no CLI spawn at all; an older one is
// served instantly and revalidated behind the painted data
// (stale-while-revalidate). Any reload on the SAME key — interval poll,
// visibility catch-up, refresh() — always fetches, so the poll cadence and the
// manual refresh are unaffected.
const POLLED_FRESH_MS = 30_000
const MAX_MEMO_ENTRIES = 96
const MAX_MEMO_CHARS = 12_000_000
const SNAPSHOT_PREFIX = 'codeburn.reportSnapshot.v1.'
const SNAPSHOT_GENERATION_KEY = 'codeburn.reportSnapshotGeneration.v1'
const MAX_SNAPSHOT_CHARS = 2_500_000
// Do not synchronously compress arbitrarily large reports on the renderer main
// thread. A payload above this raw JSON ceiling is still kept in the bounded
// memory LRU; it simply is not eligible for best-effort restart persistence.
const MAX_SNAPSHOT_SOURCE_CHARS = 300_000
const MAX_STORED_SNAPSHOTS = 72
type MemoEntry = { value: unknown; at: number; durable?: boolean; sizeChars?: number }
const memoStore = new Map<string, MemoEntry>()
let memoSizeChars = 0
let memoEpoch = 0

function memoPut(key: string, entry: MemoEntry): void {
  // Map iteration order is the eviction order. Both a cache hit and a write
  // become most recent. Bound both count and serialized weight: report graphs
  // vary drastically in size, so a count-only LRU is not a memory ceiling.
  memoSizeChars -= memoStore.get(key)?.sizeChars ?? 0
  memoStore.delete(key)
  memoStore.set(key, entry)
  memoSizeChars += entry.sizeChars ?? 0
  while (memoStore.size > 1
    && (memoStore.size > MAX_MEMO_ENTRIES || memoSizeChars > MAX_MEMO_CHARS)) {
    const oldest = memoStore.keys().next().value as string | undefined
    if (oldest === undefined) break
    memoSizeChars -= memoStore.get(oldest)?.sizeChars ?? 0
    memoStore.delete(oldest)
  }
}

function snapshotGeneration(): number {
  try { return Number(globalThis.localStorage?.getItem(SNAPSHOT_GENERATION_KEY) ?? '0') || 0 } catch { return 0 }
}

function snapshotStorageKey(key: string): string {
  return `${SNAPSHOT_PREFIX}${key}`
}

function snapshotFingerprint(json: string): string {
  // Two independent 32-bit hashes plus length make unchanged-payload detection
  // cheap without retaining a second multi-megabyte JSON string in memory.
  let fnv = 0x811c9dc5
  let djb = 0x1505
  for (let index = 0; index < json.length; index++) {
    const code = json.charCodeAt(index)
    fnv = Math.imul(fnv ^ code, 0x01000193)
    djb = Math.imul(djb, 33) ^ code
  }
  return `${json.length}:${(fnv >>> 0).toString(16)}:${(djb >>> 0).toString(16)}`
}

function snapshotHeader(raw: string | null): { at: number; generation?: number; fingerprint?: string } | undefined {
  if (!raw) return undefined
  // Current envelopes deliberately write these small fields first. Avoid
  // JSON-parsing (and therefore allocating) every compressed report merely to
  // compare or evict snapshot metadata.
  const current = /^\{"at":(\d+),"generation":(\d+),"fingerprint":"([^"]+)"/.exec(raw)
  if (current) return { at: Number(current[1]), generation: Number(current[2]), fingerprint: current[3] }
  try {
    const parsed = JSON.parse(raw) as { at?: number; generation?: number; fingerprint?: string }
    return { at: Number(parsed.at) || 0, generation: parsed.generation, fingerprint: parsed.fingerprint }
  } catch {
    return undefined
  }
}

/**
 * Whether a report is a finished answer rather than a first paint the producer
 * is still filling in, or a read-only serve that could not see real files.
 *
 * This is the one rule for both persistence AND display. Only persistence
 * honoured it before, so after a local-day rollover the resident serve child
 * re-derived the new day and the partials it served replaced a complete payload
 * on screen: `history.daily` came back with about 27 cost-bearing rows instead
 * of 125, and the streak, month-to-date and medians read off that same array
 * were wrong with it.
 */
export function isCompleteReport(value: unknown): boolean {
  if (!value || typeof value !== 'object') return true
  const report = value as { stale?: unknown; hydration?: { complete?: unknown } }
  return report.stale !== true && report.hydration?.complete !== false
}

function readDurableMemo<T>(key: string): { value: T; at: number; durable: true; sizeChars?: number } | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(snapshotStorageKey(key))
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as {
      value?: T
      data?: string
      encoding?: string
      at?: number
      generation?: number
    }
    if (parsed.generation !== snapshotGeneration()
      || !Number.isFinite(parsed.at)) return undefined
    if (parsed.encoding === 'lz-utf16' && typeof parsed.data === 'string') {
      const json = decompressFromUTF16(parsed.data)
      if (!json) return undefined
      return { value: JSON.parse(json) as T, at: parsed.at as number, durable: true, sizeChars: json.length }
    }
    // Backward-compatible read of the short-lived uncompressed development
    // format; the next success rewrites it compressed.
    if (!Object.prototype.hasOwnProperty.call(parsed, 'value')) return undefined
    return { value: parsed.value as T, at: parsed.at as number, durable: true }
  } catch {
    return undefined
  }
}

function memoGet<T>(key: string): { value: T; at: number; durable?: boolean; sizeChars?: number } | undefined {
  const memory = memoStore.get(key) as { value: T; at: number; durable?: boolean; sizeChars?: number } | undefined
  if (memory) {
    memoPut(key, memory)
    return memory
  }
  const durable = readDurableMemo<T>(key)
  if (durable) memoPut(key, durable)
  return durable
}

function memoSet(key: string, value: unknown): void {
  const at = Date.now()
  let json: string | undefined
  try { json = JSON.stringify(value) } catch { /* memory-only fallback */ }
  // A degraded report never displaces a complete one, in memory or on disk: the
  // memo is what a period switch paints from, so a partial cached here would
  // resurface as the answer long after the producer had converged.
  const held = memoStore.get(key)
  if (!isCompleteReport(value) && held && isCompleteReport(held.value)) return
  const entry = { value, at, sizeChars: json?.length }
  memoPut(key, entry)
  // Partial hydration and stale read-only reports are useful last-good data for
  // the current renderer, but must never become the restart-time exact answer.
  if (!isCompleteReport(value)) return
  try {
    const storage = globalThis.localStorage
    if (!storage) return
    if (json === undefined) return
    if (json.length > MAX_SNAPSHOT_SOURCE_CHARS) return
    const generation = snapshotGeneration()
    const fingerprint = snapshotFingerprint(json)
    const storageKey = snapshotStorageKey(key)
    const previous = snapshotHeader(storage.getItem(storageKey))
    // Polls commonly return byte-identical reports. Keep the existing durable
    // body instead of re-stringifying it into an envelope and recompressing it
    // every cadence tick; the in-memory timestamp above still records success.
    if (previous?.generation === generation && previous.fingerprint === fingerprint) return
    const raw = JSON.stringify({
      at,
      generation,
      fingerprint,
      encoding: 'lz-utf16',
      data: compressToUTF16(json),
    })
    if (raw.length > MAX_SNAPSHOT_CHARS) return
    // localStorage quotas differ by Electron/Chromium release. On quota pressure,
    // evict the oldest report and retry; the selected/latest snapshots win.
    for (let attempt = 0; attempt < MAX_STORED_SNAPSHOTS; attempt++) {
      try {
        storage.setItem(storageKey, raw)
        break
      } catch {
        if (!removeOldestDurableSnapshot(storage, storageKey)) return
      }
    }
    while (durableSnapshotCount(storage) > MAX_STORED_SNAPSHOTS) {
      if (!removeOldestDurableSnapshot(storage, storageKey)) break
    }
  } catch {
    // Storage can be disabled, full, or the value may not be serializable. The
    // in-memory fast path still works; persistence is a best-effort enhancement.
  }
}

function durableSnapshotRows(storage: Storage): Array<{ key: string; at: number }> {
  const rows: Array<{ key: string; at: number }> = []
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index)
    if (!key?.startsWith(SNAPSHOT_PREFIX)) continue
    rows.push({ key, at: snapshotHeader(storage.getItem(key))?.at ?? 0 })
  }
  return rows
}

function durableSnapshotCount(storage: Storage): number {
  return durableSnapshotRows(storage).length
}

function removeOldestDurableSnapshot(storage: Storage, except: string): boolean {
  const oldest = durableSnapshotRows(storage)
    .filter(row => row.key !== except)
    .sort((a, b) => a.at - b.at)[0]
  if (!oldest) return false
  storage.removeItem(oldest.key)
  return true
}

// Every CLI-backed fetch in the app routes through load() below, so one counter
// here is the whole app's "a refresh is in flight" signal.
let inFlight = 0
const inFlightListeners = new Set<() => void>()

function addInFlight(delta: number): void {
  inFlight += delta
  for (const listener of inFlightListeners) listener()
}

function subscribeInFlight(listener: () => void): () => void {
  inFlightListeners.add(listener)
  return () => { inFlightListeners.delete(listener) }
}

/** True while any polled fetch is running, in any section. Drives the top
 *  hairline and the footer refresh mark, both of which reserve their space. */
export function usePolledInFlight(): boolean {
  return useSyncExternalStore(subscribeInFlight, () => inFlight > 0, () => false)
}

/** Test-only: clear the module-level memo between renders so cached results from
 *  one test never bleed into the next. */
export function __resetPolledMemo(): void {
  memoStore.clear()
  memoSizeChars = 0
  memoEpoch++
  addInFlight(-inFlight)
}

/** Empty the instant-switch memo. Called when a Settings action mutates config
 *  that changes computed costs or currency (currency/alias/plan/price-override):
 *  a later provider/period switch must never paint a payload cached under the OLD
 *  config, which is what stuck the display on the previous currency. */
export function clearPolledMemo(): void {
  memoStore.clear()
  memoSizeChars = 0
  memoEpoch++
  try {
    const storage = globalThis.localStorage
    if (!storage) return
    // Generation invalidation is atomic and makes stale snapshots unreadable
    // even if storage enumeration/removal is interrupted or unavailable.
    storage.setItem(SNAPSHOT_GENERATION_KEY, String(snapshotGeneration() + 1))
    const keys: string[] = []
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index)
      if (key?.startsWith(SNAPSHOT_PREFIX)) keys.push(key)
    }
    for (const key of keys) storage.removeItem(key)
  } catch { /* storage can be unavailable */ }
}

/** Seed the instant-switch memo out of band. The prefetcher (App.tsx) warms the
 *  standard horizons and their first-click reports for the active provider so a
 *  period or destination switch paints from memory instead of waiting on a fresh
 *  CLI spawn. Keyed identically to the corresponding usePolled `memoKey`. */
export function primePolledMemo(key: string, value: unknown): void {
  memoSet(key, value)
}

/** Whether a live result is already memoized for `key`. A durable hit is promoted
 *  into the bounded memory LRU so the prefetcher can skip work already warmed. */
export function hasPolledMemo(key: string): boolean {
  return memoGet(key) !== undefined
}

/** Timestamp of the last fetch that produced the report for `key` IN THIS
 * renderer. A snapshot restored from disk is painted but never reported as a
 * refresh: it dates from an earlier app run, so claiming it here made the footer
 * announce a refresh that was hours old and had not happened. Reading this may
 * hydrate the in-memory memo from the versioned durable snapshot, but never
 * changes data. */
export function polledMemoTimestamp(key: string): number | null {
  const entry = memoGet(key)
  return entry && !entry.durable ? entry.at : null
}

/**
 * Generic CLI-backed data hook: fetches on mount + whenever `deps` change, then
 * re-polls every `intervalMs`. Errors are normalized to the CliError shape so
 * sections can branch on `error.kind`. Last-good data is retained on error.
 *
 * `intervalMs` defaults to the app-wide refresh cadence (Settings > General) via
 * context; pass one explicitly to override. `null` cadence (Manual) means no
 * setInterval — the fetcher runs only on mount, deps change, and refresh().
 *
 * `enabled` (default true) gates fetching: while false the hook stays in its
 * initial loading state and issues no CLI spawn. The app boot flow sets it false
 * on every section poll until the first overview resolves, so the one-time cold
 * cache hydration happens ONCE (via overview) instead of fanning out into a
 * parallel full-history parse per section.
 *
 * `memoKey` opts into the instant-switch memo above.
 */
export function usePolled<T>(
  fetcher: () => Promise<T>,
  deps: unknown[],
  opts: { intervalMs?: number | null; enabled?: boolean; memoKey?: string } = {},
): Polled<T> {
  const cadence = useContext(RefreshCadenceContext)
  const intervalMs = opts.intervalMs !== undefined ? opts.intervalMs : cadence.intervalMs
  const enabled = opts.enabled ?? true
  const memoKey = opts.memoKey
  const [data, setData] = useState<T | null>(() => (memoKey ? memoGet<T>(memoKey)?.value ?? null : null))
  const [dataKey, setDataKey] = useState<string | null>(() =>
    memoKey && memoGet<T>(memoKey) !== undefined ? memoKey : null)
  const [error, setError] = useState<CliError | null>(null)
  const [errorKey, setErrorKey] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [switching, setSwitching] = useState(false)
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null)
  const [degraded, setDegraded] = useState<T | null>(null)
  // Whether the value currently displayed is a finished answer, and the key it
  // belongs to. Refs because the resolve handler must read the CURRENT state,
  // not the one captured when the fetch started.
  const completeRef = useRef(false)
  const dataKeyRef = useRef<string | null>(null)
  // Generation counter: every load() (mount, deps change, interval, refresh)
  // claims the next epoch; a fetch applies its result only while its epoch is
  // still current. This is what keeps a slow fetch from an older deps/period
  // from clobbering a newer one that already resolved.
  const epochRef = useRef(0)
  // Wall-clock of the last successful fetch, mirrored out of state so the
  // visibilitychange catch-up can read it without re-subscribing on every poll.
  const lastSuccessRef = useRef<number | null>(null)
  // memoKey of the previous load, so a switch can be told from a same-key reload.
  const lastKeyRef = useRef<string | undefined>(undefined)

  const load = useCallback(() => {
    if (!enabled) return
    const epoch = ++epochRef.current
    const loadMemoEpoch = memoEpoch
    // A switch (new memoKey) may serve a still-fresh cached payload without
    // fetching; a reload on the same key never may.
    const keyChanged = memoKey !== undefined && memoKey !== lastKeyRef.current
    lastKeyRef.current = memoKey
    // Instant paint: on a deps/key change, if a last-good result for the new key
    // is cached, show it immediately and flag `switching` while the fresh fetch
    // runs. If there is NO cached result for the new key, clear stale data so the
    // section paints its loading/skeleton state — never the previous filter's
    // numbers. (An interval re-poll keeps the same key, whose last result is
    // always cached, so a background refresh never blanks.)
    let servedCached = false
    if (memoKey) {
      const cached = memoGet<T>(memoKey)
      if (cached !== undefined) {
        setData(cached.value)
        setDataKey(memoKey)
        dataKeyRef.current = memoKey
        completeRef.current = isCompleteReport(cached.value)
        setDegraded(null)
        servedCached = true
        // The footer's "refreshed Ns ago" must describe the payload on screen,
        // not this hook instance's last fetch of some other key. A durable entry
        // is a snapshot from an earlier app run, not a refresh this one made, so
        // it stamps nothing: the fetch below is what sets the clock.
        if (!cached.durable) {
          setLastSuccessAt(cached.at)
          lastSuccessRef.current = cached.at
        }
        // Still fresh, and this is a switch rather than a poll/manual refresh:
        // the painted answer is good enough, so skip the CLI spawn entirely.
        // A durable entry came from an earlier renderer lifetime. Paint it, but
        // always revalidate once even when it is only seconds old; disk data is
        // a snapshot, not proof that provider files have not changed meanwhile.
        if (keyChanged && !cached.durable && Date.now() - cached.at < POLLED_FRESH_MS) {
          setError(null)
          setErrorKey(null)
          setLoading(false)
          setSwitching(false)
          return
        }
      } else {
        setData(null)
        setDataKey(null)
        dataKeyRef.current = null
        completeRef.current = false
        setDegraded(null)
      }
    }
    setLoading(true)
    setSwitching(servedCached)
    // Clear any prior error at the start of each attempt so a fresh poll never
    // shows a stale banner while it is still in flight; last-good `data` stays.
    setError(null)
    setErrorKey(null)
    addInFlight(1)
    let pending: Promise<T>
    try {
      pending = fetcher()
    } catch (err) {
      addInFlight(-1)
      throw err
    }
    pending
      .then(result => {
        if (epochRef.current !== epoch || memoEpoch !== loadMemoEpoch) return
        setError(null)
        setErrorKey(null)
        // A finished answer is never given up for an unfinished one. The producer
        // keeps converging and the next poll replaces this; until then the screen
        // keeps the complete numbers and says indexing is still running.
        if (!isCompleteReport(result) && completeRef.current && dataKeyRef.current === (memoKey ?? null)) {
          setDegraded(result)
          return
        }
        setDegraded(null)
        setData(result)
        setDataKey(memoKey ?? null)
        dataKeyRef.current = memoKey ?? null
        completeRef.current = isCompleteReport(result)
        const at = Date.now()
        setLastSuccessAt(at)
        lastSuccessRef.current = at
        if (memoKey) memoSet(memoKey, result)
      })
      .catch(err => {
        if (epochRef.current !== epoch) return
        setError(normalizeCliError(err))
        setErrorKey(memoKey ?? null)
      })
      .finally(() => {
        addInFlight(-1)
        if (epochRef.current !== epoch) return
        setLoading(false)
        setSwitching(false)
      })
    // deps are intentionally the caller-provided dependency list; `enabled` and
    // `memoKey` are prepended so flipping the gate / key re-creates load and
    // fires immediately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, memoKey, ...deps])

  useEffect(() => {
    load()
    // Poll only while the window is visible. Each tick drives a CLI re-parse in
    // the resident serve child, and on a machine with active agent sessions the
    // watched roots change constantly, so every tick is a full-core parse. A
    // minimized/occluded window has no viewer to keep fresh; letting it poll was
    // the app's dominant idle energy drain. On return to visible the catch-up
    // below refreshes immediately, so freshness while looking is unchanged.
    const tick = () => load()
    // Manual cadence (intervalMs == null) skips the interval entirely.
    let id: ReturnType<typeof setInterval> | null = null
    const isVisible = () => typeof document === 'undefined' || document.visibilityState === 'visible'
    const startTicking = () => { if (id == null && intervalMs != null) id = setInterval(tick, intervalMs) }
    const stopTicking = () => { if (id != null) { clearInterval(id); id = null } }
    if (isVisible()) startTicking()
    // On return to visible, if the last success is older than a full cadence,
    // refresh once immediately instead of waiting up to intervalMs; then resume
    // ticking. On hide, stop ticking so no CLI work happens while unwatched.
    const onVisible = () => {
      if (intervalMs == null) return
      if (!isVisible()) { stopTicking(); return }
      const last = lastSuccessRef.current
      if (last == null || Date.now() - last >= intervalMs) load()
      startTicking()
    }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
    return () => {
      stopTicking()
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
      // Retire this generation so an in-flight fetch can't resolve into state
      // after unmount or a deps change.
      epochRef.current++
    }
  }, [load, intervalMs])

  const refresh = useCallback(() => {
    load()
  }, [load])

  // A dependency/key change renders before the effect above can swap state.
  // Mask the previous key synchronously in that render; if the new key is
  // already memoized, expose that matching value immediately instead. This
  // keeps the selected filter and every visible number consistent per frame,
  // not merely after effects have run.
  const renderMemo = memoKey ? memoGet<T>(memoKey) : undefined
  const keyMismatch = memoKey !== undefined && dataKey !== memoKey
  const renderedData = keyMismatch ? renderMemo?.value ?? null : data
  const renderedDataKey = keyMismatch ? (renderMemo ? memoKey : null) : dataKey
  // A durable entry dates from an earlier app run, so it stamps no refresh time
  // here either — same rule as `polledMemoTimestamp`.
  const renderedLastSuccessAt = keyMismatch && renderMemo ? (renderMemo.durable ? null : renderMemo.at) : lastSuccessAt
  const renderedLoading = keyMismatch ? true : loading
  const renderedSwitching = keyMismatch ? renderMemo !== undefined : switching
  const renderedError = memoKey !== undefined && errorKey !== memoKey ? null : error

  return {
    data: renderedData,
    dataKey: renderedDataKey,
    error: renderedError,
    loading: renderedLoading,
    // A refused partial means the producer is still working, which reads as
    // in-flight to every consumer of `switching`.
    switching: renderedSwitching || (keyMismatch ? false : degraded !== null),
    lastSuccessAt: renderedLastSuccessAt,
    degraded: keyMismatch ? null : degraded,
    refresh,
  }
}

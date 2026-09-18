import { open, rename, unlink, mkdir } from 'fs/promises'
import { existsSync, readFileSync, unlinkSync } from 'fs'
import { randomBytes } from 'crypto'
import { join } from 'path'

import { getCodeburnCacheDir } from './cache-dir.js'
import type { CachedCall, ProviderSection } from './session-cache.js'

// Sidecar ledger for Hermes lifetime totals that keep growing after a day is
// sealed. Contract (iamtoruk #1121 review):
//
// - Reset 150 → 0 → 40 is in contract: an all-zero (or shrinking) snapshot
//   advances last-seen without a negative observation; later growth is new
//   spend on the observation day.
// - Restores are out of contract: state.db restored from backup without
//   wiping the ledger ⇒ regrowth is re-credited; wipe both or accept it.
//   A post-reset high-water-mark guard is rejected: it would eat genuine
//   150→0→40 resets, which are treated as new spend by design.
// - Recovery horizon is the warm session-cache baseline. `seedHermesCursorsFromProviderSection`
//   copies cached lifetime totals into missing cursors so growth *since the
//   last warm parse* is recovered. Growth dropped *before* that parse stays
//   dropped: sealed days are not re-read. This slice does not bump
//   DAILY_CACHE_VERSION (one cold re-parse for every user) to recover history.

// v3 discards the local-only v2 migration candidate. Seeding v2 from the warm
// session cache could preserve lifetime totals while assigning historical
// observations to the migration day, inflating that day's scoped Hermes spend.
export const HERMES_SESSION_LEDGER_FILENAME = 'hermes-session-ledger.v3.json'
export const HERMES_SESSION_LEDGER_VERSION = 3 as const

export type HermesCostBasis = 'actual' | 'estimated' | 'calculated' | 'included'

export type HermesTokenTotals = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
}

export type HermesObservation = HermesTokenTotals & {
  /** 0 = first behavioral observation; 1+ = later weight-0 observations. */
  index: number
  timestamp: string
  costUSD: number
  costBasis: HermesCostBasis
  supplementaryAccounting: boolean
}

export type HermesLastSeen = HermesTokenTotals & {
  costUSD: number
  costBasis: HermesCostBasis
}

export type HermesSessionCursor = {
  profile: string
  sessionId: string
  lastSeen: HermesLastSeen
  observations: HermesObservation[]
}

export type HermesSessionLedger = {
  version: typeof HERMES_SESSION_LEDGER_VERSION
  cursors: Record<string, Record<string, HermesSessionCursor>>
}

export class HermesLedgerPublicationError extends Error {
  override readonly name = 'HermesLedgerPublicationError'
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

export function isHermesLedgerPublicationError(err: unknown): boolean {
  return err instanceof HermesLedgerPublicationError
}

const ZERO_TOKENS: HermesTokenTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
}

let nowFn: () => Date = () => new Date()
let memory: HermesSessionLedger | null = null
let memoryDir: string | null = null

export function setHermesLedgerNow(fn: () => Date): void {
  nowFn = fn
}

export function resetHermesLedgerNow(): void {
  nowFn = () => new Date()
}

export function hermesLedgerNow(): Date {
  return nowFn()
}

export function hermesSessionLedgerPath(): string {
  return join(getCodeburnCacheDir(), HERMES_SESSION_LEDGER_FILENAME)
}

export function emptyHermesSessionLedger(): HermesSessionLedger {
  return { version: HERMES_SESSION_LEDGER_VERSION, cursors: {} }
}

export function resetHermesSessionLedgerForTests(): void {
  memory = null
  memoryDir = null
  nowFn = () => new Date()
}

export function parseHermesDedupKey(key: string): { profile: string; sessionId: string; observationIndex?: number } | null {
  if (!key.startsWith('hermes:')) return null
  const rest = key.slice('hermes:'.length)
  const obsMatch = rest.match(/^(.*):obs:(\d+)$/)
  const body = obsMatch ? obsMatch[1]! : rest
  const colon = body.indexOf(':')
  if (colon <= 0) return null
  const profile = body.slice(0, colon)
  const sessionId = body.slice(colon + 1)
  if (!profile || !sessionId) return null
  return {
    profile,
    sessionId,
    observationIndex: obsMatch ? Number(obsMatch[2]) : undefined,
  }
}

export function isHermesObservationKey(key: string): boolean {
  return key.startsWith('hermes:') && /:obs:\d+$/.test(key)
}

export function hermesBaselineKey(profile: string, sessionId: string): string {
  return `hermes:${profile}:${sessionId}`
}

export function hermesObservationKey(profile: string, sessionId: string, n: number): string {
  return `hermes:${profile}:${sessionId}:obs:${n}`
}

export function getHermesCursor(ledger: HermesSessionLedger, profile: string, sessionId: string): HermesSessionCursor | undefined {
  return ledger.cursors[profile]?.[sessionId]
}

export function listHermesCursorSessionIds(ledger: HermesSessionLedger, profile: string): string[] {
  return Object.keys(ledger.cursors[profile] ?? {})
}

export function zeroHermesTokens(): HermesTokenTotals {
  return { ...ZERO_TOKENS }
}

function tokenList(t: HermesTokenTotals): number[] {
  return [t.inputTokens, t.outputTokens, t.cacheReadTokens, t.cacheWriteTokens, t.reasoningTokens]
}

function tokensGte(curr: HermesTokenTotals, last: HermesTokenTotals): boolean {
  const a = tokenList(curr)
  const b = tokenList(last)
  return a.every((v, i) => v >= b[i]!)
}

function tokensEqual(a: HermesTokenTotals, b: HermesTokenTotals): boolean {
  return tokenList(a).every((v, i) => v === tokenList(b)[i])
}

function subtractTokens(curr: HermesTokenTotals, last: HermesTokenTotals): HermesTokenTotals {
  return {
    inputTokens: curr.inputTokens - last.inputTokens,
    outputTokens: curr.outputTokens - last.outputTokens,
    cacheReadTokens: curr.cacheReadTokens - last.cacheReadTokens,
    cacheWriteTokens: curr.cacheWriteTokens - last.cacheWriteTokens,
    reasoningTokens: curr.reasoningTokens - last.reasoningTokens,
  }
}

function hasPositiveTokenDelta(delta: HermesTokenTotals): boolean {
  return tokenList(delta).some(v => v > 0)
}

export type HermesSnapshot = {
  profile: string
  sessionId: string
  startedAt: string
  observedAt: string
  tokens: HermesTokenTotals
  costUSD: number
  costBasis: HermesCostBasis
}

export function applyHermesSnapshot(
  existing: HermesSessionCursor | undefined,
  snapshot: HermesSnapshot,
): { cursor: HermesSessionCursor; dirty: boolean } {
  if (!existing) {
    const first: HermesObservation = {
      index: 0,
      timestamp: snapshot.startedAt,
      ...snapshot.tokens,
      costUSD: snapshot.costUSD,
      costBasis: snapshot.costBasis,
      supplementaryAccounting: false,
    }
    return {
      cursor: {
        profile: snapshot.profile,
        sessionId: snapshot.sessionId,
        lastSeen: {
          ...snapshot.tokens,
          costUSD: snapshot.costUSD,
          costBasis: snapshot.costBasis,
        },
        observations: [first],
      },
      dirty: true,
    }
  }

  const last = existing.lastSeen
  const sameCost = snapshot.costUSD === last.costUSD && snapshot.costBasis === last.costBasis
  if (tokensEqual(snapshot.tokens, last) && sameCost) {
    return { cursor: existing, dirty: false }
  }

  // Shrink, including all-zero: new baseline. Do not emit a negative. Keep sealed history.
  if (!tokensGte(snapshot.tokens, last)) {
    return {
      cursor: {
        ...existing,
        lastSeen: {
          ...snapshot.tokens,
          costUSD: snapshot.costUSD,
          costBasis: snapshot.costBasis,
        },
      },
      dirty: true,
    }
  }

  const tokenDelta = subtractTokens(snapshot.tokens, last)
  const positiveTokens = hasPositiveTokenDelta(tokenDelta)
  const costGrew = snapshot.costUSD >= last.costUSD
  const costDelta = costGrew ? snapshot.costUSD - last.costUSD : 0

  // Before billing-mode-v1, warm-cache recovery labelled every non-estimated
  // baseline `actual`, including an included $0 subscription call. Repair only
  // that exact one-observation seed when the live cumulative row now supplies
  // the stronger included fact. Multi-observation histories are real deltas and
  // keep each stored basis unchanged.
  const first = existing.observations[0]
  const legacyIncludedSeed = snapshot.costBasis === 'included'
    && snapshot.costUSD === 0
    && last.costBasis === 'actual'
    && last.costUSD === 0
    && existing.observations.length === 1
    && first?.index === 0
    && first.costBasis === 'actual'
    && first.costUSD === 0
    && tokensEqual(first, snapshot.tokens)
  if (!positiveTokens && costDelta === 0 && legacyIncludedSeed) {
    return {
      cursor: {
        ...existing,
        lastSeen: { ...snapshot.tokens, costUSD: 0, costBasis: 'included' },
        observations: [{ ...first, costBasis: 'included' }],
      },
      dirty: true,
    }
  }

  if (!positiveTokens && costDelta === 0) {
    // Tokens held (or only cost reset / basis change). Advance last-seen, no observation.
    return {
      cursor: {
        ...existing,
        lastSeen: {
          ...snapshot.tokens,
          costUSD: snapshot.costUSD,
          costBasis: snapshot.costBasis,
        },
      },
      dirty: true,
    }
  }

  const nextIndex = existing.observations.reduce((max, obs) => Math.max(max, obs.index), 0) + 1
  const observation: HermesObservation = {
    index: nextIndex,
    timestamp: snapshot.observedAt,
    ...tokenDelta,
    costUSD: costDelta,
    costBasis: snapshot.costBasis,
    supplementaryAccounting: true,
  }
  return {
    cursor: {
      ...existing,
      lastSeen: {
        ...snapshot.tokens,
        costUSD: snapshot.costUSD,
        costBasis: snapshot.costBasis,
      },
      observations: [...existing.observations, observation],
    },
    dirty: true,
  }
}

function putCursor(ledger: HermesSessionLedger, cursor: HermesSessionCursor): HermesSessionLedger {
  return {
    version: HERMES_SESSION_LEDGER_VERSION,
    cursors: {
      ...ledger.cursors,
      [cursor.profile]: {
        ...(ledger.cursors[cursor.profile] ?? {}),
        [cursor.sessionId]: cursor,
      },
    },
  }
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isCostBasis(v: unknown): v is HermesCostBasis {
  return v === 'actual' || v === 'estimated' || v === 'calculated' || v === 'included'
}

function validateTokens(o: Record<string, unknown>): o is Record<string, unknown> & HermesTokenTotals {
  return isNum(o['inputTokens'])
    && isNum(o['outputTokens'])
    && isNum(o['cacheReadTokens'])
    && isNum(o['cacheWriteTokens'])
    && isNum(o['reasoningTokens'])
}

function validateObservation(v: unknown): v is HermesObservation {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return validateTokens(o)
    && isNum(o['index'])
    && typeof o['timestamp'] === 'string'
    && isNum(o['costUSD'])
    && isCostBasis(o['costBasis'])
    && typeof o['supplementaryAccounting'] === 'boolean'
}

function validateCursor(v: unknown): v is HermesSessionCursor {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  if (typeof o['profile'] !== 'string' || typeof o['sessionId'] !== 'string') return false
  if (!o['lastSeen'] || typeof o['lastSeen'] !== 'object') return false
  const last = o['lastSeen'] as Record<string, unknown>
  if (!validateTokens(last) || !isNum(last['costUSD']) || !isCostBasis(last['costBasis'])) return false
  if (!Array.isArray(o['observations']) || !o['observations'].every(validateObservation)) return false
  return true
}

function validateLedger(raw: unknown): raw is HermesSessionLedger {
  if (!raw || typeof raw !== 'object') return false
  const o = raw as Record<string, unknown>
  if (o['version'] !== HERMES_SESSION_LEDGER_VERSION) return false
  if (!o['cursors'] || typeof o['cursors'] !== 'object' || Array.isArray(o['cursors'])) return false
  for (const profileCursors of Object.values(o['cursors'] as Record<string, unknown>)) {
    if (!profileCursors || typeof profileCursors !== 'object' || Array.isArray(profileCursors)) return false
    if (!Object.values(profileCursors as Record<string, unknown>).every(validateCursor)) return false
  }
  return true
}

function readLedgerFromDisk(): HermesSessionLedger {
  const path = hermesSessionLedgerPath()
  if (!existsSync(path)) {
    // The v1 file is superseded and can never be read again: the parse-version
    // bump forces a cold re-parse that rebuilds every cursor from source.
    // Left behind it is dead bytes that only invite a future reader to trust
    // observations recorded under an accounting this branch replaced.
    const v1 = join(getCodeburnCacheDir(), 'hermes-session-ledger.v1.json')
    if (existsSync(v1)) {
      try { unlinkSync(v1) } catch { /* another process got there first */ }
    }
    return emptyHermesSessionLedger()
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    if (!validateLedger(parsed)) return emptyHermesSessionLedger()
    return parsed
  } catch {
    return emptyHermesSessionLedger()
  }
}

export function loadHermesSessionLedger(): HermesSessionLedger {
  const dir = getCodeburnCacheDir()
  if (memory && memoryDir === dir) return memory
  const loaded = readLedgerFromDisk()
  memory = loaded
  memoryDir = dir
  return loaded
}

async function writeFileAtomic(finalPath: string, payload: string): Promise<void> {
  const tempPath = `${finalPath}.${randomBytes(8).toString('hex')}.tmp`
  const handle = await open(tempPath, 'w', 0o600)
  try {
    await handle.writeFile(payload, { encoding: 'utf-8' })
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await rename(tempPath, finalPath)
        return
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if ((code !== 'EPERM' && code !== 'EBUSY') || attempt === 2) throw err
        await new Promise(resolve => { setTimeout(resolve, 10 * (attempt + 1)) })
      }
    }
  } catch (err) {
    await unlink(tempPath).catch(() => undefined)
    throw err
  }
}

export async function persistHermesSessionLedger(ledger: HermesSessionLedger): Promise<void> {
  const dir = getCodeburnCacheDir()
  const finalPath = join(dir, HERMES_SESSION_LEDGER_FILENAME)
  try {
    await mkdir(dir, { recursive: true })
    await writeFileAtomic(finalPath, JSON.stringify(ledger))
  } catch (err) {
    throw new HermesLedgerPublicationError(
      `failed to publish Hermes session ledger at ${finalPath}`,
      { cause: err },
    )
  }
  memory = ledger
  memoryDir = dir
}

export async function recordHermesSnapshot(snapshot: HermesSnapshot): Promise<HermesSessionCursor> {
  const ledger = loadHermesSessionLedger()
  const existing = getHermesCursor(ledger, snapshot.profile, snapshot.sessionId)
  const { cursor, dirty } = applyHermesSnapshot(existing, snapshot)
  if (dirty) await persistHermesSessionLedger(putCursor(ledger, cursor))
  return cursor
}

function cachedCallToSnapshotTokens(call: CachedCall): HermesTokenTotals {
  return {
    inputTokens: call.usage.inputTokens,
    outputTokens: call.usage.outputTokens,
    cacheReadTokens: call.usage.cacheReadInputTokens,
    cacheWriteTokens: call.usage.cacheCreationInputTokens,
    reasoningTokens: call.usage.reasoningTokens,
  }
}

export async function seedHermesCursorsFromProviderSection(section: ProviderSection): Promise<void> {
  // Seeds missing cursors from the already-loaded warm cache so the next
  // observation is a delta against last-seen lifetime, not a dump of the
  // whole session at `now`. Does not re-read sealed days: historically
  // dropped growth stays dropped (see file-level contract).
  const ledger = loadHermesSessionLedger()
  let next = ledger
  let dirty = false
  for (const file of Object.values(section.files)) {
    for (const turn of file.turns) {
      for (const call of turn.calls) {
        if (call.provider !== 'hermes') continue
        const parsed = parseHermesDedupKey(call.deduplicationKey)
        if (!parsed || parsed.observationIndex != null) continue
        if (getHermesCursor(next, parsed.profile, parsed.sessionId)) continue
        const tokens = cachedCallToSnapshotTokens(call)
        const costUSD = call.costUSD ?? 0
        const costBasis: HermesCostBasis = call.billing === 'subscription'
          ? 'included'
          : call.billing === 'metered'
            ? 'actual'
            : call.isEstimated ? 'calculated' : 'actual'
        const cursor: HermesSessionCursor = {
          profile: parsed.profile,
          sessionId: parsed.sessionId,
          lastSeen: { ...tokens, costUSD, costBasis },
          observations: [{
            index: 0,
            timestamp: call.timestamp,
            ...tokens,
            costUSD,
            costBasis,
            supplementaryAccounting: false,
          }],
        }
        next = putCursor(next, cursor)
        dirty = true
      }
    }
  }
  if (dirty) await persistHermesSessionLedger(next)
}

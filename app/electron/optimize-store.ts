import fs from 'node:fs'
import path from 'node:path'

/** The `optimize` block of a menubar-json payload — the only part of the scan
 *  the Overview and Optimize pages read. */
export type OptimizeBlock = {
  findingCount: number
  savingsUSD: number
  topFindings: Array<{ title: string; impact: 'high' | 'medium' | 'low'; savingsUSD: number }>
}

export type OptimizeSnapshot = {
  /** The exact argv this scan was computed for (period, provider, project
   *  filter, config source, scope). A result is only ever served back for the
   *  identical scope, so one period's savings can never surface under another. */
  scope: string
  computedAt: string
  appVersion: string
  optimize: OptimizeBlock
}

const FILE = 'optimize-snapshots.json'
// A handful of scopes (the period picker, a provider switch) is all a user
// cycles through; past that the oldest entry is dropped.
const MAX_ENTRIES = 8

function storePath(dir: string): string {
  return path.join(dir, FILE)
}

function isSnapshot(value: unknown): value is OptimizeSnapshot {
  if (!value || typeof value !== 'object') return false
  const row = value as Partial<OptimizeSnapshot>
  const block = row.optimize as Partial<OptimizeBlock> | undefined
  return typeof row.scope === 'string'
    && typeof row.computedAt === 'string'
    && typeof row.appVersion === 'string'
    && !!block
    && typeof block.findingCount === 'number'
    && typeof block.savingsUSD === 'number'
    && Array.isArray(block.topFindings)
}

/**
 * Whether two instants fall on the same LOCAL calendar day.
 *
 * Age alone is not freshness here. Every period the scan is computed for
 * ('today', 'week', '30days', 'month', …) is anchored to the local day, so a
 * scan taken at 23:50 describes a different window than a request at 00:10 even
 * though it is 20 minutes old. A cached scan is only ever served on the day it
 * was computed.
 */
export function sameLocalDay(a: number, b: number): boolean {
  const left = new Date(a)
  const right = new Date(b)
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate()
}

/** Every stored scan, newest first. A missing, unreadable or corrupt file reads
 *  as empty: the caller then recomputes, which is always safe. */
export function readOptimizeSnapshots(dir: string): OptimizeSnapshot[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(storePath(dir), 'utf8'))
    return Array.isArray(parsed) ? parsed.filter(isSnapshot) : []
  } catch {
    return []
  }
}

/** The stored scan for exactly this scope and app version, or null. */
export function readOptimizeSnapshot(dir: string, scope: string, appVersion: string): OptimizeSnapshot | null {
  return readOptimizeSnapshots(dir).find(row => row.scope === scope && row.appVersion === appVersion) ?? null
}

export function writeOptimizeSnapshot(dir: string, snapshot: OptimizeSnapshot): void {
  try {
    // A row from another app version can never be served, so it only takes up a
    // slot under the cap. Drop those before capping.
    const rows = [snapshot, ...readOptimizeSnapshots(dir)
      .filter(row => row.scope !== snapshot.scope && row.appVersion === snapshot.appVersion)]
      .slice(0, MAX_ENTRIES)
    fs.mkdirSync(dir, { recursive: true })
    const target = storePath(dir)
    const tmp = `${target}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(rows), 'utf8')
    fs.renameSync(tmp, target)
  } catch {
    // A cache that cannot be written is not an error the user needs: the next
    // open recomputes.
  }
}

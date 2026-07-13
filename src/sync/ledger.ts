/**
 * codeburn sync — sent-ledger.
 *
 * Client-side deduplication: tracks which calls have been successfully pushed.
 * Push logic: window minus ledger = what to send.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, renameSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export interface LedgerEntry {
  key: string  // deduplicationKey
  ts: string   // call timestamp (for pruning)
}

const SIX_MONTHS_MS = 180 * 24 * 60 * 60 * 1000

function cacheDir(): string {
  // Honor XDG_CACHE_HOME — the ledger is reconstructible state, not config
  const xdg = process.env.XDG_CACHE_HOME
  const base = xdg && xdg.trim() ? xdg : join(homedir(), '.cache')
  return join(base, 'codeburn')
}

function ledgerPath(): string {
  return join(cacheDir(), 'sync-ledger.json')
}

export function readLedger(): LedgerEntry[] {
  const path = ledgerPath()
  if (!existsSync(path)) return []
  try {
    const raw = readFileSync(path, 'utf-8')
    const entries = JSON.parse(raw) as unknown
    if (!Array.isArray(entries)) return []
    return entries.filter(
      (e): e is LedgerEntry => typeof e === 'object' && e !== null && typeof e.key === 'string'
    )
  } catch {
    return []
  }
}

export function writeLedger(entries: LedgerEntry[]): void {
  const dir = cacheDir()
  mkdirSync(dir, { recursive: true })
  // Atomic write: a crash mid-write must not corrupt the ledger — a corrupt
  // ledger reads as empty and the next push re-sends the whole window.
  const path = ledgerPath()
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(entries))
  renameSync(tmp, path)
}

/** Append new entries after a successful push. Also prunes entries older than 6 months. */
export function appendToLedger(newEntries: LedgerEntry[]): void {
  const existing = readLedger()
  const cutoff = new Date(Date.now() - SIX_MONTHS_MS).toISOString()

  // Prune old + dedupe
  const keySet = new Set(existing.map(e => e.key))
  const pruned = existing.filter(e => !e.ts || e.ts > cutoff)

  for (const entry of newEntries) {
    if (!keySet.has(entry.key)) {
      pruned.push(entry)
      keySet.add(entry.key)
    }
  }

  writeLedger(pruned)
}

/** Get the set of already-sent deduplication keys for fast lookup. */
export function ledgerKeySet(): Set<string> {
  return new Set(readLedger().map(e => e.key))
}

/** Clear the ledger (for sync reset). Returns the number of entries removed. */
export function clearLedger(): number {
  const path = ledgerPath()
  if (!existsSync(path)) return 0
  const count = readLedger().length
  unlinkSync(path)
  return count
}

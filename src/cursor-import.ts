import { createHash, randomBytes } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'fs/promises'
import { dirname, join } from 'path'

import { getCodeburnCacheDir } from './cache-dir.js'
import { calculateCost } from './models.js'
import type { ParsedProviderCall, SessionParser, SessionSource } from './providers/types.js'

// Cursor's dashboard export (cursor.com/dashboard/usage, Export CSV): one row
// per usage event, with the token split and cost Cursor itself recorded. The
// import replaces CodeBurn's local Cursor estimates for the time it covers.

export const CURSOR_CSV_HEADER = [
  'Date', 'Cloud Agent ID', 'Automation ID', 'Kind', 'Model', 'Max Mode',
  'Input (w/ Cache Write)', 'Input (w/o Cache Write)', 'Cache Read', 'Output Tokens', 'Total Tokens', 'Cost',
] as const

export const CURSOR_IMPORT_KEY_PREFIX = 'cursor-import:'
const CURSOR_IMPORT_PROJECT = 'Cursor (imported)'
const GROK_BOT_IMPORT_PROJECT = 'Grok Bot (imported)'

// Local providers whose usage the export also carries: the Cursor IDE and the
// Cursor Agent CLI bill the same account. Grok Bot runs on Cursor's servers
// and bills the account too, but its local mirror is only replaced when the
// export actually holds Grok Bot events (see coverageFor).
const REPLACED_PROVIDERS = ['cursor', 'cursor-agent']
const GROK_BOT_PROVIDER = 'grokbot'

export type CursorUsageEvent = {
  hash: string
  date: string
  cloudAgentId: string
  automationId: string
  kind: string
  model: string
  maxMode: string
  inputCacheWrite: number
  input: number
  cacheRead: number
  output: number
  cost: string
  // Downloaded by cursor-sync.ts rather than imported from a CSV file. A later
  // sync of the same account may replace these inside its window; manually
  // imported rows are never replaced. `account` is cursor-sync's short hash.
  source?: 'sync'
  account?: string
}

export type CoverageRange = { start: string; end: string; source?: 'sync'; account?: string }

export type CursorImportStore = {
  version: 1
  ranges: CoverageRange[]
  events: CursorUsageEvent[]
}

// Beside the daily cache, CodeBurn's other never-swept record of history.
export function cursorImportPath(): string {
  return join(getCodeburnCacheDir(), 'imports', 'cursor-usage.v1.json')
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i++ }
      else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { fields.push(field); field = '' }
    else field += ch
  }
  fields.push(field)
  return fields
}

function tokenCount(value: string, line: number, column: string): number {
  if (value === '') return 0
  if (!/^\d+$/.test(value)) throw new Error(`line ${line}: ${column} is not a token count: "${value}"`)
  return Number(value)
}

function isGrokBotModel(model: string): boolean {
  return model.startsWith('grok-bot-')
}

/// Dollar amount in the Cost column, or null for plan-covered rows
/// ("Included", "Free") and anything else that names no amount.
function billedCost(cost: string): number | null {
  const m = /^\$?(\d+(?:\.\d+)?)$/.exec(cost.trim())
  return m ? Number(m[1]) : null
}

export function parseCursorUsageCsv(text: string): CursorUsageEvent[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  const header = parseCsvLine(lines[0] ?? '')
  if (header.length !== CURSOR_CSV_HEADER.length || header.some((h, i) => h.trim() !== CURSOR_CSV_HEADER[i])) {
    throw new Error(
      'not a Cursor usage export. Expected the header from cursor.com/dashboard/usage (Export CSV):\n' +
      `  ${CURSOR_CSV_HEADER.join(',')}\n` +
      `got:\n  ${(lines[0] ?? '').slice(0, 300)}`,
    )
  }
  const events: CursorUsageEvent[] = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === '') continue
    const f = parseCsvLine(line)
    if (f.length !== CURSOR_CSV_HEADER.length) throw new Error(`line ${i + 1}: expected ${CURSOR_CSV_HEADER.length} fields, got ${f.length}`)
    const [date, cloudAgentId, automationId, kind, model, maxMode, cw, inp, cr, out, total, cost] = f as [string, string, string, string, string, string, string, string, string, string, string, string]
    if (Number.isNaN(Date.parse(date)) || !date.endsWith('Z')) throw new Error(`line ${i + 1}: Date is not a UTC timestamp: "${date}"`)
    if (!model) throw new Error(`line ${i + 1}: Model is empty`)
    const event: CursorUsageEvent = {
      hash: createHash('sha256').update(f.join('\u001f')).digest('hex').slice(0, 32),
      date: new Date(date).toISOString(),
      cloudAgentId, automationId, kind, model, maxMode,
      inputCacheWrite: tokenCount(cw, i + 1, CURSOR_CSV_HEADER[6]),
      input: tokenCount(inp, i + 1, CURSOR_CSV_HEADER[7]),
      cacheRead: tokenCount(cr, i + 1, CURSOR_CSV_HEADER[8]),
      output: tokenCount(out, i + 1, CURSOR_CSV_HEADER[9]),
      cost,
    }
    if (total !== '' && tokenCount(total, i + 1, CURSOR_CSV_HEADER[10]) !== event.inputCacheWrite + event.input + event.cacheRead + event.output) {
      throw new Error(`line ${i + 1}: Total Tokens does not equal the sum of the input, cache and output columns`)
    }
    events.push(event)
  }
  return events
}

/// `2026-08-27`, an ISO instant, or epoch milliseconds (what the dashboard's
/// export URL carries). A bare date is a whole local day, the same day reports
/// bucket by: its start for `from`, its last millisecond for `to`.
export function parseBoundary(value: string, edge: 'from' | 'to'): number {
  const v = value.trim()
  let ms: number
  if (/^\d{9,}$/.test(v)) ms = Number(v)
  else if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split('-').map(Number) as [number, number, number]
    ms = edge === 'to' ? new Date(y, m - 1, d + 1).getTime() - 1 : new Date(y, m - 1, d).getTime()
  }
  else ms = Date.parse(v)
  if (Number.isNaN(ms)) throw new Error(`--${edge} must be a date (2026-08-27), an ISO timestamp or epoch milliseconds, got "${value}"`)
  return ms
}

function localDayStart(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function localDayEnd(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() - 1
}

/// The span one export covers. The export records no range of its own, so it
/// is the `--from`/`--to` the user exported with, else the local days of its
/// first and last event, so no report day is split between imported and local
/// usage. The end never passes the moment the file was saved: usage after the
/// export is not in it and keeps its local estimate.
function exportCoverage(
  events: CursorUsageEvent[],
  fileSavedMs: number,
  from?: number,
  to?: number,
): { start: number; end: number; inferred: boolean } {
  const times = events.map(e => Date.parse(e.date))
  const first = Math.min(...times)
  const last = Math.max(...times)
  const start = from ?? localDayStart(first)
  const declaredEnd = to ?? localDayEnd(last)
  if (start > declaredEnd) throw new Error('--from is after --to')
  if (first < start || last > declaredEnd) {
    throw new Error(`the export holds events from ${new Date(first).toISOString()} to ${new Date(last).toISOString()}, outside ${new Date(start).toISOString()} .. ${new Date(declaredEnd).toISOString()}`)
  }
  return { start, end: Math.min(declaredEnd, Math.max(fileSavedMs, last)), inferred: from === undefined || to === undefined }
}

// Each account's synced coverage is merged apart from imported coverage and
// from other accounts', so it stays attributable to the export it came from.
function mergeRanges(ranges: CoverageRange[]): CoverageRange[] {
  const groups = new Map<string, Pick<CoverageRange, 'source' | 'account'>>()
  for (const r of ranges) groups.set(`${r.source ?? ''}\0${r.account ?? ''}`, { source: r.source, account: r.account })
  return [...groups.values()].flatMap(({ source, account }) => {
    const sorted = ranges.filter(r => r.source === source && r.account === account)
      .map(r => [Date.parse(r.start), Date.parse(r.end)] as [number, number]).sort((a, b) => a[0] - b[0])
    const out: Array<[number, number]> = []
    for (const r of sorted) {
      const last = out[out.length - 1]
      if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1])
      else out.push([...r])
    }
    return out.map(([s, e]) => ({ start: new Date(s).toISOString(), end: new Date(e).toISOString(), ...(source ? { source } : {}), ...(account ? { account } : {}) }))
  })
}

let memo: { key: string; store: CursorImportStore | null } | null = null

export async function loadCursorImport(): Promise<CursorImportStore | null> {
  const path = cursorImportPath()
  let key: string
  try {
    const s = await stat(path)
    key = `${path}\0${s.ino}\0${s.mtimeMs}\0${s.size}`
  } catch {
    return null
  }
  if (memo?.key === key) return memo.store
  const parsed = JSON.parse(await readFile(path, 'utf-8')) as CursorImportStore
  if (parsed?.version !== 1 || !Array.isArray(parsed.events) || !Array.isArray(parsed.ranges)) {
    throw new Error(`unrecognized Cursor import file ${path}; remove it with \`codeburn import cursor --remove\``)
  }
  memo = { key, store: parsed }
  return parsed
}

async function saveCursorImport(store: CursorImportStore): Promise<void> {
  const path = cursorImportPath()
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${randomBytes(8).toString('hex')}.tmp`
  await writeFile(tmp, JSON.stringify(store) + '\n', 'utf-8')
  await rename(tmp, path)
}

export type CursorImportSummary = {
  changed: boolean
  added: number
  skipped: number
  total: number
  coverage: { start: string; end: string; inferred: boolean }
  firstEvent: string
  lastEvent: string
  tokens: number
  grokBotTokens: number
  grokBotEvents: number
}

export async function importCursorCsv(csvPath: string, opts: { from?: number; to?: number } = {}): Promise<CursorImportSummary> {
  const [text, fileStat] = await Promise.all([readFile(csvPath, 'utf-8'), stat(csvPath)])
  return (await importCursorCsvText(text, fileStat.mtimeMs, opts))!
}

/// A sync (`source: 'sync'`, `from` required) covers `from` to its newest
/// event, so usage after that keeps its local estimate, and it replaces the
/// same account's synced events from `from` on. Manually imported events and
/// other accounts' synced events are never replaced, and a row already stored
/// is skipped by its hash. A sync with no events returns null and changes no
/// stored usage.
export async function importCursorCsvText(
  text: string,
  savedMs: number,
  opts: { from?: number; to?: number; source?: 'sync'; account?: string } = {},
): Promise<CursorImportSummary | null> {
  const sync = opts.source === 'sync'
  // Rows before a sync's window are already stored by an earlier sync; a
  // server that rounds startDate down must not fail every later sync.
  const incoming = parseCursorUsageCsv(text).filter(e => !sync || Date.parse(e.date) >= opts.from!)
  if (incoming.length === 0) {
    if (!sync) throw new Error('the export holds no usage events')
    // An empty store records that this machine has synced, so a quiet account
    // is not downloaded from scratch again.
    if (!existsSync(cursorImportPath())) await saveCursorImport({ version: 1, ranges: [], events: [] })
    return null
  }
  let coverage: { start: number; end: number; inferred: boolean }
  if (sync) {
    coverage = { start: opts.from!, end: Math.max(...incoming.map(e => Date.parse(e.date))), inferred: false }
  } else {
    coverage = exportCoverage(incoming, savedMs, opts.from, opts.to)
  }

  const existing = await loadCursorImport()
  const replaced = new Set(sync ? existing?.events.filter(e => e.source === 'sync' && e.account === opts.account && Date.parse(e.date) >= coverage.start) : [])
  const before = new Set(existing?.events.map(e => e.hash))
  const byHash = new Map((existing?.events ?? []).filter(e => !replaced.has(e)).map(e => [e.hash, e]))
  // Manual coverage wins inside its range: a row Cursor revised there would
  // otherwise be priced twice, once as the manual row and once as the sync's.
  const manualRanges = sync ? (existing?.ranges ?? []).filter(r => !r.source).map(r => [Date.parse(r.start), Date.parse(r.end)] as const) : []
  let added = 0
  let converted = 0
  for (const e of incoming) {
    const stored = byHash.get(e.hash)
    if (stored) {
      // A manual import claims a row a sync stored first, so no later sync
      // replace can delete a row manual coverage relies on.
      if (!sync && stored.source === 'sync') {
        const { source: _source, account: _account, ...manual } = stored
        byHash.set(e.hash, manual)
        converted++
      }
      continue
    }
    const ms = Date.parse(e.date)
    if (manualRanges.some(([start, end]) => ms >= start && ms <= end)) continue
    byHash.set(e.hash, sync ? { ...e, source: 'sync', ...(opts.account ? { account: opts.account } : {}) } : e)
    if (!before.has(e.hash)) added++
  }
  const removed = [...replaced].filter(e => !byHash.has(e.hash)).length
  const events = [...byHash.values()].sort((a, b) => a.date.localeCompare(b.date))
  const range = { start: new Date(coverage.start).toISOString(), end: new Date(coverage.end).toISOString() }
  const ranges = mergeRanges([...(existing?.ranges ?? []), sync ? { ...range, source: 'sync', ...(opts.account ? { account: opts.account } : {}) } : range])
  // An unchanged store keeps its mtime, so a repeat import re-parses nothing.
  const changed = added > 0 || removed > 0 || converted > 0 || JSON.stringify(ranges) !== JSON.stringify(existing?.ranges)
  if (changed) await saveCursorImport({ version: 1, ranges, events })

  const tokensOf = (e: CursorUsageEvent) => e.inputCacheWrite + e.input + e.cacheRead + e.output
  const bot = incoming.filter(e => isGrokBotModel(e.model))
  const times = incoming.map(e => e.date).sort()
  return {
    changed,
    added,
    skipped: incoming.length - added,
    total: events.length,
    coverage: { ...range, inferred: coverage.inferred },
    firstEvent: times[0]!,
    lastEvent: times[times.length - 1]!,
    tokens: incoming.reduce((s, e) => s + tokensOf(e), 0),
    grokBotTokens: bot.reduce((s, e) => s + tokensOf(e), 0),
    grokBotEvents: bot.length,
  }
}

/// Deletes the import and returns the coverage it held, so the caller can
/// re-derive those days from the local estimates again.
export async function removeCursorImport(): Promise<CoverageRange[] | null> {
  const store = await loadCursorImport().catch(() => null)
  try {
    await unlink(cursorImportPath())
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  memo = null
  return store?.ranges ?? []
}

type ImportCoverage = { ranges: Array<[number, number]>; providers: ReadonlySet<string> }

export function coverageFor(store: CursorImportStore): ImportCoverage {
  const providers = new Set(REPLACED_PROVIDERS)
  if (store.events.some(e => isGrokBotModel(e.model))) providers.add(GROK_BOT_PROVIDER)
  return { ranges: store.ranges.map(r => [Date.parse(r.start), Date.parse(r.end)]), providers }
}

export function replacedProviders(): string[] {
  return [...REPLACED_PROVIDERS, GROK_BOT_PROVIDER]
}

/// Serve-time replacement: a local call of a replaced provider whose timestamp
/// the import covers is dropped, since an imported event stands for it.
export function dropImportCoveredCalls<T extends { timestamp: string; calls: Array<{ timestamp: string; deduplicationKey: string }> }>(
  providerName: string,
  turn: T,
  coverage: ImportCoverage | null,
): T | null {
  if (!coverage?.providers.has(providerName)) return turn
  const covered = (ts: string) => {
    const ms = Date.parse(ts)
    return !Number.isNaN(ms) && coverage.ranges.some(([s, e]) => ms >= s && ms <= e)
  }
  const kept = turn.calls.filter(c => c.deduplicationKey.startsWith(CURSOR_IMPORT_KEY_PREFIX) || !covered(c.timestamp))
  if (kept.length === turn.calls.length) return turn
  if (kept.length === 0) return null
  return { ...turn, calls: kept, timestamp: kept[0]!.timestamp }
}

/// Cursor's own ids, mapped to the catalog ids CodeBurn prices and labels:
/// Auto is the same `cursor-auto` the local parser reports, and Cursor-hosted
/// Grok drops its `cursor-` prefix.
function catalogModel(model: string): string {
  if (model === 'auto' || model === 'default') return 'cursor-auto'
  if (model.startsWith('cursor-grok-')) return model.slice('cursor-'.length)
  return model
}

function importedCalls(store: CursorImportStore, provider: 'cursor' | 'grokbot'): ParsedProviderCall[] {
  const bot = provider === GROK_BOT_PROVIDER
  const calls: ParsedProviderCall[] = []
  for (const e of store.events) {
    if (isGrokBotModel(e.model) !== bot) continue
    const model = catalogModel(e.model)
    const billed = billedCost(e.cost)
    calls.push({
      provider,
      model,
      inputTokens: e.input,
      outputTokens: e.output,
      cacheCreationInputTokens: e.inputCacheWrite,
      cacheReadInputTokens: e.cacheRead,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      costUSD: billed ?? calculateCost(model, e.input, e.output, e.inputCacheWrite, e.cacheRead, 0),
      ...(billed !== null ? { costFromBilling: true } : {}),
      // Plan rows carry no dollars, and Auto and Grok Bot never name the model
      // that served them, so their list price is a stand-in.
      ...(billed === null && (bot || model === 'cursor-auto') ? { costIsEstimated: true } : {}),
      billing: billed !== null ? 'metered' : 'subscription',
      tools: [],
      bashCommands: [],
      timestamp: e.date,
      speed: 'standard',
      deduplicationKey: `${CURSOR_IMPORT_KEY_PREFIX}${e.hash}`,
      userMessage: '',
      sessionId: e.cloudAgentId || e.automationId || `${CURSOR_IMPORT_KEY_PREFIX}${bot ? 'grok-bot:' : ''}${e.date.slice(0, 10)}`,
      project: bot ? GROK_BOT_IMPORT_PROJECT : CURSOR_IMPORT_PROJECT,
    })
  }
  return calls
}

/// The import file as one more source of the provider its events belong to,
/// so it flows through the session cache and every report like local data.
export function importSource(provider: 'cursor' | 'grokbot'): SessionSource[] {
  const path = cursorImportPath()
  if (!existsSync(path)) return []
  return [{ path, project: provider === GROK_BOT_PROVIDER ? GROK_BOT_IMPORT_PROJECT : CURSOR_IMPORT_PROJECT, provider }]
}

export function importSourceParser(source: SessionSource, seenKeys: Set<string>, provider: 'cursor' | 'grokbot'): SessionParser | null {
  if (source.path !== cursorImportPath()) return null
  return {
    async *parse() {
      const store = await loadCursorImport()
      if (!store) return
      for (const call of importedCalls(store, provider)) {
        if (seenKeys.has(call.deduplicationKey)) continue
        seenKeys.add(call.deduplicationKey)
        yield call
      }
    },
  }
}

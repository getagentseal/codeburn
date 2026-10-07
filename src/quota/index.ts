// Provider capacity readers for `codeburn quota`.
//
// These adapters were ported from the Electron desktop app's copies under
// `app/electron/quota/*.ts`, which remain the origin and are still what the
// desktop app runs. They are deliberately left untouched by this change; the
// two trees will be deduped in a follow-up once every surface reads the CLI.

import os from 'node:os'
import path from 'node:path'
import { existsSync } from 'node:fs'

import { renderTable } from '../text-table.js'
import { filterProjectsByClaudeConfigSource, parseAllSessions } from '../parser.js'
import { discoverClaudeConfigSources, type ClaudeConfigSource } from '../providers/claude.js'
import { buildPeriodData } from '../usage-aggregator.js'
import { fetchAntigravityQuota } from './antigravity.js'
import { fetchClaudeQuota } from './claude.js'
import { fetchClinePassQuota } from './clinepass.js'
import { fetchCodexQuota } from './codex.js'
import { fetchCommandCodeQuota } from './commandcode.js'
import { fetchCopilotQuota } from './copilot.js'
import { fetchCursorQuota } from './cursor.js'
import { fetchDevinQuota } from './devin.js'
import { fetchGeminiQuota } from './gemini.js'
import { fetchGrokQuota } from './grok.js'
import { fetchGrokbotQuota, grokbotInstalled } from './grokbot.js'
import { fetchKimiQuota } from './kimi.js'
import { KEYCHAIN_TIMEOUT_MS } from './security.js'
import type { ProviderName, QuotaProvider } from './types.js'
import type { DateRange } from '../types.js'
import { fetchZaiQuota } from './zai.js'
import { fetchZcodeQuota } from './zcode.js'

export type QuotaCommandWindow = { label: string; usedPct: number; resetsAt?: string }

export type QuotaCommandProvider = {
  id: ProviderName
  name: string
  available: boolean
  plan?: string
  windows: QuotaCommandWindow[]
  error?: string
  /** Provider facts that are not a window, such as Codex's limit-reset credits.
   *  Printed under the provider's rows and carried in `--format json`. */
  notes?: string[]
}

/** One Claude config directory's entry in the quota payload. Without `--claude-profiles`
 *  only the identity fields are filled in (enough for the dock's settings row); with it,
 *  each directory's own windows and today totals are read. `providers[]` is unchanged
 *  either way. */
export type ClaudeProfileReport = {
  id: string
  label: string
  path: string
  available?: boolean
  plan?: string
  windows?: QuotaCommandWindow[]
  error?: string
  today?: ClaudeProfileToday
}

/** A profile's today totals, scoped to that config directory's sessions only.
 *  Mirrors the fields the Capacity Dock's glance bubble already renders. */
export type ClaudeProfileToday = {
  cost: number
  calls: number
  sessions: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export type QuotaReport = { providers: QuotaCommandProvider[]; claudeProfiles?: ClaudeProfileReport[] }
export type ProviderReader = (signal: AbortSignal) => Promise<QuotaProvider>

const READERS: { id: ProviderName; name: string; read: ProviderReader }[] = [
  { id: 'claude', name: 'Claude', read: async signal => (await fetchClaudeQuota({ signal, allowKeychain: true })).quota },
  // No keychain for Codex: it would prefer the menubar's read-only cached token
  // over `~/.codex/auth.json`, which this process may refresh and write back.
  { id: 'codex', name: 'Codex', read: async signal => (await fetchCodexQuota({ signal })).quota },
  { id: 'gemini', name: 'Gemini', read: async signal => (await fetchGeminiQuota({ signal })).quota },
  { id: 'copilot', name: 'GitHub Copilot', read: async signal => (await fetchCopilotQuota({ signal })).quota },
  { id: 'antigravity', name: 'Antigravity', read: () => fetchAntigravityQuota() },
  { id: 'kimi', name: 'Kimi', read: async signal => (await fetchKimiQuota({ signal })).quota },
  { id: 'cursor', name: 'Cursor', read: async signal => (await fetchCursorQuota({ signal })).quota },
  { id: 'zai', name: 'Z.ai', read: async signal => (await fetchZaiQuota({ signal })).quota },
  { id: 'zcode', name: 'ZCode', read: async signal => (await fetchZcodeQuota({ signal })).quota },
  { id: 'grok', name: 'Grok', read: async signal => (await fetchGrokQuota({ signal })).quota },
  { id: 'grokbot', name: 'Grok Bot', read: async signal => (await fetchGrokbotQuota({ signal })).quota },
  { id: 'clinepass', name: 'ClinePass', read: async signal => (await fetchClinePassQuota({ signal })).quota },
  { id: 'devin', name: 'Devin', read: async () => (await fetchDevinQuota()).quota },
  { id: 'commandcode', name: 'Command Code', read: async signal => (await fetchCommandCodeQuota({ signal })).quota },
]

/** Grok Bot is an optional desktop app rather than a signed-in account. With
 *  the app absent its reader would still answer — with the Cursor allowance of
 *  whoever is signed into Cursor, under a Grok Bot label — so the row is left
 *  out entirely. */
export function availableReaders(installed: () => boolean = grokbotInstalled): typeof READERS {
  return READERS.filter(entry => entry.id !== 'grokbot' || installed())
}

// Must cover the slowest documented per-reader allowance - Claude's keychain
// fallback waits up to KEYCHAIN_TIMEOUT_MS for the macOS "Allow" dialog - or
// this outer race aborts a reader that is still legitimately waiting and
// misreports it as disconnected. Derived rather than a separate literal so
// the two cannot drift apart; the margin covers the request itself.
const DEFAULT_TIMEOUT_MS = KEYCHAIN_TIMEOUT_MS + 5_000

function errorFor(quota: QuotaProvider): string | undefined {
  switch (quota.connection) {
    case 'accessDenied':
      return quota.footerLines[0] ?? 'Access to the stored credential was denied.'
    case 'terminalFailure':
      return quota.footerLines[0] ?? 'The provider rejected the request.'
    case 'transientFailure':
      return quota.footerLines[0] ?? 'Temporarily unavailable.'
    default:
      return undefined
  }
}

function toWindows(quota: QuotaProvider): QuotaCommandWindow[] {
  const rows = quota.details.length > 0 ? quota.details : quota.primary ? [quota.primary] : []
  return rows.map(row => ({
    label: row.label,
    usedPct: Math.round(row.percent * 1000) / 10,
    ...(row.resetsAt ? { resetsAt: row.resetsAt } : {}),
  }))
}

export function toCommandProvider(id: ProviderName, name: string, quota: QuotaProvider): QuotaCommandProvider {
  const error = errorFor(quota)
  // errorFor() only surfaces footerLines on a non-connected state; a connected
  // read (e.g. Grok Bot's "this is the Cursor account's allowance" disclosure)
  // still needs its first line said out loud so it isn't shown as fact-free.
  const baseNotes = quota.notes ?? []
  const footerNote =
    quota.connection === 'connected' && quota.footerLines.length > 0 ? quota.footerLines[0] : undefined
  const notes = [
    ...baseNotes,
    ...(footerNote && !baseNotes.includes(footerNote) ? [footerNote] : []),
  ]
  return {
    id,
    name,
    available: quota.connection === 'connected',
    ...(quota.planLabel ? { plan: quota.planLabel } : {}),
    windows: toWindows(quota),
    ...(error ? { error } : {}),
    ...(notes.length ? { notes } : {}),
  }
}

/** Reads one config directory's own quota from its `<dir>/.credentials.json`. The macOS
 *  Keychain fallback stays reserved for the default ~/.claude, so non-default directories
 *  read as disconnected on macOS (fine today: the dock is Windows/Linux only). WSL
 *  credential aggregation is off because every WSL home is its own config source. */
function readClaudeProfile(source: ClaudeConfigSource, signal: AbortSignal): Promise<QuotaProvider> {
  const isDefault = path.resolve(source.path) === path.resolve(path.join(os.homedir(), '.claude'))
  return fetchClaudeQuota({
    signal,
    credentialPath: path.join(source.path, '.credentials.json'),
    wslCredentialPaths: () => [],
    allowKeychain: isDefault,
  }).then(result => result.quota)
}

/** Each config directory's own today totals from one Claude-only parse of today's range
 *  (cache-backed), filtered per source id like the menubar's per-config payloads. Claude
 *  Desktop sessions belong to no config directory and match no source id. An empty map
 *  means "no answer" (parse failed), which leaves the rows without today — zeros are a
 *  real answer and only a successful parse may report them. */
export async function claudeTodayBySource(sources: ClaudeConfigSource[]): Promise<Map<string, ClaudeProfileToday>> {
  const now = new Date()
  const range: DateRange = { start: new Date(now.getFullYear(), now.getMonth(), now.getDate()), end: now }
  const projects = await parseAllSessions(range, 'claude').catch(() => null)
  const bySource = new Map<string, ClaudeProfileToday>()
  if (projects === null) return bySource
  for (const source of sources) {
    const data = buildPeriodData('Today', filterProjectsByClaudeConfigSource(projects, source.id))
    bySource.set(source.id, {
      cost: data.cost,
      calls: data.calls,
      sessions: data.sessions,
      inputTokens: data.inputTokens,
      outputTokens: data.outputTokens,
      cacheReadTokens: data.cacheReadTokens,
      cacheWriteTokens: data.cacheWriteTokens,
    })
  }
  return bySource
}

function toProfileRow(source: ClaudeConfigSource, quota: QuotaProvider | 'timeout'): ClaudeProfileReport {
  const row: QuotaCommandProvider = quota === 'timeout'
    ? { id: 'claude', name: source.label, available: false, windows: [], error: 'Timed out.' }
    : toCommandProvider('claude', source.label, quota)
  return {
    id: source.id,
    label: source.label,
    path: source.path,
    available: row.available,
    ...(row.plan ? { plan: row.plan } : {}),
    windows: row.windows,
    ...(row.error ? { error: row.error } : {}),
  }
}

function isDefaultClaudeDir(source: ClaudeConfigSource): boolean {
  return path.resolve(source.path) === path.resolve(path.join(os.homedir(), '.claude'))
}

export async function collectQuota(options: {
  readers?: { id: ProviderName; name: string; read: ProviderReader }[]
  timeoutMs?: number
  /** 'list' (default): identity only, no per-directory reads or parse. 'full': read each
   *  directory's own windows and today. The Windows dock passes 'full' only while its
   *  claudeProfiles preference is 'separate', so a combined rail costs nothing extra. */
  claudeProfileDetail?: 'list' | 'full'
  /** Overridable so tests can pin the profile windows without credentials. */
  claudeProfileReader?: (source: ClaudeConfigSource, signal: AbortSignal) => Promise<QuotaProvider>
  /** Overridable so tests can answer today totals without a parse. */
  claudeToday?: (sources: ClaudeConfigSource[]) => Promise<Map<string, ClaudeProfileToday>>
} = {}): Promise<QuotaReport> {
  const readers = options.readers ?? availableReaders()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const detail = options.claudeProfileDetail ?? 'list'
  // Profiles exist only when two or more config directories are really on disk; a missing
  // directory in CLAUDE_CONFIG_DIRS is not a profile.
  const sources = (await discoverClaudeConfigSources().catch(() => [])).filter(source => existsSync(source.path))
  const profileSources = sources.length > 1 ? sources : []
  const providersTask = Promise.all(readers.map(async entry => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const timedOut = new Promise<'timeout'>(resolve => { controller.signal.addEventListener('abort', () => resolve('timeout')) })
    try {
      const quota = await Promise.race([entry.read(controller.signal), timedOut])
      if (quota === 'timeout') {
        return { id: entry.id, name: entry.name, available: false, windows: [], error: 'Timed out.' }
      }
      return toCommandProvider(entry.id, entry.name, quota)
    } finally {
      clearTimeout(timer)
    }
  }))
  const profilesTask: Promise<{ rows: ClaudeProfileReport[]; today: Map<string, ClaudeProfileToday> } | undefined> = profileSources.length === 0
    ? Promise.resolve(undefined)
    : (async () => {
      if (detail === 'list') {
        return { rows: profileSources.map(({ id, label, path }) => ({ id, label, path })), today: new Map() }
      }
      // The default ~/.claude's profile is the same fetch as the claude row, so it reuses
      // that result instead of a second request and (on macOS) a second Keychain read.
      const reuseClaudeRow = readers.some(entry => entry.id === 'claude')
      const defaultSource = profileSources.find(isDefaultClaudeDir)
      const toRead = reuseClaudeRow && defaultSource
        ? profileSources.filter(source => source !== defaultSource)
        : profileSources
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const timedOut = new Promise<'timeout'>(resolve => { controller.signal.addEventListener('abort', () => resolve('timeout')) })
      const read = options.claudeProfileReader ?? readClaudeProfile
      try {
        // The today parse is raced against the same timeout: a silent child must not cost
        // the dock every provider's quota. Losing the race answers an empty map.
        const emptyToday = new Map<string, ClaudeProfileToday>()
        const [rows, today] = await Promise.all([
          Promise.all(toRead.map(async source => {
            const quota = await Promise.race([read(source, controller.signal), timedOut])
            return toProfileRow(source, quota)
          })),
          Promise.race([
            (options.claudeToday ?? claudeTodayBySource)(profileSources).catch(() => emptyToday),
            new Promise<Map<string, ClaudeProfileToday>>(resolve => {
              setTimeout(() => resolve(emptyToday), timeoutMs)
            }),
          ]),
        ])
        for (const row of rows) {
          const rowToday = today.get(row.id)
          if (rowToday) row.today = rowToday
        }
        return { rows, today }
      } finally {
        clearTimeout(timer)
      }
    })()
  const [providers, profiles] = await Promise.all([providersTask, profilesTask])
  let claudeProfiles = profiles?.rows
  // The default dir's row is the claude provider row itself, spliced back into place.
  const claudeRow = providers.find(row => row.id === 'claude')
  const defaultSource = profileSources.find(isDefaultClaudeDir)
  if (profiles !== undefined && detail === 'full' && claudeRow && defaultSource && !profiles.rows.some(row => row.id === defaultSource.id)) {
    const reused: ClaudeProfileReport = {
      id: defaultSource.id,
      label: defaultSource.label,
      path: defaultSource.path,
      available: claudeRow.available,
      ...(claudeRow.plan ? { plan: claudeRow.plan } : {}),
      windows: claudeRow.windows,
      ...(claudeRow.error ? { error: claudeRow.error } : {}),
      ...(profiles.today.get(defaultSource.id) ? { today: profiles.today.get(defaultSource.id) } : {}),
    }
    claudeProfiles = profileSources.map(source =>
      source === defaultSource
        ? reused
        : profiles.rows.find(row => row.id === source.id) ?? { id: source.id, label: source.label, path: source.path },
    )
  }
  // ZCode and Z.ai read the same endpoint and report the same plan numbers
  // whenever both credentials belong to one z.ai account: showing both is a
  // duplicate row. The deliberately configured Z.ai credential (Keychain,
  // ZAI_API_KEY, Pi) wins and the ambient ZCode app login yields — but only
  // while Z.ai is actually connected, so a rejected or stale Z.ai state never
  // hides a working ZCode row.
  const zaiRow = providers.find(row => row.id === 'zai')
  if (zaiRow?.available) {
    const zcodeIndex = providers.findIndex(row => row.id === 'zcode')
    if (zcodeIndex !== -1 && providers[zcodeIndex].available) {
      providers.splice(zcodeIndex, 1)
      zaiRow.notes = [...(zaiRow.notes ?? []), 'A ZCode app login is also connected; it reads the same z.ai plan endpoint and is hidden as a duplicate.']
    }
  }
  return claudeProfiles === undefined ? { providers } : { providers, claudeProfiles }
}

function resetLabel(iso: string | undefined): string {
  if (!iso) return ''
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleString()
}

export function renderQuotaTable(report: QuotaReport, opts: { color?: boolean } = {}): string {
  const rows: string[][] = []
  for (const provider of report.providers) {
    const title = provider.plan ? `${provider.name} (${provider.plan})` : provider.name
    if (provider.windows.length === 0) {
      rows.push([title, provider.error ?? 'Not connected', '', ''])
      // A provider with no readable window can still hold a fact worth saying.
      for (const note of provider.notes ?? []) rows.push(['', note, '', ''])
      continue
    }
    provider.windows.forEach((window, index) => {
      rows.push([index === 0 ? title : '', window.label, `${window.usedPct}%`, resetLabel(window.resetsAt)])
    })
    for (const note of provider.notes ?? []) rows.push(['', note, '', ''])
  }
  const columns = [{ header: 'Provider' }, { header: 'Window' }, { header: 'Used', right: true }, { header: 'Resets' }]
  return renderTable(columns, rows, { color: opts.color })
}

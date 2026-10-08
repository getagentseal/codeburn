import { lstat, readdir, realpath, statfs } from 'fs/promises'
import { join, resolve } from 'path'
import { getCodeburnCacheDir } from './cache-dir.js'
import { allProviderNames, getAllProviders } from './providers/index.js'
import { sanitizeModelForDisplay } from './models.js'
import type { ProbeRoot, Provider } from './providers/types.js'

type Totals = { files: number; bytes: number }
export type StorageTarget = { provider: string; roots: ProbeRoot[] }
export type StorageOmission = { provider: string; path: string; reason: string }
export type StorageReport = {
  schemaVersion: 1
  readOnly: true
  coverage: string
  providers: Array<Totals & { provider: string; roots: ProbeRoot[] }>
  shared: Array<Totals & { providers: string[] }>
  sources: Totals
  cache: Totals & { path: string }
  largestFiles: Array<{ path: string; bytes: number; providers: string[] }>
  filesystems: Array<{ device: string; path: string; availableBytes: number | null; error?: string }>
  omissions: StorageOmission[]
  excludedProviders: Array<{ provider: string; reason: string }>
}

// Explicitly opt in only resolvers that locate roots without reading source
// content or opening databases. New providers need the same review before
// joining this list. Broad editor roots/registry-only probes are excluded.
const METADATA_ROOT_PROVIDERS = new Set([
  'amp', 'antigravity', 'claude', 'cline', 'cline-cli', 'codebuff', 'codewhale',
  'codex', 'command-code', 'cursor', 'cursor-agent', 'devin', 'droid', 'dsh',
  'forge', 'gemini', 'goose', 'grok', 'grokbot', 'hermes', 'ibm-bob', 'kilo-code',
  'kimi', 'kimicode', 'kiro', 'mistral-vibe', 'mux', 'open-design', 'openclaude',
  'openclaw', 'opencode', 'pi', 'omp', 'qwen', 'warp', 'zcode', 'zed', 'zerostack',
])
const CACHE = 'codeburn-cache'
const COVERAGE = 'Partial coverage: all regular files under known source roots, including auxiliary files; not a count of parsed sessions. Logical bytes, not allocated disk usage. Configured root symlinks are resolved; nested symlinks are skipped.'
const emptyTotals = (): Totals => ({ files: 0, bytes: 0 })
const errorCode = (err: unknown): string => (err as NodeJS.ErrnoException)?.code ?? 'unavailable'

/** Only metadata operations below: never discoverSessions, parse, readFile or SQL. */
export async function measureStorage(targets: StorageTarget[], cachePath = getCodeburnCacheDir()): Promise<StorageReport> {
  const report: StorageReport = {
    schemaVersion: 1, readOnly: true, coverage: COVERAGE,
    providers: targets.map(t => ({ provider: t.provider, roots: t.roots, ...emptyTotals() })),
    shared: [], sources: emptyTotals(), cache: { path: cachePath, ...emptyTotals() },
    largestFiles: [], filesystems: [], omissions: [], excludedProviders: [],
  }
  const files = new Map<string, { path: string; bytes: number; providers: Set<string> }>()
  const directories = new Set<string>()
  const devices = new Set<string>()
  const omit = (provider: string, path: string, reason: string) => report.omissions.push({ provider, path, reason })

  async function visit(provider: string, start: string, optional = false): Promise<void> {
    let root: string
    try {
      // Explicit roots can be relocated through a symlink (common on macOS).
      // Resolve once, then refuse symlinks encountered inside that tree.
      await lstat(start)
      root = await realpath(start)
    } catch (err) {
      if (!optional || errorCode(err) !== 'ENOENT') omit(provider, start, errorCode(err))
      return
    }
    const pending = [root]
    while (pending.length) {
      const path = pending.pop()!
      try {
        const info = await lstat(path)
        if (info.isSymbolicLink()) { omit(provider, path, 'symlink skipped'); continue }
        if (!info.isFile() && !info.isDirectory()) { omit(provider, path, 'special file skipped'); continue }
        const device = String(info.dev)
        if (!devices.has(device)) {
          devices.add(device)
          try {
            const space = await statfs(path)
            const available = space.bavail * space.bsize
            report.filesystems.push({ device, path, availableBytes: Number.isFinite(available) && available >= 0 ? available : null })
          } catch (err) {
            report.filesystems.push({ device, path, availableBytes: null, error: errorCode(err) })
          }
        }
        // Hard links, aliases and overlapping roots count once. Filesystems
        // without useful inode IDs fall back to the resolved absolute path.
        const key = info.ino > 0 ? `${device}:${info.ino}` : resolve(path)
        if (info.isDirectory()) {
          const directoryKey = `${provider}:${key}`
          if (directories.has(directoryKey)) continue
          // Mark only after readdir succeeds so another root can retry errors.
          const children = await readdir(path)
          directories.add(directoryKey)
          for (const child of children.sort().reverse()) pending.push(join(path, child))
        } else {
          const existing = files.get(key)
          if (existing) existing.providers.add(provider)
          else files.set(key, { path, bytes: info.size, providers: new Set([provider]) })
        }
      } catch (err) {
        omit(provider, path, errorCode(err))
      }
    }
  }

  for (const target of [...targets, { provider: CACHE, roots: [{ path: cachePath, label: 'cache' }] }]) {
    for (const root of target.roots) {
      await visit(target.provider, root.path)
      // SQLite sidecars live beside a file root, outside the recursive walk.
      // Probe by filename only, even if the database disappeared mid-scan.
      if (/\.(?:db|sqlite|sqlite3|vscdb)$/i.test(root.path)) {
        for (const suffix of ['-wal', '-shm']) await visit(target.provider, root.path + suffix, true)
      }
    }
  }

  const rows = new Map(report.providers.map(p => [p.provider, p]))
  const shared = new Map<string, Totals & { providers: string[] }>()
  for (const file of files.values()) {
    // If the user places CodeBurn's cache within a source root, classify it
    // solely as cache so source + cache bytes still equal the unique total.
    if (file.providers.has(CACHE)) {
      report.cache.files++
      report.cache.bytes += file.bytes
      continue
    }
    const providers = [...file.providers].sort()
    report.sources.files++
    report.sources.bytes += file.bytes
    if (providers.length === 1) {
      const row = rows.get(providers[0]!)!
      row.files++
      row.bytes += file.bytes
    } else {
      const key = providers.join(',')
      const row = shared.get(key) ?? { providers, ...emptyTotals() }
      row.files++
      row.bytes += file.bytes
      shared.set(key, row)
    }
    report.largestFiles.push({ path: file.path, bytes: file.bytes, providers })
    report.largestFiles.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path))
    if (report.largestFiles.length > 10) report.largestFiles.pop()
  }
  report.shared = [...shared.values()]
  return report
}

export async function collectStorageReport(providerFilter = 'all', providerList?: Provider[]): Promise<StorageReport> {
  const providers = providerList ?? await getAllProviders()
  const names = providerList ? providers.map(p => p.name) : allProviderNames()
  const targets: StorageTarget[] = []
  const excluded: StorageReport['excludedProviders'] = []
  for (const name of names) {
    if (providerFilter !== 'all' && name !== providerFilter) continue
    const provider = providers.find(p => p.name === name)
    if (!METADATA_ROOT_PROVIDERS.has(name) || !provider?.probeRoots) {
      excluded.push({ provider: name, reason: 'No reviewed metadata-only source roots in this version' })
      continue
    }
    try {
      const roots = await provider.probeRoots()
      if (roots.length) targets.push({ provider: name, roots })
      else excluded.push({ provider: name, reason: 'No source roots available' })
    } catch (err) {
      excluded.push({ provider: name, reason: `Root lookup failed: ${errorCode(err)}` })
    }
  }
  const report = await measureStorage(targets)
  report.excludedProviders = excluded
  return report
}

function bytes(value: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`
}

export function renderStorageTable(report: StorageReport): string {
  const safe = sanitizeModelForDisplay
  const lines = ['Storage footprint (read-only)', report.coverage, '', 'Provider / store                  Files       Logical size']
  const row = (name: string, totals: Totals) => lines.push(`${safe(name).padEnd(32)} ${String(totals.files).padStart(7)} ${bytes(totals.bytes).padStart(18)}`)
  for (const provider of report.providers) row(provider.provider, provider)
  for (const shared of report.shared) row(`Shared: ${shared.providers.join(', ')}`, shared)
  row('Total sources (deduplicated)', report.sources)
  row('CodeBurn cache', report.cache)
  lines.push(`Cache root: ${safe(report.cache.path)}`, '', 'Largest source files:')
  for (const file of report.largestFiles) lines.push(`  ${bytes(file.bytes).padStart(12)}  ${safe(file.path)}`)
  if (!report.largestFiles.length) lines.push('  None measured')
  lines.push('', 'Available disk space:')
  for (const fs of report.filesystems) lines.push(`  ${fs.availableBytes === null ? `unavailable (${fs.error ?? 'unsupported'})` : bytes(fs.availableBytes)}  at ${safe(fs.path)}`)
  if (!report.filesystems.length) lines.push('  Unavailable: no accessible storage roots')
  lines.push('', `Omitted paths: ${report.omissions.length}`)
  for (const omitted of report.omissions.slice(0, 10)) lines.push(`  ${safe(omitted.provider)}: ${safe(omitted.path)} (${safe(omitted.reason)})`)
  if (report.omissions.length > 10) lines.push('  Use --json for all omitted paths')
  if (report.excludedProviders.length) {
    lines.push('', 'Providers outside this report:')
    for (const provider of report.excludedProviders) lines.push(`  ${safe(provider.provider)}: ${safe(provider.reason)}`)
  }
  return lines.join('\n') + '\n'
}

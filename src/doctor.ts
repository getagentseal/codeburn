import { existsSync } from 'fs'
import { dirname } from 'path'

import { Chalk } from 'chalk'

import { getAllProviders } from './providers/index.js'
import type { Provider } from './providers/types.js'
import {
  PROVIDER_ENV_VARS,
  PROVIDER_PARSE_VERSIONS,
  loadCache,
  type SessionCache,
} from './session-cache.js'
import { renderTable } from './text-table.js'

// ── Types ──────────────────────────────────────────────────────────────

export type DoctorProbePath = {
  path: string
  label: string
  exists: boolean
}

export type DoctorEnvOverride = {
  name: string
  value: string
}

export type DoctorStatus = 'ok' | 'empty' | 'errors' | 'error' | 'network'

export type DoctorProviderReport = {
  provider: string
  displayName: string
  status: DoctorStatus
  /** Directories/dbs the provider scans, with existence checked (may be empty
   *  for providers that do not expose probeRoots). */
  probePaths: DoctorProbePath[]
  /** Env overrides that are actually set for this provider. */
  envOverrides: DoctorEnvOverride[]
  parseVersion?: string
  /** Session sources discovered (candidate files/dbs). */
  candidatesFound: number
  /** How many discovered sources we attempted to parse (bounded sample). */
  sampled: number
  parsedOk: number
  parseFailed: number
  /** True when we sampled fewer sources than were discovered. */
  bounded: boolean
  /** Files cached for this provider in session-cache.json. */
  cachedFiles: number
  /** Cached entries flagged as parse failures. */
  cachedFailed: number
  /** One-line human verdict. */
  verdict: string
  /** Message when the provider itself threw (status 'error'). */
  error?: string
}

export type DoctorReport = {
  generatedAt: string
  providers: DoctorProviderReport[]
}

export type CollectDoctorOptions = {
  /** Injectable provider list (defaults to the real registry). */
  providers?: Provider[]
  /** Injectable cache snapshot (defaults to reading session-cache.json). */
  cache?: SessionCache
  /** Max discovered sources to parse-sample per provider. */
  sampleLimit?: number
}

// Bound the parse sample so doctor never does a full expensive parse of a huge
// history: sample at most this many discovered sources per provider, and read
// at most this many calls out of each before moving on.
const DEFAULT_SAMPLE_LIMIT = 8
const PARSE_CALL_CAP = 500

// ── Collect (pure, testable) ─────────────────────────────────────────────

function collectEnvOverrides(providerName: string): DoctorEnvOverride[] {
  const vars = PROVIDER_ENV_VARS[providerName] ?? []
  const out: DoctorEnvOverride[] = []
  for (const name of vars) {
    const value = process.env[name]
    if (value !== undefined && value !== '') out.push({ name, value })
  }
  return out
}

async function collectProbePaths(provider: Provider): Promise<DoctorProbePath[]> {
  if (!provider.probeRoots) return []
  const roots = await provider.probeRoots()
  return roots.map(r => ({ path: r.path, label: r.label, exists: existsSync(r.path) }))
}

// A discovered source path can carry a virtual suffix (`<db>#cursor-ws=...`,
// `<db>:<sessionId>`); strip it to the real on-disk path, then to its parent
// dir so many per-session sources collapse to a handful of probed directories.
function realPathOf(sourcePath: string): string {
  const hashIdx = sourcePath.indexOf('#')
  let p = hashIdx > 0 ? sourcePath.slice(0, hashIdx) : sourcePath
  const colonIdx = p.lastIndexOf(':')
  // Keep Windows drive letters (`C:\...`): only strip a colon that is not the
  // drive separator (index > 1).
  if (colonIdx > 1) p = p.slice(0, colonIdx)
  return p
}

function derivePathsFromSources(sourcePaths: string[]): DoctorProbePath[] {
  const dirs = new Set<string>()
  for (const sp of sourcePaths) {
    const real = realPathOf(sp)
    dirs.add(existsSync(real) ? dirname(real) : real)
  }
  return [...dirs].sort().map(path => ({ path, label: 'discovered', exists: existsSync(path) }))
}

function pluralSessions(n: number): string {
  return `${n} session${n === 1 ? '' : 's'}`
}

function emptyVerdict(
  probePaths: DoctorProbePath[],
  envOverrides: DoctorEnvOverride[],
): string {
  const overrideNames = envOverrides.map(o => o.name).join(', ')
  const hasOverride = envOverrides.length > 0
  const known = probePaths.filter(p => p.label !== 'discovered')
  const missing = known.filter(p => !p.exists)
  const present = known.filter(p => p.exists)

  // No known probe roots to check: honest, override-aware fallback.
  if (known.length === 0) {
    return hasOverride
      ? `NOTHING FOUND (override ${overrideNames} set, but nothing was discovered)`
      : 'NOTHING FOUND (tool likely not installed or no history yet)'
  }
  // With an override set, a missing probed path is the likely culprit; name it
  // so the row itself points at the misconfiguration (Details lists them all).
  if (hasOverride) {
    return missing.length > 0
      ? `NOTHING FOUND (override ${overrideNames} set; ${missing[0]!.path} does not exist)`
      : `NOTHING FOUND (override ${overrideNames} set; ${present[0]!.path} holds no sessions)`
  }
  // No override. If every probed path is missing, the tool is likely not
  // installed; if some exist, the data dir is there but empty (no history).
  return present.length === 0
    ? `NOTHING FOUND (${missing[0]!.path} does not exist; tool likely not installed)`
    : `NOTHING FOUND (${present[0]!.path} exists but holds no sessions; no history yet)`
}

async function collectOneProvider(
  provider: Provider,
  cache: SessionCache,
  sampleLimit: number,
): Promise<DoctorProviderReport> {
  const base: DoctorProviderReport = {
    provider: provider.name,
    displayName: provider.displayName,
    status: 'ok',
    probePaths: [],
    envOverrides: collectEnvOverrides(provider.name),
    parseVersion: PROVIDER_PARSE_VERSIONS[provider.name],
    candidatesFound: 0,
    sampled: 0,
    parsedOk: 0,
    parseFailed: 0,
    bounded: false,
    cachedFiles: 0,
    cachedFailed: 0,
    verdict: '',
  }

  const section = cache.providers[provider.name]
  if (section) {
    const files = Object.values(section.files)
    base.cachedFiles = files.length
    base.cachedFailed = files.filter(f => f.failed).length
  }

  // Any single provider throwing (probe, discovery, or a parser) must never
  // crash doctor or blank the other rows: catch and report it as an ERROR row.
  try {
    base.probePaths = await collectProbePaths(provider)

    const sources = await provider.discoverSessions()
    base.candidatesFound = sources.length
    if (base.probePaths.length === 0) {
      base.probePaths = derivePathsFromSources(sources.map(s => s.path))
    }

    // Network providers fetch on parse; doctor runs offline, so we never parse
    // them. Discovery for the one network provider is offline (it only checks
    // for a configured API key), so the count above still means something.
    if (provider.network) {
      base.status = 'network'
      base.verdict = base.candidatesFound > 0
        ? `NETWORK (${base.candidatesFound} source configured; parse skipped offline)`
        : 'NETWORK (not configured; no API key)'
      return base
    }

    if (sources.length > 0) {
      const sample = sources.slice(0, sampleLimit)
      base.bounded = sample.length < sources.length
      const seenKeys = new Set<string>()
      for (const source of sample) {
        base.sampled++
        try {
          const parser = provider.createSessionParser(source, seenKeys)
          let n = 0
          for await (const _call of parser.parse()) {
            if (++n >= PARSE_CALL_CAP) break
          }
          base.parsedOk++
        } catch {
          base.parseFailed++
        }
      }
    }

    if (base.parseFailed > 0) {
      base.status = 'errors'
      base.verdict = `ERRORS (${base.parseFailed}/${base.sampled} sampled file${base.sampled === 1 ? '' : 's'} failed to parse)`
    } else if (base.candidatesFound === 0) {
      base.status = 'empty'
      base.verdict = emptyVerdict(base.probePaths, base.envOverrides)
    } else {
      base.status = 'ok'
      base.verdict = `OK (${pluralSessions(base.candidatesFound)})`
    }
  } catch (err) {
    base.status = 'error'
    base.error = err instanceof Error ? err.message : String(err)
    base.verdict = `ERROR (${base.error})`
  }

  return base
}

export async function collectDoctorReport(
  providerFilter?: string,
  opts: CollectDoctorOptions = {},
): Promise<DoctorReport> {
  const all = opts.providers ?? await getAllProviders()
  const filtered = providerFilter && providerFilter !== 'all'
    ? all.filter(p => p.name === providerFilter)
    : all
  const cache = opts.cache ?? await loadCache()
  const sampleLimit = opts.sampleLimit ?? DEFAULT_SAMPLE_LIMIT

  const providers: DoctorProviderReport[] = []
  for (const provider of filtered) {
    providers.push(await collectOneProvider(provider, cache, sampleLimit))
  }
  providers.sort((a, b) => (a.displayName < b.displayName ? -1 : a.displayName > b.displayName ? 1 : 0))

  return { generatedAt: new Date().toISOString(), providers }
}

// ── Render ────────────────────────────────────────────────────────────────

export function renderDoctorJson(report: DoctorReport): string {
  return JSON.stringify(report, null, 2)
}

export function renderDoctorTable(
  report: DoctorReport,
  opts: { color?: boolean } = {},
): string {
  const c = new Chalk(opts.color === false ? { level: 0 } : {})
  const out: string[] = []

  const n = report.providers.length
  out.push(c.bold('CodeBurn doctor') + c.dim(`   ${n} provider${n === 1 ? '' : 's'}   ${report.generatedAt.slice(0, 19).replace('T', ' ')} UTC`))
  out.push('')

  const colorVerdict = (r: DoctorProviderReport): string => {
    if (r.status === 'ok') return c.green(r.verdict)
    if (r.status === 'network') return c.cyan(r.verdict)
    if (r.status === 'empty') return c.yellow(r.verdict)
    return c.red(r.verdict)
  }

  const rows = report.providers.map(r => [
    r.displayName,
    r.status === 'network' ? '-' : String(r.candidatesFound),
    r.status === 'network' || r.sampled === 0 ? '-' : `${r.parsedOk}/${r.sampled}${r.bounded ? '+' : ''}`,
    String(r.cachedFiles),
    colorVerdict(r),
  ])

  out.push(renderTable(
    [
      { header: 'Provider' },
      { header: 'Sessions', right: true },
      { header: 'Parsed', right: true },
      { header: 'Cached', right: true },
      { header: 'Verdict' },
    ],
    rows,
    { color: opts.color },
  ))

  // Detail: show the exact probed paths + overrides only where there is
  // something diagnostic to show (known probe roots, an override, a hard
  // error, or cached parse failures), so a wrong path is spotted at a glance
  // without a wall of empty blocks for tools that are simply not installed.
  const detail = report.providers.filter(
    r =>
      r.status === 'error' ||
      r.status === 'errors' ||
      r.envOverrides.length > 0 ||
      r.cachedFailed > 0 ||
      r.probePaths.some(p => p.label !== 'discovered'),
  )
  if (detail.length > 0) {
    out.push('')
    out.push(c.bold('Details'))
    for (const r of detail) {
      out.push('  ' + c.bold(r.displayName))
      for (const o of r.envOverrides) {
        out.push('    ' + c.dim('override ') + `${o.name}=${o.value}`)
      }
      for (const p of r.probePaths) {
        const mark = p.exists ? c.green('exists') : c.red('missing')
        out.push('    ' + c.dim(`${p.label}: `) + p.path + ' ' + c.dim('(') + mark + c.dim(')'))
      }
      if (r.parseVersion) out.push('    ' + c.dim('parser: ') + r.parseVersion)
      if (r.cachedFailed > 0) out.push('    ' + c.dim('cached parse failures: ') + String(r.cachedFailed))
      if (r.error) out.push('    ' + c.red('error: ') + r.error)
    }
  }

  out.push('')
  const broken = report.providers.filter(r => r.status === 'error' || r.status === 'errors')
  const empty = report.providers.filter(r => r.status === 'empty')
  const ok = report.providers.filter(r => r.status === 'ok')
  out.push(
    c.dim('Bottom line: ') +
    `${ok.length} OK, ${empty.length} with nothing found, ${broken.length} with errors.`,
  )

  return out.join('\n') + '\n'
}

import { readdirSync, statSync } from 'fs'
import { readFile, readdir, stat } from 'fs/promises'
import { basename, delimiter as pathDelimiter, dirname, join, resolve } from 'path'
import { homedir } from 'os'
import { createHash } from 'crypto'

import type { Provider, ProbeRoot, SessionSource, SessionParser } from './types.js'
import { calculateCost, getShortModelName } from '../models.js'
import { readConfig } from '../config.js'
import { getCodeburnCacheDir } from '../cache-dir.js'
import { FS_SCAN_CONCURRENCY, mapWithConcurrency, readSessionLines } from '../fs-utils.js'
import { wslHomes } from '../wsl.js'

export type ClaudeConfigSource = {
  id: string
  label: string
  path: string
  orgUuid?: string
  accountUuid?: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

function dedupeResolved(paths: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of paths) {
    if (!seen.has(p)) {
      seen.add(p)
      out.push(p)
    }
  }
  return out
}

/// Stable id for one config directory, shared by session sources, the menubar's
/// claudeConfigs selector, live sessions and the quota payload's claudeProfiles.
export function claudeConfigSourceId(path: string): string {
  return 'claude-config:' + createHash('sha256').update(path).digest('hex').slice(0, 16)
}

/// Stable id for a Claude Desktop sessions directory.
export function claudeDesktopSourceId(base: string): string {
  return 'claude-desktop:' + createHash('sha256').update(resolve(base)).digest('hex').slice(0, 16)
}

/// Stable id for a Claude organization (Personal or Team) discovered from
/// Claude Desktop (`claude-code-sessions/<accountUuid>/<orgUuid>` / `oauth:tokenCacheV2`).
export function claudeOrgSourceId(orgUuid: string): string {
  return 'claude-org:' + orgUuid.trim().toLowerCase()
}

/// macOS Keychain service name Claude Code uses for a config directory.
/// `~/.claude` uses the unsuffixed service; any other `CLAUDE_CONFIG_DIR`
/// appends `-<first 8 hex of sha256(resolvedPath.normalize('NFC'))>`.
export function claudeKeychainService(configDir?: string): string {
  const target = resolve(configDir ? expandHome(configDir) : join(homedir(), '.claude'))
  const def = resolve(join(homedir(), '.claude'))
  if (target === def) return 'Claude Code-credentials'
  const suffix = createHash('sha256').update(target.normalize('NFC')).digest('hex').slice(0, 8)
  return `Claude Code-credentials-${suffix}`
}

// `\\wsl$\<distro>\home\<user>\.claude` -> distro, and the home's own name
// (`<user>`, or `root`). Either separator after the prefix: the join that
// builds these follows the host platform, which is `/` under test.
const WSL_CONFIG_DIR = /^\\\\wsl(?:\$|\.localhost)\\([^\\/]+)[\\/](?:home[\\/])?([^\\/]+)[\\/]/i

function baseClaudeConfigLabel(path: string, siblings: string[]): string {
  const normalized = resolve(path)
  if (normalized === resolve(join(homedir(), '.claude'))) return 'Default Claude'
  // Every WSL root basenames to ".claude", so name them by distro instead of
  // letting makeUniqueLabels number them "claude 1", "claude 2" (#1059). Two
  // homes in the same distro would collide on the distro alone, so those also
  // carry the user name.
  const wsl = WSL_CONFIG_DIR.exec(path)
  if (wsl) {
    const shared = siblings.filter(p => WSL_CONFIG_DIR.exec(p)?.[1]?.toLowerCase() === wsl[1]!.toLowerCase())
    return shared.length > 1 ? `${wsl[1]} (WSL, ${wsl[2]})` : `${wsl[1]} (WSL)`
  }
  const name = basename(normalized).replace(/^\./, '').trim()
  return name || normalized
}

function makeUniqueLabels(sources: ClaudeConfigSource[]): ClaudeConfigSource[] {
  const counts = new Map<string, number>()
  for (const source of sources) counts.set(source.label, (counts.get(source.label) ?? 0) + 1)
  if (![...counts.values()].some(count => count > 1)) return sources

  const seen = new Map<string, number>()
  return sources.map(source => {
    if ((counts.get(source.label) ?? 0) <= 1) return source
    const index = (seen.get(source.label) ?? 0) + 1
    seen.set(source.label, index)
    return { ...source, label: `${source.label} ${index}` }
  })
}

/// Returns every Claude config dir to scan, in priority order with duplicates
/// removed (resolved-path equality). Precedence: `CLAUDE_CONFIG_DIRS` (a
/// `path.delimiter`-separated list, ":" on POSIX, ";" on Windows), then
/// `CLAUDE_CONFIG_DIR` (single dir), then the `claudeConfigDirs` array in
/// `~/.config/codeburn/config.json` (how the macOS menubar configures
/// multi-account aggregation, since a GUI app can't inherit the shell env),
/// then `~/.claude`. Sessions from every returned dir are merged into one
/// ProjectSummary per project name in `src/parser.ts:scanProjectDirs`, so two
/// dirs holding the same sanitized project slug naturally aggregate (#208).
export async function getClaudeConfigDirs(): Promise<string[]> {
  // WSL homes are additive, not an override: a Windows user who points
  // CLAUDE_CONFIG_DIRS at a second Windows account still wants the sessions
  // Claude Code wrote inside their distro (#1059). Off-win32 this is empty.
  const wsl = wslHomes().map(home => join(home, '.claude'))
  return dedupeResolved([...await configuredClaudeConfigDirs(), ...wsl])
}

async function configuredClaudeConfigDirs(): Promise<string[]> {
  const multi = process.env['CLAUDE_CONFIG_DIRS']
  if (multi !== undefined && multi !== '') {
    const dirs = multi
      .split(pathDelimiter)
      .map(s => s.trim())
      .filter(s => s.length > 0)
      .map(s => resolve(expandHome(s)))
    if (dirs.length > 0) return dedupeResolved(dirs)
  }
  const single = process.env['CLAUDE_CONFIG_DIR']
  if (single !== undefined && single !== '') return [resolve(expandHome(single))]

  // Config-file fallback (menubar-driven). Env vars always win so a power user
  // can still override per-shell. A non-array or empty value falls through to
  // the ~/.claude default, matching the "unset" behavior.
  const config = await readConfig()
  if (Array.isArray(config.claudeConfigDirs)) {
    const dirs = config.claudeConfigDirs
      .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      .map(s => resolve(expandHome(s.trim())))
    if (dirs.length > 0) return dedupeResolved(dirs)
  }

  return [join(homedir(), '.claude')]
}

export async function discoverClaudeConfigSources(): Promise<ClaudeConfigSource[]> {
  const dirs = await getClaudeConfigDirs()
  return makeUniqueLabels(dirs.map(path => ({
    id: claudeConfigSourceId(path),
    label: baseClaudeConfigLabel(path, dirs),
    path,
  })))
}

export type CachedClaudeOrgProfile = {
  orgUuid: string
  accountUuid?: string
  label?: string
  organizationType?: string
  isDefaultConfigOrg?: boolean
}

export function claudeOrgProfilesCachePath(): string {
  return join(getCodeburnCacheDir(), 'claude-org-profiles.json')
}

export async function readClaudeOrgProfilesCache(): Promise<Map<string, CachedClaudeOrgProfile>> {
  const map = new Map<string, CachedClaudeOrgProfile>()
  try {
    const raw = await readFile(claudeOrgProfilesCachePath(), 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return map
    for (const [key, val] of Object.entries(parsed)) {
      if (!val || typeof val !== 'object' || Array.isArray(val)) continue
      const row = val as Record<string, unknown>
      const orgUuid = (typeof row.orgUuid === 'string' ? row.orgUuid : key).trim().toLowerCase()
      if (!UUID_RE.test(orgUuid)) continue
      map.set(orgUuid, {
        orgUuid,
        ...(typeof row.accountUuid === 'string' ? { accountUuid: row.accountUuid.trim().toLowerCase() } : {}),
        ...(typeof row.label === 'string' && row.label.trim() ? { label: row.label.trim() } : {}),
        ...(typeof row.organizationType === 'string' ? { organizationType: row.organizationType.trim().toLowerCase() } : {}),
        ...(row.isDefaultConfigOrg === true ? { isDefaultConfigOrg: true } : {}),
      })
    }
  } catch {
    // Missing or unreadable cache is normal on first run.
  }
  return map
}

function formatOrgLabel(name: string | undefined, organizationType: string | undefined): string | undefined {
  const trimmed = name?.trim()
  const type = organizationType?.toLowerCase()
  if (type === 'max' || type === 'pro' || type === 'claude_max' || type === 'claude_pro') {
    return 'Personal'
  }
  if (trimmed) {
    if (/^.+['’]s organization$/i.test(trimmed)) return 'Personal'
    return trimmed
  }
  if (type === 'team' || type === 'claude_team') return 'Team'
  if (type === 'enterprise' || type === 'claude_enterprise') return 'Enterprise'
  return undefined
}

async function readDefaultClaudeOauthAccount(defaultDir: string): Promise<{
  accountUuid?: string
  orgUuid?: string
  label?: string
}> {
  const candidates = [
    join(homedir(), '.claude.json'),
    join(defaultDir, '.claude.json'),
  ]
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf-8')) as { oauthAccount?: Record<string, unknown> }
      const acct = parsed?.oauthAccount
      if (!acct || typeof acct !== 'object') continue
      const orgUuid = typeof acct.organizationUuid === 'string' && UUID_RE.test(acct.organizationUuid.trim())
        ? acct.organizationUuid.trim().toLowerCase()
        : undefined
      const accountUuid = typeof acct.accountUuid === 'string' && UUID_RE.test(acct.accountUuid.trim())
        ? acct.accountUuid.trim().toLowerCase()
        : undefined
      const orgName = typeof acct.organizationName === 'string' ? acct.organizationName : undefined
      if (orgUuid || accountUuid) {
        return {
          accountUuid,
          orgUuid,
          label: formatOrgLabel(orgName, undefined),
        }
      }
    } catch {
      continue
    }
  }
  return {}
}

type DiscoveredDesktopOrg = {
  orgUuid: string
  accountUuid: string
  path: string
  sessionIds: string[]
}

async function scanDesktopCodeSessionOrgs(): Promise<Map<string, DiscoveredDesktopOrg>> {
  const byOrg = new Map<string, DiscoveredDesktopOrg>()
  const appRoots = dedupeResolved(getDesktopSessionsDirs().map(dir => dirname(dir)))
  for (const appRoot of appRoots) {
    const codeSessionsRoot = join(appRoot, 'claude-code-sessions')
    const acctEntries = await readdir(codeSessionsRoot, { withFileTypes: true }).catch(() => [])
    for (const acctEntry of acctEntries) {
      if (!acctEntry.isDirectory() || !UUID_RE.test(acctEntry.name)) continue
      const accountUuid = acctEntry.name.toLowerCase()
      const acctPath = join(codeSessionsRoot, acctEntry.name)
      const orgEntries = await readdir(acctPath, { withFileTypes: true }).catch(() => [])
      for (const orgEntry of orgEntries) {
        if (!orgEntry.isDirectory() || !UUID_RE.test(orgEntry.name)) continue
        const orgUuid = orgEntry.name.toLowerCase()
        const orgPath = join(acctPath, orgEntry.name)
        const files = await readdir(orgPath).catch(() => [])
        const localFiles = files.filter(f => f.startsWith('local_') && f.endsWith('.json'))
        if (localFiles.length === 0) continue
        const sessionIds: string[] = []
        for (const file of localFiles) {
          try {
            const meta = JSON.parse(await readFile(join(orgPath, file), 'utf-8')) as { cliSessionId?: unknown }
            if (typeof meta?.cliSessionId === 'string' && meta.cliSessionId.trim()) {
              sessionIds.push(meta.cliSessionId.trim())
            }
          } catch {
            continue
          }
        }
        const existing = byOrg.get(orgUuid)
        if (existing) {
          existing.sessionIds.push(...sessionIds)
        } else {
          byOrg.set(orgUuid, { orgUuid, accountUuid, path: orgPath, sessionIds })
        }
      }
    }
  }
  return byOrg
}

/**
 * Discovers Claude quota/usage profiles across both configured `claudeConfigDirs`
 * and multi-organization Claude Desktop setups (Personal + Team accounts).
 * Single-account setups without extra organizations return the exact same list as
 * `discoverClaudeConfigSources()`.
 */
export async function discoverClaudeProfileSources(): Promise<ClaudeConfigSource[]> {
  const base = await discoverClaudeConfigSources()
  const defaultDir = resolve(join(homedir(), '.claude'))
  const defaultIndex = base.findIndex(s => resolve(s.path) === defaultDir)
  const [defaultAcct, desktopOrgs, cachedOrgs] = await Promise.all([
    readDefaultClaudeOauthAccount(defaultDir),
    scanDesktopCodeSessionOrgs(),
    readClaudeOrgProfilesCache(),
  ])

  const cachedDefaultEntry = [...cachedOrgs.values()].find(o => o.isDefaultConfigOrg)
    ?? [...cachedOrgs.values()].find(o => o.organizationType === 'max' || o.organizationType === 'pro' || o.label === 'Personal')
  const defaultOrgUuid = cachedDefaultEntry?.orgUuid ?? defaultAcct.orgUuid
  const allOrgUuids = new Set<string>([
    ...desktopOrgs.keys(),
    ...cachedOrgs.keys(),
  ])
  if (defaultOrgUuid) allOrgUuids.delete(defaultOrgUuid)

  if (allOrgUuids.size === 0) return base

  const result = base.map((source, idx) => {
    if (idx !== defaultIndex) return source
    const cachedDefault = defaultOrgUuid ? cachedOrgs.get(defaultOrgUuid) : undefined
    const label = source.label === 'Default Claude'
      ? (formatOrgLabel(cachedDefault?.label, cachedDefault?.organizationType) ?? defaultAcct.label ?? 'Personal')
      : source.label
    return {
      ...source,
      label,
      ...(defaultOrgUuid ? { orgUuid: defaultOrgUuid } : {}),
      ...(cachedDefault?.accountUuid ?? defaultAcct.accountUuid ? { accountUuid: cachedDefault?.accountUuid ?? defaultAcct.accountUuid } : {}),
    }
  })

  const extraSources: ClaudeConfigSource[] = []
  for (const orgUuid of allOrgUuids) {
    const desktop = desktopOrgs.get(orgUuid)
    const cached = cachedOrgs.get(orgUuid)
    const orgPath = desktop?.path ?? defaultDir
    const accountUuid = desktop?.accountUuid ?? cached?.accountUuid
    const label = formatOrgLabel(cached?.label, cached?.organizationType) ?? 'Team'
    extraSources.push({
      id: claudeOrgSourceId(orgUuid),
      label,
      path: orgPath,
      orgUuid,
      ...(accountUuid ? { accountUuid } : {}),
    })
  }
  extraSources.sort((a, b) => a.label.localeCompare(b.label))
  return makeUniqueLabels([...result, ...extraSources])
}

/**
 * Maps `cliSessionId` (the `<sessionId>.jsonl` basename in `~/.claude/projects/`)
 * to its owning organization profile when multiple organizations are present.
 */
export async function discoverClaudeSessionOrgSources(): Promise<Map<string, ClaudeConfigSource>> {
  const map = new Map<string, ClaudeConfigSource>()
  const [profiles, desktopOrgs] = await Promise.all([
    discoverClaudeProfileSources(),
    scanDesktopCodeSessionOrgs(),
  ])
  if (profiles.length <= 1 || desktopOrgs.size === 0) return map
  const profileByOrg = new Map<string, ClaudeConfigSource>()
  for (const profile of profiles) {
    if (profile.orgUuid) profileByOrg.set(profile.orgUuid.toLowerCase(), profile)
  }
  for (const [orgUuid, info] of desktopOrgs) {
    const profile = profileByOrg.get(orgUuid.toLowerCase())
    if (!profile) continue
    for (const sessionId of info.sessionIds) {
      map.set(sessionId, profile)
    }
  }
  return map
}

// Filesystem changes under an unchanged input key intentionally do not invalidate this cache.
const desktopSessionsDirsCache = new Map<string, string[]>()

function cacheDesktopSessionsDirs(key: string, candidates: string[]): string[] {
  const dirs = dedupeResolved(candidates.map(candidate => resolve(candidate)))
  desktopSessionsDirsCache.set(key, dirs)
  return [...dirs]
}

export function getDesktopSessionsDirs(): string[] {
  const override = process.env['CODEBURN_DESKTOP_SESSIONS_DIR']
  const appDataInput = process.env['APPDATA']
  const localAppDataInput = process.env['LOCALAPPDATA']
  const platform = process.platform
  // homedir() feeds every non-override branch below, so a key without it hands
  // back the previous home's paths once the home directory moves.
  const cacheKey = JSON.stringify([
    platform,
    override ?? null,
    appDataInput ?? null,
    localAppDataInput ?? null,
    homedir(),
  ])
  const cached = desktopSessionsDirsCache.get(cacheKey)
  if (cached) return [...cached]

  if (override) return cacheDesktopSessionsDirs(cacheKey, [override])
  if (platform === 'darwin') {
    const appSupport = join(homedir(), 'Library', 'Application Support')
    return cacheDesktopSessionsDirs(
      cacheKey,
      [
        join(appSupport, 'Claude', 'local-agent-mode-sessions'),
        // Current Claude Desktop 3p builds use a distinct Electron user-data
        // directory for Cowork, while the Code surface continues to use the
        // traditional ~/.claude project store.
        join(appSupport, 'Claude-3p', 'local-agent-mode-sessions'),
      ],
    )
  }
  if (platform === 'win32') {
    const appData = appDataInput?.trim()
    const candidates = [
      join(appData || join(homedir(), 'AppData', 'Roaming'), 'Claude', 'local-agent-mode-sessions'),
    ]

    const localAppData = localAppDataInput?.trim()
    const packagesDir = join(localAppData || join(homedir(), 'AppData', 'Local'), 'Packages')
    try {
      const entries = readdirSync(packagesDir, { withFileTypes: true })
        .filter(entry =>
          entry.isDirectory() &&
          (entry.name.startsWith('Claude_') || entry.name.includes('.Claude_')),
        )
        .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

      for (const entry of entries) {
        const sessionsDir = join(
          packagesDir,
          entry.name,
          'LocalCache',
          'Roaming',
          'Claude',
          'local-agent-mode-sessions',
        )
        try {
          if (statSync(sessionsDir).isDirectory()) candidates.push(sessionsDir)
        } catch {
          // A package may disappear or be unreadable while Packages is scanned.
        }
      }
    } catch {
      // Missing or unreadable Packages is equivalent to no MSIX candidates.
    }

    return cacheDesktopSessionsDirs(cacheKey, candidates)
  }
  return cacheDesktopSessionsDirs(
    cacheKey,
    [join(homedir(), '.config', 'Claude', 'local-agent-mode-sessions')],
  )
}

async function findDesktopProjectDirs(base: string): Promise<string[]> {
  const results: string[] = []
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 8) return
    const entries = await readdir(dir).catch(() => [])
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.git') continue
      const full = join(dir, entry)
      const s = await stat(full).catch(() => null)
      if (!s?.isDirectory()) continue
      if (entry === 'projects') {
        const projectDirs = await readdir(full).catch(() => [])
        for (const pd of projectDirs) {
          const pdFull = join(full, pd)
          const pdStat = await stat(pdFull).catch(() => null)
          if (pdStat?.isDirectory()) results.push(pdFull)
        }
      } else {
        await walk(full, depth + 1)
      }
    }
  }
  await walk(base, 0)
  return results
}

async function findDesktopUsageLedgerFiles(base: string): Promise<string[]> {
  const results: string[] = []

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 8) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name === 'node_modules' || entry.name === '.git') continue

      const full = join(dir, entry.name)
      if (entry.name === 'usage-ledger') {
        const ledgerEntries = await readdir(full, { withFileTypes: true }).catch(() => [])
        for (const ledgerEntry of ledgerEntries) {
          if (ledgerEntry.isFile() && ledgerEntry.name.endsWith('.ndjson')) {
            results.push(join(full, ledgerEntry.name))
          }
        }
        continue
      }
      await walk(full, depth + 1)
    }
  }

  await walk(base, 0)
  return results
}

type CoworkLedgerObject = Record<string, unknown>

function ledgerObject(value: unknown): CoworkLedgerObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as CoworkLedgerObject
    : null
}

function ledgerNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function ledgerTimestamp(value: unknown): string | undefined {
  const raw = ledgerNumber(value)
  if (raw === undefined) return undefined
  const milliseconds = raw >= 1_000_000_000_000 ? raw : raw * 1000
  const date = new Date(milliseconds)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function createCoworkLedgerParser(
  source: SessionSource,
  seenKeys: Set<string>,
): SessionParser {
  return {
    async *parse() {
      if (source.sourceKind !== 'claude-desktop-ledger') return

      let lineNumber = 0
      for await (const rawLine of readSessionLines(source.path)) {
        lineNumber++
        let parsed: unknown
        try {
          parsed = JSON.parse(rawLine)
        } catch {
          // Cowork appends records while a turn is in flight. Ignore a torn
          // final line; valid records elsewhere in the ledger remain usable.
          continue
        }

        const record = ledgerObject(parsed)
        const surface = record?.['surface']
        if (!record || (surface !== 'cowork' && surface !== 'code')) continue

        const sessionId = typeof record['sessionId'] === 'string' ? record['sessionId'] : ''
        const timestamp = ledgerTimestamp(record['ts'])
        if (!sessionId || !timestamp) continue

        const models = ledgerObject(record['models'])
        if (!models) continue

        for (const [model, rawUsage] of Object.entries(models)) {
          const usage = ledgerObject(rawUsage)
          if (!usage) continue

          const inputTokens = Math.max(0, ledgerNumber(usage['inputTokens']) ?? 0)
          const outputTokens = Math.max(0, ledgerNumber(usage['outputTokens']) ?? 0)
          const cacheReadInputTokens = Math.max(0, ledgerNumber(usage['cacheReadTokens']) ?? 0)
          const cacheCreationInputTokens = Math.max(0, ledgerNumber(usage['cacheWriteTokens']) ?? 0)
          const webSearchRequests = Math.max(0, ledgerNumber(usage['webSearchRequests']) ?? 0)
          const recordedCost = ledgerNumber(ledgerObject(usage['cost'])?.['usd'])
          const estimatedCost = calculateCost(
            model,
            inputTokens,
            outputTokens,
            cacheCreationInputTokens,
            cacheReadInputTokens,
            webSearchRequests,
            'standard',
            0,
            'claude',
          )

          if (
            inputTokens === 0 &&
            outputTokens === 0 &&
            cacheReadInputTokens === 0 &&
            cacheCreationInputTokens === 0 &&
            recordedCost === undefined
          ) {
            continue
          }

          const deduplicationKey = `claude-cowork-ledger:${source.path}:${sessionId}:${timestamp}:${model}`
          if (seenKeys.has(deduplicationKey)) continue
          seenKeys.add(deduplicationKey)

          yield {
            provider: 'claude',
            model,
            inputTokens,
            outputTokens,
            cacheCreationInputTokens,
            cacheReadInputTokens,
            cachedInputTokens: cacheReadInputTokens,
            reasoningTokens: 0,
            webSearchRequests,
            // Keep the ledger's dollar amount only as a fallback for a model
            // CodeBurn cannot price. Known models must use CodeBurn's pricing
            // and overrides so cached usage can be repriced later.
            costUSD: estimatedCost,
            ...(recordedCost !== undefined ? { fallbackCostUSD: recordedCost } : {}),
            tools: [],
            bashCommands: [],
            skills: [],
            subagentTypes: [],
            timestamp,
            speed: 'standard',
            deduplicationKey,
            userMessage: '',
            sessionId,
            project: surface === 'code' ? 'Claude Code' : 'Claude Cowork',
            turnId: `${timestamp}:${lineNumber}`,
          }
        }
      }
    },
  }
}

// ── Cowork space resolution ────────────────────────────────────────────
// Claude Desktop's local-agent-mode creates one directory per session under
//   <desktopSessionsDir>/<appId>/<workspaceId>/local_<sessionId>/
// Inside each session directory Claude Code stores its own config at
//   .claude/projects/<sanitized-cwd>/
// which is what findDesktopProjectDirs picks up. The actual project name
// lives in the sibling <workspaceId>/local_<sessionId>.json (spaceId field)
// and <workspaceId>/spaces.json (id → name mapping).

interface CoworkSpace { id: string; name: string }
interface CoworkSpacesFile { spaces: CoworkSpace[] }

// Cache spaces.json per workspace directory to avoid redundant reads.
const spacesJsonCache = new Map<string, CoworkSpacesFile | null>()

async function loadSpacesJson(workspaceDir: string): Promise<CoworkSpacesFile | null> {
  if (spacesJsonCache.has(workspaceDir)) return spacesJsonCache.get(workspaceDir) ?? null
  try {
    const raw = await readFile(join(workspaceDir, 'spaces.json'), 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'spaces' in parsed &&
      Array.isArray((parsed as { spaces: unknown }).spaces)
    ) {
      const result = parsed as CoworkSpacesFile
      spacesJsonCache.set(workspaceDir, result)
      return result
    }
  } catch {
    // unreadable or malformed — treat as no spaces
  }
  spacesJsonCache.set(workspaceDir, null)
  return null
}

async function resolveCoworkSpaceName(workspaceDir: string, sessionId: string): Promise<string | null> {
  const [spacesFile, sessionMetaRaw] = await Promise.all([
    loadSpacesJson(workspaceDir),
    readFile(join(workspaceDir, `${sessionId}.json`), 'utf-8').catch(() => null),
  ])
  if (!sessionMetaRaw) return null
  let sessionMeta: unknown
  try { sessionMeta = JSON.parse(sessionMetaRaw) } catch { return null }
  if (sessionMeta === null || typeof sessionMeta !== 'object') return null
  const meta = sessionMeta as Record<string, unknown>

  const spaceId = meta['spaceId']
  if (typeof spaceId === 'string' && spacesFile) {
    const spaceName = spacesFile.spaces.find(s => s.id === spaceId)?.name
    if (spaceName) return spaceName
  }

  // No spaceId (standalone session): fall back to selected folder then title.
  const folders = meta['userSelectedFolders']
  if (Array.isArray(folders) && folders.length > 0 && typeof folders[0] === 'string') {
    return basename(folders[0])
  }
  const title = meta['title']
  if (typeof title === 'string' && title.trim().length > 0) return title.trim()

  return null
}

export const claude: Provider = {
  name: 'claude',
  displayName: 'Claude',

  modelDisplayName(model: string): string {
    return getShortModelName(model)
  },

  toolDisplayName(rawTool: string): string {
    return rawTool
  },

  // Each config dir's `projects/` subdir is what discoverSessions readdir's,
  // plus the Claude Desktop sessions base. Resolved via the same helpers so a
  // CLAUDE_CONFIG_DIR(S) override is reflected exactly.
  async probeRoots(): Promise<ProbeRoot[]> {
    const dirs = await getClaudeConfigDirs()
    const roots: ProbeRoot[] = dirs.map(dir => ({ path: join(dir, 'projects'), label: 'projects' }))
    roots.push(...getDesktopSessionsDirs().map(path => ({ path, label: 'desktop' })))
    return roots
  },

  async discoverSessions(): Promise<SessionSource[]> {
    const sources: SessionSource[] = []
    const seenProjectDirs = new Set<string>()
    const configSources = await discoverClaudeConfigSources()
    let anyDirReadable = false

    for (const configSource of configSources) {
      const claudeDir = configSource.path
      const projectsDir = join(claudeDir, 'projects')
      let entries: string[]
      try {
        entries = await readdir(projectsDir)
        anyDirReadable = true
      } catch {
        // Missing or unreadable dir is not fatal: a user can configure both
        // a real and a stale path in CLAUDE_CONFIG_DIRS without breaking.
        continue
      }
      // stat() (not the readdir Dirent) decides directory-ness so a symlinked
      // project dir still counts; issue them concurrently, then apply the
      // order-sensitive dedup serially.
      const dirStats = await mapWithConcurrency(entries, FS_SCAN_CONCURRENCY, dirName =>
        stat(join(projectsDir, dirName)).catch(() => null))
      for (const [i, dirName] of entries.entries()) {
        const dirPath = join(projectsDir, dirName)
        // Resolve before deduping so two CLAUDE_CONFIG_DIRS entries that
        // reach the same projects/<slug> directory (via symlinks or
        // overlapping configs) emit only one SessionSource.
        const resolved = resolve(dirPath)
        if (seenProjectDirs.has(resolved)) continue
        const dirStat = dirStats[i]
        if (!dirStat?.isDirectory()) continue
        seenProjectDirs.add(resolved)
        // `project: dirName` is identical across config dirs for the same
        // sanitized slug, which is exactly what makes the parser merge
        // their sessions into a single ProjectSummary.
        sources.push({
          path: dirPath,
          project: dirName,
          provider: 'claude',
          sourceId: configSource.id,
          sourceLabel: configSource.label,
          sourcePath: configSource.path,
          sourceKind: 'claude-config',
        })
      }
    }

    // If the user explicitly set CLAUDE_CONFIG_DIRS and every entry was
    // unreadable, emit a one-line stderr hint. Catches the most common
    // misconfiguration: a Windows user typing `:` (POSIX delimiter) when
    // the platform expects `;`, which produces a single bogus path that
    // silently resolves to nothing on disk.
    const explicitMulti = process.env['CLAUDE_CONFIG_DIRS']
    if (!anyDirReadable && explicitMulti !== undefined && explicitMulti !== '' && configSources.length > 0) {
      process.stderr.write(
        `codeburn: CLAUDE_CONFIG_DIRS was set but no listed directory could be read. ` +
        `Tried: ${configSources.map(s => s.path).join(', ')}. ` +
        `Use "${pathDelimiter}" as the separator on this platform.\n`,
      )
    }

    for (const desktopBase of getDesktopSessionsDirs()) {
      const desktopDirs = await findDesktopProjectDirs(desktopBase)
      const sep = desktopBase.includes('\\') ? '\\' : '/'
      // Desktop / Cowork sessions belong to no CLAUDE_CONFIG_DIR. Tag them with a
      // distinct source so a per-config view can account for them as their own
      // "Claude Desktop" bucket instead of silently dropping them (which made
      // sum-of-configs < All).
      const desktopSourceId = claudeDesktopSourceId(desktopBase)
      for (const dirPath of desktopDirs) {
        const resolved = resolve(dirPath)
        if (seenProjectDirs.has(resolved)) continue
        seenProjectDirs.add(resolved)

        // For Claude Desktop local-agent-mode (Cowork) sessions, the project dir
        // lives inside local_<sessionId>/.claude/projects/. We resolve the space
        // name from the sibling .json and spaces.json so it groups correctly.
        // Path structure: <desktopBase>/<appId>/<workspaceId>/local_<id>/.claude/projects/<slug>
        let projectName = basename(dirPath)
        const resolvedBase = resolve(desktopBase)
        if (resolved.startsWith(resolvedBase + sep) || resolved.startsWith(resolvedBase + '/')) {
          const rel = resolved.slice(resolvedBase.length + 1)
          const parts = rel.split(/[/\\]/)
          // parts = [appId, workspaceId, local_sessionId, .claude, projects, slug]
          if (
            parts.length >= 6 &&
            parts[2]?.startsWith('local_') &&
            parts[3] === '.claude' &&
            parts[4] === 'projects'
          ) {
            const workspaceDir = join(resolvedBase, parts[0]!, parts[1]!)
            const sessionId = parts[2]!
            const spaceName = await resolveCoworkSpaceName(workspaceDir, sessionId)
            if (spaceName) projectName = spaceName
          }
        }

        sources.push({
          path: dirPath,
          project: projectName,
          provider: 'claude',
          sourceId: desktopSourceId,
          sourceLabel: 'Claude Desktop',
          sourcePath: desktopBase,
          sourceKind: 'claude-desktop',
        })
      }

      // Current Claude Desktop Cowork builds also keep metered usage in a
      // workspace-level usage-ledger/*.ndjson file. These records are separate
      // from the Claude Code JSONL transcripts above and must be exposed as
      // leaf sources so the generic provider cache can fingerprint and parse
      // them incrementally.
      for (const ledgerPath of await findDesktopUsageLedgerFiles(desktopBase)) {
        sources.push({
          path: ledgerPath,
          project: 'Claude Cowork',
          provider: 'claude',
          sourceId: desktopSourceId,
          sourceLabel: 'Claude Desktop',
          sourcePath: desktopBase,
          sourceKind: 'claude-desktop-ledger',
        })
      }
    }

    return sources
  },

  createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
    return createCoworkLedgerParser(source, seenKeys)
  },
}

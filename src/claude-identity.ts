import { createHash, randomBytes } from 'crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'

import { behavioralCallWeight } from './behavioral-weight.js'
import { readExistingTextFile } from './cache-dir.js'
import { getConfigDir } from './config.js'
import { getClaudeConfigDirs } from './providers/claude.js'
import { readClaudePlan } from './quota/claude.js'
import { inferSessionProvider } from './session-output.js'
import type { ProjectSummary, SessionSummary } from './types.js'

export type IdentityEntry = { accountHash: string; orgHash?: string; label: string; plan?: string; observedAt: string; configDir: string }
export type IdentityLog = { version: 1; entries: IdentityEntry[]; labels: Record<string, string> }
export type IdentitySplitRow = { hash: string; label: string; plan?: string; cost: number; calls: number; sessions: number }

export const UNATTRIBUTED = 'unattributed'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function identityLogPath(): string {
  return join(getConfigDir(), 'identity-log.v1.json')
}

// 12 hex (48 bits) keeps a few local accounts apart without storing anything that maps back to the raw id.
function shortHash(uuid: string): string {
  return createHash('sha256').update(uuid).digest('hex').slice(0, 12)
}

function cleanUuid(value: unknown): string | undefined {
  return typeof value === 'string' && UUID_RE.test(value.trim()) ? value.trim().toLowerCase() : undefined
}

function cleanName(value: unknown): string | undefined {
  const name = typeof value === 'string' ? value.trim() : ''
  return name && name.length <= 256 && !/[\x00-\x1f\x7f]/.test(name) ? name : undefined
}

function claudeJsonCandidates(configDir: string): string[] {
  return resolve(configDir) === resolve(join(homedir(), '.claude'))
    ? [join(homedir(), '.claude.json'), join(configDir, '.claude.json')]
    : [join(configDir, '.claude.json')]
}

export async function readClaudeAccount(file: string): Promise<{ accountUuid: string; organizationUuid?: string; organizationName?: string } | null> {
  try {
    const account = (JSON.parse(await readFile(file, 'utf-8')) as { oauthAccount?: Record<string, unknown> | null })?.oauthAccount
    const accountUuid = cleanUuid(account?.accountUuid)
    if (!accountUuid) return null
    return { accountUuid, organizationUuid: cleanUuid(account?.organizationUuid), organizationName: cleanName(account?.organizationName) }
  } catch {
    return null
  }
}

export async function readIdentityLog(): Promise<IdentityLog | null> {
  const file = await readExistingTextFile(identityLogPath())
  if (file.status === 'absent') return { version: 1, entries: [], labels: {} }
  if (file.status === 'unreadable') return null
  try {
    const parsed = JSON.parse(file.text) as IdentityLog
    return parsed?.version === 1 && Array.isArray(parsed.entries) ? { ...parsed, labels: parsed.labels ?? {} } : null
  } catch {
    return null
  }
}

async function writeIdentityLog(log: IdentityLog): Promise<void> {
  const path = identityLogPath()
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${randomBytes(8).toString('hex')}.tmp`
  await writeFile(tmp, JSON.stringify(log, null, 2) + '\n', { mode: 0o600 })
  await rename(tmp, path)
}

const observedStats = new Map<string, string>()

export async function observeClaudeIdentities(now = new Date()): Promise<void> {
  for (const configDir of await getClaudeConfigDirs()) {
    const files = claudeJsonCandidates(configDir)
    const key = (await Promise.all(files.map(f => stat(f).then(s => `${s.mtimeMs}:${s.size}`, () => '-')))).join('|')
    if (observedStats.get(configDir) === key) continue
    observedStats.set(configDir, key)
    let account = null
    for (const file of files) if ((account = await readClaudeAccount(file))) break
    if (!account) continue
    const log = await readIdentityLog()
    if (!log) return
    const accountHash = shortHash(account.accountUuid)
    const orgHash = account.organizationUuid ? shortHash(account.organizationUuid) : undefined
    const plan = await readClaudePlan(configDir)
    const last = log.entries.filter(e => e.configDir === configDir).at(-1)
    if (last?.accountHash === accountHash && last.orgHash === orgHash && (!plan || last.plan === plan)) continue
    log.entries.push({ accountHash, ...(orgHash ? { orgHash } : {}), label: account.organizationName ?? '', ...(plan ? { plan } : {}), observedAt: now.toISOString(), configDir })
    await writeIdentityLog(log)
  }
}

export async function recordClaudePlan(configDir: string, name: string, now = new Date()): Promise<void> {
  const plan = cleanName(name)
  if (!plan) return
  await observeClaudeIdentities(now)
  const log = await readIdentityLog()
  const last = log?.entries.filter(e => e.configDir === configDir).at(-1)
  if (!log || !last || last.plan === plan) return
  log.entries.push({ ...last, plan, observedAt: now.toISOString() })
  await writeIdentityLog(log)
}

/** An identity is one account in one organization, or the account when Claude reports no organization. */
export function identityId(entry: IdentityEntry): string {
  return entry.orgHash ? entry.orgHash.slice(0, 6) + entry.accountHash.slice(0, 6) : entry.accountHash
}

function identityIds(log: IdentityLog): string[] {
  return [...new Set(log.entries.map(identityId))]
}

export async function multipleIdentities(): Promise<boolean> {
  const log = await readIdentityLog().catch(() => null)
  return !!log && identityIds(log).length >= 2
}

function baseLabel(log: IdentityLog, hash: string): string {
  const entries = log.entries.filter(e => identityId(e) === hash)
  const orgHash = entries.at(-1)?.orgHash
  return log.labels[hash] || (orgHash && log.labels[orgHash]) || entries.filter(e => e.label).at(-1)?.label || hash
}

export function identityLabel(log: IdentityLog, hash: string): string {
  if (hash === UNATTRIBUTED) return UNATTRIBUTED
  const label = baseLabel(log, hash)
  const account = log.entries.find(e => identityId(e) === hash)?.accountHash
  const shared = identityIds(log).some(id => id !== hash && baseLabel(log, id) === label)
  return shared && account ? `${label} (${account.slice(0, 4)})` : label
}

type Identity = { hash: string; label: string; plan?: string }

function identityResolver(log: IdentityLog): (configDir: string | undefined, timestamp: string) => Identity {
  const marks = log.entries.map(e => ({ configDir: e.configDir, at: Date.parse(e.observedAt), hash: identityId(e) }))
  const known = new Map<string, Identity>()
  return (configDir, timestamp) => {
    const at = Date.parse(timestamp)
    let hash = UNATTRIBUTED
    for (const mark of marks) if (mark.configDir === configDir && mark.at <= at) hash = mark.hash
    let identity = known.get(hash)
    if (!identity) {
      const plan = log.entries.filter(e => identityId(e) === hash && e.plan).at(-1)?.plan
      known.set(hash, identity = { hash, label: identityLabel(log, hash), ...(plan ? { plan } : {}) })
    }
    return identity
  }
}

export function identityAt(log: IdentityLog, configDir: string | undefined, startedAt: string): Identity {
  return identityResolver(log)(configDir, startedAt)
}

function sessionConfigDir(session: SessionSummary): string | undefined {
  return session.source?.kind === 'claude-config' ? session.source.path : undefined
}

let appliedResolver: ReturnType<typeof identityResolver> | undefined

/** Observes, then stamps every Claude session with the account active at its start. Without `always`, a log of fewer than two accounts leaves sessions untouched. */
export async function applyClaudeIdentities(projects: ProjectSummary[], always = false): Promise<ProjectSummary[]> {
  await observeClaudeIdentities().catch(() => {})
  const log = await readIdentityLog().catch(() => null)
  if (!log || (!always && identityIds(log).length < 2)) return projects
  const resolver = appliedResolver = identityResolver(log)
  const attribute = (session: SessionSummary): SessionSummary => inferSessionProvider(session) !== 'claude' ? session : {
    ...session,
    identity: resolver(sessionConfigDir(session), session.firstTimestamp),
  }
  return projects.map(project => ({
    ...project,
    sessions: project.sessions.map(attribute),
    ...(project.subagentAnchors ? { subagentAnchors: project.subagentAnchors.map(attribute) } : {}),
  }))
}

/** Per-identity totals, each call credited to the account active at its own time; undefined when fewer than `min` identities. */
export function identitySplit(projects: ProjectSummary[], min = 2): IdentitySplitRow[] | undefined {
  const rows = new Map<string, IdentitySplitRow & { ids: Set<string> }>()
  const credit = (session: SessionSummary, identity: Identity, cost: number, calls: number) => {
    const row = rows.get(identity.hash) ?? { ...identity, cost: 0, calls: 0, sessions: 0, ids: new Set<string>() }
    row.cost += cost
    row.calls += calls
    if (!session.isSidechain) row.ids.add(session.sessionId)
    rows.set(identity.hash, row)
  }
  for (const session of projects.flatMap(project => project.sessions)) {
    if (!session.identity) continue
    const calls = (session.turns ?? []).flatMap(turn => turn.assistantCalls)
    if (!appliedResolver || calls.length === 0) credit(session, session.identity, session.totalCostUSD, session.apiCalls)
    else for (const call of calls) credit(session, appliedResolver(sessionConfigDir(session), call.timestamp), call.costUSD, behavioralCallWeight(call))
  }
  if (rows.size < min) return undefined
  return [...rows.values()]
    .map(({ ids, ...row }) => ({ ...row, sessions: ids.size }))
    .sort((a, b) => b.cost - a.cost)
}

/** Resolves an identity hash or label (case-insensitive) to its identity hash; an organization hash or a shared label resolves to every account it covers. */
export async function resolveIdentity(value: string): Promise<string[] | null> {
  if (value === UNATTRIBUTED) return [UNATTRIBUTED]
  const log = await readIdentityLog()
  if (!log) return null
  const hashes = identityIds(log)
  const lower = value.toLowerCase()
  const one = hashes.find(h => h === value) ?? hashes.find(h => identityLabel(log, h).toLowerCase() === lower)
  if (one) return [one]
  const group = hashes.filter(h => log.entries.some(e => e.orgHash === value && identityId(e) === h) || baseLabel(log, h).toLowerCase() === lower)
  return group.length > 0 ? group : null
}

export async function setIdentityLabel(hash: string, name: string): Promise<void> {
  const log = await readIdentityLog()
  if (!log) throw new Error(`cannot read ${identityLogPath()}`)
  if (!identityIds(log).includes(hash) && !log.entries.some(e => e.orgHash === hash)) throw new Error(`no Claude identity ${hash} in the identity log; see \`codeburn identity list\``)
  const label = cleanName(name)
  if (!label) throw new Error('label must be 1-256 printable characters')
  log.labels[hash] = label
  await writeIdentityLog(log)
}

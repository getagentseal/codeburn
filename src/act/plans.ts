import { existsSync, readFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { isAbsolute, join } from 'path'
import { homedir } from 'os'
import type { ActionKind, ActionPlan, PlannedChange } from './types.js'
import { sha256 } from './backup.js'
import {
  ALWAYSLOAD_MIN_VERSION,
  ALWAYSLOAD_STARTUP_CAP_SECONDS,
  ENABLE_TOOL_SEARCH_VAR,
  parseVersion,
  versionPredates,
} from '../optimize.js'
import type { WasteFinding } from '../optimize.js'

// Turns an optimize finding into a concrete, journaled file-mutation plan.
// Only config-class findings are appliable; everything else yields plan: null
// (shown as "manual" by the CLI). Every path is derived from an injectable
// context so tests can point the whole thing at a fixture home.

export type PlanContext = {
  homeDir?: string
  cwd?: string
  shell?: string
  // Installed Claude Code version (null when undeterminable). Injectable so
  // tests never shell out; production defaults to probing `claude --version`.
  claudeVersion?: () => string | null
}

export type BuiltPlan = {
  plan: ActionPlan | null
  // Human-facing skip reasons and parse errors, surfaced in the apply summary.
  notes: string[]
  // Per-file preview annotations (path -> text), e.g. which ~/.claude.json
  // project entries lose a server.
  pathNotes?: Record<string, string>
}

export type FindingPlan = BuiltPlan & { finding: WasteFinding }

type ResolvedPaths = {
  homeDir: string
  cwd: string
  projectMcpJson: string
  projectSettings: string
  projectSettingsLocal: string
  userClaudeJson: string
  userSettings: string
  skillsDir: string
  agentsDir: string
  commandsDir: string
  projectClaudeMd: string
  shellRc: string
  // Not a path, but resolved from the same context: the injectable installed-
  // version probe the defer-alwaysload version gate consults.
  claudeVersion: () => string | null
}

// `claude --version` prints e.g. "2.1.130 (Claude Code)"; any failure (binary
// missing, timeout, non-zero exit) yields null and version-gated plans
// degrade to a manual note instead of guessing.
const CLAUDE_VERSION_PROBE_TIMEOUT_MS = 3000

function probeClaudeVersion(): string | null {
  try {
    return execFileSync('claude', ['--version'], {
      encoding: 'utf-8',
      timeout: CLAUDE_VERSION_PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

function resolvePaths(ctx: PlanContext): ResolvedPaths {
  const homeDir = ctx.homeDir ?? homedir()
  const cwd = ctx.cwd ?? process.cwd()
  const shell = ctx.shell ?? process.env['SHELL'] ?? ''
  return {
    homeDir,
    cwd,
    projectMcpJson: join(cwd, '.mcp.json'),
    projectSettings: join(cwd, '.claude', 'settings.json'),
    projectSettingsLocal: join(cwd, '.claude', 'settings.local.json'),
    userClaudeJson: join(homeDir, '.claude.json'),
    userSettings: join(homeDir, '.claude', 'settings.json'),
    skillsDir: join(homeDir, '.claude', 'skills'),
    agentsDir: join(homeDir, '.claude', 'agents'),
    commandsDir: join(homeDir, '.claude', 'commands'),
    projectClaudeMd: join(cwd, 'CLAUDE.md'),
    shellRc: join(homeDir, /zsh/.test(shell) ? '.zshrc' : '.bashrc'),
    claudeVersion: ctx.claudeVersion ?? probeClaudeVersion,
  }
}

export function planFor(finding: WasteFinding, ctx: PlanContext = {}): ActionPlan | null {
  return buildPlan(finding, resolvePaths(ctx)).plan
}

export function planFindings(findings: WasteFinding[], ctx: PlanContext = {}): FindingPlan[] {
  const r = resolvePaths(ctx)
  return findings.map(finding => ({ finding, ...buildPlan(finding, r) }))
}

function buildPlan(finding: WasteFinding, r: ResolvedPaths): BuiltPlan {
  switch (finding.id) {
    case 'mcp-low-coverage': return buildMcpRemove(finding, r)
    case 'unused-mcp': return buildMcpRemove(finding, r)
    case 'mcp-project-scope': return buildMcpProjectScope(finding, r)
    case 'mcp-deferral-off': return buildDeferEnable(finding, r)
    case 'mcp-alwaysload-hygiene': return buildDeferAlwaysLoad(finding, r)
    case 'mcp-defer-threshold': return buildDeferThreshold(finding, r)
    case 'unused-skills': return buildArchive(finding, r, 'skill')
    case 'unused-agents': return buildArchive(finding, r, 'agent')
    case 'unused-commands': return buildArchive(finding, r, 'command')
    case 'bash-output-cap': return buildShellConfig(finding, r)
    default:
      if (finding.fix.type === 'paste' && finding.fix.destination === 'claude-md') {
        return buildClaudeMdRule(finding, r)
      }
      return { plan: null, notes: [] }
  }
}

// ---------------------------------------------------------------------------
// MCP config editing (remove + project-scope)
// ---------------------------------------------------------------------------

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function shortPath(p: string, homeDir: string): string {
  return p.startsWith(homeDir) ? '~' + p.slice(homeDir.length) : p
}

// Config keys are the server's original name; coverage findings carry the
// runtime-normalized form (":" -> "_"). Match either.
function findServerKey(container: Record<string, unknown> | undefined, server: string): string | null {
  if (!container) return null
  for (const k of Object.keys(container)) {
    if (k === server || k.replace(/:/g, '_') === server) return k
  }
  return null
}

type DocState = {
  path: string
  doc: Record<string, unknown>
  existed: boolean
  dirty: boolean
  // sha256 of the raw bytes the doc was parsed from (before the BOM strip);
  // null when the file did not exist. Becomes the change's expectedHash so
  // runAction refuses to apply over a file edited after the plan was built.
  rawHash: string | null
}

// Reads each config file at most once, tracks parse errors, and emits one
// PlannedChange per file it actually mutated.
class ConfigDocs {
  private docs = new Map<string, DocState | null>()
  private errors = new Map<string, string>()
  constructor(private homeDir: string) {}

  load(path: string): DocState | null {
    if (this.docs.has(path)) return this.docs.get(path)!
    if (!existsSync(path)) {
      const state: DocState = { path, doc: {}, existed: false, dirty: false, rawHash: null }
      this.docs.set(path, state)
      return state
    }
    let buf: Buffer
    try {
      buf = readFileSync(path)
    } catch (e) {
      this.errors.set(path, `could not read ${shortPath(path, this.homeDir)}: ${errMessage(e)}`)
      this.docs.set(path, null)
      return null
    }
    const rawHash = sha256(buf)
    let raw = buf.toString('utf-8')
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
    try {
      const doc = JSON.parse(raw) as Record<string, unknown>
      const state: DocState = { path, doc, existed: true, dirty: false, rawHash }
      this.docs.set(path, state)
      return state
    } catch (e) {
      this.errors.set(path, `could not parse ${shortPath(path, this.homeDir)}: ${errMessage(e)}`)
      this.docs.set(path, null)
      return null
    }
  }

  changes(): PlannedChange[] {
    const out: PlannedChange[] = []
    for (const state of this.docs.values()) {
      if (state && state.dirty) {
        out.push({
          op: state.existed ? 'edit' : 'create',
          path: state.path,
          content: JSON.stringify(state.doc, null, 2) + '\n',
          expectedHash: state.rawHash,
        })
      }
    }
    return out
  }

  errorNotes(): string[] {
    return [...this.errors.values()]
  }
}

type ContainerRef = { container: Record<string, unknown>; projectPath: string | null }

function serverContainers(state: DocState, isUserClaudeJson: boolean): ContainerRef[] {
  const containers: ContainerRef[] = []
  const top = state.doc.mcpServers
  if (top && typeof top === 'object') containers.push({ container: top as Record<string, unknown>, projectPath: null })
  if (isUserClaudeJson) {
    const projects = state.doc.projects
    if (projects && typeof projects === 'object') {
      for (const [projectPath, entry] of Object.entries(projects as Record<string, unknown>)) {
        const pm = (entry as Record<string, unknown> | null)?.['mcpServers']
        if (pm && typeof pm === 'object') containers.push({ container: pm as Record<string, unknown>, projectPath })
      }
    }
  }
  return containers
}

// Deletes the server from the file's containers. With projectScope set, only
// the top-level container and the listed (cold) project entries are touched;
// entries under any other project path keep their copy.
function deleteServer(
  state: DocState,
  server: string,
  isUserClaudeJson: boolean,
  projectScope?: ReadonlySet<string>,
): { removed: boolean; projectEntries: string[] } {
  let removed = false
  const projectEntries: string[] = []
  for (const { container, projectPath } of serverContainers(state, isUserClaudeJson)) {
    if (projectScope && projectPath !== null && !projectScope.has(projectPath)) continue
    const key = findServerKey(container, server)
    if (!key) continue
    delete container[key]
    state.dirty = true
    removed = true
    if (projectPath !== null) projectEntries.push(projectPath)
  }
  return { removed, projectEntries }
}

function readServerValue(state: DocState, server: string, isUserClaudeJson: boolean): unknown {
  for (const { container } of serverContainers(state, isUserClaudeJson)) {
    const key = findServerKey(container, server)
    if (key) return container[key]
  }
  return undefined
}

function projectRemovalNote(server: string, entries: string[], homeDir: string): string {
  const noun = entries.length === 1 ? 'entry' : 'entries'
  return `removes ${server} from ${entries.length} project ${noun}: ${entries.map(e => shortPath(e, homeDir)).join(', ')}`
}

// Accumulates per-file preview annotations; repeats on a path join with ";".
function pathNoteAdder(pathNotes: Record<string, string>): (path: string, note: string) => void {
  return (path, note) => {
    pathNotes[path] = pathNotes[path] ? `${pathNotes[path]}; ${note}` : note
  }
}

function buildMcpRemove(finding: WasteFinding, r: ResolvedPaths): BuiltPlan {
  const servers = finding.apply?.kind === 'mcp-remove' ? finding.apply.servers : []
  const searchPaths = [r.projectMcpJson, r.projectSettings, r.projectSettingsLocal, r.userClaudeJson]
  const docs = new ConfigDocs(r.homeDir)
  const skips: string[] = []
  const pathNotes: Record<string, string> = {}
  const addPathNote = pathNoteAdder(pathNotes)

  for (const server of servers) {
    let removed = false
    for (const path of searchPaths) {
      const state = docs.load(path)
      if (!state) continue
      const res = deleteServer(state, server, path === r.userClaudeJson)
      if (res.removed) removed = true
      if (res.projectEntries.length > 0) addPathNote(path, projectRemovalNote(server, res.projectEntries, r.homeDir))
    }
    if (!removed) skips.push(`skipped ${server}: not found in editable config (plugin or managed config?)`)
  }

  const changes = docs.changes()
  const notes = [...docs.errorNotes(), ...skips]
  if (changes.length === 0) return { plan: null, notes }
  return {
    plan: mcpPlan('mcp-remove', finding.id, `Remove ${changes.length === 1 ? 'an MCP server' : 'MCP servers'} from config`, changes),
    notes,
    ...(Object.keys(pathNotes).length > 0 ? { pathNotes } : {}),
  }
}

function buildMcpProjectScope(finding: WasteFinding, r: ResolvedPaths): BuiltPlan {
  const entries = finding.apply?.kind === 'mcp-project-scope' ? finding.apply.servers : []
  const searchPaths = [r.projectMcpJson, r.projectSettings, r.projectSettingsLocal, r.userClaudeJson]
  const docs = new ConfigDocs(r.homeDir)
  const skips: string[] = []
  const pathNotes: Record<string, string> = {}
  const addPathNote = pathNoteAdder(pathNotes)

  for (const { server, keepProjects, removeProjects } of entries) {
    const keepers = keepProjects.filter(p => isAbsolute(p))
    if (keepers.length === 0) {
      skips.push(`skipped ${server}: no absolute keeper project path to scope into`)
      continue
    }

    let value: unknown
    for (const path of searchPaths) {
      const state = docs.load(path)
      if (!state) continue
      const found = readServerValue(state, server, path === r.userClaudeJson)
      if (found !== undefined) { value = found; break }
    }
    if (value === undefined) {
      skips.push(`skipped ${server}: not found in editable config (plugin or managed config?)`)
      continue
    }

    // Scoped removal: only the global entry and the finding's cold projects
    // lose the server. The cwd's own config files count as cold only when
    // the cwd is in the cold list; a keeper or unrelated cwd keeps its copy.
    const coldSet = new Set(removeProjects)
    const keeperMcpPaths = new Set(keepers.map(k => join(k, '.mcp.json')))
    for (const path of searchPaths) {
      if (keeperMcpPaths.has(path)) continue
      const isUser = path === r.userClaudeJson
      if (!isUser && !coldSet.has(r.cwd)) continue
      const state = docs.load(path)
      if (!state) continue
      const res = deleteServer(state, server, isUser, isUser ? coldSet : undefined)
      if (res.projectEntries.length > 0) addPathNote(path, projectRemovalNote(server, res.projectEntries, r.homeDir))
    }

    for (const keeper of keepers) {
      const state = docs.load(join(keeper, '.mcp.json'))
      if (!state) {
        skips.push(`skipped ${server} for ${keeper}: its .mcp.json could not be parsed`)
        continue
      }
      const existing = state.doc.mcpServers
      const mcpServers = existing && typeof existing === 'object'
        ? existing as Record<string, unknown>
        : (state.doc.mcpServers = {})
      mcpServers[server] = value
      state.dirty = true
    }
  }

  const changes = docs.changes()
  const notes = [...docs.errorNotes(), ...skips]
  if (changes.length === 0) return { plan: null, notes }
  return {
    plan: mcpPlan('mcp-project-scope', finding.id, `Project-scope ${entries.length === 1 ? 'an MCP server' : 'MCP servers'}`, changes),
    notes,
    ...(Object.keys(pathNotes).length > 0 ? { pathNotes } : {}),
  }
}

function mcpPlan(kind: ActionKind, findingId: string, description: string, changes: PlannedChange[]): ActionPlan {
  return { kind, findingId, description, changes }
}

// ---------------------------------------------------------------------------
// MCP deferral plans — defer-enable / defer-alwaysload / defer-threshold (#614)
// ---------------------------------------------------------------------------

// ENABLE_TOOL_SEARCH and mcpServers config are read once at Claude Code
// process start, so an applied plan changes nothing for sessions already
// running. Stated on every deferral plan.
const NEXT_SESSION_NOTE = 'takes effect on the next session (this config is read at Claude Code start)'

// findDeferralEnvSetting (src/optimize.ts) reports shell-profile hits with
// exactly this scope string; the plan layer keys its refusal on it.
const SHELL_PROFILE_SCOPE = 'shell profile'

const SHELL_TOOL_SEARCH_LINE = new RegExp(`^\\s*(?:export\\s+)?${ENABLE_TOOL_SEARCH_VAR}\\s*=.*$`, 'm')

function envContainer(state: DocState): Record<string, unknown> | null {
  const env = state.doc.env
  return env && typeof env === 'object' ? env as Record<string, unknown> : null
}

// An emptied env object stays in place, matching deleteServer's convention
// for emptied mcpServers containers.
function deleteEnvKey(state: DocState, key: string): boolean {
  const env = envContainer(state)
  if (!env || !(key in env)) return false
  delete env[key]
  state.dirty = true
  return true
}

function setEnvKey(state: DocState, key: string, value: string): void {
  const env = envContainer(state) ?? (state.doc.env = {}) as Record<string, unknown>
  env[key] = value
  state.dirty = true
}

// Shell rc files only ever receive marker-block APPENDS (markerChange);
// deleting or rewriting arbitrary user lines is out. Deferral overrides
// found in a profile get precise by-hand instructions naming the exact file
// and line instead of a plan. `replacement` switches the instruction from
// "delete the line" to "change it to <replacement>".
function shellOverrideManualNotes(path: string, homeDir: string, replacement?: string): string[] {
  const shown = shortPath(path, homeDir)
  let content: string | null = null
  try {
    content = readFileSync(path, 'utf-8')
  } catch {
    content = null
  }
  const line = content?.match(SHELL_TOOL_SEARCH_LINE)?.[0]?.trim()
  if (!line) {
    return [`manual: ${ENABLE_TOOL_SEARCH_VAR} was reported in ${shown} but no such line is there now; nothing to change`]
  }
  // Keep the original line's `export ` prefix in the suggested replacement —
  // a user following the note verbatim would otherwise lose it.
  const replacementLine = replacement !== undefined && line.startsWith('export ') && !replacement.startsWith('export ')
    ? `export ${replacement}`
    : replacement
  const action = replacementLine === undefined
    ? `delete the line \`${line}\` from ${shown}`
    : `in ${shown}, change the line \`${line}\` to \`${replacementLine}\``
  return [`manual: ${action} yourself — codeburn only appends marker blocks to shell files and never edits user lines`]
}

// mcp-deferral-off -> defer-enable. Only two causes are auto-appliable:
// removing a stale ENABLE_TOOL_SEARCH=false from a settings file, and (for
// the future part-3 verifier) forcing =true once a proxy is verified. The
// rest refuse with instructions: an unknown proxy because an explicit
// override makes requests FAIL outright on proxies that don't forward
// tool_reference blocks (live-docs fact), Vertex because default-off there
// is a platform property, old-version because the fix is `claude update`.
function buildDeferEnable(finding: WasteFinding, r: ResolvedPaths): BuiltPlan {
  const payload = finding.apply?.kind === 'defer-enable' ? finding.apply : null
  if (!payload) return { plan: null, notes: [] }

  switch (payload.cause) {
    case 'env-false': {
      if (!payload.settingPath) return { plan: null, notes: [] }
      if (payload.settingScope === SHELL_PROFILE_SCOPE) {
        return { plan: null, notes: shellOverrideManualNotes(payload.settingPath, r.homeDir) }
      }
      const docs = new ConfigDocs(r.homeDir)
      const state = docs.load(payload.settingPath)
      if (!state) return { plan: null, notes: docs.errorNotes() }
      if (!deleteEnvKey(state, ENABLE_TOOL_SEARCH_VAR)) {
        return { plan: null, notes: [`skipped: ${ENABLE_TOOL_SEARCH_VAR} is no longer set in ${shortPath(payload.settingPath, r.homeDir)}`] }
      }
      return {
        plan: mcpPlan(
          'defer-enable',
          finding.id,
          `Remove the ${ENABLE_TOOL_SEARCH_VAR}=${payload.value ?? 'false'} override from ${shortPath(payload.settingPath, r.homeDir)}`,
          docs.changes(),
        ),
        notes: [`restores default-on MCP tool deferral; ${NEXT_SESSION_NOTE}`],
      }
    }
    case 'proxy-unknown': {
      const where = payload.settingPath ? ` configured in ${payload.settingScope ?? 'settings'} (${shortPath(payload.settingPath, r.homeDir)})` : ''
      return {
        plan: null,
        notes: [
          `not auto-applied: setting ${ENABLE_TOOL_SEARCH_VAR}=true would force deferral back on, but requests fail outright on proxies that don't forward tool_reference blocks. ` +
          `Verify that the proxy${where} forwards them before setting the override.`,
        ],
      }
    }
    case 'proxy-verified': {
      // Part-3 verifier confirmed the proxy forwards tool_reference blocks,
      // so the explicit opt-in is safe. User settings env is the target: it
      // covers every project without touching shell files.
      const docs = new ConfigDocs(r.homeDir)
      const state = docs.load(r.userSettings)
      if (!state) return { plan: null, notes: docs.errorNotes() }
      setEnvKey(state, ENABLE_TOOL_SEARCH_VAR, 'true')
      return {
        plan: mcpPlan(
          'defer-enable',
          finding.id,
          `Set ${ENABLE_TOOL_SEARCH_VAR}=true in ${shortPath(r.userSettings, r.homeDir)} (proxy verified to forward tool_reference blocks)`,
          docs.changes(),
        ),
        notes: [`enables MCP tool deferral through the verified proxy; ${NEXT_SESSION_NOTE}`],
      }
    }
    case 'vertex':
      return {
        plan: null,
        notes: [
          `manual: tool search is disabled by default on Vertex AI — a platform property, not a config error. ` +
          `Opt in yourself with \`export ${ENABLE_TOOL_SEARCH_VAR}=true\` if your Vertex setup supports it.`,
        ],
      }
    case 'old-version':
      return {
        plan: null,
        notes: ['manual: every observed Claude Code version predates default-on tool search; run `claude update`'],
      }
  }
}

// mcp-alwaysload-hygiene -> defer-alwaysload: drop `"alwaysLoad": true` from
// the flagged servers in the exact config files the finding recorded.
function buildDeferAlwaysLoad(finding: WasteFinding, r: ResolvedPaths): BuiltPlan {
  const entries = finding.apply?.kind === 'defer-alwaysload' ? finding.apply.servers : []
  if (entries.length === 0) return { plan: null, notes: [] }

  // Version gate: server-level alwaysLoad shipped in v2.1.121. Below that
  // (or undeterminable) the key is inert — tools defer normally and there is
  // no startup block — so "removing the cost" would be a false claim.
  const installed = r.claudeVersion()
  const parsed = installed === null ? null : parseVersion(installed)
  if (parsed === null) {
    return { plan: null, notes: [`skipped: could not determine the installed Claude Code version; removing alwaysLoad is only meaningful on v${ALWAYSLOAD_MIN_VERSION}+`] }
  }
  if (versionPredates(installed!, ALWAYSLOAD_MIN_VERSION)) {
    return { plan: null, notes: [`skipped: installed Claude Code v${parsed.join('.')} predates v${ALWAYSLOAD_MIN_VERSION}, where server-level alwaysLoad shipped; the pin is inert there`] }
  }

  const docs = new ConfigDocs(r.homeDir)
  const skips: string[] = []
  const pathNotes: Record<string, string> = {}
  const addPathNote = pathNoteAdder(pathNotes)

  for (const { server, paths } of entries) {
    let removed = false
    for (const path of paths) {
      const state = docs.load(path)
      if (!state) continue
      const container = state.doc.mcpServers
      if (!container || typeof container !== 'object') continue
      const key = findServerKey(container as Record<string, unknown>, server)
      if (!key) continue
      const entry = (container as Record<string, unknown>)[key]
      if (!entry || typeof entry !== 'object' || (entry as Record<string, unknown>)['alwaysLoad'] !== true) continue
      delete (entry as Record<string, unknown>)['alwaysLoad']
      state.dirty = true
      removed = true
      // alwaysLoad also blocks session startup on the server's connection
      // (capped at 5s), so unpinning removes that startup cost too.
      addPathNote(path, `unpins ${server}: its schema defers on demand and session startup no longer blocks up to ${ALWAYSLOAD_STARTUP_CAP_SECONDS}s on its connection`)
    }
    if (!removed) skips.push(`skipped ${server}: no "alwaysLoad": true entry found in its config files`)
  }

  const changes = docs.changes()
  const notes = [...docs.errorNotes(), ...skips]
  if (changes.length === 0) return { plan: null, notes }
  return {
    plan: mcpPlan('defer-alwaysload', finding.id, `Unpin ${entries.length === 1 ? 'an alwaysLoad MCP server' : 'alwaysLoad MCP servers'}`, changes),
    notes: [...notes, NEXT_SESSION_NOTE],
    ...(Object.keys(pathNotes).length > 0 ? { pathNotes } : {}),
  }
}

// mcp-defer-threshold -> defer-threshold: retune the ENABLE_TOOL_SEARCH auto
// override in place. The detector found the key in config, so this is always
// a value rewrite (or removal), never an env-object creation.
function buildDeferThreshold(finding: WasteFinding, r: ResolvedPaths): BuiltPlan {
  const payload = finding.apply?.kind === 'defer-threshold' ? finding.apply : null
  if (!payload) return { plan: null, notes: [] }
  if (payload.settingScope === SHELL_PROFILE_SCOPE) {
    const replacement = payload.removeOverride ? undefined : `${ENABLE_TOOL_SEARCH_VAR}=auto:${payload.recommendedPercent}`
    return { plan: null, notes: shellOverrideManualNotes(payload.settingPath, r.homeDir, replacement) }
  }

  const docs = new ConfigDocs(r.homeDir)
  const state = docs.load(payload.settingPath)
  if (!state) return { plan: null, notes: docs.errorNotes() }
  const env = envContainer(state)
  if (!env || !(ENABLE_TOOL_SEARCH_VAR in env)) {
    return { plan: null, notes: [`skipped: ${ENABLE_TOOL_SEARCH_VAR} is no longer set in ${shortPath(payload.settingPath, r.homeDir)}`] }
  }
  if (payload.removeOverride) {
    // Defs already exceed the default auto threshold: the override is pure
    // downside, so deleting it restores default auto behavior, which defers.
    delete env[ENABLE_TOOL_SEARCH_VAR]
  } else {
    env[ENABLE_TOOL_SEARCH_VAR] = `auto:${payload.recommendedPercent}`
  }
  state.dirty = true

  const shown = shortPath(payload.settingPath, r.homeDir)
  const description = payload.removeOverride
    ? `Remove the ${ENABLE_TOOL_SEARCH_VAR}=${payload.value} override from ${shown} (the default auto threshold already defers this volume)`
    : `Tighten ${ENABLE_TOOL_SEARCH_VAR} to auto:${payload.recommendedPercent} in ${shown}`
  return {
    plan: mcpPlan('defer-threshold', finding.id, description, docs.changes()),
    notes: [NEXT_SESSION_NOTE],
  }
}

// ---------------------------------------------------------------------------
// Archive unused skills / agents / commands
// ---------------------------------------------------------------------------

const ARCHIVE_KIND: Record<'skill' | 'agent' | 'command', ActionKind> = {
  skill: 'archive-skill',
  agent: 'archive-agent',
  command: 'archive-command',
}

function withSuffix(base: string, n: number): string {
  const dot = base.lastIndexOf('.')
  return dot === -1 ? `${base}-${n}` : `${base.slice(0, dot)}-${n}${base.slice(dot)}`
}

function buildArchive(finding: WasteFinding, r: ResolvedPaths, capability: 'skill' | 'agent' | 'command'): BuiltPlan {
  const names = finding.apply?.kind === 'archive' ? finding.apply.names : []
  const baseDir = capability === 'skill' ? r.skillsDir : capability === 'agent' ? r.agentsDir : r.commandsDir
  const isDir = capability === 'skill'
  const archivedDir = join(baseDir, '.archived')
  const changes: PlannedChange[] = []
  const notes: string[] = []
  const claimed = new Set<string>()

  for (const name of names) {
    const source = isDir ? join(baseDir, name) : join(baseDir, `${name}.md`)
    if (!existsSync(source)) {
      notes.push(`skipped ${name}: ${shortPath(source, r.homeDir)} no longer exists`)
      continue
    }
    const destBase = isDir ? name : `${name}.md`
    let dest = join(archivedDir, destBase)
    let n = 2
    while (existsSync(dest) || claimed.has(dest)) {
      dest = join(archivedDir, withSuffix(destBase, n))
      n++
    }
    claimed.add(dest)
    changes.push({ op: 'move', path: source, movedTo: dest })
  }

  if (changes.length === 0) return { plan: null, notes }
  return {
    plan: {
      kind: ARCHIVE_KIND[capability],
      findingId: finding.id,
      description: `Archive ${changes.length} unused ${capability}${changes.length === 1 ? '' : 's'}`,
      changes,
    },
    notes,
  }
}

// ---------------------------------------------------------------------------
// Marker-block edits (CLAUDE.md rule, shell rc)
// ---------------------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function upsertMarkerBlock(existing: string | null, id: string, text: string, style: 'html' | 'hash'): string {
  const begin = style === 'html' ? `<!-- codeburn:begin ${id} -->` : `# codeburn:begin ${id}`
  const end = style === 'html' ? `<!-- codeburn:end ${id} -->` : `# codeburn:end ${id}`
  const block = `${begin}\n${text}\n${end}\n`
  if (!existing) return block
  const region = new RegExp(`${escapeRegExp(begin)}[\\s\\S]*?${escapeRegExp(end)}\\n?`)
  if (region.test(existing)) return existing.replace(region, block)
  return existing.endsWith('\n') ? existing + block : existing + '\n' + block
}

function markerChange(target: string, id: string, text: string, style: 'html' | 'hash'): PlannedChange {
  const buf = existsSync(target) ? readFileSync(target) : null
  const existing = buf === null ? null : buf.toString('utf-8')
  return {
    op: buf === null ? 'create' : 'edit',
    path: target,
    content: upsertMarkerBlock(existing, id, text, style),
    expectedHash: buf === null ? null : sha256(buf),
  }
}

function buildClaudeMdRule(finding: WasteFinding, r: ResolvedPaths): BuiltPlan {
  if (finding.fix.type !== 'paste') return { plan: null, notes: [] }
  const target = r.projectClaudeMd
  return {
    plan: {
      kind: 'claude-md-rule',
      findingId: finding.id,
      description: `Add the ${finding.id} rule block to ${shortPath(target, r.homeDir)}`,
      changes: [markerChange(target, finding.id, finding.fix.text, 'html')],
    },
    notes: [],
  }
}

function buildShellConfig(finding: WasteFinding, r: ResolvedPaths): BuiltPlan {
  if (finding.fix.type !== 'paste') return { plan: null, notes: [] }
  const target = r.shellRc
  return {
    plan: {
      kind: 'shell-config',
      findingId: finding.id,
      description: `Set the bash output cap in ${shortPath(target, r.homeDir)}`,
      changes: [markerChange(target, finding.id, finding.fix.text, 'hash')],
    },
    notes: [],
  }
}

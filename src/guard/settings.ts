import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { sha256 } from '../act/backup.js'
import type { ActionPlan, PlannedChange } from '../act/types.js'

// The hook entries `guard install` writes and `guard uninstall` removes. Every
// command carries the same recognizable prefix so uninstall can find exactly
// ours by substring even if the user later moved or reindented the file.
export const GUARD_HOOK_PREFIX = 'codeburn guard hook'
export const GUARD_STATUSLINE_COMMAND = 'codeburn guard statusline'

const INSTALL_HOOKS: { event: string; matcher?: string; arg: string }[] = [
  { event: 'PreToolUse', arg: 'pretooluse' },
  { event: 'SessionStart', matcher: 'startup', arg: 'sessionstart' },
  { event: 'Stop', arg: 'stop' },
]

function hookCommand(arg: string): string {
  return `${GUARD_HOOK_PREFIX} ${arg}`
}

export function settingsPathFor(scope: { global?: boolean; project?: string; cwd?: string }): string {
  const dir = scope.global ? homedir() : (scope.project ?? scope.cwd ?? process.cwd())
  return join(dir, '.claude', 'settings.json')
}

type Loaded = { doc: Record<string, unknown>; existed: boolean; rawHash: string | null }

function load(path: string): Loaded {
  if (!existsSync(path)) return { doc: {}, existed: false, rawHash: null }
  const buf = readFileSync(path)
  const rawHash = sha256(buf)
  let raw = buf.toString('utf-8')
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch (e) {
    throw new Error(`could not parse ${path}: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`${path} is not a JSON object`)
  }
  return { doc: doc as Record<string, unknown>, existed: true, rawHash }
}

type HookEntry = { type?: string; command?: string; [k: string]: unknown }
type MatcherGroup = { matcher?: string; hooks?: HookEntry[]; [k: string]: unknown }

function asGroups(value: unknown): MatcherGroup[] {
  return Array.isArray(value) ? (value as MatcherGroup[]) : []
}

function groupHasOurCommand(group: MatcherGroup, command: string): boolean {
  return Array.isArray(group.hooks) && group.hooks.some(h => h?.command === command)
}

export type SettingsBuild = {
  plan: ActionPlan | null
  path: string
  existed: boolean
  notes: string[]
}

function change(path: string, existed: boolean, rawHash: string | null, doc: Record<string, unknown>): PlannedChange {
  return {
    op: existed ? 'edit' : 'create',
    path,
    content: JSON.stringify(doc, null, 2) + '\n',
    expectedHash: rawHash,
  }
}

export function buildInstall(path: string, opts: { statusline?: boolean } = {}): SettingsBuild {
  const { doc, existed, rawHash } = load(path)
  const notes: string[] = []
  const hooks = (doc.hooks && typeof doc.hooks === 'object' && !Array.isArray(doc.hooks))
    ? doc.hooks as Record<string, unknown>
    : {}
  let added = false

  for (const { event, matcher, arg } of INSTALL_HOOKS) {
    const command = hookCommand(arg)
    const groups = asGroups(hooks[event])
    if (groups.some(g => groupHasOurCommand(g, command))) continue
    groups.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command }] })
    hooks[event] = groups
    added = true
  }
  if (added || Object.keys(hooks).length > 0) doc.hooks = hooks

  if (opts.statusline) {
    const existing = doc.statusLine
    if (existing && typeof existing === 'object' && (existing as HookEntry).command !== GUARD_STATUSLINE_COMMAND) {
      notes.push('a statusline is already configured; left it untouched (remove it first to use the guard statusline)')
    } else if ((existing as HookEntry | undefined)?.command === GUARD_STATUSLINE_COMMAND) {
      // already ours
    } else {
      doc.statusLine = { type: 'command', command: GUARD_STATUSLINE_COMMAND }
      added = true
    }
  }

  if (!added) {
    notes.push('guard hooks already present; nothing to install')
    return { plan: null, path, existed, notes }
  }
  return {
    plan: {
      kind: 'guard-install',
      findingId: null,
      description: `Install codeburn guard hooks into ${path}`,
      changes: [change(path, existed, rawHash, doc)],
    },
    path,
    existed,
    notes,
  }
}

export function buildUninstall(path: string): SettingsBuild {
  if (!existsSync(path)) {
    return { plan: null, path, existed: false, notes: ['no settings file at that location; nothing to uninstall'] }
  }
  const { doc, existed, rawHash } = load(path)
  let removed = false

  const hooks = (doc.hooks && typeof doc.hooks === 'object' && !Array.isArray(doc.hooks))
    ? doc.hooks as Record<string, unknown>
    : null
  if (hooks) {
    for (const event of Object.keys(hooks)) {
      const groups = asGroups(hooks[event])
      const kept: MatcherGroup[] = []
      for (const group of groups) {
        if (!Array.isArray(group.hooks)) { kept.push(group); continue }
        const keptHooks = group.hooks.filter(h => !(typeof h?.command === 'string' && h.command.includes(GUARD_HOOK_PREFIX)))
        if (keptHooks.length !== group.hooks.length) removed = true
        if (keptHooks.length === 0) continue // drop a group that was only ours
        kept.push(keptHooks.length === group.hooks.length ? group : { ...group, hooks: keptHooks })
      }
      if (kept.length === 0) delete hooks[event]
      else hooks[event] = kept
    }
    if (Object.keys(hooks).length === 0) delete doc.hooks
  }

  const statusLine = doc.statusLine as HookEntry | undefined
  if (statusLine && typeof statusLine.command === 'string' && statusLine.command.includes(GUARD_STATUSLINE_COMMAND)) {
    delete doc.statusLine
    removed = true
  }

  if (!removed) {
    return { plan: null, path, existed, notes: ['no codeburn guard hooks found in that settings file'] }
  }
  return {
    plan: {
      kind: 'guard-uninstall',
      findingId: null,
      description: `Remove codeburn guard hooks from ${path}`,
      changes: [change(path, existed, rawHash, doc)],
    },
    path,
    existed,
    notes: [],
  }
}

// Report whether a settings file currently carries our hooks / statusline, for
// `guard status`. Never throws: a missing or malformed file reads as absent.
export function inspectInstall(path: string): { path: string; hooks: string[]; statusline: boolean } {
  const out = { path, hooks: [] as string[], statusline: false }
  if (!existsSync(path)) return out
  let doc: Record<string, unknown>
  try {
    let raw = readFileSync(path, 'utf-8')
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return out
    doc = parsed as Record<string, unknown>
  } catch {
    return out
  }
  const hooks = doc.hooks
  if (hooks && typeof hooks === 'object') {
    for (const [event, value] of Object.entries(hooks as Record<string, unknown>)) {
      for (const group of asGroups(value)) {
        if (Array.isArray(group.hooks) && group.hooks.some(h => typeof h?.command === 'string' && h.command.includes(GUARD_HOOK_PREFIX))) {
          out.hooks.push(event)
        }
      }
    }
  }
  const sl = doc.statusLine as HookEntry | undefined
  out.statusline = !!(sl && typeof sl.command === 'string' && sl.command.includes(GUARD_STATUSLINE_COMMAND))
  return out
}

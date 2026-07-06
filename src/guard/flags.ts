import { mkdir, readFile, writeFile } from 'fs/promises'
import { sep } from 'path'
import type { ProjectSummary } from '../types.js'
import { flagsPath, guardDir } from './store.js'

// Per-project flag list computed at install / `guard refresh` time and read on
// SessionStart. The resolved opener text is stored here (not a code path into
// optimize) so the hot SessionStart handler never imports the analyzer.
export type ProjectFlag = { path: string; openers: string[] }
export type GuardFlags = { generatedAt: string; projects: ProjectFlag[] }

export const FLAG_STALE_MS = 7 * 24 * 60 * 60 * 1000

// optimize is loaded lazily so importing this module (for readFlags/matchFlag,
// which the SessionStart hook needs) does not pull the analyzer.
export async function buildFlags(projects: ProjectSummary[]): Promise<GuardFlags> {
  const { findLowWorthCandidates, findContextBloatCandidates, LOW_WORTH_OPENER, CONTEXT_HEAVY_OPENER } =
    await import('../optimize.js')
  const lowWorth = new Set(findLowWorthCandidates(projects).map(c => c.project))
  const contextHeavy = new Set(findContextBloatCandidates(projects).map(c => c.project))
  const flags: ProjectFlag[] = []
  for (const project of projects) {
    const openers: string[] = []
    if (lowWorth.has(project.project)) openers.push(LOW_WORTH_OPENER)
    if (contextHeavy.has(project.project)) openers.push(CONTEXT_HEAVY_OPENER)
    if (openers.length > 0) flags.push({ path: project.projectPath, openers })
  }
  return { generatedAt: new Date().toISOString(), projects: flags }
}

export async function readFlags(base?: string): Promise<GuardFlags | null> {
  let raw: string
  try {
    raw = await readFile(flagsPath(base), 'utf-8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as GuardFlags
    if (typeof parsed?.generatedAt !== 'string' || !Array.isArray(parsed.projects)) return null
    return parsed
  } catch {
    return null
  }
}

export async function writeFlags(flags: GuardFlags, base?: string): Promise<void> {
  await mkdir(guardDir(base), { recursive: true })
  await writeFile(flagsPath(base), JSON.stringify(flags, null, 2) + '\n', 'utf-8')
}

export function flagsAgeMs(flags: GuardFlags): number {
  const t = Date.parse(flags.generatedAt)
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : Date.now() - t
}

function norm(p: string): string {
  return p.length > 1 && p.endsWith(sep) ? p.slice(0, -1) : p
}

// Openers for the flagged project the cwd sits in (exact match or a subdir of
// it); most-specific project wins. Empty when the cwd is not flagged.
export function matchFlag(flags: GuardFlags, cwd: string): string[] {
  const target = norm(cwd)
  let best: ProjectFlag | null = null
  for (const flag of flags.projects) {
    const base = norm(flag.path)
    if (target === base || target.startsWith(base + sep)) {
      if (!best || base.length > norm(best.path).length) best = flag
    }
  }
  return best ? best.openers : []
}

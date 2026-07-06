import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { getConfigFilePath } from '../config.js'

// Guard state lives beside config.json under the CodeBurn home dir (in practice
// ~/.config/codeburn): guard.json for thresholds, a guard/ subdir for the
// per-session incremental caches, the flag list, and per-session allow markers.
// Every path derives from an injectable base so tests point the whole thing at
// a fixture dir and the real config dir is never touched.
export function guardBase(base?: string): string {
  return base ?? dirname(getConfigFilePath())
}

export function guardConfigPath(base?: string): string {
  return join(guardBase(base), 'guard.json')
}

export function guardDir(base?: string): string {
  return join(guardBase(base), 'guard')
}

export function flagsPath(base?: string): string {
  return join(guardDir(base), 'flags.json')
}

// Per-session state sits one level below the shared flags.json so a session id
// can never collide with it (e.g. a session literally named "flags").
export function sessionsDir(base?: string): string {
  return join(guardDir(base), 'sessions')
}

export function sessionCachePath(sessionId: string, base?: string): string {
  return join(sessionsDir(base), `${sanitizeId(sessionId)}.json`)
}

export function allowPath(sessionId: string, base?: string): string {
  return join(sessionsDir(base), `${sanitizeId(sessionId)}.allow`)
}

// Session ids come from the hook payload; keep them to a filesystem-safe set so
// a malformed id can never escape the guard dir.
function sanitizeId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_')
}

export type GuardConfig = {
  softUSD: number | null
  hardUSD: number | null
  checkpointUSD: number | null
  openerEnabled: boolean
  updatedAt: string
}

export const DEFAULT_GUARD_CONFIG: GuardConfig = {
  softUSD: 5,
  hardUSD: 15,
  checkpointUSD: 3,
  openerEnabled: true,
  updatedAt: '',
}

function coerceThreshold(v: unknown, fallback: number | null): number | null {
  if (v === null) return null
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback
}

export async function readGuardConfig(base?: string): Promise<GuardConfig> {
  let raw: string
  try {
    raw = await readFile(guardConfigPath(base), 'utf-8')
  } catch {
    return { ...DEFAULT_GUARD_CONFIG }
  }
  let parsed: Partial<GuardConfig>
  try {
    parsed = JSON.parse(raw) as Partial<GuardConfig>
  } catch {
    return { ...DEFAULT_GUARD_CONFIG }
  }
  return {
    softUSD: coerceThreshold(parsed.softUSD, DEFAULT_GUARD_CONFIG.softUSD),
    hardUSD: coerceThreshold(parsed.hardUSD, DEFAULT_GUARD_CONFIG.hardUSD),
    checkpointUSD: coerceThreshold(parsed.checkpointUSD, DEFAULT_GUARD_CONFIG.checkpointUSD),
    openerEnabled: parsed.openerEnabled !== false,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
  }
}

export async function writeGuardConfig(config: GuardConfig, base?: string): Promise<void> {
  await mkdir(guardBase(base), { recursive: true })
  await writeFile(guardConfigPath(base), JSON.stringify(config, null, 2) + '\n', 'utf-8')
}

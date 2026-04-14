/**
 * Project name normalization — extracts human-readable project names from
 * Claude Code's encoded session directory paths, merges duplicates via a
 * user-configurable alias map, and supports manual session attribution for
 * workspace sessions.
 *
 * Problem: Claude Code stores sessions under ~/.claude/projects/<encoded-path>/
 * where the encoded path replaces / with -. This creates two issues:
 *
 *   1. The raw directory name is unreadable: "-Users-alice-projects-my-app"
 *   2. Different CWDs produce different encoded dirs for the same project,
 *      splitting cost data across duplicate entries.
 *
 * This module solves both by extracting the meaningful project segment and
 * optionally merging aliases.
 */

import { readFileSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// ---------------------------------------------------------------------------
// Config paths
// ---------------------------------------------------------------------------

function getConfigDir(): string {
  return process.env['CODEBURN_CONFIG_DIR'] || join(homedir(), '.config', 'codeburn')
}

function getAliasPath(): string {
  return join(getConfigDir(), 'project-aliases.json')
}

function getAttributionPath(): string {
  return join(getConfigDir(), 'session-projects.jsonl')
}

// ---------------------------------------------------------------------------
// Project name extraction from encoded directory names
// ---------------------------------------------------------------------------

/** Segments to skip when extracting project names from paths. */
const SYSTEM_SEGMENTS = new Set([
  'users', 'user', 'home', 'projects', 'documents', 'desktop',
  'volumes', 'mnt', 'opt', 'var', 'tmp',
])

/**
 * Extract a human-readable project name from the encoded session directory.
 *
 * Claude Code encodes the session path by replacing / with -.
 * Example: "-Users-alice-projects-my-app" → "my-app"
 *
 * Strategy: find the "projects" marker and take everything after it as the
 * project path. If the result contains further subdirectories, return just
 * the top-level project directory.
 */
export function extractProjectName(encodedDirName: string): string {
  // Look for the "-projects-" marker (case-insensitive)
  const lower = encodedDirName.toLowerCase()
  const marker = '-projects-'
  const idx = lower.indexOf(marker)

  if (idx >= 0) {
    const remainder = encodedDirName.slice(idx + marker.length)
    if (!remainder) return 'workspace'
    return remainder
  }

  // Check if it ends with "-projects" (workspace root)
  if (lower.endsWith('-projects')) return 'workspace'

  // Fallback: split on - and find last non-system segment
  const parts = encodedDirName.replace(/^-/, '').split('-').filter(Boolean)
  for (let i = parts.length - 1; i >= 0; i--) {
    if (!SYSTEM_SEGMENTS.has(parts[i]!.toLowerCase())) {
      return parts[i]!
    }
  }

  return encodedDirName
}

// ---------------------------------------------------------------------------
// Project alias map — user-configurable merge rules
// ---------------------------------------------------------------------------

interface AliasConfig {
  /** Map of variant name (case-insensitive) → canonical project name. */
  aliases?: Record<string, string>
}

let aliasCache: Map<string, string> | null = null
let aliasMtime = 0

function loadAliases(): Map<string, string> {
  const path = getAliasPath()
  if (!existsSync(path)) return new Map()

  try {
    const currentMtime = statSync(path).mtimeMs
    if (aliasCache && currentMtime === aliasMtime) return aliasCache
    aliasMtime = currentMtime

    const raw = readFileSync(path, 'utf-8')
    const config: AliasConfig = JSON.parse(raw)
    const map = new Map<string, string>()
    if (config.aliases) {
      for (const [key, value] of Object.entries(config.aliases)) {
        map.set(key.toLowerCase(), value)
      }
    }
    aliasCache = map
    return map
  } catch {
    return aliasCache ?? new Map()
  }
}

/**
 * Apply alias map to consolidate variant project names.
 * Tries exact match, then without numeric prefix (e.g., "30_SVG-PAINT" → "SVG-PAINT").
 */
export function applyAlias(rawName: string): string {
  const aliases = loadAliases()
  if (aliases.size === 0) return rawName

  // Exact match (case-insensitive)
  const exact = aliases.get(rawName.toLowerCase())
  if (exact) return exact

  // Try without numeric prefix (e.g., "30_SVG-PAINT" → lookup "svg-paint")
  const stripped = rawName.replace(/^\d+[_-]/, '')
  const strippedMatch = aliases.get(stripped.toLowerCase())
  if (strippedMatch) return strippedMatch

  // Try progressively shorter hyphen-delimited prefixes
  // (handles subdirectory-in-project names like "my-app-src")
  if (rawName.includes('-')) {
    const parts = rawName.split('-')
    for (let len = parts.length - 1; len > 0; len--) {
      const prefix = parts.slice(0, len).join('-').toLowerCase()
      const match = aliases.get(prefix)
      if (match) return match
    }
  }

  return rawName
}

// ---------------------------------------------------------------------------
// Session attribution — manual overrides for workspace sessions
// ---------------------------------------------------------------------------

interface AttributionEntry {
  session_id: string
  project: string
}

let attributionCache: Map<string, string> | null = null
let attributionMtime = 0

/**
 * Load session→project attribution overrides.
 * File format: JSONL with { session_id, project, date? } per line.
 * First entry per session_id wins (primary project).
 */
export function loadAttribution(): Map<string, string> {
  const path = getAttributionPath()
  if (!existsSync(path)) return new Map()

  try {
    const currentMtime = statSync(path).mtimeMs
    if (attributionCache && currentMtime === attributionMtime) return attributionCache
    attributionMtime = currentMtime

    const content = readFileSync(path, 'utf-8')
    const map = new Map<string, string>()
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        const entry: AttributionEntry = JSON.parse(line)
        if (entry.session_id && entry.project && !map.has(entry.session_id)) {
          map.set(entry.session_id, entry.project)
        }
      } catch { continue }
    }
    attributionCache = map
    return map
  } catch {
    return attributionCache ?? new Map()
  }
}

// ---------------------------------------------------------------------------
// Combined normalization pipeline
// ---------------------------------------------------------------------------

/**
 * Full project name normalization pipeline:
 *   1. Extract readable name from encoded directory path
 *   2. Apply user-defined aliases to merge variants
 *   3. Optionally override with session attribution
 *
 * @param encodedDirName - The raw encoded directory name from ~/.claude/projects/
 * @param sessionId - Optional session UUID for attribution lookup
 * @returns Normalized project name
 */
export function normalizeProject(
  encodedDirName: string,
  sessionId?: string,
): string {
  // Step 1: Extract readable name
  let name = extractProjectName(encodedDirName)

  // Step 2: Apply aliases
  name = applyAlias(name)

  // Step 3: Override workspace with session attribution
  if (name === 'workspace' && sessionId) {
    const attribution = loadAttribution()
    const override = attribution.get(sessionId)
    if (override) name = override
  }

  return name
}

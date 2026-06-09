import { readFile, readdir, stat } from 'fs/promises'
import { basename, delimiter as pathDelimiter, join, resolve } from 'path'
import { homedir } from 'os'

import type { Provider, SessionSource, SessionParser } from './types.js'
import { getShortModelName } from '../models.js'
import { readConfig } from '../config.js'

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

/// Returns every Claude config dir to scan, in priority order with duplicates
/// removed (resolved-path equality). Precedence: `CLAUDE_CONFIG_DIRS` (a
/// `path.delimiter`-separated list, ":" on POSIX, ";" on Windows), then
/// `CLAUDE_CONFIG_DIR` (single dir), then the `claudeConfigDirs` array in
/// `~/.config/codeburn/config.json` (how the macOS menubar configures
/// multi-account aggregation, since a GUI app can't inherit the shell env),
/// then `~/.claude`. Sessions from every returned dir are merged into one
/// ProjectSummary per project name in `src/parser.ts:scanProjectDirs`, so two
/// dirs holding the same sanitized project slug naturally aggregate (#208).
async function getClaudeConfigDirs(): Promise<string[]> {
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

export function getDesktopSessionsDir(): string {
  const override = process.env['CODEBURN_DESKTOP_SESSIONS_DIR']
  if (override) return override
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions')
  if (process.platform === 'win32') return join(homedir(), 'AppData', 'Roaming', 'Claude', 'local-agent-mode-sessions')
  return join(homedir(), '.config', 'Claude', 'local-agent-mode-sessions')
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

  async discoverSessions(): Promise<SessionSource[]> {
    const sources: SessionSource[] = []
    const seenProjectDirs = new Set<string>()
    const configDirs = await getClaudeConfigDirs()
    let anyDirReadable = false

    for (const claudeDir of configDirs) {
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
      for (const dirName of entries) {
        const dirPath = join(projectsDir, dirName)
        // Resolve before deduping so two CLAUDE_CONFIG_DIRS entries that
        // reach the same projects/<slug> directory (via symlinks or
        // overlapping configs) emit only one SessionSource.
        const resolved = resolve(dirPath)
        if (seenProjectDirs.has(resolved)) continue
        const dirStat = await stat(dirPath).catch(() => null)
        if (!dirStat?.isDirectory()) continue
        seenProjectDirs.add(resolved)
        // `project: dirName` is identical across config dirs for the same
        // sanitized slug, which is exactly what makes the parser merge
        // their sessions into a single ProjectSummary.
        sources.push({ path: dirPath, project: dirName, provider: 'claude' })
      }
    }

    // If the user explicitly set CLAUDE_CONFIG_DIRS and every entry was
    // unreadable, emit a one-line stderr hint. Catches the most common
    // misconfiguration: a Windows user typing `:` (POSIX delimiter) when
    // the platform expects `;`, which produces a single bogus path that
    // silently resolves to nothing on disk.
    const explicitMulti = process.env['CLAUDE_CONFIG_DIRS']
    if (!anyDirReadable && explicitMulti !== undefined && explicitMulti !== '' && configDirs.length > 0) {
      process.stderr.write(
        `codeburn: CLAUDE_CONFIG_DIRS was set but no listed directory could be read. ` +
        `Tried: ${configDirs.join(', ')}. ` +
        `Use "${pathDelimiter}" as the separator on this platform.\n`,
      )
    }

    const desktopBase = getDesktopSessionsDir()
    const desktopDirs = await findDesktopProjectDirs(desktopBase)
    const sep = desktopBase.includes('\\') ? '\\' : '/'
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

      sources.push({ path: dirPath, project: projectName, provider: 'claude' })
    }

    return sources
  },

  createSessionParser(): SessionParser {
    return {
      async *parse() {},
    }
  },
}

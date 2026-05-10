import { readdir, stat } from 'fs/promises'
import { basename, delimiter as pathDelimiter, join, resolve } from 'path'
import { homedir } from 'os'

import type { Provider, SessionSource, SessionParser } from './types.js'

const shortNames: Record<string, string> = {
  'claude-opus-4-7': 'Opus 4.7',
  'claude-opus-4-6': 'Opus 4.6',
  'claude-opus-4-5': 'Opus 4.5',
  'claude-opus-4-1': 'Opus 4.1',
  'claude-opus-4': 'Opus 4',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-sonnet-4-5': 'Sonnet 4.5',
  'claude-sonnet-4': 'Sonnet 4',
  'claude-3-7-sonnet': 'Sonnet 3.7',
  'claude-3-5-sonnet': 'Sonnet 3.5',
  'claude-haiku-4-5': 'Haiku 4.5',
  'claude-3-5-haiku': 'Haiku 3.5',
}

function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

/// Returns every Claude config dir to scan, in priority order with duplicates
/// removed (resolved-path equality). Precedence: `CLAUDE_CONFIG_DIRS` (a
/// `path.delimiter`-separated list, ":" on POSIX, ";" on Windows), then
/// `CLAUDE_CONFIG_DIR` (single dir), then `~/.claude`. Sessions from every
/// returned dir are merged into one ProjectSummary per project name in
/// `src/parser.ts:scanProjectDirs`, so two dirs holding the same sanitized
/// project slug naturally aggregate (issue #208 option 1).
function getClaudeConfigDirs(): string[] {
  const multi = process.env['CLAUDE_CONFIG_DIRS']
  if (multi !== undefined && multi !== '') {
    const dirs = multi
      .split(pathDelimiter)
      .map(s => s.trim())
      .filter(s => s.length > 0)
      .map(s => resolve(expandHome(s)))
    if (dirs.length > 0) {
      const seen = new Set<string>()
      const out: string[] = []
      for (const d of dirs) {
        if (!seen.has(d)) {
          seen.add(d)
          out.push(d)
        }
      }
      return out
    }
  }
  const single = process.env['CLAUDE_CONFIG_DIR']
  if (single !== undefined && single !== '') return [resolve(expandHome(single))]
  return [join(homedir(), '.claude')]
}

function getDesktopSessionsDir(): string {
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

export const claude: Provider = {
  name: 'claude',
  displayName: 'Claude',

  modelDisplayName(model: string): string {
    const canonical = model.replace(/@.*$/, '').replace(/-\d{8}$/, '')
    for (const [key, name] of Object.entries(shortNames)) {
      if (canonical.startsWith(key)) return name
    }
    return canonical
  },

  toolDisplayName(rawTool: string): string {
    return rawTool
  },

  async discoverSessions(): Promise<SessionSource[]> {
    const sources: SessionSource[] = []
    const seenProjectDirs = new Set<string>()
    const configDirs = getClaudeConfigDirs()
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

    const desktopDirs = await findDesktopProjectDirs(getDesktopSessionsDir())
    for (const dirPath of desktopDirs) {
      const resolved = resolve(dirPath)
      if (seenProjectDirs.has(resolved)) continue
      seenProjectDirs.add(resolved)
      sources.push({ path: dirPath, project: basename(dirPath), provider: 'claude' })
    }

    return sources
  },

  createSessionParser(): SessionParser {
    return {
      async *parse() {},
    }
  },
}

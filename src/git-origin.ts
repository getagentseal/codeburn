import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

import { getCodeburnCacheDir } from './cache-dir.js'

/// The `origin` remote of a checkout, read straight from .git/config. Two clones
/// or worktrees of the same repository share it, which is what lets surfaces
/// fold a dozen throwaway checkouts into one project.

export function parseGitConfigSection(config: string, section: string, key: string): string | null {
  const wanted = `[${section.toLowerCase()}]`
  let inSection = false
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    if (line.startsWith('[')) {
      inSection = line.toLowerCase() === wanted
      continue
    }
    if (!inSection) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    if (line.slice(0, eq).trim().toLowerCase() !== key.toLowerCase()) continue
    return line.slice(eq + 1).trim()
  }
  return null
}

/** Comparable identity for a remote URL: `git@github.com:o/r.git` and
 *  `https://github.com/o/r` both become `github.com/o/r`. */
export function normalizeOriginUrl(url: string): string {
  return url
    .trim()
    .replace(/^[a-z+]+:\/\//i, '')
    .replace(/^[^@/]+@/, '')
    .replace(/:(?=[^/])/, '/')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .toLowerCase()
}

function entryKind(path: string): 'file' | 'dir' | null {
  try {
    const st = statSync(path)
    return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : null
  } catch {
    return null
  }
}

function resolveGitCommonDir(gitDir: string): string {
  const marker = join(gitDir, 'commondir')
  if (!existsSync(marker)) return gitDir
  const rel = readFileSync(marker, 'utf8').trim()
  if (!rel) return gitDir
  if (rel.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(rel)) return rel
  return join(gitDir, rel)
}

// Memoized per repo root: every session in the same repo would otherwise
// re-read .git/config. Process-lifetime only, so a remote URL change needs a
// restart (a resident `serve` child included).
const originByRoot = new Map<string, string | null>()

export function readGitOriginUrl(path: string): string | null {
  const memo = originByRoot.get(path)
  if (memo !== undefined) return memo
  const url = readGitOriginUrlUncached(path)
  originByRoot.set(path, url)
  return url
}

/// A recorded working directory is usually inside the checkout, not at its root
/// (`<repo>/app`, `<repo>/src/lib`), so reading only `<path>/.git` found an
/// origin for a handful of the identities on a real machine and left every
/// other checkout of the same repository as its own picker row. Walk up to the
/// first ancestor that has one.
function readGitOriginUrlUncached(path: string): string | null {
  let dir = path
  for (let depth = 0; depth < 64; depth++) {
    const url = originAt(dir)
    if (url) return url
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

function originAt(repoRoot: string): string | null {
  try {
    let gitDir = join(repoRoot, '.git')
    const kind = entryKind(gitDir)
    if (kind === 'file') {
      const match = readFileSync(gitDir, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m)
      if (!match?.[1]) return null
      gitDir = match[1].startsWith('/') || /^[a-zA-Z]:[\\/]/.test(match[1]) ? match[1] : join(repoRoot, match[1])
    } else if (kind !== 'dir') {
      return null
    }
    for (const configPath of [join(gitDir, 'config'), join(resolveGitCommonDir(gitDir), 'config')]) {
      if (!existsSync(configPath)) continue
      const url = parseGitConfigSection(readFileSync(configPath, 'utf8'), 'remote "origin"', 'url')
      if (url) return url
    }
    return null
  } catch {
    return null
  }
}

// Agents delete their scratch clones, so the origin a folder had is kept in the
// cache dir: while the folder exists the filesystem answers (and overwrites the
// record, since scratch names get reused for other repos), once it is gone the
// record does.
const ORIGINS_FILE = 'git-origins.json'
const keyByPath = new Map<string, string | null>()
let recorded: Record<string, string> | null = null
const pending = new Map<string, string | null>()
let exitHooked = false

function readRecorded(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(getCodeburnCacheDir(), ORIGINS_FILE), 'utf8'))
    const paths = (parsed as { paths?: unknown } | null)?.paths
    if (!paths || typeof paths !== 'object') return {}
    return Object.fromEntries(Object.entries(paths).filter((e): e is [string, string] => typeof e[1] === 'string'))
  } catch {
    return {}
  }
}

/** Normalized `origin` of the checkout containing `path`, or null when it has
 *  none. A path that no longer exists answers from what an earlier run saw. */
export function gitOriginKey(path: string): string | null {
  const memo = keyByPath.get(path)
  if (memo !== undefined) return memo
  recorded ??= readRecorded()
  let key: string | null
  if (existsSync(path)) {
    const url = readGitOriginUrl(path)
    key = url ? normalizeOriginUrl(url) : null
    if ((Object.hasOwn(recorded, path) ? recorded[path] : null) !== key) {
      if (key) recorded[path] = key
      else delete recorded[path]
      // Lookups outside a parse (a filter over carried days) are kept too.
      if (!exitHooked) process.once('exit', saveGitOrigins)
      exitHooked = true
      pending.set(path, key)
    }
  } else {
    key = Object.hasOwn(recorded, path) ? recorded[path]! : null
  }
  keyByPath.set(path, key)
  return key
}

/** A recorded project path as a native absolute path, or null. Codex strips
 *  the leading slash from its cwds, so a slash-bearing relative path is rooted. */
function nativeProjectPath(projectPath: string | undefined): string | null {
  const raw = (projectPath ?? '').trim().replace(/[\\/]+$/, '')
  if (!raw) return null
  if (isAbsolute(raw)) return raw
  if (process.platform === 'win32' || !raw.includes('/') || raw.startsWith('-')) return null
  return `/${raw}`
}

/** The origin of a recorded project path. */
export function projectOriginKey(projectPath: string | undefined): string | null {
  const path = nativeProjectPath(projectPath)
  return path ? gitOriginKey(path) : null
}

/** The one list row (and filter pattern) for every folder under a temp root
 *  that is not a checkout of a known repository: agents' scratch folders,
 *  thousands of them, mostly deleted. */
export const TEMPORARY_PROJECTS = '@temp'

// macOS reaches /tmp and /var through /private, so both spellings fold to one.
function foldTempKey(path: string): string {
  const s = path.replace(/\\/g, '/').replace(/\/+$/, '').replace(/^\/private(?=\/(?:tmp|var)(?:\/|$))/, '')
  return process.platform === 'win32' ? s.toLowerCase() : s
}

let roots: string[] | null = null
function tempRoots(): string[] {
  roots ??= [...new Set([tmpdir(), '/tmp', '/var/folders'].map(foldTempKey))]
  return roots
}

export function isTemporaryProjectPath(projectPath: string | undefined): boolean {
  const path = nativeProjectPath(projectPath)
  if (!path) return false
  const key = foldTempKey(path)
  return tempRoots().some(root => key === root || key.startsWith(`${root}/`))
}

/** "github.com/org/repo" -> "repo". */
export function originRepoName(originKey: string): string {
  return originKey.split('/').filter(Boolean).pop() ?? originKey
}

/** Writes what this process learned, merged over what another one may have
 *  written meanwhile. Never fails the caller. */
export function saveGitOrigins(): void {
  if (pending.size === 0) return
  try {
    const merged = readRecorded()
    for (const [path, key] of pending) {
      if (key) merged[path] = key
      else delete merged[path]
    }
    const target = join(getCodeburnCacheDir(), ORIGINS_FILE)
    const tmp = `${target}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, paths: merged }), { mode: 0o600 })
    renameSync(tmp, target)
    pending.clear()
  } catch {
    // A missed save only means a later run learns it again while the folder exists.
  }
}

export function __setTempRoots(paths: string[] | null): void {
  roots = paths && paths.map(foldTempKey)
}

export function __resetGitOriginCache(): void {
  originByRoot.clear()
  keyByPath.clear()
  pending.clear()
  recorded = null
}

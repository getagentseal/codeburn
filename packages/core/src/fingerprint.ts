import { createHmac } from 'node:crypto'

/**
 * All fingerprints are the first 16 hex chars of an HMAC-SHA256 keyed by a
 * caller-supplied `privacyKey` (decision D1: the key is REQUIRED — core never
 * invents or persists one). HMAC-SHA256 is one-way, so a fingerprint cannot be
 * reversed to its input; and because the key is per-host, fingerprints are not
 * comparable across hosts that use different keys.
 *
 * `node:crypto` is pure computation (no I/O), so it is permitted in core.
 */

const FINGERPRINT_LEN = 16

/** Domain-separation prefixes so the same string in different roles differs. */
type Domain = 'session' | 'project' | 'branch' | 'resource' | 'source'

/** Field separator for composite HMAC inputs (ASCII Unit Separator). */
const SEP = String.fromCharCode(0x1f)

function hmac(privacyKey: string, domain: Domain, ...parts: string[]): string {
  if (!privacyKey) throw new Error('privacyKey is required')
  return createHmac('sha256', privacyKey)
    .update(`${domain}:${parts.join(SEP)}`)
    .digest('hex')
    .slice(0, FINGERPRINT_LEN)
}

export type ResourceClass =
  | 'dependency'
  | 'build'
  | 'vcs'
  | 'config'
  | 'source'
  | 'doc'
  | 'other'

export interface ResourceFingerprint {
  resourceClass: ResourceClass
  resourceId: string
}

// The dependency / build / vcs segment tables are the source of truth for what
// the junk-reads detector treats as junk. They are kept a strict SUPERSET of the
// CLI's legacy JUNK_DIRS regex: every directory that regex named classifies here
// as junk too (the extras — 'venv', '__pycache__', 'coverage', '.cache',
// '.nuxt', '.output', '.svn', '.hg' — are added below), plus vendor /
// site-packages / out / target, which the old regex missed.
const DEPENDENCY_SEGMENTS = new Set(['node_modules', 'vendor', '.venv', 'venv', 'site-packages'])
const BUILD_SEGMENTS = new Set([
  'dist', 'build', 'out', 'target', '.next', '.nuxt', '.output',
  '__pycache__', 'coverage', '.cache',
])
const VCS_SEGMENTS = new Set(['.git', '.svn', '.hg'])
const CONFIG_EXTENSIONS = new Set(['json', 'yaml', 'yml', 'toml'])
const DOC_EXTENSIONS = new Set(['md', 'txt', 'rst'])
const SOURCE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'go', 'rs', 'java', 'rb', 'php', 'swift', 'kt', 'kts', 'scala', 'cs',
  'c', 'h', 'cc', 'cpp', 'hpp', 'hh', 'cxx', 'm', 'mm',
  'sh', 'bash', 'zsh', 'sql', 'vue', 'svelte',
])

/**
 * Normalise a path before hashing/classifying:
 *  1. Backslashes -> forward slashes (so a Windows path and its POSIX spelling
 *     hash identically).
 *  2. Strip trailing separator(s).
 *  3. Case-fold (lowercase) ONLY when the path is Windows-style — it either has
 *     a drive-letter prefix (`C:\...`) or used backslashes — because Windows
 *     filesystems are case-insensitive. POSIX paths keep their case, since
 *     `Foo.ts` and `foo.ts` are distinct files there.
 */
export function normalizePath(absolutePath: string): string {
  const looksWindows = /^[A-Za-z]:[\\/]/.test(absolutePath) || absolutePath.includes('\\')
  let p = absolutePath.replace(/\\/g, '/')
  p = p.replace(/\/+$/, '')
  if (looksWindows) p = p.toLowerCase()
  return p
}

function extensionOf(basename: string): string | undefined {
  const dot = basename.lastIndexOf('.')
  if (dot <= 0) return undefined // no ext, or leading dot (dotfile) -> not an extension
  return basename.slice(dot + 1).toLowerCase()
}

/**
 * Classify a path by its segments and basename. Precedence is directory-based
 * first (a file under node_modules is a dependency regardless of its
 * extension), then basename/extension-based:
 *   dependency > build > vcs > config(dotfile) > config(ext) > doc > source > other
 */
export function classifyResource(absolutePath: string): ResourceClass {
  const normalized = normalizePath(absolutePath)
  const segments = normalized.split('/').filter(Boolean)

  for (const seg of segments) {
    if (DEPENDENCY_SEGMENTS.has(seg)) return 'dependency'
  }
  for (const seg of segments) {
    if (BUILD_SEGMENTS.has(seg)) return 'build'
  }
  for (const seg of segments) {
    if (VCS_SEGMENTS.has(seg)) return 'vcs'
  }

  const basename = segments[segments.length - 1] ?? ''
  // A dotfile (e.g. `.eslintrc`, `.gitignore`) is configuration.
  if (basename.startsWith('.') && basename.length > 1) return 'config'

  const ext = extensionOf(basename)
  if (ext) {
    if (CONFIG_EXTENSIONS.has(ext)) return 'config'
    if (DOC_EXTENSIONS.has(ext)) return 'doc'
    if (SOURCE_EXTENSIONS.has(ext)) return 'source'
  }
  return 'other'
}

/**
 * Fingerprint an absolute path into `{ resourceClass, resourceId }`. The class
 * is a coarse, non-identifying bucket; the id is the domain-separated HMAC of
 * the normalised path.
 */
export function resourceFingerprint(privacyKey: string, absolutePath: string): ResourceFingerprint {
  return {
    resourceClass: classifyResource(absolutePath),
    resourceId: hmac(privacyKey, 'resource', normalizePath(absolutePath)),
  }
}

/** Fingerprint a session id, scoped to its provider. */
export function sessionRef(privacyKey: string, provider: string, sessionId: string): string {
  return hmac(privacyKey, 'session', provider, sessionId)
}

/** Fingerprint a project path (normalised first). */
export function projectRef(privacyKey: string, path: string): string {
  return hmac(privacyKey, 'project', normalizePath(path))
}

/**
 * Fingerprint a git branch name. Branch names leak feature intent, so only the
 * ref crosses into the observation layer; the host keeps the raw name.
 */
export function branchRef(privacyKey: string, branch: string): string {
  return hmac(privacyKey, 'branch', branch)
}

/**
 * Fingerprint the source path for dedup-key / identity derivation. The raw
 * absolute path must never cross into an observation output, but a decoder
 * that needs a stable opaque form of it (e.g. inside a dedupKey, which ships
 * on the envelope) may use this. Keyed HMAC-SHA256 (decision D1) under the
 * caller-supplied privacyKey: the key is REQUIRED and an empty key throws
 * (like every other fingerprint in this module), so a source ref can never
 * silently degrade to an unkeyed, dictionary-attackable digest. With the host
 * key the ref is host-scoped — not brute-forceable, and not comparable across
 * hosts. The path is normalized first, so a Windows path and its POSIX
 * spelling fingerprint identically.
 */
export function sourceRefFingerprint(privacyKey: string, sourceRef: string): string {
  return hmac(privacyKey, 'source', normalizePath(sourceRef))
}

export type CommandFamily =
  | 'git'
  | 'test'
  | 'build'
  | 'package'
  | 'run'
  | 'fs'
  | 'net'
  | 'shell-other'

const RUNNERS = new Set(['npm', 'yarn', 'pnpm', 'npx', 'bunx'])
const FIRST_TOKEN: Record<string, CommandFamily> = {
  git: 'git',
  vitest: 'test', jest: 'test', pytest: 'test', mocha: 'test', ava: 'test',
  make: 'build', tsc: 'build', tsup: 'build', webpack: 'build', vite: 'build', rollup: 'build', esbuild: 'build',
  pip: 'package', pip3: 'package', gem: 'package', bundle: 'package', cargo: 'package', go: 'package',
  apt: 'package', 'apt-get': 'package', brew: 'package', poetry: 'package',
  node: 'run', deno: 'run', bun: 'run', python: 'run', python3: 'run', ruby: 'run', 'ts-node': 'run', tsx: 'run',
  ls: 'fs', cp: 'fs', mv: 'fs', rm: 'fs', mkdir: 'fs', rmdir: 'fs', touch: 'fs', cat: 'fs', chmod: 'fs', chown: 'fs', find: 'fs', ln: 'fs',
  curl: 'net', wget: 'net', ssh: 'net', scp: 'net', rsync: 'net', nc: 'net', ping: 'net', dig: 'net',
}
// For a runner (npm/yarn/...), the SECOND token decides.
const RUNNER_SUBCOMMAND: Record<string, CommandFamily> = {
  test: 'test',
  run: 'run', start: 'run', exec: 'run', dev: 'run',
  build: 'build',
  install: 'package', ci: 'package', add: 'package', remove: 'package', uninstall: 'package', update: 'package', i: 'package',
}

function basenameToken(token: string): string {
  const cleaned = token.replace(/\\/g, '/')
  const base = cleaned.slice(cleaned.lastIndexOf('/') + 1)
  return base.toLowerCase()
}

/**
 * Classify a command by its leading token(s) only. The function accepts the
 * full command string for the caller's convenience but is documented to NEVER
 * store or return it — only the coarse family is emitted.
 */
export function commandFamily(command: string): CommandFamily {
  const tokens = command.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return 'shell-other'

  const first = basenameToken(tokens[0])

  if (RUNNERS.has(first)) {
    const sub = tokens[1] ? basenameToken(tokens[1]) : ''
    // `npm run <script>` / `npm exec <bin>`: the family is decided by the script.
    if (sub === 'run' || sub === 'exec') {
      const script = tokens[2] ? basenameToken(tokens[2]) : ''
      return RUNNER_SUBCOMMAND[script] ?? 'run'
    }
    return RUNNER_SUBCOMMAND[sub] ?? 'run'
  }

  // `go test` / `go build` refine the generic `go` runner.
  if (first === 'go' && tokens[1]) {
    const sub = basenameToken(tokens[1])
    if (sub === 'test') return 'test'
    if (sub === 'build' || sub === 'install' || sub === 'get') return 'build'
  }

  // Classify by the binary's basename first (so `/opt/bin/git` is git), then
  // fall back to treating a bare path invocation like `./scripts/x.sh` as a run.
  const known = FIRST_TOKEN[first]
  if (known) return known
  if (tokens[0].startsWith('./') || tokens[0].startsWith('/') || tokens[0].startsWith('../')) return 'run'

  return 'shell-other'
}

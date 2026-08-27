import { execFileSync } from 'child_process'
import { existsSync, readdirSync } from 'fs'

/// WSL discovery (#1059). Claude Code / Codex run *inside* a WSL distro write
/// their history to the distro's Linux home, which lives on a 9P share Windows
/// exposes as `\\wsl$\<distro>\...` — never under the Windows user profile. A
/// Windows-only scan therefore reports zero sessions for those users.
///
/// `CODEBURN_WSL` is deliberately NOT in PROVIDER_ENV_VARS (src/session-cache.ts):
/// it is a live discovery/read policy, not parsed content. Active roots add
/// source paths; offline roots retain their historical rows; and active-root
/// deletions are reconciled explicitly. Fingerprinting the mode would discard
/// that retained history and force a full 9P re-parse after re-enable.

export type WslMode = 'off' | 'all' | 'running'

export type WslCachePathStatus = 'not-wsl' | 'disabled' | 'active' | 'offline'

export function wslMode(env: NodeJS.ProcessEnv = process.env): WslMode {
  const value = (env['CODEBURN_WSL'] ?? '').trim().toLowerCase()
  return value === 'off' || value === 'all' ? value : 'running'
}

/// Windows' CreateProcess searches the current directory before PATH, so
/// spawning `wsl.exe` by bare name lets anything dropped next to the CLI
/// impersonate it. Same rule as src/menubar-installer.ts: resolveSystem32Path.
function wslExePath(env: NodeJS.ProcessEnv): string {
  const root = env['SystemRoot']
  const base = root && /^[a-zA-Z]:[\\/]/.test(root) ? root.replace(/[\\/]+$/, '') : 'C:\\Windows'
  return `${base}\\System32\\wsl.exe`
}

// Distros that exist to back a container runtime; they hold no user history.
const UTILITY_DISTROS = /^(docker-desktop|podman-machine|rancher-desktop)/

/// `wsl.exe --list --quiet` writes UTF-16LE (no BOM on some builds) with CRLF
/// line ends; piping it through a UTF-8 decode yields NUL-separated garbage.
/// Detect the encoding from the interleaved NULs rather than trusting either.
///
/// With nothing installed, wsl.exe prints prose ("Windows Subsystem for Linux
/// has no installed distributions.", plus install hints) on stdout, and every
/// one of those lines would otherwise be probed as a distro name over UNC.
/// A name must therefore be a single token with none of the characters Windows
/// bans from a path component and no trailing period \u2014 true of every real
/// distro name, false of every line of that message, in any UI language.
// ponytail: a distro imported under a name containing a space is skipped.
// Widen to a wording-based filter only if someone actually reports one.
const DISTRO_NAME = /^[^\s\\/:*?"<>|]+$/

export function parseWslDistros(raw: Buffer): string[] {
  const text = raw.includes(0) ? raw.toString('utf16le') : raw.toString('utf8')
  return text
    .split(/\r?\n/)
    .map(line => line.replace(/[\0\uFEFF]/g, '').trim())
    .filter(name => DISTRO_NAME.test(name) && !name.endsWith('.') && !UTILITY_DISTROS.test(name))
}

// `\\wsl$\` first: it works on every WSL build, while `wsl.localhost` only
// exists on newer ones. Probing the newer spelling first would send builds
// without it through MUP -> SMB -> DNS resolution for a host named
// "wsl.localhost" \u2014 multiple seconds of stall per distro, every process.
const UNC_PREFIXES = ['\\\\wsl$\\', '\\\\wsl.localhost\\']

/// Only the backslash spellings are matched: these paths are produced by
/// UNC_PREFIXES above and never normalized to forward slashes, and Windows
/// itself accepts `//wsl$/` only through APIs we do not use.
export function isWslUncPath(path: string): boolean {
  return /^\\\\wsl(\$|\.localhost)\\/i.test(path)
}

function homesUnder(base: string): string[] {
  const homes: string[] = []
  try {
    for (const entry of readdirSync(`${base}\\home`, { withFileTypes: true })) {
      if (entry.isDirectory()) homes.push(`${base}\\home\\${entry.name}`)
    }
  } catch {}
  try {
    if (existsSync(`${base}\\root`)) homes.push(`${base}\\root`)
  } catch {}
  return homes
}

function discoverWslHomes(): string[] {
  if (process.platform !== 'win32') return []
  const mode = wslMode()
  if (mode === 'off') return []

  // Default is running-only: touching `\\wsl$\<distro>` for a *stopped* distro
  // boots it, which is both intrusive and slow. `CODEBURN_WSL=all` opts in.
  const args = mode === 'all' ? ['--list', '--quiet'] : ['--list', '--quiet', '--running']
  let raw: Buffer
  try {
    raw = execFileSync(wslExePath(process.env), args, {
      timeout: 3000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return []
  }

  const homes: string[] = []
  for (const distro of parseWslDistros(raw)) {
    for (const prefix of UNC_PREFIXES) {
      const found = homesUnder(prefix + distro)
      if (found.length > 0) {
        homes.push(...found)
        break
      }
    }
  }
  return homes
}

// Discovery is cached for a short TTL only — never for the process lifetime.
// In long-lived embedders (the resident serve child, menubar polling) a
// process-lifetime memo goes stale in both directions: a distro cached as
// running can be shut down, and touching a stopped distro's \\wsl$ path can
// HANG win32 fs calls (worse than an error — it is the operation the
// running-only default exists to avoid); and a distro started after an empty
// discovery would stay invisible until restart. On expiry the running-distro
// list is re-probed BEFORE any UNC path is touched, and a failed probe fails
// closed to native-only discovery — stale homes are never served in place of
// a fresh probe.
const WSL_HOMES_TTL_MS = 60_000

let cached: { homes: string[]; expiresAt: number; mode?: WslMode; pinned?: boolean } | undefined

/// Every WSL home directory to treat as an extra provider root. Cached for
/// WSL_HOMES_TTL_MS (spawning wsl.exe and walking a 9P share is not free);
/// past the TTL the running-distro probe re-validates before any UNC access.
export function wslHomes(now: number = Date.now()): string[] {
  const mode = wslMode()
  // Toggling the opt-out in a long-lived process must take effect immediately:
  // do not reuse a previously discovered home and then walk its UNC share.
  // Retained cache rows are handled separately by classifyWslCachePath, so
  // clearing discovery here does not erase historical WSL usage.
  if (mode === 'off') {
    if (!cached?.pinned) cached = undefined
    return []
  }
  if (cached?.pinned) return cached.homes
  // `running` and `all` enumerate different sets. A long-lived caller that
  // changes policy must not reuse the prior mode's roots for the TTL window.
  if (cached !== undefined && cached.mode === mode && now < cached.expiresAt) return cached.homes
  const homes = discoverWslHomes()
  cached = { homes, expiresAt: now + WSL_HOMES_TTL_MS, mode }
  return homes
}

/// Re-check the currently reachable homes before deciding whether an
/// undiscovered WSL cache path is merely offline or was actually deleted.
/// Normal discovery keeps its 60s TTL; this escape hatch is used only when an
/// orphan needs that distinction. Pinned test homes remain pinned.
export function refreshWslHomes(): string[] {
  const mode = wslMode()
  if (mode === 'off') return []
  if (cached?.pinned) return cached.homes
  const homes = discoverWslHomes()
  cached = { homes, expiresAt: Date.now() + WSL_HOMES_TTL_MS, mode }
  return homes
}

/// Test seam: discovery shells out to wsl.exe and stats a 9P share, neither of
/// which exists on CI. Pinned homes never expire; pass `undefined` to restore
/// real discovery.
export function setWslHomes(homes: string[] | undefined): void {
  cached = homes === undefined
    ? undefined
    : { homes, expiresAt: Number.POSITIVE_INFINITY, pinned: true }
}

const WSL_CANONICAL_PATH = /^\\\\wsl(?:\$|\.localhost)\\([^\\/]+)(?:[\\/](.*))?$/i

function canonicalWslPath(path: string): string | undefined {
  const match = WSL_CANONICAL_PATH.exec(path)
  if (!match) return undefined
  const suffix = (match[2] ?? '')
    .replace(/[\\/]+/g, '\\')
    .replace(/^\\+|\\+$/g, '')
  // The distro/share portion is Windows-addressed, but everything below it is
  // a Linux path. Preserve suffix case so homes such as `Alice` and `alice`
  // are never treated as the same active root.
  return `${match[1]!.toLowerCase()}${suffix ? `\\${suffix}` : ''}`
}

/// Classify a cached WSL source without touching the source path itself.
/// `active` means the current WSL probe still exposes the owning home;
/// `offline` means the root is currently absent (normally stopped); and
/// `disabled` is the explicit read-policy opt-out. The alternate UNC spellings
/// are canonicalized so a cache written through `\\wsl$` still matches a
/// current probe that resolved through `\\wsl.localhost`.
export function classifyWslCachePath(path: string, homes?: readonly string[]): WslCachePathStatus {
  if (!isWslUncPath(path)) return 'not-wsl'
  if (wslMode() === 'off') return 'disabled'
  const canonicalPath = canonicalWslPath(path)
  if (!canonicalPath) return 'offline'
  const currentHomes = homes ?? wslHomes()
  for (const home of currentHomes) {
    const canonicalHome = canonicalWslPath(home)
    if (canonicalHome && (canonicalPath === canonicalHome || canonicalPath.startsWith(`${canonicalHome}\\`))) {
      return 'active'
    }
  }
  return 'offline'
}

/// One line for `codeburn doctor` when Windows probed no WSL roots, so an
/// opt-out or a missing wsl.exe reads as a reason rather than a silent zero.
export function wslDoctorNote(platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== 'win32') return undefined
  if (wslMode() === 'off') return 'WSL scan disabled by CODEBURN_WSL=off; no \\\\wsl$ roots were probed.'
  if (wslHomes().length > 0) return undefined
  return 'No WSL roots probed: no running distro was found, or wsl.exe is unavailable. ' +
    'Set CODEBURN_WSL=all to include stopped distros (accessing one starts it).'
}

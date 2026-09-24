// "Update available" check for CodeBurn Desktop, mirroring the Swift menubar's
// UpdateChecker (mac/Sources/CodeBurnMenubar/Data/UpdateChecker.swift): it reads
// the public GitHub releases feed once per launch and every 24h, finds the newest
// `desktop-v<semver>` release, and semver-compares it to the running version.
//
// It NEVER downloads or installs. The desktop builds are unsigned, so an in-app
// auto-update can't run yet — that arrives with Developer ID signing. Offline or
// any error is a silent no-op that retries on the next cycle.
//
// Privacy: this is a plain, unauthenticated GitHub read that carries no
// identifiers. We deliberately send NO app-identifying headers — only the
// runtime's default User-Agent (Node/Electron's "node") goes out, and no auth
// token — so the request reveals nothing about the user or install. GitHub only
// requires *some* User-Agent, which the default satisfies. See fetchReleases.

const RELEASES_URL = 'https://api.github.com/repos/getagentseal/codeburn/releases?per_page=15'
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 15_000
// Desktop releases are tagged `desktop-v<major>.<minor>.<patch>` (app/DISTRIBUTION.md).
const DESKTOP_TAG_RE = /^desktop-v(\d+\.\d+\.\d+)$/

export type UpdateStatus = {
  currentVersion: string
  /** Newest published desktop version, or null when unknown (offline / no match). */
  latestVersion: string | null
  updateAvailable: boolean
  /** The release tag to link when an update is available (else null). */
  tag: string | null
  /** A Microsoft Store (AppX) install: the Store delivers updates, on its own schedule, so
   *  GitHub is never asked and nothing is offered. */
  storeManaged?: boolean
}

type GitHubRelease = { tag_name?: string }

function baselineStatus(currentVersion: string): UpdateStatus {
  return { currentVersion, latestVersion: null, updateAvailable: false, tag: null }
}

/** Numeric compare of two `major.minor.patch` strings: -1 / 0 / 1. Missing or
 *  non-numeric parts count as 0. */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.')
  const pb = b.split('.')
  for (let i = 0; i < 3; i++) {
    const x = Number(pa[i] ?? 0) || 0
    const y = Number(pb[i] ?? 0) || 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** The newest `desktop-v<semver>` release among the feed, or null if none match.
 *  Picks by semver rather than trusting feed order. */
export function pickLatestDesktopVersion(releases: GitHubRelease[]): { version: string; tag: string } | null {
  let best: { version: string; tag: string } | null = null
  for (const release of releases) {
    const tag = typeof release?.tag_name === 'string' ? release.tag_name : ''
    const match = DESKTOP_TAG_RE.exec(tag)
    if (!match) continue
    const version = match[1]!
    if (!best || compareSemver(version, best.version) > 0) best = { version, tag }
  }
  return best
}

/** Fetch + parse the releases feed. No auth, no app-identifying headers (see the
 *  file header). Aborts after 15s. Throws on a non-2xx response. */
export async function fetchReleases(signal: AbortSignal, fetchImpl: typeof fetch = globalThis.fetch): Promise<GitHubRelease[]> {
  const response = await fetchImpl(RELEASES_URL, { signal })
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`)
  const data = await response.json()
  return Array.isArray(data) ? (data as GitHubRelease[]) : []
}

export type UpdateChecker = {
  /** Cached status, refreshed only when older than the 24h interval. */
  getStatus(): Promise<UpdateStatus>
  /** Force a fresh check now (launch + the 24h timer call this). */
  check(): Promise<UpdateStatus>
}

export function createUpdateChecker(opts: {
  currentVersion: string
  storeManaged?: boolean
  /** Injected in tests; defaults to the real GitHub read. */
  fetchReleasesImpl?: (signal: AbortSignal) => Promise<GitHubRelease[]>
  now?: () => number
  intervalMs?: number
}): UpdateChecker {
  const now = opts.now ?? (() => Date.now())
  const intervalMs = opts.intervalMs ?? CHECK_INTERVAL_MS
  const fetchReleasesImpl = opts.fetchReleasesImpl ?? ((signal: AbortSignal) => fetchReleases(signal))

  let cached = baselineStatus(opts.currentVersion)
  let lastCheckedAt = 0
  let inflight: Promise<UpdateStatus> | null = null

  // A release is tagged on GitHub before the Store has certified it, so the GitHub feed would
  // announce a version the Store cannot install yet (#1520).
  if (opts.storeManaged) {
    const status: UpdateStatus = { ...baselineStatus(opts.currentVersion), storeManaged: true }
    return { getStatus: () => Promise.resolve(status), check: () => Promise.resolve(status) }
  }

  const check = (): Promise<UpdateStatus> => {
    if (inflight) return inflight
    inflight = (async () => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
      try {
        const releases = await fetchReleasesImpl(controller.signal)
        const latest = pickLatestDesktopVersion(releases)
        lastCheckedAt = now()
        if (!latest) {
          cached = baselineStatus(opts.currentVersion)
        } else {
          const updateAvailable = compareSemver(latest.version, opts.currentVersion) > 0
          cached = {
            currentVersion: opts.currentVersion,
            latestVersion: latest.version,
            updateAvailable,
            tag: updateAvailable ? latest.tag : null,
          }
        }
      } catch {
        // Offline / GitHub error / timeout: silent no-op. Keep the last known
        // status and leave lastCheckedAt so the next cycle retries.
      } finally {
        clearTimeout(timer)
        inflight = null
      }
      return cached
    })()
    return inflight
  }

  const getStatus = (): Promise<UpdateStatus> => {
    if (lastCheckedAt !== 0 && now() - lastCheckedAt < intervalMs) return Promise.resolve(cached)
    return check()
  }

  return { getStatus, check }
}

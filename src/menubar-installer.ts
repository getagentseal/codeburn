import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, constants as fsConstants } from 'node:fs'
import { access, chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, platform, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { ProxyAgent, fetch as undiciFetch } from 'undici'

import { getCodeburnCacheDir } from './cache-dir.js'
import {
  buildPersistentCodeburnLookupPath,
  resolvePersistentCodeburnPathFromWhichOutput,
} from './persistent-codeburn.js'

/// Public GitHub repo that hosts macOS release builds. Normal installs use direct
/// versioned release asset URLs; the API scan is only a fallback for missing assets.
const RELEASE_API = 'https://api.github.com/repos/getagentseal/codeburn/releases?per_page=20'
const RELEASE_DOWNLOAD_BASE = 'https://github.com/getagentseal/codeburn/releases/download'
const APP_BUNDLE_NAME = 'CodeBurnMenubar.app'
const EXPECTED_BUNDLE_ID = 'org.agentseal.codeburn-menubar'
const VERSIONED_ASSET_PATTERN = /^CodeBurnMenubar-v.+\.zip$/
const APP_PROCESS_NAME = 'CodeBurnMenubar'
const SUPPORTED_OS = 'darwin'
/// The Windows tray app (windows/) ships as an .msi under its own `windows-v*` tag. GitHub
/// rewrites the spaces in the bundle name to dots when it stores the asset, so both the asset
/// name and its download URL carry `CodeBurn.Menubar_...`.
const WINDOWS_PRODUCT_NAME = 'CodeBurn Menubar'
/// What the installed executable is actually called. Tauri names the binary after the Cargo
/// package (windows/src-tauri/Cargo.toml) and the install directory after the product, so the
/// two differ: `CodeBurn Menubar\codeburn-menubar.exe`. Joining the product name onto
/// InstallLocation builds a path to nothing, which is what the post-install launch, the
/// desktop app's stored path and the Run value it seeds were all built from.
const WINDOWS_BINARY_NAME = 'codeburn-menubar.exe'
const WINDOWS_ASSET_PATTERN = /^CodeBurn\.Menubar_.+_x64_en-US\.msi$/
const MIN_MACOS_MAJOR = 14
const PERSISTED_CLI_PATH = join(homedir(), 'Library', 'Application Support', 'CodeBurn', 'codeburn-cli-path.v1')
const PERSISTENT_CLI_REQUIRED_MESSAGE =
  'The menubar app needs a persistent codeburn command. Install CodeBurn globally first: npm install -g codeburn'

export type InstallResult = { installedPath: string; launched: boolean }

export type ReleaseAsset = { name: string; browser_download_url: string }
export type ReleaseResponse = { tag_name: string; assets: ReleaseAsset[] }
/// `zip` is the platform's primary asset: the mac bundle zip, or the Windows .msi.
export type ResolvedAssets = { release: ReleaseResponse; zip: ReleaseAsset; checksum: ReleaseAsset }
export type InstallOptions = {
  force?: boolean
  cliVersion?: string
  platform?: string
  /// An absolute path to a `CodeBurn.Menubar_<version>_x64_en-US.msi` staged inside an
  /// installed CodeBurn desktop app, from `codeburn menubar --staged-msi`. Validated by
  /// assertStagedMsiPath before anything is run on it.
  stagedMsi?: string
  windows?: WindowsInstallHooks
}

/// What differs per platform between the mac and Windows installs: which release tag holds the
/// build, and which asset in it is the installable. Everything downstream - versioned URL first,
/// release-API scan as fallback, retrying download, checksum verify - is shared.
export type ReleaseSpec = {
  tagPrefix: string
  assetPattern: RegExp
  assetName: (version: string) => string
  missingAsset: (tag: string) => string
  noRelease: string
}

const MAC_RELEASE: ReleaseSpec = {
  tagPrefix: 'mac-v',
  assetPattern: VERSIONED_ASSET_PATTERN,
  assetName: version => `CodeBurnMenubar-v${version}.zip`,
  missingAsset: tag =>
    `No ${APP_BUNDLE_NAME} versioned zip found in release ${tag}. ` +
    `Check https://github.com/getagentseal/codeburn/releases.`,
  noRelease: 'No mac-v* release with a CodeBurnMenubar-v*.zip and checksum was found.',
}

export const WINDOWS_RELEASE: ReleaseSpec = {
  tagPrefix: 'windows-v',
  assetPattern: WINDOWS_ASSET_PATTERN,
  assetName: version => `CodeBurn.Menubar_${version}_x64_en-US.msi`,
  missingAsset: tag =>
    `No ${WINDOWS_PRODUCT_NAME} .msi found in release ${tag}. ` +
    `Check https://github.com/getagentseal/codeburn/releases.`,
  noRelease: 'No windows-v* release with a CodeBurn.Menubar_*.msi and checksum was found.',
}
type ProxyEnv = Partial<Record<'HTTPS_PROXY' | 'https_proxy' | 'HTTP_PROXY' | 'http_proxy' | 'NO_PROXY' | 'no_proxy', string>>
type FetchOptions = Parameters<typeof undiciFetch>[1]
type HeaderGetter = { get(name: string): string | null }

/// Only the response surface the asset downloads actually touch, so tests can inject a
/// plain object instead of constructing a full undici Response.
type FetchLikeResponse = {
  ok: boolean
  status: number
  headers: HeaderGetter
  body: unknown
  text(): Promise<string>
}
type FetchImpl = (url: string, options?: FetchOptions) => Promise<FetchLikeResponse>
/// The release-API lookup reads JSON instead of streaming a body, so it takes its own narrow
/// response shape rather than widening FetchLikeResponse for every asset download fake.
export type ReleaseApiFetch = (url: string, options?: FetchOptions) =>
  Promise<{ ok: boolean; status: number; headers: HeaderGetter; json(): Promise<unknown> }>

/// Release-asset delivery (github.com -> Azure blob) occasionally returns a transient 5xx or
/// drops the socket. Three attempts with a short exponential backoff (0.5s, then 1s) rides out
/// that class of blip while adding at most ~1.5s before a genuinely broken download reports
/// back, and `codeburn menubar` is interactive, so failing fast still matters.
const ASSET_MAX_ATTEMPTS = 3
const ASSET_BASE_DELAY_MS = 500

export type AssetFetchOptions = {
  fetchImpl?: FetchImpl
  sleep?: (ms: number) => Promise<void>
  log?: (message: string) => void
  maxAttempts?: number
  baseDelayMs?: number
}

class HttpStatusError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'HttpStatusError'
  }
}

export function resolveProxyUrlForUrl(url: string, env: ProxyEnv = process.env): string | undefined {
  const target = new URL(url)
  if (matchesNoProxy(target.hostname, env.NO_PROXY ?? env.no_proxy)) return undefined
  if (target.protocol === 'https:') return env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy
  if (target.protocol === 'http:') return env.HTTP_PROXY ?? env.http_proxy
  return undefined
}

function matchesNoProxy(hostname: string, noProxy?: string): boolean {
  if (!noProxy) return false
  const host = hostname.toLowerCase()
  return noProxy.split(',').some(entry => {
    const rule = entry.trim().toLowerCase().split(':')[0]
    if (!rule) return false
    if (rule === '*') return true
    if (rule.startsWith('.')) return host === rule.slice(1) || host.endsWith(rule)
    return host === rule || host.endsWith(`.${rule}`)
  })
}

function fetchWithProxy(url: string, options: FetchOptions = {}) {
  const proxyUrl = resolveProxyUrlForUrl(url)
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined
  return undiciFetch(url, dispatcher ? { ...options, dispatcher } : options)
}

export function resolveMenubarReleaseAssets(release: ReleaseResponse, spec: ReleaseSpec = MAC_RELEASE): ResolvedAssets {
  const zip = release.assets.find(a => spec.assetPattern.test(a.name))
  if (!zip) throw new Error(spec.missingAsset(release.tag_name))
  const checksum = release.assets.find(a => a.name === `${zip.name}.sha256`)
  if (!checksum) {
    throw new Error(`Missing checksum asset ${zip.name}.sha256 in release ${release.tag_name}.`)
  }
  return { release, zip, checksum }
}

export function resolveLatestMenubarReleaseAssets(releases: ReleaseResponse[], spec: ReleaseSpec = MAC_RELEASE): ResolvedAssets {
  for (const release of releases) {
    if (!release.tag_name.startsWith(spec.tagPrefix)) continue
    try {
      return resolveMenubarReleaseAssets(release, spec)
    } catch {
      continue
    }
  }
  throw new Error(spec.noRelease)
}

function normalizeCliVersion(cliVersion: string): string {
  return cliVersion.trim().replace(/^v/, '')
}

export function resolveVersionedMenubarReleaseAssets(cliVersion: string, spec: ReleaseSpec = MAC_RELEASE): ResolvedAssets {
  const version = normalizeCliVersion(cliVersion)
  if (!version) throw new Error('Cannot resolve CodeBurn Menubar release without a CLI version.')

  const tagName = `${spec.tagPrefix}${version}`
  const zipName = spec.assetName(version)
  const checksumName = `${zipName}.sha256`
  const releaseBase = `${RELEASE_DOWNLOAD_BASE}/${tagName}`
  const zip = { name: zipName, browser_download_url: `${releaseBase}/${zipName}` }
  const checksum = { name: checksumName, browser_download_url: `${releaseBase}/${checksumName}` }

  return {
    release: { tag_name: tagName, assets: [zip, checksum] },
    zip,
    checksum,
  }
}

export function shouldFallbackToReleaseApi(status: number): boolean {
  return status === 404 || status === 410
}

export function formatGitHubReleaseLookupError(status: number, headers?: HeaderGetter): string {
  const base = `GitHub release lookup failed: HTTP ${status}`
  if (status !== 403 && status !== 429) return base

  const details = ['GitHub may be rate limiting unauthenticated release API requests.']
  const retryAfter = headers?.get('retry-after')
  const rateLimitReset = headers?.get('x-ratelimit-reset')
  if (retryAfter) details.push(`retry-after=${retryAfter}`)
  if (rateLimitReset) details.push(`x-ratelimit-reset=${rateLimitReset}`)
  return `${base}. ${details.join(' ')}`
}

export function isMissingDirectAssetError(err: unknown): boolean {
  return err instanceof HttpStatusError && shouldFallbackToReleaseApi(err.status)
}

export {
  buildPersistentCodeburnLookupPath,
  resolvePersistentCodeburnPathFromWhichOutput,
} from './persistent-codeburn.js'

function userApplicationsDir(): string {
  return join(homedir(), 'Applications')
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function ensureSupportedPlatform(): Promise<void> {
  if (platform() !== SUPPORTED_OS) {
    throw new Error(`The menubar app is macOS only (detected: ${platform()}).`)
  }
  const major = Number((process.env.CODEBURN_FORCE_MACOS_MAJOR ?? '')
    || (await sysProductVersion()).split('.')[0])
  if (!Number.isFinite(major) || major < MIN_MACOS_MAJOR) {
    throw new Error(`macOS ${MIN_MACOS_MAJOR}+ required (detected ${major}).`)
  }
}

async function sysProductVersion(): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('/usr/bin/sw_vers', ['-productVersion'])
    let out = ''
    proc.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0) reject(new Error(`sw_vers exited with ${code}`))
      else resolve(out.trim())
    })
  })
}

async function fetchLatestReleaseAssets(spec: ReleaseSpec = MAC_RELEASE, fetchImpl?: ReleaseApiFetch): Promise<ResolvedAssets> {
  const response = await (fetchImpl ?? fetchWithProxy)(RELEASE_API, {
    headers: {
      'User-Agent': 'codeburn-menubar-installer',
      Accept: 'application/vnd.github+json',
    },
  })
  if (!response.ok) {
    throw new HttpStatusError(formatGitHubReleaseLookupError(response.status, response.headers), response.status)
  }
  const body = await response.json() as ReleaseResponse[]
  return resolveLatestMenubarReleaseAssets(body, spec)
}

/// 5xx means "GitHub/the CDN is unhappy right now" and is worth another attempt. 4xx is not:
/// 404/410 must keep falling through to the release-API path untouched, and a 403/429 rate limit
/// cannot clear inside a 1.5s backoff window, and hammering it would only spend more of the budget,
/// so those surface immediately with the retry-after hint instead.
function isTransientStatus(status: number): boolean {
  return status >= 500 && status <= 599
}

function formatAssetHttpError(label: string, url: string, response: FetchLikeResponse): string {
  const base = `${label} failed: HTTP ${response.status} (${url})`
  if (response.status !== 403 && response.status !== 429) return base
  const retryAfter = response.headers.get('retry-after')
  const hint = retryAfter
    ? `GitHub may be rate limiting this download; retry-after=${retryAfter}.`
    : 'GitHub may be rate limiting this download.'
  return `${base}. ${hint}`
}

/// Clamp a caller-supplied attempt budget to a finite positive integer. `AssetFetchOptions` is
/// exported, so a NaN/Infinity/0 slipping through must never turn the loop below into an unbounded
/// (and, once `2 ** attempt` overflows to a ~1ms setTimeout, tight) retry against the same host.
function normalizeMaxAttempts(value: number | undefined): number {
  if (value === undefined) return ASSET_MAX_ATTEMPTS
  if (!Number.isFinite(value) || value < 1) return 1
  return Math.floor(value)
}

/// Release a response's body so undici can return the socket to the pool instead of holding it
/// open until GC across a run of retries. Best effort: a missing or already-consumed body is fine.
async function drainBody(response: FetchLikeResponse): Promise<void> {
  const body = response.body as { cancel?: () => Promise<unknown> } | null
  try {
    await body?.cancel?.()
  } catch {
    // ignore
  }
}

/// Fetch a release asset and hand the successful response to `consume`, retrying only transient
/// failures: a 5xx, a network-level rejection, or a failure while consuming the body (a socket
/// dropped mid-download). 4xx is never retried - 404/410 keep routing to the release-API fallback
/// with their status intact, and a 403/429 rate limit cannot clear inside the backoff window.
/// `consume` runs inside the retry, so it must clean up after itself on failure (see downloadToFile,
/// which removes any partial file before re-throwing) and must not fold in an integrity check that
/// has to fail closed (see verifyChecksum, which compares the digest only after this returns).
async function fetchReleaseAsset<T>(
  url: string,
  label: string,
  consume: (response: FetchLikeResponse) => Promise<T>,
  options: AssetFetchOptions,
): Promise<T> {
  const doFetch = options.fetchImpl ?? fetchWithProxy
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const log = options.log ?? console.log
  const maxAttempts = normalizeMaxAttempts(options.maxAttempts)
  const baseDelayMs = options.baseDelayMs ?? ASSET_BASE_DELAY_MS

  for (let attempt = 1; ; attempt++) {
    const isLastAttempt = attempt >= maxAttempts
    const delayMs = baseDelayMs * 2 ** (attempt - 1)

    let response: FetchLikeResponse
    try {
      response = await doFetch(url, {
        headers: { 'User-Agent': 'codeburn-menubar-installer' },
        redirect: 'follow',
      })
    } catch (err) {
      // Network-level failure (ECONNRESET / ETIMEDOUT / socket hang up): no status to inspect,
      // and always transient enough to be worth one more try.
      const reason = err instanceof Error ? err.message : String(err)
      if (isLastAttempt) throw new Error(`${label} failed after ${maxAttempts} attempts: ${reason} (${url})`, { cause: err })
      log(`${label} hit a network error (${reason}), retrying in ${delayMs}ms (attempt ${attempt + 1} of ${maxAttempts})...`)
      await sleep(delayMs)
      continue
    }

    if (!response.ok) {
      const retryable = isTransientStatus(response.status) && !isLastAttempt
      await drainBody(response)
      if (!retryable) throw new HttpStatusError(formatAssetHttpError(label, url, response), response.status)
      log(`${label} failed with HTTP ${response.status}, retrying in ${delayMs}ms (attempt ${attempt + 1} of ${maxAttempts})...`)
      await sleep(delayMs)
      continue
    }

    try {
      return await consume(response)
    } catch (err) {
      // The body did not arrive in full (a dropped socket mid-stream, or a 2xx with no body).
      // consume has cleaned up any partial artifact, so this is safe to treat as transient.
      const reason = err instanceof Error ? err.message : String(err)
      if (isLastAttempt) throw new Error(`${label} failed after ${maxAttempts} attempts: ${reason} (${url})`, { cause: err })
      log(`${label} stream failed (${reason}), retrying in ${delayMs}ms (attempt ${attempt + 1} of ${maxAttempts})...`)
      await sleep(delayMs)
      continue
    }
  }
}

/// `<digest>  <name>`, as sha256sum writes it; only the digest is compared.
async function assertSha256(archivePath: string, checksumText: string): Promise<void> {
  const expected = checksumText.trim().split(/\s+/)[0]!.toLowerCase()
  const fileBytes = await readFile(archivePath)
  const actual = createHash('sha256').update(fileBytes).digest('hex')
  if (actual !== expected) {
    throw new Error(
      `Checksum mismatch for ${archivePath}.\n` +
      `  Expected: ${expected}\n` +
      `  Got:      ${actual}\n` +
      `The download may be corrupted or tampered with.`
    )
  }
}

export async function verifyChecksum(
  archivePath: string,
  checksumUrl: string,
  options: AssetFetchOptions = {},
): Promise<void> {
  // Only the transport is retried. The digest comparison is deliberately outside the retry:
  // an integrity failure must abort on the first look and never re-download.
  const text = await fetchReleaseAsset(checksumUrl, 'Checksum download', response => response.text(), options)
  await assertSha256(archivePath, text)
}

/// The same check for an .msi that arrived with another installer rather than over the network:
/// its digest sits in `<msi>.sha256` beside it. A missing digest file is a refusal rather than a
/// skip, because the whole point is that nothing unverified reaches msiexec.
export async function verifyStagedChecksum(archivePath: string): Promise<void> {
  const checksumPath = `${archivePath}.sha256`
  let text: string
  try {
    text = await readFile(checksumPath, 'utf8')
  } catch {
    throw new Error(`Missing checksum file ${checksumPath}; refusing to run an unverified installer.`)
  }
  await assertSha256(archivePath, text)
}

export async function downloadToFile(
  url: string,
  destPath: string,
  options: AssetFetchOptions = {},
): Promise<void> {
  await fetchReleaseAsset(url, 'Download', async response => {
    // A 2xx with no body is the most retryable response there is; throw so the retry picks it up
    // rather than writing a zero-byte file that verifyChecksum would later reject as a mismatch.
    if (response.body === null) throw new Error('response had no body')
    // fetch's ReadableStream needs to be wrapped for Node streams.
    const nodeStream = Readable.fromWeb(response.body as never)
    try {
      await pipeline(nodeStream, createWriteStream(destPath))
    } catch (err) {
      // A mid-stream drop leaves a truncated file. Remove it before re-throwing so the retry
      // starts clean and a genuine failure never leaves a partial artifact behind.
      await rm(destPath, { force: true }).catch(() => {})
      throw err
    }
  }, options)
}

async function stageMenubarApp(assets: ResolvedAssets, stagingDir: string): Promise<string> {
  const { zip, checksum } = assets
  const archivePath = join(stagingDir, zip.name)
  console.log(`Downloading ${zip.name}...`)
  await downloadToFile(zip.browser_download_url, archivePath)

  console.log('Verifying checksum...')
  await verifyChecksum(archivePath, checksum.browser_download_url)

  console.log('Unpacking...')
  await runCommand('/usr/bin/ditto', ['-x', '-k', archivePath, stagingDir])

  const unpackedApp = join(stagingDir, APP_BUNDLE_NAME)
  if (!(await exists(unpackedApp))) {
    throw new Error(`Archive did not contain ${APP_BUNDLE_NAME}.`)
  }

  console.log('Verifying app bundle...')
  await verifyBundleIdentity(unpackedApp)

  // Clear Gatekeeper's quarantine xattr. Without this, the first launch shows the
  // "cannot verify developer" prompt even for a signed + notarized app when the bundle
  // was delivered via curl/fetch instead of the Mac App Store.
  await runCommand('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', unpackedApp]).catch(() => {})

  return unpackedApp
}

async function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: 'inherit' })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with status ${code}`))
    })
  })
}

async function captureCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    proc.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
    proc.stderr.on('data', (chunk: Buffer) => { err += chunk.toString() })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve(out.trim())
      else reject(new Error(`${command} exited with status ${code}${err ? `: ${err.trim()}` : ''}`))
    })
  })
}

async function verifyBundleIdentity(appPath: string): Promise<void> {
  const bundleID = await captureCommand('/usr/libexec/PlistBuddy', [
    '-c',
    'Print :CFBundleIdentifier',
    join(appPath, 'Contents', 'Info.plist'),
  ])
  if (bundleID !== EXPECTED_BUNDLE_ID) {
    throw new Error(`Unexpected menubar bundle id ${bundleID}; expected ${EXPECTED_BUNDLE_ID}.`)
  }
  await runCommand('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath])
}

async function resolvePersistentCodeburnPath(): Promise<string> {
  let output = ''
  try {
    output = await captureCommand('/usr/bin/env', [
      `PATH=${buildPersistentCodeburnLookupPath()}`,
      'which',
      '-a',
      'codeburn',
    ])
  } catch {
    throw new Error(PERSISTENT_CLI_REQUIRED_MESSAGE)
  }

  return resolvePersistentCodeburnPathFromWhichOutput(output, PERSISTENT_CLI_REQUIRED_MESSAGE)
}

async function persistCodeburnPath(): Promise<void> {
  let cliPath: string
  try {
    cliPath = await resolvePersistentCodeburnPath()
  } catch (err) {
    // Nothing on PATH, but someone may already have recorded a codeburn the menubar can run:
    // the desktop app writes a launcher for the CLI it carries before it asks for this install,
    // and a person who only ever installed the .dmg has no global command to find. A recorded
    // launcher that still runs is a better answer than refusing the install.
    if (await hasRunnableRecordedCli()) return
    throw err
  }
  await mkdir(join(homedir(), 'Library', 'Application Support', 'CodeBurn'), { recursive: true, mode: 0o700 })
  await writeFile(PERSISTED_CLI_PATH, `${cliPath}\n`, { mode: 0o600 })
  await chmod(PERSISTED_CLI_PATH, 0o600)
}

/// Whether the recorded path names an absolute file this machine can execute. Same three
/// checks the menubar itself makes before trusting the record (CodeburnCLI.persistedCLIPath).
export async function hasRunnableRecordedCli(recordPath: string = PERSISTED_CLI_PATH): Promise<boolean> {
  try {
    const recorded = (await readFile(recordPath, 'utf-8')).trim()
    if (!isAbsolute(recorded)) return false
    await access(recorded, fsConstants.X_OK)
    return (await stat(recorded)).isFile()
  } catch {
    return false
  }
}

async function isAppRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('/usr/bin/pgrep', ['-f', APP_PROCESS_NAME])
    proc.on('close', (code) => resolve(code === 0))
    proc.on('error', () => resolve(false))
  })
}

async function killRunningApp(): Promise<void> {
  await new Promise<void>((resolve) => {
    const proc = spawn('/usr/bin/pkill', ['-f', APP_PROCESS_NAME])
    proc.on('close', () => resolve())
    proc.on('error', () => resolve())
  })
  for (let i = 0; i < 10; i++) {
    if (!(await isAppRunning())) return
    await new Promise(r => setTimeout(r, 500))
  }
}

/// Windows mirror of the mac install below: pin the release to the CLI's own version, fall back
/// to the newest windows-v* release, verify the sha256 before anything executes the file, hand
/// the .msi to msiexec, then launch what it installed. Two routes come before that one: an .msi
/// the desktop app already staged and named with `--staged-msi` (assertStagedMsiPath), and a
/// Microsoft Store install of the desktop app, which carries the tray app inside its own
/// package (findStoreMenubar).
const WINDOWS_UNINSTALL_KEYS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
]
/// 3010 is "installed, reboot to finish"; 1602 is the user closing the UAC/installer prompt.
const MSI_EXIT_REBOOT_REQUIRED = 3010
const MSI_EXIT_USER_CANCEL = 1602
/// How long a running tray app gets to act on a `--quit` before it is closed outright. The same
/// window the desktop app allows for the same request (app/electron/menubar.ts, QUIT_SETTLE_MS).
const TRAY_QUIT_TIMEOUT_MS = 4000
const TRAY_QUIT_POLL_MS = 200
/// tasklist and taskkill answer immediately on a healthy machine; the bound is only there so a
/// wedged one cannot hold up the install for ever.
const TRAY_PROCESS_TIMEOUT_MS = 5000

export type WindowsInstallHooks = {
  fetchOptions?: AssetFetchOptions
  apiFetch?: ReleaseApiFetch
  runInstaller?: (exe: string, args: string[]) => Promise<number>
  queryRegistry?: () => Promise<string>
  /// The Store package's InstallLocation, or an empty string when the desktop app is not
  /// installed from the Store. Replaced in tests so nothing spawns PowerShell.
  queryStorePackage?: () => Promise<string>
  /// Whether a tray process is running right now. Replaced in tests so nothing spawns tasklist.
  isTrayRunning?: () => Promise<boolean>
  /// Close a tray process that would not quit when asked. Replaced in tests so nothing spawns
  /// taskkill.
  killTray?: () => Promise<void>
  /// The wait between two `isTrayRunning` polls, so tests need not spend the real one.
  sleep?: (ms: number) => Promise<void>
  launch?: (exePath: string, args?: string[]) => void
  log?: (message: string) => void
  stagingDir?: string
  env?: NodeJS.ProcessEnv
}

export type InstalledWindowsMenubar = {
  version: string
  exePath: string
  /// `MsiExec.exe /X{product-code}` as Windows Installer wrote it. The desktop app's own
  /// uninstaller has no other handle on the product it installed, so the bundled install
  /// records this in the marker file.
  uninstallString?: string
}

// The bundled .msi route ---------------------------------------------------------------------

/// How the Electron desktop app used to name the `CodeBurn.Menubar_<version>_x64_en-US.msi` it
/// ships in its own resources. It is no longer a route, only a refusal: an environment variable
/// is settable by anything that can start this process, and this one decided which file msiexec
/// would run, with the `.sha256` it is checked against written by whoever wrote the file. The
/// desktop app passes `--staged-msi <path>` instead, which is validated (assertStagedMsiPath).
export const BUNDLED_MSI_ENV = 'CODEBURN_MENUBAR_MSI'
/// The flag that replaced it.
export const STAGED_MSI_FLAG = '--staged-msi'
/// One line on stdout so the caller that staged the MSI learns what happened without reading
/// prose. Everything else the install prints stays human-readable. Unchanged by the move from
/// the environment variable to the flag: it is the desktop app's only parse of this command.
export const BUNDLED_RESULT_PREFIX = 'CODEBURN_MENUBAR_RESULT '

/// Where a packaged desktop app keeps the tray installer, relative to the directory holding
/// `CodeBurn.exe`: electron-builder puts extraResources under `resources`, and the tray build
/// is staged into `resources\menubar` (app/electron/menubar.ts, menubarResourcesDir).
export const STAGED_MSI_DIR_SEGMENTS = ['resources', 'menubar'] as const
/// The desktop app's own binary, which is what makes the directory above an installed CodeBurn
/// rather than a directory anyone happened to name `resources\menubar`.
export const DESKTOP_APP_EXE = 'CodeBurn.exe'

async function isRegularFile(path: string): Promise<boolean> {
  try {
    // lstat, not stat: a symbolic link standing in for any of these is a way to point a
    // validated shape at an unvalidated file.
    return (await lstat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * Decides whether a `--staged-msi` path may be handed to msiexec, and refuses if not.
 *
 * Whatever this returns is executed as the installing user, so the path has to prove it came
 * from an installed CodeBurn desktop app rather than from anyone who could put a file on this
 * machine and name it. It must be absolute, it must be the release asset by name, it must carry
 * the `.sha256` it will be checked against, and it must sit in the one place a packaged desktop
 * app stages it: `<app>\resources\menubar`, with `<app>\CodeBurn.exe` beside those. A path that
 * fails any of that is refused here, before anything runs it.
 *
 * The digest beside the file is not by itself a guarantee - the party that writes one writes the
 * other - which is why the location check, and not the checksum, is what this route trusts.
 */
export async function assertStagedMsiPath(msiPath: string): Promise<string> {
  const refuse = (reason: string): never => {
    throw new Error(`Refusing ${STAGED_MSI_FLAG} ${msiPath}: ${reason}`)
  }
  if (typeof msiPath !== 'string' || msiPath.trim() === '') refuse('no path was given.')
  if (!isAbsolute(msiPath)) refuse('the path is not absolute.')
  // Resolved before every other check, so `..` cannot walk out of the directory the checks
  // below are about to confirm.
  const resolved = resolve(msiPath)

  if (!parseWindowsMsiVersion(basename(resolved))) {
    refuse('the file is not named like a CodeBurn.Menubar_<version>_x64_en-US.msi release asset.')
  }

  const stagedDir = dirname(resolved)
  const [expectedParent, expectedDir] = STAGED_MSI_DIR_SEGMENTS
  // Case-insensitive because Windows paths are, so a `Resources\Menubar` from a caller that
  // built the path by hand is the same directory rather than a different one.
  const named = (dir: string, expected: string) => basename(dir).toLowerCase() === expected
  if (!named(stagedDir, expectedDir!) || !named(dirname(stagedDir), expectedParent!)) {
    refuse(`the file is not inside a ${STAGED_MSI_DIR_SEGMENTS.join('\\')} directory.`)
  }

  const appDir = dirname(dirname(stagedDir))
  if (!(await isRegularFile(join(appDir, DESKTOP_APP_EXE)))) {
    refuse(`there is no ${DESKTOP_APP_EXE} in ${appDir}, so this is not an installed CodeBurn desktop app.`)
  }
  if (!(await isRegularFile(resolved))) refuse('there is no regular file at that path.')
  if (!(await isRegularFile(`${resolved}.sha256`))) refuse('there is no .sha256 file beside it.')
  return resolved
}

export type BundledInstallAction = 'installed' | 'up-to-date' | 'kept-newer' | 'cancelled'

export type BundledInstallResult = {
  action: BundledInstallAction
  bundledVersion: string
  /// What the uninstall registry held before this run, or null when nothing was installed.
  previousVersion: string | null
  exePath: string
  uninstallString: string | null
  /// Who the marker file credits with the install: never this run when someone else got there
  /// first, so the desktop uninstaller only ever removes what the desktop app put there.
  installedBy: MenubarInstalledBy | null
}

export type MenubarInstalledBy = 'desktop' | 'manual'

export type MenubarInstallMarker = {
  installedBy: MenubarInstalledBy
  version: string
  uninstallString: string | null
  installedAt: string
}

/// Numeric dotted compare, shortest field wins nothing: 0.9.9 is older than 0.9.10, and a
/// missing or non-numeric field counts as 0 so an empty DisplayVersion reads as the oldest
/// thing there is rather than throwing.
export function compareMenubarVersions(a: string, b: string): number {
  const pa = a.trim().replace(/^v/, '').split('.')
  const pb = b.trim().replace(/^v/, '').split('.')
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number.parseInt(pa[i] ?? '0', 10) || 0
    const y = Number.parseInt(pb[i] ?? '0', 10) || 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/// `CodeBurn.Menubar_0.9.23_x64_en-US.msi` -> `0.9.23`. The staged file is the release asset
/// verbatim, so its name is the only version statement that cannot disagree with its contents.
export function parseWindowsMsiVersion(fileName: string): string | undefined {
  return /^CodeBurn\.Menubar_(.+)_x64_en-US\.msi$/.exec(fileName)?.[1]
}

/// Never downgrade: a menubar newer than the bundled one was put there by a `codeburn menubar`
/// install or a newer desktop build, and replacing it with what this build happens to carry
/// would take working features away.
export function decideBundledInstall(
  installedVersion: string | undefined,
  bundledVersion: string,
  force = false,
): Exclude<BundledInstallAction, 'cancelled'> {
  if (installedVersion === undefined) return 'installed'
  if (force) return 'installed'
  const order = compareMenubarVersions(installedVersion, bundledVersion)
  if (order > 0) return 'kept-newer'
  return order === 0 ? 'up-to-date' : 'installed'
}

/// Beside the tray app's own `status.json` and `update.json`, which is where anything about a
/// specific install of the menubar already lives.
export function menubarMarkerPath(env: NodeJS.ProcessEnv = process.env): string {
  const local = env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  return join(local, 'codeburn-menubar', 'installed-by.json')
}

export async function readMenubarMarker(env: NodeJS.ProcessEnv = process.env): Promise<MenubarInstallMarker | undefined> {
  try {
    const parsed = JSON.parse(await readFile(menubarMarkerPath(env), 'utf8')) as Partial<MenubarInstallMarker>
    if (parsed.installedBy !== 'desktop' && parsed.installedBy !== 'manual') return undefined
    return {
      installedBy: parsed.installedBy,
      version: typeof parsed.version === 'string' ? parsed.version : '',
      uninstallString: typeof parsed.uninstallString === 'string' ? parsed.uninstallString : null,
      installedAt: typeof parsed.installedAt === 'string' ? parsed.installedAt : '',
    }
  } catch {
    return undefined
  }
}

/// The marker answers one question for the desktop app's uninstaller: did this app put the
/// menubar here? Only a first install onto a machine that had none can say yes, and once a
/// marker exists its verdict is never rewritten - an upgrade refreshes the version and the
/// uninstall string, nothing else.
///
/// `fallback` is the verdict for a machine that has no marker yet, and it is the route that
/// knows it: the desktop route credits itself only when it found nothing already installed,
/// while a plain `codeburn menubar` is always 'manual'. Writing that 'manual' down is what
/// stops a later desktop install from having to guess: a registry read that comes back empty
/// because of a hive this process cannot see would otherwise read as "nothing was here", and
/// the desktop uninstaller would take the user's own tray app away with it.
async function writeMenubarMarker(
  installed: InstalledWindowsMenubar,
  fallback: MenubarInstalledBy,
  env: NodeJS.ProcessEnv,
): Promise<MenubarInstalledBy> {
  const existing = await readMenubarMarker(env)
  const installedBy: MenubarInstalledBy = existing?.installedBy ?? fallback
  const marker: MenubarInstallMarker = {
    installedBy,
    version: installed.version,
    uninstallString: installed.uninstallString ?? null,
    installedAt: new Date().toISOString(),
  }
  const path = menubarMarkerPath(env)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(marker, null, 2)}\n`)
  return installedBy
}

/// Install from a file another installer staged. No network, no release lookup, no launch: the
/// caller that staged the MSI owns the tray app's process, so starting it is its business. The
/// `--quit` this route may send is not a launch of that kind: a second process started with it
/// hands the argument to the running instance and exits, and nothing is sent when nothing is
/// running (stopRunningMenubar).
async function installStagedWindowsMenubar(
  msiPath: string,
  options: InstallOptions,
): Promise<InstallResult> {
  const hooks = options.windows ?? {}
  const log = hooks.log ?? console.log
  const env = hooks.env ?? process.env
  const queryRegistry = hooks.queryRegistry ?? (() => queryWindowsUninstallRegistry(env))

  const bundledVersion = parseWindowsMsiVersion(basename(msiPath))
  if (!bundledVersion) {
    throw new Error(`${msiPath} is not a CodeBurn.Menubar_<version>_x64_en-US.msi.`)
  }

  const before = parseInstalledWindowsMenubar(await queryRegistry())
  const decision = decideBundledInstall(before?.version, bundledVersion, options.force)

  const report = async (
    action: BundledInstallAction,
    installed: InstalledWindowsMenubar | undefined,
    installedBy: MenubarInstalledBy | null,
  ): Promise<InstallResult> => {
    const result: BundledInstallResult = {
      action,
      bundledVersion,
      previousVersion: before?.version ?? null,
      exePath: installed?.exePath ?? '',
      uninstallString: installed?.uninstallString ?? null,
      installedBy,
    }
    log(`${BUNDLED_RESULT_PREFIX}${JSON.stringify(result)}`)
    return { installedPath: result.exePath, launched: false }
  }

  if (decision !== 'installed') {
    log(decision === 'kept-newer'
      ? `CodeBurn Menubar ${before!.version} is newer than the bundled ${bundledVersion}; leaving it alone.`
      : `CodeBurn Menubar ${bundledVersion} is already installed.`)
    const installedBy = before ? await writeMenubarMarker(before, 'manual', env) : null
    return report(decision, before, installedBy)
  }

  log('Verifying checksum...')
  await verifyStagedChecksum(msiPath)
  // After the checksum, so a file that is not going to be installed never costs anyone their
  // running tray app.
  await stopRunningMenubar(before?.exePath, hooks, log, env)
  log('Installing...')
  const msiexec = resolveSystem32Path('msiexec.exe', env)
  const exitCode = await (hooks.runInstaller ?? runMsiexec)(msiexec, ['/i', msiPath, '/passive', '/norestart'])
  if (exitCode === MSI_EXIT_USER_CANCEL) {
    log('Installation was cancelled; nothing was installed.')
    return report('cancelled', undefined, null)
  }
  if (exitCode !== 0 && exitCode !== MSI_EXIT_REBOOT_REQUIRED) {
    throw new Error(`msiexec exited with ${exitCode} while installing ${basename(msiPath)}.`)
  }
  if (exitCode === MSI_EXIT_REBOOT_REQUIRED) log('Windows wants a restart to finish the install.')

  const installed = parseInstalledWindowsMenubar(await queryRegistry())
  if (!installed) {
    throw new Error('CodeBurn Menubar installed, but it was not found in the uninstall registry.')
  }
  const installedBy = await writeMenubarMarker(installed, before === undefined ? 'desktop' : 'manual', env)
  log(`Installed CodeBurn Menubar ${installed.version}.`)
  return report('installed', installed, installedBy)
}

/// Windows' `CreateProcess` searches the current directory before `PATH`, so spawning `msiexec`
/// or `reg` by bare name lets anything dropped next to the CLI impersonate a system tool. Same
/// rule the tray app follows (windows/src-tauri/src/cli.rs: system32_path).
export function resolveSystem32Path(exe: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot
  const base = root && /^[a-zA-Z]:[\\/]/.test(root) ? root.replace(/[\\/]+$/, '') : 'C:\\Windows'
  return `${base}\\System32\\${exe}`
}

/// Reads `reg query ... /s` output, which prints one blank-line separated block per subkey.
export function parseInstalledWindowsMenubar(regOutput: string): InstalledWindowsMenubar | undefined {
  for (const block of regOutput.split(/\r?\n\s*\r?\n/)) {
    const values = new Map<string, string>()
    for (const line of block.split(/\r?\n/)) {
      const match = /^\s+(.+?)\s{4}REG_\w+\s{4}(.*)$/.exec(line)
      if (match) values.set(match[1]!.trim(), match[2]!.trim())
    }
    if (values.get('DisplayName') !== WINDOWS_PRODUCT_NAME) continue
    // DisplayIcon is `<exe>[,<index>]` and names the installed binary outright, so where an
    // installer wrote one it is the answer rather than a guess. Tauri's MSI leaves it empty,
    // so the path that actually gets used is InstallLocation joined with the binary name.
    const icon = values.get('DisplayIcon')?.split(',')[0]?.trim()
    const location = values.get('InstallLocation')
    const exePath = icon
      || (location ? `${location.replace(/[\\/]+$/, '')}\\${WINDOWS_BINARY_NAME}` : undefined)
    if (!exePath) continue
    const uninstallString = values.get('UninstallString')
    return {
      version: values.get('DisplayVersion') ?? '',
      exePath,
      ...(uninstallString ? { uninstallString } : {}),
    }
  }
  return undefined
}

// The Microsoft Store route -------------------------------------------------------------------

/// The identity the Store build of the desktop app is published under (app/package.json,
/// build.appx.identityName). Mirrored rather than imported: this module compiles with rootDir
/// src/ and the published package ships only dist/, so app/ is reachable neither at build time
/// nor at runtime. tests/menubar-installer-windows.test.ts fails if the two ever drift apart.
export const STORE_IDENTITY_NAME = 'Codeburn.CodeBurn'
/// Where the tray app sits inside that package: electron-builder puts extraResources under
/// `app\resources`, and app/build/appx-extensions.xml names the same path in its startup task.
const STORE_TRAY_SEGMENTS = ['app', 'resources', 'menubar', WINDOWS_BINARY_NAME]
/// Get-AppxPackage on a warm machine answers well inside a second, but a cold PowerShell behind
/// a slow disk or a policy-loaded profile can take much longer, and `codeburn menubar` is
/// interactive. Past this the answer is "no Store install" and the .msi route takes over.
const STORE_QUERY_TIMEOUT_MS = 5000

export type StoreMenubar = { installLocation: string; exePath: string }

export type WindowsMenubarSourceDecision = {
  source: 'store' | 'msi'
  storePresent: boolean
  msiPresent: boolean
}

/// Which copy of the tray app this run should use. The Store copy wins whenever it is there: it
/// is already installed and already registered for launch at login, so installing the .msi
/// beside it would leave the machine running two tray apps with two autostart entries. Nothing
/// is ever uninstalled here, and --force is the one way to ask for the .msi anyway.
export function decideWindowsMenubarSource(
  storePresent: boolean,
  msiPresent: boolean,
  force = false,
): WindowsMenubarSourceDecision {
  return { source: storePresent && !force ? 'store' : 'msi', storePresent, msiPresent }
}

/// Find the tray app inside an installed Store package of the desktop app.
///
/// The uninstall registry cannot answer this, which is the whole reason this exists: a Store
/// (AppX) install writes no uninstall key, so a machine that already carries the tray app inside
/// the packaged desktop app reads as empty to parseInstalledWindowsMenubar. Believing that would
/// download the .msi and stand a second copy in Program Files, with a second launch-at-login
/// entry, beside the one the package already provides.
///
/// `queryStorePackage` returns the package's InstallLocation, or an empty string when there is
/// none. Every way this can come up short - no PowerShell, blocked by policy, too slow, a
/// package whose exe is not where it should be - means "not a Store install".
export async function findStoreMenubar(
  queryStorePackage: () => Promise<string>,
): Promise<StoreMenubar | undefined> {
  let output: string
  try {
    output = await queryStorePackage()
  } catch {
    return undefined
  }
  const installLocation = output
    .split(/\r?\n/)
    .map(line => line.trim().replace(/^"(.*)"$/, '$1'))
    .find(line => line.length > 0)
  if (!installLocation) return undefined
  const exePath = join(installLocation, ...STORE_TRAY_SEGMENTS)
  return (await exists(exePath)) ? { installLocation, exePath } : undefined
}

async function queryStoreInstallLocation(env: NodeJS.ProcessEnv): Promise<string> {
  // Same rule msiexec and reg follow above: an absolute System32 path, never a bare name.
  const powershell = resolveSystem32Path('WindowsPowerShell\\v1.0\\powershell.exe', env)
  return captureBounded(powershell, [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Get-AppxPackage -Name ${STORE_IDENTITY_NAME} | Select-Object -First 1 -ExpandProperty InstallLocation`,
  ], STORE_QUERY_TIMEOUT_MS)
}

/// captureCommand with a wall-clock limit and no rejection: a missing binary, a non-zero exit
/// and a hang all mean the same thing to the one caller, so they all come back empty.
async function captureBounded(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let settled = false
    let out = ''
    const finish = (value: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    const timer = setTimeout(() => {
      proc.kill()
      finish('')
    }, timeoutMs)
    proc.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
    proc.on('error', () => finish(''))
    proc.on('close', code => finish(code === 0 ? out : ''))
  })
}

async function queryWindowsUninstallRegistry(env: NodeJS.ProcessEnv): Promise<string> {
  const reg = resolveSystem32Path('reg.exe', env)
  // reg exits non-zero for a hive the machine does not have; an empty block is the right answer.
  const outputs = await Promise.all(
    WINDOWS_UNINSTALL_KEYS.map(key => captureCommand(reg, ['query', key, '/s']).catch(() => '')),
  )
  return outputs.join('\n\n')
}

async function runMsiexec(exe: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn(exe, args, { stdio: 'inherit' })
    proc.on('error', reject)
    proc.on('close', code => resolve(code ?? 1))
  })
}

function launchWindowsApp(exePath: string, args: string[] = []): void {
  const proc = spawn(exePath, args, { detached: true, stdio: 'ignore' })
  proc.on('error', err => console.error(`Could not launch ${exePath}: ${err.message}`))
  proc.unref()
}

async function trayHasProcess(env: NodeJS.ProcessEnv): Promise<boolean> {
  const tasklist = resolveSystem32Path('tasklist.exe', env)
  // tasklist prints a "no tasks are running" notice rather than failing, and captureBounded
  // turns everything that can go wrong into an empty string, so both read as "not running".
  const output = await captureBounded(
    tasklist,
    ['/FI', `IMAGENAME eq ${WINDOWS_BINARY_NAME}`, '/NH'],
    TRAY_PROCESS_TIMEOUT_MS,
  )
  return output.toLowerCase().includes(WINDOWS_BINARY_NAME)
}

async function killTrayProcess(env: NodeJS.ProcessEnv): Promise<void> {
  const taskkill = resolveSystem32Path('taskkill.exe', env)
  await captureBounded(taskkill, ['/IM', WINDOWS_BINARY_NAME, '/F'], TRAY_PROCESS_TIMEOUT_MS)
}

/// Stop a running tray app before msiexec is allowed near the files it is running from.
///
/// Windows Installer does not fail on a file that is in use: it installs the new one and defers
/// the swap to the next reboot, so an upgrade over a running tray leaves the old binary running
/// and the launch that follows hands its arguments to that old process through the tray app's
/// single-instance window (windows/src-tauri/src/lib.rs). The user is then told they are on the
/// new version while the old one is still what is running.
///
/// So the tray app is asked to stop through that same single-instance protocol, which is how the
/// desktop app asks (app/electron/menubar.ts): a second launch of the installed exe with
/// `--quit` reaches the running instance. taskkill is the fallback for a tray that does not
/// answer within the window, and a machine with no tray running skips all of it.
async function stopRunningMenubar(
  exePath: string | undefined,
  hooks: WindowsInstallHooks,
  log: (message: string) => void,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const isRunning = hooks.isTrayRunning ?? (() => trayHasProcess(env))
  if (!(await isRunning())) return

  const launch = hooks.launch ?? launchWindowsApp
  const sleep = hooks.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))

  if (exePath) {
    log('CodeBurn Menubar is running; asking it to quit before installing...')
    launch(exePath, ['--quit'])
    // Counted polls rather than a wall clock, so the wait is the same length however long the
    // supplied sleep actually takes.
    for (let attempt = 0; attempt < Math.ceil(TRAY_QUIT_TIMEOUT_MS / TRAY_QUIT_POLL_MS); attempt++) {
      await sleep(TRAY_QUIT_POLL_MS)
      if (!(await isRunning())) {
        log('CodeBurn Menubar stopped.')
        return
      }
    }
  }

  log('CodeBurn Menubar did not stop on its own; closing it now.')
  await (hooks.killTray ?? (() => killTrayProcess(env)))()
  if (await isRunning()) {
    log('CodeBurn Menubar is still running; Windows will finish the upgrade after the next restart.')
  }
}

async function stageWindowsInstaller(
  assets: ResolvedAssets,
  stagingDir: string,
  hooks: WindowsInstallHooks,
  log: (message: string) => void,
): Promise<string> {
  const { zip: msi, checksum } = assets
  const msiPath = join(stagingDir, msi.name)
  log(`Downloading ${msi.name}...`)
  await downloadToFile(msi.browser_download_url, msiPath, hooks.fetchOptions)
  log('Verifying checksum...')
  await verifyChecksum(msiPath, checksum.browser_download_url, hooks.fetchOptions)
  return msiPath
}

async function installWindowsMenubarApp(options: InstallOptions): Promise<InstallResult> {
  const hooks = options.windows ?? {}
  const log = hooks.log ?? console.log
  const env = hooks.env ?? process.env
  const queryRegistry = hooks.queryRegistry ?? (() => queryWindowsUninstallRegistry(env))
  const queryStorePackage = hooks.queryStorePackage ?? (() => queryStoreInstallLocation(env))
  const launch = hooks.launch ?? launchWindowsApp
  const cliVersion = options.cliVersion ? normalizeCliVersion(options.cliVersion) : ''

  // Refused rather than honoured, and before anything else, so a machine carrying the old
  // variable is told why instead of quietly taking the safe route and looking like it worked.
  if (env[BUNDLED_MSI_ENV]) {
    throw new Error(
      `${BUNDLED_MSI_ENV} is no longer honoured: an environment variable chose which installer ran, `
      + `and the checksum it was verified against was written by whoever wrote that installer. `
      + `Pass ${STAGED_MSI_FLAG} <absolute path> instead; it is accepted only for a release-named .msi `
      + `staged in an installed CodeBurn desktop app's ${STAGED_MSI_DIR_SEGMENTS.join('\\')} directory.`,
    )
  }

  // An MSI already on disk short-circuits the whole release lookup: the desktop app ships the
  // matching build and points at it rather than sending every install of the desktop app to
  // GitHub for a file it already has. This stays ahead of the Store lookup because it is an
  // explicit instruction from whoever staged the file, and the Store build never passes it.
  if (options.stagedMsi) {
    return installStagedWindowsMenubar(await assertStagedMsiPath(options.stagedMsi), options)
  }

  // The Store package is looked for before the uninstall registry, because it is the one install
  // the registry cannot see at all (findStoreMenubar).
  const store = await findStoreMenubar(queryStorePackage)
  const installed = parseInstalledWindowsMenubar(await queryRegistry())
  const decision = decideWindowsMenubarSource(store !== undefined, installed !== undefined, options.force)

  if (store && decision.source === 'store') {
    // No ownership marker on this route: nothing was installed, the tray app lives inside the
    // Store package and goes away with it, and there is no MSI product code for the desktop
    // app's uninstaller to act on even if it wanted to (app/build/installer.nsh).
    log('CodeBurn Menubar comes from the Microsoft Store CodeBurn desktop app; nothing to download.')
    if (installed) {
      log(`A separate .msi install is also present at ${installed.exePath}; leaving it in place and using the Store copy.`)
    }
    launch(store.exePath)
    log('Launched CodeBurn Menubar.')
    return { installedPath: store.exePath, launched: true }
  }
  if (decision.storePresent) {
    log('CodeBurn Menubar comes from the Microsoft Store CodeBurn desktop app; --force installs the .msi as well and leaves the Store copy in place.')
  }

  if (installed && !options.force && (!cliVersion || installed.version === cliVersion)) {
    // Nothing was installed, but this is still the route that owns a hand-installed tray app,
    // and a machine that was set up before the marker existed has none to show for it.
    await writeMenubarMarker(installed, 'manual', env)
    launch(installed.exePath)
    log('Launched CodeBurn Menubar.')
    return { installedPath: installed.exePath, launched: true }
  }

  let assets: ResolvedAssets
  if (cliVersion) {
    log(`Resolving CodeBurn Menubar v${cliVersion}...`)
    assets = resolveVersionedMenubarReleaseAssets(cliVersion, WINDOWS_RELEASE)
  } else {
    log('Looking up the latest CodeBurn Menubar release...')
    assets = await fetchLatestReleaseAssets(WINDOWS_RELEASE, hooks.apiFetch)
  }

  const stagingDir = hooks.stagingDir ?? await (async () => {
    await mkdir(getCodeburnCacheDir(), { recursive: true })
    return mkdtemp(join(getCodeburnCacheDir(), 'menubar-'))
  })()
  try {
    let msiPath: string
    try {
      msiPath = await stageWindowsInstaller(assets, stagingDir, hooks, log)
    } catch (err) {
      if (!cliVersion || !isMissingDirectAssetError(err)) throw err
      log(`CodeBurn Menubar v${cliVersion} assets were not found. Looking up the latest CodeBurn Menubar release...`)
      assets = await fetchLatestReleaseAssets(WINDOWS_RELEASE, hooks.apiFetch)
      msiPath = await stageWindowsInstaller(assets, stagingDir, hooks, log)
    }

    // The .msi is downloaded and verified by now, so nothing is stopped for an install that was
    // never going to happen.
    await stopRunningMenubar(installed?.exePath, hooks, log, env)
    log('Installing...')
    const msiexec = resolveSystem32Path('msiexec.exe', env)
    const exitCode = await (hooks.runInstaller ?? runMsiexec)(msiexec, ['/i', msiPath, '/passive', '/norestart'])
    if (exitCode === MSI_EXIT_USER_CANCEL) {
      log('Installation was cancelled; nothing was installed.')
      return { installedPath: '', launched: false }
    }
    if (exitCode !== 0 && exitCode !== MSI_EXIT_REBOOT_REQUIRED) {
      throw new Error(`msiexec exited with ${exitCode} while installing ${assets.zip.name}.`)
    }
    if (exitCode === MSI_EXIT_REBOOT_REQUIRED) log('Windows wants a restart to finish the install.')

    const nowInstalled = parseInstalledWindowsMenubar(await queryRegistry())
    if (!nowInstalled) {
      throw new Error('CodeBurn Menubar installed, but it was not found in the uninstall registry; start it from the Start menu.')
    }
    // A `codeburn menubar` install is the user's own, so the marker says 'manual'. An install
    // the desktop app already credited to itself keeps that verdict: writeMenubarMarker never
    // rewrites one, so upgrading a desktop-installed tray from the CLI does not orphan it.
    await writeMenubarMarker(nowInstalled, 'manual', env)
    launch(nowInstalled.exePath)
    log('Launched CodeBurn Menubar.')
    return { installedPath: nowInstalled.exePath, launched: true }
  } finally {
    if (!hooks.stagingDir) await rm(stagingDir, { recursive: true, force: true })
  }
}

export async function installMenubarApp(options: InstallOptions = {}): Promise<InstallResult> {
  if ((options.platform ?? platform()) === 'win32') return installWindowsMenubarApp(options)
  // There is no staged .msi anywhere but Windows, so a path here is a caller that thinks it is
  // on another platform. Say so rather than ignoring the argument and installing something else.
  if (options.stagedMsi) throw new Error(`${STAGED_MSI_FLAG} is a Windows option; this is ${options.platform ?? platform()}.`)
  await ensureSupportedPlatform()
  await persistCodeburnPath()

  const appsDir = userApplicationsDir()
  const targetPath = join(appsDir, APP_BUNDLE_NAME)
  const alreadyInstalled = await exists(targetPath)

  if (alreadyInstalled && !options.force) {
    if (!(await isAppRunning())) {
      await runCommand('/usr/bin/open', [targetPath])
    }
    return { installedPath: targetPath, launched: true }
  }

  const cliVersion = options.cliVersion ? normalizeCliVersion(options.cliVersion) : ''
  let assets: ResolvedAssets
  if (cliVersion) {
    console.log(`Resolving CodeBurn Menubar v${cliVersion}...`)
    assets = resolveVersionedMenubarReleaseAssets(cliVersion)
  } else {
    console.log('Looking up the latest CodeBurn Menubar release...')
    assets = await fetchLatestReleaseAssets()
  }

  const stagingDir = await mkdtemp(join(tmpdir(), 'codeburn-menubar-'))
  try {
    let unpackedApp: string
    try {
      unpackedApp = await stageMenubarApp(assets, stagingDir)
    } catch (err) {
      if (!cliVersion || !isMissingDirectAssetError(err)) throw err
      console.log(`CodeBurn Menubar v${cliVersion} assets were not found. Looking up the latest CodeBurn Menubar release...`)
      assets = await fetchLatestReleaseAssets()
      unpackedApp = await stageMenubarApp(assets, stagingDir)
    }

    await mkdir(appsDir, { recursive: true })
    if (alreadyInstalled) {
      // Kill the running copy before replacing its bundle so `mv` can proceed cleanly and the
      // user ends up on the new version.
      await killRunningApp()
      await rm(targetPath, { recursive: true, force: true })
    }
    await rename(unpackedApp, targetPath)

    console.log('Launching CodeBurn Menubar...')
    await runCommand('/usr/bin/open', [targetPath])
    return { installedPath: targetPath, launched: true }
  } finally {
    await rm(stagingDir, { recursive: true, force: true })
  }
}

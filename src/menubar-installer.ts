import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
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
const RECOVERY_BUNDLE_ID_PREFIX = `${EXPECTED_BUNDLE_ID}.recovery.`
const RECOVERY_BUNDLE_ID_PATTERN = /^org\.agentseal\.codeburn-menubar\.recovery\.[0-9a-f]{16}$/
const STATUS_ITEM_AUTOSAVE_NAME = 'CodeBurnMenubar.MainStatusItem'
const LOGIN_ITEM_MAINTENANCE_VERSION_KEY = 'CodeBurnLoginItemMaintenanceVersion'
const LOGIN_ITEM_STATUS_ARGUMENT = '--codeburn-login-item-status'
const LOGIN_ITEM_UNREGISTER_ARGUMENT = '--codeburn-unregister-login-item'
const LOGIN_ITEM_REGISTER_ARGUMENT = '--codeburn-register-login-item'
const LOGIN_ITEM_MAINTENANCE_TIMEOUT_MS = 5_000
const VERSIONED_ASSET_PATTERN = /^CodeBurnMenubar-v.+\.zip$/
const APP_PROCESS_NAME = 'CodeBurnMenubar'
const SUPPORTED_OS = 'darwin'
/// The Windows tray app (windows/) ships as an .msi under its own `windows-v*` tag. GitHub
/// rewrites the spaces in the bundle name to dots when it stores the asset, so both the asset
/// name and its download URL carry `CodeBurn.Menubar_...`.
const WINDOWS_PRODUCT_NAME = 'CodeBurn Menubar'
const WINDOWS_ASSET_PATTERN = /^CodeBurn\.Menubar_.+_x64_en-US\.msi$/
const MIN_MACOS_MAJOR = 14
const PERSISTED_CLI_PATH = join(homedir(), 'Library', 'Application Support', 'CodeBurn', 'codeburn-cli-path.v1')
const PERSISTED_MENUBAR_BUNDLE_ID = join(
  homedir(),
  'Library',
  'Application Support',
  'CodeBurn',
  'menubar-bundle-id.v1',
)
const PERSISTENT_CLI_REQUIRED_MESSAGE =
  'The menubar app needs a persistent codeburn command. Install CodeBurn globally first: npm install -g codeburn'

export type InstallResult = { installedPath: string; launched: boolean }

function isMenubarPlacementRecoveryBundleId(bundleID: string): boolean {
  return RECOVERY_BUNDLE_ID_PATTERN.test(bundleID)
}

export function isSupportedMenubarBundleId(bundleID: string): boolean {
  return bundleID === EXPECTED_BUNDLE_ID || isMenubarPlacementRecoveryBundleId(bundleID)
}

export function isAdHocMenubarSignatureDetails(details: string): boolean {
  return /^Signature=adhoc$/m.test(details) && /^TeamIdentifier=not set$/m.test(details)
}

export function isMissingDefaultsDomainError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /Domain \(?[^\n]+\)? (?:does not exist|not found)/i.test(message) ||
    /domain\/default pair of \([^\n]+\) does not exist/i.test(message)
}

export function createMenubarPlacementRecoveryBundleId(suffix = randomBytes(8).toString('hex')): string {
  if (!/^[0-9a-f]{16}$/.test(suffix)) {
    throw new Error('Menubar placement recovery id suffix must be 16 lowercase hex characters.')
  }
  return `${RECOVERY_BUNDLE_ID_PREFIX}${suffix}`
}

export function selectMenubarBundleId(options: {
  repairPlacement?: boolean
  resetPlacement?: boolean
  persistedBundleId?: string
  recoverySuffix?: string
} = {}): string {
  if (options.repairPlacement && options.resetPlacement) {
    throw new Error('--repair-placement and --reset-placement cannot be used together.')
  }
  if (options.repairPlacement) {
    return createMenubarPlacementRecoveryBundleId(options.recoverySuffix)
  }
  if (options.resetPlacement) return EXPECTED_BUNDLE_ID
  if (options.persistedBundleId && isMenubarPlacementRecoveryBundleId(options.persistedBundleId)) {
    return options.persistedBundleId
  }
  return EXPECTED_BUNDLE_ID
}

export function resolveActiveMenubarBundleId(options: {
  installedBundleId?: string
  persistedBundleId?: string
}): string {
  if (options.installedBundleId !== undefined) {
    if (!isSupportedMenubarBundleId(options.installedBundleId)) {
      throw new Error(`Refusing unsupported installed menubar bundle id ${options.installedBundleId}.`)
    }
    return options.installedBundleId
  }
  if (options.persistedBundleId && isMenubarPlacementRecoveryBundleId(options.persistedBundleId)) {
    return options.persistedBundleId
  }
  return EXPECTED_BUNDLE_ID
}

export type ReleaseAsset = { name: string; browser_download_url: string }
export type ReleaseResponse = { tag_name: string; assets: ReleaseAsset[] }
/// `zip` is the platform's primary asset: the mac bundle zip, or the Windows .msi.
export type ResolvedAssets = { release: ReleaseResponse; zip: ReleaseAsset; checksum: ReleaseAsset }
export type InstallOptions = {
  force?: boolean
  repairPlacement?: boolean
  resetPlacement?: boolean
  cliVersion?: string
  platform?: string
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
/// back — `codeburn menubar` is interactive, so failing fast still matters.
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
/// cannot clear inside a 1.5s backoff window — hammering it would only spend more of the budget,
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

export async function verifyChecksum(
  archivePath: string,
  checksumUrl: string,
  options: AssetFetchOptions = {},
): Promise<void> {
  // Only the transport is retried. The digest comparison below is deliberately outside the retry:
  // an integrity failure must abort on the first look and never re-download.
  const text = await fetchReleaseAsset(checksumUrl, 'Checksum download', response => response.text(), options)
  const expected = text.trim().split(/\s+/)[0]!.toLowerCase()
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

async function captureCommandWithTimeout(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback()
    }
    const timer = setTimeout(() => {
      proc.kill('SIGTERM')
      const forceKill = setTimeout(() => proc.kill('SIGKILL'), 250)
      forceKill.unref()
      finish(() => reject(new Error(`${command} timed out after ${timeoutMs}ms`)))
    }, timeoutMs)
    timer.unref()
    proc.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
    proc.stderr.on('data', (chunk: Buffer) => { err += chunk.toString() })
    proc.on('error', error => finish(() => reject(error)))
    proc.on('close', code => finish(() => {
      if (code === 0) resolve(out.trim())
      else reject(new Error(`${command} exited with status ${code}${err ? `: ${err.trim()}` : ''}`))
    }))
  })
}

async function captureCommandStreams(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve({ stdout: stdout.trim(), stderr: stderr.trim() })
      else reject(new Error(`${command} exited with status ${code}${stderr ? `: ${stderr.trim()}` : ''}`))
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

export async function reidentifyMenubarBundleForPlacementRecovery(
  appPath: string,
  bundleID: string,
): Promise<void> {
  if (!isMenubarPlacementRecoveryBundleId(bundleID)) {
    throw new Error(`Refusing unsupported recovery bundle id ${bundleID}.`)
  }

  const signature = await captureCommandStreams('/usr/bin/codesign', [
    '-dvvv',
    '--verbose=4',
    appPath,
  ])
  const signatureDetails = `${signature.stdout}\n${signature.stderr}`
  if (!isAdHocMenubarSignatureDetails(signatureDetails)) {
    throw new Error(
      'This CodeBurn Menubar build is Developer-ID signed or notarized and cannot be safely ' +
      're-identified locally without invalidating its signature. Placement repair is unavailable ' +
      'for this artifact; use `--reset-placement` to keep the official identity.'
    )
  }

  const infoPlist = join(appPath, 'Contents', 'Info.plist')
  await runCommand('/usr/libexec/PlistBuddy', [
    '-c',
    `Set :CFBundleIdentifier ${bundleID}`,
    infoPlist,
  ])
  // The official bundle has already passed checksum, identity, and signature
  // verification in stageMenubarApp. Changing Info.plist invalidates that
  // signature, so apply a local ad-hoc signature and verify the resulting
  // bundle before it can replace the installed copy.
  await runCommand('/usr/bin/codesign', [
    '--force',
    '--sign',
    '-',
    '--preserve-metadata=entitlements,flags,runtime',
    '--timestamp=none',
    '--deep',
    appPath,
  ])
  const writtenBundleID = await captureCommand('/usr/libexec/PlistBuddy', [
    '-c',
    'Print :CFBundleIdentifier',
    infoPlist,
  ])
  if (writtenBundleID !== bundleID) {
    throw new Error(`Menubar placement recovery wrote ${writtenBundleID}; expected ${bundleID}.`)
  }
  await runCommand('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath])
  await runCommand('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', appPath]).catch(() => {})
}

export async function migrateMenubarPreferencesForPlacementRecovery(
  sourceBundleID: string,
  targetBundleID: string,
  stagingDir: string,
): Promise<void> {
  const migration = await prepareMenubarPreferenceMigration(
    sourceBundleID,
    targetBundleID,
    stagingDir,
  )
  await migration.apply()
  await migration.commit()
}

export type MenubarPreferenceMigration = {
  apply: () => Promise<void>
  rollback: () => Promise<void>
  commit: () => Promise<void>
}

async function readPreferenceKeysFromPlist(plistPath: string): Promise<string[]> {
  const json = await captureCommand('/usr/bin/plutil', [
    '-convert',
    'json',
    '-o',
    '-',
    plistPath,
  ])
  const value: unknown = JSON.parse(json)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Preference export ${plistPath} was not a dictionary.`)
  }
  return Object.keys(value)
}

export async function prepareMenubarPreferenceMigration(
  sourceBundleID: string,
  targetBundleID: string,
  stagingDir: string,
  options: { preserveLoginDisable?: boolean } = {},
): Promise<MenubarPreferenceMigration> {
  if (!isSupportedMenubarBundleId(sourceBundleID) || !isSupportedMenubarBundleId(targetBundleID)) {
    throw new Error('Refusing to migrate preferences for an unsupported menubar bundle id.')
  }
  if (sourceBundleID === targetBundleID) {
    return {
      apply: async () => {},
      rollback: async () => {},
      commit: async () => {},
    }
  }

  const sourcePreferencesPath = join(stagingDir, 'menubar-preferences-source.plist')
  const targetPreferencesPath = join(stagingDir, 'menubar-preferences-target.plist')
  let hasSourcePreferences = false
  let hadTargetPreferences = false
  let sourcePreferenceKeys: string[] = []
  let targetPreferenceKeys: string[] = []
  let applied = false

  try {
    const exported = await captureCommand('/usr/bin/defaults', ['export', sourceBundleID, '-'])
    await writeFile(sourcePreferencesPath, `${exported}\n`, { mode: 0o600 })
    await chmod(sourcePreferencesPath, 0o600)
    sourcePreferenceKeys = await readPreferenceKeysFromPlist(sourcePreferencesPath)
    // `defaults export` can emit an empty dictionary with status 0 for a
    // nonexistent domain. Treat that as no source rather than importing an
    // empty plist over an existing target domain.
    hasSourcePreferences = sourcePreferenceKeys.length > 0
  } catch (error) {
    // A first install can have no source preference domain yet.
    if (!isMissingDefaultsDomainError(error)) throw error
  }

  try {
    const exported = await captureCommand('/usr/bin/defaults', ['export', targetBundleID, '-'])
    await writeFile(targetPreferencesPath, `${exported}\n`, { mode: 0o600 })
    await chmod(targetPreferencesPath, 0o600)
    targetPreferenceKeys = await readPreferenceKeysFromPlist(targetPreferencesPath)
    hadTargetPreferences = targetPreferenceKeys.length > 0
  } catch (error) {
    // A fresh recovery identity intentionally has no target domain.
    if (!isMissingDefaultsDomainError(error)) throw error
  }

  return {
    apply: async () => {
      if (applied) return
      if (hasSourcePreferences) {
        await runCommand('/usr/bin/defaults', ['import', targetBundleID, sourcePreferencesPath])
      }
      applied = true

      // Preserve product settings, never any AppKit status-item placement
      // state. Older builds had no autosaveName, so strip every legacy
      // NSStatusItem key as well as the documented stable-name keys.
      const importedKeys = hasSourcePreferences ? sourcePreferenceKeys : targetPreferenceKeys
      const keysToDelete = new Set([
        `NSStatusItem Preferred Position ${STATUS_ITEM_AUTOSAVE_NAME}`,
        `NSStatusItem Visible ${STATUS_ITEM_AUTOSAVE_NAME}`,
        // Registration history belongs to the bundle identity. Excluding it
        // lets the new identity register exactly once while the source
        // identity's marker still preserves a user's later disable choice.
        'codeburn.loginItemRegistered',
        ...importedKeys.filter(key => key.startsWith('NSStatusItem ')),
      ])
      for (const key of keysToDelete) {
        try {
          await captureCommand('/usr/bin/defaults', ['delete', targetBundleID, key])
        } catch (error) {
          if (!isMissingDefaultsDomainError(error)) throw error
        }
      }
      if (options.preserveLoginDisable) {
        await runCommand('/usr/bin/defaults', [
          'write', targetBundleID, 'codeburn.loginItemRegistered', '-bool', 'true',
        ])
      }
    },
    rollback: async () => {
      if (!applied) return
      if (hadTargetPreferences) {
        await runCommand('/usr/bin/defaults', ['import', targetBundleID, targetPreferencesPath])
      } else {
        try {
          await captureCommand('/usr/bin/defaults', ['delete', targetBundleID])
        } catch (error) {
          if (!isMissingDefaultsDomainError(error)) throw error
        }
      }
      applied = false
    },
    commit: async () => {
      // Retain the canonical preference domain as the user's reversible
      // fallback, but bound recovery residue to the currently selected ID.
      if (isMenubarPlacementRecoveryBundleId(sourceBundleID)) {
        await runCommand('/usr/bin/defaults', ['delete', sourceBundleID]).catch(() => {})
      }
    },
  }
}

export type MenubarLoginItemState =
  | 'registered'
  | 'disabled'
  | 'not-registered'
  | 'unknown'
  | 'unsupported'

type MenubarLoginItemMaintenanceAction = 'status' | 'unregister' | 'register'

export function planMenubarLoginItemMigration(state: MenubarLoginItemState): {
  preserveDisable: boolean
  retirePrevious: boolean
  restoreOnFailure: boolean
} {
  return {
    preserveDisable: state === 'disabled',
    retirePrevious: state === 'registered' || state === 'disabled',
    restoreOnFailure: state === 'registered',
  }
}

export function isRestoredMenubarLoginItemState(
  state: MenubarLoginItemState,
  originalState: MenubarLoginItemState,
): boolean {
  return originalState === 'registered' && state === 'registered'
}

export async function installedMenubarSupportsLoginItemMaintenance(
  installedAppPath: string,
): Promise<boolean> {
  try {
    const version = await captureCommand('/usr/libexec/PlistBuddy', [
      '-c',
      `Print :${LOGIN_ITEM_MAINTENANCE_VERSION_KEY}`,
      join(installedAppPath, 'Contents', 'Info.plist'),
    ])
    return Number.parseInt(version, 10) >= 1
  } catch {
    return false
  }
}

export async function runInstalledMenubarLoginItemMaintenance(
  installedAppPath: string,
  expectedBundleID: string,
  action: MenubarLoginItemMaintenanceAction,
  options: { timeoutMs?: number } = {},
): Promise<MenubarLoginItemState> {
  if (!isSupportedMenubarBundleId(expectedBundleID)) {
    throw new Error(`Refusing Login Item maintenance for unsupported bundle id ${expectedBundleID}.`)
  }
  if (!(await installedMenubarSupportsLoginItemMaintenance(installedAppPath))) {
    return 'unsupported'
  }

  const actualBundleID = await captureCommand('/usr/libexec/PlistBuddy', [
    '-c',
    'Print :CFBundleIdentifier',
    join(installedAppPath, 'Contents', 'Info.plist'),
  ])
  if (actualBundleID !== expectedBundleID) {
    throw new Error(
      `Installed CodeBurn Menubar identity is ${actualBundleID}; expected ${expectedBundleID}.`,
    )
  }

  const argument = action === 'status'
    ? LOGIN_ITEM_STATUS_ARGUMENT
    : action === 'unregister'
      ? LOGIN_ITEM_UNREGISTER_ARGUMENT
      : LOGIN_ITEM_REGISTER_ARGUMENT
  const executablePath = join(installedAppPath, 'Contents', 'MacOS', APP_PROCESS_NAME)
  const result = await captureCommandWithTimeout(
    executablePath,
    [argument],
    options.timeoutMs ?? LOGIN_ITEM_MAINTENANCE_TIMEOUT_MS,
  )
  if (result === 'registered' || result === 'disabled' ||
      result === 'not-registered' || result === 'unknown') {
    return result
  }
  throw new Error(`CodeBurn Menubar returned an unexpected Login Item state: ${result || '(empty)'}`)
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
  const cliPath = await resolvePersistentCodeburnPath()
  await mkdir(join(homedir(), 'Library', 'Application Support', 'CodeBurn'), { recursive: true, mode: 0o700 })
  await writeFile(PERSISTED_CLI_PATH, `${cliPath}\n`, { mode: 0o600 })
  await chmod(PERSISTED_CLI_PATH, 0o600)
}

async function readPersistedMenubarBundleId(): Promise<string | undefined> {
  try {
    const bundleID = (await readFile(PERSISTED_MENUBAR_BUNDLE_ID, 'utf8')).trim()
    return isMenubarPlacementRecoveryBundleId(bundleID) ? bundleID : undefined
  } catch {
    return undefined
  }
}

async function readInstalledMenubarBundleId(appPath: string): Promise<string> {
  return captureCommand('/usr/libexec/PlistBuddy', [
    '-c',
    'Print :CFBundleIdentifier',
    join(appPath, 'Contents', 'Info.plist'),
  ])
}

async function persistMenubarBundleId(bundleID: string): Promise<void> {
  if (bundleID === EXPECTED_BUNDLE_ID) {
    await rm(PERSISTED_MENUBAR_BUNDLE_ID, { force: true })
    return
  }
  if (!isMenubarPlacementRecoveryBundleId(bundleID)) {
    throw new Error(`Refusing to persist unsupported menubar bundle id ${bundleID}.`)
  }
  const supportDir = join(homedir(), 'Library', 'Application Support', 'CodeBurn')
  await mkdir(supportDir, { recursive: true, mode: 0o700 })
  await chmod(supportDir, 0o700)
  const temporaryDir = await mkdtemp(join(supportDir, '.menubar-bundle-id-'))
  const temporaryPath = join(temporaryDir, 'value')
  try {
    await writeFile(temporaryPath, `${bundleID}\n`, { mode: 0o600 })
    await chmod(temporaryPath, 0o600)
    await rename(temporaryPath, PERSISTED_MENUBAR_BUNDLE_ID)
  } finally {
    await rm(temporaryDir, { recursive: true, force: true }).catch(() => {})
  }
}

export async function replaceMenubarBundleWithRollback(options: {
  stagedPath: string
  targetPath: string
  commitState: () => Promise<void>
  restoreState: () => Promise<void>
  launch: () => Promise<void>
}): Promise<void> {
  const backupPath = `${options.targetPath}.codeburn-backup-${process.pid}`
  const failedPath = `${options.targetPath}.codeburn-failed-${process.pid}`
  const hadPreviousBundle = await exists(options.targetPath)
  let installedNewBundle = false

  if (hadPreviousBundle) {
    await rm(backupPath, { recursive: true, force: true })
    await rename(options.targetPath, backupPath)
  }

  try {
    await rename(options.stagedPath, options.targetPath)
    installedNewBundle = true
    await options.commitState()
  } catch (installError) {
    const rollbackErrors: unknown[] = []
    if (installedNewBundle) {
      try {
        // Preserve the failed candidate until the previous app is back in its
        // canonical path. A rollback must never delete both runnable copies.
        await rm(failedPath, { recursive: true, force: true })
        await rename(options.targetPath, failedPath)
      } catch (error) {
        rollbackErrors.push(error)
      }
    }
    if (hadPreviousBundle) {
      try {
        await rename(backupPath, options.targetPath)
      } catch (error) {
        rollbackErrors.push(error)
      }
    }
    if (await exists(options.targetPath)) {
      await rm(failedPath, { recursive: true, force: true }).catch(() => {})
    }
    try {
      await options.restoreState()
    } catch (restoreError) {
      rollbackErrors.push(restoreError)
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [installError, ...rollbackErrors],
        'Menubar replacement failed and its previous bundle or identity state could not be fully restored.',
      )
    }
    throw installError
  }

  if (hadPreviousBundle) {
    try {
      await rm(backupPath, { recursive: true, force: true })
    } catch (error) {
      // The new app is already installed and running. This private path does
      // not end in .app, so Finder/LaunchServices will not treat it as a
      // second installation; report cleanup without turning success into a
      // misleading failed-install result.
      console.warn(`CodeBurn Menubar installed, but its private rollback backup could not be removed: ${String(error)}`)
    }
  }

  // LaunchServices failure does not undo an otherwise committed install. The
  // caller can retry launch or tell the user exactly which installed app to
  // open without restoring the poisoned identity that prompted the repair.
  await options.launch()
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
/// the .msi to msiexec, then launch what it installed.
const WINDOWS_UNINSTALL_KEYS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
]
/// 3010 is "installed, reboot to finish"; 1602 is the user closing the UAC/installer prompt.
const MSI_EXIT_REBOOT_REQUIRED = 3010
const MSI_EXIT_USER_CANCEL = 1602

export type WindowsInstallHooks = {
  fetchOptions?: AssetFetchOptions
  apiFetch?: ReleaseApiFetch
  runInstaller?: (exe: string, args: string[]) => Promise<number>
  queryRegistry?: () => Promise<string>
  launch?: (exePath: string) => void
  log?: (message: string) => void
  stagingDir?: string
  env?: NodeJS.ProcessEnv
}

export type InstalledWindowsMenubar = { version: string; exePath: string }

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
    const location = values.get('InstallLocation')
    // DisplayIcon is `<exe>[,<index>]` and points at the installed binary when there is no
    // InstallLocation to join onto.
    const icon = values.get('DisplayIcon')?.split(',')[0]?.trim()
    const exePath = location
      ? `${location.replace(/[\\/]+$/, '')}\\${WINDOWS_PRODUCT_NAME}.exe`
      : icon
    if (!exePath) continue
    return { version: values.get('DisplayVersion') ?? '', exePath }
  }
  return undefined
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

function launchWindowsApp(exePath: string): void {
  const proc = spawn(exePath, [], { detached: true, stdio: 'ignore' })
  proc.on('error', err => console.error(`Could not launch ${exePath}: ${err.message}`))
  proc.unref()
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
  const launch = hooks.launch ?? launchWindowsApp
  const cliVersion = options.cliVersion ? normalizeCliVersion(options.cliVersion) : ''

  const installed = parseInstalledWindowsMenubar(await queryRegistry())
  if (installed && !options.force && (!cliVersion || installed.version === cliVersion)) {
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
    launch(nowInstalled.exePath)
    log('Launched CodeBurn Menubar.')
    return { installedPath: nowInstalled.exePath, launched: true }
  } finally {
    if (!hooks.stagingDir) await rm(stagingDir, { recursive: true, force: true })
  }
}

export async function installMenubarApp(options: InstallOptions = {}): Promise<InstallResult> {
  if ((options.platform ?? platform()) === 'win32') {
    if (options.repairPlacement || options.resetPlacement) {
      throw new Error('--repair-placement and --reset-placement are only available for the macOS menu bar app.')
    }
    return installWindowsMenubarApp(options)
  }
  await ensureSupportedPlatform()
  await persistCodeburnPath()

  const appsDir = userApplicationsDir()
  const targetPath = join(appsDir, APP_BUNDLE_NAME)
  const alreadyInstalled = await exists(targetPath)
  const persistedBundleId = await readPersistedMenubarBundleId()
  const installedBundleId = alreadyInstalled
    ? await readInstalledMenubarBundleId(targetPath)
    : undefined
  const previousBundleId = resolveActiveMenubarBundleId({
    installedBundleId,
    persistedBundleId,
  })
  const selectedBundleId = selectMenubarBundleId({
    repairPlacement: options.repairPlacement,
    resetPlacement: options.resetPlacement,
    persistedBundleId: isMenubarPlacementRecoveryBundleId(previousBundleId)
      ? previousBundleId
      : undefined,
  })

  if (alreadyInstalled && previousBundleId !== selectedBundleId &&
      !(await installedMenubarSupportsLoginItemMaintenance(targetPath))) {
    throw new Error(
      'This installed CodeBurn Menubar predates safe Login Item identity transfer. ' +
      'Run `codeburn menubar --force` once, then rerun the placement repair command.',
    )
  }

  if (alreadyInstalled && !options.force && !options.repairPlacement && !options.resetPlacement) {
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

    if ((previousBundleId !== selectedBundleId || selectedBundleId !== EXPECTED_BUNDLE_ID) &&
        !(await installedMenubarSupportsLoginItemMaintenance(unpackedApp))) {
      throw new Error(
        'The downloaded CodeBurn Menubar build predates safe bundle-identity transfer. ' +
        'Install a current official release before using placement repair.',
      )
    }

    await mkdir(appsDir, { recursive: true })
    const wasRunning = alreadyInstalled && await isAppRunning()
    if (alreadyInstalled) {
      // Stop the running copy before the transactional bundle swap.
      await killRunningApp()
    }
    let preferenceMigration: MenubarPreferenceMigration
    let loginItemWasUnregistered = false
    let loginItemState: MenubarLoginItemState = 'not-registered'
    let loginItemMigrationPlan = planMenubarLoginItemMigration(loginItemState)
    try {
      if (alreadyInstalled && previousBundleId !== selectedBundleId) {
        loginItemState = await runInstalledMenubarLoginItemMaintenance(
          targetPath,
          previousBundleId,
          'status',
        )
        if (loginItemState === 'unsupported' || loginItemState === 'unknown') {
          throw new Error('CodeBurn could not safely determine the existing Login Item state.')
        }
        loginItemMigrationPlan = planMenubarLoginItemMigration(loginItemState)
      }
      if (previousBundleId !== selectedBundleId) {
        console.log('Preparing CodeBurn Menubar settings for the selected bundle identity...')
      }
      // Snapshot only after the old app has stopped, so its final UserDefaults
      // writes cannot race the identity migration.
      preferenceMigration = await prepareMenubarPreferenceMigration(
        previousBundleId,
        selectedBundleId,
        stagingDir,
        { preserveLoginDisable: loginItemMigrationPlan.preserveDisable },
      )

      if (selectedBundleId !== EXPECTED_BUNDLE_ID) {
        console.log(options.repairPlacement
          ? 'Repairing menu bar placement with a fresh local bundle identity...'
          : 'Restoring the repaired menu bar bundle identity...')
        await reidentifyMenubarBundleForPlacementRecovery(unpackedApp, selectedBundleId)
      }

      if (alreadyInstalled && previousBundleId !== selectedBundleId) {
        if (loginItemMigrationPlan.retirePrevious) {
          console.log('Retiring the previous CodeBurn Menubar Login Item identity...')
          // The process may successfully unregister and then time out or crash
          // before replying. Arm the idempotent restore before invoking it.
          loginItemWasUnregistered = loginItemMigrationPlan.restoreOnFailure
          const retiredState = await runInstalledMenubarLoginItemMaintenance(
            targetPath,
            previousBundleId,
            'unregister',
          )
          if (retiredState !== loginItemState) {
            throw new Error('CodeBurn could not confirm retirement of the previous Login Item identity.')
          }
        }
      }
    } catch (error) {
      if (loginItemWasUnregistered) {
        try {
          const restoredState = await runInstalledMenubarLoginItemMaintenance(
            targetPath,
            previousBundleId,
            'register',
          )
          if (!isRestoredMenubarLoginItemState(restoredState, loginItemState)) {
            throw new Error(`Unexpected state ${restoredState}`)
          }
          loginItemWasUnregistered = false
        } catch (restoreError) {
          if (wasRunning) await runCommand('/usr/bin/open', [targetPath]).catch(() => {})
          throw new AggregateError(
            [error, restoreError],
            'Placement repair stopped before installation and could not restore the previous Login Item.',
          )
        }
      }
      if (wasRunning) await runCommand('/usr/bin/open', [targetPath]).catch(() => {})
      throw error
    }
    let launched = false
    try {
      await replaceMenubarBundleWithRollback({
        stagedPath: unpackedApp,
        targetPath,
        commitState: async () => {
          await preferenceMigration.apply()
          await persistMenubarBundleId(selectedBundleId)
        },
        restoreState: async () => {
          await preferenceMigration.rollback()
          await persistMenubarBundleId(previousBundleId)
          if (loginItemWasUnregistered) {
            const restoredState = await runInstalledMenubarLoginItemMaintenance(
              targetPath,
              previousBundleId,
              'register',
            )
            if (!isRestoredMenubarLoginItemState(restoredState, loginItemState)) {
              throw new Error('CodeBurn could not restore the previous Login Item identity.')
            }
            loginItemWasUnregistered = false
          }
          if (wasRunning) await runCommand('/usr/bin/open', [targetPath])
        },
        launch: async () => {
          console.log('Launching CodeBurn Menubar...')
          if (options.repairPlacement) {
            console.log('macOS may ask for CodeBurn permissions again because placement repair uses a new local identity.')
          } else if (options.resetPlacement) {
            console.log('Restored the official CodeBurn Menubar bundle identity.')
          }
          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              await runCommand('/usr/bin/open', [targetPath])
              launched = true
              return
            } catch (error) {
              if (attempt === 1) {
                await new Promise(resolve => setTimeout(resolve, 250))
                continue
              }
              console.warn(
                `CodeBurn Menubar was installed at ${targetPath}, but macOS did not launch it. ` +
                `Open that app manually. ${String(error)}`,
              )
            }
          }
        },
      })
    } catch (error) {
      if (loginItemWasUnregistered) {
        try {
          const restoredState = await runInstalledMenubarLoginItemMaintenance(
            targetPath,
            previousBundleId,
            'register',
          )
          if (!isRestoredMenubarLoginItemState(restoredState, loginItemState)) {
            throw new Error(`Unexpected state ${restoredState}`)
          }
          loginItemWasUnregistered = false
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            'Menubar replacement failed and its previous Login Item could not be restored.',
          )
        }
      }
      throw error
    }
    await preferenceMigration.commit()
    return { installedPath: targetPath, launched }
  } finally {
    await rm(stagingDir, { recursive: true, force: true })
  }
}

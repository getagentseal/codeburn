import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { ProxyAgent, fetch as undiciFetch } from 'undici'

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
const MIN_MACOS_MAJOR = 14
const PERSISTED_CLI_PATH = join(homedir(), 'Library', 'Application Support', 'CodeBurn', 'codeburn-cli-path.v1')
const PERSISTENT_CLI_REQUIRED_MESSAGE =
  'The menubar app needs a persistent codeburn command. Install CodeBurn globally first: npm install -g codeburn'

export type InstallResult = { installedPath: string; launched: boolean }

export type ReleaseAsset = { name: string; browser_download_url: string }
export type ReleaseResponse = { tag_name: string; assets: ReleaseAsset[] }
export type ResolvedAssets = { release: ReleaseResponse; zip: ReleaseAsset; checksum: ReleaseAsset }
export type InstallOptions = { force?: boolean; cliVersion?: string }
type ProxyEnv = Partial<Record<'HTTPS_PROXY' | 'https_proxy' | 'HTTP_PROXY' | 'http_proxy' | 'NO_PROXY' | 'no_proxy', string>>
type FetchOptions = Parameters<typeof undiciFetch>[1]
type HeaderGetter = { get(name: string): string | null }

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

export function resolveMenubarReleaseAssets(release: ReleaseResponse): ResolvedAssets {
  const zip = release.assets.find(a => VERSIONED_ASSET_PATTERN.test(a.name))
  if (!zip) {
    throw new Error(
      `No ${APP_BUNDLE_NAME} versioned zip found in release ${release.tag_name}. ` +
      `Check https://github.com/getagentseal/codeburn/releases.`
    )
  }
  const checksum = release.assets.find(a => a.name === `${zip.name}.sha256`)
  if (!checksum) {
    throw new Error(`Missing checksum asset ${zip.name}.sha256 in release ${release.tag_name}.`)
  }
  return { release, zip, checksum }
}

export function resolveLatestMenubarReleaseAssets(releases: ReleaseResponse[]): ResolvedAssets {
  for (const release of releases) {
    if (!release.tag_name.startsWith('mac-v')) continue
    try {
      return resolveMenubarReleaseAssets(release)
    } catch {
      continue
    }
  }
  throw new Error('No mac-v* release with a CodeBurnMenubar-v*.zip and checksum was found.')
}

function normalizeCliVersion(cliVersion: string): string {
  return cliVersion.trim().replace(/^v/, '')
}

export function resolveVersionedMenubarReleaseAssets(cliVersion: string): ResolvedAssets {
  const version = normalizeCliVersion(cliVersion)
  if (!version) throw new Error('Cannot resolve CodeBurn Menubar release without a CLI version.')

  const tagName = `mac-v${version}`
  const zipName = `CodeBurnMenubar-v${version}.zip`
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

function isMissingDirectAssetError(err: unknown): boolean {
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

async function fetchLatestReleaseAssets(): Promise<ResolvedAssets> {
  const response = await fetchWithProxy(RELEASE_API, {
    headers: {
      'User-Agent': 'codeburn-menubar-installer',
      Accept: 'application/vnd.github+json',
    },
  })
  if (!response.ok) {
    throw new HttpStatusError(formatGitHubReleaseLookupError(response.status, response.headers), response.status)
  }
  const body = await response.json() as ReleaseResponse[]
  return resolveLatestMenubarReleaseAssets(body)
}

async function verifyChecksum(archivePath: string, checksumUrl: string): Promise<void> {
  const response = await fetchWithProxy(checksumUrl, {
    headers: { 'User-Agent': 'codeburn-menubar-installer' },
    redirect: 'follow',
  })
  if (!response.ok) {
    throw new HttpStatusError(`Checksum download failed: HTTP ${response.status}`, response.status)
  }
  const text = await response.text()
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

async function downloadToFile(url: string, destPath: string): Promise<void> {
  const response = await fetchWithProxy(url, {
    headers: { 'User-Agent': 'codeburn-menubar-installer' },
    redirect: 'follow',
  })
  if (!response.ok || response.body === null) {
    throw new HttpStatusError(`Download failed: HTTP ${response.status}`, response.status)
  }
  // fetch's ReadableStream needs to be wrapped for Node streams.
  const nodeStream = Readable.fromWeb(response.body as never)
  await pipeline(nodeStream, createWriteStream(destPath))
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
  const cliPath = await resolvePersistentCodeburnPath()
  await mkdir(join(homedir(), 'Library', 'Application Support', 'CodeBurn'), { recursive: true, mode: 0o700 })
  await writeFile(PERSISTED_CLI_PATH, `${cliPath}\n`, { mode: 0o600 })
  await chmod(PERSISTED_CLI_PATH, 0o600)
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

export async function installMenubarApp(options: InstallOptions = {}): Promise<InstallResult> {
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

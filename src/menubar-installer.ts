import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

/// Public GitHub repo that hosts macOS release builds. CLI and menubar releases share
/// the repository, so we scan recent releases and choose the newest `mac-v*` release
/// that actually contains the menubar zip.
const RELEASE_API = 'https://api.github.com/repos/getagentseal/codeburn/releases?per_page=20'
const APP_BUNDLE_NAME = 'CodeBurnMenubar.app'
const EXPECTED_BUNDLE_ID = 'org.agentseal.codeburn-menubar'
const VERSIONED_ASSET_PATTERN = /^CodeBurnMenubar-v.+\.zip$/
const APP_PROCESS_NAME = 'CodeBurnMenubar'
const SUPPORTED_OS = 'darwin'
const MIN_MACOS_MAJOR = 14
const PERSISTED_CLI_PATH = join(homedir(), 'Library', 'Application Support', 'CodeBurn', 'codeburn-cli-path.v1')
const PERSISTENT_CLI_REQUIRED_MESSAGE =
  'The menubar app needs a persistent codeburn command. Install CodeBurn globally first: npm install -g codeburn'
const DEFAULT_CLI_LOOKUP_PATHS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']

export type InstallResult = { installedPath: string; launched: boolean }

export type ReleaseAsset = { name: string; browser_download_url: string }
export type ReleaseResponse = { tag_name: string; assets: ReleaseAsset[] }
export type ResolvedAssets = { release: ReleaseResponse; zip: ReleaseAsset; checksum: ReleaseAsset }

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

export function buildPersistentCodeburnLookupPath(existingPath = process.env.PATH ?? ''): string {
  const parts = existingPath.split(':').filter(Boolean)
  for (const fallback of DEFAULT_CLI_LOOKUP_PATHS) {
    if (!parts.includes(fallback)) parts.push(fallback)
  }
  return parts.join(':')
}

function isTransientNpxPath(path: string): boolean {
  return path.includes('/_npx/') || path.includes('/.npm/_npx/')
}

export function resolvePersistentCodeburnPathFromWhichOutput(output: string): string {
  const paths = output
    .split(/\r?\n/)
    .map(path => path.trim())
    .filter(Boolean)

  const persistentPath = paths.find(path => path.startsWith('/') && !isTransientNpxPath(path))
  if (persistentPath) return persistentPath

  throw new Error(PERSISTENT_CLI_REQUIRED_MESSAGE)
}

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
  const response = await fetch(RELEASE_API, {
    headers: {
      'User-Agent': 'codeburn-menubar-installer',
      Accept: 'application/vnd.github+json',
    },
  })
  if (!response.ok) {
    throw new Error(`GitHub release lookup failed: HTTP ${response.status}`)
  }
  const body = await response.json() as ReleaseResponse[]
  return resolveLatestMenubarReleaseAssets(body)
}

async function verifyChecksum(archivePath: string, checksumUrl: string): Promise<void> {
  const response = await fetch(checksumUrl, {
    headers: { 'User-Agent': 'codeburn-menubar-installer' },
    redirect: 'follow',
  })
  if (!response.ok) {
    throw new Error(`Checksum download failed: HTTP ${response.status}`)
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
  const response = await fetch(url, {
    headers: { 'User-Agent': 'codeburn-menubar-installer' },
    redirect: 'follow',
  })
  if (!response.ok || response.body === null) {
    throw new Error(`Download failed: HTTP ${response.status}`)
  }
  // fetch's ReadableStream needs to be wrapped for Node streams.
  const nodeStream = Readable.fromWeb(response.body as never)
  await pipeline(nodeStream, createWriteStream(destPath))
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

  return resolvePersistentCodeburnPathFromWhichOutput(output)
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

export async function installMenubarApp(options: { force?: boolean } = {}): Promise<InstallResult> {
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

  console.log('Looking up the latest CodeBurn Menubar release...')
  const { zip, checksum } = await fetchLatestReleaseAssets()

  const stagingDir = await mkdtemp(join(tmpdir(), 'codeburn-menubar-'))
  try {
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

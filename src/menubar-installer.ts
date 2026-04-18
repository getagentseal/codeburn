import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises'
import { homedir, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

/// Public GitHub repo that hosts signed macOS release builds. `/releases/latest` returns the
/// newest tagged release; we filter its assets list for our zipped .app bundle.
const RELEASE_API = 'https://api.github.com/repos/getagentseal/codeburn/releases/latest'
const APP_BUNDLE_NAME = 'CodeBurnMenubar.app'
const ASSET_PATTERN = /^CodeBurnMenubar-.*\.zip$/
const APP_PROCESS_NAME = 'CodeBurnMenubar'
const SUPPORTED_OS = 'darwin'
const MIN_MACOS_MAJOR = 14

export type InstallResult = { installedPath: string; launched: boolean }

type ReleaseAsset = { name: string; browser_download_url: string }
type ReleaseResponse = { tag_name: string; assets: ReleaseAsset[] }

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

async function fetchLatestReleaseAsset(): Promise<ReleaseAsset> {
  const response = await fetch(RELEASE_API, {
    headers: {
      // Identify the installer so GitHub's abuse heuristics treat us as a known client.
      'User-Agent': 'codeburn-menubar-installer',
      Accept: 'application/vnd.github+json',
    },
  })
  if (!response.ok) {
    throw new Error(`GitHub release lookup failed: HTTP ${response.status}`)
  }
  const body = await response.json() as ReleaseResponse
  const asset = body.assets.find(a => ASSET_PATTERN.test(a.name))
  if (!asset) {
    throw new Error(
      `No ${APP_BUNDLE_NAME} zip found in release ${body.tag_name}. ` +
      `Check https://github.com/getagentseal/codeburn/releases.`
    )
  }
  return asset
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
}

export async function installMenubarApp(options: { force?: boolean } = {}): Promise<InstallResult> {
  await ensureSupportedPlatform()

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
  const asset = await fetchLatestReleaseAsset()

  const stagingDir = await mkdtemp(join(tmpdir(), 'codeburn-menubar-'))
  try {
    const archivePath = join(stagingDir, asset.name)
    console.log(`Downloading ${asset.name}...`)
    await downloadToFile(asset.browser_download_url, archivePath)

    console.log('Unpacking...')
    await runCommand('/usr/bin/unzip', ['-q', archivePath, '-d', stagingDir])

    const unpackedApp = join(stagingDir, APP_BUNDLE_NAME)
    if (!(await exists(unpackedApp))) {
      throw new Error(`Archive did not contain ${APP_BUNDLE_NAME}.`)
    }

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

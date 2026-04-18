import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises'
import { arch, homedir, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { createWriteStream } from 'node:fs'

/// Public GitHub repo that hosts release builds. `/releases/latest` returns the newest
/// tagged release; we filter its assets list for the artifact matching the current OS + arch.
const RELEASE_API = 'https://api.github.com/repos/getagentseal/codeburn/releases/latest'
const MIN_MACOS_MAJOR = 14

export type InstallResult = { installedPath: string; launched: boolean }

type ReleaseAsset = { name: string; browser_download_url: string }
type ReleaseResponse = { tag_name: string; assets: ReleaseAsset[] }

/// A platform-specific strategy for picking the right release asset and installing it.
type InstallPlan = {
  platformLabel: string
  assetPattern: RegExp
  install: (archivePath: string, opts: { force?: boolean }) => Promise<InstallResult>
  /// Optional pre-install validation; throws with a user-friendly message on unsupported
  /// environments (wrong OS version, missing tooling, etc.).
  validate?: () => Promise<void>
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch { return false }
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

function macOSPlan(): InstallPlan {
  const APP_BUNDLE_NAME = 'CodeBurnMenubar.app'
  const appsDir = join(homedir(), 'Applications')
  const targetPath = join(appsDir, APP_BUNDLE_NAME)

  return {
    platformLabel: 'macOS',
    assetPattern: /^CodeBurnMenubar-.*\.zip$/,
    validate: async () => {
      const major = Number((process.env.CODEBURN_FORCE_MACOS_MAJOR ?? '')
        || (await sysProductVersion()).split('.')[0])
      if (!Number.isFinite(major) || major < MIN_MACOS_MAJOR) {
        throw new Error(`macOS ${MIN_MACOS_MAJOR}+ required (detected ${major}).`)
      }
    },
    install: async (archivePath, { force }) => {
      const already = await exists(targetPath)
      if (already && !force) {
        // Just relaunch if an install is present and the user didn't force.
        await runCommand('/usr/bin/open', [targetPath])
        return { installedPath: targetPath, launched: true }
      }

      const stagingDir = await mkdtemp(join(tmpdir(), 'codeburn-menubar-'))
      try {
        await runCommand('/usr/bin/unzip', ['-q', archivePath, '-d', stagingDir])
        const unpacked = join(stagingDir, APP_BUNDLE_NAME)
        if (!(await exists(unpacked))) {
          throw new Error(`Archive did not contain ${APP_BUNDLE_NAME}.`)
        }

        // Strip Gatekeeper quarantine so the download-via-curl launch doesn't trigger the
        // "cannot verify developer" dialog on unsigned / ad-hoc-signed builds.
        await runCommand('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', unpacked]).catch(() => {})

        await mkdir(appsDir, { recursive: true })
        if (already) {
          // Kill the running copy before replacing its bundle.
          await new Promise<void>((resolve) => {
            const proc = spawn('/usr/bin/pkill', ['-f', 'CodeBurnMenubar'])
            proc.on('close', () => resolve())
            proc.on('error', () => resolve())
          })
          await rm(targetPath, { recursive: true, force: true })
        }
        await rename(unpacked, targetPath)
        await runCommand('/usr/bin/open', [targetPath])
        return { installedPath: targetPath, launched: true }
      } finally {
        await rm(stagingDir, { recursive: true, force: true })
      }
    },
  }
}

function linuxPlan(): InstallPlan {
  const targetArch = arch() === 'arm64' ? 'aarch64' : 'x86_64'
  const localBin = join(homedir(), '.local', 'bin')
  const targetPath = join(localBin, 'codeburn-menubar.AppImage')
  // AppImage is the universal single-file format: no root, no package manager, runs on any
  // glibc-based distro. .deb and .rpm paths can be added as preferred formats later.
  const pattern = new RegExp(`^codeburn-menubar.*${targetArch}.*\\.AppImage$`, 'i')

  return {
    platformLabel: 'Linux',
    assetPattern: pattern,
    install: async (archivePath) => {
      await mkdir(localBin, { recursive: true })
      // AppImage assets are downloaded directly (not zipped), so the "archive" is the final
      // binary. Move into place and mark executable.
      await rename(archivePath, targetPath)
      await chmod(targetPath, 0o755)

      // Launch detached so `npx codeburn menubar` can return.
      const proc = spawn(targetPath, [], { detached: true, stdio: 'ignore' })
      proc.unref()
      return { installedPath: targetPath, launched: true }
    },
  }
}

function windowsPlan(): InstallPlan {
  const targetArch = arch() === 'arm64' ? 'arm64' : 'x64'
  const pattern = new RegExp(`^codeburn-menubar.*${targetArch}.*\\.msi$`, 'i')

  return {
    platformLabel: 'Windows',
    assetPattern: pattern,
    install: async (archivePath) => {
      // Hand the .msi to the Windows Installer; it prompts the user for UAC confirmation.
      // The installer writes the app under Program Files and launches it on completion.
      await runCommand('msiexec', ['/i', archivePath, '/passive'])
      return { installedPath: archivePath, launched: true }
    },
  }
}

function planForPlatform(): InstallPlan {
  switch (platform()) {
    case 'darwin': return macOSPlan()
    case 'linux':  return linuxPlan()
    case 'win32':  return windowsPlan()
    default:
      throw new Error(`codeburn menubar does not support platform "${platform()}" yet.`)
  }
}

async function fetchLatestReleaseAsset(assetPattern: RegExp): Promise<ReleaseAsset> {
  const response = await fetch(RELEASE_API, {
    headers: {
      'User-Agent': 'codeburn-menubar-installer',
      Accept: 'application/vnd.github+json',
    },
  })
  if (!response.ok) {
    throw new Error(`GitHub release lookup failed: HTTP ${response.status}`)
  }
  const body = await response.json() as ReleaseResponse
  const asset = body.assets.find(a => assetPattern.test(a.name))
  if (!asset) {
    throw new Error(
      `No matching asset found in release ${body.tag_name}. ` +
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
  const nodeStream = Readable.fromWeb(response.body as never)
  await pipeline(nodeStream, createWriteStream(destPath))
}

export async function installMenubarApp(options: { force?: boolean } = {}): Promise<InstallResult> {
  const plan = planForPlatform()
  if (plan.validate) await plan.validate()

  console.log(`Looking up the latest CodeBurn Menubar release for ${plan.platformLabel}...`)
  const asset = await fetchLatestReleaseAsset(plan.assetPattern)

  const stagingDir = await mkdtemp(join(tmpdir(), 'codeburn-menubar-'))
  try {
    const downloadPath = join(stagingDir, asset.name)
    console.log(`Downloading ${asset.name}...`)
    await downloadToFile(asset.browser_download_url, downloadPath)

    console.log('Installing...')
    return await plan.install(downloadPath, options)
  } finally {
    await rm(stagingDir, { recursive: true, force: true })
  }
}

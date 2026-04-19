import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises'
import { homedir, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { URL } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

/// Public GitHub repo that hosts signed macOS release builds. `/releases/latest` returns the
/// newest tagged release; we filter its assets list for our zipped .app bundle.
const RELEASE_API = 'https://api.github.com/repos/getagentseal/codeburn/releases/latest'
const APP_BUNDLE_NAME = 'CodeBurnMenubar.app'
const ASSET_PATTERN = /^CodeBurnMenubar-.*\.zip$/
const SHA256_SUFFIX = '.sha256'
const APP_PROCESS_NAME = 'CodeBurnMenubar'
const SUPPORTED_OS = 'darwin'
const MIN_MACOS_MAJOR = 14
/// Only accept download URLs served from these GitHub-controlled hosts. Stops a release-asset
/// JSON whose `browser_download_url` was tampered with (or returned via a redirect we forwarded)
/// from pointing the installer at an attacker-hosted binary.
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
])
const SHA256_HEX_PATTERN = /^[0-9a-fA-F]{64}$/
const ALLOW_UNVERIFIED_ENV = 'CODEBURN_ALLOW_UNVERIFIED_INSTALL'

export type InstallResult = { installedPath: string; launched: boolean }

type ReleaseAsset = { name: string; browser_download_url: string }
type ReleaseResponse = { tag_name: string; assets: ReleaseAsset[] }
type AssetPair = { archive: ReleaseAsset; checksum: ReleaseAsset | null; tag: string }

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

async function fetchLatestReleaseAsset(): Promise<AssetPair> {
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
  const archive = body.assets.find(a => ASSET_PATTERN.test(a.name))
  if (!archive) {
    throw new Error(
      `No ${APP_BUNDLE_NAME} zip found in release ${body.tag_name}. ` +
      `Check https://github.com/getagentseal/codeburn/releases.`
    )
  }
  const checksum = body.assets.find(a => a.name === `${archive.name}${SHA256_SUFFIX}`) ?? null
  return { archive, checksum, tag: body.tag_name }
}

/// Refuses to download if the published asset URL points anywhere other than a GitHub-controlled
/// host. Belt-and-braces alongside the SHA256 verification: even with TLS, a malicious release
/// payload can ship arbitrary `browser_download_url` strings.
///
/// Hardening notes:
/// - Trailing dots are stripped: `github.com.` resolves to the same DNS record as `github.com`,
///   so treating them as different would let an attacker bypass the allow-list with a host that
///   `fetch` happily resolves.
/// - URLs carrying userinfo (`https://anyone@host/...`) are rejected. GitHub release URLs never
///   carry credentials, so userinfo signals either tampering or someone smuggling additional
///   semantics past a careless reader.
/// - IDN/punycode hosts (`xn--...`) are rejected. The allow-list is plain ASCII; a punycoded
///   host that visually looks like `github.com` is exactly the homoglyph attack we want to refuse.
function ensureAllowedHost(url: string, label: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`${label} URL is unparseable: ${url}`)
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error(`${label} URL contains userinfo; refusing to install.`)
  }
  const rawHost = parsed.host
  if (rawHost.startsWith('xn--') || rawHost.includes('.xn--')) {
    throw new Error(`${label} URL host is IDN/punycode (${rawHost}); refusing to install.`)
  }
  const host = rawHost.toLowerCase().replace(/\.$/, '')
  if (!ALLOWED_DOWNLOAD_HOSTS.has(host)) {
    throw new Error(`${label} URL points at an unexpected host (${host}); refusing to install.`)
  }
}

/// Walks a redirect chain manually so the host check runs on every hop, not just the initial
/// URL. `fetch`'s `redirect: 'follow'` mode applies the host check only once and then trusts
/// whatever the server sends; this loop re-validates after each 3xx so an asset URL that 302s
/// to an attacker-hosted CDN is rejected at the redirect, not after the bytes are on disk.
async function fetchFollowingAllowedRedirects(url: string, label: string): Promise<Response> {
  const maxRedirects = 5
  let current = url
  for (let hop = 0; hop <= maxRedirects; hop++) {
    ensureAllowedHost(current, label)
    const response = await fetch(current, {
      headers: { 'User-Agent': 'codeburn-menubar-installer' },
      redirect: 'manual',
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) {
        throw new Error(`${label} redirect missing Location header (HTTP ${response.status}).`)
      }
      // Resolve relative redirects against the current URL, matching browser behaviour.
      current = new URL(location, current).toString()
      continue
    }
    return response
  }
  throw new Error(`${label} exceeded ${maxRedirects} redirects; refusing to install.`)
}

async function downloadToFile(url: string, destPath: string): Promise<void> {
  const response = await fetchFollowingAllowedRedirects(url, 'Download')
  if (!response.ok || response.body === null) {
    throw new Error(`Download failed: HTTP ${response.status}`)
  }
  // fetch's ReadableStream needs to be wrapped for Node streams.
  const nodeStream = Readable.fromWeb(response.body as never)
  await pipeline(nodeStream, createWriteStream(destPath))
}

async function fetchExpectedSha256(asset: ReleaseAsset): Promise<string> {
  const response = await fetchFollowingAllowedRedirects(asset.browser_download_url, 'Checksum')
  if (!response.ok) {
    throw new Error(`Checksum download failed: HTTP ${response.status}`)
  }
  const body = (await response.text()).trim()
  // Accept either a bare hex digest or the `sha256sum` two-column format ("<hex>  <name>").
  const hex = body.split(/\s+/)[0] ?? ''
  if (!SHA256_HEX_PATTERN.test(hex)) {
    throw new Error(`Checksum file does not contain a valid SHA-256 digest.`)
  }
  return hex.toLowerCase()
}

async function computeFileSha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex').toLowerCase()
}

async function verifyArchiveIntegrity(archivePath: string, checksum: ReleaseAsset | null, tag: string): Promise<void> {
  if (!checksum) {
    if (process.env[ALLOW_UNVERIFIED_ENV] === '1') {
      console.warn(
        `WARNING: release ${tag} ships no .sha256 sidecar; proceeding because ` +
        `${ALLOW_UNVERIFIED_ENV}=1. The downloaded bundle is NOT integrity-verified.`,
      )
      return
    }
    throw new Error(
      `Release ${tag} does not publish a SHA-256 checksum sidecar (${APP_BUNDLE_NAME}<version>.zip${SHA256_SUFFIX}). ` +
      `Refusing to install an unverified binary. ` +
      `Set ${ALLOW_UNVERIFIED_ENV}=1 to override at your own risk, or wait for a release that ships a sidecar.`
    )
  }
  const [expected, actual] = await Promise.all([
    fetchExpectedSha256(checksum),
    computeFileSha256(archivePath),
  ])
  if (expected !== actual) {
    throw new Error(
      `Checksum mismatch for ${APP_BUNDLE_NAME} (${tag}): expected ${expected}, got ${actual}. ` +
      `The downloaded archive does not match the published SHA-256; refusing to install.`
    )
  }
  console.log(`Verified SHA-256 (${actual.slice(0, 12)}...) against published sidecar.`)
}

async function readChecksumSidecar(path: string): Promise<string> {
  const body = (await readFile(path, 'utf-8')).trim()
  const hex = body.split(/\s+/)[0] ?? ''
  if (!SHA256_HEX_PATTERN.test(hex)) {
    throw new Error(`Local checksum sidecar at ${path} does not contain a valid SHA-256 digest.`)
  }
  return hex.toLowerCase()
}

async function verifyLocalArchive(archivePath: string, checksumPath: string): Promise<void> {
  const [expected, actual] = await Promise.all([
    readChecksumSidecar(checksumPath),
    computeFileSha256(archivePath),
  ])
  if (expected !== actual) {
    throw new Error(`Local checksum mismatch: expected ${expected}, got ${actual}.`)
  }
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
  const { archive, checksum, tag } = await fetchLatestReleaseAsset()

  const stagingDir = await mkdtemp(join(tmpdir(), 'codeburn-menubar-'))
  try {
    const archivePath = join(stagingDir, archive.name)
    console.log(`Downloading ${archive.name}...`)
    await downloadToFile(archive.browser_download_url, archivePath)

    await verifyArchiveIntegrity(archivePath, checksum, tag)

    console.log('Unpacking...')
    await runCommand('/usr/bin/unzip', ['-q', archivePath, '-d', stagingDir])

    const unpackedApp = join(stagingDir, APP_BUNDLE_NAME)
    if (!(await exists(unpackedApp))) {
      throw new Error(`Archive did not contain ${APP_BUNDLE_NAME}.`)
    }

    // Quarantine xattr is intentionally left in place so Gatekeeper evaluates the bundle
    // on first launch. Stripping it (the previous behaviour) defeated the OS-level prompt
    // that gives the user a chance to abort if the binary was tampered with -- the SHA-256
    // sidecar verification above is necessary but not sufficient.

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

/// Test seam: verifies a locally-staged archive against a sidecar without touching the network.
/// Exported so tests can exercise the SHA-256 path end-to-end with fixture files.
export async function _verifyLocalArchiveForTest(archivePath: string, checksumPath: string): Promise<void> {
  return verifyLocalArchive(archivePath, checksumPath)
}

/// Test seam: exposes the host allow-list check for unit tests.
export function _ensureAllowedHostForTest(url: string): void {
  ensureAllowedHost(url, 'Test')
}

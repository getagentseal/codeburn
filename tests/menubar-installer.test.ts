import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildPersistentCodeburnLookupPath,
  downloadToFile,
  formatGitHubReleaseLookupError,
  createMenubarPlacementRecoveryBundleId,
  isSupportedMenubarBundleId,
  isAdHocMenubarSignatureDetails,
  isMissingDefaultsDomainError,
  installedMenubarSupportsLoginItemMaintenance,
  isRestoredMenubarLoginItemState,
  planMenubarLoginItemMigration,
  selectMenubarBundleId,
  isMissingDirectAssetError,
  resolveLatestMenubarReleaseAssets,
  resolveMenubarReleaseAssets,
  resolvePersistentCodeburnPathFromWhichOutput,
  resolveProxyUrlForUrl,
  resolveActiveMenubarBundleId,
  reidentifyMenubarBundleForPlacementRecovery,
  migrateMenubarPreferencesForPlacementRecovery,
  prepareMenubarPreferenceMigration,
  runInstalledMenubarLoginItemMaintenance,
  replaceMenubarBundleWithRollback,
  resolveVersionedMenubarReleaseAssets,
  shouldFallbackToReleaseApi,
  verifyChecksum,
  type ReleaseResponse,
} from '../src/menubar-installer.js'

const execFileAsync = promisify(execFile)

function asset(name: string) {
  return { name, browser_download_url: `https://example.test/${name}` }
}

describe('resolveMenubarReleaseAssets', () => {
  it('fails closed for an ambiguous legacy approval state', () => {
    expect(planMenubarLoginItemMigration('disabled')).toEqual({
      preserveDisable: true,
      retirePrevious: true,
      restoreOnFailure: false,
    })
  })

  it('requires rollback to restore the source consent level exactly', () => {
    expect(isRestoredMenubarLoginItemState('registered', 'registered')).toBe(true)
    expect(isRestoredMenubarLoginItemState('disabled', 'registered')).toBe(false)
  })

  it('distinguishes an absent defaults domain from an operational export failure', () => {
    expect(isMissingDefaultsDomainError(new Error('Domain org.example does not exist.'))).toBe(true)
    expect(isMissingDefaultsDomainError(new Error('Domain (org.example) not found.'))).toBe(true)
    expect(isMissingDefaultsDomainError(new Error(
      'The domain/default pair of (org.example, MissingKey) does not exist',
    ))).toBe(true)
    expect(isMissingDefaultsDomainError(new Error('defaults exited with status 1: permission denied'))).toBe(false)
  })

  it('accepts only the canonical or namespaced placement-recovery bundle ids', () => {
    expect(isSupportedMenubarBundleId('org.agentseal.codeburn-menubar')).toBe(true)
    expect(isSupportedMenubarBundleId(
      'org.agentseal.codeburn-menubar.recovery.0123456789abcdef'
    )).toBe(true)
    expect(isSupportedMenubarBundleId(
      'org.agentseal.codeburn-menubar.recovery.not-random'
    )).toBe(false)
    expect(isSupportedMenubarBundleId('org.attacker.codeburn-menubar')).toBe(false)
  })

  it('creates a stable recovery namespace from validated entropy', () => {
    expect(createMenubarPlacementRecoveryBundleId('0123456789abcdef')).toBe(
      'org.agentseal.codeburn-menubar.recovery.0123456789abcdef'
    )
    expect(() => createMenubarPlacementRecoveryBundleId('../escape')).toThrow(/16 lowercase hex/)
  })

  it('persists repaired identity across updates and rotates only on explicit repair', () => {
    const repaired = 'org.agentseal.codeburn-menubar.recovery.0123456789abcdef'
    expect(selectMenubarBundleId({ persistedBundleId: repaired })).toBe(repaired)
    expect(selectMenubarBundleId({
      repairPlacement: true,
      persistedBundleId: repaired,
      recoverySuffix: 'fedcba9876543210',
    })).toBe('org.agentseal.codeburn-menubar.recovery.fedcba9876543210')
    expect(selectMenubarBundleId({ persistedBundleId: 'org.attacker.injected' })).toBe(
      'org.agentseal.codeburn-menubar'
    )
    expect(selectMenubarBundleId({
      resetPlacement: true,
      persistedBundleId: repaired,
    })).toBe('org.agentseal.codeburn-menubar')
    expect(() => selectMenubarBundleId({
      repairPlacement: true,
      resetPlacement: true,
    })).toThrow(/cannot be used together/)
  })

  it('uses the installed bundle identity when the persistence sidecar is missing or stale', () => {
    const repaired = createMenubarPlacementRecoveryBundleId('abcdefabcdefabcd')
    expect(resolveActiveMenubarBundleId({ installedBundleId: repaired })).toBe(repaired)
    expect(resolveActiveMenubarBundleId({
      installedBundleId: 'org.agentseal.codeburn-menubar',
      persistedBundleId: repaired,
    })).toBe('org.agentseal.codeburn-menubar')
    expect(() => resolveActiveMenubarBundleId({
      installedBundleId: 'org.attacker.injected',
    })).toThrow(/unsupported installed menubar bundle id/)
  })

  it('allows re-identification only for the ad-hoc release signature', () => {
    expect(isAdHocMenubarSignatureDetails(`
CodeDirectory v=20400 flags=0x2(adhoc)
Signature=adhoc
TeamIdentifier=not set
`)).toBe(true)
    expect(isAdHocMenubarSignatureDetails(`
Authority=Developer ID Application: AgentSeal
TeamIdentifier=ABCDE12345
Runtime Version=26.0.0
`)).toBe(false)
  })

  it('ignores dev zips and pairs the checksum with the versioned zip', () => {
    const release: ReleaseResponse = {
      tag_name: 'mac-v0.9.8',
      assets: [
        asset('CodeBurnMenubar-dev.zip'),
        asset('CodeBurnMenubar-dev.zip.sha256'),
        asset('CodeBurnMenubar-v0.9.8.zip'),
        asset('CodeBurnMenubar-v0.9.8.zip.sha256'),
      ],
    }

    const resolved = resolveMenubarReleaseAssets(release)

    expect(resolved.zip.name).toBe('CodeBurnMenubar-v0.9.8.zip')
    expect(resolved.checksum?.name).toBe('CodeBurnMenubar-v0.9.8.zip.sha256')
  })

  it('fails when a release only contains dev assets', () => {
    const release: ReleaseResponse = {
      tag_name: 'mac-v0.9.8',
      assets: [
        asset('CodeBurnMenubar-dev.zip'),
        asset('CodeBurnMenubar-dev.zip.sha256'),
      ],
    }

    expect(() => resolveMenubarReleaseAssets(release)).toThrow(/versioned zip/)
  })

  it('fails when the versioned checksum is missing', () => {
    const release: ReleaseResponse = {
      tag_name: 'mac-v0.9.8',
      assets: [
        asset('CodeBurnMenubar-v0.9.8.zip'),
      ],
    }

    expect(() => resolveMenubarReleaseAssets(release)).toThrow(/Missing checksum/)
  })

  it('selects the newest mac release instead of the newest repo release', () => {
    const releases: ReleaseResponse[] = [
      {
        tag_name: 'v0.9.9',
        assets: [
          asset('codeburn-0.9.9.tgz'),
        ],
      },
      {
        tag_name: 'mac-v0.9.8',
        assets: [
          asset('CodeBurnMenubar-v0.9.8.zip'),
          asset('CodeBurnMenubar-v0.9.8.zip.sha256'),
        ],
      },
    ]

    const resolved = resolveLatestMenubarReleaseAssets(releases)

    expect(resolved.release.tag_name).toBe('mac-v0.9.8')
    expect(resolved.zip.name).toBe('CodeBurnMenubar-v0.9.8.zip')
  })

  it('builds direct release asset URLs from the CLI version', () => {
    const resolved = resolveVersionedMenubarReleaseAssets('0.9.15')

    expect(resolved.release.tag_name).toBe('mac-v0.9.15')
    expect(resolved.zip.name).toBe('CodeBurnMenubar-v0.9.15.zip')
    expect(resolved.zip.browser_download_url).toBe(
      'https://github.com/getagentseal/codeburn/releases/download/mac-v0.9.15/CodeBurnMenubar-v0.9.15.zip'
    )
    expect(resolved.checksum.name).toBe('CodeBurnMenubar-v0.9.15.zip.sha256')
    expect(resolved.checksum.browser_download_url).toBe(
      'https://github.com/getagentseal/codeburn/releases/download/mac-v0.9.15/CodeBurnMenubar-v0.9.15.zip.sha256'
    )
  })

  it('normalizes a leading v when building direct release URLs', () => {
    const resolved = resolveVersionedMenubarReleaseAssets('v0.9.15')

    expect(resolved.release.tag_name).toBe('mac-v0.9.15')
    expect(resolved.zip.name).toBe('CodeBurnMenubar-v0.9.15.zip')
  })

  it('falls back to the release API only for missing direct assets', () => {
    expect(shouldFallbackToReleaseApi(404)).toBe(true)
    expect(shouldFallbackToReleaseApi(410)).toBe(true)
    expect(shouldFallbackToReleaseApi(403)).toBe(false)
    expect(shouldFallbackToReleaseApi(429)).toBe(false)
    expect(shouldFallbackToReleaseApi(500)).toBe(false)
  })

  it('explains likely rate limiting for GitHub API 403 and 429 errors', () => {
    const headerValues: Record<string, string> = {
      'retry-after': '120',
      'x-ratelimit-reset': '1783539204',
    }
    const headers = { get: (name: string) => headerValues[name] ?? null }

    expect(formatGitHubReleaseLookupError(403, headers)).toContain(
      'GitHub may be rate limiting unauthenticated release API requests'
    )
    expect(formatGitHubReleaseLookupError(403, headers)).toContain('retry-after=120')
    expect(formatGitHubReleaseLookupError(429, headers)).toContain('x-ratelimit-reset=1783539204')
  })

  it('preserves the caller PATH when building the persistent CLI lookup PATH', () => {
    const lookupPath = buildPersistentCodeburnLookupPath('/Users/me/.nvm/versions/node/v22.13.0/bin:/usr/bin')

    expect(lookupPath.split(':')).toContain('/Users/me/.nvm/versions/node/v22.13.0/bin')
    expect(lookupPath.split(':')).toContain('/opt/homebrew/bin')
  })

  it('selects a persistent codeburn binary when npx is first in which output', () => {
    const resolved = resolvePersistentCodeburnPathFromWhichOutput([
      '/Users/me/.npm/_npx/abcd/node_modules/.bin/codeburn',
      '/Users/me/.nvm/versions/node/v22.13.0/bin/codeburn',
    ].join('\n'))

    expect(resolved).toBe('/Users/me/.nvm/versions/node/v22.13.0/bin/codeburn')
  })

  it('shows the install guidance instead of a raw env failure when only npx is available', () => {
    expect(() => resolvePersistentCodeburnPathFromWhichOutput(
      '/Users/me/.npm/_npx/abcd/node_modules/.bin/codeburn'
    )).toThrow(/Install CodeBurn globally first/)
  })

  it('uses HTTPS proxy for GitHub HTTPS downloads', () => {
    const proxyUrl = resolveProxyUrlForUrl('https://api.github.com/repos/getagentseal/codeburn/releases', {
      HTTPS_PROXY: 'http://proxy.company.test:8080',
    })

    expect(proxyUrl).toBe('http://proxy.company.test:8080')
  })

  it('bypasses proxy when NO_PROXY matches the download host', () => {
    const proxyUrl = resolveProxyUrlForUrl('https://api.github.com/repos/getagentseal/codeburn/releases', {
      HTTPS_PROXY: 'http://proxy.company.test:8080',
      NO_PROXY: '.github.com',
    })

    expect(proxyUrl).toBeUndefined()
  })
})

const ZIP_URL = 'https://github.com/getagentseal/codeburn/releases/download/mac-v0.9.19/CodeBurnMenubar-v0.9.19.zip'
const CHECKSUM_URL = `${ZIP_URL}.sha256`

/** Minimal stand-in for the fetch response surface the asset downloads touch. */
function httpResponse(status: number, body?: string, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    body: body === undefined ? null : new Response(body).body,
    text: async () => body ?? '',
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(Buffer.from(text)).digest('hex')
}

/** A 200 whose body delivers `chunk`, then errors - a socket dropped mid-download. */
function droppedStreamResponse(chunk: string, err: Error) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(chunk)) },
    pull(controller) { controller.error(err) },
  })
  return { ok: true, status: 200, headers: { get: () => null }, body, text: async () => chunk }
}

async function fileExists(path: string): Promise<boolean> {
  try { await readFile(path); return true } catch { return false }
}

describe('release asset download retry', () => {
  let sandbox: string
  let sleeps: number[]
  let logs: string[]
  let recorder: { sleep: (ms: number) => Promise<void>; log: (message: string) => void }

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'menubar-installer-'))
    sleeps = []
    logs = []
    recorder = {
      sleep: async (ms: number) => { sleeps.push(ms) },
      log: (message: string) => { logs.push(message) },
    }
  })

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true })
  })

  it('retries a transient 500 zip download and completes on the next attempt', async () => {
    const dest = join(sandbox, 'CodeBurnMenubar-v0.9.19.zip')
    const statuses = [500, 200]
    let calls = 0

    await downloadToFile(ZIP_URL, dest, {
      ...recorder,
      fetchImpl: async () => {
        const status = statuses[calls++]!
        return httpResponse(status, status === 200 ? 'zip-bytes' : 'upstream error')
      },
    })

    expect(calls).toBe(2)
    expect(await readFile(dest, 'utf8')).toBe('zip-bytes')
    expect(sleeps).toEqual([500])
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('HTTP 500')
    expect(logs[0]).toContain('attempt 2 of 3')
  })

  it('retries a transient 500 checksum download, the failure reported in the issue', async () => {
    const archive = join(sandbox, 'CodeBurnMenubar-v0.9.19.zip')
    await writeFile(archive, 'zip-bytes')
    const statuses = [500, 200]
    let calls = 0

    await verifyChecksum(archive, CHECKSUM_URL, {
      ...recorder,
      fetchImpl: async () => {
        const status = statuses[calls++]!
        return httpResponse(status, status === 200 ? `${sha256('zip-bytes')}  CodeBurnMenubar-v0.9.19.zip` : 'boom')
      },
    })

    expect(calls).toBe(2)
    expect(sleeps).toEqual([500])
    expect(logs[0]).toContain('Checksum download failed with HTTP 500')
  })

  it('gives up on a persistent 500 and names the requested URL in the error', async () => {
    let calls = 0

    await expect(verifyChecksum(join(sandbox, 'unused.zip'), CHECKSUM_URL, {
      ...recorder,
      fetchImpl: async () => { calls++; return httpResponse(500) },
    })).rejects.toThrow(CHECKSUM_URL)

    expect(calls).toBe(3)
    expect(sleeps).toEqual([500, 1000])
  })

  it('does not retry a 404 and still routes to the missing-asset fallback', async () => {
    let calls = 0
    let captured: unknown

    await downloadToFile(ZIP_URL, join(sandbox, 'out.zip'), {
      ...recorder,
      fetchImpl: async () => { calls++; return httpResponse(404) },
    }).catch((err: unknown) => { captured = err })

    expect(calls).toBe(1)
    expect(sleeps).toEqual([])
    expect(isMissingDirectAssetError(captured)).toBe(true)
    expect(captured).toBeInstanceOf(Error)
    expect((captured as Error).message).toContain(ZIP_URL)
  })

  it('does not retry a 429 and surfaces the retry-after hint instead', async () => {
    let calls = 0

    await expect(downloadToFile(ZIP_URL, join(sandbox, 'out.zip'), {
      ...recorder,
      fetchImpl: async () => { calls++; return httpResponse(429, undefined, { 'retry-after': '120' }) },
    })).rejects.toThrow(/retry-after=120/)

    expect(calls).toBe(1)
    expect(sleeps).toEqual([])
  })

  it('retries a network-level failure and reports it with the URL when it persists', async () => {
    let calls = 0

    await expect(downloadToFile(ZIP_URL, join(sandbox, 'out.zip'), {
      ...recorder,
      fetchImpl: async () => {
        calls++
        throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
      },
    })).rejects.toThrow(/socket hang up/)

    expect(calls).toBe(3)
    expect(sleeps).toEqual([500, 1000])
    expect(logs).toHaveLength(2)
  })

  it('recovers when a network-level failure clears on the next attempt', async () => {
    const dest = join(sandbox, 'CodeBurnMenubar-v0.9.19.zip')
    let calls = 0

    await downloadToFile(ZIP_URL, dest, {
      ...recorder,
      fetchImpl: async () => {
        calls++
        if (calls === 1) throw Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' })
        return httpResponse(200, 'zip-bytes')
      },
    })

    expect(calls).toBe(2)
    expect(await readFile(dest, 'utf8')).toBe('zip-bytes')
  })

  it('fails a genuine checksum mismatch immediately instead of re-downloading', async () => {
    const archive = join(sandbox, 'CodeBurnMenubar-v0.9.19.zip')
    await writeFile(archive, 'tampered-bytes')
    let calls = 0

    await expect(verifyChecksum(archive, CHECKSUM_URL, {
      ...recorder,
      fetchImpl: async () => {
        calls++
        return httpResponse(200, `${sha256('zip-bytes')}  CodeBurnMenubar-v0.9.19.zip`)
      },
    })).rejects.toThrow(/Checksum mismatch/)

    // The retry budget covers transport only. A digest mismatch must abort on the first look.
    expect(calls).toBe(1)
    expect(sleeps).toEqual([])
  })

  it('honors an overridden attempt budget', async () => {
    let calls = 0

    await expect(downloadToFile(ZIP_URL, join(sandbox, 'out.zip'), {
      ...recorder,
      maxAttempts: 2,
      baseDelayMs: 10,
      fetchImpl: async () => { calls++; return httpResponse(503) },
    })).rejects.toThrow(/HTTP 503/)

    expect(calls).toBe(2)
    expect(sleeps).toEqual([10])
  })

  it('retries a socket dropped mid-download and completes on the next attempt', async () => {
    const dest = join(sandbox, 'CodeBurnMenubar-v0.9.19.zip')
    let calls = 0

    await downloadToFile(ZIP_URL, dest, {
      ...recorder,
      fetchImpl: async () => {
        calls++
        return calls === 1
          ? droppedStreamResponse('partial', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
          : httpResponse(200, 'zip-bytes')
      },
    })

    expect(calls).toBe(2)
    expect(await readFile(dest, 'utf8')).toBe('zip-bytes')
    expect(sleeps).toEqual([500])
    expect(logs.some(l => l.includes('stream failed'))).toBe(true)
  })

  it('gives up on a persistent mid-download failure and leaves no partial file behind', async () => {
    const dest = join(sandbox, 'CodeBurnMenubar-v0.9.19.zip')
    let calls = 0

    await expect(downloadToFile(ZIP_URL, dest, {
      ...recorder,
      fetchImpl: async () => { calls++; return droppedStreamResponse('partial', new Error('socket hang up')) },
    })).rejects.toThrow(/socket hang up/)

    expect(calls).toBe(3)
    expect(sleeps).toEqual([500, 1000])
    expect(await fileExists(dest)).toBe(false)
  })

  it('retries a 2xx response that arrives with no body', async () => {
    const dest = join(sandbox, 'CodeBurnMenubar-v0.9.19.zip')
    let calls = 0

    await downloadToFile(ZIP_URL, dest, {
      ...recorder,
      fetchImpl: async () => { calls++; return calls === 1 ? httpResponse(200) : httpResponse(200, 'zip-bytes') },
    })

    expect(calls).toBe(2)
    expect(await readFile(dest, 'utf8')).toBe('zip-bytes')
  })

  it('clamps a non-finite attempt budget to a single attempt instead of looping', async () => {
    let calls = 0

    await expect(downloadToFile(ZIP_URL, join(sandbox, 'out.zip'), {
      ...recorder,
      maxAttempts: Number.POSITIVE_INFINITY,
      fetchImpl: async () => { calls++; return httpResponse(500) },
    })).rejects.toThrow(/HTTP 500/)

    expect(calls).toBe(1)
    expect(sleeps).toEqual([])
  })

  it('preserves the underlying error as the cause when retries are exhausted', async () => {
    const original = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
    let captured: unknown

    await downloadToFile(ZIP_URL, join(sandbox, 'out.zip'), {
      ...recorder,
      fetchImpl: async () => { throw original },
    }).catch((err: unknown) => { captured = err })

    expect((captured as Error).cause).toBe(original)
  })
})

describe.runIf(process.platform === 'darwin')('placement repair bundle re-identification', () => {
  let sandbox: string
  let appPath: string

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'menubar-reidentify-'))
    appPath = join(sandbox, 'CodeBurnMenubar.app')
    const contents = join(appPath, 'Contents')
    const executable = join(contents, 'MacOS', 'CodeBurnMenubar')
    await mkdir(join(contents, 'MacOS'), { recursive: true })
    await writeFile(executable, '#!/bin/sh\nexit 0\n')
    await chmod(executable, 0o755)
    await writeFile(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>CodeBurnMenubar</string>
<key>CFBundleIdentifier</key><string>org.agentseal.codeburn-menubar</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>\n`)
    await execFileAsync('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', appPath])
  })

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true })
  })

  it('changes only to a supported recovery id and leaves a valid signed bundle', async () => {
    const recoveryID = 'org.agentseal.codeburn-menubar.recovery.0123456789abcdef'
    await reidentifyMenubarBundleForPlacementRecovery(appPath, recoveryID)

    const { stdout } = await execFileAsync('/usr/libexec/PlistBuddy', [
      '-c', 'Print :CFBundleIdentifier', join(appPath, 'Contents', 'Info.plist'),
    ])
    expect(stdout.trim()).toBe(recoveryID)
    await expect(execFileAsync('/usr/bin/codesign', [
      '--verify', '--deep', '--strict', appPath,
    ])).resolves.toBeDefined()
    await expect(reidentifyMenubarBundleForPlacementRecovery(
      appPath,
      'org.attacker.injected',
    )).rejects.toThrow(/unsupported recovery bundle id/)
  })

  it('runs bounded Login Item maintenance only for a capable exact installed identity', async () => {
    const executableDir = join(appPath, 'Contents', 'MacOS')
    const executablePath = join(executableDir, 'CodeBurnMenubar')
    await mkdir(executableDir, { recursive: true })
    await writeFile(executablePath, `#!/bin/sh
case "$1" in
  --codeburn-login-item-status) echo disabled ;;
  --codeburn-unregister-login-item) echo disabled ;;
  --codeburn-register-login-item) echo registered ;;
  *) exit 2 ;;
esac
`)
    await chmod(executablePath, 0o755)

    expect(await installedMenubarSupportsLoginItemMaintenance(appPath)).toBe(false)
    await execFileAsync('/usr/libexec/PlistBuddy', [
      '-c', 'Add :CodeBurnLoginItemMaintenanceVersion integer 1',
      join(appPath, 'Contents', 'Info.plist'),
    ])
    expect(await installedMenubarSupportsLoginItemMaintenance(appPath)).toBe(true)
    await expect(runInstalledMenubarLoginItemMaintenance(
      appPath,
      'org.agentseal.codeburn-menubar',
      'status',
    )).resolves.toBe('disabled')
    await expect(runInstalledMenubarLoginItemMaintenance(
      appPath,
      'org.agentseal.codeburn-menubar',
      'unregister',
    )).resolves.toBe('disabled')
    await expect(runInstalledMenubarLoginItemMaintenance(
      appPath,
      'org.agentseal.codeburn-menubar',
      'register',
    )).resolves.toBe('registered')
    await expect(runInstalledMenubarLoginItemMaintenance(
      appPath,
      createMenubarPlacementRecoveryBundleId('9999999999999999'),
      'status',
    )).rejects.toThrow(/identity is org\.agentseal\.codeburn-menubar/)
  })

  it('terminates a non-responsive Login Item maintenance command', async () => {
    const executableDir = join(appPath, 'Contents', 'MacOS')
    const executablePath = join(executableDir, 'CodeBurnMenubar')
    await mkdir(executableDir, { recursive: true })
    await writeFile(executablePath, '#!/bin/sh\nsleep 2\n')
    await chmod(executablePath, 0o755)
    await execFileAsync('/usr/libexec/PlistBuddy', [
      '-c', 'Add :CodeBurnLoginItemMaintenanceVersion integer 1',
      join(appPath, 'Contents', 'Info.plist'),
    ])

    await expect(runInstalledMenubarLoginItemMaintenance(
      appPath,
      'org.agentseal.codeburn-menubar',
      'status',
      { timeoutMs: 25 },
    )).rejects.toThrow(/timed out after 25ms/)
  })

  it('migrates preferences between recovery identities without touching other domains', async () => {
    const sourceID = createMenubarPlacementRecoveryBundleId('1111111111111111')
    const targetID = createMenubarPlacementRecoveryBundleId('2222222222222222')
    await execFileAsync('/usr/bin/defaults', ['delete', sourceID]).catch(() => {})
    await execFileAsync('/usr/bin/defaults', ['delete', targetID]).catch(() => {})
    try {
      await execFileAsync('/usr/bin/defaults', [
        'write', sourceID, 'CodeBurnDisplayMetric', '-string', 'tokens',
      ])
      await execFileAsync('/usr/bin/defaults', [
        'write', sourceID, 'codeburn.loginItemRegistered', '-bool', 'true',
      ])
      await execFileAsync('/usr/bin/defaults', [
        'write', sourceID, 'NSStatusItem Legacy Ghost Position', '-string', 'poisoned',
      ])
      await migrateMenubarPreferencesForPlacementRecovery(sourceID, targetID, sandbox)

      const { stdout } = await execFileAsync('/usr/bin/defaults', [
        'read', targetID, 'CodeBurnDisplayMetric',
      ])
      expect(stdout.trim()).toBe('tokens')
      await expect(execFileAsync('/usr/bin/defaults', [
        'read', targetID, 'codeburn.loginItemRegistered',
      ])).rejects.toBeDefined()
      await expect(execFileAsync('/usr/bin/defaults', [
        'read', targetID, 'NSStatusItem Legacy Ghost Position',
      ])).rejects.toBeDefined()
    } finally {
      await execFileAsync('/usr/bin/defaults', ['delete', sourceID]).catch(() => {})
      await execFileAsync('/usr/bin/defaults', ['delete', targetID]).catch(() => {})
    }
  })

  it('restores the target preference domain when a prepared migration rolls back', async () => {
    const sourceID = createMenubarPlacementRecoveryBundleId('3333333333333333')
    const targetID = createMenubarPlacementRecoveryBundleId('4444444444444444')
    await execFileAsync('/usr/bin/defaults', ['delete', sourceID]).catch(() => {})
    await execFileAsync('/usr/bin/defaults', ['delete', targetID]).catch(() => {})
    try {
      await execFileAsync('/usr/bin/defaults', [
        'write', sourceID, 'CodeBurnDisplayMetric', '-string', 'tokens',
      ])
      await execFileAsync('/usr/bin/defaults', [
        'write', targetID, 'CodeBurnDisplayMetric', '-string', 'cost',
      ])

      const migration = await prepareMenubarPreferenceMigration(sourceID, targetID, sandbox)
      await migration.apply()
      expect((await execFileAsync('/usr/bin/defaults', [
        'read', targetID, 'CodeBurnDisplayMetric',
      ])).stdout.trim()).toBe('tokens')

      await migration.rollback()
      expect((await execFileAsync('/usr/bin/defaults', [
        'read', targetID, 'CodeBurnDisplayMetric',
      ])).stdout.trim()).toBe('cost')
    } finally {
      await execFileAsync('/usr/bin/defaults', ['delete', sourceID]).catch(() => {})
      await execFileAsync('/usr/bin/defaults', ['delete', targetID]).catch(() => {})
    }
  })

  it('carries an explicit Login Items disable choice to a replacement identity', async () => {
    const sourceID = createMenubarPlacementRecoveryBundleId('7777777777777777')
    const targetID = createMenubarPlacementRecoveryBundleId('8888888888888888')
    await execFileAsync('/usr/bin/defaults', ['delete', sourceID]).catch(() => {})
    await execFileAsync('/usr/bin/defaults', ['delete', targetID]).catch(() => {})
    try {
      await execFileAsync('/usr/bin/defaults', [
        'write', sourceID, 'codeburn.loginItemRegistered', '-bool', 'true',
      ])
      const migration = await prepareMenubarPreferenceMigration(
        sourceID,
        targetID,
        sandbox,
        { preserveLoginDisable: true },
      )
      await migration.apply()

      expect((await execFileAsync('/usr/bin/defaults', [
        'read', targetID, 'codeburn.loginItemRegistered',
      ])).stdout.trim()).toBe('1')
    } finally {
      await execFileAsync('/usr/bin/defaults', ['delete', sourceID]).catch(() => {})
      await execFileAsync('/usr/bin/defaults', ['delete', targetID]).catch(() => {})
    }
  })

  it('sanitizes target placement and preserves disable without a source domain', async () => {
    const sourceID = createMenubarPlacementRecoveryBundleId('aaaaaaaaaaaaaaaa')
    const targetID = createMenubarPlacementRecoveryBundleId('bbbbbbbbbbbbbbbb')
    await execFileAsync('/usr/bin/defaults', ['delete', sourceID]).catch(() => {})
    await execFileAsync('/usr/bin/defaults', ['delete', targetID]).catch(() => {})
    try {
      await execFileAsync('/usr/bin/defaults', [
        'write', targetID, 'NSStatusItem Legacy Ghost Position', '-string', 'poisoned',
      ])
      const migration = await prepareMenubarPreferenceMigration(
        sourceID,
        targetID,
        sandbox,
        { preserveLoginDisable: true },
      )
      await migration.apply()

      expect((await execFileAsync('/usr/bin/defaults', [
        'read', targetID, 'codeburn.loginItemRegistered',
      ])).stdout.trim()).toBe('1')
      await expect(execFileAsync('/usr/bin/defaults', [
        'read', targetID, 'NSStatusItem Legacy Ghost Position',
      ])).rejects.toBeDefined()
    } finally {
      await execFileAsync('/usr/bin/defaults', ['delete', sourceID]).catch(() => {})
      await execFileAsync('/usr/bin/defaults', ['delete', targetID]).catch(() => {})
    }
  })

  it('removes a superseded recovery preference domain only after commit', async () => {
    const sourceID = createMenubarPlacementRecoveryBundleId('5555555555555555')
    const targetID = createMenubarPlacementRecoveryBundleId('6666666666666666')
    await execFileAsync('/usr/bin/defaults', ['delete', sourceID]).catch(() => {})
    await execFileAsync('/usr/bin/defaults', ['delete', targetID]).catch(() => {})
    try {
      await execFileAsync('/usr/bin/defaults', [
        'write', sourceID, 'CodeBurnDisplayMetric', '-string', 'tokens',
      ])

      const migration = await prepareMenubarPreferenceMigration(sourceID, targetID, sandbox)
      await migration.apply()
      await migration.commit()

      await expect(execFileAsync('/usr/bin/defaults', [
        'read', sourceID, 'CodeBurnDisplayMetric',
      ])).rejects.toBeDefined()
      expect((await execFileAsync('/usr/bin/defaults', [
        'read', targetID, 'CodeBurnDisplayMetric',
      ])).stdout.trim()).toBe('tokens')
    } finally {
      await execFileAsync('/usr/bin/defaults', ['delete', sourceID]).catch(() => {})
      await execFileAsync('/usr/bin/defaults', ['delete', targetID]).catch(() => {})
    }
  })

  it('restores the previous app and state when replacement cannot commit', async () => {
    const targetPath = join(sandbox, 'Installed.app')
    const stagedPath = join(sandbox, 'Staged.app')
    await mkdir(targetPath)
    await mkdir(stagedPath)
    await writeFile(join(targetPath, 'marker'), 'old')
    await writeFile(join(stagedPath, 'marker'), 'new')
    let restoredState = false

    await expect(replaceMenubarBundleWithRollback({
      stagedPath,
      targetPath,
      commitState: async () => { throw new Error('disk full') },
      restoreState: async () => { restoredState = true },
      launch: async () => { throw new Error('must not launch') },
    })).rejects.toThrow(/disk full/)

    expect(await readFile(join(targetPath, 'marker'), 'utf8')).toBe('old')
    expect(restoredState).toBe(true)
    expect((await readdir(sandbox)).filter(name => name.includes('backup'))).toEqual([])
  })

  it('commits and launches the new app without leaving a backup bundle', async () => {
    const targetPath = join(sandbox, 'Installed.app')
    const stagedPath = join(sandbox, 'Staged.app')
    await mkdir(targetPath)
    await mkdir(stagedPath)
    await writeFile(join(targetPath, 'marker'), 'old')
    await writeFile(join(stagedPath, 'marker'), 'new')
    let launched = false

    await replaceMenubarBundleWithRollback({
      stagedPath,
      targetPath,
      commitState: async () => {},
      restoreState: async () => {},
      launch: async () => { launched = true },
    })

    expect(await readFile(join(targetPath, 'marker'), 'utf8')).toBe('new')
    expect(launched).toBe(true)
    expect((await readdir(sandbox)).filter(name => name.includes('backup'))).toEqual([])
  })

  it('keeps the committed new app when only the launch request fails', async () => {
    const targetPath = join(sandbox, 'Installed.app')
    const stagedPath = join(sandbox, 'Staged.app')
    await mkdir(targetPath)
    await mkdir(stagedPath)
    await writeFile(join(targetPath, 'marker'), 'old')
    await writeFile(join(stagedPath, 'marker'), 'new')
    let restoredState = false

    await expect(replaceMenubarBundleWithRollback({
      stagedPath,
      targetPath,
      commitState: async () => {},
      restoreState: async () => { restoredState = true },
      launch: async () => { throw new Error('launch request failed') },
    })).rejects.toThrow(/launch request failed/)

    expect(await readFile(join(targetPath, 'marker'), 'utf8')).toBe('new')
    expect(restoredState).toBe(false)
  })

  it('restores identity state even when the previous bundle cannot be restored', async () => {
    const targetPath = join(sandbox, 'Installed.app')
    const stagedPath = join(sandbox, 'Staged.app')
    const backupPath = `${targetPath}.codeburn-backup-${process.pid}`
    await mkdir(targetPath)
    await mkdir(stagedPath)
    let restoredState = false

    await expect(replaceMenubarBundleWithRollback({
      stagedPath,
      targetPath,
      commitState: async () => {
        await rm(backupPath, { recursive: true, force: true })
        throw new Error('identity commit failed')
      },
      restoreState: async () => { restoredState = true },
      launch: async () => { throw new Error('must not launch') },
    })).rejects.toThrow(/could not be fully restored/)

    expect(restoredState).toBe(true)
  })
})

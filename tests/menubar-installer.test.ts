import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildPersistentCodeburnLookupPath,
  downloadToFile,
  formatGitHubReleaseLookupError,
  hasRunnableRecordedCli,
  isMissingDirectAssetError,
  leftoverBundleLines,
  resolveLatestMenubarReleaseAssets,
  pidIsLive,
  placeMenubarBundle,
  recoverPlacements,
  resolveMacInstallTarget,
  resolveMenubarReleaseAssets,
  resolvePersistentCodeburnPathFromWhichOutput,
  resolveProxyUrlForUrl,
  resolveVersionedMenubarReleaseAssets,
  shouldFallbackToReleaseApi,
  verifyChecksum,
  type ReleaseResponse,
} from '../src/menubar-installer.js'

function asset(name: string) {
  return { name, browser_download_url: `https://example.test/${name}` }
}

describe('resolveMenubarReleaseAssets', () => {
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
    // The fallback prefixes appended here are POSIX-only; Windows has no
    // system-wide bin dir to add, so there the caller PATH comes back untouched.
    if (process.platform === 'win32') expect(lookupPath).toBe('/Users/me/.nvm/versions/node/v22.13.0/bin:/usr/bin')
    else expect(lookupPath.split(':')).toContain('/opt/homebrew/bin')
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

describe('hasRunnableRecordedCli', () => {
  // The desktop app writes a launcher for the CLI it carries and records it here before it
  // asks for an install; `codeburn menubar` keeps that record rather than refusing when
  // nothing named codeburn is on PATH (a .dmg-only machine).
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'codeburn-cli-record-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('is false when nothing was ever recorded', async () => {
    expect(await hasRunnableRecordedCli(join(dir, 'missing.v1'))).toBe(false)
  })

  it('is false for a relative path', async () => {
    const record = join(dir, 'record.v1')
    await writeFile(record, 'codeburn\n')
    expect(await hasRunnableRecordedCli(record)).toBe(false)
  })

  it('is false when the recorded file is gone', async () => {
    const record = join(dir, 'record.v1')
    await writeFile(record, `${join(dir, 'gone.sh')}\n`)
    expect(await hasRunnableRecordedCli(record)).toBe(false)
  })

  // Windows fs.access(X_OK) ignores the executable bit; this launcher guard is a
  // macOS-only install path, so the not-executable case is only meaningful on Unix.
  it.skipIf(process.platform === 'win32')('is false when the recorded file is not executable', async () => {
    const launcher = join(dir, 'launcher.sh')
    await writeFile(launcher, '#!/bin/sh\n', { mode: 0o644 })
    const record = join(dir, 'record.v1')
    await writeFile(record, `${launcher}\n`)
    expect(await hasRunnableRecordedCli(record)).toBe(false)
  })

  it('is true for an absolute executable file, trailing newline and all', async () => {
    const launcher = join(dir, 'launcher.sh')
    await writeFile(launcher, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const record = join(dir, 'record.v1')
    await writeFile(record, `${launcher}\n`)
    expect(await hasRunnableRecordedCli(record)).toBe(true)
  })
})

// The desktop card and `codeburn menubar` have to agree on which bundle is "the" install,
// or a user with a copy in /Applications gets a second one, and a second login item, in
// ~/Applications.
describe.skipIf(process.platform === 'win32')('resolveMacInstallTarget', () => {
  let root: string
  let userApps: string
  let systemApps: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'codeburn-menubar-target-'))
    userApps = join(root, 'user-applications')
    systemApps = join(root, 'system-applications')
    await mkdir(userApps, { recursive: true })
    await mkdir(systemApps, { recursive: true })
  })
  afterEach(async () => {
    await chmod(systemApps, 0o755).catch(() => {})
    await rm(root, { recursive: true, force: true })
  })

  const bundle = (dir: string) => join(dir, 'CodeBurnMenubar.app')
  const install = async (dir: string) => { await mkdir(bundle(dir), { recursive: true }) }

  it('installs into ~/Applications when nothing is installed anywhere', async () => {
    expect(await resolveMacInstallTarget([userApps, systemApps])).toEqual({
      targetPath: bundle(userApps), installedPath: null, found: [],
    })
  })

  it('replaces a writable copy in /Applications where it already is', async () => {
    await install(systemApps)
    expect(await resolveMacInstallTarget([userApps, systemApps])).toEqual({
      targetPath: bundle(systemApps), installedPath: bundle(systemApps), found: [bundle(systemApps)],
    })
  })

  // No sudo, ever: fall back to ~/Applications and name the copy left behind.
  it('falls back to ~/Applications when /Applications cannot be written', async () => {
    await install(systemApps)
    await chmod(systemApps, 0o555)
    expect(await resolveMacInstallTarget([userApps, systemApps])).toEqual({
      targetPath: bundle(userApps), installedPath: bundle(systemApps), found: [bundle(systemApps)],
    })
  })

  // Without --force nothing is installed, so what gets opened is installedPath, never
  // targetPath: here targetPath is a fallback for an install that is not happening, and
  // `open` on it would exit 1 and fail the command with the app sitting in /Applications.
  it('names the copy that exists, not the fallback, when the only copy cannot be replaced', async () => {
    await install(systemApps)
    await chmod(systemApps, 0o555)
    const resolved = await resolveMacInstallTarget([userApps, systemApps])
    expect(await stat(resolved.installedPath!).catch(() => null)).not.toBeNull()
    expect(await stat(resolved.targetPath).catch(() => null)).toBeNull()
    // And the copy being opened is not also reported as one to move to the Trash.
    expect(resolved.found.filter(path => path !== resolved.installedPath)).toEqual([])
  })

  it('replaces the copy the desktop card would find and reports the other', async () => {
    await install(userApps)
    await install(systemApps)
    expect(await resolveMacInstallTarget([userApps, systemApps])).toEqual({
      targetPath: bundle(userApps), installedPath: bundle(userApps), found: [bundle(userApps), bundle(systemApps)],
    })
  })
})

// Replacing a bundle used to be rm(old) then rename(new): a rename that fails — EXDEV when
// staging and Applications are on different volumes, EPERM, a full disk — left the user with
// no menu bar app at all.
describe.skipIf(process.platform === 'win32')('placeMenubarBundle', () => {
  let root: string
  let staged: string
  let target: string

  const marker = (app: string) => join(app, 'Contents', 'marker')
  const readMarker = (app: string) => readFile(marker(app), 'utf-8')
  const makeBundle = async (app: string, text: string) => {
    await mkdir(join(app, 'Contents'), { recursive: true })
    await writeFile(marker(app), text, 'utf-8')
  }
  const exdev = () => Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' })
  const siblings = async () => (await readdir(dirname(target))).sort()

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'codeburn-menubar-place-'))
    staged = join(root, 'staging', 'CodeBurnMenubar.app')
    target = join(root, 'Applications', 'CodeBurnMenubar.app')
    await mkdir(dirname(target), { recursive: true })
    await makeBundle(staged, 'new')
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('renames the staged bundle into place and removes the copy it replaced', async () => {
    await makeBundle(target, 'old')
    await placeMenubarBundle(staged, target)
    expect(await readMarker(target)).toBe('new')
    expect(await siblings()).toEqual(['CodeBurnMenubar.app'])
  })

  it('copies into a sibling and renames that into place when the move crosses a volume', async () => {
    await makeBundle(target, 'old')
    const verified: string[] = []
    await placeMenubarBundle(staged, target, {
      rename: async (from, to) => { if (from === staged) throw exdev(); await rename(from, to) },
      verify: async (app) => { verified.push(app) },
    })
    expect(await readMarker(target)).toBe('new')
    // The staged source is gone, the aside copy is gone, and the final bundle was verified.
    expect(await stat(staged).catch(() => null)).toBeNull()
    expect(await siblings()).toEqual(['CodeBurnMenubar.app'])
    expect(verified).toEqual([target])
  })

  it('puts the bundle it replaced back, untouched, when the placement fails', async () => {
    await makeBundle(target, 'old')
    const boom = Object.assign(new Error('read-only file system'), { code: 'EPERM' })
    await expect(placeMenubarBundle(staged, target, {
      rename: async (from, to) => { if (from === staged) throw boom; await rename(from, to) },
    })).rejects.toThrow(boom)
    expect(await readMarker(target)).toBe('old')
    expect(await siblings()).toEqual(['CodeBurnMenubar.app'])
  })

  // The copy is where a signature breaks, so a bundle that no longer verifies is not an install.
  it('restores the old bundle when the copied one fails verification', async () => {
    await makeBundle(target, 'old')
    await expect(placeMenubarBundle(staged, target, {
      rename: async (from, to) => { if (from === staged) throw exdev(); await rename(from, to) },
      verify: async () => { throw new Error('code object is not signed at all') },
    })).rejects.toThrow(/not signed/)
    expect(await readMarker(target)).toBe('old')
    expect(await siblings()).toEqual(['CodeBurnMenubar.app'])
  })

  // Silence here is the worst case: no bundle at the real name, the user's app under a
  // hidden one, and nothing said about it.
  it('says where the old bundle is when it cannot be put back either', async () => {
    await makeBundle(target, 'old')
    const said: string[] = []
    await expect(placeMenubarBundle(staged, target, {
      rename: async (from, to) => {
        if (to !== target) { await rename(from, to); return }
        throw from === staged ? new Error('nope') : new Error('restore failed')
      },
      log: (line) => { said.push(line) },
    })).rejects.toThrow('nope')
    expect(said).toHaveLength(1)
    expect(said[0]).toContain(`.CodeBurnMenubar.app.old-${process.pid}`)
    expect(said[0]).toContain(target)
    // And it is still on disk under that name, so the instructions work.
    expect((await readdir(dirname(target)))[0]).toContain('.old-')
  })

  it('installs onto an empty Applications folder and leaves nothing behind on failure', async () => {
    await placeMenubarBundle(staged, target)
    expect(await readMarker(target)).toBe('new')

    await makeBundle(staged, 'newer')
    await rm(target, { recursive: true, force: true })
    await expect(placeMenubarBundle(staged, target, {
      rename: async () => { throw new Error('nope') },
    })).rejects.toThrow('nope')
    expect(await siblings()).toEqual([])
  })
})

// An install that is killed between the two renames leaves the user's app under a hidden
// name; a second install running at the same time would fight this one over the same files.
// Both are answered by the pid in the name.
describe.skipIf(process.platform === 'win32')('recoverPlacements', () => {
  let dir: string
  const app = () => join(dir, 'CodeBurnMenubar.app')
  const aside = (pid: number) => join(dir, `.CodeBurnMenubar.app.old-${pid}`)
  const staged = (pid: number) => join(dir, `.CodeBurnMenubar.app.new-${pid}`)
  const DEAD = 424242
  const bundleAt = async (path: string, text: string) => {
    await mkdir(join(path, 'Contents'), { recursive: true })
    await writeFile(join(path, 'Contents', 'marker'), text, 'utf-8')
  }

  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'codeburn-menubar-recover-')) })
  afterEach(async () => {
    await chmod(dir, 0o755).catch(() => {})
    await rm(dir, { recursive: true, force: true })
  })

  it('refuses to run while another install holds the directory, and changes nothing', async () => {
    await bundleAt(aside(DEAD), 'old')
    await bundleAt(staged(777), 'half-copied')
    const refusal = recoverPlacements([dir], { isLivePid: pid => pid === 777 })
    await expect(refusal).rejects.toThrow(/pid 777/)
    // Naming the file is the difference between a user who can unstick themselves and one who cannot.
    await expect(refusal).rejects.toThrow(staged(777))
    // The dead-pid orphan is still there: the abort happens before anything is touched.
    expect((await readdir(dir)).sort()).toEqual(['.CodeBurnMenubar.app.new-777', `.CodeBurnMenubar.app.old-${DEAD}`])
  })

  // A placement outlives its install whenever the last cleanup fails, and pids get reused.
  // Without an age limit, one recycled pid refuses every install on that machine forever.
  it('treats a placement whose pid was recycled long ago as dead, and recovers from it', async () => {
    await bundleAt(aside(DEAD), 'the users app')
    const anHourOn = Date.now() + 60 * 60_000
    await recoverPlacements([dir], { isLivePid: () => true, now: () => anHourOn })
    expect(await readFile(join(app(), 'Contents', 'marker'), 'utf-8')).toBe('the users app')
    expect(await readdir(dir)).toEqual(['CodeBurnMenubar.app'])
  })

  it('still refuses when the live pid put its placement there just now', async () => {
    await bundleAt(staged(777), 'half-copied')
    await expect(recoverPlacements([dir], { isLivePid: () => true, now: () => Date.now() }))
      .rejects.toThrow(/is working on/)
  })

  // An Applications folder we cannot write to is not a reason to fail the whole install:
  // the install either lands somewhere else or fails later with a message of its own.
  it('carries on, saying so, when an orphan cannot be cleared', async () => {
    await bundleAt(aside(DEAD), 'old')
    await chmod(dir, 0o555)
    const said: string[] = []
    await recoverPlacements([dir], { isLivePid: () => false, log: (line) => { said.push(line) } })
    expect(said).toHaveLength(1)
    expect(said[0]).toContain(aside(DEAD))
    await chmod(dir, 0o755)
  })

  it('puts the app back when an install was killed between the two renames', async () => {
    await bundleAt(aside(DEAD), 'the users app')
    await recoverPlacements([dir], { isLivePid: () => false })
    expect(await readFile(join(app(), 'Contents', 'marker'), 'utf-8')).toBe('the users app')
    expect(await readdir(dir)).toEqual(['CodeBurnMenubar.app'])
  })

  it('clears what a dead install left behind once the real bundle is back', async () => {
    await bundleAt(app(), 'new')
    await bundleAt(aside(DEAD), 'old')
    await bundleAt(staged(DEAD), 'half-copied')
    await recoverPlacements([dir], { isLivePid: () => false })
    expect(await readFile(join(app(), 'Contents', 'marker'), 'utf-8')).toBe('new')
    expect(await readdir(dir)).toEqual(['CodeBurnMenubar.app'])
  })

  // A killed install into /Applications must not read as "nothing installed": that is what
  // would quietly move the app to ~/Applications on the next run.
  it('recovers before the install target is resolved, so the app keeps its folder', async () => {
    const userApps = join(dir, 'user')
    const systemApps = join(dir, 'system')
    await mkdir(userApps, { recursive: true })
    await mkdir(systemApps, { recursive: true })
    await bundleAt(join(systemApps, '.CodeBurnMenubar.app.old-424242'), 'the users app')

    await recoverPlacements([userApps, systemApps], { isLivePid: () => false })
    const resolved = await resolveMacInstallTarget([userApps, systemApps])
    expect(resolved.targetPath).toBe(join(systemApps, 'CodeBurnMenubar.app'))
    expect(resolved.installedPath).toBe(join(systemApps, 'CodeBurnMenubar.app'))
  })

  it('ignores a directory that is not there and anything that is not a placement', async () => {
    await bundleAt(app(), 'new')
    await writeFile(join(dir, '.DS_Store'), '', 'utf-8')
    await recoverPlacements([join(dir, 'missing'), dir], { isLivePid: () => false })
    expect((await readdir(dir)).sort()).toEqual(['.DS_Store', 'CodeBurnMenubar.app'])
  })
})

describe('pidIsLive', () => {
  it('is true for a pid we can signal', () => {
    expect(pidIsLive(process.pid)).toBe(true)
  })

  // Sending nothing (signal 0) to a pid nobody holds.
  it('is false for a pid that is not running', () => {
    expect(pidIsLive(2 ** 31 - 1)).toBe(false)
  })

  // A second `codeburn menubar` runs as the same user, so a pid we may not signal is not
  // one of ours: it has been recycled by somebody else's process.
  it('is false for a pid we are not allowed to signal', () => {
    const denied = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    })
    try {
      expect(pidIsLive(4242)).toBe(false)
    } finally {
      denied.mockRestore()
    }
  })
})

describe('leftoverBundleLines', () => {
  const path = '/Applications/CodeBurnMenubar.app'

  it('tells a terminal in prose and nothing else', () => {
    expect(leftoverBundleLines([path], {})).toEqual([
      `An older copy is still at ${path}. Move it to the Trash; CodeBurn will not delete it for you.`,
    ])
  })

  it('adds a machine-readable twin for the desktop app', () => {
    expect(leftoverBundleLines([path], { CODEBURN_PROGRESS: '1' })[1]).toBe(`CODEBURN_LEFTOVER ${path}`)
  })
})

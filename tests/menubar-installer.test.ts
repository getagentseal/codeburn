import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildPersistentCodeburnLookupPath,
  downloadToFile,
  formatGitHubReleaseLookupError,
  hasRunnableRecordedCli,
  isMissingDirectAssetError,
  resolveLatestMenubarReleaseAssets,
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

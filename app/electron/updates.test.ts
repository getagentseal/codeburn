// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import { compareSemver, createUpdateChecker, fetchReleases, pickLatestDesktopVersion } from './updates'

const CURRENT = '0.9.16'

function release(tag: string) {
  return { tag_name: tag }
}

describe('compareSemver', () => {
  it.each([
    ['0.9.17', '0.9.16', 1],
    ['0.10.0', '0.9.16', 1],
    ['1.0.0', '0.9.16', 1],
    ['0.9.16', '0.9.16', 0],
    ['0.9.15', '0.9.16', -1],
    ['0.9.9', '0.9.16', -1], // string sort would rank "9" > "16"; numeric must not
  ])('compareSemver(%s, %s) === %d', (a, b, expected) => {
    expect(Math.sign(compareSemver(a, b))).toBe(expected)
  })
})

describe('pickLatestDesktopVersion', () => {
  it('picks the newest desktop-v tag by semver, ignoring non-desktop tags', () => {
    const picked = pickLatestDesktopVersion([
      release('v0.9.20'), // CLI release — ignored
      release('mac-v0.9.18'), // menubar release — ignored
      release('desktop-v0.9.15'),
      release('desktop-v0.9.17'),
      release('desktop-v0.9.16'),
    ])
    expect(picked).toEqual({ version: '0.9.17', tag: 'desktop-v0.9.17' })
  })

  it('returns null when no desktop-v release is present', () => {
    expect(pickLatestDesktopVersion([release('v1.2.3'), release('mac-v0.9.9')])).toBeNull()
  })

  it('rejects malformed / prerelease-shaped desktop tags', () => {
    expect(pickLatestDesktopVersion([release('desktop-v0.9'), release('desktop-v1.0.0-rc1')])).toBeNull()
  })
})

describe('createUpdateChecker', () => {
  const checker = (releases: unknown[]) =>
    createUpdateChecker({ currentVersion: CURRENT, fetchReleasesImpl: async () => releases as never })

  it('never asks GitHub for a store install, which the Store updates on its own schedule', async () => {
    const fetchReleasesImpl = vi.fn(async () => [release('desktop-v0.9.17')] as never)
    const store = createUpdateChecker({ currentVersion: CURRENT, storeManaged: true, fetchReleasesImpl })
    expect(await store.check()).toEqual({ currentVersion: CURRENT, latestVersion: null, updateAvailable: false, tag: null, storeManaged: true })
    expect(await store.getStatus()).toMatchObject({ updateAvailable: false, storeManaged: true })
    expect(fetchReleasesImpl).not.toHaveBeenCalled()
  })

  it('flags an update when a newer desktop release exists', async () => {
    const status = await checker([release('desktop-v0.9.17')]).getStatus()
    expect(status).toEqual({ currentVersion: '0.9.16', latestVersion: '0.9.17', updateAvailable: true, tag: 'desktop-v0.9.17' })
  })

  it.each(['0.10.0', '1.0.0'])('flags an update for a %s release', async version => {
    const status = await checker([release(`desktop-v${version}`)]).getStatus()
    expect(status).toMatchObject({ updateAvailable: true, latestVersion: version })
  })

  it('reports no update for the same version (tag suppressed)', async () => {
    const status = await checker([release('desktop-v0.9.16')]).getStatus()
    expect(status).toEqual({ currentVersion: '0.9.16', latestVersion: '0.9.16', updateAvailable: false, tag: null })
  })

  it('reports no update for an older release', async () => {
    const status = await checker([release('desktop-v0.9.15')]).getStatus()
    expect(status).toMatchObject({ updateAvailable: false, latestVersion: '0.9.15' })
  })

  it('is a silent no-op on a fetch error and retries on the next cycle', async () => {
    let calls = 0
    const check = createUpdateChecker({
      currentVersion: CURRENT,
      fetchReleasesImpl: async () => {
        calls += 1
        if (calls === 1) throw new Error('offline')
        return [release('desktop-v0.9.17')] as never
      },
    })
    const first = await check.getStatus()
    expect(first).toMatchObject({ updateAvailable: false, latestVersion: null }) // error: no crash, no update
    const second = await check.getStatus() // retries because the error did not stamp lastCheckedAt
    expect(second).toMatchObject({ updateAvailable: true, latestVersion: '0.9.17' })
    expect(calls).toBe(2)
  })

  it('serves the cached status within the 24h interval, then re-checks after it', async () => {
    let clock = 1_000
    let calls = 0
    const check = createUpdateChecker({
      currentVersion: CURRENT,
      now: () => clock,
      fetchReleasesImpl: async () => {
        calls += 1
        return [release('desktop-v0.9.17')] as never
      },
    })
    await check.getStatus()
    expect(calls).toBe(1)
    clock += 60_000 // <24h later
    await check.getStatus()
    expect(calls).toBe(1) // served from cache
    clock += 24 * 60 * 60 * 1000 // past the interval
    await check.getStatus()
    expect(calls).toBe(2)
  })
})

describe('fetchReleases', () => {
  it('reads the releases feed with no auth or app-identifying headers', async () => {
    const fakeFetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify([{ tag_name: 'desktop-v0.9.17' }]), { status: 200 }))
    const result = await fetchReleases(new AbortController().signal, fakeFetch as unknown as typeof fetch)
    expect(result).toEqual([{ tag_name: 'desktop-v0.9.17' }])
    const [url, init] = fakeFetch.mock.calls[0]!
    expect(String(url)).toContain('api.github.com/repos/getagentseal/codeburn/releases')
    // No custom headers at all → no Authorization, no app-identifying UA override.
    expect(init?.headers).toBeUndefined()
  })

  it('throws on a non-2xx response so the checker treats it as a no-op', async () => {
    const fakeFetch = vi.fn(async () => new Response('rate limited', { status: 403 }))
    await expect(fetchReleases(new AbortController().signal, fakeFetch as unknown as typeof fetch)).rejects.toThrow(/403/)
  })

  it('tolerates a non-array body', async () => {
    const fakeFetch = vi.fn(async () => new Response(JSON.stringify({ message: 'oops' }), { status: 200 }))
    expect(await fetchReleases(new AbortController().signal, fakeFetch as unknown as typeof fetch)).toEqual([])
  })
})

import { describe, expect, it, vi } from 'vitest'

vi.mock('../lib/ipc', () => ({
  codeburn: { platform: 'linux', arch: 'x64' },
}))

import { directDownloadUrl, MICROSOFT_STORE_URL, releasePageUrl, updateDownloadUrl } from './useUpdateStatus'

const TAG = 'desktop-v0.9.19'
const BASE = 'https://github.com/getagentseal/codeburn/releases/download/desktop-v0.9.19'

describe('directDownloadUrl', () => {
  it('maps macOS arm64 to the arm64 dmg', () => {
    expect(directDownloadUrl(TAG, 'darwin', 'arm64')).toBe(`${BASE}/CodeBurn-0.9.19-arm64.dmg`)
  })

  it('maps macOS x64 to the plain dmg', () => {
    expect(directDownloadUrl(TAG, 'darwin', 'x64')).toBe(`${BASE}/CodeBurn-0.9.19.dmg`)
  })

  it('maps Windows to the official Microsoft Store regardless of arch', () => {
    expect(directDownloadUrl(TAG, 'win32', 'x64')).toBe(MICROSOFT_STORE_URL)
    expect(directDownloadUrl(TAG, 'win32', undefined)).toBe(MICROSOFT_STORE_URL)
  })

  it('returns null for Linux (three formats, the user picks on the page)', () => {
    expect(directDownloadUrl(TAG, 'linux', 'x64')).toBeNull()
  })

  it('returns null for unknown platforms, missing mac arch, and foreign tags', () => {
    expect(directDownloadUrl(TAG, 'freebsd', 'x64')).toBeNull()
    expect(directDownloadUrl(TAG, 'darwin', undefined)).toBeNull()
    expect(directDownloadUrl('mac-v0.9.19', 'darwin', 'arm64')).toBeNull()
  })
})

describe('updateDownloadUrl fallback', () => {
  it('falls back to the release page when no direct asset fits', () => {
    // The mocked bridge reports linux, where no single asset fits, so the
    // click target is the release page.
    expect(releasePageUrl(TAG)).toBe('https://github.com/getagentseal/codeburn/releases/tag/desktop-v0.9.19')
    expect(updateDownloadUrl(TAG)).toBe(releasePageUrl(TAG))
  })
})

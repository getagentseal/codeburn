import { describe, expect, it } from 'vitest'
import {
  buildPersistentCodeburnLookupPath,
  resolveLatestMenubarReleaseAssets,
  resolveMenubarReleaseAssets,
  resolvePersistentCodeburnPathFromWhichOutput,
  resolveProxyUrlForUrl,
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

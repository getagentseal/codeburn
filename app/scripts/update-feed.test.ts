import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('./update-feed.mjs', import.meta.url))

const FEED = `version: 1.2.3
files:
  - url: CodeBurn-1.2.3-arm64-mac.zip
    sha512: abc==
    size: 10
  - url: CodeBurn-1.2.3-mac.zip
    sha512: def==
    size: 11
path: CodeBurn-1.2.3-arm64-mac.zip
sha512: abc==
releaseDate: '2026-10-07T00:00:00.000Z'
`

function run(feed: string, assets: string[], tag = 'desktop-v1.2.3') {
  const dir = mkdtempSync(join(tmpdir(), 'codeburn-update-feed-'))
  const file = join(dir, 'latest-mac.yml')
  const manifest = join(dir, 'assets.json')
  writeFileSync(file, feed)
  writeFileSync(manifest, JSON.stringify(assets))
  const result = spawnSync(process.execPath, [script, '--tag', tag, '--release-assets', manifest, file], { encoding: 'utf8' })
  return { ...result, feed: readFileSync(file, 'utf8') }
}

describe('update-feed', () => {
  it('points every file at the tagged release and leaves hashes alone', () => {
    const result = run(FEED, ['CodeBurn-1.2.3-arm64-mac.zip', 'CodeBurn-1.2.3-mac.zip'])
    const base = 'https://github.com/getagentseal/codeburn/releases/download/desktop-v1.2.3'
    expect(result.status).toBe(0)
    expect(result.feed).toContain(`  - url: ${base}/CodeBurn-1.2.3-arm64-mac.zip\n    sha512: abc==`)
    expect(result.feed).toContain(`  - url: ${base}/CodeBurn-1.2.3-mac.zip`)
    expect(result.feed).toContain(`path: ${base}/CodeBurn-1.2.3-arm64-mac.zip\nsha512: abc==`)
  })

  it('refuses a feed naming a file the release does not have', () => {
    const result = run(FEED, ['CodeBurn-1.2.3-arm64-mac.zip'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('desktop-v1.2.3 has no asset named CodeBurn-1.2.3-mac.zip')
    expect(result.feed).toBe(FEED)
  })

  it('refuses a feed built for another version', () => {
    const result = run(FEED, ['CodeBurn-1.2.3-arm64-mac.zip', 'CodeBurn-1.2.3-mac.zip'], 'desktop-v1.2.4')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('feed version 1.2.3 does not match desktop-v1.2.4')
  })
})

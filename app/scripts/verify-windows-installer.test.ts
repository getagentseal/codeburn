import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { rootFromModuleUrl } from './windows-installer-paths.mjs'

const verifier = new URL('./verify-windows-installer.mjs', import.meta.url)
const verifierPath = fileURLToPath(verifier)

function fixture(options: {
  appVersion?: string
  rootVersion?: string
  files?: string[]
  tag?: string
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'codeburn-windows-manifest-'))
  const appDir = join(root, 'app')
  const releaseDir = join(appDir, 'release')
  mkdirSync(releaseDir, { recursive: true })

  const appVersion = options.appVersion ?? '1.2.3'
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: options.rootVersion ?? appVersion }))
  writeFileSync(join(appDir, 'package.json'), JSON.stringify({ version: appVersion }))
  for (const file of options.files ?? [
    `CodeBurn-Setup-${appVersion}.exe`,
    `CodeBurn-Setup-${appVersion}.exe.blockmap`,
  ]) {
    const path = join(releaseDir, file)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, 'fixture')
  }

  const args = [verifierPath, '--root', root, '--artifacts', releaseDir]
  if (options.tag) args.push('--tag', options.tag)
  return spawnSync(process.execPath, args, { encoding: 'utf8' })
}

function releaseFixture(files: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'codeburn-windows-release-'))
  const assets = join(root, 'assets.json')
  writeFileSync(assets, JSON.stringify(files))
  return spawnSync(process.execPath, [
    verifierPath,
    '--tag',
    'desktop-v1.2.3',
    '--release-assets',
    assets,
  ], { encoding: 'utf8' })
}

describe('Windows installer release manifest verifier', () => {
  it('converts a Windows module URL into a valid drive-letter repository root', () => {
    expect(rootFromModuleUrl(
      'file:///D:/a/codeburn/codeburn/app/scripts/verify-windows-installer.mjs',
      true,
    )).toBe('D:\\a\\codeburn\\codeburn')
  })

  it('accepts one exact installer and blockmap for matching package versions and tag', () => {
    const result = fixture({ tag: 'desktop-v1.2.3' })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Windows installer manifest verified for 1.2.3')
  })

  it('rejects a desktop tag that does not match the app version', () => {
    const result = fixture({ tag: 'desktop-v1.2.4' })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('desktop-v1.2.4 does not match app version 1.2.3')
  })

  it('rejects divergent root and app versions', () => {
    const result = fixture({ rootVersion: '1.2.2' })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('root version 1.2.2 does not match app version 1.2.3')
  })

  it('rejects a missing installer blockmap', () => {
    const result = fixture({ files: ['CodeBurn-Setup-1.2.3.exe'] })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('expected exactly one CodeBurn-Setup-1.2.3.exe.blockmap, found 0')
  })

  it('requires installer artifacts at the documented top-level output', () => {
    const result = fixture({
      files: [
        'CodeBurn-Setup-1.2.3.exe.blockmap',
        'duplicate/CodeBurn-Setup-1.2.3.exe',
      ],
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('expected exactly one CodeBurn-Setup-1.2.3.exe, found 0')
  })

  it('rejects stale installer artifacts from another version', () => {
    const result = fixture({
      files: [
        'CodeBurn-Setup-1.2.3.exe',
        'CodeBurn-Setup-1.2.3.exe.blockmap',
        'CodeBurn-Setup-1.2.2.exe',
        'CodeBurn-Setup-1.2.2.exe.blockmap',
      ],
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('unexpected Windows installer artifacts')
  })

  it('accepts a complete live desktop release asset manifest', () => {
    const result = releaseFixture([
      'CodeBurn-1.2.3-arm64.dmg',
      'CodeBurn-1.2.3.dmg',
      'CodeBurn-1.2.3-arm64-mac.zip',
      'CodeBurn-1.2.3-mac.zip',
      'CodeBurn-1.2.3.AppImage',
      'codeburn-desktop_1.2.3_amd64.deb',
      'codeburn-desktop-1.2.3.x86_64.rpm',
      'CodeBurn-Setup-1.2.3.exe',
      'CodeBurn-Setup-1.2.3.exe.blockmap',
      'latest-mac.yml',
      'latest-linux.yml',
    ])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Live desktop release assets verified for 1.2.3')
  })

  it('rejects a live desktop release missing the Windows installer', () => {
    const result = releaseFixture([
      'CodeBurn-1.2.3-arm64.dmg',
      'CodeBurn-1.2.3.dmg',
      'CodeBurn-1.2.3-arm64-mac.zip',
      'CodeBurn-1.2.3-mac.zip',
      'CodeBurn-1.2.3.AppImage',
      'codeburn-desktop_1.2.3_amd64.deb',
      'codeburn-desktop-1.2.3.x86_64.rpm',
      'CodeBurn-Setup-1.2.3.exe.blockmap',
      'latest-mac.yml',
      'latest-linux.yml',
    ])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('live release is missing CodeBurn-Setup-1.2.3.exe')
  })

  it.each([
    'codeburn-desktop_1.2.3_amd64.deb',
    'codeburn-desktop-1.2.3.x86_64.rpm',
    'latest-mac.yml',
    'latest-linux.yml',
  ])('rejects a live desktop release missing %s', missing => {
    const required = [
      'CodeBurn-1.2.3-arm64.dmg',
      'CodeBurn-1.2.3.dmg',
      'CodeBurn-1.2.3-arm64-mac.zip',
      'CodeBurn-1.2.3-mac.zip',
      'CodeBurn-1.2.3.AppImage',
      'codeburn-desktop_1.2.3_amd64.deb',
      'codeburn-desktop-1.2.3.x86_64.rpm',
      'CodeBurn-Setup-1.2.3.exe',
      'CodeBurn-Setup-1.2.3.exe.blockmap',
      'latest-mac.yml',
      'latest-linux.yml',
    ]
    const result = releaseFixture(required.filter(asset => asset !== missing))

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`live release is missing ${missing}`)
  })
})

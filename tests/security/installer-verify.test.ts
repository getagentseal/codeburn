import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { _ensureAllowedHostForTest, _verifyLocalArchiveForTest } from '../../src/menubar-installer.js'

const SAMPLE_BODY = 'codeburn-installer-test\n'
const SAMPLE_SHA256 = '3b41624875722de5f1cad9cd809a6511f0a93f913741699c67d59c072eaba1a2'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'codeburn-installer-test-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function stageArchive(body: string): Promise<string> {
  const path = join(dir, 'sample.zip')
  await writeFile(path, body)
  return path
}

async function stageSidecar(content: string): Promise<string> {
  const path = join(dir, 'sample.zip.sha256')
  await writeFile(path, content)
  return path
}

describe('menubar installer verification', () => {
  it('accepts a matching SHA-256 in bare-hex form', async () => {
    const archive = await stageArchive(SAMPLE_BODY)
    const sidecar = await stageSidecar(SAMPLE_SHA256 + '\n')
    await expect(_verifyLocalArchiveForTest(archive, sidecar)).resolves.toBeUndefined()
  })

  it('accepts a matching SHA-256 in two-column sha256sum form', async () => {
    const archive = await stageArchive(SAMPLE_BODY)
    const sidecar = await stageSidecar(`${SAMPLE_SHA256}  sample.zip\n`)
    await expect(_verifyLocalArchiveForTest(archive, sidecar)).resolves.toBeUndefined()
  })

  it('rejects a tampered archive', async () => {
    const archive = await stageArchive('tampered-body\n')
    const sidecar = await stageSidecar(SAMPLE_SHA256 + '\n')
    await expect(_verifyLocalArchiveForTest(archive, sidecar)).rejects.toThrow(/checksum mismatch/i)
  })

  it('rejects a sidecar that does not contain a valid SHA-256 digest', async () => {
    const archive = await stageArchive(SAMPLE_BODY)
    const sidecar = await stageSidecar('not-a-hex-digest\n')
    await expect(_verifyLocalArchiveForTest(archive, sidecar)).rejects.toThrow(/valid SHA-256/i)
  })
})

describe('menubar installer download host allow-list', () => {
  it.each([
    'https://github.com/getagentseal/codeburn/releases/download/mac-v1/CodeBurnMenubar.zip',
    'https://GitHub.com/getagentseal/codeburn/releases/download/mac-v1/CodeBurnMenubar.zip',
    'https://github.com./getagentseal/codeburn/releases/download/mac-v1/CodeBurnMenubar.zip',
    'https://objects.githubusercontent.com/path/to/asset',
    'https://release-assets.githubusercontent.com/path/to/asset',
  ])('accepts %s', (url) => {
    expect(() => _ensureAllowedHostForTest(url)).not.toThrow()
  })

  it.each([
    'https://evil.example.com/CodeBurnMenubar.zip',
    'http://github.com.attacker.test/asset.zip',
    'https://raw.githubusercontent.com/attacker/repo/main/CodeBurnMenubar.zip',
  ])('rejects %s', (url) => {
    expect(() => _ensureAllowedHostForTest(url)).toThrow(/unexpected host/i)
  })

  it.each([
    // Userinfo: even when the host parses to an allow-listed value, refuse on principle.
    'https://attacker@github.com/asset.zip',
    'https://user:pw@github.com/asset.zip',
    'https://attacker@evil.example.com/asset.zip',
  ])('rejects URL containing userinfo: %s', (url) => {
    expect(() => _ensureAllowedHostForTest(url)).toThrow(/userinfo/i)
  })

  it.each([
    // Node converts non-ASCII hostnames to xn-- punycode at parse time. Reject all of them.
    'https://gïthub.com/asset.zip',
    'https://gïthub.com.evil.example/asset.zip',
  ])('rejects IDN/punycode host: %s', (url) => {
    expect(() => _ensureAllowedHostForTest(url)).toThrow(/idn|punycode/i)
  })

  it('rejects an unparseable URL', () => {
    expect(() => _ensureAllowedHostForTest('not a url')).toThrow(/unparseable/i)
  })
})

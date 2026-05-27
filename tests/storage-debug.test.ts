import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { collectStorageEntries, formatBytes, formatStorageTable, storageCandidates } from '../src/storage-debug.js'

describe('storage debug', () => {
  it('reports provider storage candidates for supported tooling', () => {
    const home = '/Users/example'
    const candidates = storageCandidates(home, 'darwin')

    expect(candidates).toContainEqual(expect.objectContaining({
      provider: 'antigravity',
      label: 'Antigravity CLI conversations',
      path: join(home, '.gemini', 'antigravity-cli', 'conversations'),
    }))
    expect(candidates).toContainEqual(expect.objectContaining({
      provider: 'antigravity',
      label: 'Antigravity Google application support',
      path: join(home, 'Library', 'Application Support', 'Google', 'Antigravity'),
    }))
    expect(candidates).toContainEqual(expect.objectContaining({
      provider: 'codex',
      path: join(home, '.codex'),
    }))
  })

  it('covers every supported provider in storage candidates', () => {
    const providers = new Set(storageCandidates('/Users/example', 'darwin').map(candidate => candidate.provider))

    expect([...providers].sort()).toEqual([
      'antigravity',
      'claude',
      'cline',
      'codebuff',
      'codeburn',
      'codex',
      'copilot',
      'crush',
      'cursor',
      'cursor-agent',
      'droid',
      'forge',
      'gemini',
      'goose',
      'ibm-bob',
      'kilo-code',
      'kimi',
      'kiro',
      'mistral-vibe',
      'omp',
      'openclaw',
      'opencode',
      'pi',
      'qwen',
      'roo-code',
      'warp',
    ])
  })

  it('formats bytes compactly', () => {
    expect(formatBytes(null)).toBe('-')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.00 KB')
    expect(formatBytes(2_000_000)).toBe('1.91 MB')
  })

  it('collects storage entries for a provider filter', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-storage-debug-'))
    const oldHome = process.env['HOME']
    const oldCache = process.env['CODEBURN_CACHE_DIR']

    try {
      process.env['HOME'] = home
      const cacheDir = join(home, '.cache', 'codeburn')
      process.env['CODEBURN_CACHE_DIR'] = cacheDir
      await mkdir(cacheDir, { recursive: true })
      await writeFile(join(cacheDir, 'session-cache.json'), 'hello')

      const entries = await collectStorageEntries('codeburn')

      expect(entries.every(entry => entry.provider === 'codeburn')).toBe(true)
      expect(entries.some(entry => entry.path === cacheDir && entry.exists && entry.sizeBytes === 5)).toBe(true)
    } finally {
      if (oldHome === undefined) delete process.env['HOME']
      else process.env['HOME'] = oldHome
      if (oldCache === undefined) delete process.env['CODEBURN_CACHE_DIR']
      else process.env['CODEBURN_CACHE_DIR'] = oldCache
      await rm(home, { recursive: true, force: true })
    }
  })

  it('renders a readable table', () => {
    const table = formatStorageTable([
      { provider: 'codex', label: 'Codex home', path: '/tmp/.codex', exists: true, sizeBytes: 2048, truncated: false },
      { provider: 'claude', label: 'Claude config', path: '/tmp/.claude', exists: false, sizeBytes: null, truncated: false },
    ])

    expect(table).toContain('Provider')
    expect(table).toContain('2.00 KB')
    expect(table).toContain('missing')
  })
})

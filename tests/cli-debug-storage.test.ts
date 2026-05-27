import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

function runCli(args: string[], home: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      CODEBURN_CACHE_DIR: join(home, '.cache', 'codeburn'),
    },
    encoding: 'utf-8',
    timeout: 30_000,
  })
}

describe('codeburn debug storage', () => {
  it('prints provider storage entries as json', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-cli-storage-'))
    try {
      const cacheDir = join(home, '.cache', 'codeburn')
      await mkdir(cacheDir, { recursive: true })
      await writeFile(join(cacheDir, 'session-cache.json'), 'hello')

      const result = runCli(['debug', 'storage', '--provider', 'codeburn', '--format', 'json'], home)
      expect(result.status, `stderr: ${result.stderr}`).toBe(0)

      const payload = JSON.parse(result.stdout) as {
        entries: Array<{ provider: string; path: string; exists: boolean; sizeBytes: number | null }>
      }
      expect(payload.entries.every(entry => entry.provider === 'codeburn')).toBe(true)
      expect(payload.entries.some(entry => entry.path === cacheDir && entry.exists && entry.sizeBytes === 5)).toBe(true)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('rejects unknown storage providers', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-cli-storage-'))
    try {
      const result = runCli(['debug', 'storage', '--provider', 'missing-provider'], home)

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('unknown provider "missing-provider"')
      expect(result.stderr).toContain('antigravity')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { describe, it, expect } from 'vitest'

const CLI_TIMEOUT_MS = 10_000

function runCli(args: string[], home: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      HOMEPATH: home,
      HOMEDRIVE: '',
    },
    encoding: 'utf-8',
  })
}

function readConfig(home: string): Promise<Record<string, unknown>> {
  return readFile(join(home, '.config', 'codeburn', 'config.json'), 'utf-8')
    .then(raw => JSON.parse(raw) as Record<string, unknown>)
}

describe('codeburn price-override command', () => {
  it('saves, lists, and removes a model price override', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-cli-price-override-'))
    try {
      const set = runCli([
        'price-override',
        'unpriced-provider/test-model',
        '--input',
        '0.27',
        '--output',
        '1.10',
        '--cache-read',
        '0.03',
        '--cache-creation',
        '0.42',
      ], home)
      expect(set.status).toBe(0)
      expect(set.stdout).toContain('unpriced-provider/test-model')
      expect(set.stdout).toContain('USD per 1,000,000 tokens')

      const saved = await readConfig(home)
      expect(saved.priceOverrides).toEqual({
        'unpriced-provider/test-model': {
          input: 0.27,
          output: 1.1,
          cacheRead: 0.03,
          cacheCreation: 0.42,
        },
      })

      const list = runCli(['price-override', '--list'], home)
      expect(list.status).toBe(0)
      expect(list.stdout).toContain('unpriced-provider/test-model')
      expect(list.stdout).toContain('input 0.27')
      expect(list.stdout).toContain('output 1.1')

      const remove = runCli(['price-override', '--remove', 'unpriced-provider/test-model'], home)
      expect(remove.status).toBe(0)

      const after = await readConfig(home)
      expect(after.priceOverrides).toBeUndefined()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, CLI_TIMEOUT_MS)

  it('rejects an invalid rate', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-cli-price-override-'))
    try {
      const result = runCli(['price-override', 'bad-rate-model', '--input', 'abc', '--output', '1'], home)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Invalid --input')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, CLI_TIMEOUT_MS)
})

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { describe, it, expect } from 'vitest'

const CLI_TIMEOUT_MS = 30_000

function runCli(args: string[], home: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, USERPROFILE: home, HOMEPATH: home, HOMEDRIVE: '' },
    encoding: 'utf-8',
  })
}

function readConfig(home: string): Promise<Record<string, unknown>> {
  return readFile(join(home, '.config', 'codeburn', 'config.json'), 'utf-8')
    .then(raw => JSON.parse(raw) as Record<string, unknown>)
}

describe('codeburn price-discount command', () => {
  it('sets, lists and removes discounts', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-cli-price-discount-'))
    try {
      expect(runCli(['price-discount', 'set', 'claude', '20%'], home).status).toBe(0)
      const set = runCli(['price-discount', 'set', 'claude-opus-4-8:output', '50'], home)
      expect(set.status).toBe(0)
      expect(set.stdout).toContain('claude-opus-4-8:output: 50% off list price')
      expect((await readConfig(home)).discounts).toEqual({ claude: 20, 'claude-opus-4-8:output': 50 })

      const list = runCli(['price-discount', 'list', '--format', 'json'], home)
      expect(list.status).toBe(0)
      expect(JSON.parse(list.stdout).discounts).toEqual([
        { scope: 'claude', percent: 20 },
        { scope: 'claude-opus-4-8:output', percent: 50 },
      ])

      expect(runCli(['price-discount', 'remove', 'claude'], home).status).toBe(0)
      expect(runCli(['price-discount', 'remove', 'claude-opus-4-8:output'], home).status).toBe(0)
      expect((await readConfig(home)).discounts).toBeUndefined()
      expect(runCli(['price-discount', 'remove', 'claude'], home).status).toBe(1)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, CLI_TIMEOUT_MS)

  it('rejects an invalid percent or scope', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-cli-price-discount-'))
    try {
      for (const percent of ['101', 'abc', '', '20%%']) {
        const result = runCli(['price-discount', 'set', 'claude', percent], home)
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('Invalid percent')
      }
      for (const scope of ['no-such-model-x', 'claude-opus-4-8:reasoning', 'claude:output']) {
        const result = runCli(['price-discount', 'set', scope, '10'], home)
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('Unknown scope')
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, CLI_TIMEOUT_MS)
})

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

describe('codeburn model-savings command', () => {
  it('saves, lists, and removes a local-model savings mapping', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-cli-savings-'))
    try {
      const set = runCli(['model-savings', 'llama3.1:8b', 'gpt-4o'], home)
      expect(set.status).toBe(0)
      expect(set.stdout).toContain('llama3.1:8b -> gpt-4o')

      const saved = await readConfig(home)
      expect(saved.localModelSavings).toEqual({ 'llama3.1:8b': 'gpt-4o' })

      const list = runCli(['model-savings', '--list'], home)
      expect(list.status).toBe(0)
      expect(list.stdout).toContain('llama3.1:8b -> gpt-4o')

      const remove = runCli(['model-savings', '--remove', 'llama3.1:8b'], home)
      expect(remove.status).toBe(0)

      const after = await readConfig(home)
      expect(after.localModelSavings).toBeUndefined()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, CLI_TIMEOUT_MS)

  it('warns when the same model is also configured in modelAliases', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-cli-savings-'))
    try {
      expect(runCli(['model-alias', 'llama3.1:8b', 'gpt-4o'], home).status).toBe(0)
      const set = runCli(['model-savings', 'llama3.1:8b', 'gpt-4o'], home)
      expect(set.status).toBe(0)
      expect(set.stdout).toContain('savings take precedence')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, CLI_TIMEOUT_MS)

  it('rejects a remove for an unknown mapping', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-cli-savings-'))
    try {
      const result = runCli(['model-savings', '--remove', 'unknown:1b'], home)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('No savings mapping found')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, CLI_TIMEOUT_MS)
})

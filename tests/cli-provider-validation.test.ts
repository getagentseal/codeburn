import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { afterEach, describe, expect, it } from 'vitest'

import { allProviderNames, getAllProviders } from '../src/providers/index.js'

let homes: string[] = []

afterEach(async () => {
  while (homes.length > 0) {
    const h = homes.pop()
    if (h) await rm(h, { recursive: true, force: true })
  }
})

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'codeburn-provider-cli-'))
  homes.push(home)
  return home
}

function runCli(args: string[], home: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), TZ: 'UTC' },
    encoding: 'utf-8',
    timeout: 30_000,
  })
}

describe('allProviderNames', () => {
  it('is non-empty, sorted, and excludes the "all" sentinel', () => {
    const names = allProviderNames()
    expect(names.length).toBeGreaterThan(0)
    expect([...names]).toEqual([...names].sort())
    expect(names).not.toContain('all')
  })

  it('covers every loadable provider (guards against lazy-list drift)', async () => {
    const loaded = (await getAllProviders()).map(p => p.name)
    const names = allProviderNames()
    for (const name of loaded) {
      expect(names).toContain(name)
    }
  })
})

describe('codeburn --provider validation', () => {
  it('rejects an unknown provider with a clear error and exit 1', async () => {
    const home = await makeHome()
    const res = runCli(['report', '--provider', 'claud', '-p', 'today'], home)
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('unknown provider "claud"')
    expect(res.stderr).toContain('Valid values: all,')
  })

  it('accepts a valid provider', async () => {
    const home = await makeHome()
    const res = runCli(['status', '--provider', 'claude', '--format', 'json'], home)
    expect(res.status).toBe(0)
    expect(res.stderr).not.toContain('unknown provider')
  })

  it('accepts the "all" sentinel', async () => {
    const home = await makeHome()
    const res = runCli(['status', '--provider', 'all', '--format', 'json'], home)
    expect(res.status).toBe(0)
  })
})

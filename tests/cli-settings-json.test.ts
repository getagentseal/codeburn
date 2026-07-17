import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 30_000 })

const homes: string[] = []

afterEach(async () => {
  while (homes.length > 0) {
    const home = homes.pop()
    if (home) await rm(home, { recursive: true, force: true })
  }
})

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'codeburn-settings-json-'))
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

describe('settings CLI JSON list output', () => {
  it('lists model aliases as rows sorted by from', async () => {
    const home = await makeHome()

    expect(runCli(['model-alias', 'z-model', 'gpt-4o'], home).status).toBe(0)
    expect(runCli(['model-alias', 'a-model', 'claude-sonnet-4-6'], home).status).toBe(0)

    const result = runCli(['model-alias', '--list', '--format', 'json'], home)
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual([
      { from: 'a-model', to: 'claude-sonnet-4-6' },
      { from: 'z-model', to: 'gpt-4o' },
    ])
  })

  it('lists configured proxy paths as strings', async () => {
    const home = await makeHome()

    expect(runCli(['proxy-path', '/work/copilot-repo'], home).status).toBe(0)

    const result = runCli(['proxy-path', '--list', '--format', 'json'], home)
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(['/work/copilot-repo'])
  })

  it('lists price overrides as rows sorted by model with a config path', async () => {
    const home = await makeHome()

    expect(runCli(['price-override', 'z-model', '--input', '0.5', '--output', '2', '--cache-read', '0.05'], home).status).toBe(0)
    expect(runCli(['price-override', 'a-model', '--input', '0.27', '--output', '1.1', '--cache-creation', '0.42'], home).status).toBe(0)

    const result = runCli(['price-override', '--list', '--format', 'json'], home)
    expect(result.status).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(parsed.overrides).toEqual([
      { model: 'a-model', inputPerM: 0.27, outputPerM: 1.1, cacheCreationPerM: 0.42 },
      { model: 'z-model', inputPerM: 0.5, outputPerM: 2, cacheReadPerM: 0.05 },
    ])
    expect(typeof parsed.configPath).toBe('string')
    expect(parsed.configPath).toContain('config.json')
  })

  it('emits an empty override list as JSON when none are configured', async () => {
    const home = await makeHome()

    const result = runCli(['price-override', '--list', '--format', 'json'], home)
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout).overrides).toEqual([])
  })
})

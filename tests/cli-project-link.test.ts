import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 60_000 })

let home: string

afterEach(() => rmSync(home, { recursive: true, force: true }))

function runCli(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, USERPROFILE: home, CODEBURN_CACHE_DIR: join(home, 'cache'), TZ: 'UTC' },
    encoding: 'utf-8',
    timeout: 30_000,
  })
}

describe('codeburn project link', () => {
  it('links a folder to a known repository, lists, and unlinks it', () => {
    home = mkdtempSync(join(tmpdir(), 'codeburn-project-link-'))
    mkdirSync(join(home, 'cache'))
    writeFileSync(join(home, 'cache', 'git-origins.json'), JSON.stringify({ version: 1, paths: { '/w/crewroom': 'github.com/me/crewroom' } }))

    const unknown = runCli(['project', 'link', '~/crewroom', 'crew'])
    expect(unknown.status).toBe(1)
    expect(unknown.stderr).toContain('No repository project named "crew". Did you mean: crewroom?')

    expect(runCli(['project', 'link', '~/crewroom/', 'Crewroom']).status).toBe(0)
    const config = JSON.parse(readFileSync(join(home, '.config', 'codeburn', 'config.json'), 'utf-8'))
    expect(config.projectLinks).toEqual({ [join(home, 'crewroom')]: 'github.com/me/crewroom' })
    expect(runCli(['project', 'links']).stdout).toContain(`${join(home, 'crewroom')} -> crewroom (github.com/me/crewroom)`)

    expect(runCli(['project', 'unlink', join(home, 'crewroom')]).status).toBe(0)
    expect(runCli(['project', 'links']).stdout).toContain('No project links.')
  })
})

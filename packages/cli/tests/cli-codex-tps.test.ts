import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const homes: string[] = []

afterEach(async () => {
  while (homes.length) await rm(homes.pop()!, { recursive: true, force: true })
})

function runCli(args: string[], home: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, CODEX_HOME: join(home, '.codex'), TZ: 'UTC' },
    encoding: 'utf-8',
    timeout: 30_000,
  })
}

describe('codex-tps CLI validation', () => {
  it('rejects sub-second watch intervals', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-tps-cli-'))
    homes.push(home)
    const result = runCli(['codex-tps', '--watch', '0.1'], home)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('watch must be 0 or at least 1 second')
  })

  it('rejects JSON watch output instead of concatenating invalid JSON documents', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-tps-cli-'))
    homes.push(home)
    const result = runCli(['codex-tps', '--json', '--watch', '1'], home)
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('--json cannot be combined with --watch')
  })

  it('returns a nonzero status for a missing explicit rollout', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-tps-cli-'))
    homes.push(home)
    const result = runCli(['codex-tps', join(home, 'missing.jsonl')], home)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('session file not found')
  })
})

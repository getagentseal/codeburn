import { spawnSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

// CLI surface of `codeburn peak`: exit codes (0 = all off-peak, 2 = any
// peak), --format json shape, and --at replay of a known boundary.
function runPeak(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'peak', '--no-color', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, TZ: 'UTC', CODEBURN_PRICING_SNAPSHOT_ONLY: '1' },
    encoding: 'utf-8',
    timeout: 60_000,
  })
}

describe('codeburn peak', () => {
  it('exits 2 with peak state at a known peak instant', () => {
    const result = runPeak(['--at', '2026-09-21T02:00:00Z'])
    expect(result.status).toBe(2)
    expect(result.stdout).toContain('PEAK')
    expect(result.stdout).toContain('DeepSeek')
    expect(result.stdout).toContain('GLM')
  })

  it('exits 0 with off-peak state on a weekend', () => {
    const result = runPeak(['--at', '2026-09-26T12:00:00Z'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('OFF-PEAK')
  })

  it('emits machine-readable JSON with flip fields', () => {
    const result = runPeak(['--at', '2026-09-21T02:00:00Z', '--format', 'json'])
    expect(result.status).toBe(2)
    const parsed = JSON.parse(result.stdout) as Array<Record<string, unknown>>
    expect(parsed).toHaveLength(2)
    const ds = parsed.find(r => r['vendor'] === 'deepseek')!
    expect(ds['state']).toBe('peak')
    expect(ds['flipsAt']).toBe('2026-09-21T04:00:00.000Z')
    expect(ds['flipSgt']).toBe('Mon 12:00 SGT')
    expect(ds['secondsUntilFlip']).toBe(7200)
    expect(ds['countdown']).toBe('2:00:00')
  })

  it('filters to one vendor', () => {
    const result = runPeak(['--vendor', 'glm', '--at', '2026-09-21T02:00:00Z'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('GLM')
    expect(result.stdout).not.toContain('DeepSeek')
  })

  it('rejects a bad vendor and a bad timestamp', () => {
    expect(runPeak(['--vendor', 'nope']).status).toBe(1)
    expect(runPeak(['--at', 'not-a-date']).status).toBe(1)
  })
})

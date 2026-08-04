import { spawnSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

describe('CLI refresh help', () => {
  it.each(['report', 'today', 'month'])('%s discloses the refresh floor and disable value', command => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', command, '--help'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/Auto-refresh interval in seconds \(minimum 60; 0 to\s+disable\)/)
  })
})

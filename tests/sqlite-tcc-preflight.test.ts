import { mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { assertDatabaseReadable, isBlockedDatabaseError, probeDatabaseBlocked } from '../src/sqlite.js'

// A real open() on a Full-Disk-Access-protected path never returns, and no test
// can reproduce that; a child that just sleeps wedges the preflight the same way.
const SLEEPS_FOREVER = 'setTimeout(() => {}, 1e9)'
const groupContainerPath = (name: string) =>
  join(homedir(), 'Library', 'Group Containers', '2BBY89MBSN.dev.warp.test', name)

describe('Group Container preflight', () => {
  it('gives up on a child that never exits', () => {
    const started = Date.now()
    expect(probeDatabaseBlocked(groupContainerPath('hang.sqlite'), SLEEPS_FOREVER)).toBe(true)
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('passes a readable file', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'codeburn-tcc-')), 'warp.sqlite')
    writeFileSync(file, 'x')
    expect(probeDatabaseBlocked(file)).toBe(false)
  })

  it('does not blame the file when the probe itself cannot run', () => {
    const missingNode = join(tmpdir(), 'codeburn-no-such-node')
    expect(probeDatabaseBlocked(groupContainerPath('spawn-fail.sqlite'), SLEEPS_FOREVER, missingNode)).toBe(false)
  })

  it('warns once per run and leaves the error marked as blocked', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      let thrown: unknown
      for (const name of ['first.sqlite', 'second.sqlite']) {
        try {
          assertDatabaseReadable(groupContainerPath(name), SLEEPS_FOREVER)
          throw new Error('expected the preflight to throw')
        } catch (err) {
          thrown = err
        }
      }
      expect(isBlockedDatabaseError(thrown)).toBe(true)
      const warnings = stderr.mock.calls.filter(([msg]) => String(msg).includes('Full Disk Access'))
      expect(warnings).toHaveLength(1)
      expect(warnings[0]![0]).toBe(
        "codeburn: skipped warp: macOS blocked access to Warp's database; grant Full Disk Access to the app " +
        'running codeburn (System Settings > Privacy & Security) and retry\n',
      )
    } finally {
      stderr.mockRestore()
    }
  })
})

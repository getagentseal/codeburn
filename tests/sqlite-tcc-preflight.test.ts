import { execFileSync } from 'node:child_process'
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
const normalDir = () => mkdtempSync(join(tmpdir(), 'codeburn-tcc-'))

describe('Group Container preflight', () => {
  // A readable file exits 0 whatever directory it lives in, so its verdict does
  // not depend on the Group Container prefix; the real protected dir cannot be
  // written to in a test, so a normal readable file stands in for both.
  it('passes a readable file', () => {
    const file = join(normalDir(), 'warp.sqlite')
    writeFileSync(file, 'x')
    expect(probeDatabaseBlocked(file)).toBe(false)
  })

  it('blocks a hang on a Group Container path', () => {
    const started = Date.now()
    expect(probeDatabaseBlocked(groupContainerPath('hang.sqlite'), SLEEPS_FOREVER)).toBe(true)
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  // mkfifo has no Windows equivalent, so this hang can only be reproduced on POSIX.
  it.skipIf(process.platform === 'win32')('blocks a hanging open (FIFO) on a normal path', () => {
    const fifo = join(normalDir(), 'warp.fifo')
    execFileSync('mkfifo', [fifo])
    const started = Date.now()
    // The default probe opens argv[1] for read; a FIFO with no writer blocks it
    // exactly like a TCC-wedged open, and the timeout kill classifies as blocked.
    expect(probeDatabaseBlocked(fifo)).toBe(true)
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('fails closed on a Group Container path the probe could not run for', () => {
    const missingNode = join(tmpdir(), 'codeburn-no-such-node')
    expect(probeDatabaseBlocked(groupContainerPath('spawn-fail.sqlite'), SLEEPS_FOREVER, missingNode)).toBe(true)
  })

  it('does not blame a normal-path file when the probe itself cannot run', () => {
    const missingNode = join(tmpdir(), 'codeburn-no-such-node')
    expect(probeDatabaseBlocked(join(normalDir(), 'spawn-fail.sqlite'), SLEEPS_FOREVER, missingNode)).toBe(false)
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

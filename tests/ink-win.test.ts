import { describe, it, expect } from 'vitest'
import { BSU, ESU, stripSyncUpdateEscapes, patchStdoutForWindows } from '../src/ink-win.js'

describe('stripSyncUpdateEscapes', () => {
  it('strips an exact BSU chunk to empty', () => {
    expect(stripSyncUpdateEscapes(BSU)).toBe('')
  })

  it('strips an exact ESU chunk to empty', () => {
    expect(stripSyncUpdateEscapes(ESU)).toBe('')
  })

  it('strips a leading BSU from a concatenated clear write', () => {
    // #863 regression shape: the clear sequence glued to a BSU used to slip
    // through raw and hang Windows ConPTY.
    expect(stripSyncUpdateEscapes(BSU + '\x1b[2J\x1b[H')).toBe('\x1b[2J\x1b[H')
  })

  it('strips a trailing ESU, and both ends at once', () => {
    expect(stripSyncUpdateEscapes('x' + ESU)).toBe('x')
    expect(stripSyncUpdateEscapes(BSU + 'x' + ESU)).toBe('x')
  })

  it('removes every occurrence when escapes appear multiple times', () => {
    expect(stripSyncUpdateEscapes(BSU + 'a' + BSU + 'b' + ESU + 'c' + ESU)).toBe('abc')
  })

  it('leaves a string without escapes untouched (same reference-equal content)', () => {
    const plain = 'status line \x1b[2J'
    expect(stripSyncUpdateEscapes(plain)).toBe(plain)
  })
})

describe('patchStdoutForWindows', () => {
  it('is a no-op off win32: process.stdout.write stays reference-identical', () => {
    // Skip on actual Windows runners, where the patch legitimately applies.
    if (process.platform === 'win32') return
    const before = process.stdout.write
    patchStdoutForWindows()
    expect(process.stdout.write).toBe(before)
  })
})

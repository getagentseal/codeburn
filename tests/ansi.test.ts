import { describe, it, expect } from 'vitest'

import { stripAnsi } from '../src/ansi.js'

describe('stripAnsi', () => {
  it('removes basic SGR colour codes', () => {
    expect(stripAnsi('[31mred[0m')).toBe('red')
    expect(stripAnsi('[1;33mwarn[0m')).toBe('warn')
  })

  it('removes 256-color and truecolor codes', () => {
    expect(stripAnsi('[38;5;208mfg[0m[48;2;10;20;30mbg[0m')).toBe('fgbg')
  })

  it('removes cursor-movement sequences', () => {
    expect(stripAnsi('top[2Aleft[5D')).toBe('topleft')
  })

  it('removes OSC hyperlink sequences (ESC ] … BEL)', () => {
    expect(stripAnsi(']8;;https://example.orgclicky]8;;')).toBe('clicky')
  })

  it('removes 8-bit CSI introducer (\\u009B)', () => {
    expect(stripAnsi('31mred0m')).toBe('red')
  })

  it('leaves non-ANSI input untouched', () => {
    expect(stripAnsi('npm install --save')).toBe('npm install --save')
    expect(stripAnsi('')).toBe('')
    expect(stripAnsi('emoji 🔥 ok')).toBe('emoji 🔥 ok')
  })
})

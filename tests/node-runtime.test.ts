import { describe, expect, it } from 'vitest'

import {
  formatUnsupportedNodeMessage,
  isSupportedNodeVersion,
  parseNodeVersion,
} from '../src/node-runtime.js'

describe('node runtime guard', () => {
  it('parses Node version strings', () => {
    expect(parseNodeVersion('v22.13.0')).toEqual({ major: 22, minor: 13, patch: 0 })
    expect(parseNodeVersion('25.9.0')).toEqual({ major: 25, minor: 9, patch: 0 })
    expect(parseNodeVersion('not-node')).toBeNull()
  })

  it('requires Node 22.13 or newer', () => {
    expect(isSupportedNodeVersion('v18.20.4')).toBe(false)
    expect(isSupportedNodeVersion('v22.11.0')).toBe(false)
    expect(isSupportedNodeVersion('v22.12.0')).toBe(false)
    expect(isSupportedNodeVersion('v22.13.0')).toBe(true)
    expect(isSupportedNodeVersion('v22.13.5')).toBe(true)
    expect(isSupportedNodeVersion('v23.0.0')).toBe(true)
    expect(isSupportedNodeVersion('v24.0.0')).toBe(true)
  })

  it('formats an actionable unsupported-runtime message', () => {
    const message = formatUnsupportedNodeMessage('v18.20.4')
    expect(message).toContain('Node.js 22.13.0 or newer')
    expect(message).toContain('current runtime is v18.20.4')
    expect(message).toContain('node:sqlite')
  })
})

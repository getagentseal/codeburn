import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { readKeychainPassword, type KeychainExec } from '../src/quota/security.js'

// Every lookup is answered by the injected exec; no test reaches /usr/bin/security.
const realPlatform = process.platform
beforeAll(() => Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true }))
afterAll(() => Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true }))

const fail = (fields: Record<string, unknown>) => vi.fn<KeychainExec>(async () => { throw Object.assign(new Error('Command failed'), fields) })

describe('readKeychainPassword consent', () => {
  it('stops at a Deny on the user item instead of prompting again service-only', async () => {
    const exec = fail({ code: 128, stderr: 'security: SecKeychainSearchCopyNext: User canceled the operation.' })
    expect(await readKeychainPassword('Claude Code-credentials', ['alice', null], exec)).toEqual({ status: 'accessDenied' })
    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec.mock.calls[0]![1]).toEqual(['find-generic-password', '-s', 'Claude Code-credentials', '-a', 'alice', '-w'])
  })

  it('stops at an unanswered prompt killed by the timeout, so one wait fits the quota race', async () => {
    const exec = fail({ killed: true, signal: 'SIGTERM', code: null })
    expect(await readKeychainPassword('org.agentseal.codeburn.menubar.codex.oauth.v1', ['default', null], exec)).toEqual({ status: 'accessDenied' })
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('still falls through a genuine miss to the next account', async () => {
    const exec = vi.fn<KeychainExec>(async (_file, args) => {
      if (args.includes('-a')) throw Object.assign(new Error('The specified item could not be found in the keychain.'), { code: 44 })
      return { stdout: '{"ok":true}\n' }
    })
    expect(await readKeychainPassword('Claude Code-credentials', ['alice', null], exec)).toEqual({ status: 'found', value: '{"ok":true}\n' })
    expect(exec).toHaveBeenCalledTimes(2)
  })
})

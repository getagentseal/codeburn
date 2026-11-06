import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { readKeychainPassword, type KeychainExec } from '../src/quota/security.js'

// Every lookup is answered by the injected exec; no test reaches /usr/bin/security.
// Refusals are remembered per process, so each test uses its own service name.
const realPlatform = process.platform
beforeAll(() => Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true }))
afterAll(() => Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true }))

const fail = (fields: Record<string, unknown>) => vi.fn<KeychainExec>(async () => { throw Object.assign(new Error('Command failed'), fields) })
const DENY = { code: 128, stderr: 'security: SecKeychainSearchCopyNext: User canceled the operation.' }
const notFound = () => { throw Object.assign(new Error('The specified item could not be found in the keychain.'), { code: 44 }) }

describe('readKeychainPassword consent', () => {
  it('stops at a Deny on the user item instead of prompting again service-only', async () => {
    const exec = fail(DENY)
    expect(await readKeychainPassword('svc-deny', ['alice', null], exec)).toEqual({ status: 'accessDenied', reason: 'denied' })
    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec.mock.calls[0]![1]).toEqual(['find-generic-password', '-s', 'svc-deny', '-a', 'alice', '-w'])
  })

  it('stops at an unanswered prompt killed by the timeout, so one wait fits the quota race', async () => {
    const exec = fail({ killed: true, signal: 'SIGTERM', code: null })
    expect(await readKeychainPassword('svc-unanswered', ['default', null], exec)).toEqual({ status: 'accessDenied', reason: 'unanswered' })
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('answers a second read of a refused service from memory, without a prompt', async () => {
    const exec = fail(DENY)
    await readKeychainPassword('svc-memo', ['alice', null], exec)
    const allowed = vi.fn<KeychainExec>(async () => ({ stdout: '{"ok":true}' }))
    expect(await readKeychainPassword('svc-memo', ['alice', null], allowed)).toEqual({ status: 'accessDenied', reason: 'denied' })
    expect(allowed).not.toHaveBeenCalled()
  })

  it('moves past an error that showed no prompt to the next account', async () => {
    const exec = vi.fn<KeychainExec>(async (_file, args) => {
      if (args.includes('-a')) throw Object.assign(new Error('security: read error'), { code: 1 })
      return { stdout: '{"ok":true}' }
    })
    expect(await readKeychainPassword('svc-io', ['alice', null], exec)).toEqual({ status: 'found', value: '{"ok":true}' })
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('still falls through a genuine miss to the next account', async () => {
    const exec = vi.fn<KeychainExec>(async (_file, args) => args.includes('-a') ? notFound() : { stdout: '{"ok":true}\n' })
    expect(await readKeychainPassword('svc-miss', ['alice', null], exec)).toEqual({ status: 'found', value: '{"ok":true}\n' })
    expect(exec).toHaveBeenCalledTimes(2)
  })
})

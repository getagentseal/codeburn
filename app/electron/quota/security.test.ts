import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { forgetKeychainRefusals, readKeychainPassword, sanitizeError, type KeychainExec } from './security'

// readKeychainPassword short-circuits off darwin; pin the platform so the
// classification logic is exercised on any CI host.
const originalPlatform = process.platform
beforeAll(() => Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true }))
afterAll(() => Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true }))

const denied = (message: string) => () => { throw new Error(message) }
const notFound = () => { const error = new Error('The specified item could not be found in the keychain.') as Error & { code: number }; error.code = 44; throw error }

describe('readKeychainPassword', () => {
  beforeEach(() => forgetKeychainRefusals())

  it('decodes a hex-dumped security(1) payload back to its JSON text', async () => {
    const json = JSON.stringify({ claudeAiOauth: { accessToken: 'x' } })
    const hex = Buffer.from(json, 'utf8').toString('hex')
    const exec = vi.fn(async () => ({ stdout: `${hex}\n` }))
    expect(await readKeychainPassword('svc', [null], exec)).toEqual({ status: 'found', value: json })
  })

  it('passes plain (non-hex) JSON through unchanged', async () => {
    const exec = vi.fn(async () => ({ stdout: '{"a":1}' }))
    expect(await readKeychainPassword('svc', [null], exec)).toEqual({ status: 'found', value: '{"a":1}' })
  })

  it('classifies exit 44 / "could not be found" as notFound', async () => {
    expect(await readKeychainPassword('svc', [null], vi.fn(notFound))).toEqual({ status: 'notFound' })
  })

  it('stops at a prompt our own timer gave up on', async () => {
    vi.useFakeTimers()
    try {
      const exec = vi.fn<KeychainExec>((_file, _args, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })))
      }))
      const pending = readKeychainPassword('svc', ['alice', null], exec)
      await vi.advanceTimersByTimeAsync(90_000)
      expect(await pending).toEqual({ status: 'accessDenied', reason: 'unanswered' })
      expect(exec).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('moves past a kill that was not our timer', async () => {
    const exec = vi.fn(async (_file: string, args: string[]) => {
      if (args.includes('-a')) throw Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' })
      return { stdout: '{"ok":true}' }
    })
    expect(await readKeychainPassword('svc', ['alice', null], exec)).toEqual({ status: 'found', value: '{"ok":true}' })
  })

  it('remembers a refusal until the user acts again, without a second prompt', async () => {
    const exec = vi.fn(denied('User canceled the operation.'))
    await readKeychainPassword('svc', ['alice', null], exec)
    expect(await readKeychainPassword('svc', ['alice', null], exec)).toEqual({ status: 'accessDenied', reason: 'denied' })
    expect(exec).toHaveBeenCalledTimes(1)
    forgetKeychainRefusals()
    await readKeychainPassword('svc', ['alice', null], exec)
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('classifies "User interaction is not allowed" and user cancel as accessDenied', async () => {
    expect(await readKeychainPassword('svc', [null], vi.fn(denied('SecKeychainItemCopyContent: User interaction is not allowed.')))).toEqual({ status: 'accessDenied' })
    expect(await readKeychainPassword('svc', [null], vi.fn(denied('User canceled the operation.')))).toEqual({ status: 'accessDenied', reason: 'denied' })
  })

  it('falls through a user-scoped miss to the service-only lookup', async () => {
    const exec = vi.fn(async (_file: string, args: string[]) => {
      if (args.includes('-a')) return notFound()
      return { stdout: '{"ok":true}' }
    })
    expect(await readKeychainPassword('svc', ['alice', null], exec)).toEqual({ status: 'found', value: '{"ok":true}' })
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('stops at a Deny on the first candidate instead of prompting again for the same item', async () => {
    const exec = vi.fn(denied('User canceled the operation.'))
    expect(await readKeychainPassword('svc', ['alice', null], exec)).toEqual({ status: 'accessDenied', reason: 'denied' })
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('moves past an error that showed no prompt to the next candidate', async () => {
    const exec = vi.fn(async (_file: string, args: string[]) => {
      if (args.includes('-a')) throw Object.assign(new Error('security: read error'), { code: 1 })
      return { stdout: '{"ok":true}' }
    })
    expect(await readKeychainPassword('svc', ['alice', null], exec)).toEqual({ status: 'found', value: '{"ok":true}' })
  })

  it('reports accessDenied when a later candidate is denied after an earlier miss', async () => {
    const exec = vi.fn(async (_file: string, args: string[]) => {
      if (args.includes('-a')) return notFound()
      throw new Error('User interaction is not allowed.')
    })
    expect(await readKeychainPassword('svc', ['alice', null], exec)).toEqual({ status: 'accessDenied' })
  })
})

describe('sanitizeError', () => {
  it('redacts the OAuth token shapes used by the quota providers', () => {
    const sanitized = sanitizeError(new Error('Bearer abc123 ya29.google-token gho_ghub eyJwt.sig\0x sk-ant-one sk-two'))
    expect(sanitized).toBe('[REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED]')
  })
})

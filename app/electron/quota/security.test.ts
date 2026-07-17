import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { readKeychainPassword } from './security'

// readKeychainPassword short-circuits off darwin; pin the platform so the
// classification logic is exercised on any CI host.
const originalPlatform = process.platform
beforeAll(() => Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true }))
afterAll(() => Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true }))

const denied = (message: string) => () => { throw new Error(message) }
const notFound = () => { const error = new Error('The specified item could not be found in the keychain.') as Error & { code: number }; error.code = 44; throw error }

describe('readKeychainPassword', () => {
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

  it('classifies a timeout kill left open on the dialog as accessDenied', async () => {
    const exec = vi.fn(async () => { const error = new Error('Command failed') as Error & { killed: boolean; signal: string }; error.killed = true; error.signal = 'SIGTERM'; throw error })
    expect(await readKeychainPassword('svc', [null], exec)).toEqual({ status: 'accessDenied' })
  })

  it('classifies "User interaction is not allowed" and user cancel as accessDenied', async () => {
    expect(await readKeychainPassword('svc', [null], vi.fn(denied('SecKeychainItemCopyContent: User interaction is not allowed.')))).toEqual({ status: 'accessDenied' })
    expect(await readKeychainPassword('svc', [null], vi.fn(denied('User canceled the operation.')))).toEqual({ status: 'accessDenied' })
  })

  it('falls through a user-scoped miss to the service-only lookup', async () => {
    const exec = vi.fn(async (_file: string, args: string[]) => {
      if (args.includes('-a')) return notFound()
      return { stdout: '{"ok":true}' }
    })
    expect(await readKeychainPassword('svc', ['alice', null], exec)).toEqual({ status: 'found', value: '{"ok":true}' })
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('reports accessDenied when a later candidate is denied after an earlier miss', async () => {
    const exec = vi.fn(async (_file: string, args: string[]) => {
      if (args.includes('-a')) return notFound()
      throw new Error('User interaction is not allowed.')
    })
    expect(await readKeychainPassword('svc', ['alice', null], exec)).toEqual({ status: 'accessDenied' })
  })
})

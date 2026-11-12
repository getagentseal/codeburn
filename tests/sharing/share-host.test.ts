import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/sharing/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/sharing/store.js')>()
  return { ...actual, getSharingDir: () => '/tmp/fake-sharing-dir', loadPeers: async () => [] }
})

vi.mock('../../src/sharing/identity.js', () => ({
  loadOrCreateIdentity: async () => ({ key: '', cert: '', fingerprint: 'fp', name: 'TestDevice' }),
}))

import { ShareController } from '../../src/sharing/share-controller.js'

const getUsage = async () => ({})

describe('ShareController --host option', () => {
  it('defaults to 0.0.0.0 when no host is specified', async () => {
    const ctrl = new ShareController(getUsage)
    const status = await ctrl.status()
    expect(status.host).toBe('0.0.0.0')
    expect(status.port).toBe(7777)
  })

  it('accepts a custom host and surfaces it in status()', async () => {
    const ctrl = new ShareController(getUsage, 8080, '127.0.0.1')
    const status = await ctrl.status()
    expect(status.host).toBe('127.0.0.1')
    expect(status.port).toBe(8080)
  })

  it('preserves an arbitrary host value such as a LAN address', async () => {
    const ctrl = new ShareController(getUsage, 7777, '192.168.1.42')
    const status = await ctrl.status()
    expect(status.host).toBe('192.168.1.42')
  })
})

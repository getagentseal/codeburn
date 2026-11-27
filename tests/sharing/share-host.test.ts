import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/sharing/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/sharing/store.js')>()
  return { ...actual, getSharingDir: () => '/tmp/fake-sharing-dir', loadPeers: async () => [], savePeers: async () => {} }
})

vi.mock('../../src/sharing/identity.js', () => ({
  loadOrCreateIdentity: async () => ({ key: '', cert: '', fingerprint: 'fp', name: 'TestDevice' }),
}))

vi.mock('../../src/sharing/pairing.js', () => ({
  PeerStore: class {
    list() { return [] }
    add() {}
  }
}))

vi.mock('../../src/sharing/discovery.js', () => ({
  advertise: () => ({ stop: () => {} }),
}))

// Mock ShareServer to spy on listen() calls
const mockListen = vi.fn().mockResolvedValue(undefined)
vi.mock('../../src/sharing/share-server.js', () => ({
  ShareServer: class {
    listen = mockListen
    close() {}
    server = { on: () => {} }
  }
}))

import { ShareController } from '../../src/sharing/share-controller.js'

const getUsage = async () => ({})

beforeEach(() => {
  mockListen.mockClear()
})

describe('ShareController --host option', () => {
  describe('status()', () => {
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

  describe('start() — mutation tests verifying host is passed to server.listen()', () => {
    it('passes default host to ShareServer.listen() on start()', async () => {
      const ctrl = new ShareController(getUsage)
      await ctrl.start(false)
      
      expect(mockListen).toHaveBeenCalledWith(7777, '0.0.0.0')
    })

    it('passes custom host to ShareServer.listen() on start()', async () => {
      const ctrl = new ShareController(getUsage, 9999, '192.168.193.36')
      await ctrl.start(false)
      
      expect(mockListen).toHaveBeenCalledWith(9999, '192.168.193.36')
    })

    it('catches mutation: hardcoded 0.0.0.0 instead of this.host', async () => {
      // If someone changes share-controller.ts to:
      //   await server.listen(this.port, '0.0.0.0')
      // this test will catch it
      const ctrl = new ShareController(getUsage, 8080, '10.0.0.5')
      await ctrl.start(false)
      
      // Should be '10.0.0.5', NOT '0.0.0.0'
      const listenCall = mockListen.mock.calls[0]
      expect(listenCall[1]).toBe('10.0.0.5')
      expect(listenCall[1]).not.toBe('0.0.0.0') // explicit mutation check
    })
  })
})

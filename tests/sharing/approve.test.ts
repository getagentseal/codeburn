import { describe, it, expect, beforeAll, afterAll } from 'vitest'

import { generateIdentity, type Identity } from '../../src/sharing/identity.js'
import { PeerStore, pairingCode } from '../../src/sharing/pairing.js'
import { ShareServer } from '../../src/sharing/share-server.js'
import { pairRequest, fetchUsage } from '../../src/sharing/client.js'

describe('pairingCode', () => {
  it('is order-independent, deterministic, and 3 digits', () => {
    expect(pairingCode('aaa', 'bbb')).toBe(pairingCode('bbb', 'aaa'))
    expect(pairingCode('aaa', 'bbb')).toMatch(/^\d{3}$/)
    expect(pairingCode('aaa', 'bbb')).toBe(pairingCode('aaa', 'bbb'))
  })
})

describe('approve-style pairing (no PIN)', () => {
  let server: ShareServer
  let serverId: Identity
  let clientId: Identity
  let port: number
  let seenCode = ''

  beforeAll(async () => {
    serverId = await generateIdentity('MacBook')
    clientId = await generateIdentity('Mac Studio')
    server = new ShareServer({
      identity: serverId,
      peers: new PeerStore(),
      getUsage: async () => ({ current: { cost: 7 } }),
      approve: async (req) => {
        seenCode = req.code
        return req.name !== 'Intruder'
      },
    })
    port = await server.listen(0, '127.0.0.1')
  })

  afterAll(async () => {
    await server.close()
  })

  const ep = () => ({ identity: clientId, host: '127.0.0.1', port, expectedFingerprint: serverId.fingerprint })

  it('accepts an approved device, with the same code on both sides, and the token works', async () => {
    const r = await pairRequest(ep(), 'Mac Studio')
    expect(r.status).toBe(200)
    const body = r.json as { token: string; code: string }
    expect(body.token).toBeTruthy()
    // Both ends derive the same confirmation code from the two fingerprints.
    expect(body.code).toBe(pairingCode(serverId.fingerprint, clientId.fingerprint))
    expect(seenCode).toBe(body.code)

    const usage = await fetchUsage(ep(), body.token)
    expect(usage.status).toBe(200)
    expect((usage.json as { current: { cost: number } }).current.cost).toBe(7)
  })

  it('rejects a declined device', async () => {
    const r = await pairRequest(ep(), 'Intruder')
    expect(r.status).toBe(403)
  })
})

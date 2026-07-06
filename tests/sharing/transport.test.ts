import { describe, it, expect, beforeAll, afterAll } from 'vitest'

import { generateIdentity, type Identity } from '../../src/sharing/identity.js'
import { PeerStore } from '../../src/sharing/pairing.js'
import { ShareServer } from '../../src/sharing/share-server.js'
import { getDateRange, parsePeriodOrThrow } from '../../src/cli-date.js'
import { hello, pair, fetchUsage } from '../../src/sharing/client.js'

describe('device sharing transport (loopback mutual TLS)', () => {
  let server: ShareServer
  let serverId: Identity
  let clientId: Identity
  let peers: PeerStore
  let port: number

  beforeAll(async () => {
    serverId = await generateIdentity('MacBook')
    clientId = await generateIdentity('Mac Studio')
    peers = new PeerStore()
    server = new ShareServer({ identity: serverId, peers, getUsage: async () => ({ current: { cost: 42 } }) })
    port = await server.listen(0, '127.0.0.1')
  })

  afterAll(async () => {
    await server.close()
  })

  const ep = () => ({ identity: clientId, host: '127.0.0.1', port })

  it('hello exposes name + fingerprint, and the client sees the right cert', async () => {
    const r = await hello(ep())
    expect(r.status).toBe(200)
    const body = r.json as { name: string; fingerprint: string }
    expect(body.name).toBe('MacBook')
    expect(body.fingerprint).toBe(serverId.fingerprint)
    expect(r.serverFingerprint).toBe(serverId.fingerprint)
  })

  it('denies usage before pairing', async () => {
    const r = await fetchUsage(ep(), 'no-token')
    expect(r.status).toBe(401)
  })

  it('pairs with a valid PIN, then authorizes a pinned usage pull', async () => {
    const pin = server.openPairing()
    const pr = await pair(ep(), pin, 'Mac Studio')
    expect(pr.status).toBe(200)
    const token = (pr.json as { token: string }).token
    expect(token).toBeTruthy()

    const ur = await fetchUsage({ ...ep(), expectedFingerprint: serverId.fingerprint }, token)
    expect(ur.status).toBe(200)
    expect((ur.json as { current: { cost: number } }).current.cost).toBe(42)
  })

  it('returns bad request when getUsage rejects an invalid period', async () => {
    const badServer = new ShareServer({
      identity: serverId,
      peers,
      getUsage: async (q) => {
        getDateRange(parsePeriodOrThrow(q.period ?? 'month'))
        return { current: { cost: 0 } }
      },
    })
    const badPort = await badServer.listen(0, '127.0.0.1')
    try {
      const pin = badServer.openPairing()
      const pr = await pair({ ...ep(), port: badPort }, pin, 'Mac Studio')
      const token = (pr.json as { token: string }).token
      const ur = await fetchUsage(
        { ...ep(), port: badPort, expectedFingerprint: serverId.fingerprint },
        token,
        { period: 'garbage' },
      )
      expect(ur.status).toBe(400)
      expect((ur.json as { error: string }).error).toMatch(/Unknown period "garbage"/)
    } finally {
      await badServer.close()
    }
  })

  it('keeps unexpected getUsage failures as internal errors', async () => {
    const badServer = new ShareServer({
      identity: serverId,
      peers,
      getUsage: async () => {
        throw new Error('database temporarily unavailable')
      },
    })
    const badPort = await badServer.listen(0, '127.0.0.1')
    try {
      const pin = badServer.openPairing()
      const pr = await pair({ ...ep(), port: badPort }, pin, 'Mac Studio')
      const token = (pr.json as { token: string }).token
      const ur = await fetchUsage(
        { ...ep(), port: badPort, expectedFingerprint: serverId.fingerprint },
        token,
      )
      expect(ur.status).toBe(500)
      expect((ur.json as { error: string }).error).toMatch(/database temporarily unavailable/)
    } finally {
      await badServer.close()
    }
  })

  it('does not classify plain string-matched errors as usage validation errors', async () => {
    const badServer = new ShareServer({
      identity: serverId,
      peers,
      getUsage: async () => {
        throw new Error('Unknown period "garbage". Valid values: today, week, 30days, month, all.')
      },
    })
    const badPort = await badServer.listen(0, '127.0.0.1')
    try {
      const pin = badServer.openPairing()
      const pr = await pair({ ...ep(), port: badPort }, pin, 'Mac Studio')
      const token = (pr.json as { token: string }).token
      const ur = await fetchUsage(
        { ...ep(), port: badPort, expectedFingerprint: serverId.fingerprint },
        token,
      )
      expect(ur.status).toBe(500)
      expect((ur.json as { error: string }).error).toMatch(/Unknown period "garbage"/)
    } finally {
      await badServer.close()
    }
  })

  it('rejects a wrong PIN', async () => {
    server.openPairing()
    const pr = await pair(ep(), '000000', 'x')
    expect(pr.status).toBe(401)
  })

  it('rejects a token replayed from a different device fingerprint', async () => {
    const pin = server.openPairing()
    const pr = await pair(ep(), pin, 'Mac Studio')
    const token = (pr.json as { token: string }).token
    const attacker = await generateIdentity('Evil')
    const r = await fetchUsage({ identity: attacker, host: '127.0.0.1', port }, token)
    expect(r.status).toBe(401)
  })

  it('aborts when the peer fingerprint does not match the pin', async () => {
    await expect(hello({ ...ep(), expectedFingerprint: 'deadbeef' })).rejects.toThrow(/fingerprint mismatch/)
  })
})

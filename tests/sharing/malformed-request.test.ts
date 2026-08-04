import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { connect as tlsConnect } from 'tls'

import { generateIdentity, type Identity } from '../../src/sharing/identity.js'
import { PeerStore } from '../../src/sharing/pairing.js'
import { ShareServer } from '../../src/sharing/share-server.js'

// The share server listens on the LAN for device pairing and is dispatched via
// `void this.handle(...)`, so a throw inside handle() is an UNHANDLED rejection.
// A request target the HTTP parser accepts but the WHATWG URL parser rejects
// (an unterminated IPv6 host) used to throw at `new URL(...)` before the
// try/catch, which could crash the host process. The server must instead answer
// and stay alive.
describe('share server: malformed request URL does not crash the process', () => {
  let server: ShareServer
  let serverId: Identity
  let clientId: Identity
  let port: number

  beforeAll(async () => {
    serverId = await generateIdentity('Server')
    clientId = await generateIdentity('Client')
    server = new ShareServer({ identity: serverId, peers: new PeerStore(), getUsage: async () => ({ current: { cost: 1 } }) })
    port = await server.listen(0, '127.0.0.1')
  })

  afterAll(async () => {
    await server.close()
  })

  // Send one raw HTTP request line over mTLS and resolve with the response head.
  function rawRequest(line: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = tlsConnect(
        { host: '127.0.0.1', port, key: clientId.key, cert: clientId.cert, rejectUnauthorized: false },
        () => socket.write(`${line}\r\nHost: localhost\r\nConnection: close\r\n\r\n`),
      )
      let buf = ''
      socket.setTimeout(4000, () => { socket.destroy(); reject(new Error('timed out (server hung)')) })
      socket.on('data', (d) => { buf += d.toString() })
      socket.on('end', () => resolve(buf))
      socket.on('error', reject)
    })
  }

  it('answers an unterminated-IPv6 target instead of hanging or crashing', async () => {
    // `new URL('//[::1', 'https://localhost')` throws TypeError; llhttp accepts
    // the target, so this exercises the exact pre-try throw path.
    const res = await rawRequest('GET //[::1 HTTP/1.1')
    expect(res).toMatch(/^HTTP\/1\.1 400/)
  })

  it('is still alive for a valid request afterward', async () => {
    const res = await rawRequest('GET /api/peer/hello HTTP/1.1')
    expect(res).toMatch(/^HTTP\/1\.1 200/)
    expect(res).toContain(serverId.fingerprint)
  })
})

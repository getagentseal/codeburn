import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { generateIdentity } from '../../src/sharing/identity.js'
import { PeerStore } from '../../src/sharing/pairing.js'
import { ShareServer } from '../../src/sharing/share-server.js'
import { addRemote, pullDevices, renderDevices, type DeviceUsage } from '../../src/sharing/host.js'

describe('host device flow (loopback)', () => {
  let server: ShareServer
  let port: number
  let dir: string
  const remoteUsage = { current: { cost: 100, calls: 10, sessions: 2, inputTokens: 1000, outputTokens: 200 } }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cb-host-'))
    const serverId = await generateIdentity('MacBook')
    server = new ShareServer({ identity: serverId, peers: new PeerStore(), getUsage: async () => remoteUsage })
    port = await server.listen(0, '127.0.0.1')
  })

  afterAll(async () => {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('pairs, persists, pulls both devices, and combines', async () => {
    const pin = server.openPairing()
    const device = await addRemote(`127.0.0.1:${port}`, pin, { defaultPort: port, dir })
    expect(device.name).toBe('MacBook')
    expect(device.token).toBeTruthy()

    const localUsage = { current: { cost: 50, calls: 5, sessions: 1, inputTokens: 500, outputTokens: 100 } }
    const results = await pullDevices(async () => localUsage, { period: 'month' }, 'Mac Studio', { dir })

    expect(results).toHaveLength(2)
    expect(results[0]!.local).toBe(true)
    expect(results[0]!.payload!.current!.cost).toBe(50)
    const remote = results.find((r) => !r.local)!
    expect(remote.name).toBe('MacBook')
    expect(remote.payload!.current!.cost).toBe(100)

    const text = renderDevices(results)
    expect(text).toContain('Mac Studio (this Mac)')
    expect(text).toContain('MacBook')
    expect(text).toContain('Combined')
    expect(text).toContain('150') // combined cost 50 + 100
  })

  it('renders an unreachable device as an error without dropping the combined row', () => {
    const results: DeviceUsage[] = [
      { name: 'Mac Studio', local: true, payload: { current: { cost: 10, calls: 1, sessions: 1, inputTokens: 1, outputTokens: 1 } } },
      { name: 'MacBook', local: false, error: 'connection refused' },
    ]
    const text = renderDevices(results)
    expect(text).toContain('connection refused')
    expect(text).toContain('Combined')
  })
})

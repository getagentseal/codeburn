import { describe, it, expect } from 'vitest'

import { generateIdentity } from '../../src/sharing/identity.js'
import { hello } from '../../src/sharing/client.js'

describe('peer connect timeout', () => {
  it('fails fast when a peer is unreachable instead of riding the OS connect timeout', async () => {
    const id = await generateIdentity('Test')
    // RFC5737 TEST-NET-1 is reserved and black-holed: the SYN gets no answer,
    // so without the connect-phase cap this would hang ~75s on macOS.
    const start = Date.now()
    await expect(hello({ identity: id, host: '192.0.2.1', port: 7777 })).rejects.toThrow()
    expect(Date.now() - start).toBeLessThan(6000)
  }, 15000)
})

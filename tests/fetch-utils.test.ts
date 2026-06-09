import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { type AddressInfo } from 'node:net'

import { fetchWithTimeout } from '../src/fetch-utils.js'

let server: Server

afterEach(async () => {
  await new Promise<void>(resolve => server?.close(() => resolve()))
})

function listen(handler: (respond: () => void) => void): Promise<string> {
  return new Promise(resolve => {
    server = createServer((_req, res) => handler(() => res.end('{"ok":true}')))
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve(`http://127.0.0.1:${port}/`)
    })
  })
}

describe('fetchWithTimeout', () => {
  it('aborts when the server never responds, within the timeout window', async () => {
    // Accept the request but never reply — the half-open-network case.
    const url = await listen(() => { /* never respond */ })

    const start = Date.now()
    await expect(fetchWithTimeout(url, {}, 150)).rejects.toMatchObject({ name: 'TimeoutError' })
    const elapsed = Date.now() - start

    // Fails fast at ~the timeout, not hanging indefinitely.
    expect(elapsed).toBeLessThan(2000)
  })

  it('returns the response when the server replies before the timeout', async () => {
    const url = await listen(respond => respond())

    const res = await fetchWithTimeout(url, {}, 2000)
    expect(res.ok).toBe(true)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('still aborts on timeout when the caller also passes a signal', async () => {
    const url = await listen(() => { /* never respond */ })
    const controller = new AbortController()

    await expect(fetchWithTimeout(url, { signal: controller.signal }, 150))
      .rejects.toMatchObject({ name: 'TimeoutError' })
  })
})

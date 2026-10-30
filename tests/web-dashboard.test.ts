import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AddressInfo } from 'net'
import type { Server } from 'http'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { request } from 'http'

import { injectDashboardBootstrap, isAllowedHost, isAllowedOrigin, runWebDashboard } from '../src/web-dashboard.js'
import { setHome } from './setup/home.js'

describe('web dashboard bootstrap injection', () => {
  it('keeps replacement syntax in a payload value literal', () => {
    const payloadValue = "$`|$'|$&|$1"
    const payload = { devices: [{ name: payloadValue }] }
    const html = '<!doctype html><script type="module" src="/app.js"></script>'

    const injected = injectDashboardBootstrap(html, payload)

    expect(injected).toContain(`window.__CODEBURN_BOOTSTRAP__=${JSON.stringify(payload)}</script>`)
    expect(injected).toContain(`"name":"${payloadValue}"`)
  })

  it('escapes script-closing payload values and preserves the served bootstrap payload', () => {
    const hostileName = '</script><script>globalThis.bootstrapPwned = true</script>'
    const payload = {
      devices: [{
        id: 'local',
        name: hostileName,
        payload: { current: { topProjects: [{ name: hostileName }] } },
      }],
    }
    const html = '<!doctype html><script type="module" src="/app.js"></script>'

    const servedHtml = injectDashboardBootstrap(html, payload)
    const marker = 'window.__CODEBURN_BOOTSTRAP__='
    const start = servedHtml.indexOf(marker) + marker.length
    const end = servedHtml.indexOf('</script>', start)
    const serialized = servedHtml.slice(start, end)

    expect(serialized).not.toContain('</script')
    expect(serialized).toContain('\\u003c/script>')
    expect(JSON.parse(serialized)).toEqual(payload)
  })
})

// Regression guard for the original bug: a bad `period` query used to hit
// process.exit(1) and kill the long-running dashboard server. The handlers must
// now answer 400 and keep serving.
describe('web dashboard server: invalid query returns 400 without exiting', () => {
  let server: Server
  let base: string
  let homeDir: string
  let cacheDir: string
  const prevHome = process.env['HOME']
  const prevCache = process.env['CODEBURN_CACHE_DIR']

  beforeAll(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'codeburn-web-home-'))
    cacheDir = await mkdtemp(join(tmpdir(), 'codeburn-web-cache-'))
    setHome(homeDir)
    process.env['CODEBURN_CACHE_DIR'] = cacheDir
    server = await runWebDashboard({
      period: 'today', provider: 'all', project: [], exclude: [], port: 0, open: false,
    })
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (prevHome === undefined) setHome(undefined)
    else setHome(prevHome)
    if (prevCache === undefined) delete process.env['CODEBURN_CACHE_DIR']
    else process.env['CODEBURN_CACHE_DIR'] = prevCache
    await rm(homeDir, { recursive: true, force: true })
    await rm(cacheDir, { recursive: true, force: true })
  })

  it('answers 400 for an invalid /api/usage period and keeps serving', async () => {
    const bad = await fetch(`${base}/api/usage?period=garbage`)
    expect(bad.status).toBe(400)
    expect((await bad.json() as { error: string }).error).toMatch(/Unknown period "garbage"/)

    // The bug was process.exit; if it regressed, this test process would die.
    // A successful follow-up request proves the server survived the bad one.
    const ok = await fetch(`${base}/api/usage?period=today`)
    expect(ok.status).toBe(200)
    const payload = await ok.json() as { history: { timeline?: { bucketMinutes: number; points: unknown[] } } }
    expect(payload.history.timeline?.bucketMinutes).toBe(15)
    expect(Array.isArray(payload.history.timeline?.points)).toBe(true)
  })

  it('answers 400 for an invalid /api/devices period', async () => {
    const bad = await fetch(`${base}/api/devices?period=garbage`)
    expect(bad.status).toBe(400)
    expect((await bad.json() as { error: string }).error).toMatch(/Unknown period "garbage"/)
  })
})

describe('web dashboard host and origin guard', () => {
  const none = new Set<string>()
  const proxied = new Set(['dash.example.org'])

  it('accepts only loopback names by default', () => {
    for (const h of ['127.0.0.1:4747', 'localhost', 'LOCALHOST:80', '[::1]:4747', '::1']) {
      expect(isAllowedHost(h, none), h).toBe(true)
    }
    for (const h of ['dash.example.org', 'evil.example', '127.0.0.1.evil.example', '', undefined]) {
      expect(isAllowedHost(h, none), String(h)).toBe(false)
    }
  })

  it('accepts an --allowed-host name with any port, and nothing that merely contains it', () => {
    expect(isAllowedHost('dash.example.org:8443', proxied)).toBe(true)
    expect(isAllowedHost('DASH.example.org', proxied)).toBe(true)
    expect(isAllowedHost('dash.example.org.evil.example', proxied)).toBe(false)
    expect(isAllowedHost('evil-dash.example.org', proxied)).toBe(false)
  })

  it('checks the Origin the same way, http and https only', () => {
    expect(isAllowedOrigin('http://127.0.0.1:4747', none)).toBe(true)
    expect(isAllowedOrigin('https://dash.example.org:8443', none)).toBe(false)
    expect(isAllowedOrigin('https://dash.example.org:8443', proxied)).toBe(true)
    expect(isAllowedOrigin('https://evil.example', proxied)).toBe(false)
    expect(isAllowedOrigin('file://dash.example.org', proxied)).toBe(false)
    expect(isAllowedOrigin('null', proxied)).toBe(false)
  })
})

describe('web dashboard server behind a reverse proxy', () => {
  let server: Server
  let port: number
  let homeDir: string
  let cacheDir: string
  const prevHome = process.env['HOME']
  const prevCache = process.env['CODEBURN_CACHE_DIR']

  // fetch() may not set Host, so use http.request to play the proxy.
  const get = (path: string, headers: Record<string, string>): Promise<number> =>
    new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      req.on('error', reject)
      req.end()
    })

  beforeAll(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'codeburn-web-home-'))
    cacheDir = await mkdtemp(join(tmpdir(), 'codeburn-web-cache-'))
    setHome(homeDir)
    process.env['CODEBURN_CACHE_DIR'] = cacheDir
    server = await runWebDashboard({
      period: 'today', provider: 'all', project: [], exclude: [], port: 0, open: false,
      allowedHosts: ['dash.example.org'],
    })
    port = (server.address() as AddressInfo).port
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (prevHome === undefined) setHome(undefined)
    else setHome(prevHome)
    if (prevCache === undefined) delete process.env['CODEBURN_CACHE_DIR']
    else process.env['CODEBURN_CACHE_DIR'] = prevCache
    await rm(homeDir, { recursive: true, force: true })
    await rm(cacheDir, { recursive: true, force: true })
  })

  it('serves a request addressed to the allowed host', async () => {
    expect(await get('/api/usage?period=today', { host: 'dash.example.org:8443' })).toBe(200)
    expect(await get('/api/usage?period=today', {
      host: 'dash.example.org:8443', origin: 'https://dash.example.org:8443',
    })).toBe(200)
  })

  it('still refuses other hosts and cross-origin requests', async () => {
    expect(await get('/api/usage?period=today', { host: 'evil.example' })).toBe(403)
    expect(await get('/api/usage?period=today', {
      host: 'dash.example.org', origin: 'https://evil.example',
    })).toBe(403)
  })
})

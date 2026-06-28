import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AddressInfo } from 'net'
import type { Server } from 'http'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runWebDashboard } from '../src/web-dashboard.js'

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
    process.env['HOME'] = homeDir
    process.env['CODEBURN_CACHE_DIR'] = cacheDir
    server = await runWebDashboard({
      period: 'today', provider: 'all', project: [], exclude: [], port: 0, open: false,
    })
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
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
  })

  it('answers 400 for an invalid /api/devices period', async () => {
    const bad = await fetch(`${base}/api/devices?period=garbage`)
    expect(bad.status).toBe(400)
    expect((await bad.json() as { error: string }).error).toMatch(/Unknown period "garbage"/)
  })
})

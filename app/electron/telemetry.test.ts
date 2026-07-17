// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { defaultEnabledFor, Telemetry } from './telemetry'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cb-telemetry-'))
  delete process.env.CODEBURN_TELEMETRY_DEV
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.CODEBURN_TELEMETRY_DEV
})

function make(over: Partial<ConstructorParameters<typeof Telemetry>[0]> = {}) {
  const posts: Array<{ url: string; body: unknown }> = []
  const fetchFn = vi.fn(async (url: unknown, init?: { body?: unknown }) => {
    posts.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    return { ok: true } as Response
  }) as unknown as typeof fetch
  const telemetry = new Telemetry({
    stateDir: dir,
    country: 'US',
    isPackaged: true,
    appVersion: '1.0.0',
    fetchFn,
    ...over,
  })
  return { telemetry, posts, fetchFn }
}

describe('regional consent defaults', () => {
  it('defaults OFF in the EU/EEA/UK/CH and for unknown regions, ON elsewhere', () => {
    for (const c of ['DE', 'FR', 'NL', 'SE', 'GB', 'CH', 'NO', 'IS']) expect(defaultEnabledFor(c), c).toBe(false)
    for (const c of ['US', 'CA', 'JP', 'AU', 'BR', 'IN']) expect(defaultEnabledFor(c), c).toBe(true)
    expect(defaultEnabledFor(null)).toBe(false)
    expect(defaultEnabledFor(undefined)).toBe(false)
  })

  it('a fresh EU install starts disabled; a fresh US install starts enabled', () => {
    const eu = new Telemetry({ stateDir: join(dir, 'eu'), country: 'DE', isPackaged: true, appVersion: '1' })
    expect(eu.status()).toMatchObject({ enabled: false, defaultEnabled: false, onboarded: false })
    const us = new Telemetry({ stateDir: join(dir, 'us'), country: 'US', isPackaged: true, appVersion: '1' })
    expect(us.status()).toMatchObject({ enabled: true, defaultEnabled: true, onboarded: false })
  })
})

describe('consent gating', () => {
  it('never sends before onboarding completes, even when enabled', async () => {
    const { telemetry, posts } = make()
    telemetry.track('app_open', {})
    expect(await telemetry.flush()).toBe(false)
    expect(posts.length).toBe(0)
  })

  it('sends after onboarding, and stops (dropping the queue) when disabled', async () => {
    const { telemetry, posts } = make()
    telemetry.completeOnboarding(true)
    telemetry.track('section_view', { section: 'spend' })
    expect(await telemetry.flush()).toBe(true)
    expect(posts.length).toBe(1)

    telemetry.setEnabled(false)
    telemetry.track('section_view', { section: 'models' })
    expect(telemetry.queueLength).toBe(0)
    expect(await telemetry.flush()).toBe(false)
    expect(posts.length).toBe(1)
  })

  it('opting out rotates the install id so history cannot be linked', () => {
    const { telemetry } = make()
    const before = telemetry.status().installId
    telemetry.setEnabled(false)
    const after = telemetry.status().installId
    expect(after).not.toBe(before)
  })

  it('unpackaged (dev) builds never send unless CODEBURN_TELEMETRY_DEV=1', async () => {
    const { telemetry, posts } = make({ isPackaged: false })
    telemetry.completeOnboarding(true)
    expect(await telemetry.flush()).toBe(false)
    expect(posts.length).toBe(0)

    process.env.CODEBURN_TELEMETRY_DEV = '1'
    telemetry.track('app_open', {})
    expect(await telemetry.flush()).toBe(true)
    expect(posts.length).toBe(1)
  })

  it('persists consent + install id across instances', () => {
    const { telemetry } = make()
    const id = telemetry.completeOnboarding(true).installId
    const reloaded = new Telemetry({ stateDir: dir, country: 'US', isPackaged: true, appVersion: '1' })
    expect(reloaded.status()).toMatchObject({ installId: id, enabled: true, onboarded: true })
    const raw = JSON.parse(readFileSync(join(dir, 'telemetry.v1.json'), 'utf-8'))
    expect(raw.installId).toBe(id)
  })
})

describe('events', () => {
  it('drops unknown event names and sanitizes props', async () => {
    const { telemetry, posts } = make()
    telemetry.completeOnboarding(true) // queues app_open
    telemetry.track('totally_made_up', { a: 1 })
    telemetry.track('section_view', {
      section: 'x'.repeat(500),
      junk: { nested: 'object' },
      fn: () => {},
      nan: NaN,
      ok: 42,
    })
    await telemetry.flush()
    const body = posts[0]!.body as { events: Array<{ name: string; day: string; props: Record<string, unknown> }> }
    expect(body.events.map(e => e.name)).toEqual(['app_open', 'section_view'])
    const props = body.events[1]!.props
    expect((props.section as string).length).toBe(64)
    expect(props.junk).toBeUndefined()
    expect(props.fn).toBeUndefined()
    expect(props.nan).toBeUndefined()
    expect(props.ok).toBe(42)
    // Day-granularity timestamps only.
    expect(body.events[0]!.day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('stamps events with the LOCAL calendar day, not the UTC day', async () => {
    const savedTZ = process.env.TZ
    process.env.TZ = 'America/Los_Angeles' // UTC-07/08
    try {
      // 05:00Z is still the previous local day in LA (22:00). UTC-bucketing would
      // stamp 2026-07-17; the local calendar day is 2026-07-16.
      const instant = new Date('2026-07-17T05:00:00Z')
      const { telemetry, posts } = make({ now: () => instant })
      telemetry.completeOnboarding(true) // queues app_open at `instant`
      await telemetry.flush()
      const body = posts[0]!.body as { events: Array<{ day: string }> }
      expect(body.events[0]!.day).toBe('2026-07-16')
    } finally {
      if (savedTZ === undefined) delete process.env.TZ
      else process.env.TZ = savedTZ
    }
  })

  it('caps usage_snapshot at one per calendar day', () => {
    const { telemetry } = make()
    telemetry.completeOnboarding(true)
    const before = telemetry.queueLength
    telemetry.track('usage_snapshot', { costBucket: '1-10' })
    telemetry.track('usage_snapshot', { costBucket: '10-50' })
    expect(telemetry.queueLength).toBe(before + 1)
  })

  it('keeps the queue on a transient failure (5xx) and clears it on success', async () => {
    let ok = false
    const fetchFn = vi.fn(async () => ({ ok, status: 503 })) as unknown as typeof fetch
    const { telemetry } = make({ fetchFn })
    telemetry.completeOnboarding(true)
    expect(await telemetry.flush()).toBe(false)
    expect(telemetry.queueLength).toBe(1)
    ok = true
    expect(await telemetry.flush()).toBe(true)
    expect(telemetry.queueLength).toBe(0)
  })

  it('drops a permanently rejected batch (4xx) instead of wedging the queue', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 400 })) as unknown as typeof fetch
    const { telemetry } = make({ fetchFn })
    telemetry.completeOnboarding(true)
    expect(await telemetry.flush()).toBe(false)
    expect(telemetry.queueLength).toBe(0)
  })

  it('batches with the wire contract: schema, installId, app block, events', async () => {
    const { telemetry, posts } = make()
    telemetry.completeOnboarding(true)
    await telemetry.flush()
    const body = posts[0]!.body as Record<string, unknown>
    expect(body.schema).toBe(1)
    expect(typeof body.installId).toBe('string')
    expect(body.app).toMatchObject({ name: 'codeburn-desktop', version: '1.0.0', country: 'US' })
    expect(Array.isArray(body.events)).toBe(true)
  })
})

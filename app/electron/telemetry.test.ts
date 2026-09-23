// @vitest-environment node
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { cpuBucket, defaultEnabledFor, memBucket, Telemetry } from './telemetry'

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

  it('reports whether the decision reached disk, and never tears the file', () => {
    const { telemetry } = make()
    const file = join(dir, 'telemetry.v1.json')
    expect(telemetry.completeOnboarding(false).persisted).toBe(true)
    const before = readFileSync(file, 'utf-8')

    // The menu bar app inherits the decision from this file, so a write that
    // cannot land must be reported, not swallowed behind an in-memory success.
    chmodSync(dir, 0o500)
    let status
    try {
      status = telemetry.setEnabled(true)
    } finally {
      chmodSync(dir, 0o700)
    }

    expect(status).toMatchObject({ enabled: true, persisted: false })
    // Old file wholly intact, and no half-written temp left beside it.
    expect(readFileSync(file, 'utf-8')).toBe(before)
    expect(readdirSync(dir)).toEqual(['telemetry.v1.json'])

    // And the in-memory decision still holds for this session.
    expect(telemetry.status().enabled).toBe(true)
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
      junk: new Date(),
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

  it('keeps the daily snapshot shape but drops anything deeper or bigger', async () => {
    const { telemetry, posts } = make()
    telemetry.completeOnboarding(true)
    telemetry.track('usage_snapshot', {
      schema: 2,
      models: [{ name: 'Sonnet 4.5', tasks: [{ name: 'Coding', share: 0.75 }] }],
      categories: [{ name: 'Coding', topModels: ['Sonnet 4.5', 'Opus 4.6'] }],
      sessions: { countBucket: '100-1k' },
      // One container deeper than the snapshot's own deepest shape.
      tooDeep: [{ a: [{ b: [{ c: 1 }] }] }],
      wide: Array.from({ length: 40 }, (_, i) => ({ name: `n${i}` })),
    })
    await telemetry.flush()
    const props = (posts[0]!.body as { events: Array<{ name: string; props: Record<string, unknown> }> }).events[1]!.props

    expect(props.models).toEqual([{ name: 'Sonnet 4.5', tasks: [{ name: 'Coding', share: 0.75 }] }])
    expect(props.categories).toEqual([{ name: 'Coding', topModels: ['Sonnet 4.5', 'Opus 4.6'] }])
    expect(props.sessions).toEqual({ countBucket: '100-1k' })
    expect(props.tooDeep).toBeUndefined()
    expect(props.wide).toHaveLength(12)
  })

  it('accepts the name-only interaction events', async () => {
    const { telemetry, posts } = make()
    telemetry.completeOnboarding(true)
    telemetry.track('optimize_apply', { kind: 'claude-md-too-long', fixType: 'file-content' })
    telemetry.track('plan_set', { provider: 'cursor', plan: 'cursor-pro' })
    telemetry.track('export', { format: 'json', provider: 'all' })
    telemetry.track('compare_view', { modelA: 'Sonnet 4.5', modelB: 'Opus 4.6' })
    telemetry.track('settings_change', { setting: 'theme', value: 'dark' })
    await telemetry.flush()
    const events = (posts[0]!.body as { events: Array<{ name: string; props: Record<string, unknown> }> }).events

    expect(events.map(event => event.name)).toEqual([
      'app_open', 'optimize_apply', 'plan_set', 'export', 'compare_view', 'settings_change',
    ])
    expect(events[1]!.props).toEqual({ kind: 'claude-md-too-long', fixType: 'file-content' })
    expect(events[5]!.props).toEqual({ setting: 'theme', value: 'dark' })
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

  it('caps cli_error per kind per local day while leaving other events unaffected', async () => {
    let instant = new Date('2026-07-17T12:00:00')
    const { telemetry, posts } = make({ now: () => instant })
    telemetry.completeOnboarding(true)

    for (let i = 0; i < 25; i++) telemetry.track('cli_error', { kind: 'timeout', cmd: 'status' })
    telemetry.track('cli_error', { kind: 'not-found', cmd: 'status' })
    telemetry.track('section_view', { section: 'spend' })

    expect(telemetry.queueLength).toBe(23) // app_open + 20 timeout + one other kind + one other event

    instant = new Date('2026-07-18T12:00:00')
    telemetry.track('cli_error', { kind: 'timeout', cmd: 'status' })
    expect(telemetry.queueLength).toBe(24)

    await telemetry.flush()
    const body = posts[0]!.body as { events: Array<{ name: string; day: string; props: Record<string, unknown> }> }
    const timeoutEvents = body.events.filter(event => event.name === 'cli_error' && event.props.kind === 'timeout')
    expect(timeoutEvents.filter(event => event.day === '2026-07-17')).toHaveLength(20)
    expect(timeoutEvents.filter(event => event.day === '2026-07-18')).toHaveLength(1)
    expect(body.events.filter(event => event.name === 'cli_error' && event.props.kind === 'not-found')).toHaveLength(1)
    expect(body.events.filter(event => event.name === 'section_view')).toHaveLength(1)
  })

  it('persists the cli_error cap across restarts on the same local day', () => {
    const instant = new Date('2026-07-17T12:00:00')
    const { telemetry } = make({ now: () => instant })
    telemetry.completeOnboarding(true)
    for (let i = 0; i < 20; i++) telemetry.track('cli_error', { kind: 'timeout', cmd: 'status' })

    const reloaded = new Telemetry({ stateDir: dir, country: 'US', isPackaged: true, appVersion: '1', now: () => instant })
    reloaded.track('cli_error', { kind: 'timeout', cmd: 'status' })
    expect(reloaded.queueLength).toBe(0)
    reloaded.track('cli_error', { kind: 'not-found', cmd: 'status' })
    expect(reloaded.queueLength).toBe(1)

    const raw = JSON.parse(readFileSync(join(dir, 'telemetry.v1.json'), 'utf-8'))
    expect(raw).toMatchObject({ cliErrorDay: '2026-07-17', cliErrorCounts: { timeout: 20, 'not-found': 1 } })
  })

  it('falls back to fresh cli_error counters when the persisted budget is malformed', () => {
    const instant = new Date('2026-07-17T12:00:00')
    const { telemetry } = make({ now: () => instant })
    telemetry.completeOnboarding(true)
    const stateFile = join(dir, 'telemetry.v1.json')
    const raw = JSON.parse(readFileSync(stateFile, 'utf-8'))
    writeFileSync(stateFile, JSON.stringify({ ...raw, cliErrorDay: '2026-07-17', cliErrorCounts: { timeout: 'many' } }))

    const reloaded = new Telemetry({ stateDir: dir, country: 'US', isPackaged: true, appVersion: '1', now: () => instant })
    for (let i = 0; i < 25; i++) reloaded.track('cli_error', { kind: 'timeout', cmd: 'status' })
    expect(reloaded.queueLength).toBe(20)
    expect(reloaded.status()).toMatchObject({ enabled: true, onboarded: true })
  })

  it('evicts the oldest event so app_close survives a full queue', async () => {
    const { telemetry, posts } = make()
    telemetry.completeOnboarding(true)
    for (let i = 0; i < 199; i++) telemetry.track('section_view', { section: `section-${i}` })
    telemetry.track('section_view', { section: 'dropped-at-capacity' })
    expect(telemetry.queueLength).toBe(200)

    telemetry.trackClose()
    expect(telemetry.queueLength).toBe(200)
    await telemetry.flush()

    const body = posts[0]!.body as { events: Array<{ name: string; props: Record<string, unknown> }> }
    expect(body.events).toHaveLength(200)
    expect(body.events[0]).toMatchObject({ name: 'section_view', props: { section: 'section-0' } })
    expect(body.events.at(-1)?.name).toBe('app_close')
    expect(body.events.some(event => event.props.section === 'dropped-at-capacity')).toBe(false)
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

describe('resource usage buckets', () => {
  it('places every CPU boundary in the higher bucket', () => {
    expect(cpuBucket(0)).toBe('<1')
    expect(cpuBucket(0.99)).toBe('<1')
    expect(cpuBucket(1)).toBe('1-5')
    expect(cpuBucket(4.99)).toBe('1-5')
    expect(cpuBucket(5)).toBe('5-15')
    expect(cpuBucket(14.99)).toBe('5-15')
    expect(cpuBucket(15)).toBe('15-40')
    expect(cpuBucket(39.99)).toBe('15-40')
    expect(cpuBucket(40)).toBe('40+')
    expect(cpuBucket(1200)).toBe('40+')
    // Unmeasurable reads as the lowest bucket, never as a thrown close.
    expect(cpuBucket(Number.NaN)).toBe('<1')
    expect(cpuBucket(-5)).toBe('<1')
  })

  it('places every memory boundary in the higher bucket', () => {
    expect(memBucket(0)).toBe('<250')
    expect(memBucket(249.9)).toBe('<250')
    expect(memBucket(250)).toBe('250-500')
    expect(memBucket(499.9)).toBe('250-500')
    expect(memBucket(500)).toBe('500-1k')
    expect(memBucket(999.9)).toBe('500-1k')
    expect(memBucket(1000)).toBe('1-3k')
    expect(memBucket(2999.9)).toBe('1-3k')
    expect(memBucket(3000)).toBe('3k+')
    expect(memBucket(Number.NaN)).toBe('<250')
  })
})

describe('app_close resource usage', () => {
  const SESSION_MS = 10 * 60_000
  const OPENED_AT = Date.parse('2026-09-19T09:00:00Z')
  /// Both counters are cumulative since their own process started, so the mocks below grow
  /// with the clock and carry a head start from before telemetry was constructed.
  const elapsedSec = () => (Date.now() - OPENED_AT) / 1000

  afterEach(() => { vi.useRealTimers() })

  async function closeWith(over: Partial<ConstructorParameters<typeof Telemetry>[0]>, sample = false, sessionMs = SESSION_MS) {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-19T09:00:00Z'))
    const { telemetry, posts } = make(over)
    telemetry.completeOnboarding(true)
    vi.setSystemTime(new Date(Date.now() + sessionMs))
    if (sample) telemetry.sampleResources()
    telemetry.trackClose()
    await telemetry.flush()
    const body = posts[0]!.body as { events: Array<{ name: string; props: Record<string, unknown> }> }
    return body.events.find(event => event.name === 'app_close')!.props
  }

  it('carries app and serve buckets when both report metrics', async () => {
    const props = await closeWith({
      // 30 CPU-seconds over a 600s session is 5% of one core; 600MB of working set. The
      // 400 and 100 already on the clocks belong to the time before this session.
      getAppMetrics: () => [
        { cpu: { cumulativeCPUUsage: 400 + elapsedSec() * 0.03, percentCPUUsage: 0 }, memory: { workingSetSize: 400 * 1024 } },
        { cpu: { cumulativeCPUUsage: 100 + elapsedSec() * 0.02, percentCPUUsage: 0 }, memory: { workingSetSize: 200 * 1024 } },
      ],
      getServeUsage: () => ({ cpuSec: 900 + elapsedSec() * 0.2, rssMb: 1200 }),
    })
    expect(props).toEqual({ sessionMinutes: 10, cpu: '5-15', mem: '500-1k', serveCpu: '15-40', serveMem: '1-3k' })
  })

  // The counters run from each process's own start, the wall clock from telemetry's: a
  // desktop app that had been open for hours read as pinned CPU for a session that did
  // nothing at all.
  it('reports the CPU spent during the session, not what was already on the clock', async () => {
    const props = await closeWith({
      getAppMetrics: () => [{ cpu: { cumulativeCPUUsage: 500, percentCPUUsage: 0 }, memory: { workingSetSize: 300 * 1024 } }],
      getServeUsage: () => ({ cpuSec: 900, rssMb: 300 }),
    })
    expect(props).toMatchObject({ cpu: '<1', serveCpu: '<1' })
  })

  it('averages sampled percentages when the platform reports no cumulative CPU', async () => {
    const props = await closeWith({
      getAppMetrics: () => [{ cpu: { percentCPUUsage: 8 }, memory: { workingSetSize: 300 * 1024 } }],
      getServeUsage: () => null,
    }, true)
    expect(props).toMatchObject({ cpu: '5-15', mem: '250-500' })
    expect(props.serveCpu).toBeUndefined()
    expect(props.serveMem).toBeUndefined()
  })

  // CPU seconds count from process start, the wall clock from telemetry init, so a
  // ten-second session read '40+' however idle the app was. Memory is unaffected.
  it('omits both CPU figures on a session too short to divide by', async () => {
    const props = await closeWith({
      getAppMetrics: () => [{ cpu: { cumulativeCPUUsage: 20, percentCPUUsage: 0 }, memory: { workingSetSize: 400 * 1024 } }],
      getServeUsage: () => ({ cpuSec: 120, rssMb: 1200 }),
    }, false, 10_000)
    expect(props).toEqual({ sessionMinutes: 0, mem: '250-500', serveMem: '1-3k' })
  })

  it('omits every field it could not measure rather than sending zeros', async () => {
    const props = await closeWith({})
    expect(props).toEqual({ sessionMinutes: 10 })
  })
})

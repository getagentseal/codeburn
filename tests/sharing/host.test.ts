import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { addRemote, pullDevices, renderDevices, summarizeDeviceUsage, type DeviceUsage } from '../../src/sharing/host.js'

const clientMock = vi.hoisted(() => ({
  hello: vi.fn(),
  pair: vi.fn(),
  pairRequest: vi.fn(),
  fetchUsage: vi.fn(),
}))

vi.mock('../../src/sharing/client.js', () => clientMock)

describe('host device flow', () => {
  let dir: string

  beforeEach(async () => {
    vi.clearAllMocks()
    dir = await mkdtemp(join(tmpdir(), 'cb-host-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('pairs, persists, pulls both devices, and combines', async () => {
    const remoteUsage = { current: { cost: 100, calls: 10, sessions: 2, inputTokens: 1000, outputTokens: 200 } }
    clientMock.hello.mockResolvedValue({ status: 200, json: { fingerprint: 'remote-fp', name: 'MacBook' } })
    clientMock.pair.mockResolvedValue({ status: 200, json: { token: 'remote-token' } })
    clientMock.fetchUsage.mockResolvedValue({ status: 200, json: remoteUsage })

    const device = await addRemote('127.0.0.1:7777', '123456', { defaultPort: 7777, dir })
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
    expect(clientMock.fetchUsage).toHaveBeenCalledWith(
      expect.objectContaining({ host: '127.0.0.1', port: 7777, expectedFingerprint: 'remote-fp' }),
      'remote-token',
      { period: 'month' },
    )

    const text = renderDevices(results)
    expect(text).toContain('Mac Studio (this Mac)')
    expect(text).toContain('MacBook')
    expect(text).toContain('Combined')
    expect(text).toContain('150') // combined cost 50 + 100
  })

  it('renders an unreachable device as an error without dropping the combined row', () => {
    const results: DeviceUsage[] = [
      { id: 'local', name: 'Mac Studio', local: true, payload: { current: { cost: 10, calls: 1, sessions: 1, inputTokens: 1, outputTokens: 1 } } },
      { id: 'remote-1', name: 'MacBook', local: false, error: 'connection refused' },
    ]
    const text = renderDevices(results)
    expect(text).toContain('connection refused')
    expect(text).toContain('Combined')
  })

  it('summarizes reachable devices and excludes error rows from combined totals', () => {
    const results: DeviceUsage[] = [
      {
        id: 'local',
        name: 'Mac Studio',
        local: true,
        payload: {
          current: { cost: 10, calls: 2, sessions: 1, inputTokens: 100, outputTokens: 40 },
          history: {
            daily: [
              { cacheWriteTokens: 5, cacheReadTokens: 10 },
              { cacheWriteTokens: 7, cacheReadTokens: 3 },
            ],
          },
        },
      },
      {
        id: 'remote-1',
        name: 'MacBook',
        local: false,
        payload: {
          current: { cost: 3, calls: 4, sessions: 2, inputTokens: 20, outputTokens: 30 },
          history: { daily: [{ cacheWriteTokens: 2, cacheReadTokens: 8 }] },
        },
      },
      { id: 'remote-err', name: 'Offline', local: false, error: 'timeout' },
    ]

    const summary = summarizeDeviceUsage(results)

    expect(summary.perDevice).toEqual([
      {
        id: 'local',
        name: 'Mac Studio',
        local: true,
        cost: 10,
        calls: 2,
        sessions: 1,
        inputTokens: 100,
        outputTokens: 40,
        cacheCreateTokens: 12,
        cacheReadTokens: 13,
        totalTokens: 165,
      },
      {
        id: 'remote-1',
        name: 'MacBook',
        local: false,
        cost: 3,
        calls: 4,
        sessions: 2,
        inputTokens: 20,
        outputTokens: 30,
        cacheCreateTokens: 2,
        cacheReadTokens: 8,
        totalTokens: 60,
      },
      {
        id: 'remote-err',
        name: 'Offline',
        local: false,
        error: 'timeout',
        cost: 0,
        calls: 0,
        sessions: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreateTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
      },
    ])
    expect(summary.combined).toEqual({
      cost: 13,
      calls: 6,
      sessions: 3,
      inputTokens: 120,
      outputTokens: 70,
      cacheCreateTokens: 14,
      cacheReadTokens: 21,
      totalTokens: 225,
      deviceCount: 3,
      reachableCount: 2,
    })
  })

  it('scopes cache-token summaries to the optional window without changing no-window totals', () => {
    const results: DeviceUsage[] = [
      {
        id: 'local',
        name: 'Mac Studio',
        local: true,
        payload: {
          current: { cost: 1, calls: 1, sessions: 1, inputTokens: 100, outputTokens: 50 },
          history: {
            daily: [
              { date: '2026-04-09', cacheWriteTokens: 100, cacheReadTokens: 1000 },
              { date: '2026-04-10', cacheWriteTokens: 5, cacheReadTokens: 10 },
              { date: '2026-04-11', cacheWriteTokens: 7, cacheReadTokens: 3 },
            ],
          },
        },
      },
      {
        id: 'remote-1',
        name: 'MacBook',
        local: false,
        payload: {
          current: { cost: 2, calls: 2, sessions: 1, inputTokens: 20, outputTokens: 30 },
          history: {
            daily: [
              { date: '2026-04-08', cacheWriteTokens: 11, cacheReadTokens: 13 },
              { date: '2026-04-10', cacheWriteTokens: 2, cacheReadTokens: 8 },
            ],
          },
        },
      },
    ]

    const all = summarizeDeviceUsage(results)
    expect(all.perDevice[0]).toMatchObject({
      cacheCreateTokens: 112,
      cacheReadTokens: 1013,
      totalTokens: 1275,
    })
    expect(all.perDevice[1]).toMatchObject({
      cacheCreateTokens: 13,
      cacheReadTokens: 21,
      totalTokens: 84,
    })
    expect(all.combined).toMatchObject({
      inputTokens: 120,
      outputTokens: 80,
      cacheCreateTokens: 125,
      cacheReadTokens: 1034,
      totalTokens: 1359,
    })

    const scoped = summarizeDeviceUsage(results, { start: '2026-04-10', end: '2026-04-10' })
    expect(scoped.perDevice[0]).toMatchObject({
      cacheCreateTokens: 5,
      cacheReadTokens: 10,
      totalTokens: 165,
    })
    expect(scoped.perDevice[1]).toMatchObject({
      cacheCreateTokens: 2,
      cacheReadTokens: 8,
      totalTokens: 60,
    })
    expect(scoped.combined).toMatchObject({
      cost: 3,
      calls: 3,
      sessions: 2,
      inputTokens: 120,
      outputTokens: 80,
      cacheCreateTokens: 7,
      cacheReadTokens: 18,
      totalTokens: 225,
      deviceCount: 2,
      reachableCount: 2,
    })
  })

  it('prefers period-scoped current cache tokens over the 365-day daily history (#583)', () => {
    const results: DeviceUsage[] = [
      {
        id: 'local',
        name: 'Mac',
        local: true,
        payload: {
          current: { cost: 1, calls: 1, sessions: 1, inputTokens: 100, outputTokens: 50, cacheReadTokens: 42, cacheWriteTokens: 7 },
          history: {
            daily: [
              // A full 365-day backfill whose cache dwarfs the selected period.
              { date: '2025-08-01', cacheWriteTokens: 900, cacheReadTokens: 5000 },
              { date: '2026-04-10', cacheWriteTokens: 3, cacheReadTokens: 8 },
            ],
          },
        },
      },
    ]

    const summary = summarizeDeviceUsage(results)
    // Reads current (7 / 42), not the inflated daily-history sum (903 / 5008).
    expect(summary.perDevice[0]).toMatchObject({ cacheCreateTokens: 7, cacheReadTokens: 42 })
    expect(summary.combined).toMatchObject({ cacheCreateTokens: 7, cacheReadTokens: 42 })
  })
})

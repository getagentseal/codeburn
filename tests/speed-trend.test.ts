import { describe, it, expect } from 'vitest'
import { buildSpeedReport, renderSpeedReport, speedTrendIntervals } from '../src/speed/report.js'
import type { SpeedSample } from '../src/speed/types.js'

let next = 0
/** Request timing with exactly one second after the first arrival, so the generation rate equals `rate`. */
function request(startedAt: Date, rate: number, firstMs = 1000, overrides: Partial<SpeedSample> = {}): SpeedSample {
  return { version: 1, id: `r${next++}`, harness: 'zcode', model: 'glm', source: 'zcode-db', resolution: 'request',
    startedAt: startedAt.toISOString(), durationMs: firstMs + 1000, firstEmissionMs: firstMs, outputTokens: rate + 1,
    status: 'complete', events: [], ...overrides }
}
const at = (month: number, day: number, hour = 12, minute = 0) => new Date(2026, month - 1, day, hour, minute)
const repeat = (count: number, make: () => SpeedSample) => Array.from({ length: count }, make)

describe('speed trend intervals', () => {
  it('sizes intervals by the observed span and aligns them to local hours, days and Monday weeks', () => {
    const hourly = speedTrendIntervals([request(at(10, 1, 9, 30), 10), request(at(10, 1, 12, 10), 10)])
    expect(hourly.bucket).toBe('hour')
    expect(hourly.starts).toEqual([9, 10, 11, 12].map(h => at(10, 1, h).getTime()))

    const daily = speedTrendIntervals([request(at(9, 1, 23), 10), request(at(9, 30, 1), 10)])
    expect(daily.bucket).toBe('day')
    expect(daily.starts).toHaveLength(30)
    expect(daily.starts[0]).toBe(new Date(2026, 8, 1).getTime())
    expect(daily.starts.at(-1)).toBe(new Date(2026, 8, 30).getTime())

    const weekly = speedTrendIntervals([request(new Date(2026, 0, 1, 8), 10), request(at(10, 1), 10)])
    expect(weekly.bucket).toBe('week')
    expect(weekly.starts[0]).toBe(new Date(2025, 11, 29).getTime())
    expect(weekly.starts.every(start => new Date(start).getDay() === 1 && new Date(start).getHours() === 0)).toBe(true)

    expect(speedTrendIntervals([])).toEqual({ bucket: 'day', starts: [] })
  })
})

describe('speed trend and typical day', () => {
  it('charts per-interval medians aligned to the report, with gaps and separate sources', () => {
    const samples = [
      request(at(9, 28, 9), 10, 100), request(at(9, 28, 10), 20, 200), request(at(9, 28, 11), 30, 300),
      request(at(9, 29), 99, 100, { status: 'error' }),
      request(at(9, 30), 40, 400),
      request(at(9, 30), 70, 100, { source: 'proxy', resolution: 'chunk', lastEmissionMs: 1100, events: [{ elapsedMs: 100 }, { elapsedMs: 1100 }] }),
    ]
    const report = buildSpeedReport(samples)
    expect(report.trend).toEqual({ bucket: 'day', starts: [28, 29, 30].map(d => at(9, d, 0).toISOString()) })
    const history = report.rows.find(r => r.source === 'zcode-db')!
    expect(history.trend).toEqual([
      { generationTokensPerSecondP50: 20, generationRequests: 3, firstEmissionMsP50: 200, firstEmissionRequests: 3 },
      null,
      { generationTokensPerSecondP50: 40, generationRequests: 1, firstEmissionMsP50: 400, firstEmissionRequests: 1 },
    ])
    expect(report.rows.find(r => r.source === 'proxy')!.trend).toEqual([null, null,
      { generationTokensPerSecondP50: 70, generationRequests: 1, firstEmissionMsP50: 100, firstEmissionRequests: 1 }])
    expect(history.typical).toBeNull()
  })

  it('compares the window with its median day before it and flags a 25% move', () => {
    const before = [
      ...[24, 25, 26].flatMap(day => repeat(5, () => request(at(9, day), 100, 1000))),
      // One unusually fast day cannot drag the typical day with it.
      ...repeat(5, () => request(at(9, 27), 200, 1000)),
      // A day with fewer than five requests is too thin to count.
      ...repeat(4, () => request(at(9, 28), 500, 9000)),
    ]
    const now = repeat(5, () => request(at(10, 1), 70, 1200))
    const report = buildSpeedReport(now, before)
    expect(report.rows[0]!.typical).toEqual({
      days: 4, generationTokensPerSecondP50: 100, firstEmissionMsP50: 1000,
      generationChangePct: expect.closeTo(-30, 6), firstEmissionChangePct: expect.closeTo(20, 6),
      generationShift: true, firstEmissionShift: false,
    })
    expect(renderSpeedReport({ ...report, typicalDays: 7 })).toContain('Typical day, 7 days before: ZCode / glm (zcode-db) generation 100.0 tok/s (now -30%, SHIFT), first 1000.0 ms (now +20%)')
  })

  it('keeps the typical value but calls no change from a thin window, and needs three typical days', () => {
    const before = [24, 25, 26].flatMap(day => repeat(5, () => request(at(9, day), 100)))
    const thin = buildSpeedReport(repeat(4, () => request(at(10, 1), 10)), before).rows[0]!.typical!
    expect(thin).toMatchObject({ generationTokensPerSecondP50: 100, generationChangePct: null, generationShift: false })
    expect(buildSpeedReport([request(at(10, 1), 10)], before.slice(0, 10)).rows[0]!.typical).toBeNull()
    // Other models and sources never lend their history to a row.
    expect(buildSpeedReport([request(at(10, 1), 10, 1000, { model: 'other' })], before).rows[0]!.typical).toBeNull()
  })
})

describe('buffered delivery', () => {
  it('needs a second of streaming after the first arrival before estimating from request or chunk timestamps', () => {
    const burst = (ms: number) => request(at(10, 1), 0, 7000, { outputTokens: 1250, durationMs: 7000 + ms })
    // 1,249 tokens 170 ms after the first chunk would read as ~7,300 tok/s.
    const mostlyBursts = [...repeat(4, () => burst(170)), burst(2000), burst(3000)]
    const row = buildSpeedReport(mostlyBursts).rows[0]!
    expect(row).toMatchObject({ bufferedDelivery: true, generationTokensPerSecondP50: null, generationRequests: 0, firstEmissionMsP50: 7000 })
    expect(row.trend.every(p => p === null || p.generationTokensPerSecondP50 === null)).toBe(true)
    expect(renderSpeedReport(buildSpeedReport(mostlyBursts))).toContain('Buffered delivery, generation unavailable: ZCode / glm')

    // A few short replies among steady streams are only left out, never averaged in.
    const mostlySteady = [burst(170), burst(2000), burst(2000), burst(2500), burst(2500)]
    expect(buildSpeedReport(mostlySteady).rows[0]).toMatchObject({ bufferedDelivery: false, generationRequests: 4,
      generationTokensPerSecondP50: expect.closeTo((1249 / 2 + 1249 / 2.5) / 2, 6) })

    // A provider that has just started buffering gets no typical rate beside its "—".
    const steadyBefore = [24, 25, 26].flatMap(day => repeat(5, () => request(at(9, day), 50, 1000, { durationMs: 3000 })))
    expect(buildSpeedReport(repeat(6, () => burst(100)), steadyBefore).rows[0]!.typical).toMatchObject({
      generationTokensPerSecondP50: null, generationChangePct: null, generationShift: false, firstEmissionMsP50: 1000 })

    // Native per-token timestamps are exact, however short the window.
    const tokens = Array.from({ length: 50 }, (_, i) => ({ elapsedMs: 100 + i * 2, tokens: 1 as const }))
    const native = request(at(10, 1), 0, 100, { source: 'native', resolution: 'token', harness: 'hermes', outputTokens: 50,
      durationMs: 300, lastEmissionMs: 198, events: tokens })
    expect(buildSpeedReport([native]).rows[0]).toMatchObject({ generationRequests: 1, generationTokensPerSecondP50: expect.closeTo(49 / 0.098, 6) })
  })
})

import { describe, it, expect } from 'vitest'

import fallback from '../src/data/pricing-fallback.json' assert { type: 'json' }

// The gap-fill fallback is generated from models.dev / OpenRouter. These assert
// the bundler's hygiene guarantees on the committed artifact, so a future
// rebundle that regresses them fails CI rather than shipping bad pricing.
describe('pricing-fallback.json data hygiene', () => {
  const entries = Object.entries(fallback as Record<string, (number | null)[]>)

  it('is non-empty', () => {
    expect(entries.length).toBeGreaterThan(50)
  })

  it('has no negative rates (OpenRouter -1 "variable price" sentinels)', () => {
    const bad = entries.filter(([, v]) => (v[0] ?? 0) < 0 || (v[1] ?? 0) < 0 || (v[2] ?? 0) < 0 || (v[3] ?? 0) < 0)
    expect(bad.map(([k]) => k)).toEqual([])
  })

  it('has no entry that is free on both input and output', () => {
    const bad = entries.filter(([, v]) => v[0] === 0 && v[1] === 0)
    expect(bad.map(([k]) => k)).toEqual([])
  })

  it('has no unreachable @pin or date-suffixed keys', () => {
    const bad = entries.filter(([k]) => /@/.test(k) || /\d{8}$/.test(k))
    expect(bad.map(([k]) => k)).toEqual([])
  })

  it('stores per-token rates (no per-million values leaked through)', () => {
    // A per-million value would be >= 1; real per-token rates are tiny.
    const bad = entries.filter(([, v]) => (v[0] ?? 0) >= 1 || (v[1] ?? 0) >= 1)
    expect(bad.map(([k]) => k)).toEqual([])
  })
})

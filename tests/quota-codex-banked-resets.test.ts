import { describe, expect, it } from 'vitest'

import { compactAge, decodeCodexUsage, decodeResetCredits, resetCreditsLine } from '../src/quota/codex.js'
import { renderQuotaTable, toCommandProvider } from '../src/quota/index.js'

// 2027-01-15T08:00:00Z, the same instant the Swift suite pins, so the two sets
// of expected strings can be compared by eye.
const NOW = 1_800_000_000_000

function usageBody(block: unknown) {
  return {
    plan_type: 'plus',
    rate_limit: {
      primary_window: { used_percent: 12, limit_window_seconds: 18_000 },
    },
    rate_limit_reset_credits: block,
  }
}

describe('Codex limit-reset credits', () => {
  it('names the count and the most recent grant, in the menubar wording', () => {
    const quota = decodeCodexUsage(usageBody({
      available_count: 2,
      credits: [
        { id: 'c1', reset_type: 'weekly', status: 'available', granted_at: '2027-01-15T06:00:00Z' },
        { id: 'c2', reset_type: 'weekly', status: 'available', granted_at: '2027-01-15T07:50:00Z' },
      ],
    }), NOW)
    expect(quota.notes).toEqual(['Limit resets · 2 available · latest weekly reset granted 10m ago'])
    expect(quota.footerLines).toContain('Limit resets · 2 available · latest weekly reset granted 10m ago')
  })

  it('states the usable count only when it disagrees with the headline', () => {
    const same = decodeCodexUsage(usageBody({ available_count: 1, applicable_available_count: 1 }), NOW)
    expect(same.notes).toEqual(['Limit resets · 1 available'])

    const differs = decodeCodexUsage(usageBody({ available_count: 2, applicable_available_count: 1 }), NOW)
    expect(differs.notes).toEqual(['Limit resets · 2 available · 1 usable now'])
  })

  it('keeps the expiry clause when the payload carries per-credit expiries', () => {
    const line = resetCreditsLine(decodeResetCredits({
      available_count: 1,
      credits: [{
        id: 'c1', reset_type: 'weekly', status: 'available',
        granted_at: '2027-01-14T08:00:00Z', expires_at: '2027-01-16T00:00:00Z',
      }],
    }, NOW), NOW)
    expect(line).toBe('Limit resets · 1 available · latest weekly reset granted 1d ago · next expires in 16h')
  })

  it('the expiry reported is the soonest one, not the last', () => {
    const credits = decodeResetCredits({
      available_count: 2,
      credits: [
        { id: 'c1', status: 'available', expires_at: '2027-01-20T08:00:00Z' },
        { id: 'c2', status: 'available', expires_at: '2027-01-16T00:00:00Z' },
      ],
    }, NOW)
    expect(credits?.nextExpiresAt).toBe(Date.parse('2027-01-16T00:00:00Z'))
    expect(resetCreditsLine(credits, NOW)).toBe('Limit resets · 2 available · next expires in 16h')
  })

  it('only available credits count toward the grant and the expiry', () => {
    const credits = decodeResetCredits({
      available_count: 1,
      credits: [
        { id: 'c1', reset_type: 'weekly', status: 'available', granted_at: '2027-01-14T08:00:00Z' },
        {
          id: 'c2', reset_type: 'weekly', status: 'redeemed',
          granted_at: '2027-01-15T07:00:00Z', expires_at: '2027-01-15T09:00:00Z',
        },
      ],
    }, NOW)
    expect(credits?.grants.map(grant => grant.id)).toEqual(['c1'])
    expect(credits?.nextExpiresAt).toBeNull()
  })

  it('an absent applicable count is unknown, never zero', () => {
    expect(decodeResetCredits({ available_count: 0 }, NOW)?.applicableAvailableCount).toBeNull()
    expect(decodeResetCredits({ available_count: 0, applicable_available_count: 0 }, NOW)
      ?.applicableAvailableCount).toBe(0)
  })

  it('falls back to granted_at as the identity, and drops a credit with neither', () => {
    const credits = decodeResetCredits({
      available_count: 2,
      credits: [
        { status: 'available', granted_at: '2027-01-14T08:00:00Z' },
        { status: 'available' },
      ],
    }, NOW)
    expect(credits?.grants.map(grant => grant.id)).toEqual(['2027-01-14T08:00:00Z'])
    // Still counted — the server said two are available — but only one can ever
    // be told apart from the next grant.
    expect(credits?.availableCount).toBe(2)
  })

  it('holds nothing, says nothing', () => {
    const quota = decodeCodexUsage(usageBody({ available_count: 0, applicable_available_count: 0 }), NOW)
    expect(quota.notes).toBeUndefined()
    expect(quota.footerLines).toEqual([])
  })

  it('a malformed or missing block hides the line without failing the read', () => {
    for (const block of [undefined, null, 'nonsense', {}, { available_count: -1 }, { available_count: 'two' }]) {
      const quota = decodeCodexUsage(usageBody(block), NOW)
      expect(quota.connection).toBe('connected')
      expect(quota.primary?.percent).toBe(0.12)
      expect(quota.notes).toBeUndefined()
    }
  })

  it('a grant timestamped in the future reads as landing, not as granted', () => {
    const line = resetCreditsLine(decodeResetCredits({
      available_count: 1,
      credits: [{ id: 'c1', reset_type: 'weekly', status: 'available', granted_at: '2027-01-15T10:00:00Z' }],
    }, NOW), NOW)
    expect(line).toBe('Limit resets · 1 available · next weekly reset lands in 2h')
  })

  it('an absent reset_type degrades to the bare noun', () => {
    const line = resetCreditsLine(decodeResetCredits({
      available_count: 1,
      credits: [{ id: 'c1', status: 'available', granted_at: '2027-01-15T07:00:00Z' }],
    }, NOW), NOW)
    expect(line).toBe('Limit resets · 1 available · latest limit reset granted 1h ago')
  })

  it('compact ages read the same as the Swift port', () => {
    expect(compactAge(NOW, NOW)).toBe('just now')
    expect(compactAge(NOW - 59_000, NOW)).toBe('just now')
    expect(compactAge(NOW - 60_000, NOW)).toBe('1m ago')
    expect(compactAge(NOW - 7_200_000, NOW)).toBe('2h ago')
    // Elapsed time is floored, never rounded up: 2h50m is still "2h ago".
    expect(compactAge(NOW - 10_200_000, NOW)).toBe('2h ago')
    expect(compactAge(NOW - 3 * 86_400_000, NOW)).toBe('3d ago')
    expect(compactAge(NOW - 3.9 * 86_400_000, NOW)).toBe('3d ago')
    expect(compactAge(NOW + 30_000, NOW)).toBe('in under a minute')
    expect(compactAge(NOW + 7_200_000, NOW)).toBe('in 2h')
    expect(compactAge(NOW + 2 * 86_400_000, NOW)).toBe('in 2d')
  })

  it('`codeburn quota` prints the line under the provider windows', () => {
    const quota = decodeCodexUsage(usageBody({ available_count: 2, applicable_available_count: 1 }), NOW)
    const provider = toCommandProvider('codex', 'Codex', quota)
    expect(provider.notes).toEqual(['Limit resets · 2 available · 1 usable now'])
    const table = renderQuotaTable({ providers: [provider] })
    expect(table).toContain('Limit resets · 2 available · 1 usable now')
  })

  it('a provider that reports no notes is rendered exactly as before', () => {
    const quota = decodeCodexUsage(usageBody(undefined), NOW)
    expect(toCommandProvider('codex', 'Codex', quota).notes).toBeUndefined()
  })
})

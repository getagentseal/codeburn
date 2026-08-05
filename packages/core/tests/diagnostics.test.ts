import { describe, expect, it } from 'vitest'

import {
  DiagnosticDetail,
  RecordDiagnostic,
  isolateRecords,
  keyedDetail,
  sanitizeDetail,
} from '../src/diagnostics.js'
import type { SessionObservation } from '../src/observations.js'

const fakeSession = (ref: string): SessionObservation => ({
  sessionRef: ref,
  projectRef: '0000000000000000',
  providerId: 'claude',
  startedAt: '2026-07-17T10:00:00.000Z',
  calls: [],
  turnCount: 0,
})

describe('DiagnosticDetail validator', () => {
  it('accepts a 16-hex fingerprint (the only legal detail)', () => {
    expect(DiagnosticDetail.safeParse('0123456789abcdef').success).toBe(true)
  })

  it('rejects free text — even slash-free content like a prompt line', () => {
    expect(DiagnosticDetail.safeParse('unexpected token at position 4').success).toBe(false)
    expect(DiagnosticDetail.safeParse('reset the production database').success).toBe(false)
  })

  it('rejects an API key (identifier-charset content, no slashes)', () => {
    expect(DiagnosticDetail.safeParse('sk-live-abc123DEF456').success).toBe(false)
  })

  it('rejects path-bearing strings', () => {
    expect(DiagnosticDetail.safeParse('/home/u/secret.json').success).toBe(false)
    expect(DiagnosticDetail.safeParse('C:\\Users\\me\\x').success).toBe(false)
  })

  it('rejects anything that is not exactly 16 lowercase hex chars', () => {
    expect(DiagnosticDetail.safeParse('0123456789abcdef0').success).toBe(false) // 17 chars
    expect(DiagnosticDetail.safeParse('0123456789ABCDEF').success).toBe(false) // uppercase
    expect(DiagnosticDetail.safeParse('0123456789abcde').success).toBe(false) // 15 chars
  })

  it('RecordDiagnostic is strict (rejects unknown fields)', () => {
    expect(
      RecordDiagnostic.safeParse({ code: 'other', detail: '0123456789abcdef', extra: 'nope' }).success,
    ).toBe(false)
  })

  it('RecordDiagnostic accepts the contract fields: index, code, detail', () => {
    expect(
      RecordDiagnostic.safeParse({
        index: 3,
        code: 'malformed-json',
        detail: '0123456789abcdef',
      }).success,
    ).toBe(true)
  })
})

describe('sanitizeDetail', () => {
  it('never echoes content: an absolute path becomes a 16-hex fingerprint', () => {
    const out = sanitizeDetail(new Error('cannot read /etc/passwd or C:\\secret'), 'host-key')
    expect(out).toMatch(/^[0-9a-f]{16}$/)
    expect(out).not.toContain('etc')
    expect(DiagnosticDetail.safeParse(out).success).toBe(true)
  })

  it('never echoes slash-free content: a prompt line and an API key cannot survive', () => {
    const prompt = 'reset the production database and email me the dump'
    const apiKey = '«redacted:sk-…»'
    for (const input of [prompt, apiKey]) {
      const out = sanitizeDetail(input, 'host-key')
      expect(out).toMatch(/^[0-9a-f]{16}$/)
      expect(out).not.toContain('reset')
      expect(out).not.toContain('sk-')
      expect(DiagnosticDetail.safeParse(out).success).toBe(true)
    }
  })

  it('is deterministic: identical inputs produce identical fingerprints, distinct inputs differ', () => {
    expect(sanitizeDetail('boom', 'k')).toBe(sanitizeDetail('boom', 'k'))
    expect(sanitizeDetail('boom', 'k')).not.toBe(sanitizeDetail('boom!', 'k'))
  })

  it('is keyed when a privacy key is supplied (D1)', () => {
    const a = sanitizeDetail('boom', 'key-1')
    const b = sanitizeDetail('boom', 'key-2')
    expect(a).toMatch(/^[0-9a-f]{16}$/)
    expect(b).toMatch(/^[0-9a-f]{16}$/)
    expect(a).not.toBe(b)
  })

  it('always yields exactly 16 hex chars regardless of input size', () => {
    expect(sanitizeDetail('y'.repeat(100_000), 'k')).toMatch(/^[0-9a-f]{16}$/)
    expect(sanitizeDetail(42, 'k')).toMatch(/^[0-9a-f]{16}$/)
  })

  it('D1 regression: refuses to run without a key — no silent unkeyed digest', () => {
    // A keyless call must fail loudly, never degrade to an unkeyed SHA-256 of
    // a JSON.parse error message that can embed user content. The unkeyed
    // call goes through a loose cast: the compile-time contract already
    // requires the key, and this asserts the runtime guard holds too.
    const unkeyed = sanitizeDetail as (value: unknown) => string
    expect(() => unkeyed('boom')).toThrow(/privacyKey/)
    expect(() => sanitizeDetail('boom', '')).toThrow(/privacyKey/)
  })
})

describe('keyedDetail', () => {
  it('emits no detail at all when no key is available (D1)', () => {
    expect(keyedDetail('boom', undefined)).toBeUndefined()
    expect(keyedDetail('boom', '')).toBeUndefined()
  })

  it('emits the keyed fingerprint when a key is available', () => {
    expect(keyedDetail('boom', 'host-key')).toBe(sanitizeDetail('boom', 'host-key'))
    expect(keyedDetail('boom', 'host-key')).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('isolateRecords poison isolation', () => {
  it('a throwing record becomes a diagnostic with a content-free fingerprint and never drops its siblings', () => {
    const records = ['good-1', 'POISON', 'good-2']
    const { observations, diagnostics } = isolateRecords(records, (record, index) => {
      if (record === 'POISON') throw new Error('kaboom at /secret/path')
      return { observations: [fakeSession(`ref-${index}`)] }
    }, 'host-key')

    expect(observations.map((o) => o.sessionRef)).toEqual(['ref-0', 'ref-2'])
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0].index).toBe(1)
    expect(diagnostics[0].code).toBe('other')
    // The thrown message's path must never survive — only its fingerprint.
    expect(diagnostics[0].detail).toMatch(/^[0-9a-f]{16}$/)
    expect(diagnostics[0].detail).not.toContain('secret')
    expect(RecordDiagnostic.safeParse(diagnostics[0]).success).toBe(true)
  })

  it('D1 regression: keyless isolation emits no detail — never an unkeyed digest', () => {
    const { diagnostics } = isolateRecords(['POISON'], () => {
      throw new Error('boom at /x/y')
    })
    expect(diagnostics[0]!.detail).toBeUndefined()
    expect(diagnostics[0]).toEqual({ index: 0, code: 'other' })
  })

  it('fingerprints the thrown error with the supplied privacy key', () => {
    const { diagnostics } = isolateRecords(['POISON'], () => {
      throw new Error('boom at /x/y')
    }, 'host-key')
    expect(diagnostics[0]!.detail).toBe(sanitizeDetail(new Error('boom at /x/y'), 'host-key'))
  })

  it('aggregates caller diagnostics but strips any detail — only thrown-error fingerprints survive', () => {
    const { observations, diagnostics } = isolateRecords([1, 2], (_r, index) => ({
      observations: [fakeSession(`s-${index}`)],
      // The type-level contract forbids a caller diagnostic from carrying
      // `detail`; the loose cast simulates an untyped caller smuggling one in.
      // The runtime must strip it rather than trust it — without the privacy
      // key this fingerprint is unkeyed, and with a key isolateRecords cannot
      // verify a caller-derived digest was actually keyed with it.
      diagnostics: [
        { index, code: 'invalid-value' as const, detail: '0123456789abcdef' },
      ] as unknown as Array<Omit<RecordDiagnostic, 'detail'>>,
    }))
    expect(observations).toHaveLength(2)
    expect(diagnostics).toHaveLength(2)
    expect(diagnostics).toEqual([
      { index: 0, code: 'invalid-value' },
      { index: 1, code: 'invalid-value' },
    ])
    for (const d of diagnostics) {
      expect(d.detail).toBeUndefined()
    }
  })

  it('never throws even when every record is poison', () => {
    const { observations, diagnostics } = isolateRecords(['a', 'b'], () => {
      throw new Error('always bad')
    })
    expect(observations).toEqual([])
    expect(diagnostics).toHaveLength(2)
  })
})

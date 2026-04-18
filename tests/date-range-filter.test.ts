import { describe, it, expect } from 'vitest'
import { parseDateRangeFlags } from '../src/cli-date.js'

describe('parseDateRangeFlags', () => {
  it('returns null when neither flag is provided', () => {
    expect(parseDateRangeFlags(undefined, undefined)).toBeNull()
  })

  it('parses a symmetric range in local time', () => {
    const range = parseDateRangeFlags('2026-04-07', '2026-04-10')
    expect(range).not.toBeNull()
    expect(range!.start.getFullYear()).toBe(2026)
    expect(range!.start.getMonth()).toBe(3)
    expect(range!.start.getDate()).toBe(7)
    expect(range!.start.getHours()).toBe(0)
    expect(range!.end.getDate()).toBe(10)
    expect(range!.end.getHours()).toBe(23)
    expect(range!.end.getMinutes()).toBe(59)
    expect(range!.end.getSeconds()).toBe(59)
  })

  it('accepts --from alone (open-ended to today 23:59:59)', () => {
    const range = parseDateRangeFlags('2026-04-01', undefined)
    expect(range).not.toBeNull()
    expect(range!.start.getDate()).toBe(1)
    expect(range!.end.getHours()).toBe(23)
  })

  it('accepts --to alone (start = epoch)', () => {
    const range = parseDateRangeFlags(undefined, '2026-04-10')
    expect(range).not.toBeNull()
    expect(range!.start.getTime()).toBe(new Date(0).getTime())
    expect(range!.end.getDate()).toBe(10)
  })

  it('throws when --from > --to', () => {
    expect(() => parseDateRangeFlags('2026-04-10', '2026-04-07'))
      .toThrow('--from must not be after --to')
  })

  it('throws on a non-ISO string', () => {
    expect(() => parseDateRangeFlags('April 7', undefined))
      .toThrow('Invalid date format')
  })

  it('throws on wrong digit count', () => {
    expect(() => parseDateRangeFlags('26-4-7', undefined))
      .toThrow('Invalid date format')
  })

  it('same day is valid (start midnight, end 23:59:59)', () => {
    const range = parseDateRangeFlags('2026-04-10', '2026-04-10')
    expect(range).not.toBeNull()
    expect(range!.start.getDate()).toBe(10)
    expect(range!.end.getDate()).toBe(10)
  })
})

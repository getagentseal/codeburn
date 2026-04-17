import { describe, it, expect } from 'vitest'
import { extractTimestampFromLine } from '../src/parser.js'

describe('extractTimestampFromLine', () => {
  it('extracts valid ISO timestamp', () => {
    const line = '{"type":"assistant","timestamp":"2026-04-15T10:30:00Z","message":{}}'
    const result = extractTimestampFromLine(line)
    expect(result).toBeInstanceOf(Date)
    expect(result!.toISOString()).toBe('2026-04-15T10:30:00.000Z')
  })

  it('returns null when no timestamp field', () => {
    const line = '{"type":"user","message":"hello"}'
    expect(extractTimestampFromLine(line)).toBeNull()
  })

  it('returns null for malformed timestamp value', () => {
    const line = '{"type":"assistant","timestamp":"not-a-date"}'
    expect(extractTimestampFromLine(line)).toBeNull()
  })

  it('finds first timestamp when multiple exist', () => {
    const line = '{"timestamp":"2026-04-15T08:00:00Z","nested":{"timestamp":"2026-04-16T09:00:00Z"}}'
    const result = extractTimestampFromLine(line)
    expect(result!.toISOString()).toBe('2026-04-15T08:00:00.000Z')
  })

  it('handles timestamp with offset', () => {
    const line = '{"timestamp":"2026-04-15T10:00:00+05:00"}'
    const result = extractTimestampFromLine(line)
    expect(result).toBeInstanceOf(Date)
    expect(result!.toISOString()).toBe('2026-04-15T05:00:00.000Z')
  })

  it('returns null for empty line', () => {
    expect(extractTimestampFromLine('')).toBeNull()
  })
})

import { describe, it, expect } from 'vitest'
import { normalizeContentBlocks } from '../src/content-utils.js'

describe('normalizeContentBlocks', () => {
  it('passes an array of blocks through unchanged', () => {
    const blocks = [{ type: 'text', text: 'hi' }, { type: 'tool_use', text: '' }]
    expect(normalizeContentBlocks(blocks)).toBe(blocks)
  })

  it('wraps a string as a single text block (the issue #441 case)', () => {
    expect(normalizeContentBlocks('hello world')).toEqual([{ type: 'text', text: 'hello world' }])
  })

  it('returns an empty array for null / undefined', () => {
    expect(normalizeContentBlocks(null)).toEqual([])
    expect(normalizeContentBlocks(undefined)).toEqual([])
  })

  it('returns an empty array for other non-array values', () => {
    // Defensive against corrupt records: a number/object content must not throw downstream.
    expect(normalizeContentBlocks(42 as unknown as string)).toEqual([])
    expect(normalizeContentBlocks({ type: 'text' } as unknown as string)).toEqual([])
  })

  it('drops null/undefined elements inside an array (avoids the same crash one level down)', () => {
    const dirty = [{ type: 'text', text: 'ok' }, null, undefined, { type: 'tool_use' }] as unknown as Array<{ type?: string }>
    const out = normalizeContentBlocks(dirty)
    expect(out).toEqual([{ type: 'text', text: 'ok' }, { type: 'tool_use' }])
    expect(() => out.filter(b => b.type === 'text')).not.toThrow()
  })

  it('returns the same reference for a clean array (no copy)', () => {
    const clean = [{ type: 'text', text: 'a' }, { type: 'tool_use' }]
    expect(normalizeContentBlocks(clean)).toBe(clean)
  })

  it('the result is always safe to .filter/.some over', () => {
    const inputs = ['a string', null, undefined, [{ type: 'text' }], [{ type: 'text' }, null]] as const
    for (const input of inputs) {
      expect(() => normalizeContentBlocks(input as never).filter(b => b.type === 'text')).not.toThrow()
    }
  })
})

describe('flattenJsonStrings', () => {
  it('retains the decoded graph itself with equal content (no copy)', async () => {
    const { flattenJsonStrings } = await import('../src/content-utils.js')
    const value = {
      path: '/live/sessions/x.jsonl',
      calls: [{ deduplicationKey: 'omp:1', nested: { list: ['a', 1, true, null] } }],
      empty: {},
    }
    const pristine = structuredClone(value)
    const out = flattenJsonStrings(value)
    expect(out).toBe(value)
    expect(out.calls).toBe(value.calls)
    expect(out).toEqual(pristine)
  })

  it('flattens keys as well as string leaves, preserving key order', async () => {
    const { flattenJsonStrings } = await import('../src/content-utils.js')
    const slicedKey = `x${'y'.repeat(64)}`.slice(1)
    const value = { a: 1, [slicedKey]: { v: 's' }, z: 2 }
    const out = flattenJsonStrings(value)
    expect(out).toBe(value)
    expect(Object.keys(out)).toEqual(['a', slicedKey.slice(0), 'z'])
    expect(out[slicedKey]).toEqual({ v: 's' })
  })

  it('preserves own __proto__ keys from valid JSON without changing the prototype', async () => {
    const { flattenJsonStrings } = await import('../src/content-utils.js')
    const value = JSON.parse('{"__proto__":{"x":"y"},"a":"b"}') as Record<string, unknown>
    const out = flattenJsonStrings(value)
    expect(out).toBe(value)
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect((out as Record<string, unknown>)['__proto__']).toEqual({ x: 'y' })
  })
})

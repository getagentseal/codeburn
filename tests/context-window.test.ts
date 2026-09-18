import { describe, expect, it } from 'vitest'

import { reportedContextWindow } from '../src/context-tree.js'

describe('reportedContextWindow', () => {
  it('treats the Claude 5 Fable and Mythos ids as 1M windows from the first turn', () => {
    expect(reportedContextWindow('claude-fable-5-1', 10_000)).toBe(1_000_000)
    expect(reportedContextWindow('claude-mythos-5-1', 10_000)).toBe(1_000_000)
  })

  it('keeps the existing 1M names and the 220k proof rule', () => {
    expect(reportedContextWindow('claude-opus-4-8', 10_000)).toBe(1_000_000)
    expect(reportedContextWindow('claude-sonnet-4-5[1m]', 10_000)).toBe(1_000_000)
    expect(reportedContextWindow('claude-sonnet-4-5', 10_000)).toBe(200_000)
    expect(reportedContextWindow('claude-sonnet-4-5', 220_001)).toBe(1_000_000)
  })
})

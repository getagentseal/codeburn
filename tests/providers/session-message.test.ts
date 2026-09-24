import { describe, it, expect } from 'vitest'

import { buildAssistantCall } from '../../src/providers/session-message.js'

const base = {
  providerName: 'opencode',
  dedupKey: 'opencode:s1:m1',
  sessionId: 's1',
  parts: [{ type: 'text', text: 'answer' }],
  timeCreatedMs: 1_776_000_000_000,
  userMessage: 'q',
}

describe('buildAssistantCall usage', () => {
  it('marks a call with output but no recorded usage as estimated, never a measured $0', () => {
    const call = buildAssistantCall({ ...base, data: { role: 'assistant', modelID: 'claude-sonnet-4-6' } })
    expect(call).not.toBeNull()
    expect(call!.costUSD).toBe(0)
    expect(call!.costIsEstimated).toBe(true)
  })

  it('leaves a call with recorded usage unflagged', () => {
    const call = buildAssistantCall({
      ...base,
      data: { role: 'assistant', modelID: 'claude-sonnet-4-6', tokens: { input: 10, output: 5 } },
    })
    expect(call!.costUSD).toBeGreaterThan(0)
    expect(call!.costIsEstimated).toBeUndefined()
  })
})

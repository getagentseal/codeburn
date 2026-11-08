import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/data/litellm-snapshot.json', () => ({
  default: {
    chat: [0, 0, null, null, null, null],
    'gpt-x': [1e-6, 2e-6, null, null, null, null],
  },
}))
vi.mock('../src/data/pricing-fallback.json', () => ({
  default: {
    'chat-bison': [1.25e-7, 1.25e-7, null, null, null],
    'gpt-x-0709': [0.5e-6, 1e-6, null, null, null],
  },
}))

const { getModelCosts } = await import('../src/models.js')

describe('a $0 prefix sibling never shadows an exact key', () => {
  it('a shorter $0 primary key does not shadow an exact fallback key', () => {
    expect(getModelCosts('chat-bison')!.inputCostPerToken).toBe(1.25e-7)
  })

  it('a priced prefix sibling still wins, and an id with no exact key resolves through its prefix', () => {
    expect(getModelCosts('gpt-x-0709')!.inputCostPerToken).toBe(1e-6)
    expect(getModelCosts('chat-unknown')!.inputCostPerToken).toBe(0)
    expect(getModelCosts('gpt-x-preview')!.inputCostPerToken).toBe(1e-6)
  })
})

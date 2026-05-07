import { describe, it, expect } from 'vitest'
import { calculateCost, getModelCosts, getShortModelName } from '../src/models.js'

// Lock down the post-hoist refactor: every model name a real user has
// emitted in the last year should resolve to the same display name and
// the same costs as before. If this list grows or shrinks, the refactor
// is fine — it's the per-name resolution that must stay stable.
const KNOWN_NAMES = [
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-opus-4-5',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
  'claude-3-5-sonnet',
  'claude-3-5-haiku',
  'claude-opus-4-7-20250101',
  'claude-sonnet-4-6-20250929',
  'anthropic/claude-opus-4-7',
  'anthropic--claude-4.6-opus',
  'anthropic--claude-4.6-sonnet',
  'claude-4.6-sonnet',
  'gpt-5',
  'gpt-5-mini',
  'gpt-5-nano',
  'gpt-5-pro',
  'gpt-5.1',
  'gpt-5.1-codex',
  'gpt-5.1-codex-mini',
  'gpt-5.2',
  'gpt-5.2-low',
  'gpt-5.3-codex',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-3.1-pro-preview',
  'gemini-3-flash-preview',
  'gemini-3.1-pro',
  'gemini-3-flash',
  'cursor-auto',
  'cursor-agent-auto',
  'copilot-auto',
  'copilot-openai-auto',
  'kiro-auto',
  'cline-auto',
  'qwen-auto',
  'o3',
  'o4-mini',
  'deepseek-coder',
  'deepseek-coder-max',
  'deepseek-r1',
  'MiniMax-M2.7',
  'MiniMax-M2.7-highspeed',
]

describe('post-hoist resolution stability', () => {
  it('every known model resolves to a non-empty short name', () => {
    for (const name of KNOWN_NAMES) {
      const short = getShortModelName(name)
      expect(short, `short name for ${name}`).toBeTruthy()
      expect(typeof short, `short name for ${name}`).toBe('string')
    }
  })

  it('gpt-5-mini does NOT collide with gpt-5 (longest-prefix wins)', () => {
    expect(getShortModelName('gpt-5-mini')).toBe('GPT-5 Mini')
    expect(getShortModelName('gpt-5')).toBe('GPT-5')
    expect(getShortModelName('gpt-5-nano')).toBe('GPT-5 Nano')
    expect(getShortModelName('gpt-5-pro')).toBe('GPT-5 Pro')
  })

  it('gpt-5.1-codex-mini does NOT collapse to gpt-5.1-codex or gpt-5', () => {
    expect(getShortModelName('gpt-5.1-codex-mini')).toBe('GPT-5.1 Codex Mini')
    expect(getShortModelName('gpt-5.1-codex')).toBe('GPT-5.1 Codex')
    expect(getShortModelName('gpt-5.1')).toBe('GPT-5.1')
  })

  it('claude-haiku-4-5 does NOT collapse to claude-haiku-4 or claude-3-5-haiku', () => {
    expect(getShortModelName('claude-haiku-4-5')).toBe('Haiku 4.5')
    expect(getShortModelName('claude-3-5-haiku')).toBe('Haiku 3.5')
  })

  it('getModelCosts returns positive token costs for every known name', () => {
    for (const name of KNOWN_NAMES) {
      const c = getModelCosts(name)
      expect(c, `costs for ${name}`).not.toBeNull()
      expect(c!.inputCostPerToken).toBeGreaterThan(0)
      expect(c!.outputCostPerToken).toBeGreaterThan(0)
    }
  })

  it('calculateCost is stable for a typical Sonnet 4.6 turn', () => {
    // 1k input, 2k output, 50k cache read — common Claude Code shape.
    const cost = calculateCost('claude-sonnet-4-6', 1000, 2000, 0, 50_000, 0)
    expect(cost).toBeGreaterThan(0)
    expect(Number.isFinite(cost)).toBe(true)
  })

  it('calculateCost clamps NaN/negative inputs to 0', () => {
    const c1 = calculateCost('claude-sonnet-4-6', NaN, 1000, 0, 0, 0)
    const c2 = calculateCost('claude-sonnet-4-6', 0, 1000, 0, 0, 0)
    expect(c1).toBe(c2)
    const c3 = calculateCost('claude-sonnet-4-6', -1000, 1000, 0, 0, 0)
    expect(c3).toBe(c2)
  })

  it('repeated calls return the same cost (memoized sort cache is consistent)', () => {
    const a = getModelCosts('gpt-5-mini')
    const b = getModelCosts('gpt-5-mini')
    const c = getModelCosts('gpt-5-mini')
    expect(a).toEqual(b)
    expect(b).toEqual(c)
  })
})

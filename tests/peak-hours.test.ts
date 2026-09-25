import { describe, expect, it } from 'vitest'

import {
  classifyPeak,
  isDeepSeekPeak,
  isZaiPeak,
  OFF_PEAK_MULTIPLIER,
  peakBillingKind,
  peakCostMultiplier,
} from '../src/peak-hours.js'

const at = (iso: string): Date => new Date(iso)

describe('isDeepSeekPeak', () => {
  it('is peak on a weekday inside 01:00-04:00 UTC', () => {
    // Monday 2026-09-28.
    expect(isDeepSeekPeak(at('2026-09-28T01:00:00Z'))).toBe(true)
    expect(isDeepSeekPeak(at('2026-09-28T02:30:00Z'))).toBe(true)
    expect(isDeepSeekPeak(at('2026-09-28T03:59:59Z'))).toBe(true)
  })

  it('is peak on a weekday inside 06:00-10:00 UTC', () => {
    expect(isDeepSeekPeak(at('2026-09-28T06:00:00Z'))).toBe(true)
    expect(isDeepSeekPeak(at('2026-09-28T09:59:59Z'))).toBe(true)
  })

  it('is off-peak in the gaps between windows', () => {
    expect(isDeepSeekPeak(at('2026-09-28T00:59:59Z'))).toBe(false)
    expect(isDeepSeekPeak(at('2026-09-28T04:00:00Z'))).toBe(false)
    expect(isDeepSeekPeak(at('2026-09-28T05:30:00Z'))).toBe(false)
    expect(isDeepSeekPeak(at('2026-09-28T10:00:00Z'))).toBe(false)
    expect(isDeepSeekPeak(at('2026-09-28T23:00:00Z'))).toBe(false)
  })

  it('is off-peak on weekends', () => {
    // Saturday 2026-09-26, Sunday 2026-09-27.
    expect(isDeepSeekPeak(at('2026-09-26T02:00:00Z'))).toBe(false)
    expect(isDeepSeekPeak(at('2026-09-27T08:00:00Z'))).toBe(false)
  })

  it('is off-peak on Chinese public holidays', () => {
    // Mid-Autumn 2026-09-25 is a Friday; National Day 2026-10-01 is a Thursday.
    expect(isDeepSeekPeak(at('2026-09-25T02:00:00Z'))).toBe(false)
    expect(isDeepSeekPeak(at('2026-10-01T08:00:00Z'))).toBe(false)
  })
})

describe('isZaiPeak', () => {
  it('is peak Mon-Fri 14:00-18:00 SGT (06:00-10:00 UTC)', () => {
    expect(isZaiPeak(at('2026-09-28T06:00:00Z'))).toBe(true)
    expect(isZaiPeak(at('2026-09-28T09:59:59Z'))).toBe(true)
  })

  it('is off-peak outside the SGT window', () => {
    expect(isZaiPeak(at('2026-09-28T05:59:59Z'))).toBe(false)
    expect(isZaiPeak(at('2026-09-28T10:00:00Z'))).toBe(false)
    expect(isZaiPeak(at('2026-09-28T02:00:00Z'))).toBe(false)
  })

  it('is off-peak on weekends (no holiday exception)', () => {
    expect(isZaiPeak(at('2026-09-26T08:00:00Z'))).toBe(false)
  })
})

describe('peakBillingKind', () => {
  it('maps DeepSeek models to USD peak billing', () => {
    expect(peakBillingKind('deepseek-chat')).toBe('deepseek-usd')
    expect(peakBillingKind('deepseek/deepseek-chat')).toBe('deepseek-usd')
    expect(peakBillingKind('deepseek-reasoner')).toBe('deepseek-usd')
    expect(peakBillingKind('deepseek-v4-pro')).toBe('deepseek-usd')
    expect(peakBillingKind('deepseek-flash')).toBe('deepseek-usd')
  })

  it('maps GLM / Z.ai spellings to credit peak billing', () => {
    expect(peakBillingKind('glm-5.3')).toBe('zai-credits')
    expect(peakBillingKind('GLM-5.2')).toBe('zai-credits')
    expect(peakBillingKind('z-ai/glm-5.2')).toBe('zai-credits')
    expect(peakBillingKind('cliproxy/zcode/glm-5.3-flash')).toBe('zai-credits')
  })

  it('returns null for unrelated models and junk', () => {
    expect(peakBillingKind('claude-sonnet-4-6')).toBe(null)
    expect(peakBillingKind('gpt-5.5')).toBe(null)
    expect(peakBillingKind('')).toBe(null)
  })
})

describe('classifyPeak', () => {
  it('classifies a DeepSeek call by its timestamp', () => {
    expect(classifyPeak('deepseek-chat', '2026-09-28T02:00:00Z')).toBe('peak')
    expect(classifyPeak('deepseek-chat', '2026-09-28T12:00:00Z')).toBe('off-peak')
  })

  it('classifies a GLM call by the Z.ai window', () => {
    expect(classifyPeak('glm-5.3', '2026-09-28T08:00:00Z')).toBe('peak')
    expect(classifyPeak('glm-5.3', '2026-09-28T12:00:00Z')).toBe('off-peak')
  })

  it('returns unknown without a model match or timestamp', () => {
    expect(classifyPeak('gpt-5.5', '2026-09-28T02:00:00Z')).toBe('unknown')
    expect(classifyPeak('deepseek-chat', undefined)).toBe('unknown')
    expect(classifyPeak('deepseek-chat', 'not-a-date')).toBe('unknown')
  })
})

describe('peakCostMultiplier', () => {
  it('halves DeepSeek cost off-peak and keeps peak at list', () => {
    expect(peakCostMultiplier('deepseek-chat', '2026-09-28T12:00:00Z')).toBe(OFF_PEAK_MULTIPLIER)
    expect(peakCostMultiplier('deepseek-chat', '2026-09-28T02:00:00Z')).toBe(1)
    expect(peakCostMultiplier('deepseek-chat', undefined)).toBe(1)
  })

  it('never reprices GLM in dollars', () => {
    expect(peakCostMultiplier('glm-5.3', '2026-09-28T12:00:00Z')).toBe(1)
    expect(peakCostMultiplier('glm-5.3', '2026-09-28T08:00:00Z')).toBe(1)
  })
})

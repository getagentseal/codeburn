import { describe, expect, it } from 'vitest'

import { SERIES_LABELS, seriesClassForModel, seriesColorForModel, seriesKeyForModel } from './modelSeries'

describe('model series', () => {
  it('uses provider-neutral capability labels', () => {
    expect(SERIES_LABELS).toEqual({
      flagship: 'Flagship',
      premium: 'Premium',
      balanced: 'Balanced',
      fast: 'Fast',
      other: 'Other',
    })
  })

  it.each([
    ['Claude Opus 4.8', 'flagship'],
    ['claude-fable-1', 'premium'],
    ['claude-sonnet-4.6', 'balanced'],
    ['claude-haiku-4.5', 'fast'],
    ['GPT-5.6 Sol', 'flagship'],
    ['gpt-5.6-terra', 'balanced'],
    ['gpt-5.6-luna', 'fast'],
    ['gpt-5.5-codex', 'balanced'],
    ['codex-auto-review', 'balanced'],
    ['gemini-3.1-pro-preview', 'balanced'],
    ['Gemini 3.5 Flash', 'fast'],
    ['gemini-3.1-flash-lite-preview', 'fast'],
    ['mystery-model', 'other'],
    [undefined, 'other'],
  ] as const)('classifies %s as %s', (model, series) => {
    expect(seriesKeyForModel(model)).toBe(series)
  })

  it('assigns every tier an existing neutral color and class', () => {
    expect(seriesColorForModel('gpt-5.6-sol')).toBe('var(--s-flagship)')
    expect(seriesClassForModel('claude-fable-1')).toBe('s-premium')
    expect(seriesColorForModel('gemini-3.1-pro')).toBe('var(--s-balanced)')
    expect(seriesClassForModel('gemini-3.5-flash')).toBe('s-fast')
  })
})

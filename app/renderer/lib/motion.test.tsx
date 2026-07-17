// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import gsap from 'gsap'

import { motionClass, motionEnabled, reducedMotion } from './motion'
import { StackedBars } from '../components/StackedBars'
import type { DailyHistoryEntry } from './types'
import { mockMatchMedia } from './testMatchMedia'


function entry(day: number): DailyHistoryEntry {
  return {
    date: `2026-07-${String(day).padStart(2, '0')}`,
    cost: day,
    savingsUSD: 0,
    calls: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    topModels: [],
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, 'matchMedia')
})

describe('motion gate', () => {
  it('reducedMotion mirrors the prefers-reduced-motion query', () => {
    mockMatchMedia(true)
    expect(reducedMotion()).toBe(true)
    mockMatchMedia(false)
    expect(reducedMotion()).toBe(false)
  })

  it('reducedMotion is false when matchMedia is unavailable', () => {
    Reflect.deleteProperty(window, 'matchMedia')
    expect(reducedMotion()).toBe(false)
  })

  it('motionEnabled stays off under vitest even without a reduced-motion preference', () => {
    mockMatchMedia(false)
    expect(motionEnabled()).toBe(false)
  })

  it('motionClass drops the animation class while motion is off', () => {
    mockMatchMedia(false)
    expect(motionClass('body', 'section-fade')).toBe('body')
  })

  it('never drives a chart grow-in through gsap while the gate is closed', () => {
    const spy = vi.spyOn(gsap, 'from')
    mockMatchMedia(false)
    const { container } = render(<StackedBars daily={[entry(1), entry(2)]} animateKey="a" />)
    expect(spy).not.toHaveBeenCalled()
    // The bars still render at their natural, un-transformed size.
    expect(container.querySelectorAll('.sbars .c')).toHaveLength(2)
  })
})

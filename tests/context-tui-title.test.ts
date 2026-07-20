import { describe, it, expect } from 'vitest'

import { sessionPrimaryLabel } from '../src/context-tui.js'

describe('sessionPrimaryLabel', () => {
  it('uses the title when present', () => {
    expect(sessionPrimaryLabel('Refactor the parser')).toBe('Refactor the parser')
  })

  it('trims surrounding whitespace', () => {
    expect(sessionPrimaryLabel('  Fix the dashboard  ')).toBe('Fix the dashboard')
  })

  it('falls back to a placeholder for an empty or whitespace-only title', () => {
    expect(sessionPrimaryLabel('')).toBe('untitled session')
    expect(sessionPrimaryLabel('   ')).toBe('untitled session')
  })

  it('falls back to a placeholder for an undefined title', () => {
    expect(sessionPrimaryLabel(undefined)).toBe('untitled session')
  })
})

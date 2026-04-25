import { describe, expect, it } from 'vitest'

import { AUGGIE_TOKENS, TUI_THEME, gradientColor } from '../src/theme.js'

describe('Auggie TUI theme', () => {
  it('keeps the raw upstream cyanBright token for fidelity only', () => {
    expect(AUGGIE_TOKENS.cyanBright).toBe('#80d8f')
    expect(Object.values(TUI_THEME).flatMap(value => Object.values(value))).not.toContain(AUGGIE_TOKENS.cyanBright)
  })

  it('maps primary values and usage bars to approved Auggie semantics', () => {
    expect(TUI_THEME.value.primary).toBe(AUGGIE_TOKENS.yellowBright)
    expect(TUI_THEME.accent.primary).toBe(AUGGIE_TOKENS.brand)
    expect(TUI_THEME.bars.usageGradient).toBe(AUGGIE_TOKENS.brandGradient)
  })

  it('interpolates across the brand gradient', () => {
    expect(gradientColor(TUI_THEME.bars.usageGradient, 0)).toBe(AUGGIE_TOKENS.brandGradient[0])
    expect(gradientColor(TUI_THEME.bars.usageGradient, 1)).toBe(AUGGIE_TOKENS.brandGradient[2])
  })
})
import { describe, it, expect } from 'vitest'

import { PROVIDER_COLORS, providerColor, providerLabel } from '../src/provider-colors.js'

describe('provider presentation metadata', () => {
  it('exports the shared provider palette', () => {
    expect(PROVIDER_COLORS).toEqual({
      all: '#FF8C42',
      claude: '#FF8C42',
      codex: '#5BF5A0',
      cursor: '#00B4D8',
      opencode: '#A78BFA',
      pi: '#F472B6',
      copilot: '#6495ED',
    })
  })

  it('maps provider names to labels', () => {
    expect(providerLabel('all')).toBe('All')
    expect(providerLabel('opencode')).toBe('OpenCode')
    expect(providerLabel('unknown')).toBe('unknown')
  })

  it('maps provider names to colors with a neutral fallback', () => {
    expect(providerColor('all')).toBe('#FF8C42')
    expect(providerColor('opencode')).toBe('#A78BFA')
    expect(providerColor('unknown')).toBe('#CCCCCC')
  })
})

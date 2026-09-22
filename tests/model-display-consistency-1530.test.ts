import { describe, expect, it } from 'vitest'

import { fallbackRawModelDisplayName } from '../src/models.js'
import { pi, createOmpProvider } from '../src/providers/pi.js'
import { copilot } from '../src/providers/copilot.js'

// The exact composition models-report/audit-report use: the provider's local
// table first, then the global resolver when the provider echoed the raw id.
// One model id must resolve to one display name on every provider (#1530).
function displayNameOf(provider: { modelDisplayName?: (m: string) => string }, model: string): string {
  return fallbackRawModelDisplayName(provider.modelDisplayName!(model), model)
}

describe('model display name consistency across providers (#1530)', () => {
  const omp = createOmpProvider()
  const providers = [
    { name: 'pi', modelDisplayName: pi.modelDisplayName },
    { name: 'omp', modelDisplayName: omp.modelDisplayName },
    { name: 'copilot', modelDisplayName: copilot.modelDisplayName },
  ]

  // The rows from the issue: copilot and pi showed "GPT-5" / "Opus 4" because
  // a bare `gpt-5` key prefix-matched `gpt-5.5` / `gpt-5.6-luna`, and the
  // dot-form Claude minor was dropped by the dash-only derivation.
  it('shows GPT-5.5 and the GPT-5.6 variants on every provider', () => {
    for (const p of providers) {
      expect(displayNameOf(p, 'gpt-5.5')).toBe('GPT-5.5')
      expect(displayNameOf(p, 'gpt-5.6-terra')).toBe('GPT-5.6 Terra')
      expect(displayNameOf(p, 'gpt-5.6-luna')).toBe('GPT-5.6 Luna')
      expect(displayNameOf(p, 'gpt-5.5')).not.toBe('GPT-5')
    }
  })

  it('shows the Claude minor for dot-form ids on every provider', () => {
    for (const p of providers) {
      expect(displayNameOf(p, 'claude-opus-4.8')).toBe('Opus 4.8')
      expect(displayNameOf(p, 'claude-sonnet-4.5')).toBe('Sonnet 4.5')
    }
  })

  it('resolves one id to the same name on every provider', () => {
    const ids = ['gpt-5.5', 'gpt-5.6-terra', 'gpt-5.6-luna', 'claude-opus-4.8', 'gpt-5.4-mini', 'gpt-5-mini', 'gpt-5', 'gpt-4o']
    for (const id of ids) {
      const names = new Set(providers.map(p => displayNameOf(p, id)))
      expect([...names], id).toHaveLength(1)
    }
  })

  it('keeps the provider-specific auto-model overrides', () => {
    expect(displayNameOf(copilot, 'copilot-openai-auto')).toBe('Copilot (OpenAI auto)')
    expect(displayNameOf(copilot, 'copilot-anthropic-auto')).toBe('Copilot (Anthropic auto)')
  })
})

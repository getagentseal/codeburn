import { describe, expect, it } from 'vitest'

import { detectedProviders } from './providers'
import type { MenubarPayload } from './types'

function payload(providerDetails?: MenubarPayload['current']['providerDetails'], providers: Record<string, number> = {}): MenubarPayload['current'] {
  return { providers, providerDetails } as MenubarPayload['current']
}

describe('detectedProviders', () => {
  it('keeps providers that are installed but idle in the period, marked idle and last', () => {
    const entries = detectedProviders(payload([
      { id: 'claude', label: 'Claude', cost: 10, hasUsage: true },
      { id: 'warp', label: 'Warp', cost: 0, hasUsage: false },
      { id: 'codex', label: 'Codex', cost: 0, hasUsage: true },
      { id: 'antigravity', label: 'Antigravity', cost: 0, hasUsage: false },
    ]))
    expect(entries.map(entry => entry.id)).toEqual(['claude', 'codex', 'antigravity', 'warp'])
    expect(entries.map(entry => entry.idle)).toEqual([false, false, true, true])
  })

  it('treats a CLI that omits hasUsage as all-active', () => {
    const entries = detectedProviders(payload([
      { id: 'claude', label: 'Claude', cost: 0 },
      { id: 'codex', label: 'Codex', cost: 5 },
    ]))
    expect(entries.map(entry => entry.id)).toEqual(['codex', 'claude'])
    expect(entries.every(entry => !entry.idle)).toBe(true)
  })

  it('falls back to the providers map, dropping keys that cannot round-trip as --provider', () => {
    const entries = detectedProviders(payload(undefined, { claude: 4, 'grok build': 2, gemini: 0 }))
    expect(entries).toEqual([{ id: 'claude', label: 'Claude', cost: 4, idle: false }])
  })

  it('has nothing to show without a payload', () => {
    expect(detectedProviders(undefined)).toEqual([])
  })
})

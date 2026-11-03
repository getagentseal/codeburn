import { describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))

import { autoSeed, DEFAULT_DOCK_PREFS, DOCK_MAX_AUTO_PROVIDERS, type DockPrefs } from '../windows/src/lib/dockPrefs'

function prefs(over: Partial<DockPrefs> = {}): DockPrefs {
  return { ...DEFAULT_DOCK_PREFS, enabled: true, ...over }
}

describe('Capacity Dock auto-seed', () => {
  it('leaves the rail alone once the user has taken the set', () => {
    const current = prefs({ providers: ['codex'], preferred: 'codex', manualSelection: true })
    expect(autoSeed(current, ['cursor'])).toBeNull()
  })

  it('does not hand a saved Codex rail to Cursor when Codex misses one refresh', () => {
    const current = prefs({
      providers: ['codex', 'cursor'],
      preferred: 'codex',
      keepExpanded: true,
    })
    expect(autoSeed(current, ['cursor'])).toBeNull()
  })

  it('adds a newly connected provider without moving the resting one', () => {
    const current = prefs({ providers: ['codex'], preferred: 'codex', keepExpanded: true })
    expect(autoSeed(current, ['codex', 'cursor'])).toEqual({ providers: ['codex', 'cursor'] })
  })

  it('puts a resting provider the set does not list yet onto the rail', () => {
    const current = prefs({ providers: ['cursor'], preferred: 'codex' })
    expect(autoSeed(current, ['cursor'])).toEqual({ providers: ['codex', 'cursor'] })
  })

  it('does not put a Claude profile row saved as the resting choice onto the rail', () => {
    const current = prefs({ providers: ['claude', 'codex'], preferred: 'claude-config:0123456789abcdef' })
    expect(autoSeed(current, ['claude', 'codex'], ['claude', 'codex'])).toBeNull()
  })

  it('seeds a fresh rail from whoever is connected and rests on the first', () => {
    expect(autoSeed(prefs(), ['codex', 'cursor'])).toEqual({
      providers: ['codex', 'cursor'],
      preferred: 'codex',
    })
  })

  it('waits, rather than writing an empty rail, when nobody is connected yet', () => {
    expect(autoSeed(prefs(), [])).toBeNull()
  })

  it('does not clear a rail when a refresh reports nobody', () => {
    const current = prefs({ providers: ['codex'], preferred: 'codex', keepExpanded: true })
    expect(autoSeed(current, [])).toBeNull()
  })

  it('does not evict the resting provider to make room at the cap', () => {
    const held = ['codex', 'claude', 'gemini', 'copilot', 'antigravity']
    expect(held).toHaveLength(DOCK_MAX_AUTO_PROVIDERS)
    const current = prefs({ providers: held, preferred: 'codex' })
    expect(autoSeed(current, ['cursor', ...held])).toBeNull()
  })
})

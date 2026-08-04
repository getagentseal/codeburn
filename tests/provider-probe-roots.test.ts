import { describe, it, expect } from 'vitest'
import { isAbsolute, join } from 'path'

import { createCodeWhaleProvider } from '../src/providers/codewhale.js'
import { createHermesProvider } from '../src/providers/hermes.js'
import { createLingTaiTuiProvider } from '../src/providers/lingtai-tui.js'
import { createDroidProvider } from '../src/providers/droid.js'
import { createCursorProvider } from '../src/providers/cursor.js'
import { createCursorAgentProvider } from '../src/providers/cursor-agent.js'
import { createGooseProvider } from '../src/providers/goose.js'
import { createCrushProvider } from '../src/providers/crush.js'
import { createWarpProvider } from '../src/providers/warp.js'
import { createAntigravityProvider } from '../src/providers/antigravity.js'
import { createQwenProvider } from '../src/providers/qwen.js'
import { createIBMBobProvider } from '../src/providers/ibm-bob.js'

// probeRoots must mirror the exact resolution each provider's discovery uses
// (#899 Tier 1). Where a factory takes an override, the assertion is exact:
// the same override must come back through probeRoots, proving the two paths
// share one resolution. Providers without an override factory get structural
// assertions: non-empty, absolute, correctly labeled.

describe('probeRoots mirrors discovery resolution', () => {
  it('codewhale reports the configured dirs, or both defaults', async () => {
    expect(await createCodeWhaleProvider('/tmp/cw-root').probeRoots!()).toEqual([
      { path: '/tmp/cw-root', label: 'sessions' },
    ])
    const defaults = await createCodeWhaleProvider().probeRoots!()
    expect(defaults).toHaveLength(2)
    for (const root of defaults) expect(isAbsolute(root.path)).toBe(true)
  })

  it('hermes reports its resolved home', async () => {
    expect(await createHermesProvider('/tmp/hermes-home').probeRoots!()).toEqual([
      { path: '/tmp/hermes-home', label: 'home' },
    ])
  })

  it('droid reports the sessions dir under the factory root', async () => {
    expect(await createDroidProvider('/tmp/factory').probeRoots!()).toEqual([
      { path: join('/tmp/factory', 'sessions'), label: 'sessions' },
    ])
  })

  it('cursor reports the state db path', async () => {
    expect(await createCursorProvider('/tmp/cursor/state.vscdb').probeRoots!()).toEqual([
      { path: '/tmp/cursor/state.vscdb', label: 'db' },
    ])
  })

  it('cursor-agent reports the projects dir and the attribution db', async () => {
    expect(await createCursorAgentProvider('/tmp/ca').probeRoots!()).toEqual([
      { path: join('/tmp/ca', 'projects'), label: 'projects' },
      { path: join('/tmp/ca', 'ai-tracking', 'ai-code-tracking.db'), label: 'db' },
    ])
  })

  it('warp reports the override db, or both bundle candidates', async () => {
    expect(await createWarpProvider('/tmp/warp.db').probeRoots!()).toEqual([
      { path: '/tmp/warp.db', label: 'db' },
    ])
    const defaults = await createWarpProvider().probeRoots!()
    expect(defaults).toHaveLength(2)
    for (const root of defaults) {
      expect(isAbsolute(root.path)).toBe(true)
      expect(root.label).toBe('db')
    }
  })

  it('qwen reports the projects dir', async () => {
    expect(await createQwenProvider('/tmp/qwen-projects').probeRoots!()).toEqual([
      { path: '/tmp/qwen-projects', label: 'projects' },
    ])
  })

  it('ibm-bob reports the storage dirs', async () => {
    expect(await createIBMBobProvider('/tmp/bob').probeRoots!()).toEqual([
      { path: '/tmp/bob', label: 'storage' },
    ])
    const defaults = await createIBMBobProvider().probeRoots!()
    expect(defaults.length).toBeGreaterThan(0)
    for (const root of defaults) expect(root.label).toBe('storage')
  })

  it('lingtai-tui reports its candidates even when none exist yet', async () => {
    // getLingTaiHomes drops non-existent candidates (right for discovery);
    // probeRoots must keep them visible so doctor can show where it looked.
    const roots = await createLingTaiTuiProvider().probeRoots!()
    expect(roots.length).toBeGreaterThanOrEqual(2)
    for (const root of roots) expect(isAbsolute(root.path)).toBe(true)
    const labels = new Set(roots.map(r => r.label))
    expect(labels.has('sessions')).toBe(true)
    expect(labels.has('registry')).toBe(true)
  })

  it('goose reports its sessions db', async () => {
    const roots = await createGooseProvider().probeRoots!()
    expect(roots).toHaveLength(1)
    expect(isAbsolute(roots[0]!.path)).toBe(true)
    expect(roots[0]!.label).toBe('db')
  })

  it('crush reports its registry file', async () => {
    const roots = await createCrushProvider().probeRoots!()
    expect(roots).toHaveLength(1)
    expect(isAbsolute(roots[0]!.path)).toBe(true)
    expect(roots[0]!.label).toBe('registry')
  })

  it('antigravity reports its conversation roots and the statusline file', async () => {
    const roots = await createAntigravityProvider().probeRoots!()
    expect(roots.length).toBeGreaterThanOrEqual(2)
    for (const root of roots) expect(isAbsolute(root.path)).toBe(true)
    const labels = new Set(roots.map(r => r.label))
    expect(labels.has('conversations')).toBe(true)
    expect(labels.has('statusline')).toBe(true)
  })
})

import { describe, it, expect } from 'vitest'
import { isAbsolute, join } from 'path'
import { homedir } from 'os'

import { createClineProvider, getClineDataPath } from '../src/providers/cline.js'
import { createRooCodeProvider } from '../src/providers/roo-code.js'
import { createKiloCodeProvider } from '../src/providers/kilo-code.js'
import { createGrokProvider } from '../src/providers/grok.js'
import { createPiProvider, createOmpProvider } from '../src/providers/pi.js'
import { createKimiProvider } from '../src/providers/kimi.js'
import {
  clineTaskRoots,
  discoverClineTasks,
  getVSCodeGlobalStoragePaths,
} from '../src/providers/vscode-cline-parser.js'

// #899 Tier 2, batch 1. probeRoots() must report the roots discovery actually
// reads: a probe pointing somewhere discovery never looks is worse than none,
// because it looks authoritative. Assertions pin exact root sets rather than
// substrings, so a wrong-but-similar path cannot pass.
//
// This file is separate from the Tier 1 suite only because #903 introduces
// that one and is still open; fold the two together once it lands.

const CLINE_EXTENSION = 'saoudrizwan.claude-dev'
const ROO_EXTENSION = 'rooveterinaryinc.roo-cline'

describe('probeRoots mirrors discovery resolution (Tier 2, batch 1)', () => {
  it('cline reports exactly the roots discovery scans', async () => {
    // The provider whose silence motivated #874: four places to look, and until
    // now no way to see which of them CodeBurn actually read.
    const roots = await createClineProvider().probeRoots!()
    expect(roots).toEqual([
      ...clineTaskRoots(CLINE_EXTENSION).map(path => ({ path, label: 'tasks' })),
      { path: getClineDataPath(), label: 'tasks' },
    ])
    expect(roots).toHaveLength(4)
    for (const root of roots) expect(isAbsolute(root.path)).toBe(true)
  })

  it('cline reports the configured dirs verbatim when overridden', async () => {
    expect(await createClineProvider(['/tmp/cline-a', '/tmp/cline-b']).probeRoots!()).toEqual([
      { path: '/tmp/cline-a', label: 'tasks' },
      { path: '/tmp/cline-b', label: 'tasks' },
    ])
  })

  it('roo-code reports the override, or exactly the VS Code variant roots', async () => {
    expect(await createRooCodeProvider('/tmp/roo-a').probeRoots!()).toEqual([
      { path: '/tmp/roo-a', label: 'tasks' },
    ])
    expect(await createRooCodeProvider().probeRoots!()).toEqual(
      getVSCodeGlobalStoragePaths(ROO_EXTENSION).map(path => ({ path, label: 'tasks' })),
    )
  })

  // Regression: an earlier draft mirrored the resolution in a local helper that
  // detected "no override" with `=== undefined`, while discoverClineTasks uses
  // truthiness. An empty-string override made doctor report [""] while
  // discovery scanned the three default roots. Both now call one resolver.
  it('an empty-string override resolves the same for probeRoots and discovery', async () => {
    const probed = (await createRooCodeProvider('').probeRoots!()).map(r => r.path)
    expect(probed).toEqual(clineTaskRoots(ROO_EXTENSION, ''))
    expect(probed).toEqual(getVSCodeGlobalStoragePaths(ROO_EXTENSION))
    // discoverClineTasks resolves through the same function, so an empty
    // override cannot send discovery somewhere probeRoots did not report.
    expect(await discoverClineTasks(ROO_EXTENSION, 'roo-code', 'Roo Code', '')).toEqual([])
  })

  it('kilo-code reports both halves of its discovery: tasks and the sqlite store', async () => {
    const roots = await createKiloCodeProvider('/tmp/kilo-a').probeRoots!()
    expect(roots[0]).toEqual({ path: '/tmp/kilo-a', label: 'tasks' })
    const sqlite = roots.filter(r => r.label === 'sqlite')
    expect(sqlite).toHaveLength(1)
    // The same dbDir discoverSqliteSessions reads, not a lookalike.
    expect(sqlite[0]!.path).toBe(
      join(process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share'), 'kilo'),
    )
  })

  it('grok reports exactly its resolved sessions dir', async () => {
    expect(await createGrokProvider('/tmp/grok-a').probeRoots!()).toEqual([
      { path: '/tmp/grok-a', label: 'sessions' },
    ])
    expect(await createGrokProvider().probeRoots!()).toEqual([
      { path: join(homedir(), '.grok', 'sessions'), label: 'sessions' },
    ])
  })

  it('pi and omp each report their own sessions dir', async () => {
    expect(await createPiProvider('/tmp/pi-a').probeRoots!()).toEqual([
      { path: '/tmp/pi-a', label: 'sessions' },
    ])
    expect(await createOmpProvider('/tmp/omp-a').probeRoots!()).toEqual([
      { path: '/tmp/omp-a', label: 'sessions' },
    ])
    // Same module, two providers: the roots must not collide.
    const [piRoot] = await createPiProvider().probeRoots!()
    const [ompRoot] = await createOmpProvider().probeRoots!()
    expect(piRoot!.path).not.toBe(ompRoot!.path)
  })

  it('kimi reports the sessions dir under its share root, not the share root itself', async () => {
    // Discovery walks <shareDir>/sessions; reporting shareDir would point doctor
    // at a directory that exists even when no sessions do.
    expect(await createKimiProvider('/tmp/kimi-a').probeRoots!()).toEqual([
      { path: join('/tmp/kimi-a', 'sessions'), label: 'sessions' },
    ])
  })
})

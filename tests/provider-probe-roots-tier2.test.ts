import { afterEach, describe, it, expect } from 'vitest'
import { isAbsolute, join } from 'path'
import { homedir } from 'os'

import { createClineProvider, getClineDataPath } from '../src/providers/cline.js'
import { createKiloCodeProvider } from '../src/providers/kilo-code.js'
import { createGrokProvider } from '../src/providers/grok.js'
import { createPiProvider, createOmpProvider } from '../src/providers/pi.js'
import { createKimiProvider } from '../src/providers/kimi.js'
import {
  clineTaskRoots,
  discoverClineTasks,
  getVSCodeGlobalStoragePaths,
} from '../src/providers/vscode-cline-parser.js'
import { createCodebuffProvider, getCodebuffRootSet } from '../src/providers/codebuff.js'
import { createDevinProvider } from '../src/providers/devin.js'
import { createGeminiProvider, getGeminiTmpDir } from '../src/providers/gemini.js'
import { createKiroProvider, getKiroAgentDirCandidates } from '../src/providers/kiro.js'
import { createMistralVibeProvider, getMistralVibeSessionsDir } from '../src/providers/mistral-vibe.js'

// #899 Tier 2, batch 1. probeRoots() must report the roots discovery actually
// reads: a probe pointing somewhere discovery never looks is worse than none,
// because it looks authoritative. Assertions pin exact root sets rather than
// substrings, so a wrong-but-similar path cannot pass.
//
// This file is separate from the Tier 1 suite only because #903 introduces
// that one and is still open; fold the two together once it lands.

const CLINE_EXTENSION = 'saoudrizwan.claude-dev'
const KILO_EXTENSION = 'kilocode.kilo-code'

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

  // Regression: an earlier draft mirrored the resolution in a local helper that
  // detected "no override" with `=== undefined`, while discoverClineTasks uses
  // truthiness. An empty-string override made doctor report [""] while
  // discovery scanned the three default roots. Both now call one resolver.
  it('an empty-string override resolves the same for probeRoots and discovery', async () => {
    const probed = (await createKiloCodeProvider('').probeRoots!()).filter(r => r.label === 'tasks').map(r => r.path)
    expect(probed).toEqual(clineTaskRoots(KILO_EXTENSION, ''))
    expect(probed).toEqual(getVSCodeGlobalStoragePaths(KILO_EXTENSION))
    // discoverClineTasks resolves through the same function, so an empty
    // override cannot send discovery somewhere probeRoots did not report.
    const discovered = await discoverClineTasks(KILO_EXTENSION, 'kilo-code', 'KiloCode', '')
    for (const source of discovered) expect(probed.some(root => source.path.startsWith(root))).toBe(true)
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

// #899 Tier 2, batch 2. Same contract as batch 1: probeRoots() is the exact
// discovery-root set after the same resolution, pinned as full objects.
describe('probeRoots mirrors discovery resolution (Tier 2, batch 2)', () => {
  const originalCodebuffDataDir = process.env['CODEBUFF_DATA_DIR']
  const originalVibeHome = process.env['VIBE_HOME']

  afterEach(() => {
    if (originalCodebuffDataDir === undefined) delete process.env['CODEBUFF_DATA_DIR']
    else process.env['CODEBUFF_DATA_DIR'] = originalCodebuffDataDir
    if (originalVibeHome === undefined) delete process.env['VIBE_HOME']
    else process.env['VIBE_HOME'] = originalVibeHome
  })

  it('codebuff reports all three CHANNELS on default, and empty factory is unset', async () => {
    const expected = [
      { path: join(homedir(), '.config', 'manicode'), label: 'chats' },
      { path: join(homedir(), '.config', 'manicode-dev'), label: 'chats' },
      { path: join(homedir(), '.config', 'manicode-staging'), label: 'chats' },
    ]
    expect(await createCodebuffProvider().probeRoots!()).toEqual(expected)
    expect(await createCodebuffProvider('').probeRoots!()).toEqual(expected)
    expect(getCodebuffRootSet()).toEqual(expected.map(r => r.path))
    expect(getCodebuffRootSet('')).toEqual(expected.map(r => r.path))
    for (const root of expected) expect(isAbsolute(root.path)).toBe(true)
  })

  it('codebuff reports the factory root, or CODEBUFF_DATA_DIR when factory is empty', async () => {
    expect(await createCodebuffProvider('/tmp/codebuff-a').probeRoots!()).toEqual([
      { path: '/tmp/codebuff-a', label: 'chats' },
    ])
    process.env['CODEBUFF_DATA_DIR'] = '/tmp/codebuff-env'
    expect(await createCodebuffProvider().probeRoots!()).toEqual([
      { path: '/tmp/codebuff-env', label: 'chats' },
    ])
    expect(await createCodebuffProvider('').probeRoots!()).toEqual([
      { path: '/tmp/codebuff-env', label: 'chats' },
    ])
    // Non-blank factory wins over the env root.
    expect(await createCodebuffProvider('/tmp/codebuff-a').probeRoots!()).toEqual([
      { path: '/tmp/codebuff-a', label: 'chats' },
    ])
  })

  it('devin reports transcripts + sessions.db, not the parent, and empty factory is default', async () => {
    expect(await createDevinProvider('/tmp/probe-devin').probeRoots!()).toEqual([
      { path: join('/tmp/probe-devin', 'transcripts'), label: 'transcripts' },
      { path: join('/tmp/probe-devin', 'sessions.db'), label: 'sessions.db' },
    ])
    const defaults = [
      { path: join(homedir(), '.local', 'share', 'devin', 'cli', 'transcripts'), label: 'transcripts' },
      { path: join(homedir(), '.local', 'share', 'devin', 'cli', 'sessions.db'), label: 'sessions.db' },
    ]
    expect(await createDevinProvider().probeRoots!()).toEqual(defaults)
    expect(await createDevinProvider('').probeRoots!()).toEqual(defaults)
    for (const root of defaults) expect(isAbsolute(root.path)).toBe(true)
  })

  it('gemini reports only the shared tmp parent', async () => {
    const tmpDir = getGeminiTmpDir()
    expect(tmpDir).toBe(join(homedir(), '.gemini', 'tmp'))
    expect(await createGeminiProvider().probeRoots!()).toEqual([
      { path: tmpDir, label: 'tmp' },
    ])
    expect(tmpDir).not.toContain(`${join('tmp', 'chats')}`)
    expect(isAbsolute(tmpDir)).toBe(true)
  })

  it('kiro reports the override set exactly and never the developer Application Support tree', async () => {
    const agent = '/tmp/kiro-agent'
    const workspace = '/tmp/kiro-workspace'
    const cli = '/tmp/kiro-cli'
    const v2 = '/tmp/kiro-v2'
    const roots = await createKiroProvider(agent, workspace, cli, v2).probeRoots!()
    expect(roots).toEqual([
      { path: agent, label: 'agent' },
      { path: workspace, label: 'workspace' },
      { path: cli, label: 'cli' },
      { path: v2, label: 'v2' },
    ])
    for (const root of roots) {
      expect(isAbsolute(root.path)).toBe(true)
      expect(root.path).not.toContain('Application Support/Kiro')
    }
  })

  it('kiro empty-string table matches discovery: agent/workspace fall back, empty CLI and v2 are skipped', async () => {
    const workspace = '/tmp/kiro-ws'
    const cli = '/tmp/kiro-cli'
    const v2 = '/tmp/kiro-v2'

    const unsetAgent = await createKiroProvider(undefined, workspace, cli, v2).probeRoots!()
    const emptyAgent = await createKiroProvider('', workspace, cli, v2).probeRoots!()
    expect(emptyAgent).toEqual(unsetAgent)
    expect(emptyAgent.map(r => r.path)).toEqual([
      ...getKiroAgentDirCandidates(''),
      workspace,
      cli,
      v2,
    ])
    expect(emptyAgent.filter(r => r.label === 'agent').map(r => r.path)).toEqual(
      getKiroAgentDirCandidates(),
    )

    const unsetWorkspace = await createKiroProvider('/tmp/kiro-agent', undefined, cli, v2).probeRoots!()
    const emptyWorkspace = await createKiroProvider('/tmp/kiro-agent', '', cli, v2).probeRoots!()
    expect(emptyWorkspace).toEqual(unsetWorkspace)
    expect(emptyWorkspace.find(r => r.label === 'workspace')!.path).not.toBe('')

    const emptyCli = await createKiroProvider('/tmp/kiro-agent', workspace, '', v2).probeRoots!()
    expect(emptyCli).toEqual([
      { path: '/tmp/kiro-agent', label: 'agent' },
      { path: workspace, label: 'workspace' },
      { path: v2, label: 'v2' },
    ])
    expect(emptyCli.map(r => r.path)).not.toContain('')
    expect(emptyCli.map(r => r.path)).not.toContain('.')

    const emptyV2 = await createKiroProvider('/tmp/kiro-agent', workspace, cli, '').probeRoots!()
    expect(emptyV2).toEqual([
      { path: '/tmp/kiro-agent', label: 'agent' },
      { path: workspace, label: 'workspace' },
      { path: cli, label: 'cli' },
    ])
    expect(emptyV2.some(r => r.label === 'v2')).toBe(false)

    const emptyCliAndV2 = await createKiroProvider('/tmp/kiro-agent', workspace, '', '').probeRoots!()
    expect(emptyCliAndV2).toEqual([
      { path: '/tmp/kiro-agent', label: 'agent' },
      { path: workspace, label: 'workspace' },
    ])

    const skipped = await createKiroProvider('/tmp/kiro-agent', workspace, '', '').discoverSessions()
    expect(skipped).toEqual([])
  })

  it('mistral-vibe reports the same joined sessions dir discovery uses', async () => {
    expect(await createMistralVibeProvider('/tmp/vibe-sessions').probeRoots!()).toEqual([
      { path: getMistralVibeSessionsDir('/tmp/vibe-sessions'), label: 'sessions' },
    ])
    expect(getMistralVibeSessionsDir('/tmp/vibe-sessions')).toBe('/tmp/vibe-sessions')

    const defaults = await createMistralVibeProvider().probeRoots!()
    expect(defaults).toEqual([
      { path: getMistralVibeSessionsDir(), label: 'sessions' },
    ])
    expect(defaults[0]!.path).toBe(join(homedir(), '.vibe', 'logs', 'session'))
    expect(await createMistralVibeProvider('').probeRoots!()).toEqual(defaults)

    process.env['VIBE_HOME'] = '/tmp/vibe-home'
    expect(await createMistralVibeProvider().probeRoots!()).toEqual([
      { path: join('/tmp/vibe-home', 'logs', 'session'), label: 'sessions' },
    ])
    expect(getMistralVibeSessionsDir()).toBe(join('/tmp/vibe-home', 'logs', 'session'))
  })
})

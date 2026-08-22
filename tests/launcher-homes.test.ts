import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { collectLauncherNotes, isNestedLauncherCodexHome } from '../src/launcher-homes.js'
import { collectDoctorReport, renderDoctorTable } from '../src/doctor.js'
import { createCodexProvider } from '../src/providers/codex.js'
import { emptyCache } from '../src/session-cache.js'

function sessionMeta(): string {
  return JSON.stringify({
    type: 'session_meta',
    timestamp: '2026-04-14T10:00:00Z',
    payload: { cwd: '/Users/test/proj', originator: 'codex-cli', session_id: 'sess-001', model: 'gpt-5.3-codex' },
  })
}

async function writeCodexSession(codexDir: string, name = 'rollout-sess-001.jsonl'): Promise<void> {
  const dayDir = join(codexDir, 'sessions', '2026', '04', '14')
  await mkdir(dayDir, { recursive: true })
  await writeFile(join(dayDir, name), `${sessionMeta()}\n`)
}

describe('isNestedLauncherCodexHome', () => {
  it('skips a Codex home under .buzz when a distinct primary home exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'launch-'))
    const primary = join(root, 'real-codex')
    const buzz = join(root, '.buzz')
    const nested = join(buzz, '.codex')
    await mkdir(primary, { recursive: true })
    await mkdir(nested, { recursive: true })
    expect(isNestedLauncherCodexHome(nested, { primaryDir: primary, launcherRoots: [buzz] })).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  it('does not skip the sole Codex home even if it sits under .buzz', async () => {
    const root = await mkdtemp(join(tmpdir(), 'launch-'))
    const buzz = join(root, '.buzz')
    const nested = join(buzz, '.codex')
    await mkdir(nested, { recursive: true })
    expect(isNestedLauncherCodexHome(nested, { primaryDir: nested, launcherRoots: [buzz] })).toBe(false)
    await rm(root, { recursive: true, force: true })
  })
})

describe('Codex discover skips nested Buzz home', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'codex-buzz-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('counts only the primary tree when a Buzz nest also has rollouts', async () => {
    const primary = join(root, 'primary')
    const buzz = join(root, '.buzz')
    const nested = join(buzz, '.codex')
    await writeCodexSession(primary, 'rollout-primary.jsonl')
    await writeCodexSession(nested, 'rollout-buzz.jsonl')
    const real = createCodexProvider(primary, { primaryDir: primary, launcherRoots: [buzz] })
    const nest = createCodexProvider(nested, { primaryDir: primary, launcherRoots: [buzz] })
    expect((await real.discoverSessions()).map(s => s.path.split('/').pop())).toEqual(['rollout-primary.jsonl'])
    expect(await nest.discoverSessions()).toEqual([])
  })

  it('default factory with CODEX_HOME in .buzz walks ~/.codex, not the nest', async () => {
    const home = root
    const primary = join(home, '.codex')
    const nested = join(home, '.buzz', '.codex')
    await writeCodexSession(primary, 'rollout-primary.jsonl')
    await writeCodexSession(nested, 'rollout-buzz.jsonl')
    const prevHome = process.env.HOME
    const prevCodex = process.env.CODEX_HOME
    process.env.HOME = home
    process.env.CODEX_HOME = nested
    try {
      const provider = createCodexProvider()
      expect((await provider.discoverSessions()).map(s => s.path.split('/').pop())).toEqual(['rollout-primary.jsonl'])
      const roots = await provider.probeRoots!()
      expect(roots.map(r => r.path)).toEqual([
        join(primary, 'sessions'),
        join(primary, 'archived_sessions'),
      ])
    } finally {
      if (prevHome === undefined) delete process.env.HOME
      else process.env.HOME = prevHome
      if (prevCodex === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = prevCodex
    }
  })

  it('keeps a sole CODEX_HOME nest when ~/.codex does not exist', async () => {
    const home = root
    const nested = join(home, '.buzz', '.codex')
    await writeCodexSession(nested, 'rollout-buzz.jsonl')
    const prevHome = process.env.HOME
    const prevCodex = process.env.CODEX_HOME
    process.env.HOME = home
    process.env.CODEX_HOME = nested
    try {
      const provider = createCodexProvider()
      expect((await provider.discoverSessions()).map(s => s.path.split('/').pop())).toEqual(['rollout-buzz.jsonl'])
    } finally {
      if (prevHome === undefined) delete process.env.HOME
      else process.env.HOME = prevHome
      if (prevCodex === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = prevCodex
    }
  })
})

describe('doctor launchers', () => {
  it('lists Buzz as a launcher with no session count', async () => {
    const home = await mkdtemp(join(tmpdir(), 'home-'))
    await mkdir(join(home, '.buzz'), { recursive: true })
    const notes = collectLauncherNotes(home)
    expect(notes).toEqual([expect.objectContaining({ name: 'buzz', billedVia: 'codex' })])
    expect(notes[0]!.verdict).toMatch(/LAUNCHER/)
    expect(notes[0]!.verdict).not.toMatch(/\d+\s+session/)

    const report = await collectDoctorReport('all', {
      providers: [createCodexProvider(join(home, 'empty-codex'))],
      cache: emptyCache(),
      launchers: notes,
    })
    expect(report.launchers).toEqual(notes)
    const table = renderDoctorTable(report, { color: false })
    expect(table).toContain('Launchers')
    expect(table).toContain('buzz')
    expect(table).toContain('billed via Codex')
    await rm(home, { recursive: true, force: true })
  })
})

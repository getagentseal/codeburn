import { afterAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { PassThrough, Writable } from 'node:stream'

import { planFor, planFindings, type PlanContext } from '../src/act/plans.js'
import { runOptimizeApply, type ApplyOptions } from '../src/act/optimize-apply.js'
import { runAction } from '../src/act/apply.js'
import { undoAction } from '../src/act/undo.js'
import { readRecords } from '../src/act/journal.js'
import type { FindingApply, FindingId, WasteAction, WasteFinding } from '../src/optimize.js'

// Plan-kind tests for the deferral family (defer-enable / defer-alwaysload /
// defer-threshold, #614 commit 2), following tests/optimize-apply.test.ts:
// temp fixture roots, planFor/planFindings, runAction/undoAction, and
// byte-equality assertions on everything the plans must not touch.

const roots: string[] = []

type Fixture = { root: string; home: string; project: string; actionsDir: string }

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'codeburn-defer-plans-'))
  roots.push(root)
  const home = join(root, 'home')
  const project = join(root, 'project')
  await mkdir(home, { recursive: true })
  await mkdir(project, { recursive: true })
  return { root, home, project, actionsDir: join(root, 'actions') }
}

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

function makeFinding(id: FindingId, apply?: FindingApply): WasteFinding {
  const fix: WasteAction = { type: 'command', label: '', text: '' }
  return { id, title: id, explanation: '', impact: 'medium', tokensSaved: 1000, fix, ...(apply ? { apply } : {}) }
}

// Server-level alwaysLoad shipped in v2.1.121; SUPPORTED sits safely above.
const SUPPORTED_VERSION = '2.1.130'

function ctx(fx: Fixture, claudeVersion: string | null = SUPPORTED_VERSION): PlanContext {
  return { homeDir: fx.home, cwd: fx.project, shell: '/bin/zsh', claudeVersion: () => claudeVersion }
}

function stringify(doc: unknown): string {
  return JSON.stringify(doc, null, 2) + '\n'
}

async function hashTree(dir: string): Promise<string> {
  const h = createHash('sha256')
  async function walk(d: string): Promise<void> {
    const entries = (await readdir(d, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const full = join(d, entry.name)
      if (entry.isDirectory()) {
        h.update('D:' + full + '\n')
        await walk(full)
      } else {
        h.update('F:' + full + '\n')
        h.update(await readFile(full))
      }
    }
  }
  await walk(dir)
  return h.digest('hex')
}

// ---------------------------------------------------------------------------
// defer-enable
// ---------------------------------------------------------------------------

describe('defer-enable plan (env-false in a settings file)', () => {
  it('removes only ENABLE_TOOL_SEARCH, preserves key order, journals, and undoes byte-identically', async () => {
    const fx = await makeFixture()
    const settings = join(fx.home, '.claude', 'settings.json')
    await mkdir(join(fx.home, '.claude'), { recursive: true })
    // Deliberately odd key order plus unrelated keys: the plan must change
    // exactly one env key and keep everything else byte-identical.
    const original = stringify({
      zeta: 1,
      env: { B: 'x', ENABLE_TOOL_SEARCH: 'false', A: 'y' },
      alpha: { keep: true },
    })
    await writeFile(settings, original)

    const finding = makeFinding('mcp-deferral-off', {
      kind: 'defer-enable', cause: 'env-false', settingPath: settings, settingScope: 'user settings', value: 'false',
    })
    const [fp] = planFindings([finding], ctx(fx))
    expect(fp!.plan).not.toBeNull()
    expect(fp!.plan!.kind).toBe('defer-enable')
    expect(fp!.plan!.findingId).toBe('mcp-deferral-off')
    expect(fp!.plan!.changes.map(c => c.path)).toEqual([settings])
    expect(fp!.notes.some(n => n.includes('takes effect on the next session'))).toBe(true)

    const rec = await runAction(fp!.plan!, fx.actionsDir)
    expect(rec.kind).toBe('defer-enable')
    expect(rec.findingId).toBe('mcp-deferral-off')

    // Same serializer, same insertion order: only the target key is gone.
    expect(await readFile(settings, 'utf-8')).toBe(stringify({
      zeta: 1,
      env: { B: 'x', A: 'y' },
      alpha: { keep: true },
    }))

    await undoAction({ id: rec.id }, { actionsDir: fx.actionsDir })
    expect(await readFile(settings, 'utf-8')).toBe(original)
  })

  it('leaves an emptied env object in place (mcp-remove convention for emptied containers)', async () => {
    const fx = await makeFixture()
    const settings = join(fx.project, '.claude', 'settings.local.json')
    await mkdir(join(fx.project, '.claude'), { recursive: true })
    await writeFile(settings, stringify({ env: { ENABLE_TOOL_SEARCH: '0' }, keep: true }))

    const finding = makeFinding('mcp-deferral-off', {
      kind: 'defer-enable', cause: 'env-false', settingPath: settings, settingScope: 'project local settings', value: '0',
    })
    const plan = planFor(finding, ctx(fx))
    expect(plan).not.toBeNull()
    await runAction(plan!, fx.actionsDir)
    expect(await readFile(settings, 'utf-8')).toBe(stringify({ env: {}, keep: true }))
  })

  it('skips with a note when the override drifted away before the plan was built', async () => {
    const fx = await makeFixture()
    const settings = join(fx.home, '.claude', 'settings.json')
    await mkdir(join(fx.home, '.claude'), { recursive: true })
    await writeFile(settings, stringify({ env: { OTHER: '1' } }))

    const finding = makeFinding('mcp-deferral-off', {
      kind: 'defer-enable', cause: 'env-false', settingPath: settings, settingScope: 'user settings', value: 'false',
    })
    const [fp] = planFindings([finding], ctx(fx))
    expect(fp!.plan).toBeNull()
    expect(fp!.notes.some(n => n.includes('ENABLE_TOOL_SEARCH is no longer set'))).toBe(true)
  })

  it('refuses to edit a shell profile, naming the exact file and line', async () => {
    const fx = await makeFixture()
    const zshrc = join(fx.home, '.zshrc')
    await writeFile(zshrc, '# mine\nexport ENABLE_TOOL_SEARCH=false\nalias ll="ls -la"\n')

    const finding = makeFinding('mcp-deferral-off', {
      kind: 'defer-enable', cause: 'env-false', settingPath: zshrc, settingScope: 'shell profile', value: 'false',
    })
    const [fp] = planFindings([finding], ctx(fx))
    expect(fp!.plan).toBeNull()
    const note = fp!.notes.join('\n')
    expect(note).toContain('.zshrc')
    expect(note).toContain('export ENABLE_TOOL_SEARCH=false')
    expect(note).toContain('never edits user lines')
    // Nothing on disk changed.
    expect(await readFile(zshrc, 'utf-8')).toContain('alias ll')
  })

  it('refuses cause proxy-unknown with verify-the-proxy instructions', async () => {
    const fx = await makeFixture()
    const settings = join(fx.home, '.claude', 'settings.json')
    await mkdir(join(fx.home, '.claude'), { recursive: true })
    const original = stringify({ env: { ANTHROPIC_BASE_URL: 'https://proxy.corp.example' } })
    await writeFile(settings, original)

    const finding = makeFinding('mcp-deferral-off', {
      kind: 'defer-enable', cause: 'proxy-unknown', settingPath: settings, settingScope: 'user settings', value: 'https://proxy.corp.example',
    })
    const [fp] = planFindings([finding], ctx(fx))
    expect(fp!.plan).toBeNull()
    const note = fp!.notes.join('\n')
    expect(note).toContain('not auto-applied')
    expect(note).toContain('tool_reference')
    expect(note).toContain('Verify')
    expect(await readFile(settings, 'utf-8')).toBe(original)
  })

  it('cause proxy-verified sets ENABLE_TOOL_SEARCH=true in user settings, creating the file when absent', async () => {
    const fx = await makeFixture()
    const settings = join(fx.home, '.claude', 'settings.json')
    expect(existsSync(settings)).toBe(false)

    const finding = makeFinding('mcp-deferral-off', { kind: 'defer-enable', cause: 'proxy-verified' })
    const [fp] = planFindings([finding], ctx(fx))
    expect(fp!.plan).not.toBeNull()
    expect(fp!.plan!.changes[0]).toMatchObject({ op: 'create', path: settings, expectedHash: null })

    const rec = await runAction(fp!.plan!, fx.actionsDir)
    expect(JSON.parse(await readFile(settings, 'utf-8'))).toEqual({ env: { ENABLE_TOOL_SEARCH: 'true' } })

    await undoAction({ id: rec.id }, { actionsDir: fx.actionsDir })
    expect(existsSync(settings)).toBe(false)
  })

  it('cause proxy-verified preserves an existing user settings file byte-for-byte around the new key', async () => {
    const fx = await makeFixture()
    const settings = join(fx.home, '.claude', 'settings.json')
    await mkdir(join(fx.home, '.claude'), { recursive: true })
    const original = stringify({ theme: 'dark', env: { PATH_EXTRA: '/x' }, hooks: {} })
    await writeFile(settings, original)

    const finding = makeFinding('mcp-deferral-off', { kind: 'defer-enable', cause: 'proxy-verified' })
    const plan = planFor(finding, ctx(fx))
    const rec = await runAction(plan!, fx.actionsDir)
    expect(await readFile(settings, 'utf-8')).toBe(stringify({
      theme: 'dark',
      env: { PATH_EXTRA: '/x', ENABLE_TOOL_SEARCH: 'true' },
      hooks: {},
    }))
    await undoAction({ id: rec.id }, { actionsDir: fx.actionsDir })
    expect(await readFile(settings, 'utf-8')).toBe(original)
  })

  it('causes vertex and old-version are manual with their required instructions', async () => {
    const fx = await makeFixture()
    const vertex = makeFinding('mcp-deferral-off', {
      kind: 'defer-enable', cause: 'vertex', settingPath: join(fx.home, '.zshrc'), settingScope: 'shell profile', value: '1',
    })
    const [vp] = planFindings([vertex], ctx(fx))
    expect(vp!.plan).toBeNull()
    expect(vp!.notes.join('\n')).toContain('Vertex')
    expect(vp!.notes.join('\n')).toContain('ENABLE_TOOL_SEARCH=true')

    const oldVersion = makeFinding('mcp-deferral-off', { kind: 'defer-enable', cause: 'old-version' })
    const [op] = planFindings([oldVersion], ctx(fx))
    expect(op!.plan).toBeNull()
    expect(op!.notes.join('\n')).toContain('claude update')
  })

  it('a finding without a payload stays manual with no notes', async () => {
    const fx = await makeFixture()
    const [fp] = planFindings([makeFinding('mcp-deferral-off')], ctx(fx))
    expect(fp!.plan).toBeNull()
    expect(fp!.notes).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// defer-alwaysload
// ---------------------------------------------------------------------------

describe('defer-alwaysload plan', () => {
  async function pinnedFixture(): Promise<{ fx: Fixture; mcpJson: string; settings: string; finding: WasteFinding; mcpOriginal: string; settingsOriginal: string }> {
    const fx = await makeFixture()
    const mcpJson = join(fx.project, '.mcp.json')
    const settings = join(fx.home, '.claude', 'settings.json')
    await mkdir(join(fx.home, '.claude'), { recursive: true })
    const mcpOriginal = stringify({
      mcpServers: {
        pinned: { command: 'x', alwaysLoad: true, args: ['--a'] },
        keepme: { command: 'y', alwaysLoad: true },
      },
      unrelated: 'z',
    })
    const settingsOriginal = stringify({
      env: { X: '1' },
      mcpServers: { pinned: { url: 'https://s.example', alwaysLoad: true } },
    })
    await writeFile(mcpJson, mcpOriginal)
    await writeFile(settings, settingsOriginal)
    const finding = makeFinding('mcp-alwaysload-hygiene', {
      kind: 'defer-alwaysload',
      servers: [{ server: 'pinned', paths: [mcpJson, settings] }],
    })
    return { fx, mcpJson, settings, finding, mcpOriginal, settingsOriginal }
  }

  it('removes alwaysLoad from the named server in the exact recorded files, then undoes byte-identically', async () => {
    const { fx, mcpJson, settings, finding, mcpOriginal, settingsOriginal } = await pinnedFixture()
    const [fp] = planFindings([finding], ctx(fx))
    expect(fp!.plan).not.toBeNull()
    expect(fp!.plan!.kind).toBe('defer-alwaysload')
    expect(fp!.plan!.findingId).toBe('mcp-alwaysload-hygiene')
    expect(fp!.plan!.changes.map(c => c.path).sort()).toEqual([mcpJson, settings].sort())
    // Preview must surface the startup-block cost the pin also carries.
    const pathNoteText = Object.values(fp!.pathNotes ?? {}).join('\n')
    expect(pathNoteText).toContain('startup')
    expect(pathNoteText).toContain('5s')
    expect(fp!.notes.some(n => n.includes('takes effect on the next session'))).toBe(true)

    const rec = await runAction(fp!.plan!, fx.actionsDir)
    expect(rec.kind).toBe('defer-alwaysload')

    // Only pinned loses its alwaysLoad; keepme (not in the payload) keeps it.
    expect(await readFile(mcpJson, 'utf-8')).toBe(stringify({
      mcpServers: {
        pinned: { command: 'x', args: ['--a'] },
        keepme: { command: 'y', alwaysLoad: true },
      },
      unrelated: 'z',
    }))
    expect(await readFile(settings, 'utf-8')).toBe(stringify({
      env: { X: '1' },
      mcpServers: { pinned: { url: 'https://s.example' } },
    }))

    await undoAction({ id: rec.id }, { actionsDir: fx.actionsDir })
    expect(await readFile(mcpJson, 'utf-8')).toBe(mcpOriginal)
    expect(await readFile(settings, 'utf-8')).toBe(settingsOriginal)
  })

  it('applies at exactly the minimum version (v2.1.121) and above it', async () => {
    for (const version of ['2.1.121', '2.2.0', '3.0.0 (Claude Code)']) {
      const { fx, finding } = await pinnedFixture()
      const plan = planFor(finding, ctx(fx, version))
      expect(plan, `version ${version}`).not.toBeNull()
    }
  })

  it('refuses below the version gate, naming the required version', async () => {
    const { fx, finding, mcpJson, mcpOriginal } = await pinnedFixture()
    const [fp] = planFindings([finding], ctx(fx, '2.1.120'))
    expect(fp!.plan).toBeNull()
    expect(fp!.notes.join('\n')).toContain('2.1.121')
    expect(fp!.notes.join('\n')).toContain('v2.1.120')
    expect(await readFile(mcpJson, 'utf-8')).toBe(mcpOriginal)
  })

  it('refuses when the version probe fails or returns garbage', async () => {
    for (const probed of [null, 'not a version']) {
      const { fx, finding } = await pinnedFixture()
      const [fp] = planFindings([finding], ctx(fx, probed))
      expect(fp!.plan, `probe ${String(probed)}`).toBeNull()
      expect(fp!.notes.join('\n')).toContain('2.1.121')
    }
  })

  it('skips a server whose pin drifted away, with a note', async () => {
    const fx = await makeFixture()
    const mcpJson = join(fx.project, '.mcp.json')
    await writeFile(mcpJson, stringify({ mcpServers: { pinned: { command: 'x' } } }))
    const finding = makeFinding('mcp-alwaysload-hygiene', {
      kind: 'defer-alwaysload',
      servers: [{ server: 'pinned', paths: [mcpJson] }],
    })
    const [fp] = planFindings([finding], ctx(fx))
    expect(fp!.plan).toBeNull()
    expect(fp!.notes.some(n => n.includes('skipped pinned'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// defer-threshold
// ---------------------------------------------------------------------------

describe('defer-threshold plan', () => {
  it('rewrites the auto value in place, preserving env siblings and key order, and undoes byte-identically', async () => {
    const fx = await makeFixture()
    const settings = join(fx.project, '.claude', 'settings.local.json')
    await mkdir(join(fx.project, '.claude'), { recursive: true })
    const original = stringify({ env: { OTHER: '1', ENABLE_TOOL_SEARCH: 'auto', LAST: '2' }, misc: 3 })
    await writeFile(settings, original)

    const finding = makeFinding('mcp-defer-threshold', {
      kind: 'defer-threshold', settingPath: settings, settingScope: 'project local settings',
      value: 'auto', recommendedPercent: 2, removeOverride: false,
    })
    const [fp] = planFindings([finding], ctx(fx))
    expect(fp!.plan).not.toBeNull()
    expect(fp!.plan!.kind).toBe('defer-threshold')
    expect(fp!.plan!.findingId).toBe('mcp-defer-threshold')
    expect(fp!.plan!.description).toContain('auto:2')
    expect(fp!.notes.some(n => n.includes('takes effect on the next session'))).toBe(true)

    const rec = await runAction(fp!.plan!, fx.actionsDir)
    expect(rec.kind).toBe('defer-threshold')
    expect(await readFile(settings, 'utf-8')).toBe(stringify({
      env: { OTHER: '1', ENABLE_TOOL_SEARCH: 'auto:2', LAST: '2' },
      misc: 3,
    }))

    await undoAction({ id: rec.id }, { actionsDir: fx.actionsDir })
    expect(await readFile(settings, 'utf-8')).toBe(original)
  })

  it('removes the override entirely when the default auto threshold already defers', async () => {
    const fx = await makeFixture()
    const settings = join(fx.home, '.claude', 'settings.json')
    await mkdir(join(fx.home, '.claude'), { recursive: true })
    await writeFile(settings, stringify({ env: { ENABLE_TOOL_SEARCH: 'auto:50', KEEP: 'k' } }))

    const finding = makeFinding('mcp-defer-threshold', {
      kind: 'defer-threshold', settingPath: settings, settingScope: 'user settings',
      value: 'auto:50', recommendedPercent: 14, removeOverride: true,
    })
    const plan = planFor(finding, ctx(fx))
    expect(plan).not.toBeNull()
    expect(plan!.description).toContain('Remove')
    await runAction(plan!, fx.actionsDir)
    expect(await readFile(settings, 'utf-8')).toBe(stringify({ env: { KEEP: 'k' } }))
  })

  it('refuses to rewrite a shell profile, quoting the line and the replacement', async () => {
    const fx = await makeFixture()
    const bashrc = join(fx.home, '.bashrc')
    await writeFile(bashrc, '# cfg\nENABLE_TOOL_SEARCH="auto:25"\n')

    const finding = makeFinding('mcp-defer-threshold', {
      kind: 'defer-threshold', settingPath: bashrc, settingScope: 'shell profile',
      value: 'auto:25', recommendedPercent: 2, removeOverride: false,
    })
    const [fp] = planFindings([finding], ctx(fx))
    expect(fp!.plan).toBeNull()
    const note = fp!.notes.join('\n')
    expect(note).toContain('.bashrc')
    expect(note).toContain('ENABLE_TOOL_SEARCH="auto:25"')
    expect(note).toContain('ENABLE_TOOL_SEARCH=auto:2')
  })

  it('skips with a note when the override drifted away', async () => {
    const fx = await makeFixture()
    const settings = join(fx.home, '.claude', 'settings.json')
    await mkdir(join(fx.home, '.claude'), { recursive: true })
    await writeFile(settings, stringify({ env: {} }))

    const finding = makeFinding('mcp-defer-threshold', {
      kind: 'defer-threshold', settingPath: settings, settingScope: 'user settings',
      value: 'auto', recommendedPercent: 2, removeOverride: false,
    })
    const [fp] = planFindings([finding], ctx(fx))
    expect(fp!.plan).toBeNull()
    expect(fp!.notes.some(n => n.includes('no longer set'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// runOptimizeApply end-to-end (dry run + apply) for the deferral family
// ---------------------------------------------------------------------------

const ANSI = /\[[0-9;]*m/g

function makeIo(): { input: PassThrough; output: Writable; errorOutput: Writable; stdout(): string } {
  const input = new PassThrough()
  input.end('')
  const outChunks: Buffer[] = []
  const output = new Writable({ write(c, _e, cb) { outChunks.push(Buffer.from(c)); cb() } })
  const errorOutput = new Writable({ write(_c, _e, cb) { cb() } })
  return { input, output, errorOutput, stdout: () => Buffer.concat(outChunks).toString('utf-8').replace(ANSI, '') }
}

async function deferFamilyFixture(): Promise<{ fx: Fixture; findings: WasteFinding[]; settings: string; mcpJson: string }> {
  const fx = await makeFixture()
  const settings = join(fx.home, '.claude', 'settings.json')
  const localSettings = join(fx.home, '.claude', 'settings.local.json')
  const mcpJson = join(fx.project, '.mcp.json')
  await mkdir(join(fx.home, '.claude'), { recursive: true })
  await writeFile(settings, stringify({ env: { ENABLE_TOOL_SEARCH: 'false' } }))
  await writeFile(localSettings, stringify({ env: { ENABLE_TOOL_SEARCH: 'auto' } }))
  await writeFile(mcpJson, stringify({ mcpServers: { pinned: { command: 'x', alwaysLoad: true } } }))
  const findings: WasteFinding[] = [
    makeFinding('mcp-deferral-off', {
      kind: 'defer-enable', cause: 'env-false', settingPath: settings, settingScope: 'user settings', value: 'false',
    }),
    makeFinding('mcp-alwaysload-hygiene', {
      kind: 'defer-alwaysload', servers: [{ server: 'pinned', paths: [mcpJson] }],
    }),
    makeFinding('mcp-defer-threshold', {
      kind: 'defer-threshold', settingPath: localSettings, settingScope: 'user local settings',
      value: 'auto', recommendedPercent: 2, removeOverride: false,
    }),
  ]
  return { fx, findings, settings, mcpJson }
}

function applyOpts(fx: Fixture, io: ReturnType<typeof makeIo>, extra: Partial<ApplyOptions> & { findings: WasteFinding[] }): ApplyOptions {
  return {
    ctx: ctx(fx),
    actionsDir: fx.actionsDir,
    input: io.input,
    output: io.output,
    errorOutput: io.errorOutput,
    ...extra,
  }
}

describe('runOptimizeApply with deferral plans', () => {
  it('dry run lists the exact file paths and notes and changes nothing on disk', async () => {
    const { fx, findings, settings, mcpJson } = await deferFamilyFixture()
    const before = await hashTree(fx.root)
    const io = makeIo()
    await runOptimizeApply([], undefined, applyOpts(fx, io, { findings, dryRun: true }))

    const out = io.stdout()
    // The fixture home is outside the real ~, so paths print unabbreviated.
    expect(out).toContain(settings)
    expect(out).toContain(join(fx.home, '.claude', 'settings.local.json'))
    expect(out).toContain(mcpJson)
    expect(out).toContain('takes effect on the next session')
    expect(out).toContain('Dry run: nothing was changed.')
    expect(await hashTree(fx.root)).toBe(before)
    expect(await readRecords(fx.actionsDir)).toHaveLength(0)
    // Paths asserted against the raw fixture so nothing drifted.
    expect(existsSync(settings) && existsSync(mcpJson)).toBe(true)
  })

  it('--yes applies all three kinds and journals one record each', async () => {
    const { fx, findings, settings, mcpJson } = await deferFamilyFixture()
    const io = makeIo()
    await runOptimizeApply([], undefined, applyOpts(fx, io, { findings, yes: true }))

    const records = await readRecords(fx.actionsDir)
    expect(records.map(r => r.kind).sort()).toEqual(['defer-alwaysload', 'defer-enable', 'defer-threshold'])
    expect(records.map(r => r.findingId).sort()).toEqual(['mcp-alwaysload-hygiene', 'mcp-defer-threshold', 'mcp-deferral-off'])

    expect(JSON.parse(await readFile(settings, 'utf-8'))).toEqual({ env: {} })
    expect(JSON.parse(await readFile(mcpJson, 'utf-8'))).toEqual({ mcpServers: { pinned: { command: 'x' } } })
    expect(JSON.parse(await readFile(join(fx.home, '.claude', 'settings.local.json'), 'utf-8'))).toEqual({ env: { ENABLE_TOOL_SEARCH: 'auto:2' } })

    // Undo everything, newest first, and verify the tree round-trips.
    for (const rec of [...records].reverse()) {
      await undoAction({ id: rec.id }, { actionsDir: fx.actionsDir })
    }
    expect(JSON.parse(await readFile(settings, 'utf-8'))).toEqual({ env: { ENABLE_TOOL_SEARCH: 'false' } })
    expect(JSON.parse(await readFile(mcpJson, 'utf-8'))).toEqual({ mcpServers: { pinned: { command: 'x', alwaysLoad: true } } })
  })

  it('refusal causes render as manual findings with their instruction notes', async () => {
    const fx = await makeFixture()
    const findings = [
      makeFinding('mcp-deferral-off', {
        kind: 'defer-enable', cause: 'proxy-unknown', settingPath: join(fx.home, '.claude', 'settings.json'), settingScope: 'user settings', value: 'https://proxy.example',
      }),
    ]
    const io = makeIo()
    await runOptimizeApply([], undefined, applyOpts(fx, io, { findings, dryRun: true }))

    const out = io.stdout()
    expect(out).toContain('No appliable config-class fixes')
    expect(out).toContain('tool_reference')
    expect(await readRecords(fx.actionsDir)).toHaveLength(0)
  })

  it('stale-plan guard: an edit after planning is refused, leaving the file as-is', async () => {
    const fx = await makeFixture()
    const settings = join(fx.home, '.claude', 'settings.json')
    await mkdir(join(fx.home, '.claude'), { recursive: true })
    await writeFile(settings, stringify({ env: { ENABLE_TOOL_SEARCH: 'false' } }))
    const plan = planFor(makeFinding('mcp-deferral-off', {
      kind: 'defer-enable', cause: 'env-false', settingPath: settings, settingScope: 'user settings', value: 'false',
    }), ctx(fx))
    expect(plan).not.toBeNull()

    const interim = stringify({ env: { ENABLE_TOOL_SEARCH: 'false', ADDED: '1' } })
    await writeFile(settings, interim)

    await expect(runAction(plan!, fx.actionsDir)).rejects.toThrow(/changed since the plan was built/)
    expect(await readFile(settings, 'utf-8')).toBe(interim)
    expect(await readRecords(fx.actionsDir)).toHaveLength(0)
  })
})

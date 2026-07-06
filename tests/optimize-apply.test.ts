import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { PassThrough, Writable } from 'node:stream'

import { planFor, planFindings, type PlanContext } from '../src/act/plans.js'
import { renderApplyList, runOptimizeApply, type ApplyOptions } from '../src/act/optimize-apply.js'
import { runAction } from '../src/act/apply.js'
import { undoAction } from '../src/act/undo.js'
import { readRecords, shortId } from '../src/act/journal.js'
import {
  detectBloatedClaudeMd,
  detectDuplicateReads,
  detectJunkReads,
  detectLowReadEditRatio,
  detectMcpToolCoverage,
} from '../src/optimize.js'
import type {
  FindingApply,
  FindingId,
  McpServerCoverage,
  ToolCall,
  WasteAction,
  WasteFinding,
} from '../src/optimize.js'

const roots: string[] = []

type Fixture = { root: string; home: string; project: string; actionsDir: string }

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'codeburn-optimize-apply-'))
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

function makeFinding(id: FindingId, fix: WasteAction, apply?: FindingApply): WasteFinding {
  return { id, title: id, explanation: '', impact: 'medium', tokensSaved: 1000, fix, ...(apply ? { apply } : {}) }
}

const CMD_FIX: WasteAction = { type: 'command', label: '', text: '' }

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

describe('mcp-remove plan', () => {
  it('deletes exactly the named server, leaves other keys untouched, and undo restores byte-identical', async () => {
    const fx = await makeFixture()
    const claudeJson = join(fx.home, '.claude.json')
    const original = JSON.stringify({
      mcpServers: { alpha: { command: 'a' }, beta: { command: 'b', args: ['x'] } },
      numFoo: 3,
      nested: { keep: true },
    }, null, 2) + '\n'
    await writeFile(claudeJson, original)
    await writeFile(join(fx.project, '.mcp.json'), JSON.stringify({ mcpServers: { gamma: {} } }, null, 2) + '\n')

    const finding = makeFinding('mcp-low-coverage', CMD_FIX, { kind: 'mcp-remove', servers: ['beta'] })
    const plan = planFor(finding, { homeDir: fx.home, cwd: fx.project })
    expect(plan).not.toBeNull()
    expect(plan!.changes).toHaveLength(1)
    expect(plan!.changes[0]!.path).toBe(claudeJson)

    const rec = await runAction(plan!, fx.actionsDir)

    const after = JSON.parse(await readFile(claudeJson, 'utf-8'))
    expect(after.mcpServers).toEqual({ alpha: { command: 'a' } })
    expect(after.numFoo).toBe(3)
    expect(after.nested).toEqual({ keep: true })
    // Untouched sibling config file.
    expect(JSON.parse(await readFile(join(fx.project, '.mcp.json'), 'utf-8')).mcpServers).toEqual({ gamma: {} })
    // 2-space indent + trailing newline contract.
    expect(await readFile(claudeJson, 'utf-8')).toBe(JSON.stringify(after, null, 2) + '\n')

    await undoAction({ id: rec.id }, { actionsDir: fx.actionsDir })
    expect(await readFile(claudeJson, 'utf-8')).toBe(original)
  })
})

describe('mcp-project-scope plan', () => {
  it('moves the entry from the global config into the keeper project .mcp.json, creating it when missing', async () => {
    const fx = await makeFixture()
    const claudeJson = join(fx.home, '.claude.json')
    const serverValue = { command: 'srv', args: ['--flag'], env: { A: '1' } }
    const original = JSON.stringify({ mcpServers: { srv: serverValue }, other: 1 }, null, 2) + '\n'
    await writeFile(claudeJson, original)

    const keeper = join(fx.root, 'keeper')
    await mkdir(keeper, { recursive: true })
    const keeperMcp = join(keeper, '.mcp.json')
    expect(existsSync(keeperMcp)).toBe(false)

    const finding = makeFinding('mcp-project-scope', { type: 'paste', destination: 'prompt', label: '', text: '' }, {
      kind: 'mcp-project-scope',
      servers: [{ server: 'srv', keepProjects: [keeper], removeProjects: [] }],
    })
    const plan = planFor(finding, { homeDir: fx.home, cwd: fx.project })
    expect(plan).not.toBeNull()

    const rec = await runAction(plan!, fx.actionsDir)

    expect(JSON.parse(await readFile(claudeJson, 'utf-8')).mcpServers).toEqual({})
    expect(existsSync(keeperMcp)).toBe(true)
    expect(JSON.parse(await readFile(keeperMcp, 'utf-8')).mcpServers).toEqual({ srv: serverValue })

    await undoAction({ id: rec.id }, { actionsDir: fx.actionsDir })
    expect(await readFile(claudeJson, 'utf-8')).toBe(original)
    expect(existsSync(keeperMcp)).toBe(false)
  })
})

describe('unparseable config file', () => {
  it('reports the parse error, skips that server, and still applies the servers it can read', async () => {
    const fx = await makeFixture()
    const claudeJson = join(fx.home, '.claude.json')
    await writeFile(claudeJson, JSON.stringify({ mcpServers: { good: { command: 'g' } } }, null, 2) + '\n')
    const brokenMcp = join(fx.project, '.mcp.json')
    await writeFile(brokenMcp, '{ this is not valid json,,, ')

    const finding = makeFinding('mcp-low-coverage', CMD_FIX, { kind: 'mcp-remove', servers: ['good', 'bad'] })
    const { plan, notes } = planFindings([finding], { homeDir: fx.home, cwd: fx.project })[0]!

    expect(notes.some(n => /could not parse/.test(n) && n.includes('.mcp.json'))).toBe(true)
    expect(notes.some(n => n.includes('bad'))).toBe(true)
    expect(plan).not.toBeNull()
    expect(plan!.changes.map(c => c.path)).toEqual([claudeJson])

    await runAction(plan!, fx.actionsDir)
    expect(JSON.parse(await readFile(claudeJson, 'utf-8')).mcpServers).toEqual({})
    // The broken file is left exactly as-is.
    expect(await readFile(brokenMcp, 'utf-8')).toBe('{ this is not valid json,,, ')
  })
})

describe('archive plan', () => {
  it('archives a skill dir and an agent file, round-trips undo, and suffixes a colliding name with -2', async () => {
    const fx = await makeFixture()
    const skillsDir = join(fx.home, '.claude', 'skills')
    const agentsDir = join(fx.home, '.claude', 'agents')
    await mkdir(join(skillsDir, 'foo'), { recursive: true })
    await writeFile(join(skillsDir, 'foo', 'SKILL.md'), 'skill body')
    // Pre-existing archive with the same name forces the -2 suffix.
    await mkdir(join(skillsDir, '.archived', 'foo'), { recursive: true })
    await writeFile(join(skillsDir, '.archived', 'foo', 'SKILL.md'), 'old archived')
    await mkdir(agentsDir, { recursive: true })
    await writeFile(join(agentsDir, 'bar.md'), 'agent body')

    const skillFinding = makeFinding('unused-skills', CMD_FIX, { kind: 'archive', names: ['foo'] })
    const skillPlan = planFor(skillFinding, { homeDir: fx.home, cwd: fx.project })
    expect(skillPlan!.changes[0]).toMatchObject({
      op: 'move',
      path: join(skillsDir, 'foo'),
      movedTo: join(skillsDir, '.archived', 'foo-2'),
    })
    const skillRec = await runAction(skillPlan!, fx.actionsDir)
    expect(existsSync(join(skillsDir, 'foo'))).toBe(false)
    expect(await readFile(join(skillsDir, '.archived', 'foo-2', 'SKILL.md'), 'utf-8')).toBe('skill body')
    // The pre-existing archive is preserved.
    expect(await readFile(join(skillsDir, '.archived', 'foo', 'SKILL.md'), 'utf-8')).toBe('old archived')

    const agentFinding = makeFinding('unused-agents', CMD_FIX, { kind: 'archive', names: ['bar'] })
    const agentPlan = planFor(agentFinding, { homeDir: fx.home, cwd: fx.project })
    expect(agentPlan!.changes[0]).toMatchObject({
      op: 'move',
      path: join(agentsDir, 'bar.md'),
      movedTo: join(agentsDir, '.archived', 'bar.md'),
    })
    const agentRec = await runAction(agentPlan!, fx.actionsDir)
    expect(existsSync(join(agentsDir, 'bar.md'))).toBe(false)

    await undoAction({ id: agentRec.id }, { actionsDir: fx.actionsDir })
    await undoAction({ id: skillRec.id }, { actionsDir: fx.actionsDir })
    expect(await readFile(join(agentsDir, 'bar.md'), 'utf-8')).toBe('agent body')
    expect(await readFile(join(skillsDir, 'foo', 'SKILL.md'), 'utf-8')).toBe('skill body')
    expect(existsSync(join(skillsDir, '.archived', 'foo-2'))).toBe(false)
  })
})

describe('claude-md rule plan', () => {
  it('appends a fresh marker block, replaces it in place on re-apply, and undo removes it', async () => {
    const fx = await makeFixture()
    const claudeMd = join(fx.project, 'CLAUDE.md')
    const original = '# Project\n\nExisting rules.\n'
    await writeFile(claudeMd, original)

    const first = makeFinding('read-edit-ratio', { type: 'paste', destination: 'claude-md', label: '', text: 'Read before editing.' })
    const firstPlan = planFor(first, { homeDir: fx.home, cwd: fx.project })
    const firstRec = await runAction(firstPlan!, fx.actionsDir)

    let body = await readFile(claudeMd, 'utf-8')
    expect(body).toContain('# Project')
    expect(body).toContain('<!-- codeburn:begin read-edit-ratio -->')
    expect(body).toContain('Read before editing.')
    expect(body).toContain('<!-- codeburn:end read-edit-ratio -->')

    // Second apply with the same id replaces the block instead of duplicating.
    const second = makeFinding('read-edit-ratio', { type: 'paste', destination: 'claude-md', label: '', text: 'Read first, then edit.' })
    const secondPlan = planFor(second, { homeDir: fx.home, cwd: fx.project })
    const secondRec = await runAction(secondPlan!, fx.actionsDir)

    body = await readFile(claudeMd, 'utf-8')
    expect(body.match(/codeburn:begin read-edit-ratio/g)).toHaveLength(1)
    expect(body).toContain('Read first, then edit.')
    expect(body).not.toContain('Read before editing.')

    await undoAction({ id: secondRec.id }, { actionsDir: fx.actionsDir })
    await undoAction({ id: firstRec.id }, { actionsDir: fx.actionsDir })
    expect(await readFile(claudeMd, 'utf-8')).toBe(original)
  })
})

describe('shell-config plan', () => {
  it('writes the bash cap inside # markers to the rc chosen from $SHELL', async () => {
    const fx = await makeFixture()
    const finding = makeFinding('bash-output-cap', { type: 'paste', destination: 'shell-config', label: '', text: 'export BASH_MAX_OUTPUT_LENGTH=15000' })
    const plan = planFor(finding, { homeDir: fx.home, cwd: fx.project, shell: '/bin/zsh' })
    expect(plan!.changes[0]!.path).toBe(join(fx.home, '.zshrc'))

    await runAction(plan!, fx.actionsDir)
    const body = await readFile(join(fx.home, '.zshrc'), 'utf-8')
    expect(body).toBe('# codeburn:begin bash-output-cap\nexport BASH_MAX_OUTPUT_LENGTH=15000\n# codeburn:end bash-output-cap\n')
  })
})

describe('dry-run', () => {
  it('leaves the fixture tree byte-identical when only planning', async () => {
    const fx = await makeFixture()
    await writeFile(join(fx.home, '.claude.json'), JSON.stringify({ mcpServers: { s: { command: 'c' } } }, null, 2) + '\n')
    await mkdir(join(fx.home, '.claude', 'skills', 'ghost'), { recursive: true })
    await writeFile(join(fx.home, '.claude', 'skills', 'ghost', 'SKILL.md'), 'x')
    await writeFile(join(fx.project, 'CLAUDE.md'), '# rules\n')

    const findings: WasteFinding[] = [
      makeFinding('mcp-low-coverage', CMD_FIX, { kind: 'mcp-remove', servers: ['s'] }),
      makeFinding('unused-skills', CMD_FIX, { kind: 'archive', names: ['ghost'] }),
      makeFinding('read-edit-ratio', { type: 'paste', destination: 'claude-md', label: '', text: 'rule' }),
      makeFinding('bash-output-cap', { type: 'paste', destination: 'shell-config', label: '', text: 'export BASH_MAX_OUTPUT_LENGTH=15000' }),
    ]

    const before = await hashTree(fx.root)
    const plans = planFindings(findings, { homeDir: fx.home, cwd: fx.project, shell: '/bin/zsh' })
    // Exercise the exact rendering the dry-run path prints.
    renderApplyList(plans.filter(p => p.plan !== null), plans.filter(p => p.plan === null), 0.000002)
    const after = await hashTree(fx.root)

    expect(plans.every(p => p.plan !== null)).toBe(true)
    expect(after).toBe(before)
  })
})

describe('finding-id regression guard', () => {
  const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/
  const KNOWN: ReadonlySet<FindingId> = new Set<FindingId>([
    'read-edit-ratio', 'build-folder-reads', 'redundant-rereads', 'warmup-heavy',
    'unused-mcp', 'mcp-low-coverage', 'mcp-project-scope', 'retry-heavy-capabilities',
    'low-worth-sessions', 'context-heavy-sessions', 'cost-outliers', 'claude-md-too-long',
    'bash-output-cap', 'unused-agents', 'unused-skills', 'unused-commands',
  ])

  it('every finding produced by a detector run carries a stable, known, non-empty id', async () => {
    const fx = await makeFixture()
    const bigClaudeMd = '# Rules\n' + Array.from({ length: 260 }, (_, i) => `- rule ${i}`).join('\n') + '\n'
    await writeFile(join(fx.project, 'CLAUDE.md'), bigClaudeMd)

    function read(file: string, session = 's1'): ToolCall {
      return { name: 'Read', input: { file_path: file }, sessionId: session, project: 'p' }
    }
    const calls: ToolCall[] = [
      read('/p/node_modules/a.js'), read('/p/node_modules/b.js'), read('/p/dist/c.js'),
      ...Array.from({ length: 6 }, () => read('/p/src/app.ts')),
      ...Array.from({ length: 10 }, (): ToolCall => ({ name: 'Edit', input: {}, sessionId: 's1', project: 'p' })),
    ]
    const coverage: McpServerCoverage[] = [{
      server: 'x', toolsAvailable: 20, toolsInvoked: 1,
      unusedTools: Array.from({ length: 19 }, (_, i) => `mcp__x__t${i}`),
      invocations: 1, loadedSessions: 3, coverageRatio: 0.05,
    }]

    const findings = [
      detectLowReadEditRatio(calls),
      detectJunkReads(calls),
      detectDuplicateReads(calls),
      detectBloatedClaudeMd(new Set([fx.project])),
      detectMcpToolCoverage([], coverage),
    ].filter((f): f is WasteFinding => f !== null)

    expect(findings.length).toBeGreaterThanOrEqual(5)
    for (const f of findings) {
      expect(f.id).toBeTruthy()
      expect(f.id).toMatch(KEBAB)
      expect(KNOWN.has(f.id)).toBe(true)
    }
    const ids = findings.map(f => f.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('unused-mcp plan', () => {
  it('builds a remove-everywhere plan, including other projects[*] entries', async () => {
    const fx = await makeFixture()
    const claudeJson = join(fx.home, '.claude.json')
    await writeFile(claudeJson, JSON.stringify({
      mcpServers: { u: { command: 'u' } },
      projects: { '/some/other': { mcpServers: { u: { command: 'u' }, keepme: {} } } },
    }, null, 2) + '\n')

    const finding = makeFinding('unused-mcp', CMD_FIX, { kind: 'mcp-remove', servers: ['u'] })
    const plan = planFor(finding, { homeDir: fx.home, cwd: fx.project })
    expect(plan).not.toBeNull()
    expect(plan!.kind).toBe('mcp-remove')

    await runAction(plan!, fx.actionsDir)
    const after = JSON.parse(await readFile(claudeJson, 'utf-8'))
    expect(after.mcpServers).toEqual({})
    expect(after.projects['/some/other'].mcpServers).toEqual({ keepme: {} })
  })
})

describe('BOM handling', () => {
  it('parses a config file with a UTF-8 BOM', async () => {
    const fx = await makeFixture()
    const claudeJson = join(fx.home, '.claude.json')
    await writeFile(claudeJson, '﻿' + JSON.stringify({ mcpServers: { b: {} }, keep: 1 }, null, 2) + '\n')

    const { plan, notes } = planFindings(
      [makeFinding('mcp-low-coverage', CMD_FIX, { kind: 'mcp-remove', servers: ['b'] })],
      { homeDir: fx.home, cwd: fx.project },
    )[0]!
    expect(notes).toEqual([])
    expect(plan).not.toBeNull()
    const written = JSON.parse(String(plan!.changes[0]!.content))
    expect(written).toEqual({ mcpServers: {}, keep: 1 })
  })
})

// ---------------------------------------------------------------------------
// runOptimizeApply end-to-end (injected stdio, crafted findings, fixture home)
// ---------------------------------------------------------------------------

const ANSI = /\[[0-9;]*m/g

type Io = {
  input: PassThrough
  output: Writable
  errorOutput: Writable
  stdout(): string
  stderr(): string
}

function makeIo(answer?: string): Io {
  const input = new PassThrough()
  input.end(answer ?? '')
  const outChunks: Buffer[] = []
  const errChunks: Buffer[] = []
  const output = new Writable({ write(c, _e, cb) { outChunks.push(Buffer.from(c)); cb() } })
  const errorOutput = new Writable({ write(c, _e, cb) { errChunks.push(Buffer.from(c)); cb() } })
  return {
    input,
    output,
    errorOutput,
    stdout: () => Buffer.concat(outChunks).toString('utf-8').replace(ANSI, ''),
    stderr: () => Buffer.concat(errChunks).toString('utf-8').replace(ANSI, ''),
  }
}

function applyOpts(fx: Fixture, io: Io, extra: Partial<ApplyOptions> & { findings: WasteFinding[] }): ApplyOptions {
  const ctx: PlanContext = { homeDir: fx.home, cwd: fx.project, shell: '/bin/zsh' }
  return {
    ctx,
    actionsDir: fx.actionsDir,
    input: io.input,
    output: io.output,
    errorOutput: io.errorOutput,
    ...extra,
  }
}

// One mcp server, one skill, one shell cap: three appliable findings in a
// stable 1/2/3 order for the picker tests.
async function threeFindingFixture(): Promise<{ fx: Fixture; findings: WasteFinding[] }> {
  const fx = await makeFixture()
  await writeFile(join(fx.home, '.claude.json'), JSON.stringify({ mcpServers: { a: { command: 'a' } } }, null, 2) + '\n')
  await mkdir(join(fx.home, '.claude', 'skills', 'foo'), { recursive: true })
  await writeFile(join(fx.home, '.claude', 'skills', 'foo', 'SKILL.md'), 'x')
  const findings: WasteFinding[] = [
    makeFinding('mcp-low-coverage', CMD_FIX, { kind: 'mcp-remove', servers: ['a'] }),
    makeFinding('unused-skills', CMD_FIX, { kind: 'archive', names: ['foo'] }),
    makeFinding('bash-output-cap', { type: 'paste', destination: 'shell-config', label: '', text: 'export BASH_MAX_OUTPUT_LENGTH=15000' }),
  ]
  return { fx, findings }
}

describe('runOptimizeApply end-to-end', () => {
  it('--yes applies every plan and prints journal short ids with the undo hint', async () => {
    const { fx, findings } = await threeFindingFixture()
    const io = makeIo()
    await runOptimizeApply([], undefined, applyOpts(fx, io, { findings, yes: true }))

    const records = await readRecords(fx.actionsDir)
    expect(records).toHaveLength(3)
    const out = io.stdout()
    for (const rec of records) {
      expect(out).toContain(`Applied ${shortId(rec.id)}`)
      expect(out).toContain(`Undo anytime: codeburn act undo ${shortId(rec.id)}`)
    }
    expect(JSON.parse(await readFile(join(fx.home, '.claude.json'), 'utf-8')).mcpServers).toEqual({})
    expect(existsSync(join(fx.home, '.claude', 'skills', '.archived', 'foo'))).toBe(true)
    expect(existsSync(join(fx.home, '.zshrc'))).toBe(true)
  })

  it('interactive pick "2" applies only the second plan', async () => {
    const { fx, findings } = await threeFindingFixture()
    const io = makeIo('2\n')
    await runOptimizeApply([], undefined, applyOpts(fx, io, { findings }))

    const records = await readRecords(fx.actionsDir)
    expect(records).toHaveLength(1)
    expect(records[0]!.kind).toBe('archive-skill')
    expect(JSON.parse(await readFile(join(fx.home, '.claude.json'), 'utf-8')).mcpServers).toEqual({ a: { command: 'a' } })
    expect(existsSync(join(fx.home, '.zshrc'))).toBe(false)
  })

  it('interactive pick "1,3" applies the first and third plans', async () => {
    const { fx, findings } = await threeFindingFixture()
    const io = makeIo('1,3\n')
    await runOptimizeApply([], undefined, applyOpts(fx, io, { findings }))

    const records = await readRecords(fx.actionsDir)
    expect(records.map(r => r.kind).sort()).toEqual(['mcp-remove', 'shell-config'])
    expect(existsSync(join(fx.home, '.claude', 'skills', 'foo'))).toBe(true)
  })

  it('a garbage answer applies nothing and prints the empty outcome', async () => {
    const { fx, findings } = await threeFindingFixture()
    const io = makeIo('wat\n')
    await runOptimizeApply([], undefined, applyOpts(fx, io, { findings }))

    expect(await readRecords(fx.actionsDir)).toHaveLength(0)
    expect(io.stdout()).toContain('Nothing applied.')
  })

  it('EOF at the prompt prints "Nothing applied." and leaves the exit code untouched', async () => {
    const { fx, findings } = await threeFindingFixture()
    const io = makeIo()
    const prevExit = process.exitCode
    await runOptimizeApply([], undefined, applyOpts(fx, io, { findings }))

    expect(process.exitCode).toBe(prevExit)
    expect(io.stdout()).toContain('Nothing applied.')
    expect(await readRecords(fx.actionsDir)).toHaveLength(0)
  })

  it('--only restricts the applied set', async () => {
    const { fx, findings } = await threeFindingFixture()
    const io = makeIo()
    await runOptimizeApply([], undefined, applyOpts(fx, io, { findings, yes: true, only: 'unused-skills' }))

    const records = await readRecords(fx.actionsDir)
    expect(records).toHaveLength(1)
    expect(records[0]!.kind).toBe('archive-skill')
    expect(JSON.parse(await readFile(join(fx.home, '.claude.json'), 'utf-8')).mcpServers).toEqual({ a: { command: 'a' } })
  })

  it('--only with an unknown or not-appliable id errors with the valid ids and exit code 2', async () => {
    const { fx, findings } = await threeFindingFixture()
    const io = makeIo()
    const prevExit = process.exitCode
    try {
      await runOptimizeApply([], undefined, applyOpts(fx, io, { findings, yes: true, only: 'read-edit-ratio' }))

      expect(process.exitCode).toBe(2)
      const err = io.stderr()
      expect(err).toContain('read-edit-ratio')
      expect(err).toContain('Appliable ids for this run:')
      expect(err).toContain('mcp-low-coverage')
      expect(await readRecords(fx.actionsDir)).toHaveLength(0)
      expect(io.stdout()).not.toContain('No appliable config-class fixes')
    } finally {
      process.exitCode = prevExit
    }
  })

  it('--yes skips claude-md plans with a reason unless explicitly selected via --only', async () => {
    const { fx, findings } = await threeFindingFixture()
    const claudeMdFinding = makeFinding('read-edit-ratio', { type: 'paste', destination: 'claude-md', label: '', text: 'Read first.' })
    const io = makeIo()
    await runOptimizeApply([], undefined, applyOpts(fx, io, { findings: [claudeMdFinding, ...findings], yes: true }))

    expect(io.stdout()).toContain('Skipped read-edit-ratio: CLAUDE.md edits are not applied with --yes')
    expect(existsSync(join(fx.project, 'CLAUDE.md'))).toBe(false)
    expect((await readRecords(fx.actionsDir)).map(r => r.kind)).not.toContain('claude-md-rule')

    const fx2 = await makeFixture()
    const io2 = makeIo()
    await runOptimizeApply([], undefined, applyOpts(fx2, io2, { findings: [claudeMdFinding], yes: true, only: 'read-edit-ratio' }))

    expect((await readRecords(fx2.actionsDir)).map(r => r.kind)).toEqual(['claude-md-rule'])
    expect(await readFile(join(fx2.project, 'CLAUDE.md'), 'utf-8')).toContain('<!-- codeburn:begin read-edit-ratio -->')
  })

  it('project-scope leaves unrelated projects[*] entries untouched and previews the cold removals', async () => {
    const fx = await makeFixture()
    const claudeJson = join(fx.home, '.claude.json')
    const serverValue = { command: 'srv' }
    await writeFile(claudeJson, JSON.stringify({
      mcpServers: { srv: serverValue },
      projects: {
        '/cold/one': { mcpServers: { srv: serverValue } },
        '/unrelated/proj': { mcpServers: { srv: serverValue, keepme: {} } },
      },
    }, null, 2) + '\n')
    const keeper = join(fx.root, 'keeper')
    await mkdir(keeper, { recursive: true })

    const finding = makeFinding('mcp-project-scope', CMD_FIX, {
      kind: 'mcp-project-scope',
      servers: [{ server: 'srv', keepProjects: [keeper], removeProjects: ['/cold/one'] }],
    })
    const io = makeIo()
    await runOptimizeApply([], undefined, applyOpts(fx, io, { findings: [finding], yes: true }))

    expect(io.stdout()).toContain('(removes srv from 1 project entry: /cold/one)')

    const after = JSON.parse(await readFile(claudeJson, 'utf-8'))
    expect(after.mcpServers).toEqual({})
    expect(after.projects['/cold/one'].mcpServers).toEqual({})
    expect(after.projects['/unrelated/proj'].mcpServers).toEqual({ srv: serverValue, keepme: {} })
    expect(JSON.parse(await readFile(join(keeper, '.mcp.json'), 'utf-8')).mcpServers).toEqual({ srv: serverValue })
  })

  it('surfaces parse-error notes when every plan resolves to null', async () => {
    const fx = await makeFixture()
    await writeFile(join(fx.home, '.claude.json'), 'not json{{{')
    const finding = makeFinding('mcp-low-coverage', CMD_FIX, { kind: 'mcp-remove', servers: ['ghost'] })
    const io = makeIo()
    await runOptimizeApply([], undefined, applyOpts(fx, io, { findings: [finding], yes: true }))

    const out = io.stdout()
    expect(out).toContain('No appliable config-class fixes')
    expect(out).toContain('could not parse')
    expect(out).toContain('.claude.json')
    expect(await readRecords(fx.actionsDir)).toHaveLength(0)
  })

  it('renders notes under manual findings alongside appliable ones', async () => {
    const fx = await makeFixture()
    await writeFile(join(fx.home, '.claude.json'), 'not json{{{')
    await mkdir(join(fx.home, '.claude', 'skills', 'foo'), { recursive: true })
    await writeFile(join(fx.home, '.claude', 'skills', 'foo', 'SKILL.md'), 'x')
    const findings: WasteFinding[] = [
      makeFinding('mcp-low-coverage', CMD_FIX, { kind: 'mcp-remove', servers: ['ghost'] }),
      makeFinding('unused-skills', CMD_FIX, { kind: 'archive', names: ['foo'] }),
    ]
    const io = makeIo()
    await runOptimizeApply([], undefined, applyOpts(fx, io, { findings, dryRun: true }))

    const out = io.stdout()
    expect(out).toContain('[mcp-low-coverage]  manual')
    expect(out).toContain('could not parse')
  })
})

describe('stale-plan detection', () => {
  it('rejects when the target changed after the plan was built, leaving nothing behind', async () => {
    const fx = await makeFixture()
    const claudeJson = join(fx.home, '.claude.json')
    await writeFile(claudeJson, JSON.stringify({ mcpServers: { s: {} } }, null, 2) + '\n')
    const plan = planFor(
      makeFinding('mcp-low-coverage', CMD_FIX, { kind: 'mcp-remove', servers: ['s'] }),
      { homeDir: fx.home, cwd: fx.project },
    )
    expect(plan).not.toBeNull()

    const interim = JSON.stringify({ mcpServers: { s: {}, addedMeanwhile: {} } }, null, 2) + '\n'
    await writeFile(claudeJson, interim)

    await expect(runAction(plan!, fx.actionsDir)).rejects.toThrow(/changed since the plan was built; re-run codeburn optimize --apply/)
    expect(await readFile(claudeJson, 'utf-8')).toBe(interim)
    expect(await readRecords(fx.actionsDir)).toHaveLength(0)
    const backups = await readdir(join(fx.actionsDir, 'backups')).catch(() => [])
    expect(backups).toEqual([])
  })

  it('rejects a plan expecting an absent file when the file appeared', async () => {
    const fx = await makeFixture()
    const claudeMd = join(fx.project, 'CLAUDE.md')
    const plan = planFor(
      makeFinding('read-edit-ratio', { type: 'paste', destination: 'claude-md', label: '', text: 'rule' }),
      { homeDir: fx.home, cwd: fx.project },
    )
    expect(plan!.changes[0]).toMatchObject({ op: 'create', expectedHash: null })

    await writeFile(claudeMd, '# appeared meanwhile\n')

    await expect(runAction(plan!, fx.actionsDir)).rejects.toThrow(/changed since the plan was built/)
    expect(await readFile(claudeMd, 'utf-8')).toBe('# appeared meanwhile\n')
    expect(await readRecords(fx.actionsDir)).toHaveLength(0)
  })

  it('applies when the target still matches the expected hash', async () => {
    const fx = await makeFixture()
    const claudeJson = join(fx.home, '.claude.json')
    await writeFile(claudeJson, JSON.stringify({ mcpServers: { s: {} } }, null, 2) + '\n')
    const plan = planFor(
      makeFinding('mcp-low-coverage', CMD_FIX, { kind: 'mcp-remove', servers: ['s'] }),
      { homeDir: fx.home, cwd: fx.project },
    )
    expect(plan!.changes[0]!.op === 'move' ? undefined : plan!.changes[0]!.expectedHash).toMatch(/^[0-9a-f]{64}$/)

    const rec = await runAction(plan!, fx.actionsDir)
    expect(rec.status).toBe('applied')
    expect(JSON.parse(await readFile(claudeJson, 'utf-8')).mcpServers).toEqual({})
  })

  it('a change without expectedHash skips validation (framework back-compat)', async () => {
    const fx = await makeFixture()
    const p = join(fx.home, 'free.txt')
    await writeFile(p, 'anything at all')

    const rec = await runAction({
      kind: 'claude-md-rule',
      description: 'no expected hash',
      changes: [{ op: 'edit', path: p, content: 'overwritten' }],
    }, fx.actionsDir)
    expect(rec.status).toBe('applied')
    expect(await readFile(p, 'utf-8')).toBe('overwritten')
  })
})

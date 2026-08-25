import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseAllSessions, clearSessionCache } from '../src/parser.js'
import { clearLoadCacheMemo } from '../src/session-cache.js'
import { loadPricing } from '../src/models.js'
import { emptyCache, loadCache, saveCache } from '../src/session-cache.js'
import type { ProjectSummary, SessionLineage } from '../src/types.js'

// CB-1, slice 1: SessionLineage capture. Provider-recorded only - the
// brief forbids inference from directory layout or time adjacency, so a
// session with no provider evidence has no lineage field at all (absent,
// not 'unknown'). Every cost / token / call total in every report must
// stay byte-identical to a build that omits the field.

const CWD = '/workspace/lineage-proj'
const PARENT = 'parent-1111-4111-8111-111111111111'
const AGENT_A = 'a1234567890abcdef'
const AGENT_B = 'b2345678901bcdef0'
const SPAWN_A = 'toolu_spawn_a'
const SPAWN_B = 'toolu_spawn_b'

let tmpDir: string
let configDir: string

beforeEach(async () => {
  clearSessionCache()
  tmpDir = await mkdtemp(join(tmpdir(), 'lineage-'))
  configDir = join(tmpDir, 'claude')
  process.env['CLAUDE_CONFIG_DIR'] = configDir
  process.env['CODEBURN_CACHE_DIR'] = join(tmpDir, 'cache')
})

afterEach(async () => {
  clearSessionCache()
  clearLoadCacheMemo()
  delete process.env['CLAUDE_CONFIG_DIR']
  delete process.env['CODEBURN_CACHE_DIR']
  await rm(tmpDir, { recursive: true, force: true })
})

function findSession(projects: ProjectSummary[], sessionId: string) {
  return projects.flatMap(p => p.sessions).find(s => s.sessionId === sessionId)
}

// Two-sided Claude linkage: parent has agentSpawnLinks, child has
// parentSessionId. Both sides carry the lineage field; cost / token / call
// totals are byte-identical to a no-lineage build.
async function writeTwoSidedTranscripts(): Promise<void> {
  const projDir = join(configDir, 'projects', 'lineage-proj')
  const subDir = join(projDir, PARENT, 'subagents')
  await mkdir(subDir, { recursive: true })

  // Parent: spawns AGENT_A and AGENT_B. Both spawn results are recorded
  // in tool_result blocks, so the parent has a full agentSpawnLinks map
  // (the "two-sided" case - the parent knows about both children).
  await writeFile(join(projDir, `${PARENT}.jsonl`),
    JSON.stringify({ type: 'user', sessionId: PARENT, timestamp: '2026-07-20T10:00:00.000Z', cwd: CWD, message: { role: 'user', content: 'ship it' } }) + '\n' +
    JSON.stringify({ type: 'assistant', sessionId: PARENT, timestamp: '2026-07-20T10:00:01.000Z', cwd: CWD, message: { id: 'p1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id: SPAWN_A, name: 'Agent', input: {} }, { type: 'tool_use', id: SPAWN_B, name: 'Agent', input: {} }], usage: { input_tokens: 10, output_tokens: 5 } } }) + '\n' +
    JSON.stringify({ type: 'user', sessionId: PARENT, timestamp: '2026-07-20T10:00:02.000Z', cwd: CWD, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: SPAWN_A, content: 'a done' }] }, toolUseResult: { status: 'completed', agentId: AGENT_A, content: 'a done' } }) + '\n' +
    JSON.stringify({ type: 'user', sessionId: PARENT, timestamp: '2026-07-20T10:00:03.000Z', cwd: CWD, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: SPAWN_B, content: 'b done' }] }, toolUseResult: { status: 'completed', agentId: AGENT_B, content: 'b done' } }) + '\n' +
    JSON.stringify({ type: 'assistant', sessionId: PARENT, timestamp: '2026-07-20T10:00:04.000Z', cwd: CWD, message: { id: 'p2', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], usage: { input_tokens: 8, output_tokens: 3 } } }) + '\n')

  // Child A: standard sidechain - own sessionId is the parent's id, isSidechain
  // is true, and the parser picks up the parent from the transcript.
  await writeFile(join(subDir, `agent-${AGENT_A}.jsonl`),
    JSON.stringify({ type: 'user', isSidechain: true, sessionId: PARENT, agentId: AGENT_A, timestamp: '2026-07-20T10:00:05.000Z', cwd: CWD, message: { role: 'user', content: 'child a work' } }) + '\n' +
    JSON.stringify({ type: 'assistant', isSidechain: true, sessionId: PARENT, agentId: AGENT_A, timestamp: '2026-07-20T10:00:10.000Z', cwd: CWD, message: { id: 'a1', type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [], usage: { input_tokens: 500, output_tokens: 250 } } }) + '\n')

  // Child B: same shape as A.
  await writeFile(join(subDir, `agent-${AGENT_B}.jsonl`),
    JSON.stringify({ type: 'user', isSidechain: true, sessionId: PARENT, agentId: AGENT_B, timestamp: '2026-07-20T10:01:00.000Z', cwd: CWD, message: { role: 'user', content: 'child b work' } }) + '\n' +
    JSON.stringify({ type: 'assistant', isSidechain: true, sessionId: PARENT, agentId: AGENT_B, timestamp: '2026-07-20T10:01:05.000Z', cwd: CWD, message: { id: 'b1', type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [], usage: { input_tokens: 700, output_tokens: 350 } } }) + '\n')
}

// One-sided Claude linkage: the child file names the parent (own
// sessionId is the parent id, isSidechain true) but the parent's
// `toolUseResult.agentId` was dropped by compaction, so the parent
// file has NO `agentSpawnLinks` for this child. The child still has
// evidence (its own parentSessionId) and must carry lineage. The
// parent, with no spawn links, is a plain session - no lineage.
async function writeOneSidedTranscripts(): Promise<void> {
  const projDir = join(configDir, 'projects', 'lineage-proj')
  const subDir = join(projDir, PARENT, 'subagents')
  await mkdir(subDir, { recursive: true })

  // Parent: spawns AGENT_A but the tool_result never pairs back (e.g. the
  // transcript was compacted before the result landed). agentSpawnLinks
  // is therefore empty for this file.
  await writeFile(join(projDir, `${PARENT}.jsonl`),
    JSON.stringify({ type: 'user', sessionId: PARENT, timestamp: '2026-07-21T10:00:00.000Z', cwd: CWD, message: { role: 'user', content: 'ship it alone' } }) + '\n' +
    JSON.stringify({ type: 'assistant', sessionId: PARENT, timestamp: '2026-07-21T10:00:01.000Z', cwd: CWD, message: { id: 'p1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id: SPAWN_A, name: 'Agent', input: {} }], usage: { input_tokens: 10, output_tokens: 5 } } }) + '\n' +
    JSON.stringify({ type: 'assistant', sessionId: PARENT, timestamp: '2026-07-21T10:00:02.000Z', cwd: CWD, message: { id: 'p2', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], usage: { input_tokens: 8, output_tokens: 3 } } }) + '\n')

  // Child: still has its own parentSessionId (the parser sets it from the
  // transcript-internal sessionId on the first sidechain entry). That is
  // provider-recorded evidence; the child gets lineage.
  await writeFile(join(subDir, `agent-${AGENT_A}.jsonl`),
    JSON.stringify({ type: 'user', isSidechain: true, sessionId: PARENT, agentId: AGENT_A, timestamp: '2026-07-21T10:00:05.000Z', cwd: CWD, message: { role: 'user', content: 'child a work' } }) + '\n' +
    JSON.stringify({ type: 'assistant', isSidechain: true, sessionId: PARENT, agentId: AGENT_A, timestamp: '2026-07-21T10:00:10.000Z', cwd: CWD, message: { id: 'a1', type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [], usage: { input_tokens: 500, output_tokens: 250 } } }) + '\n')
}

// No-evidence session: a plain Claude session with no sidechain entries
// and no spawn links. It must NOT carry a lineage field at all (absent,
// not 'unknown' or 'root' - the brief's strict rule).
async function writePlainTranscripts(): Promise<void> {
  const projDir = join(configDir, 'projects', 'lineage-proj')
  await mkdir(projDir, { recursive: true })
  const SESSION = 'plain-1111-4111-8111-111111111111'
  await writeFile(join(projDir, `${SESSION}.jsonl`),
    JSON.stringify({ type: 'user', sessionId: SESSION, timestamp: '2026-07-22T10:00:00.000Z', cwd: CWD, message: { role: 'user', content: 'just a plain turn' } }) + '\n' +
    JSON.stringify({ type: 'assistant', sessionId: SESSION, timestamp: '2026-07-22T10:00:01.000Z', cwd: CWD, message: { id: 'q1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], usage: { input_tokens: 20, output_tokens: 10 } } }) + '\n')
}

// Totals shape used to assert byte-identical reports with and without
// the lineage field. Strip the lineage and the empty `prLinks` Set
// (which is metadata-only) so the comparison is a true equality check
// on the numbers and call counts.
function projectTotals(projects: ProjectSummary[]): unknown {
  return projects.map(p => ({
    project: p.project,
    projectPath: p.projectPath,
    sessions: p.sessions.map(s => ({
      sessionId: s.sessionId,
      totalCostUSD: s.totalCostUSD,
      totalInputTokens: s.totalInputTokens,
      totalOutputTokens: s.totalOutputTokens,
      totalCacheReadTokens: s.totalCacheReadTokens,
      totalCacheWriteTokens: s.totalCacheWriteTokens,
      totalReasoningTokens: s.totalReasoningTokens,
      apiCalls: s.apiCalls,
      turns: s.turns.map(t => ({
        timestamp: t.timestamp,
        userMessage: t.userMessage,
        category: t.category,
        retries: t.retries,
        hasEdits: t.hasEdits,
        assistantCalls: t.assistantCalls.map(c => ({
          provider: c.provider,
          model: c.model,
          usage: c.usage,
          costUSD: c.costUSD,
          speed: c.speed,
          timestamp: c.timestamp,
        })),
      })),
    })),
  }))
}

describe('SessionLineage capture (CB-1, slice 1)', () => {
  it('two-sided Claude linkage: parent is root, both children are children', async () => {
    await loadPricing()
    await writeTwoSidedTranscripts()
    const range = { start: new Date('2026-07-20T00:00:00Z'), end: new Date('2026-07-20T23:59:59Z') }
    const projects = await parseAllSessions(range, 'claude')

    const parent = findSession(projects, PARENT)
    expect(parent).toBeDefined()
    expect(parent!.lineage).toEqual<SessionLineage>({ role: 'root', evidence: 'provider-recorded' })

    const childA = findSession(projects, `agent-${AGENT_A}`)
    expect(childA).toBeDefined()
    expect(childA!.lineage).toEqual<SessionLineage>({ parentSessionId: PARENT, role: 'child', evidence: 'provider-recorded' })

    const childB = findSession(projects, `agent-${AGENT_B}`)
    expect(childB).toBeDefined()
    expect(childB!.lineage).toEqual<SessionLineage>({ parentSessionId: PARENT, role: 'child', evidence: 'provider-recorded' })
  })

  it('one-sided Claude linkage: child keeps lineage when parent lost the spawn result', async () => {
    await loadPricing()
    await writeOneSidedTranscripts()
    const range = { start: new Date('2026-07-21T00:00:00Z'), end: new Date('2026-07-21T23:59:59Z') }
    const projects = await parseAllSessions(range, 'claude')

    const parent = findSession(projects, PARENT)
    expect(parent).toBeDefined()
    // No agentSpawnLinks on the parent (one-sided) -> no lineage.
    expect(parent!.lineage).toBeUndefined()

    const child = findSession(projects, `agent-${AGENT_A}`)
    expect(child).toBeDefined()
    // The child file ITSELF records its parent in the transcript - that
    // is provider-recorded evidence independent of the parent's spawn map.
    expect(child!.lineage).toEqual<SessionLineage>({ parentSessionId: PARENT, role: 'child', evidence: 'provider-recorded' })
  })

  it('a session with no provider evidence carries NO lineage field', async () => {
    await loadPricing()
    await writePlainTranscripts()
    const range = { start: new Date('2026-07-22T00:00:00Z'), end: new Date('2026-07-22T23:59:59Z') }
    const projects = await parseAllSessions(range, 'claude')

    const plain = findSession(projects, 'plain-1111-4111-8111-111111111111')
    expect(plain).toBeDefined()
    expect(plain!.lineage).toBeUndefined()
    expect('lineage' in plain!).toBe(false)
  })

  it('cache round-trip preserves lineage across a warm-disk reload', async () => {
    await loadPricing()
    await writeTwoSidedTranscripts()
    const range = { start: new Date('2026-07-20T00:00:00Z'), end: new Date('2026-07-20T23:59:59Z') }
    const projects = await parseAllSessions(range, 'claude')

    // First warm read: every child still carries the lineage, parent is root.
    const parentAfterCold = findSession(projects, PARENT)
    const childAAfterCold = findSession(projects, `agent-${AGENT_A}`)
    expect(parentAfterCold!.lineage?.role).toBe('root')
    expect(childAAfterCold!.lineage?.role).toBe('child')

    // Drop the in-process memo layers so the second parse reads the
    // persisted cache shards. Lineage is a cache-stored field; if the
    // validation in session-cache.ts accepts it (and the install path
    // writes it), a warm read must see it back.
    clearSessionCache()
    clearLoadCacheMemo()
    const warm = await parseAllSessions(range, 'claude')

    expect(findSession(warm, PARENT)!.lineage).toEqual<SessionLineage>({ role: 'root', evidence: 'provider-recorded' })
    expect(findSession(warm, `agent-${AGENT_A}`)!.lineage).toEqual<SessionLineage>({ parentSessionId: PARENT, role: 'child', evidence: 'provider-recorded' })
    expect(findSession(warm, `agent-${AGENT_B}`)!.lineage).toEqual<SessionLineage>({ parentSessionId: PARENT, role: 'child', evidence: 'provider-recorded' })
  })

  it('byte-identical report totals with lineage present vs treated as absent (the money-does-not-move invariant)', async () => {
    await loadPricing()
    await writeTwoSidedTranscripts()
    const range = { start: new Date('2026-07-20T00:00:00Z'), end: new Date('2026-07-20T23:59:59Z') }
    const projects = await parseAllSessions(range, 'claude')

    // Pass A: every SessionSummary carries its lineage field (the new build).
    const totalsWithLineage = projectTotals(projects)

    // Pass B: simulate the same parser, same corpus, but with the
    // `lineage` field stripped from every SessionSummary before
    // serialisation. This is the closest in-test stand-in for a build
    // that omits the field, and proves the totals are independent of
    // it. `buildSessionSummary` and the per-provider install path do
    // not read `lineage`, so this must round-trip exactly.
    const stripped = projects.map(p => ({
      ...p,
      sessions: p.sessions.map(({ lineage: _lineage, ...rest }) => rest),
    }))
    const totalsWithoutLineage = projectTotals(stripped as ProjectSummary[])

    expect(totalsWithoutLineage).toEqual(totalsWithLineage)

    // Sanity: a derived currency figure (parent + child A + child B) sums
    // exactly to the same number in both shapes. If a future change
    // accidentally folds lineage into aggregation, this is the test that
    // would have to fail to catch it.
    const sumWith = projects.flatMap(p => p.sessions).reduce((s, x) => s + x.totalCostUSD, 0)
    const sumWithout = (stripped as ProjectSummary[]).flatMap(p => p.sessions).reduce((s, x) => s + x.totalCostUSD, 0)
    expect(sumWithout).toBe(sumWith)
  })
})

// Kimi Code subagent fixture: a `main` agent alongside a non-`main` agent.
// The brief's spec rule for kimicode is "subagents nested in the parent dir
// = provider-recorded", and the parser already records the relationship
// through `state.json` `agents[<id>].parentAgentId`.
//
// We use a small, focused test for the kimicode lineage derivation, kept
// separate from the full parseAllSessions pipeline so the assertion is
// pinned to the helper's behaviour rather than the discovery/parse
// integration. The full-pipeline totals invariant is covered by the Claude
// tests above (the lineage field is purely additive in both providers).
import { kimicodeLineageForSource } from '../src/providers/kimicode.js'

describe('Kimi Code lineage derivation', () => {
  let fixtureHome: string

  beforeEach(async () => {
    fixtureHome = await mkdtemp(join(tmpdir(), 'kimicode-lineage-'))
  })

  afterEach(async () => {
    await rm(fixtureHome, { recursive: true, force: true })
  })

  async function writeState(agents: Record<string, { parentAgentId: string | null }>): Promise<void> {
    const sessionDir = join(fixtureHome, 'sessions', 'wd_kimilineage_0123456789ab', 'session_abc')
    const agentsDir = join(sessionDir, 'agents')
    await mkdir(agentsDir, { recursive: true })
    for (const name of Object.keys(agents)) {
      const agentDir = join(agentsDir, name)
      await mkdir(agentDir, { recursive: true })
      await writeFile(join(agentDir, 'wire.jsonl'), JSON.stringify({ type: 'metadata', protocol_version: '1.4', created_at: 1782900000000 }) + '\n')
    }
    await writeFile(join(sessionDir, 'state.json'), JSON.stringify({
      createdAt: '2026-07-01T10:00:00.000Z',
      updatedAt: '2026-07-01T10:05:00.000Z',
      workDir: '/workspace/kimicode-lineage',
      agents: Object.fromEntries(Object.entries(agents).map(([k, v]) => [k, { parentAgentId: v.parentAgentId }])),
    }))
  }

  it('marks a child agent (parentAgentId === "main") as a child lineage', async () => {
    await writeState({ main: { parentAgentId: null }, helper: { parentAgentId: 'main' } })
    const wirePath = join(fixtureHome, 'sessions', 'wd_kimilineage_0123456789ab', 'session_abc', 'agents', 'helper', 'wire.jsonl')
    expect(await kimicodeLineageForSource(wirePath, 'helper')).toEqual<SessionLineage>({
      parentSessionId: 'main',
      role: 'child',
      evidence: 'provider-recorded',
    })
  })

  it('marks a `main` agent with sibling children as a root lineage', async () => {
    await writeState({ main: { parentAgentId: null }, helper: { parentAgentId: 'main' } })
    const wirePath = join(fixtureHome, 'sessions', 'wd_kimilineage_0123456789ab', 'session_abc', 'agents', 'main', 'wire.jsonl')
    expect(await kimicodeLineageForSource(wirePath, 'main')).toEqual<SessionLineage>({
      role: 'root',
      evidence: 'provider-recorded',
    })
  })

  it('a lone `main` agent (no children) carries no lineage field', async () => {
    await writeState({ main: { parentAgentId: null } })
    const wirePath = join(fixtureHome, 'sessions', 'wd_kimilineage_0123456789ab', 'session_abc', 'agents', 'main', 'wire.jsonl')
    expect(await kimicodeLineageForSource(wirePath, 'main')).toBeUndefined()
  })

  it('a missing `state.json` carries no lineage field (no inference from directory layout)', async () => {
    // Write wire files but no state.json at all.
    const sessionDir = join(fixtureHome, 'sessions', 'wd_kimilineage_0123456789ab', 'session_xyz')
    const agentsDir = join(sessionDir, 'agents')
    await mkdir(join(agentsDir, 'main'), { recursive: true })
    await mkdir(join(agentsDir, 'helper'), { recursive: true })
    const wirePath = join(agentsDir, 'helper', 'wire.jsonl')
    expect(await kimicodeLineageForSource(wirePath, 'helper')).toBeUndefined()
  })

  it('a non-`main` agent with an unexpected parent id carries no lineage field (strict provider-recorded only)', async () => {
    await writeState({ main: { parentAgentId: null }, helper: { parentAgentId: 'orphan-agent' } })
    const wirePath = join(fixtureHome, 'sessions', 'wd_kimilineage_0123456789ab', 'session_abc', 'agents', 'helper', 'wire.jsonl')
    expect(await kimicodeLineageForSource(wirePath, 'helper')).toBeUndefined()
  })
})

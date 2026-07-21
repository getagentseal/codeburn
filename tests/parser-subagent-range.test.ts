import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { parseAllSessions, clearSessionCache } from '../src/parser.js'
import { loadPricing } from '../src/models.js'
import { aggregateByPr, prLinkedTotals } from '../src/sessions-report.js'

// A parent that spawned an async subagent whose work landed inside the report
// range, while the parent's OWN turns fall just before it. The parent must be kept
// as a 0-cost fold anchor so the in-range child still attributes to the parent's
// PR (finding: a parent with no in-range calls must not drop its child's spend).

let tmpDir: string
let configDir: string
const CWD = '/tmp/anchor-proj'
const PR = 'https://github.com/o/r/pull/1'
const PARENT = '11111111-1111-4111-8111-111111111111'
const AGENT = 'a1234567890abcdef'
const SPAWN = 'toolu_spawn_anchor'

beforeEach(async () => {
  clearSessionCache()
  tmpDir = await mkdtemp(join(tmpdir(), 'anchor-'))
  configDir = join(tmpDir, 'claude')
  process.env['CLAUDE_CONFIG_DIR'] = configDir
  process.env['CODEBURN_CACHE_DIR'] = join(tmpDir, 'cache')
})

afterEach(async () => {
  clearSessionCache()
  delete process.env['CLAUDE_CONFIG_DIR']
  delete process.env['CODEBURN_CACHE_DIR']
  await rm(tmpDir, { recursive: true, force: true })
})

async function writeTranscripts(): Promise<void> {
  const projDir = join(configDir, 'projects', 'anchor-proj')
  const subDir = join(projDir, PARENT, 'subagents')
  await mkdir(subDir, { recursive: true })

  // Parent transcript: a turn that references the PR and spawns AGENT (tool_use
  // SPAWN), then the spawn result recording agentId -> SPAWN. All dated just BEFORE
  // the report range (within the 24h parse lookback so the spawn is still parsed).
  await writeFile(join(projDir, `${PARENT}.jsonl`),
    JSON.stringify({ type: 'user', sessionId: PARENT, timestamp: '2026-07-19T23:00:00.000Z', cwd: CWD, message: { role: 'user', content: 'ship the PR and launch a reviewer' } }) + '\n' +
    JSON.stringify({ type: 'assistant', sessionId: PARENT, timestamp: '2026-07-19T23:00:01.000Z', cwd: CWD, message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id: SPAWN, name: 'Agent', input: {} }], usage: { input_tokens: 10, output_tokens: 5 } } }) + '\n' +
    JSON.stringify({ type: 'pr-link', sessionId: PARENT, timestamp: '2026-07-19T23:00:02.000Z', cwd: CWD, prUrl: PR }) + '\n' +
    JSON.stringify({ type: 'user', sessionId: PARENT, timestamp: '2026-07-19T23:05:00.000Z', cwd: CWD, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: SPAWN, content: 'reviewer done' }] }, toolUseResult: { status: 'completed', agentId: AGENT, content: 'reviewer done' } }) + '\n')

  // Child transcript: the subagent's own work, dated INSIDE the report range.
  await writeFile(join(subDir, `agent-${AGENT}.jsonl`),
    JSON.stringify({ type: 'user', isSidechain: true, sessionId: PARENT, agentId: AGENT, timestamp: '2026-07-20T10:00:00.000Z', cwd: CWD, message: { role: 'user', content: 'review this' } }) + '\n' +
    JSON.stringify({ type: 'assistant', isSidechain: true, sessionId: PARENT, agentId: AGENT, timestamp: '2026-07-20T10:00:05.000Z', cwd: CWD, message: { id: 'c1', type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [], usage: { input_tokens: 1000, output_tokens: 500 } } }) + '\n')
}

describe('subagent fold across a date-range boundary', () => {
  it('folds an in-range child into its parent PR even though the parent has no in-range turns', async () => {
    await loadPricing()
    await writeTranscripts()

    const range = { start: new Date('2026-07-20T00:00:00Z'), end: new Date('2026-07-20T23:59:59Z') }
    const projects = await parseAllSessions(range, 'claude')

    // The child session is present (its work is in range) as a standalone session.
    const childPresent = projects.some(p => p.sessions.some(s => s.sessionId === `agent-${AGENT}`))
    expect(childPresent).toBe(true)

    const rows = aggregateByPr(projects)
    const row = rows.find(r => r.url === PR)
    expect(row).toBeDefined()
    // The parent contributed $0 own spend (turns out of range); the row is entirely
    // the folded child, priced from its opus tokens.
    expect(row!.cost).toBeGreaterThan(0)
    expect(row!.models).toContain('Opus 4.8')

    const totals = prLinkedTotals(projects)
    expect(totals.subagentSessions).toBe(1)
    expect(totals.attributedCost).toBeCloseTo(row!.cost, 6)
  })
})

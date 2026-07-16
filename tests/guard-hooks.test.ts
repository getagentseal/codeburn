import { afterAll, describe, expect, it } from 'vitest'
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dedupeStreamingMessageIds, parseApiCall, parseJsonlLine } from '../src/parser.js'
import { computeSessionUsage, emptyCache, readCache, writeAllow, writeCache } from '../src/guard/usage.js'
import { runGuardHook, runGuardStatusline } from '../src/guard/hooks.js'
import { writeGuardConfig, DEFAULT_GUARD_CONFIG } from '../src/guard/store.js'
import { buildFlags, matchFlag, writeFlags, type GuardFlags } from '../src/guard/flags.js'
import type { ProjectSummary } from '../src/types.js'

const roots: string[] = []
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'codeburn-guard-hooks-'))
  roots.push(d)
  return d
}
afterAll(async () => { for (const r of roots) await rm(r, { recursive: true, force: true }) })

type Tool = { name: string; input?: Record<string, unknown> }
function assistantLine(id: string, o: { inTok?: number; outTok?: number; tools?: Tool[]; ts?: string } = {}): string {
  const content: Record<string, unknown>[] = [{ type: 'text', text: 'ok' }]
  for (const t of o.tools ?? []) content.push({ type: 'tool_use', id: `${t.name}-${id}`, name: t.name, input: t.input ?? {} })
  return JSON.stringify({
    type: 'assistant',
    timestamp: o.ts ?? '2026-07-01T00:00:00.000Z',
    message: {
      model: 'claude-sonnet-4-20250514',
      id,
      type: 'message',
      role: 'assistant',
      usage: { input_tokens: o.inTok ?? 1_000_000, output_tokens: o.outTok ?? 200_000, cache_read_input_tokens: 0 },
      content,
    },
  }) + '\n'
}

async function transcript(lines: string[]): Promise<string> {
  const dir = await tmp()
  const path = join(dir, 'session.jsonl')
  await writeFile(path, lines.join(''), 'utf-8')
  return path
}

const SID = 'sess-1'
function hookInput(path: string): string {
  return JSON.stringify({ session_id: SID, transcript_path: path, hook_event_name: 'PreToolUse', tool_name: 'Bash' })
}

// The shipped pipeline's cost for a transcript: parse every line, dedupe
// streaming copies last-wins exactly like parseSessionFile does, sum call
// costs. The guard's incremental fold must match this to the cent.
async function shippedDedupedCost(path: string): Promise<number> {
  const entries = (await readFile(path, 'utf-8'))
    .split('\n')
    .filter(l => l.trim())
    .map(l => parseJsonlLine(l))
    .filter((e): e is NonNullable<ReturnType<typeof parseJsonlLine>> => e !== null)
  return dedupeStreamingMessageIds(entries).reduce((s, e) => s + (parseApiCall(e)?.costUSD ?? 0), 0)
}

describe('incremental session cache', () => {
  it('parses only the appended tail and totals match a cold parse', async () => {
    const base = await tmp()
    const path = await transcript([assistantLine('a'), assistantLine('b')])

    const r1 = await computeSessionUsage(emptyCache(SID), path)
    await writeCache(r1.cache, base)
    expect(r1.resumedFrom).toBe(0)
    expect(r1.cache.costUSD).toBeGreaterThan(0)
    const offset1 = r1.cache.byteOffset

    await appendFile(path, assistantLine('c') + assistantLine('d'), 'utf-8')
    const size = (await stat(path)).size

    const prev = await readCache(SID, base)
    const r2 = await computeSessionUsage(prev, path)

    // Bytes-read assertion: the second pass resumed exactly where the first
    // stopped and consumed only the appended region (not the whole file).
    expect(r2.resumedFrom).toBe(offset1)
    expect(r2.cache.byteOffset).toBe(size)
    expect(r2.cache.byteOffset - r2.resumedFrom).toBeGreaterThan(0)
    expect(r2.resumedFrom).toBeLessThan(size)

    const cold = await computeSessionUsage(emptyCache(SID), path)
    expect(r2.cache.costUSD).toBeCloseTo(cold.cache.costUSD, 10)
    expect(r2.cache.costUSD).toBeGreaterThan(r1.cache.costUSD)
  })

  it('folds advisor (/advisor) iteration cost into the session total', async () => {
    const plain = await transcript([assistantLine('a')])
    const plainCost = (await computeSessionUsage(emptyCache(SID), plain)).cache.costUSD

    // Same line plus an advisor_message iteration: the advisor's tokens live
    // outside the top-level usage, so the guard total must exceed the plain
    // line by the advisor call's own cost.
    const line = JSON.parse(assistantLine('a')) as { message: { usage: Record<string, unknown> } }
    line.message.usage['iterations'] = [
      { type: 'message', input_tokens: 1_000_000, output_tokens: 200_000 },
      { type: 'advisor_message', model: 'claude-opus-4-20250514', input_tokens: 500_000, output_tokens: 50_000 },
    ]
    const withAdvisor = await transcript([JSON.stringify(line) + '\n'])
    const advisorTotal = (await computeSessionUsage(emptyCache(SID), withAdvisor)).cache.costUSD

    expect(plainCost).toBeGreaterThan(0)
    expect(advisorTotal).toBeGreaterThan(plainCost)

    // Streaming rewrite of the same message id replaces, not adds: the fold
    // stays stable when the advisor-carrying line is written twice.
    const rewritten = await transcript([JSON.stringify(line) + '\n', JSON.stringify(line) + '\n'])
    const rewrittenTotal = (await computeSessionUsage(emptyCache(SID), rewritten)).cache.costUSD
    expect(rewrittenTotal).toBeCloseTo(advisorTotal, 10)
  })

  it('resets to a cold parse when the transcript shrinks (rotation)', async () => {
    const base = await tmp()
    const path = await transcript([assistantLine('a'), assistantLine('b')])
    const r1 = await computeSessionUsage(emptyCache(SID), path)
    await writeCache(r1.cache, base)

    await writeFile(path, assistantLine('z'), 'utf-8') // smaller file, new content
    const r2 = await computeSessionUsage(await readCache(SID, base), path)
    expect(r2.resumedFrom).toBe(0)
    const cold = await computeSessionUsage(emptyCache(SID), path)
    expect(r2.cache.costUSD).toBeCloseTo(cold.cache.costUSD, 10)
  })
})

describe('streaming duplicates (per-message-id replace)', () => {
  it('counts a message written 3x with identical usage once, matching the shipped dedup', async () => {
    const dup = assistantLine('msg-dup', { inTok: 500_000, outTok: 100_000 })
    const path = await transcript([dup, dup, dup, assistantLine('msg-other')])
    const singlePath = await transcript([dup, assistantLine('msg-other')])

    const { cache } = await computeSessionUsage(emptyCache(SID), path)
    expect(cache.costUSD).toBeCloseTo(await shippedDedupedCost(path), 10)
    const single = await computeSessionUsage(emptyCache(SID), singlePath)
    expect(cache.costUSD).toBeCloseTo(single.cache.costUSD, 10)
  })

  it('keeps the last copy when streamed usage grows', async () => {
    const copies = [10_000, 50_000, 120_000].map(outTok => assistantLine('msg-grow', { outTok }))
    const path = await transcript(copies)
    const lastOnly = await transcript([copies[2]!])

    const { cache } = await computeSessionUsage(emptyCache(SID), path)
    expect(cache.costUSD).toBeCloseTo(await shippedDedupedCost(path), 10)
    const last = await computeSessionUsage(emptyCache(SID), lastOnly)
    expect(cache.costUSD).toBeCloseTo(last.cache.costUSD, 10)
  })

  it('replaces across incremental invocations when a later copy arrives', async () => {
    const base = await tmp()
    const path = await transcript([assistantLine('msg-x', { outTok: 20_000 })])
    const r1 = await computeSessionUsage(emptyCache(SID), path)
    await writeCache(r1.cache, base)

    await appendFile(path, assistantLine('msg-x', { outTok: 90_000 }) + assistantLine('msg-y'), 'utf-8')
    const r2 = await computeSessionUsage(await readCache(SID, base), path)
    expect(r2.resumedFrom).toBe(r1.cache.byteOffset)
    expect(r2.cache.costUSD).toBeCloseTo(await shippedDedupedCost(path), 10)
  })
})

describe('trailing complete line without newline', () => {
  it('does not double count the line once it completes (A,B,C then D)', async () => {
    const base = await tmp()
    const a = assistantLine('msg-a')
    const b = assistantLine('msg-b')
    const c = assistantLine('msg-c')
    const d = assistantLine('msg-d')
    const dir = await tmp()
    const path = join(dir, 'session.jsonl')
    await writeFile(path, a + b + c.slice(0, -1), 'utf-8') // C complete but unterminated

    const r1 = await computeSessionUsage(emptyCache(SID), path)
    await writeCache(r1.cache, base)
    // C was folded, but the offset stops after B's newline.
    expect(r1.cache.costUSD).toBeCloseTo(await shippedDedupedCost(path), 10)
    expect(r1.cache.byteOffset).toBe((a + b).length)

    await appendFile(path, '\n' + d, 'utf-8')
    const r2 = await computeSessionUsage(await readCache(SID, base), path)
    // C is re-read as a replace, not a second add: totals equal a cold parse.
    const cold = await computeSessionUsage(emptyCache(SID), path)
    expect(r2.cache.costUSD).toBeCloseTo(cold.cache.costUSD, 10)
    expect(r2.cache.costUSD).toBeCloseTo(await shippedDedupedCost(path), 10)
  })
})

describe('git commit detection', () => {
  it('requires commit to be the git subcommand', async () => {
    const cases: [string, boolean][] = [
      ['git commit -m x', true],
      ['git -c user.name=x commit', true],
      ['npm test && git commit -am done', true],
      ['git add src\ngit commit -m "step"', true], // newline-separated multi-command Bash call
      ['git log --grep commit', false],
      ['git diff && echo commit', false],
      ['echo git then commit', false],
      ['git diff\ncommit notes to self', false], // commit on the next line is not a git subcommand
    ]
    for (const [command, expected] of cases) {
      const path = await transcript([assistantLine('msg-1', { tools: [{ name: 'Bash', input: { command } }] })])
      const { cache } = await computeSessionUsage(emptyCache(SID), path)
      expect(cache.sawGitCommit, command).toBe(expected)
    }
  })
})

describe('budget hook (PreToolUse)', () => {
  async function costOf(path: string): Promise<number> {
    return (await computeSessionUsage(emptyCache(SID), path)).cache.costUSD
  }

  it('stays silent below the soft cap', async () => {
    const base = await tmp()
    const path = await transcript([assistantLine('a')])
    const c = await costOf(path)
    await writeGuardConfig({ ...DEFAULT_GUARD_CONFIG, softUSD: c * 2, hardUSD: c * 4 }, base)
    expect(await runGuardHook('pretooluse', hookInput(path), { base })).toBe('')
  })

  it('warns once on the soft cap, then suppresses the repeat', async () => {
    const base = await tmp()
    const path = await transcript([assistantLine('a'), assistantLine('b')])
    const c = await costOf(path)
    await writeGuardConfig({ ...DEFAULT_GUARD_CONFIG, softUSD: c * 0.5, hardUSD: c * 10 }, base)

    const first = await runGuardHook('pretooluse', hookInput(path), { base })
    expect(JSON.parse(first).systemMessage).toContain('soft cap')
    const second = await runGuardHook('pretooluse', hookInput(path), { base })
    expect(second).toBe('')
  })

  it('blocks on the hard cap with a deny decision, and allow lifts it', async () => {
    const base = await tmp()
    const path = await transcript([assistantLine('a'), assistantLine('b')])
    const c = await costOf(path)
    await writeGuardConfig({ ...DEFAULT_GUARD_CONFIG, softUSD: c * 0.2, hardUSD: c * 0.5 }, base)

    const blocked = JSON.parse(await runGuardHook('pretooluse', hookInput(path), { base }))
    expect(blocked.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    expect(blocked.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(blocked.hookSpecificOutput.permissionDecisionReason).toContain('guard allow')

    await writeAllow(SID, base)
    expect(await runGuardHook('pretooluse', hookInput(path), { base })).toBe('')
  })

  it('disables the cap when the threshold is null', async () => {
    const base = await tmp()
    const path = await transcript([assistantLine('a'), assistantLine('b')])
    await writeGuardConfig({ ...DEFAULT_GUARD_CONFIG, softUSD: null, hardUSD: null }, base)
    expect(await runGuardHook('pretooluse', hookInput(path), { base })).toBe('')
  })
})

describe('yield checkpoint (Stop)', () => {
  function stopInput(path: string): string {
    return JSON.stringify({ session_id: SID, transcript_path: path, hook_event_name: 'Stop' })
  }
  async function withCheckpoint(base: string, path: string): Promise<void> {
    const c = (await computeSessionUsage(emptyCache(SID), path)).cache.costUSD
    await writeGuardConfig({ ...DEFAULT_GUARD_CONFIG, checkpointUSD: c * 0.5 }, base)
  }

  it('fires once for an expensive no-edit no-commit session', async () => {
    const base = await tmp()
    const path = await transcript([assistantLine('a'), assistantLine('b')])
    await withCheckpoint(base, path)
    const first = JSON.parse(await runGuardHook('stop', stopInput(path), { base }))
    expect(first.systemMessage).toContain('no edits or commits')
    expect(await runGuardHook('stop', stopInput(path), { base })).toBe('') // once per session
  })

  it('stays silent when cost is below the checkpoint', async () => {
    const base = await tmp()
    const path = await transcript([assistantLine('a')])
    const c = (await computeSessionUsage(emptyCache(SID), path)).cache.costUSD
    await writeGuardConfig({ ...DEFAULT_GUARD_CONFIG, checkpointUSD: c * 5 }, base)
    expect(await runGuardHook('stop', stopInput(path), { base })).toBe('')
  })

  it('stays silent when the session made an edit', async () => {
    const base = await tmp()
    const path = await transcript([assistantLine('a', { tools: [{ name: 'Edit', input: { file_path: '/x' } }] }), assistantLine('b')])
    await withCheckpoint(base, path)
    expect(await runGuardHook('stop', stopInput(path), { base })).toBe('')
  })

  it('stays silent when the session ran git commit', async () => {
    const base = await tmp()
    const path = await transcript([assistantLine('a', { tools: [{ name: 'Bash', input: { command: 'git commit -m wip' } }] }), assistantLine('b')])
    await withCheckpoint(base, path)
    expect(await runGuardHook('stop', stopInput(path), { base })).toBe('')
  })
})

describe('session opener (SessionStart)', () => {
  it('emits the matching opener text for a flagged project and nothing when stale', async () => {
    const base = await tmp()
    const projectPath = '/tmp/flagged-project'
    const flags: GuardFlags = { generatedAt: new Date().toISOString(), projects: [{ path: projectPath, openers: ['DELIVERABLE OPENER'] }] }
    await writeFlags(flags, base)

    const input = JSON.stringify({ session_id: SID, cwd: projectPath, hook_event_name: 'SessionStart', source: 'startup' })
    const out = JSON.parse(await runGuardHook('sessionstart', input, { base }))
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart')
    expect(out.hookSpecificOutput.additionalContext).toBe('DELIVERABLE OPENER')

    // Unflagged cwd -> nothing.
    const other = JSON.stringify({ session_id: SID, cwd: '/tmp/other', hook_event_name: 'SessionStart' })
    expect(await runGuardHook('sessionstart', other, { base })).toBe('')

    // Stale flag list (> 7 days) -> nothing.
    const stale: GuardFlags = { generatedAt: new Date(Date.now() - 8 * 86_400_000).toISOString(), projects: flags.projects }
    await writeFlags(stale, base)
    expect(await runGuardHook('sessionstart', input, { base })).toBe('')
  })

  it('builds flags from optimize candidate detectors and matches by project path', async () => {
    // A project whose only session has real spend but zero edit turns is a
    // low-worth candidate; buildFlags should flag its projectPath.
    const projects = [lowWorthProject()]
    const flags = await buildFlags(projects as unknown as ProjectSummary[])
    expect(flags.projects.length).toBeGreaterThan(0)
    expect(matchFlag(flags, '/repo/alpha').length).toBeGreaterThan(0)
    expect(matchFlag(flags, '/repo/alpha/src')).toEqual(matchFlag(flags, '/repo/alpha')) // subdir matches
    expect(matchFlag(flags, '/repo/beta')).toEqual([])
  })
})

describe('fail-open: malformed stdin', () => {
  it('every handler exits with empty output on garbage input', async () => {
    const base = await tmp()
    for (const ev of ['pretooluse', 'sessionstart', 'stop']) {
      expect(await runGuardHook(ev, 'not json {', { base })).toBe('')
      expect(await runGuardHook(ev, '', { base })).toBe('')
    }
    expect(await runGuardHook('unknownevent', JSON.stringify({ session_id: SID }), { base })).toBe('')
    expect(await runGuardStatusline('not json {', { base })).toBe('')
  })

  it('handlers stay silent when the transcript path is missing', async () => {
    const base = await tmp()
    const noPath = JSON.stringify({ session_id: SID, hook_event_name: 'PreToolUse' })
    expect(await runGuardHook('pretooluse', noPath, { base })).toBe('')
    expect(await runGuardHook('stop', noPath, { base })).toBe('')
  })
})

describe('statusline', () => {
  it('prints one line with the session cost', async () => {
    const base = await tmp()
    const path = await transcript([assistantLine('a')])
    const out = await runGuardStatusline(JSON.stringify({ session_id: SID, transcript_path: path }), { base })
    expect(out.startsWith('codeburn guard $')).toBe(true)
    expect(out).not.toContain('\n')
  })
})

// A minimal ProjectSummary shaped just enough for findLowWorthCandidates:
// meaningful cost, no delivery command, and no edit turns.
function lowWorthProject(): Record<string, unknown> {
  const turn = {
    userMessage: 'do a thing',
    assistantCalls: [{ costUSD: 40, tools: [], bashCommands: [], timestamp: '2026-07-01T00:00:00Z' }],
    timestamp: '2026-07-01T00:00:00Z',
    sessionId: 's-alpha',
    category: 'exploration',
    retries: 0,
    hasEdits: false,
  }
  const session = {
    sessionId: 's-alpha',
    project: 'alpha',
    firstTimestamp: '2026-07-01T00:00:00Z',
    lastTimestamp: '2026-07-01T01:00:00Z',
    totalCostUSD: 40,
    totalSavingsUSD: 0,
    totalInputTokens: 100, totalOutputTokens: 100, totalReasoningTokens: 0,
    totalCacheReadTokens: 0, totalCacheWriteTokens: 0,
    apiCalls: 1,
    turns: [turn],
    modelBreakdown: {}, toolBreakdown: {}, mcpBreakdown: {}, bashBreakdown: {},
    categoryBreakdown: {}, skillBreakdown: {}, subagentBreakdown: {},
  }
  return {
    project: 'alpha',
    projectPath: '/repo/alpha',
    sessions: [session],
    totalCostUSD: 40, totalSavingsUSD: 0, totalApiCalls: 1, totalProxiedCostUSD: 0,
  }
}

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, stat } from 'fs/promises'
import { basename, join } from 'path'
import { tmpdir } from 'os'

import { createCodexProvider } from '../../src/providers/codex.js'
import { clearCodexMemCaches, CODEX_CACHE_VERSION, codexCacheFileName } from '../../src/codex-cache.js'
import { calculateCost, parseLiteLLMEntry, restorePricingState, snapshotPricingState } from '../../src/models.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'codex-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function sessionMeta(opts: { cwd?: string; originator?: string; session_id?: string; model?: string; forked_from_id?: string; source?: unknown; timestamp?: string } = {}) {
  return JSON.stringify({
    type: 'session_meta',
    timestamp: opts.timestamp ?? '2026-04-14T10:00:00Z',
    payload: {
      cwd: opts.cwd ?? '/Users/test/myproject',
      originator: opts.originator ?? 'codex-cli',
      session_id: opts.session_id ?? 'sess-001',
      model: opts.model ?? 'gpt-5.3-codex',
      ...(opts.forked_from_id ? { forked_from_id: opts.forked_from_id } : {}),
      ...(opts.source ? { source: opts.source } : {}),
    },
  })
}

function tokenCount(opts: {
  timestamp?: string
  last?: { input?: number; cached?: number; output?: number; reasoning?: number }
  total?: { input?: number; cached?: number; output?: number; reasoning?: number; total?: number }
  model?: string
}) {
  return JSON.stringify({
    type: 'event_msg',
    timestamp: opts.timestamp ?? '2026-04-14T10:01:00Z',
    payload: {
      type: 'token_count',
      info: {
        model: opts.model,
        last_token_usage: opts.last ? {
          input_tokens: opts.last.input ?? 0,
          cached_input_tokens: opts.last.cached ?? 0,
          output_tokens: opts.last.output ?? 0,
          reasoning_output_tokens: opts.last.reasoning ?? 0,
          total_tokens: (opts.last.input ?? 0) + (opts.last.cached ?? 0) + (opts.last.output ?? 0) + (opts.last.reasoning ?? 0),
        } : undefined,
        total_token_usage: opts.total ? {
          input_tokens: opts.total.input ?? 0,
          cached_input_tokens: opts.total.cached ?? 0,
          output_tokens: opts.total.output ?? 0,
          reasoning_output_tokens: opts.total.reasoning ?? 0,
          total_tokens: opts.total.total ?? ((opts.total.input ?? 0) + (opts.total.cached ?? 0) + (opts.total.output ?? 0) + (opts.total.reasoning ?? 0)),
        } : undefined,
      },
    },
  })
}

function tokenUsageRecord(opts: {
  timestamp?: string
  responseId?: string
  model?: string
  usage: { input?: number; cached?: number; cacheWrite?: number; output?: number; reasoning?: number }
}) {
  return JSON.stringify({
    type: 'token_usage_record',
    timestamp: opts.timestamp ?? '2026-09-27T10:01:00Z',
    payload: {
      response_id: opts.responseId ?? 'resp-001',
      model: opts.model,
      usage: {
        input_tokens: opts.usage.input ?? 0,
        cached_input_tokens: opts.usage.cached ?? 0,
        cache_write_input_tokens: opts.usage.cacheWrite ?? 0,
        output_tokens: opts.usage.output ?? 0,
        reasoning_output_tokens: opts.usage.reasoning ?? 0,
      },
    },
  })
}

function functionCall(name: string, timestamp?: string) {
  return JSON.stringify({
    type: 'response_item',
    timestamp: timestamp ?? '2026-04-14T10:00:30Z',
    payload: { type: 'function_call', name },
  })
}

function mcpToolCallEnd(server: string, tool: string, timestamp?: string) {
  return JSON.stringify({
    type: 'event_msg',
    timestamp: timestamp ?? '2026-04-14T10:00:30Z',
    payload: {
      type: 'mcp_tool_call_end',
      call_id: 'call-1',
      invocation: { server, tool, arguments: {} },
      duration: '1.2s',
      result: { Ok: { content: [] } },
    },
  })
}

function userMessage(text: string, timestamp?: string) {
  return JSON.stringify({
    type: 'response_item',
    timestamp: timestamp ?? '2026-04-14T10:00:00Z',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
    },
  })
}

async function writeSession(dir: string, date: string, filename: string, lines: string[]) {
  const [year, month, day] = date.split('-')
  const sessionDir = join(dir, 'sessions', year!, month!, day!)
  await mkdir(sessionDir, { recursive: true })
  const filePath = join(sessionDir, filename)
  await writeFile(filePath, lines.join('\n') + '\n')
  return filePath
}

async function writeArchivedSession(dir: string, filename: string, lines: string[]) {
  const archivedDir = join(dir, 'archived_sessions')
  await mkdir(archivedDir, { recursive: true })
  const filePath = join(archivedDir, filename)
  await writeFile(filePath, lines.join('\n') + '\n')
  return filePath
}

describe('codex provider - model display names', () => {
  it('maps gpt-5.3-codex-spark to its own label', () => {
    const provider = createCodexProvider(tmpDir)
    const name = provider.modelDisplayName('gpt-5.3-codex-spark')
    expect(name).not.toBe('GPT-5.3 Codex')
    expect(name).toBe('GPT-5.3 Codex Spark')
  })

  it('maps gpt-5.3-codex reasoning suffixes to the base label', () => {
    const provider = createCodexProvider(tmpDir)
    expect(provider.modelDisplayName('gpt-5.3-codex-high')).toBe('GPT-5.3 Codex')
    expect(provider.modelDisplayName('gpt-5.3-codex-low')).toBe('GPT-5.3 Codex')
  })
})

describe('codex provider - session discovery', () => {
  it('discovers sessions in YYYY/MM/DD structure', async () => {
    await writeSession(tmpDir, '2026-04-14', 'rollout-abc123.jsonl', [
      sessionMeta({ cwd: '/Users/test/myproject' }),
      tokenCount({ last: { input: 100, output: 50 }, total: { total: 150 } }),
    ])

    const provider = createCodexProvider(tmpDir)
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.provider).toBe('codex')
    expect(sessions[0]!.project).toBe('Users-test-myproject')
    expect(sessions[0]!.path).toContain('rollout-abc123.jsonl')
  })

  it('discovers sessions moved to the flat archived_sessions directory', async () => {
    const filePath = await writeArchivedSession(tmpDir, 'rollout-archived.jsonl', [
      sessionMeta({ cwd: '/Users/test/archived' }),
      tokenCount({ last: { input: 100, output: 50 }, total: { total: 150 } }),
    ])

    const provider = createCodexProvider(tmpDir)
    const sessions = await provider.discoverSessions()

    expect(sessions).toEqual([{
      path: filePath,
      project: 'Users-test-archived',
      provider: 'codex',
    }])
  })

  it('deduplicates the same session_id across active and archived roots', async () => {
    const sharedLines = [
      sessionMeta({ cwd: '/Users/test/shared', session_id: 'sess-shared' }),
      tokenCount({ last: { input: 100, output: 50 }, total: { total: 150 } }),
    ]
    const activePath = await writeSession(tmpDir, '2026-04-14', 'rollout-shared.jsonl', sharedLines)
    const archivedCopyPath = await writeArchivedSession(tmpDir, 'rollout-shared.jsonl', sharedLines)
    const distinctPath = await writeArchivedSession(tmpDir, 'rollout-distinct.jsonl', [
      sessionMeta({ cwd: '/Users/test/distinct', session_id: 'sess-distinct' }),
      tokenCount({ last: { input: 200, output: 50 }, total: { total: 250 } }),
    ])

    const provider = createCodexProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    const paths = sessions.map(session => session.path)

    expect(sessions).toHaveLength(2)
    expect(paths).toEqual(expect.arrayContaining([activePath, distinctPath]))
    expect(paths).not.toContain(archivedCopyPath)
  })

  it('does not double-count usage for an archived copy while counting distinct sessions', async () => {
    const sharedLines = [
      sessionMeta({ session_id: 'sess-shared' }),
      tokenCount({ last: { input: 100, output: 50 }, total: { total: 150 } }),
    ]
    await writeSession(tmpDir, '2026-04-14', 'rollout-shared.jsonl', sharedLines)
    await writeArchivedSession(tmpDir, 'rollout-shared-copy.jsonl', sharedLines)
    await writeArchivedSession(tmpDir, 'rollout-distinct.jsonl', [
      sessionMeta({ session_id: 'sess-distinct' }),
      tokenCount({ last: { input: 200, output: 50 }, total: { total: 250 } }),
    ])

    const provider = createCodexProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    const seenKeys = new Set<string>()
    const calls: ParsedProviderCall[] = []
    for (const session of sessions) {
      for await (const call of provider.createSessionParser(session, seenKeys).parse()) {
        calls.push(call)
      }
    }

    expect(calls.map(call => call.sessionId).sort()).toEqual(['sess-distinct', 'sess-shared'])
    expect(calls.reduce(
      (total, call) => total + call.inputTokens + call.cachedInputTokens + call.outputTokens + call.reasoningTokens,
      0,
    )).toBe(400)
  })

  it('returns empty for non-existent directory', async () => {
    const provider = createCodexProvider('/nonexistent/path/that/does/not/exist')
    const sessions = await provider.discoverSessions()
    expect(sessions).toEqual([])
  })

  it('accepts case-insensitive originator (Codex Desktop)', async () => {
    await writeSession(tmpDir, '2026-04-14', 'rollout-desktop.jsonl', [
      sessionMeta({ originator: 'Codex Desktop' }),
      tokenCount({ last: { input: 100, output: 50 }, total: { total: 150 } }),
    ])

    const provider = createCodexProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toHaveLength(1)
  })

  it('accepts a third-party frontend originator (t3code_desktop)', async () => {
    // Any client driving `codex app-server` writes structurally identical
    // rollouts under ~/.codex/sessions with its own originator string.
    // Discovery must be structural, not a per-client allowlist (issue #873).
    await writeSession(tmpDir, '2026-04-14', 'rollout-t3code.jsonl', [
      sessionMeta({ originator: 't3code_desktop', session_id: 'sess-t3code', cwd: '/Users/test/t3code' }),
      tokenCount({ last: { input: 100, output: 50 }, total: { total: 150 } }),
    ])

    const provider = createCodexProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.path).toContain('rollout-t3code.jsonl')
    expect(sessions[0]!.project).toBe('Users-test-t3code')
  })

  it('accepts the JetBrains plugin originator (issue #626)', async () => {
    await writeSession(tmpDir, '2026-04-14', 'rollout-jetbrains.jsonl', [
      sessionMeta({ originator: 'JetBrains.IntelliJ IDEA', session_id: 'sess-jb', cwd: '/Users/test/jb' }),
      tokenCount({ last: { input: 100, output: 50 }, total: { total: 150 } }),
    ])

    const provider = createCodexProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.path).toContain('rollout-jetbrains.jsonl')
    expect(sessions[0]!.project).toBe('Users-test-jb')
  })

  it('accepts a rollout with no originator field at all', async () => {
    // Proves the gate is structural rather than string-matching: a rollout that
    // omits `originator` entirely is still a valid Codex session.
    const [year, month, day] = '2026-04-14'.split('-')
    const sessionDir = join(tmpDir, 'sessions', year!, month!, day!)
    await mkdir(sessionDir, { recursive: true })
    await writeFile(
      join(sessionDir, 'rollout-no-originator.jsonl'),
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-04-14T10:00:00Z',
        payload: {
          cwd: '/Users/test/anon',
          session_id: 'sess-anon',
          model: 'gpt-5.5',
        },
      }) + '\n' +
      tokenCount({ last: { input: 100, output: 50 }, total: { total: 150 } }) + '\n',
    )

    const provider = createCodexProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.project).toBe('Users-test-anon')
  })

  it('accepts an archived rollout from a third-party frontend', async () => {
    await writeArchivedSession(tmpDir, 'rollout-archived-t3code.jsonl', [
      sessionMeta({ originator: 't3code_desktop', session_id: 'sess-arch-t3', cwd: '/Users/test/arch' }),
      tokenCount({ last: { input: 100, output: 50 }, total: { total: 150 } }),
    ])

    const provider = createCodexProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.project).toBe('Users-test-arch')
  })

  it('still rejects foreign and malformed first lines regardless of originator', async () => {
    const [year, month, day] = '2026-04-14'.split('-')
    const sessionDir = join(tmpDir, 'sessions', year!, month!, day!)
    await mkdir(sessionDir, { recursive: true })
    // Wrong entry type, even with a codex-looking originator.
    await writeFile(
      join(sessionDir, 'rollout-wrong-type.jsonl'),
      JSON.stringify({ type: 'other', payload: { originator: 'codex-cli', cwd: '/x' } }) + '\n',
    )
    // session_meta with no payload at all.
    await writeFile(
      join(sessionDir, 'rollout-no-payload.jsonl'),
      JSON.stringify({ type: 'session_meta', timestamp: '2026-04-14T10:00:00Z' }) + '\n',
    )
    // session_meta with a non-object payload.
    await writeFile(
      join(sessionDir, 'rollout-scalar-payload.jsonl'),
      JSON.stringify({ type: 'session_meta', payload: 'codex-cli' }) + '\n',
    )
    // session_meta with an array payload.
    await writeFile(
      join(sessionDir, 'rollout-array-payload.jsonl'),
      JSON.stringify({ type: 'session_meta', payload: [] }) + '\n',
    )
    // Not JSON at all.
    await writeFile(join(sessionDir, 'rollout-not-json.jsonl'), 'not json at all\n')

    const provider = createCodexProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toEqual([])
  })

  it('survives a non-string cwd instead of zeroing out the whole provider', async () => {
    // Structural discovery admits rollouts from clients whose schema conformance
    // is unverified, so a payload field can hold anything JSON can express.
    // `cwd` is declared `string` but reaches sanitizeProject straight off
    // JSON.parse: a number/object/array/bool used to throw
    // "cwd.replace is not a function", escape discoverSessions, and get caught
    // by safeDiscoverSessions — which returns [] for the ENTIRE codex provider,
    // so one malformed file made every Codex report read zero.
    const [year, month, day] = '2026-04-14'.split('-')
    const sessionDir = join(tmpDir, 'sessions', year!, month!, day!)
    await mkdir(sessionDir, { recursive: true })
    const badCwds: Array<[string, unknown]> = [
      ['number', 123],
      ['object', { path: '/Users/test/obj' }],
      ['array', ['/Users/test/arr']],
      ['bool', true],
      ['null', null],
      ['empty', ''],
    ]
    for (const [label, cwd] of badCwds) {
      await writeFile(
        join(sessionDir, `rollout-badcwd-${label}.jsonl`),
        JSON.stringify({
          type: 'session_meta',
          timestamp: '2026-04-14T10:00:00Z',
          payload: { cwd, session_id: `sess-${label}`, originator: 'codex-cli' },
        }) + '\n' +
        tokenCount({ last: { input: 100, output: 50 }, total: { total: 150 } }) + '\n',
      )
    }
    // A healthy sibling: proves the provider is not zeroed out by the bad ones.
    await writeSession(tmpDir, '2026-04-14', 'rollout-good.jsonl', [
      sessionMeta({ cwd: '/Users/test/good', session_id: 'sess-good' }),
      tokenCount({ last: { input: 100, output: 50 }, total: { total: 150 } }),
    ])

    const provider = createCodexProvider(tmpDir)
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(badCwds.length + 1)
    for (const s of sessions) expect(typeof s.project).toBe('string')
    const byName = new Map(sessions.map(s => [basename(s.path), s.project]))
    for (const [label] of badCwds) {
      expect(byName.get(`rollout-badcwd-${label}.jsonl`)).toBe('unknown')
    }
    expect(byName.get('rollout-good.jsonl')).toBe('Users-test-good')
  })

  it('does not leak a non-string cwd into projectPath/workingDirectory', async () => {
    // Same unchecked cast on the parse side: sessionCwd feeds projectPath and
    // workingDirectory, which the parser's path helpers call string methods on.
    const [year, month, day] = '2026-04-14'.split('-')
    const sessionDir = join(tmpDir, 'sessions', year!, month!, day!)
    await mkdir(sessionDir, { recursive: true })
    await writeFile(
      join(sessionDir, 'rollout-badcwd-parse.jsonl'),
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-04-14T10:00:00Z',
        payload: { cwd: 123, session_id: 'sess-badcwd', model: 'gpt-5.5', originator: 'codex-cli' },
      }) + '\n' +
      tokenCount({ last: { input: 100, output: 50 }, total: { total: 150 } }) + '\n',
    )

    const provider = createCodexProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toHaveLength(1)

    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(sessions[0]!, new Set()).parse()) calls.push(call)

    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call.projectPath === undefined || typeof call.projectPath === 'string').toBe(true)
      expect(call.workingDirectory === undefined || typeof call.workingDirectory === 'string').toBe(true)
    }
  })

  it('counts a forked rollout whose timestamp is unparseable instead of throwing it to zero', async () => {
    // A forked session with a garbage (or non-string) timestamp used to make the
    // fork-cutoff `new Date(NaN).toISOString()` throw RangeError, sinking the
    // whole session's usage to zero. Same unchecked-JSON.parse class as cwd.
    await writeSession(tmpDir, '2026-04-14', 'rollout-forked-badts.jsonl', [
      JSON.stringify({
        type: 'session_meta',
        timestamp: 'not-a-real-timestamp',
        payload: { cwd: '/Users/test/fork', session_id: 'sess-fork', model: 'gpt-5.5', originator: 't3code_desktop', forked_from_id: 'parent-1' },
      }),
      tokenCount({ timestamp: '2026-04-14T10:01:00Z', last: { input: 100, output: 50 }, total: { total: 150 } }),
    ])

    const provider = createCodexProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toHaveLength(1)

    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(sessions[0]!, new Set()).parse()) calls.push(call)
    expect(calls.length).toBeGreaterThan(0)
  })

  it('counts a rollout with a non-string model via the fallback instead of throwing', async () => {
    // A non-string `model` used to ride sessionModel into calculateCost, which
    // calls `.replace()` on it -> "model.replace is not a function" -> the whole
    // session reads zero. It should fall back to a real model and be counted.
    await writeSession(tmpDir, '2026-04-14', 'rollout-badmodel.jsonl', [
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-04-14T10:00:00Z',
        payload: { cwd: '/Users/test/m', session_id: 'sess-badmodel', model: { name: 'gpt-5.5' }, originator: 't3code_desktop' },
      }),
      tokenCount({ last: { input: 100, output: 50 }, total: { total: 150 } }),
    ])

    const provider = createCodexProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toHaveLength(1)

    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(sessions[0]!, new Set()).parse()) calls.push(call)
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(typeof call.model).toBe('string')
      expect(Number.isFinite(call.costUSD)).toBe(true)
    }
  })

  it('accepts session_meta lines larger than 16 KB (Codex CLI 0.128+)', async () => {
    // Codex CLI 0.128+ embeds the full base_instructions / system prompt in the
    // first session_meta line, often pushing it past 20 KB. Regression guard
    // against a fixed-size buffer in readFirstLine.
    const bigPayload = JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-05-02T00:00:00Z',
      payload: {
        cwd: '/Users/test/big',
        originator: 'codex-tui',
        session_id: 'sess-big',
        model: 'gpt-5.5',
        base_instructions: { text: 'x'.repeat(40_000) },
      },
    })
    await writeSession(tmpDir, '2026-05-02', 'rollout-big.jsonl', [
      bigPayload,
      tokenCount({ last: { input: 100, output: 50 }, total: { total: 150 } }),
    ])

    const provider = createCodexProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.path).toContain('rollout-big.jsonl')
    // Confirm the large meta line was actually parsed (cwd extracted),
    // not just that some path was registered.
    expect(sessions[0]!.project).toBe('Users-test-big')
  })

  it('handles a session_meta line without trailing newline', async () => {
    const [year, month, day] = '2026-05-02'.split('-')
    const sessionDir = join(tmpDir, 'sessions', year!, month!, day!)
    await mkdir(sessionDir, { recursive: true })
    // Write a single session_meta line, deliberately without a trailing \n.
    await writeFile(
      join(sessionDir, 'rollout-no-nl.jsonl'),
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-05-02T00:00:00Z',
        payload: {
          cwd: '/Users/test/nonl',
          originator: 'codex-tui',
          session_id: 'sess-nonl',
          model: 'gpt-5.5',
        },
      }),
    )
    const provider = createCodexProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.project).toBe('Users-test-nonl')
  })

  it('handles a session_meta line that spans multiple stream chunks', async () => {
    // createReadStream defaults to a 64 KiB highWaterMark, so a >64 KiB first
    // line forces readline to assemble the line across chunk boundaries.
    const bigPayload = JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-05-02T00:00:00Z',
      payload: {
        cwd: '/Users/test/multichunk',
        originator: 'codex-tui',
        session_id: 'sess-multichunk',
        model: 'gpt-5.5',
        base_instructions: { text: 'y'.repeat(120_000) },
      },
    })
    await writeSession(tmpDir, '2026-05-02', 'rollout-multichunk.jsonl', [
      bigPayload,
      tokenCount({ last: { input: 100, output: 50 }, total: { total: 150 } }),
    ])
    const provider = createCodexProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.project).toBe('Users-test-multichunk')
  })

  it('rejects truncated/torn first-line writes without throwing', async () => {
    // Simulate a partial write where Codex started the session_meta object
    // but hasn't flushed the rest yet (no closing brace, no newline).
    const [year, month, day] = '2026-05-02'.split('-')
    const sessionDir = join(tmpDir, 'sessions', year!, month!, day!)
    await mkdir(sessionDir, { recursive: true })
    await writeFile(
      join(sessionDir, 'rollout-torn.jsonl'),
      '{"type":"session_meta","timestamp":"2026-05-02T00:00:00Z","payload":{"cwd":"/x","originator":"codex-tui","session_id":"s","model":"gpt',
    )
    const provider = createCodexProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toHaveLength(0)
  })

  it('returns no sessions for an empty rollout file', async () => {
    const [year, month, day] = '2026-05-02'.split('-')
    const sessionDir = join(tmpDir, 'sessions', year!, month!, day!)
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(sessionDir, 'rollout-empty.jsonl'), '')
    const provider = createCodexProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toHaveLength(0)
  })

  it('skips files without codex session_meta', async () => {
    const [year, month, day] = '2026-04-14'.split('-')
    const sessionDir = join(tmpDir, 'sessions', year!, month!, day!)
    await mkdir(sessionDir, { recursive: true })
    await writeFile(
      join(sessionDir, 'rollout-bad.jsonl'),
      JSON.stringify({ type: 'other', payload: {} }) + '\n',
    )

    const provider = createCodexProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toEqual([])
  })
})

describe('codex provider - JSONL parsing', () => {
  it('does not treat a nested session_meta model as the active turn model', async () => {
    const largeSessionMeta = JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-04-14T10:00:00Z',
      payload: {
        cwd: '/Users/test/model-switch',
        originator: 'codex-cli',
        session_id: 'sess-model-switch',
        base_instructions: {
          provenance: { type: 'model', model: 'gpt-5.6-sol' },
          text: 'x'.repeat(40_000),
        },
      },
    })
    const turnContext = JSON.stringify({
      type: 'turn_context',
      timestamp: '2026-04-14T10:00:01Z',
      payload: { model: 'gpt-5.6-luna' },
    })
    const filePath = await writeSession(tmpDir, '2026-04-14', 'rollout-model-switch.jsonl', [
      largeSessionMeta,
      turnContext,
      tokenCount({ timestamp: '2026-04-14T10:00:02Z', last: { input: 100, output: 50 }, total: { total: 150 } }),
      largeSessionMeta,
      tokenCount({ timestamp: '2026-04-14T10:00:03Z', last: { input: 200, output: 100 }, total: { total: 450 } }),
    ])

    const provider = createCodexProvider(tmpDir)
    const source = { path: filePath, project: 'test', provider: 'codex' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls.map(call => call.model)).toEqual(['gpt-5.6-luna', 'gpt-5.6-luna'])
  })

  it('reads session_meta cwd/session_id/originator at payload depth 1, not the first nested same-name key', async () => {
    const largeSessionMeta = JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-04-14T10:00:00Z',
      payload: {
        dynamic_tools: [{
          name: 'shadow-tool',
          cwd: '/shadow/cwd',
          originator: 'shadow-originator',
          session_id: 'shadow-session',
          forked_from_id: 'shadow-fork',
          model_provider: 'shadow-provider',
        }],
        base_instructions: { text: 'x'.repeat(40_000) },
        cwd: '/Users/test/real-project',
        originator: 'codex-cli',
        session_id: 'sess-real',
        model: 'gpt-5.6-luna',
        model_provider: 'openai',
        name: 'real-session-name',
      },
    })
    const filePath = await writeSession(tmpDir, '2026-04-14', 'rollout-nested-keys.jsonl', [
      largeSessionMeta,
      functionCall('exec_command'),
      tokenCount({ timestamp: '2026-04-14T10:01:00Z', last: { input: 100, output: 50 }, total: { total: 150 } }),
    ])

    const provider = createCodexProvider(tmpDir)
    const source = { path: filePath, project: 'test', provider: 'codex' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.sessionId).toBe('sess-real')
    expect(calls[0]!.workingDirectory).toBe('/Users/test/real-project')
    expect(calls[0]!.projectPath).toBe('/Users/test/real-project')
    expect(calls[0]!.model).toBe('gpt-5.6-luna')
    expect(calls[0]!.tools).toEqual(['Bash'])
  })

  it('extracts token usage from last_token_usage', async () => {
    const filePath = await writeSession(tmpDir, '2026-04-14', 'rollout-parse.jsonl', [
      sessionMeta({ session_id: 'sess-parse', model: 'gpt-5.3-codex' }),
      userMessage('fix the bug'),
      functionCall('exec_command'),
      functionCall('read_file'),
      tokenCount({
        timestamp: '2026-04-14T10:01:00Z',
        last: { input: 500, cached: 100, output: 200, reasoning: 50 },
        total: { total: 850 },
      }),
    ])

    const provider = createCodexProvider(tmpDir)
    const source = { path: filePath, project: 'test', provider: 'codex' }
    const parser = provider.createSessionParser(source, new Set())
    const calls: ParsedProviderCall[] = []
    for await (const call of parser.parse()) {
      calls.push(call)
    }

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.provider).toBe('codex')
    expect(call.model).toBe('gpt-5.3-codex')
    expect(call.inputTokens).toBe(400)
    expect(call.cachedInputTokens).toBe(100)
    expect(call.cacheReadInputTokens).toBe(100)
    expect(call.outputTokens).toBe(200)
    expect(call.reasoningTokens).toBe(50)
    expect(call.tools).toEqual(['Bash', 'Read'])
    expect(call.userMessage).toBe('fix the bug')
    expect(call.sessionId).toBe('sess-parse')
    expect(call.costUSD).toBeGreaterThan(0)
    expect(call.deduplicationKey).toContain('codex:')
  })

  it('parses large rollout lines and computes active timing for custom tool calls', async () => {
    const largeTokenLine = JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-04-14T10:01:10Z',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 20, total_tokens: 220 },
          total_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 20, total_tokens: 220 },
        },
        rate_limits: { filler: 'x'.repeat(40_000) },
      },
    })
    const largeCompleteLine = JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-04-14T10:01:11Z',
      payload: { type: 'task_complete', last_agent_message: 'x'.repeat(40_000), duration_ms: 10_000 },
    })
    const filePath = await writeSession(tmpDir, '2026-04-14', 'rollout-timing.jsonl', [
      sessionMeta({ session_id: 'sess-timing', model: 'gpt-5.5' }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-04-14T10:00:00Z', payload: { type: 'task_started', turn_id: 'turn-1' } }),
      userMessage('run the tool'),
      JSON.stringify({ type: 'response_item', timestamp: '2026-04-14T10:00:02Z', payload: { type: 'custom_tool_call', call_id: 'call-1', name: 'exec' } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-04-14T10:00:05Z', payload: { type: 'custom_tool_call_output', call_id: 'call-1', output: 'done' } }),
      largeTokenLine,
      largeCompleteLine,
    ])

    const provider = createCodexProvider(tmpDir)
    const source = { path: filePath, project: 'test', provider: 'codex' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      outputTokens: 100,
      reasoningTokens: 20,
      tools: ['Bash'],
      activeDurationMs: 7000,
      // Reasoning (20) is a subset of output_tokens (100), not additive
      // (#1075/#1078/#1079): the billable/throughput numerator is 100, not 120.
      activeGeneratedTokens: 100,
      toolWaitMs: 3000,
    })
  })

  it('REGRESSION (#1088 BUG-1): excludes the task_started -> first request-context gap from active time', async () => {
    // Codex fires task_started before it assembles the request; the 7s gap to
    // the first request-context event (here, the user message) is CLI/harness
    // startup, not model wait, and must not count toward active time. If this
    // ever reverts to windowStart = taskStartedAt, activeDurationMs becomes
    // 20000 (the full duration_ms) instead of 13000 (20000 - the 7s gap).
    const filePath = await writeSession(tmpDir, '2026-04-14', 'rollout-startup-gap.jsonl', [
      sessionMeta({ session_id: 'sess-startup-gap', model: 'gpt-5.5' }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-04-14T10:00:00Z', payload: { type: 'task_started' } }),
      userMessage('run the tool', '2026-04-14T10:00:07Z'),
      tokenCount({ timestamp: '2026-04-14T10:00:20Z', last: { output: 100 }, total: { output: 100, total: 100 } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-04-14T10:00:20Z', payload: { type: 'task_complete', duration_ms: 20_000 } }),
    ])

    const provider = createCodexProvider(tmpDir)
    const source = { path: filePath, project: 'test', provider: 'codex' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ activeGeneratedTokens: 100, activeDurationMs: 13_000, toolWaitMs: 0 })
  })

  it('#1088 BUG-8: reads a task_complete duration reported as {secs,nanos}, not only a plain number', async () => {
    // mcp_tool_call_end already tolerates {secs,nanos} and string durations
    // (durationValueMs); task_complete only read the plain-number duration_ms
    // field, so a task_complete reported the object form was silently dropped
    // (no active timing at all) instead of parsed.
    const filePath = await writeSession(tmpDir, '2026-04-14', 'rollout-object-duration.jsonl', [
      sessionMeta({ session_id: 'sess-object-duration', model: 'gpt-5.5' }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-04-14T10:00:00Z', payload: { type: 'task_started' } }),
      userMessage('run the tool', '2026-04-14T10:00:00Z'),
      tokenCount({ timestamp: '2026-04-14T10:00:10Z', last: { output: 100 }, total: { output: 100, total: 100 } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-04-14T10:00:10Z', payload: { type: 'task_complete', duration: { secs: 10, nanos: 0 } } }),
    ])

    const provider = createCodexProvider(tmpDir)
    const source = { path: filePath, project: 'test', provider: 'codex' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ activeGeneratedTokens: 100, activeDurationMs: 10_000 })
  })

  it('keeps estimated output parsing for large token lines without usage info', async () => {
    // Some rollout variants put token_count metadata beyond the compact head
    // or omit `info` entirely. The line must still reach the character-based
    // estimate path rather than being interpreted as an empty usage object.
    const largeTokenLine = JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-04-14T10:01:10Z',
      payload: { type: 'token_count' },
      filler: 'x'.repeat(40_000),
    })
    const assistantLine = JSON.stringify({
      type: 'response_item',
      timestamp: '2026-04-14T10:01:05Z',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'generated response '.repeat(100) }],
      },
    })
    const filePath = await writeSession(tmpDir, '2026-04-14', 'rollout-estimated-large.jsonl', [
      sessionMeta({ session_id: 'sess-estimated-large', model: 'gpt-5.5' }),
      userMessage('summarize the result'),
      assistantLine,
      largeTokenLine,
    ])

    const provider = createCodexProvider(tmpDir)
    const source = { path: filePath, project: 'test', provider: 'codex' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      model: 'gpt-5.5',
      costIsEstimated: true,
    })
    expect(calls[0]!.outputTokens).toBeGreaterThan(0)
  })

  it('attributes MCP calls emitted as event_msg/mcp_tool_call_end', async () => {
    const filePath = await writeSession(tmpDir, '2026-04-14', 'rollout-mcp.jsonl', [
      sessionMeta({ session_id: 'sess-mcp', model: 'gpt-5.5' }),
      userMessage('look up the issue'),
      mcpToolCallEnd('github', 'get_issue'),
      tokenCount({
        timestamp: '2026-04-14T10:01:00Z',
        last: { input: 300, output: 100 },
        total: { total: 400 },
      }),
    ])

    const provider = createCodexProvider(tmpDir)
    const source = { path: filePath, project: 'test', provider: 'codex' }
    const parser = provider.createSessionParser(source, new Set())
    const calls: ParsedProviderCall[] = []
    for await (const call of parser.parse()) {
      calls.push(call)
    }

    expect(calls).toHaveLength(1)
    expect(calls[0]!.tools).toEqual(['mcp__github__get_issue'])
  })

  it('subtracts native MCP wait time from active timing', async () => {
    const filePath = await writeSession(tmpDir, '2026-04-14', 'rollout-mcp-timing.jsonl', [
      sessionMeta({ session_id: 'sess-mcp-timing', model: 'gpt-5.5' }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-04-14T10:00:00Z', payload: { type: 'task_started' } }),
      userMessage('look up the issue'),
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-04-14T10:00:05Z',
        payload: {
          type: 'mcp_tool_call_end',
          call_id: 'mcp-1',
          invocation: { server: 'github', tool: 'get_issue', arguments: {} },
          duration: { secs: 3, nanos: 0 },
        },
      }),
      tokenCount({
        timestamp: '2026-04-14T10:00:08Z',
        last: { input: 300, output: 100 },
        total: { total: 400 },
      }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-04-14T10:00:10Z', payload: { type: 'task_complete', duration_ms: 10_000 } }),
    ])

    const provider = createCodexProvider(tmpDir)
    const source = { path: filePath, project: 'test', provider: 'codex' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ activeDurationMs: 7000, toolWaitMs: 3000 })
  })

  it('keeps MCP attribution on large result lines', async () => {
    const largeMcpLine = JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-04-14T10:00:05Z',
      payload: {
        type: 'mcp_tool_call_end',
        call_id: 'mcp-large',
        invocation: { server: 'github', tool: 'get_issue', arguments: { duration: '1s', body: 'x'.repeat(100_000) } },
        duration: { secs: 3, nanos: 0 },
        result: { Ok: { content: [{ type: 'text', text: 'x'.repeat(40_000) }] } },
      },
    })
    const filePath = await writeSession(tmpDir, '2026-04-14', 'rollout-mcp-large.jsonl', [
      sessionMeta({ session_id: 'sess-mcp-large', model: 'gpt-5.5' }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-04-14T10:00:00Z', payload: { type: 'task_started' } }),
      userMessage('look up the issue'),
      largeMcpLine,
      tokenCount({ timestamp: '2026-04-14T10:00:08Z', last: { input: 300, output: 100 }, total: { total: 400 } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-04-14T10:00:10Z', payload: { type: 'task_complete', duration_ms: 10_000 } }),
    ])

    const provider = createCodexProvider(tmpDir)
    const source = { path: filePath, project: 'test', provider: 'codex' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ tools: ['mcp__github__get_issue'], activeDurationMs: 7000, toolWaitMs: 3000 })
  })

  it('prefers payload-level duration over a nested duration_ms in large mcp_tool_call_end lines', async () => {
    // Regression guard: a naive first-match regex would pick up the
    // `duration_ms: 9999` inside invocation.arguments instead of the payload-level
    // `duration: { secs: 3 }`. The depth-aware payload scan must win.
    const largeMcpLine = JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-04-14T10:00:05Z',
      payload: {
        type: 'mcp_tool_call_end',
        call_id: 'mcp-duration-collision',
        invocation: { server: 'github', tool: 'get_issue', arguments: { duration_ms: 9999, body: 'x'.repeat(40_000) } },
        duration: { secs: 3, nanos: 0 },
        result: { Ok: { content: [{ type: 'text', text: 'x'.repeat(40_000) }] } },
      },
    })
    const filePath = await writeSession(tmpDir, '2026-04-14', 'rollout-mcp-duration-collision.jsonl', [
      sessionMeta({ session_id: 'sess-mcp-duration-collision', model: 'gpt-5.5' }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-04-14T10:00:00Z', payload: { type: 'task_started' } }),
      userMessage('look up the issue'),
      largeMcpLine,
      tokenCount({ timestamp: '2026-04-14T10:00:08Z', last: { input: 300, output: 100 }, total: { total: 400 } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-04-14T10:00:10Z', payload: { type: 'task_complete', duration_ms: 10_000 } }),
    ])

    const provider = createCodexProvider(tmpDir)
    const source = { path: filePath, project: 'test', provider: 'codex' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ tools: ['mcp__github__get_issue'], activeDurationMs: 7000, toolWaitMs: 3000 })
  })

  it('attributes a task_complete over everything since the last task_started, even across a suppressed one', async () => {
    // A mid-file session_meta carrying forked_from_id re-arms replay tracking,
    // which swallows the task_started right behind it while its
    // task_complete lands past the replay burst. Attribution then has to span both
    // turns, exactly as it did before calls were buffered per task.
    const filePath = await writeSession(tmpDir, '2026-04-14', 'rollout-suppressed-task-start.jsonl', [
      sessionMeta({ session_id: 'sess-suppressed-start', model: 'gpt-5.5' }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-04-14T10:00:00Z', payload: { type: 'task_started' } }),
      userMessage('first ask'),
      tokenCount({ timestamp: '2026-04-14T10:00:05Z', last: { input: 300, output: 100 }, total: { total: 400 } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-04-14T10:00:10Z', payload: { type: 'task_complete', duration_ms: 10_000 } }),
      sessionMeta({ timestamp: '2026-04-14T10:00:11Z', session_id: 'sess-suppressed-start', model: 'gpt-5.5', forked_from_id: 'sess-parent' }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-04-14T10:00:12Z', payload: { type: 'task_started' } }),
      userMessage('second ask', '2026-04-14T10:00:18Z'),
      tokenCount({ timestamp: '2026-04-14T10:00:20Z', last: { input: 300, output: 300 }, total: { total: 1000 } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-04-14T10:00:25Z', payload: { type: 'task_complete', duration_ms: 5_000 } }),
    ])

    const provider = createCodexProvider(tmpDir)
    const source = { path: filePath, project: 'test', provider: 'codex' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(2)
    // The second task_complete re-attributes the first turn too, so the 5s
    // window is split across both by generated tokens rather than leaving the
    // first turn pinned to its own 10s window.
    expect(calls[0]!.activeDurationMs).toBeCloseTo(1250, 6)
    expect(calls[1]!.activeDurationMs).toBeCloseTo(3750, 6)
    expect(calls[0]!.activeDurationMs! + calls[1]!.activeDurationMs!).toBeCloseTo(5000, 6)
  })

  it('omits active timing when recorded tool wait consumes the task duration', async () => {
    const filePath = await writeSession(tmpDir, '2026-04-14', 'rollout-degenerate-timing.jsonl', [
      sessionMeta({ session_id: 'sess-degenerate-timing', model: 'gpt-5.5' }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-04-14T10:00:00Z', payload: { type: 'task_started' } }),
      userMessage('wait for the tool'),
      JSON.stringify({ type: 'response_item', timestamp: '2026-04-14T10:00:00Z', payload: { type: 'custom_tool_call', call_id: 'call-1', name: 'exec' } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-04-14T10:00:10Z', payload: { type: 'custom_tool_call_output', call_id: 'call-1', output: 'done' } }),
      tokenCount({ timestamp: '2026-04-14T10:00:12Z', last: { input: 300, output: 100 }, total: { total: 400 } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-04-14T10:00:13Z', payload: { type: 'task_complete', duration_ms: 10_000 } }),
    ])

    const provider = createCodexProvider(tmpDir)
    const source = { path: filePath, project: 'test', provider: 'codex' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.activeDurationMs).toBeUndefined()
    expect(calls[0]!.toolWaitMs).toBeUndefined()
  })

  it('attributes CLI-wrapped MCP calls (mcp-cli call server tool) to MCP + Bash', async () => {
    const execStr = (command: string) => JSON.stringify({
      type: 'response_item',
      timestamp: '2026-04-14T10:00:30Z',
      payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ command }) },
    })
    // command as an array (Codex sometimes logs argv form).
    const execArr = (command: string[]) => JSON.stringify({
      type: 'response_item',
      timestamp: '2026-04-14T10:00:30Z',
      payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ command }) },
    })
    const filePath = await writeSession(tmpDir, '2026-04-14', 'rollout-mcpcli.jsonl', [
      sessionMeta({ session_id: 'sess-mcpcli', model: 'gpt-5.5' }),
      userMessage('look up an issue via the MCP CLI'),
      // Real invocation forms that MUST attribute to MCP:
      execStr("bash -lc \"mcp-cli call github get_issue '{\\\"id\\\": 5}'\""),   // bash -lc wrapper
      execStr('mcp-cli -c ./mcp.json call linear list_issues'),                 // flags before subcommand
      execArr(['mcp-cli', 'call', 'slack', 'post_message', '{}']),              // argv array form
      // Lookups and unrelated commands that must NOT attribute:
      execStr('mcp-cli info github'),
      execStr('mcp-cli grep "*issue*"'),
      execStr('my-mcp-cli-wrapper call github get_issue'),                       // not the mcp-cli binary
      execStr('ls -la'),
      tokenCount({ timestamp: '2026-04-14T10:01:00Z', last: { input: 300, output: 100 }, total: { total: 400 } }),
    ])

    const provider = createCodexProvider(tmpDir)
    const source = { path: filePath, project: 'test', provider: 'codex' }
    const parser = provider.createSessionParser(source, new Set())
    const calls: ParsedProviderCall[] = []
    for await (const call of parser.parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    const tools = calls[0]!.tools
    // Every exec still counts as Bash (7 exec_commands total).
    expect(tools.filter(t => t === 'Bash')).toHaveLength(7)
    // Exactly the three `call` invocations attribute to MCP; info/grep/wrapper/ls do not.
    expect(tools.filter(t => t.startsWith('mcp__')).sort()).toEqual([
      'mcp__github__get_issue',
      'mcp__linear__list_issues',
      'mcp__slack__post_message',
    ])
  })

  // #478 follow-up: the shapes the `function_call` path never reached. Fixtures
  // are synthesized from the real shapes seen in Codex rollouts (a `custom_tool_call`
  // whose payload is an `input` JS program, and an item-model `item_completed`
  // carrying a `CommandExecution` item with an argv `command`); no real session
  // content is used.
  it('attributes MCP + Skill usage from the exec custom tool and the item model', async () => {
    const customExec = (input: string, callId: string) => JSON.stringify({
      type: 'response_item',
      timestamp: '2026-04-14T10:00:30Z',
      payload: { type: 'custom_tool_call', call_id: callId, name: 'exec', input },
    })
    const commandExecutionItem = (command: string[]) => JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-04-14T10:00:40Z',
      payload: { type: 'item_completed', item: { type: 'CommandExecution', command, exit_code: 0 } },
    })
    const filePath = await writeSession(tmpDir, '2026-04-14', 'rollout-exec-items.jsonl', [
      sessionMeta({ session_id: 'sess-exec-items', model: 'gpt-5.5' }),
      userMessage('use the MCP CLI and load a skill'),
      // custom-tool transport: MCP call and a skill read, both inside the JS program.
      customExec('const r = await tools.exec_command({cmd:"mcp-cli call github get_issue \'{}\'"}); text(r.output);', 'c1'),
      customExec('const r = await tools.exec_command({cmd:"sed -n \'1,200p\' /Users/x/.codex/skills/control-in-app-browser/SKILL.md"}); text(r.output);', 'c2'),
      // Negatives: a lookup subcommand, and a grep that merely mentions a SKILL.md.
      customExec('const r = await tools.exec_command({cmd:"mcp-cli info github"}); text(r.output);', 'c3'),
      customExec('const r = await tools.exec_command({cmd:"grep -rn TODO /Users/x/.codex/skills/deploy/SKILL.md"}); text(r.output);', 'c4'),
      // item model, no matching response item: must attribute on its own.
      commandExecutionItem(['/bin/zsh', '-lc', "mcp-cli call optimizely-cms-mcp help '{}'"]),
      commandExecutionItem(['/bin/zsh', '-lc', 'cat /Users/x/.codex/skills/graphify/SKILL.md']),
      commandExecutionItem(['/bin/zsh', '-lc', 'ls -la']),
      tokenCount({ timestamp: '2026-04-14T10:01:00Z', last: { input: 300, output: 100 }, total: { total: 400 } }),
    ])

    const provider = createCodexProvider(tmpDir)
    const source = { path: filePath, project: 'test', provider: 'codex' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    const tools = calls[0]!.tools
    // Attribution only: the four custom-tool execs stay Bash, and the item-model
    // entries add no tool of their own, so the Bash count is unchanged at 4.
    expect(tools.filter(t => t === 'Bash')).toHaveLength(4)
    expect(tools.filter(t => t.startsWith('mcp__')).sort()).toEqual([
      'mcp__github__get_issue',
      'mcp__optimizely-cms-mcp__help',
    ])
    expect(calls[0]!.skills?.slice().sort()).toEqual(['control-in-app-browser', 'graphify'])
    expect(tools.filter(t => t === 'Skill')).toHaveLength(2)
  })

  it('counts a command carried by BOTH the response item and the item model once', async () => {
    const cmd = "mcp-cli call github get_issue '{}'"
    const filePath = await writeSession(tmpDir, '2026-04-14', 'rollout-both-shapes.jsonl', [
      sessionMeta({ session_id: 'sess-both-shapes', model: 'gpt-5.5' }),
      userMessage('call it twice'),
      JSON.stringify({ type: 'response_item', timestamp: '2026-04-14T10:00:30Z', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd }) } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-04-14T10:00:31Z', payload: { type: 'item_completed', item: { type: 'CommandExecution', command: ['/bin/zsh', '-lc', cmd] } } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-04-14T10:00:32Z', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd }) } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-04-14T10:00:33Z', payload: { type: 'item_completed', item: { type: 'CommandExecution', command: ['/bin/zsh', '-lc', cmd] } } }),
      tokenCount({ timestamp: '2026-04-14T10:01:00Z', last: { input: 300, output: 100 }, total: { total: 400 } }),
    ])

    const provider = createCodexProvider(tmpDir)
    const source = { path: filePath, project: 'test', provider: 'codex' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(1)
    // Two execs, two MCP attributions - not four.
    expect(calls[0]!.tools.filter(t => t === 'Bash')).toHaveLength(2)
    expect(calls[0]!.tools.filter(t => t === 'mcp__github__get_issue')).toHaveLength(2)
  })

  it('normalizes Codex subagent tool calls to Agent', async () => {
    const filePath = await writeSession(tmpDir, '2026-04-14', 'rollout-agent.jsonl', [
      sessionMeta({ session_id: 'sess-agent', model: 'gpt-5.5' }),
      userMessage('delegate the review'),
      functionCall('spawn_agent'),
      functionCall('wait_agent'),
      functionCall('close_agent'),
      tokenCount({
        timestamp: '2026-04-14T10:01:00Z',
        last: { input: 300, output: 100 },
        total: { total: 400 },
      }),
    ])

    const provider = createCodexProvider(tmpDir)
    const source = { path: filePath, project: 'test', provider: 'codex' }
    const parser = provider.createSessionParser(source, new Set())
    const calls: ParsedProviderCall[] = []
    for await (const call of parser.parse()) {
      calls.push(call)
    }

    expect(calls).toHaveLength(1)
    expect(calls[0]!.tools).toEqual(['Agent', 'Agent', 'Agent'])
  })

  it('skips duplicate token_count events', async () => {
    const filePath = await writeSession(tmpDir, '2026-04-14', 'rollout-dedup.jsonl', [
      sessionMeta(),
      tokenCount({
        timestamp: '2026-04-14T10:01:00Z',
        last: { input: 500, output: 200 },
        total: { total: 700 },
      }),
      tokenCount({
        timestamp: '2026-04-14T10:01:01Z',
        last: { input: 500, output: 200 },
        total: { total: 700 },
      }),
      tokenCount({
        timestamp: '2026-04-14T10:02:00Z',
        last: { input: 300, output: 100 },
        total: { total: 1100 },
      }),
    ])

    const provider = createCodexProvider(tmpDir)
    const source = { path: filePath, project: 'test', provider: 'codex' }
    const parser = provider.createSessionParser(source, new Set())
    const calls: ParsedProviderCall[] = []
    for await (const call of parser.parse()) {
      calls.push(call)
    }

    expect(calls).toHaveLength(2)
    expect(calls[0]!.inputTokens).toBe(500)
    expect(calls[1]!.inputTokens).toBe(300)
  })

  it('does not drop the first event when total_token_usage is omitted (cumulativeTotal=0)', async () => {
    // Regression for the prevCumulativeTotal-initialized-to-0 bug. Sessions
    // that emit only last_token_usage (no total_token_usage) report
    // cumulativeTotal=0 on every event. With a 0-initialized prev, the first
    // event matched the dedup guard and was silently dropped, losing the
    // session's opening turn. The null sentinel fixes this.
    const filePath = await writeSession(tmpDir, '2026-04-14', 'rollout-zero-total.jsonl', [
      sessionMeta(),
      tokenCount({
        timestamp: '2026-04-14T10:01:00Z',
        last: { input: 500, output: 200 },
        // No `total` — info.total_token_usage will be undefined.
      }),
      tokenCount({
        timestamp: '2026-04-14T10:01:01Z',
        last: { input: 100, output: 50 },
      }),
    ])

    const provider = createCodexProvider(tmpDir)
    const source = { path: filePath, project: 'test', provider: 'codex' }
    const parser = provider.createSessionParser(source, new Set())
    const calls: ParsedProviderCall[] = []
    for await (const call of parser.parse()) {
      calls.push(call)
    }

    // Both events should produce calls — the first with input=500, second
    // with input=100. With the buggy 0-init, only the second would survive
    // (or neither, depending on equality timing).
    expect(calls.length).toBeGreaterThanOrEqual(1)
    expect(calls[0]!.inputTokens).toBe(500)
  })

  it('still dedups consecutive zero-cumulative duplicates', async () => {
    // The other half of the regression: two consecutive events with the
    // same cumulativeTotal (here both 0 because total_token_usage is
    // omitted) and identical last_token_usage must NOT both ingest. The
    // second is a duplicate.
    const filePath = await writeSession(tmpDir, '2026-04-14', 'rollout-zero-dup.jsonl', [
      sessionMeta(),
      tokenCount({
        timestamp: '2026-04-14T10:01:00Z',
        last: { input: 500, output: 200 },
      }),
      tokenCount({
        timestamp: '2026-04-14T10:01:01Z',
        last: { input: 500, output: 200 },
      }),
    ])

    const provider = createCodexProvider(tmpDir)
    const source = { path: filePath, project: 'test', provider: 'codex' }
    const parser = provider.createSessionParser(source, new Set())
    const calls: ParsedProviderCall[] = []
    for await (const call of parser.parse()) {
      calls.push(call)
    }
    expect(calls).toHaveLength(1)
  })
})

describe('codex provider - forked session dedupe', () => {
  // Aggregate every discovered session through ONE shared seenKeys, exactly as
  // the real provider report does, then sum the global token total.
  async function aggregateTokens(dir: string): Promise<{ tokens: number; calls: number }> {
    const provider = createCodexProvider(dir)
    const sessions = (await provider.discoverSessions()).sort((a, b) => (a.path < b.path ? -1 : 1))
    const seenKeys = new Set<string>()
    let tokens = 0
    let calls = 0
    for (const s of sessions) {
      for await (const c of provider.createSessionParser(s, seenKeys).parse()) {
        calls++
        tokens += c.inputTokens + c.outputTokens + c.cachedInputTokens + c.reasoningTokens
      }
    }
    return { tokens, calls }
  }

  it('does not double-count a fork that replays the parent after the replay burst', async () => {
    // Parent does 1100 tokens of real work. The fork replays both events after
    // the burst boundary, then adds one genuine event
    // (+400). The replays must collide with the parent and drop, so the global
    // total is 1500 -- not 2600 (which keying on the fork's own session id would
    // produce by double-counting the replayed history).
    await writeSession(tmpDir, '2026-04-14', 'rollout-1-parent.jsonl', [
      sessionMeta({ session_id: 'sess-parent' }),
      tokenCount({ timestamp: '2026-04-14T10:00:01Z', last: { input: 700 }, total: { total: 700 } }),
      tokenCount({ timestamp: '2026-04-14T10:00:02Z', last: { input: 400 }, total: { total: 1100 } }),
    ])
    await writeSession(tmpDir, '2026-04-14', 'rollout-2-fork.jsonl', [
      sessionMeta({ session_id: 'sess-fork', forked_from_id: 'sess-parent' }),
      tokenCount({ timestamp: '2026-04-14T10:00:10Z', last: { input: 700 }, total: { total: 700 } }),
      tokenCount({ timestamp: '2026-04-14T10:00:11Z', last: { input: 400 }, total: { total: 1100 } }),
      tokenCount({ timestamp: '2026-04-14T10:00:12Z', last: { input: 400 }, total: { total: 1500 } }),
    ])

    const { tokens } = await aggregateTokens(tmpDir)
    expect(tokens).toBe(1500)
  })

  it('does not double-count a spawned sub-agent that replays its parent with the original timestamps', async () => {
    // A MultiAgent sub-agent rollout names its parent under
    // source.subagent.thread_spawn.parent_thread_id, never forked_from_id, and
    // replays the parent's token_count events with their ORIGINAL timestamps,
    // then adds its own work (+400). Parent 1100 + child 400 = 1500, not 2600.
    await writeSession(tmpDir, '2026-04-14', 'rollout-1-parent.jsonl', [
      sessionMeta({ session_id: 'sess-parent' }),
      tokenCount({ timestamp: '2026-04-14T10:00:01Z', last: { input: 700 }, total: { total: 700 } }),
      tokenCount({ timestamp: '2026-04-14T10:00:02Z', last: { input: 400 }, total: { total: 1100 } }),
    ])
    await writeSession(tmpDir, '2026-04-14', 'rollout-2-subagent.jsonl', [
      sessionMeta({
        session_id: 'sess-child',
        timestamp: '2026-04-14T10:00:30Z',
        source: { subagent: { thread_spawn: { parent_thread_id: 'sess-parent', agent_role: 'explorer' } } },
      }),
      tokenCount({ timestamp: '2026-04-14T10:00:01Z', last: { input: 700 }, total: { total: 700 } }),
      tokenCount({ timestamp: '2026-04-14T10:00:02Z', last: { input: 400 }, total: { total: 1100 } }),
      tokenCount({ timestamp: '2026-04-14T10:00:40Z', last: { input: 400 }, total: { total: 400 } }),
    ])
    const { tokens } = await aggregateTokens(tmpDir)
    expect(tokens).toBe(1500)
  })

  it('keeps a genuine divergent fork event that shares a cumulative total with the parent', async () => {
    // Parent reaches cumulative 1600 via input (last input 500). The fork replays
    // 700 and 1100, then does genuinely different work that also reaches
    // cumulative 1600 but via OUTPUT (last output 500). Keying on cumulativeTotal
    // alone would collide the fork's 1600 with the parent's 1600 and drop it
    // (undercount, losing 500). The content-addressed key keeps both.
    await writeSession(tmpDir, '2026-04-14', 'rollout-1-parent.jsonl', [
      sessionMeta({ session_id: 'sess-parent' }),
      tokenCount({ timestamp: '2026-04-14T10:00:01Z', last: { input: 700 }, total: { total: 700 } }),
      tokenCount({ timestamp: '2026-04-14T10:00:02Z', last: { input: 400 }, total: { total: 1100 } }),
      tokenCount({ timestamp: '2026-04-14T10:00:03Z', last: { input: 500 }, total: { input: 1600, total: 1600 } }),
    ])
    await writeSession(tmpDir, '2026-04-14', 'rollout-2-fork.jsonl', [
      sessionMeta({ session_id: 'sess-fork', forked_from_id: 'sess-parent' }),
      tokenCount({ timestamp: '2026-04-14T10:00:10Z', last: { input: 700 }, total: { total: 700 } }),
      tokenCount({ timestamp: '2026-04-14T10:00:11Z', last: { input: 400 }, total: { total: 1100 } }),
      tokenCount({ timestamp: '2026-04-14T10:00:12Z', last: { output: 500 }, total: { input: 1100, output: 500, total: 1600 } }),
    ])

    const { tokens } = await aggregateTokens(tmpDir)
    // parent 1600 + fork's genuine +500 = 2100; replays (700, 1100) dropped.
    expect(tokens).toBe(2100)
  })

  it('does not overcount total-only parent snapshots replayed after the burst', async () => {
    // The first snapshot is inside the replay burst. Later copied snapshots
    // arrive after the burst and rely on the shared cumulative key to collide
    // with the parent. Parent does 300 tokens; the fork is a pure replay, so
    // the global total stays 300.
    await writeSession(tmpDir, '2026-04-14', 'rollout-1-parent.jsonl', [
      sessionMeta({ session_id: 'sess-parent' }),
      tokenCount({ timestamp: '2026-04-14T10:00:01Z', total: { input: 100, total: 100 } }),
      tokenCount({ timestamp: '2026-04-14T10:00:02Z', total: { input: 200, total: 200 } }),
      tokenCount({ timestamp: '2026-04-14T10:00:03Z', total: { input: 300, total: 300 } }),
    ])
    await writeSession(tmpDir, '2026-04-14', 'rollout-2-fork.jsonl', [
      sessionMeta({ session_id: 'sess-fork', forked_from_id: 'sess-parent' }),
      // 10:00:01 is inside the replay burst -> skipped for call emission.
      tokenCount({ timestamp: '2026-04-14T10:00:01Z', total: { input: 100, total: 100 } }),
      // These land after the burst and replay the parent's cumulative totals.
      tokenCount({ timestamp: '2026-04-14T10:00:08Z', total: { input: 200, total: 200 } }),
      tokenCount({ timestamp: '2026-04-14T10:00:09Z', total: { input: 300, total: 300 } }),
    ])

    const { tokens } = await aggregateTokens(tmpDir)
    expect(tokens).toBe(300)
  })

  it('counts the first total-only fork usage after a replay burst before five seconds', async () => {
    // The fork copies cumulative snapshots in a tight burst, then does real
    // work 3.8s after its last replay. The replay totals must seed the delta
    // baseline, while the first new cumulative total must survive the old 5s
    // cutoff. Parent usage is 200; the fork adds 300.
    await writeSession(tmpDir, '2026-04-14', 'rollout-1-parent.jsonl', [
      sessionMeta({ session_id: 'sess-parent' }),
      tokenCount({ timestamp: '2026-04-14T10:00:01Z', total: { input: 100, total: 100 } }),
      tokenCount({ timestamp: '2026-04-14T10:00:02Z', total: { input: 200, total: 200 } }),
    ])
    await writeSession(tmpDir, '2026-04-14', 'rollout-2-fork.jsonl', [
      sessionMeta({ session_id: 'sess-fork', forked_from_id: 'sess-parent', timestamp: '2026-04-14T10:00:10Z' }),
      tokenCount({ timestamp: '2026-04-14T10:00:10.100Z', total: { input: 100, total: 100 } }),
      tokenCount({ timestamp: '2026-04-14T10:00:10.200Z', total: { input: 200, total: 200 } }),
      tokenCount({ timestamp: '2026-04-14T10:00:14Z', total: { input: 500, total: 500 } }),
    ])

    const { tokens } = await aggregateTokens(tmpDir)
    expect(tokens).toBe(500)
  })

  it('keeps skipping no-cumulative replay records while accepting work after the burst', async () => {
    // No cross-session cumulative key is available here, so the replay burst
    // boundary itself must suppress the copied parent calls. The first real
    // call arrives at +4s and must still be counted.
    await writeSession(tmpDir, '2026-04-14', 'rollout-1-parent.jsonl', [
      sessionMeta({ session_id: 'sess-parent' }),
      tokenCount({ timestamp: '2026-04-14T10:00:01Z', last: { input: 100 } }),
      tokenCount({ timestamp: '2026-04-14T10:00:02Z', last: { input: 50 } }),
    ])
    await writeSession(tmpDir, '2026-04-14', 'rollout-2-fork-no-total.jsonl', [
      sessionMeta({ session_id: 'sess-fork-no-total', forked_from_id: 'sess-parent', timestamp: '2026-04-14T10:00:10Z' }),
      tokenCount({ timestamp: '2026-04-14T10:00:10.100Z', last: { input: 100 } }),
      tokenCount({ timestamp: '2026-04-14T10:00:10.200Z', last: { input: 50 } }),
      // Identical usage info can still be a genuine request after divergence.
      tokenCount({ timestamp: '2026-04-14T10:00:14Z', last: { input: 50 } }),
    ])

    const { tokens } = await aggregateTokens(tmpDir)
    expect(tokens).toBe(200)
  })
})

describe('codex provider - token_usage_record accounting', () => {
  async function parseCalls(lines: string[]): Promise<ParsedProviderCall[]> {
    const filePath = await writeSession(tmpDir, '2026-09-27', 'rollout-usage-record.jsonl', lines)
    const provider = createCodexProvider(tmpDir)
    const source = { path: filePath, project: 'test', provider: 'codex' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) calls.push(call)
    return calls
  }

  it('uses the response usage record when compaction leaves a zero token_count twin', async () => {
    const calls = await parseCalls([
      sessionMeta({ timestamp: '2026-09-27T10:00:00Z' }),
      tokenUsageRecord({
        timestamp: '2026-09-27T10:01:00Z',
        responseId: 'resp-compaction',
        model: 'gpt-5.5',
        usage: { input: 1200, cached: 300, cacheWrite: 200, output: 180, reasoning: 60 },
      }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-09-27T10:01:01Z', payload: { type: 'compacted' } }),
      tokenCount({
        timestamp: '2026-09-27T10:01:02Z',
        last: {},
        total: { input: 0, output: 0, total: 0 },
      }),
    ])

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      model: 'gpt-5.5',
      inputTokens: 900,
      cacheCreationInputTokens: 0,
      cachedInputTokens: 300,
      outputTokens: 180,
      reasoningTokens: 60,
    })
  })

  it('keeps token_count as the source for older rollouts', async () => {
    const calls = await parseCalls([
      sessionMeta(),
      tokenCount({
        timestamp: '2026-04-14T10:01:00Z',
        last: { input: 800, cached: 100, output: 150, reasoning: 25 },
        total: { input: 800, cached: 100, output: 150, reasoning: 25, total: 1075 },
      }),
    ])

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      inputTokens: 700,
      cachedInputTokens: 100,
      outputTokens: 150,
      reasoningTokens: 25,
    })
  })

  it('keeps token_count fallback when a usage record has no recognized counters', async () => {
    const calls = await parseCalls([
      sessionMeta({ timestamp: '2026-09-27T10:00:00Z' }),
      JSON.stringify({
        type: 'token_usage_record',
        timestamp: '2026-09-27T10:00:01Z',
        payload: { response_id: 'resp-empty', usage: {} },
      }),
      tokenCount({
        timestamp: '2026-09-27T10:00:02Z',
        last: { input: 500, output: 80 },
        total: { input: 500, output: 80, total: 580 },
      }),
    ])

    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens + calls[0]!.outputTokens).toBe(580)
  })

  it('does not switch usage sources because of a fork replay record', async () => {
    const calls = await parseCalls([
      sessionMeta({
        timestamp: '2026-09-27T10:00:00Z',
        session_id: 'sess-fork',
        forked_from_id: 'sess-parent',
      }),
      tokenUsageRecord({
        timestamp: '2026-09-27T10:00:01Z',
        responseId: 'resp-replayed',
        usage: { input: 500 },
      }),
      tokenCount({
        timestamp: '2026-09-27T10:00:06Z',
        last: { input: 200, output: 40 },
        total: { input: 200, output: 40, total: 240 },
      }),
    ])

    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens + calls[0]!.outputTokens).toBe(240)
  })

  it('counts a real fork response record before the old five-second cutoff', async () => {
    const calls = await parseCalls([
      sessionMeta({
        timestamp: '2026-09-27T10:00:10Z',
        session_id: 'sess-fork',
        forked_from_id: 'sess-parent',
      }),
      tokenUsageRecord({
        timestamp: '2026-09-27T10:00:10.100Z',
        responseId: 'resp-replayed',
        usage: { input: 500 },
      }),
      tokenUsageRecord({
        timestamp: '2026-09-27T10:00:12Z',
        responseId: 'resp-real',
        usage: { input: 200, output: 40 },
      }),
      tokenCount({
        timestamp: '2026-09-27T10:00:12.100Z',
        last: { input: 200, output: 40 },
        total: { input: 200, output: 40, total: 240 },
      }),
    ])

    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens + calls[0]!.outputTokens).toBe(240)
  })

  it('counts pre-handover token_count usage, then ignores record twins and later token_count events', async () => {
    const calls = await parseCalls([
      sessionMeta({ timestamp: '2026-09-27T10:00:00Z' }),
      tokenCount({
        timestamp: '2026-09-27T10:00:01Z',
        last: { input: 200, output: 100 },
        total: { input: 200, output: 100, total: 300 },
      }),
      tokenUsageRecord({
        timestamp: '2026-09-27T10:00:02Z',
        responseId: 'resp-handover',
        usage: { input: 400, output: 120 },
      }),
      tokenCount({
        timestamp: '2026-09-27T10:00:03Z',
        last: { input: 400, output: 120 },
        total: { input: 600, output: 220, total: 820 },
      }),
      tokenCount({
        timestamp: '2026-09-27T10:00:04Z',
        last: { input: 30, output: 10 },
        total: { input: 630, output: 230, total: 860 },
      }),
    ])

    expect(calls).toHaveLength(2)
    const total = calls.reduce((sum, call) => sum + call.inputTokens + call.cachedInputTokens + call.outputTokens + call.reasoningTokens, 0)
    expect(total).toBe(820)
  })

  it('deduplicates response records replayed by a fork while keeping the fork response', async () => {
    await writeSession(tmpDir, '2026-09-27', 'rollout-1-parent.jsonl', [
      sessionMeta({ session_id: 'sess-parent', timestamp: '2026-09-27T10:00:00Z' }),
      tokenUsageRecord({ timestamp: '2026-09-27T10:00:10Z', responseId: 'resp-shared', usage: { input: 500 } }),
    ])
    await writeSession(tmpDir, '2026-09-27', 'rollout-2-fork.jsonl', [
      sessionMeta({ session_id: 'sess-fork', forked_from_id: 'sess-parent', timestamp: '2026-09-27T10:00:30Z' }),
      tokenUsageRecord({ timestamp: '2026-09-27T10:00:40Z', responseId: 'resp-shared', usage: { input: 500 } }),
      tokenUsageRecord({ timestamp: '2026-09-27T10:00:41Z', responseId: 'resp-fork', usage: { input: 200 } }),
    ])

    const provider = createCodexProvider(tmpDir)
    const sessions = (await provider.discoverSessions()).sort((a, b) => a.path.localeCompare(b.path))
    const seenKeys = new Set<string>()
    let tokens = 0
    let calls = 0
    for (const source of sessions) {
      for await (const call of provider.createSessionParser(source, seenKeys).parse()) {
        calls++
        tokens += call.inputTokens + call.cachedInputTokens + call.outputTokens + call.reasoningTokens
      }
    }

    expect(calls).toBe(2)
    expect(tokens).toBe(700)
  })

  it('keeps usage from a response interrupted before token_count or task_complete', async () => {
    const calls = await parseCalls([
      sessionMeta({ timestamp: '2026-09-27T10:00:00Z' }),
      tokenUsageRecord({
        timestamp: '2026-09-27T10:01:00Z',
        responseId: 'resp-interrupted',
        usage: { input: 900, output: 240 },
      }),
    ])

    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens + calls[0]!.outputTokens).toBe(1140)
  })
})

describe('codex auto-review pricing (#1047)', () => {
  it('prices a pre-30-Jul auto-review whose prompt crosses gpt-5.4\'s above-272k tier at the tier (#1076)', async () => {
    // End-to-end through the codex provider path: the gate is keyed on the
    // provider string threaded from codex.ts, so a typo there would leave the
    // call at base rates and fail this. 400k input puts the prompt well past
    // 272,000 with no cache needed.
    const filePath = await writeSession(tmpDir, '2026-04-14', 'rollout-auto-review-tier.jsonl', [
      sessionMeta({ session_id: 'sess-auto-tier', model: 'codex-auto-review' }),
      userMessage('review the PR'),
      tokenCount({
        timestamp: '2026-04-14T10:01:00Z',
        last: { input: 400_000, output: 1_000 },
        total: { total: 401_000 },
      }),
    ])
    const provider = createCodexProvider(tmpDir)
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser({ path: filePath, project: 'test', provider: 'codex' }, new Set()).parse()) {
      calls.push(call)
    }
    expect(calls).toHaveLength(1)
    // gpt-5.4 tier (bundled): input 5e-6, output 2.25e-5 - explicit arithmetic,
    // not just self-consistency with calculateCost.
    expect(calls[0]!.costUSD).toBeCloseTo(400_000 * 5e-6 + 1_000 * 2.25e-5, 12)
    expect(calls[0]!.costUSD).toBe(calculateCost('gpt-5.4', 400_000, 1_000, 0, 0, 0, 'standard', 0, 'codex'))
    // The same call without the codex provider stays at base rates (the
    // bundle's gpt-5.4 base is 2.5e-6/1.5e-5) - the gate that keeps the
    // real Copilot billing of tests/parser.test.ts (c4) intact.
    expect(calculateCost('gpt-5.4', 400_000, 1_000, 0, 0, 0)).toBeCloseTo(400_000 * 2.5e-6 + 1_000 * 1.5e-5, 12)
  })
  it('parses auto-review as itself and prices it as GPT-5.4 before 30 Jul 2026', async () => {
    const filePath = await writeSession(tmpDir, '2026-04-14', 'rollout-auto-review.jsonl', [
      sessionMeta({ session_id: 'sess-auto', model: 'codex-auto-review' }),
      userMessage('review the PR'),
      tokenCount({
        timestamp: '2026-04-14T10:01:00Z',
        last: { input: 1_000_000, output: 1_000_000 },
        total: { total: 2_000_000 },
      }),
    ])
    const provider = createCodexProvider(tmpDir)
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser({ path: filePath, project: 'test', provider: 'codex' }, new Set()).parse()) {
      calls.push(call)
    }
    expect(calls).toHaveLength(1)
    expect(calls[0]!.model).toBe('codex-auto-review')
    expect(calls[0]!.costUSD).toBe(calculateCost('gpt-5.4', 1_000_000, 1_000_000, 0, 0, 0, 'standard', 0, 'codex'))
  })

  it('prices auto-review from 30 Jul 2026 as GPT-5.6 Luna', async () => {
    const filePath = await writeSession(tmpDir, '2026-07-30', 'rollout-auto-review-luna.jsonl', [
      sessionMeta({ session_id: 'sess-auto-luna', model: 'codex-auto-review' }),
      userMessage('review the PR'),
      tokenCount({
        timestamp: '2026-07-30T00:00:00Z',
        last: { input: 100_000, output: 100_000 },
        total: { total: 200_000 },
      }),
    ])
    const provider = createCodexProvider(tmpDir)
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser({ path: filePath, project: 'test', provider: 'codex' }, new Set()).parse()) {
      calls.push(call)
    }
    expect(calls).toHaveLength(1)
    expect(calls[0]!.model).toBe('codex-auto-review')
    // Luna base (bundled): input 2e-7, output 1.2e-6.
    expect(calls[0]!.costUSD).toBeCloseTo(100_000 * 2e-7 + 100_000 * 1.2e-6, 12)
    expect(calls[0]!.costUSD).toBe(calculateCost('gpt-5.6-luna', 100_000, 100_000, 0, 0, 0, 'standard', 0, 'codex'))
  })

  it('prices a recorded gpt-5.6-luna as recorded, whatever the date', async () => {
    const filePath = await writeSession(tmpDir, '2026-04-14', 'rollout-auto-review-recorded.jsonl', [
      sessionMeta({ session_id: 'sess-auto-recorded', model: 'codex-auto-review' }),
      JSON.stringify({ type: 'turn_context', timestamp: '2026-04-14T10:00:30Z', payload: { model: 'gpt-5.6-luna' } }),
      userMessage('review the PR'),
      tokenCount({
        timestamp: '2026-04-14T10:01:00Z',
        last: { input: 1_000_000, output: 1_000_000 },
        total: { total: 2_000_000 },
      }),
    ])
    const provider = createCodexProvider(tmpDir)
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser({ path: filePath, project: 'test', provider: 'codex' }, new Set()).parse()) {
      calls.push(call)
    }
    expect(calls).toHaveLength(1)
    expect(calls[0]!.model).toBe('gpt-5.6-luna')
    expect(calls[0]!.costUSD).toBe(calculateCost('gpt-5.6-luna', 1_000_000, 1_000_000, 0, 0, 0, 'standard', 0, 'codex'))
  })

  it('discards a warm v11 versioned $0 exact hit so unchanged rollouts reprice', async () => {
    const cacheDir = join(tmpDir, 'cache')
    await mkdir(cacheDir, { recursive: true })
    const prev = process.env['CODEBURN_CACHE_DIR']
    process.env['CODEBURN_CACHE_DIR'] = cacheDir
    try {
      const filePath = await writeSession(tmpDir, '2026-04-14', 'rollout-stale-auto.jsonl', [
        sessionMeta({ session_id: 'sess-stale-auto', model: 'codex-auto-review' }),
        userMessage('review the PR'),
        tokenCount({
          timestamp: '2026-04-14T10:01:00Z',
          last: { input: 1_000_000, output: 1_000_000 },
          total: { total: 2_000_000 },
        }),
      ])
      const st = await stat(filePath)
      // Main's #1075 already owns v11. A colliding v11 $0 file must not be
      // treated as current after this PR takes v12.
      expect(CODEX_CACHE_VERSION).toBeGreaterThan(11)
      await writeFile(join(cacheDir, codexCacheFileName(11)), JSON.stringify({
        version: 11,
        files: {
          [filePath]: {
            mtimeMs: st.mtimeMs,
            sizeBytes: st.size,
            project: 'test',
            calls: [{
              model: 'codex-auto-review',
              costUSD: 0,
              inputTokens: 1_000_000,
              outputTokens: 1_000_000,
              deduplicationKey: 'stale',
            }],
          },
        },
      }))
      clearCodexMemCaches()
      const provider = createCodexProvider(tmpDir)
      const calls: ParsedProviderCall[] = []
      for await (const call of provider.createSessionParser({ path: filePath, project: 'test', provider: 'codex' }, new Set()).parse()) {
        calls.push(call)
      }
      expect(calls).toHaveLength(1)
      expect(calls[0]!.costUSD).toBeGreaterThan(0)
      expect(calls[0]!.costUSD).toBe(calculateCost('gpt-5.4', 1_000_000, 1_000_000, 0, 0, 0, 'standard', 0, 'codex'))
    } finally {
      clearCodexMemCaches()
      if (prev === undefined) delete process.env['CODEBURN_CACHE_DIR']
      else process.env['CODEBURN_CACHE_DIR'] = prev
    }
  })
})

// #1616: Codex's Fast speed setting bills through the priority service tier,
// which the rollout records per thread settings change
// (event_msg/thread_settings_applied -> payload.thread_settings.service_tier),
// never per call. The setting covers every turn after it in file order.
describe('codex provider - priority service tier (#1616)', () => {
  // gpt-5.4 as quoted from LiteLLM's live table: 2.5e-6 in / 15e-6 out /
  // 2.5e-7 cached read, with the priority tier exactly 2x on all three. The
  // bundled snapshot cannot carry the derived multiplier until its next routine
  // refresh, so install the live-parsed row for the duration of a test exactly
  // as fetchAndCachePricing would.
  const GPT54 = { input: 2.5e-6, output: 15e-6, cacheRead: 2.5e-7 }

  async function withLiveGpt54<T>(run: () => Promise<T>): Promise<T> {
    const snap = snapshotPricingState()
    const pricing = new Map(snap.pricing)
    const costs = parseLiteLLMEntry({
      input_cost_per_token: GPT54.input,
      output_cost_per_token: GPT54.output,
      cache_read_input_token_cost: GPT54.cacheRead,
      input_cost_per_token_priority: 5e-6,
      output_cost_per_token_priority: 30e-6,
      cache_read_input_token_cost_priority: 5e-7,
    } as never)
    if (costs) pricing.set('gpt-5.4', costs)
    restorePricingState({ ...snap, pricing })
    try {
      return await run()
    } finally {
      restorePricingState(snap)
    }
  }

  function threadSettings(tier: string | null, timestamp: string): string {
    return JSON.stringify({
      type: 'event_msg',
      timestamp,
      payload: {
        type: 'thread_settings_applied',
        // Older builds (and a settings record that predates the tier toggle)
        // carry no service_tier at all; `null` here omits the key entirely.
        thread_settings: {
          model: 'gpt-5.4',
          ...(tier === null ? {} : { service_tier: tier }),
          cwd: '/Users/test/myproject',
        },
      },
    })
  }

  async function parseCalls(lines: string[]): Promise<ParsedProviderCall[]> {
    const filePath = await writeSession(tmpDir, '2026-09-28', 'rollout-tier.jsonl', lines)
    const provider = createCodexProvider(tmpDir)
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser({ path: filePath, project: 'test', provider: 'codex' }, new Set()).parse()) {
      calls.push(call)
    }
    return calls
  }

  it('prices turns under service_tier "priority" at 2x and turns after a switch back at 1x', async () => {
    // calculateCost must run inside the injected-pricing window too, so the
    // reference values are captured alongside the parse.
    const { calls, fastRef, standardRef } = await withLiveGpt54(async () => ({
      calls: await parseCalls([
        sessionMeta({ session_id: 'sess-tier', model: 'gpt-5.4', timestamp: '2026-09-28T10:00:00Z' }),
        threadSettings('priority', '2026-09-28T10:00:01Z'),
        userMessage('fast turn one', '2026-09-28T10:01:00Z'),
        tokenCount({ timestamp: '2026-09-28T10:01:30Z', last: { input: 1000, cached: 200, output: 500 }, total: { input: 1000, cached: 200, output: 500, total: 1700 } }),
        userMessage('fast turn two', '2026-09-28T10:02:00Z'),
        tokenCount({ timestamp: '2026-09-28T10:02:30Z', last: { input: 1200, cached: 100, output: 400 }, total: { input: 2200, cached: 300, output: 900, total: 3400 } }),
        threadSettings('default', '2026-09-28T10:03:00Z'),
        userMessage('standard turn', '2026-09-28T10:04:00Z'),
        tokenCount({ timestamp: '2026-09-28T10:04:30Z', last: { input: 1000, cached: 200, output: 500 }, total: { input: 3200, cached: 500, output: 1400, total: 5100 } }),
      ]),
      fastRef: calculateCost('gpt-5.4', 800, 500, 0, 200, 0, 'fast', 0, 'codex'),
      standardRef: calculateCost('gpt-5.4', 800, 500, 0, 200, 0, 'standard', 0, 'codex'),
    }))

    expect(calls.map(call => call.speed)).toEqual(['fast', 'fast', 'standard'])

    // Explicit arithmetic, not self-consistency with calculateCost: the first
    // turn is 800 uncached input + 200 cached + 500 output, and the priority
    // tier doubles every published rate.
    const standard = 800 * GPT54.input + 200 * GPT54.cacheRead + 500 * GPT54.output
    expect(calls[0]!.costUSD).toBeCloseTo(standard * 2, 12)
    expect(calls[2]!.costUSD).toBeCloseTo(standard, 12)
    expect(calls[0]!.costUSD).toBe(fastRef)
    expect(calls[2]!.costUSD).toBe(standardRef)
  })

  it('accepts service_tier "fast" as an alias of "priority" (spec: a build may write the speed name)', async () => {
    // The spec's acceptance clause: `"fast"` must bill like `"priority"`. A
    // future "simplification" of speedForServiceTier to `tier === 'priority'`
    // would silently drop the alias, so pin it with the same 2x arithmetic.
    const { calls, fastRef } = await withLiveGpt54(async () => ({
      calls: await parseCalls([
        sessionMeta({ session_id: 'sess-tier-fast-alias', model: 'gpt-5.4', timestamp: '2026-09-28T10:00:00Z' }),
        threadSettings('fast', '2026-09-28T10:00:01Z'),
        userMessage('aliased fast turn', '2026-09-28T10:01:00Z'),
        tokenCount({ timestamp: '2026-09-28T10:01:30Z', last: { input: 1000, cached: 200, output: 500 }, total: { input: 1000, cached: 200, output: 500, total: 1700 } }),
      ]),
      fastRef: calculateCost('gpt-5.4', 800, 500, 0, 200, 0, 'fast', 0, 'codex'),
    }))

    expect(calls).toHaveLength(1)
    expect(calls[0]!.speed).toBe('fast')
    const standard = 800 * GPT54.input + 200 * GPT54.cacheRead + 500 * GPT54.output
    expect(calls[0]!.costUSD).toBeCloseTo(standard * 2, 12)
    expect(calls[0]!.costUSD).toBe(fastRef)
  })

  it('treats a settings record with no service_tier as the default tier', async () => {
    const calls = await parseCalls([
      sessionMeta({ session_id: 'sess-no-tier', model: 'gpt-5.4', timestamp: '2026-09-28T10:00:00Z' }),
      threadSettings(null, '2026-09-28T10:00:01Z'),
      userMessage('plain turn', '2026-09-28T10:01:00Z'),
      tokenCount({ timestamp: '2026-09-28T10:01:30Z', last: { input: 1000, cached: 200, output: 500 }, total: { input: 1000, cached: 200, output: 500, total: 1700 } }),
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.speed).toBe('standard')
  })

  it('reads service_tier out of an oversized thread_settings record', async () => {
    // The compact head decoder handles rollout lines past the buffer
    // threshold; service_tier sits early in the payload, so it must survive
    // that path too. The padding sits in a later field, exactly where a fat
    // permission profile or plugin list sits in a real record. The decoy
    // same-name key in an EARLIER payload field pins the depth-aware scan: a
    // naive first-match sweep of the head would read it as the tier, while
    // the full-JSON path only ever reads thread_settings.service_tier.
    const line = JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-09-28T10:00:01Z',
      payload: {
        type: 'thread_settings_applied',
        editor_context: { service_tier: 'default' },
        thread_settings: {
          model: 'gpt-5.4',
          service_tier: 'priority',
          cwd: '/Users/test/myproject',
          permission_profile: 'x'.repeat(70 * 1024),
        },
      },
    })
    const calls = await parseCalls([
      sessionMeta({ session_id: 'sess-big-tier', model: 'gpt-5.4', timestamp: '2026-09-28T10:00:00Z' }),
      line,
      userMessage('big settings turn', '2026-09-28T10:01:00Z'),
      tokenCount({ timestamp: '2026-09-28T10:01:30Z', last: { input: 1000, cached: 200, output: 500 }, total: { input: 1000, cached: 200, output: 500, total: 1700 } }),
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.speed).toBe('fast')
  })

  it('discards a warm v18 exact hit so priority turns reprice (#1075 pattern)', async () => {
    const cacheDir = join(tmpDir, 'cache')
    await mkdir(cacheDir, { recursive: true })
    const prev = process.env['CODEBURN_CACHE_DIR']
    process.env['CODEBURN_CACHE_DIR'] = cacheDir
    try {
      const filePath = await writeSession(tmpDir, '2026-09-28', 'rollout-stale-tier.jsonl', [
        sessionMeta({ session_id: 'sess-stale-tier', model: 'gpt-5.4', timestamp: '2026-09-28T10:00:00Z' }),
        threadSettings('priority', '2026-09-28T10:00:01Z'),
        userMessage('fast turn', '2026-09-28T10:01:00Z'),
        tokenCount({ timestamp: '2026-09-28T10:01:30Z', last: { input: 1000, cached: 200, output: 500 }, total: { input: 1000, cached: 200, output: 500, total: 1700 } }),
      ])
      const st = await stat(filePath)
      // Main's #1618 already owns v18, and that file holds the pre-fix
      // standard-rate cost (and speed) verbatim, so it must not be served.
      expect(CODEX_CACHE_VERSION).toBeGreaterThan(18)
      const standardCost = 800 * GPT54.input + 200 * GPT54.cacheRead + 500 * GPT54.output
      await writeFile(join(cacheDir, codexCacheFileName(18)), JSON.stringify({
        version: 18,
        files: {
          [filePath]: {
            mtimeMs: st.mtimeMs,
            sizeBytes: st.size,
            project: 'test',
            calls: [{
              provider: 'codex',
              model: 'gpt-5.4',
              inputTokens: 800,
              outputTokens: 500,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 200,
              cachedInputTokens: 200,
              reasoningTokens: 0,
              webSearchRequests: 0,
              costUSD: standardCost,
              tools: [],
              bashCommands: [],
              timestamp: '2026-09-28T10:01:30Z',
              speed: 'standard',
              deduplicationKey: 'stale-tier',
            }],
          },
        },
      }))
      clearCodexMemCaches()

      const calls = await withLiveGpt54(() => {
        const provider = createCodexProvider(tmpDir)
        const parsed: ParsedProviderCall[] = []
        return (async () => {
          for await (const call of provider.createSessionParser({ path: filePath, project: 'test', provider: 'codex' }, new Set()).parse()) {
            parsed.push(call)
          }
          return parsed
        })()
      })
      expect(calls).toHaveLength(1)
      expect(calls[0]!.speed).toBe('fast')
      expect(calls[0]!.costUSD).toBeCloseTo(standardCost * 2, 12)
    } finally {
      clearCodexMemCaches()
      if (prev === undefined) delete process.env['CODEBURN_CACHE_DIR']
      else process.env['CODEBURN_CACHE_DIR'] = prev
    }
  })
})


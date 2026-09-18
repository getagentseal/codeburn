import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, stat } from 'fs/promises'
import { basename, join } from 'path'
import { tmpdir } from 'os'

import { createCodexProvider } from '../../src/providers/codex.js'
import { clearCodexMemCaches, CODEX_CACHE_VERSION, codexCacheFileName } from '../../src/codex-cache.js'
import { calculateCost } from '../../src/models.js'
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
    // A mid-file session_meta carrying forked_from_id re-arms the fork-replay
    // cutoff, which swallows the task_started right behind it while its
    // task_complete lands past the cutoff. Attribution then has to span both
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

  it('does not double-count a fork that replays the parent past the 5s cutoff', async () => {
    // Parent does 1100 tokens of real work. The fork replays both events with
    // timestamps well beyond the 5s fork cutoff, then adds one genuine event
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

  it('does not overcount a total-only fork whose replay straddles the 5s cutoff', async () => {
    // The dedupe key must be derived from the cumulative token breakdown, not
    // per-event deltas. In the fallback branch (events with total_token_usage
    // but no last_token_usage), the delta is computed against a running `prev`.
    // A fork skips replays within 5s of the fork (prev NOT advanced), so a
    // replay kept just past the cutoff would compute a different delta than the
    // parent did and, with a delta-based key, fail to dedupe -> double-count.
    // The cumulative totals are copied verbatim, so a cumulative-based key
    // collides regardless of the cutoff. Parent does 300 tokens; the fork is a
    // pure replay (no new work), so the global total must stay 300.
    await writeSession(tmpDir, '2026-04-14', 'rollout-1-parent.jsonl', [
      sessionMeta({ session_id: 'sess-parent' }),
      tokenCount({ timestamp: '2026-04-14T10:00:01Z', total: { input: 100, total: 100 } }),
      tokenCount({ timestamp: '2026-04-14T10:00:02Z', total: { input: 200, total: 200 } }),
      tokenCount({ timestamp: '2026-04-14T10:00:03Z', total: { input: 300, total: 300 } }),
    ])
    await writeSession(tmpDir, '2026-04-14', 'rollout-2-fork.jsonl', [
      sessionMeta({ session_id: 'sess-fork', forked_from_id: 'sess-parent' }),
      // 10:00:01 is within the 5s cutoff -> skipped (prev not advanced).
      tokenCount({ timestamp: '2026-04-14T10:00:01Z', total: { input: 100, total: 100 } }),
      // These land past the cutoff and replay the parent's cumulative totals.
      tokenCount({ timestamp: '2026-04-14T10:00:08Z', total: { input: 200, total: 200 } }),
      tokenCount({ timestamp: '2026-04-14T10:00:09Z', total: { input: 300, total: 300 } }),
    ])

    const { tokens } = await aggregateTokens(tmpDir)
    expect(tokens).toBe(300)
  })
})

describe('codex auto-review pricing (#1047)', () => {
  it('parses auto-review as itself and prices it as GPT-5.5', async () => {
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
    expect(calls[0]!.costUSD).toBe(calculateCost('gpt-5.5', 1_000_000, 1_000_000, 0, 0, 0, 'standard', 0, 'codex'))
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
      expect(calls[0]!.costUSD).toBe(calculateCost('gpt-5.5', 1_000_000, 1_000_000, 0, 0, 0, 'standard', 0, 'codex'))
    } finally {
      clearCodexMemCaches()
      if (prev === undefined) delete process.env['CODEBURN_CACHE_DIR']
      else process.env['CODEBURN_CACHE_DIR'] = prev
    }
  })
})

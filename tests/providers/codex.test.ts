import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { createCodexProvider } from '../../src/providers/codex.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'codex-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function sessionMeta(opts: { cwd?: string; originator?: string; session_id?: string; model?: string; forked_from_id?: string; timestamp?: string } = {}) {
  return JSON.stringify({
    type: 'session_meta',
    timestamp: opts.timestamp ?? '2026-04-14T10:00:00Z',
    payload: {
      cwd: opts.cwd ?? '/Users/test/myproject',
      originator: opts.originator ?? 'codex-cli',
      session_id: opts.session_id ?? 'sess-001',
      model: opts.model ?? 'gpt-5.3-codex',
      ...(opts.forked_from_id ? { forked_from_id: opts.forked_from_id } : {}),
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

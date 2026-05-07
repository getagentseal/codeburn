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

function sessionMeta(opts: { cwd?: string; originator?: string; session_id?: string; model?: string } = {}) {
  return JSON.stringify({
    type: 'session_meta',
    timestamp: '2026-04-14T10:00:00Z',
    payload: {
      cwd: opts.cwd ?? '/Users/test/myproject',
      originator: opts.originator ?? 'codex-cli',
      session_id: opts.session_id ?? 'sess-001',
      model: opts.model ?? 'gpt-5.3-codex',
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

import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DateRange } from '../src/types.js'

let home: string
let cacheDir: string
let vibeHome: string
let clearParserCache: (() => void) | undefined

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'codeburn-turn-group-home-'))
  cacheDir = await mkdtemp(join(tmpdir(), 'codeburn-turn-group-cache-'))
  vibeHome = await mkdtemp(join(tmpdir(), 'codeburn-turn-group-vibe-'))
  process.env['HOME'] = home
  process.env['CODEBURN_CACHE_DIR'] = cacheDir
  process.env['VIBE_HOME'] = vibeHome
})

afterEach(async () => {
  clearParserCache?.()
  clearParserCache = undefined
  vi.resetModules()
  await rm(home, { recursive: true, force: true })
  await rm(cacheDir, { recursive: true, force: true })
  await rm(vibeHome, { recursive: true, force: true })
})

function dayRange(): DateRange {
  return {
    start: new Date('2026-05-16T00:00:00.000Z'),
    end: new Date('2026-05-16T23:59:59.999Z'),
  }
}

async function loadParser() {
  vi.resetModules()
  const parser = await import('../src/parser.js')
  clearParserCache = parser.clearSessionCache
  return parser.parseAllSessions
}

describe('provider turn grouping', () => {
  it('groups Gemini assistant messages under their user turn so retries are counted', async () => {
    const chatsDir = join(home, '.gemini', 'tmp', 'project-a', 'chats')
    await mkdir(chatsDir, { recursive: true })
    await writeFile(join(chatsDir, 'session-gemini.json'), JSON.stringify({
      sessionId: 'gemini-session-1',
      startTime: '2026-05-16T10:00:00.000Z',
      messages: [
        { id: 'u1', timestamp: '2026-05-16T10:00:00.000Z', type: 'user', content: 'implement parser update in src/parser.ts' },
        {
          id: 'g1',
          timestamp: '2026-05-16T10:00:05.000Z',
          type: 'gemini',
          content: 'editing',
          model: 'gemini-3.1-pro-preview',
          tokens: { input: 100, output: 30 },
          toolCalls: [{ id: 't1', name: 'edit_file', args: { path: 'src/parser.ts' } }],
        },
        {
          id: 'g2',
          timestamp: '2026-05-16T10:00:10.000Z',
          type: 'gemini',
          content: 'testing',
          model: 'gemini-3.1-pro-preview',
          tokens: { input: 80, output: 20 },
          toolCalls: [{ id: 't2', name: 'run_command', args: { command: 'npm test' } }],
        },
        {
          id: 'g3',
          timestamp: '2026-05-16T10:00:15.000Z',
          type: 'gemini',
          content: 'fixing after test',
          model: 'gemini-3.1-pro-preview',
          tokens: { input: 90, output: 25 },
          toolCalls: [{ id: 't3', name: 'edit_file', args: { path: 'src/parser.ts' } }],
        },
      ],
    }))

    const parseAllSessions = await loadParser()
    const projects = await parseAllSessions(dayRange(), 'gemini')
    const session = projects[0]!.sessions[0]!
    const turn = session.turns[0]!

    expect(session.turns).toHaveLength(1)
    expect(turn.assistantCalls.map(call => call.deduplicationKey)).toEqual([
      'gemini:gemini-session-1:g1',
      'gemini:gemini-session-1:g2',
      'gemini:gemini-session-1:g3',
    ])
    expect(turn.hasEdits).toBe(true)
    expect(turn.retries).toBe(1)
    expect(session.categoryBreakdown[turn.category].editTurns).toBe(1)
    expect(session.categoryBreakdown[turn.category].oneShotTurns).toBe(0)
  })

  it('classifies a range-sliced turn from the whole turn, not the surviving calls (#852)', async () => {
    const chatsDir = join(home, '.gemini', 'tmp', 'project-b', 'chats')
    await mkdir(chatsDir, { recursive: true })
    await writeFile(join(chatsDir, 'session-slice.json'), JSON.stringify({
      sessionId: 'gemini-slice-1',
      startTime: '2026-05-16T10:00:00.000Z',
      messages: [
        { id: 'u1', timestamp: '2026-05-16T10:00:00.000Z', type: 'user', content: 'read then edit src/parser.ts' },
        {
          id: 'g1', timestamp: '2026-05-16T10:00:00.000Z', type: 'gemini', content: 'reading',
          model: 'gemini-3.1-pro-preview', tokens: { input: 100, output: 30 },
          toolCalls: [{ id: 't1', name: 'read_file', args: { path: 'src/parser.ts' } }],
        },
        {
          id: 'g2', timestamp: '2026-05-16T11:00:00.000Z', type: 'gemini', content: 'editing',
          model: 'gemini-3.1-pro-preview', tokens: { input: 90, output: 25 },
          toolCalls: [{ id: 't2', name: 'edit_file', args: { path: 'src/parser.ts' } }],
        },
      ],
    }))

    const parseAllSessions = await loadParser()
    // A range that keeps the 10:00 Read call but excludes the 11:00 Edit call,
    // so the turn is sliced. `turnSlicedToRange`/`callsInRange` compare absolute
    // times, so this is timezone-independent.
    const sliceRange: DateRange = {
      start: new Date('2026-05-16T10:00:00.000Z'),
      end: new Date('2026-05-16T10:30:00.000Z'),
    }
    const projects = await parseAllSessions(sliceRange, 'gemini')
    const turn = projects[0]!.sessions[0]!.turns[0]!

    // Cost/calls are sliced to the range: only the Read call survives.
    expect(turn.assistantCalls.map(c => c.deduplicationKey)).toEqual(['gemini:gemini-slice-1:g1'])
    // But category/hasEdits are whole-turn judgments — the Edit is part of the
    // exchange — so they stay classified from the FULL turn, matching the Claude
    // path rather than being re-derived from the partial slice (which alone reads
    // as a no-edit exploration turn).
    expect(turn.hasEdits).toBe(true)
  })

  it('groups Mistral Vibe assistant messages and uses Vibe session_cost when present', async () => {
    const sessionDir = join(vibeHome, 'logs', 'session', 'session_20260516_100000_vibe')
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(sessionDir, 'meta.json'), JSON.stringify({
      session_id: 'vibe-session-1',
      start_time: '2026-05-16T10:00:00.000Z',
      end_time: '2026-05-16T10:01:00.000Z',
      environment: { working_directory: '/Users/test/project-a' },
      stats: {
        session_prompt_tokens: 300,
        session_completion_tokens: 90,
        session_cost: 0.123456,
        input_price_per_million: 100,
        output_price_per_million: 100,
      },
      config: { active_model: 'mistral-medium-3.5', models: [] },
      title: 'vibe parser update',
    }))
    await writeFile(join(sessionDir, 'messages.jsonl'), [
      { role: 'user', content: 'implement parser update in src/providers/mistral-vibe.ts', message_id: 'u1' },
      {
        role: 'assistant',
        content: 'editing',
        message_id: 'a1',
        tool_calls: [{ id: 't1', type: 'function', function: { name: 'search_replace', arguments: '{"file_path":"src/providers/mistral-vibe.ts"}' } }],
      },
      {
        role: 'assistant',
        content: 'testing',
        message_id: 'a2',
        tool_calls: [{ id: 't2', type: 'function', function: { name: 'bash', arguments: '{"command":"npm test"}' } }],
      },
      {
        role: 'assistant',
        content: 'fixing after test',
        message_id: 'a3',
        tool_calls: [{ id: 't3', type: 'function', function: { name: 'write_file', arguments: '{"path":"src/providers/mistral-vibe.ts"}' } }],
      },
    ].map(message => JSON.stringify(message)).join('\n') + '\n')

    const parseAllSessions = await loadParser()
    const projects = await parseAllSessions(dayRange(), 'mistral-vibe')
    const session = projects[0]!.sessions[0]!
    const turn = session.turns[0]!

    expect(session.turns).toHaveLength(1)
    expect(turn.assistantCalls.map(call => call.deduplicationKey)).toEqual([
      'mistral-vibe:vibe-session-1:a1',
      'mistral-vibe:vibe-session-1:a2',
      'mistral-vibe:vibe-session-1:a3',
    ])
    expect(turn.retries).toBe(1)
    expect(session.totalCostUSD).toBeCloseTo(0.123456, 8)
    expect(session.totalInputTokens).toBe(300)
    expect(session.totalOutputTokens).toBe(90)
    expect(session.categoryBreakdown[turn.category].oneShotTurns).toBe(0)
  })

  it('preserves Kiro credit-based cost through cache conversion instead of re-pricing from tokens', async () => {
    const kiroHome = join(home, '.kiro')
    const cliDir = join(kiroHome, 'sessions', 'cli')
    await mkdir(cliDir, { recursive: true })
    process.env['KIRO_HOME'] = kiroHome

    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeFile(join(cliDir, `${sessionId}.jsonl`), [
      JSON.stringify({ version: '1', kind: 'Prompt', data: { message_id: 'm1', content: [{ kind: 'text', data: 'hi' }], meta: { timestamp: 1778925600 } } }),
      JSON.stringify({ version: '1', kind: 'AssistantMessage', data: { message_id: 'm2', content: [{ kind: 'text', data: 'short reply' }] } }),
    ].join('\n') + '\n')
    await writeFile(join(cliDir, `${sessionId}.json`), JSON.stringify({
      session_id: sessionId,
      cwd: '/Users/test/project-a',
      created_at: '2026-05-16T10:00:00Z',
      updated_at: '2026-05-16T10:01:00Z',
      session_state: {
        rts_model_state: { model_info: { model_id: 'claude-sonnet-4.6' } },
        conversation_metadata: {
          user_turn_metadatas: [{
            end_timestamp: '2026-05-16T10:00:30Z',
            // 2.5 credits × $0.04/credit = $0.10 — far from any token estimate
            // of this tiny transcript, so passing means the metered cost was
            // preserved through providerCallToCachedCall/cachedCallToApiCall.
            metering_usage: [{ value: 2.5, unit: 'credit' }],
          }],
        },
      },
    }))

    try {
      const parseAllSessions = await loadParser()
      const projects = await parseAllSessions(dayRange(), 'kiro')
      const session = projects[0]!.sessions[0]!

      expect(session.totalCostUSD).toBeCloseTo(2.5 * 0.04, 8)
    } finally {
      delete process.env['KIRO_HOME']
    }
  })
})

describe('provider turn range filtering', () => {
  it('keeps the in-range calls of a codex turn that spans midnight instead of dropping the whole turn', async () => {
    // Regression test for #852: the range filter keyed on the turn's FIRST
    // call timestamp, so a long autonomous turn starting 23:59 the previous
    // day was excluded from the next day's view entirely, losing every
    // post-midnight call. One turn (t1) here has two token_count events
    // straddling midnight; only the post-midnight call may survive.
    const codexHome = join(home, 'codex')
    const sessionDir = join(codexHome, 'sessions', '2026', '05', '15')
    await mkdir(sessionDir, { recursive: true })
    const lines = [
      JSON.stringify({ type: 'session_meta', timestamp: '2026-05-15T23:55:00Z', payload: { session_id: 'sess-span', model: 'gpt-5.5', cwd: '/Users/test/project-a', originator: 'codex_cli_rs' } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-05-15T23:57:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run the long task' }] } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-05-15T23:58:00Z', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ command: 'npm test' }) } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-05-15T23:59:00Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, output_tokens: 30 }, total_token_usage: { total_tokens: 130 } } } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-05-16T00:10:00Z', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ command: 'npm run build' }) } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-05-16T00:15:00Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 80, output_tokens: 20 }, total_token_usage: { total_tokens: 230 } } } }),
    ]
    await writeFile(join(sessionDir, 'rollout-span.jsonl'), lines.join('\n') + '\n')

    process.env['CODEX_HOME'] = codexHome
    try {
      const parseAllSessions = await loadParser()
      const projects = await parseAllSessions(dayRange(), 'codex')
      const session = projects[0]!.sessions[0]!
      const turn = session.turns[0]!

      expect(session.turns).toHaveLength(1)
      expect(turn.assistantCalls.map(call => new Date(call.timestamp).toISOString())).toEqual([
        '2026-05-16T00:15:00.000Z',
      ])
      // The slice re-anchors the turn's timestamp from the user-message time
      // (2026-05-15T23:57Z) to the first surviving call, so turn-anchored
      // bucketing lands the slice on the day its calls actually fall in.
      expect(new Date(turn.timestamp).toISOString()).toBe('2026-05-16T00:15:00.000Z')
      expect(session.totalInputTokens).toBe(80)
      expect(session.totalOutputTokens).toBe(20)
    } finally {
      delete process.env['CODEX_HOME']
    }
  })

  it('re-anchors a turn whose calls ALL survive but whose anchor sits before the range', async () => {
    // The removal-path test above exercises a turn whose pre-range call is
    // dropped. This is the mirror case the first fix missed: a turn whose user
    // message predates the range but whose calls ALL land inside it. The early
    // return ("all calls survived") kept the pre-range anchor, so turn-anchored
    // stats (category, editTurns, session day) bucketed to the OLD day while
    // calls/cost landed on the new one. The slice must re-anchor to the first
    // in-range call whenever the anchor is wrong, not only when calls were cut.
    const codexHome = join(home, 'codex')
    const sessionDir = join(codexHome, 'sessions', '2026', '05', '15')
    await mkdir(sessionDir, { recursive: true })
    const lines = [
      JSON.stringify({ type: 'session_meta', timestamp: '2026-05-15T23:55:00Z', payload: { session_id: 'sess-anchor', model: 'gpt-5.5', cwd: '/Users/test/project-a', originator: 'codex_cli_rs' } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-05-15T23:57:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run the long task' }] } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-05-16T00:10:00Z', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ command: 'npm test' }) } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-05-16T00:15:00Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, output_tokens: 30 }, total_token_usage: { total_tokens: 130 } } } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-05-16T00:20:00Z', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ command: 'npm run build' }) } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-05-16T00:25:00Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 80, output_tokens: 20 }, total_token_usage: { total_tokens: 230 } } } }),
    ]
    await writeFile(join(sessionDir, 'rollout-anchor.jsonl'), lines.join('\n') + '\n')

    process.env['CODEX_HOME'] = codexHome
    try {
      const parseAllSessions = await loadParser()
      const projects = await parseAllSessions(dayRange(), 'codex')
      const session = projects[0]!.sessions[0]!
      const turn = session.turns[0]!

      // BOTH calls are inside the range — nothing was removed.
      expect(turn.assistantCalls.map(call => new Date(call.timestamp).toISOString())).toEqual([
        '2026-05-16T00:15:00.000Z',
        '2026-05-16T00:25:00.000Z',
      ])
      // Yet the anchor (user-message time, 2026-05-15T23:57Z) must re-anchor to
      // the first in-range call, or turn-anchored bucketing would land the
      // turn's stats on the day BEFORE the window while its calls land inside.
      expect(new Date(turn.timestamp).toISOString()).toBe('2026-05-16T00:15:00.000Z')
      expect(session.totalInputTokens).toBe(180)
      expect(session.totalOutputTokens).toBe(50)
    } finally {
      delete process.env['CODEX_HOME']
    }
  })
})

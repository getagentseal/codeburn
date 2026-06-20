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
})

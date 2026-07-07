import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { createCodexProvider } from '../../src/providers/codex.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'codex-jetbrains-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function line(entry: object): string {
  return JSON.stringify(entry)
}

function sessionMeta(): string {
  return line({
    type: 'session_meta',
    timestamp: '2026-07-06T16:07:01Z',
    payload: {
      cwd: '/Users/test/Tech-Ascension-Workspace',
      originator: 'JetBrains.IntelliJ IDEA',
      session_id: '019f3941-7d76-74d0-95eb-f0f0d70acdb2',
      model: 'gpt-5.5',
    },
  })
}

function turnContext(turnId: string, cwd: string): string {
  return line({
    type: 'turn_context',
    turn_id: turnId,
    timestamp: '2026-07-06T16:08:00Z',
    payload: { cwd, model: 'gpt-5.5' },
  })
}

function userMessage(turnId: string, text: string): string {
  return line({
    type: 'response_item',
    turn_id: turnId,
    timestamp: '2026-07-06T16:08:10Z',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
    },
  })
}

function tokenCount(turnId: string, input: number, output: number, total: number): string {
  return line({
    type: 'event_msg',
    turn_id: turnId,
    timestamp: '2026-07-06T16:08:30Z',
    payload: {
      type: 'token_count',
      info: {
        model: 'gpt-5.5',
        last_token_usage: {
          input_tokens: input,
          output_tokens: output,
          total_tokens: input + output,
        },
        total_token_usage: {
          input_tokens: total,
          output_tokens: output,
          total_tokens: total + output,
        },
      },
    },
  })
}

async function writeSession(lines: string[]): Promise<string> {
  const sessionDir = join(tmpDir, 'sessions', '2026', '07', '06')
  await mkdir(sessionDir, { recursive: true })
  const path = join(sessionDir, 'rollout-jetbrains.jsonl')
  await writeFile(path, lines.join('\n') + '\n')
  return path
}

async function parse(path: string): Promise<ParsedProviderCall[]> {
  const provider = createCodexProvider(tmpDir)
  const parser = provider.createSessionParser({ path, project: 'Tech-Ascension-Workspace', provider: 'codex' }, new Set())
  const calls: ParsedProviderCall[] = []
  for await (const call of parser.parse()) calls.push(call)
  return calls
}

describe('codex provider - JetBrains IntelliJ ACP sessions', () => {
  it('discovers Codex rollout files created by JetBrains IntelliJ ACP', async () => {
    await writeSession([
      sessionMeta(),
      tokenCount('turn-a', 100, 50, 100),
    ])

    const sessions = await createCodexProvider(tmpDir).discoverSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.provider).toBe('codex')
    expect(sessions[0]!.project).toBe('Users-test-Tech-Ascension-Workspace')
  })

  it('splits JetBrains ACP turns by turn id without splitting normal Codex turns', async () => {
    const path = await writeSession([
      sessionMeta(),
      turnContext('019f3941-cabb-7281-b95b-14e2f422a72b', '/Users/test/.cache/JetBrains/IntelliJIdea2026.1/aia/agents/task-a'),
      userMessage('019f3941-cabb-7281-b95b-14e2f422a72b', 'first JetBrains task'),
      tokenCount('019f3941-cabb-7281-b95b-14e2f422a72b', 100, 50, 100),
      turnContext('019f394d-29db-7930-b072-e0fdbcae54dd', '/Users/test/.cache/JetBrains/IntelliJIdea2026.1/aia/agents/task-b'),
      userMessage('019f394d-29db-7930-b072-e0fdbcae54dd', 'second JetBrains task'),
      tokenCount('019f394d-29db-7930-b072-e0fdbcae54dd', 100, 50, 100),
      turnContext('normal-turn', '/Users/test/Tech-Ascension-Workspace'),
      userMessage('normal-turn', 'normal Codex task'),
      tokenCount('normal-turn', 300, 70, 600),
    ])

    const calls = await parse(path)

    expect(calls.map(call => call.sessionId)).toEqual([
      '019f3941-7d76-74d0-95eb-f0f0d70acdb2:jetbrains:019f3941-cabb-7281-b95b-14e2f422a72b',
      '019f3941-7d76-74d0-95eb-f0f0d70acdb2:jetbrains:019f394d-29db-7930-b072-e0fdbcae54dd',
      '019f3941-7d76-74d0-95eb-f0f0d70acdb2',
    ])
  })
})

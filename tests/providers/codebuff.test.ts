import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { createCodebuffProvider } from '../../src/providers/codebuff.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'codebuff-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

type ToolBlock = {
  type: 'tool'
  toolName: string
  input?: Record<string, unknown>
}

type TextBlock = { type: 'text'; content: string }

type Block = ToolBlock | TextBlock

type AiOpts = {
  id?: string
  credits?: number
  timestamp?: string
  blocks?: Block[]
  metadata?: Record<string, unknown>
}

function aiMessage(opts: AiOpts = {}) {
  const m: Record<string, unknown> = {
    id: opts.id ?? 'msg-ai-1',
    variant: 'ai',
    content: '',
    timestamp: opts.timestamp ?? '2026-04-14T10:00:30.000Z',
  }
  if (opts.blocks !== undefined) m['blocks'] = opts.blocks
  if (opts.credits !== undefined) m['credits'] = opts.credits
  if (opts.metadata !== undefined) m['metadata'] = opts.metadata
  return m
}

function userMessage(content: string, timestamp?: string) {
  return {
    id: 'msg-user-1',
    variant: 'user',
    content,
    timestamp: timestamp ?? '2026-04-14T10:00:10.000Z',
  }
}

async function writeChat(
  baseDir: string,
  projectName: string,
  chatId: string,
  messages: unknown[],
  runState?: unknown,
): Promise<string> {
  const chatDir = join(baseDir, 'projects', projectName, 'chats', chatId)
  await mkdir(chatDir, { recursive: true })
  await writeFile(join(chatDir, 'chat-messages.json'), JSON.stringify(messages))
  if (runState !== undefined) {
    await writeFile(join(chatDir, 'run-state.json'), JSON.stringify(runState))
  }
  return chatDir
}

describe('codebuff provider - session discovery', () => {
  it('discovers sessions under projects/<name>/chats/<chatId>/', async () => {
    await writeChat(
      tmpDir,
      'myproject',
      '2026-04-14T10-00-00.000Z',
      [userMessage('hi'), aiMessage({ credits: 10 })],
      { sessionState: { projectContext: { cwd: '/Users/test/myproject' } } },
    )

    const provider = createCodebuffProvider(tmpDir)
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.provider).toBe('codebuff')
    expect(sessions[0]!.project).toBe('myproject')
    expect(sessions[0]!.path).toContain('2026-04-14T10-00-00.000Z')
  })

  it('uses the cwd basename from run-state.json when present', async () => {
    await writeChat(
      tmpDir,
      'sanitized-folder',
      '2026-04-14T11-00-00.000Z',
      [aiMessage({ credits: 5 })],
      { sessionState: { projectContext: { cwd: '/Users/test/real-project' } } },
    )

    const provider = createCodebuffProvider(tmpDir)
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.project).toBe('real-project')
  })

  it('falls back to the folder name when run-state.json is missing', async () => {
    await writeChat(tmpDir, 'fallback-project', '2026-04-14T12-00-00.000Z', [
      aiMessage({ credits: 3 }),
    ])

    const provider = createCodebuffProvider(tmpDir)
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.project).toBe('fallback-project')
  })

  it('discovers sessions across multiple projects', async () => {
    await writeChat(tmpDir, 'proj-a', '2026-04-14T10-00-00.000Z', [aiMessage({ credits: 1 })])
    await writeChat(tmpDir, 'proj-b', '2026-04-14T10-30-00.000Z', [aiMessage({ credits: 2 })])

    const provider = createCodebuffProvider(tmpDir)
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(2)
    const projects = sessions.map(s => s.project).sort()
    expect(projects).toEqual(['proj-a', 'proj-b'])
  })

  it('returns empty for a non-existent directory', async () => {
    const provider = createCodebuffProvider('/nonexistent/codebuff-path')
    const sessions = await provider.discoverSessions()
    expect(sessions).toEqual([])
  })

  it('skips chat folders without chat-messages.json', async () => {
    const chatDir = join(tmpDir, 'projects', 'proj', 'chats', '2026-04-14T10-00-00.000Z')
    await mkdir(chatDir, { recursive: true })
    // No chat-messages.json created.

    const provider = createCodebuffProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toEqual([])
  })
})

describe('codebuff provider - JSONL parsing', () => {
  it('yields one call per assistant message with credits, mapping codebuff tools to canonical names', async () => {
    const chatDir = await writeChat(
      tmpDir,
      'proj',
      '2026-04-14T10-00-00.000Z',
      [
        userMessage('implement the feature'),
        aiMessage({
          credits: 42,
          metadata: {
            runState: { sessionState: { mainAgentState: { agentType: 'base2' } } },
          },
          blocks: [
            { type: 'tool', toolName: 'read_files', input: {} },
            { type: 'tool', toolName: 'str_replace', input: {} },
            { type: 'tool', toolName: 'run_terminal_command', input: { command: 'npm test' } },
            { type: 'tool', toolName: 'suggest_followups', input: {} },
          ],
        }),
      ],
    )

    const provider = createCodebuffProvider(tmpDir)
    const source = { path: chatDir, project: 'proj', provider: 'codebuff' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(call)
    }

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.provider).toBe('codebuff')
    expect(call.model).toBe('codebuff-base2')
    expect(call.userMessage).toBe('implement the feature')
    // `suggest_followups` is intentionally dropped from the tool breakdown.
    expect(call.tools).toEqual(['Read', 'Edit', 'Bash'])
    expect(call.bashCommands).toContain('npm')
    // Credits × $0.01 = $0.42 when token counts are absent.
    expect(call.costUSD).toBeCloseTo(0.42, 6)
    expect(call.inputTokens).toBe(0)
    expect(call.outputTokens).toBe(0)
  })

  it('prefers direct metadata.usage tokens when available and still records credits', async () => {
    const chatDir = await writeChat(tmpDir, 'proj', '2026-04-14T10-00-00.000Z', [
      aiMessage({
        credits: 10,
        metadata: {
          model: 'claude-haiku-4-5-20251001',
          usage: {
            inputTokens: 5000,
            outputTokens: 2000,
            cacheCreationInputTokens: 1000,
            cacheReadInputTokens: 500,
          },
        },
      }),
    ])

    const provider = createCodebuffProvider(tmpDir)
    const source = { path: chatDir, project: 'proj', provider: 'codebuff' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(call)
    }

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.model).toBe('claude-haiku-4-5-20251001')
    expect(call.inputTokens).toBe(5000)
    expect(call.outputTokens).toBe(2000)
    expect(call.cacheCreationInputTokens).toBe(1000)
    expect(call.cacheReadInputTokens).toBe(500)
    expect(call.cachedInputTokens).toBe(500)
    // With real token counts the calculated cost takes precedence over credits.
    expect(call.costUSD).toBeGreaterThan(0)
  })

  it('falls back to providerOptions.codebuff.usage in the stashed RunState history', async () => {
    const chatDir = await writeChat(tmpDir, 'proj', '2026-04-14T10-00-00.000Z', [
      aiMessage({
        credits: 7,
        metadata: {
          runState: {
            sessionState: {
              mainAgentState: {
                messageHistory: [
                  { role: 'user' },
                  {
                    role: 'assistant',
                    providerOptions: {
                      codebuff: {
                        model: 'openai/gpt-4o',
                        usage: {
                          prompt_tokens: 2000,
                          completion_tokens: 800,
                          prompt_tokens_details: { cached_tokens: 400 },
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      }),
    ])

    const provider = createCodebuffProvider(tmpDir)
    const source = { path: chatDir, project: 'proj', provider: 'codebuff' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(call)
    }

    expect(calls).toHaveLength(1)
    expect(calls[0]!.model).toBe('openai/gpt-4o')
    expect(calls[0]!.inputTokens).toBe(2000)
    expect(calls[0]!.outputTokens).toBe(800)
    expect(calls[0]!.cacheReadInputTokens).toBe(400)
  })

  it('skips assistant messages with no credits and no tokens', async () => {
    const chatDir = await writeChat(tmpDir, 'proj', '2026-04-14T10-00-00.000Z', [
      aiMessage({ blocks: [{ type: 'text', content: 'mode-divider' }] }),
    ])

    const provider = createCodebuffProvider(tmpDir)
    const source = { path: chatDir, project: 'proj', provider: 'codebuff' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(call)
    }

    expect(calls).toHaveLength(0)
  })

  it('deduplicates calls seen across multiple parses', async () => {
    const chatDir = await writeChat(tmpDir, 'proj', '2026-04-14T10-00-00.000Z', [
      aiMessage({ id: 'msg-dup', credits: 3 }),
    ])

    const provider = createCodebuffProvider(tmpDir)
    const source = { path: chatDir, project: 'proj', provider: 'codebuff' }
    const seenKeys = new Set<string>()

    const firstRun: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, seenKeys).parse()) {
      firstRun.push(call)
    }

    const secondRun: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, seenKeys).parse()) {
      secondRun.push(call)
    }

    expect(firstRun).toHaveLength(1)
    expect(secondRun).toHaveLength(0)
  })

  it('yields one call per assistant message in a multi-turn chat, preserving user messages', async () => {
    const chatDir = await writeChat(tmpDir, 'proj', '2026-04-14T10-00-00.000Z', [
      userMessage('first question'),
      aiMessage({ id: 'a1', credits: 5, timestamp: '2026-04-14T10:00:30.000Z' }),
      userMessage('second question', '2026-04-14T10:01:00.000Z'),
      aiMessage({ id: 'a2', credits: 8, timestamp: '2026-04-14T10:01:30.000Z' }),
    ])

    const provider = createCodebuffProvider(tmpDir)
    const source = { path: chatDir, project: 'proj', provider: 'codebuff' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(call)
    }

    expect(calls).toHaveLength(2)
    expect(calls[0]!.userMessage).toBe('first question')
    expect(calls[0]!.costUSD).toBeCloseTo(0.05, 6)
    expect(calls[1]!.userMessage).toBe('second question')
    expect(calls[1]!.costUSD).toBeCloseTo(0.08, 6)
  })

  it('handles a missing chat-messages.json gracefully', async () => {
    const provider = createCodebuffProvider(tmpDir)
    const source = {
      path: join(tmpDir, 'projects', 'missing', 'chats', 'nope'),
      project: 'missing',
      provider: 'codebuff',
    }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(call)
    }
    expect(calls).toHaveLength(0)
  })

  it('skips a malformed chat-messages.json without throwing', async () => {
    const chatDir = join(tmpDir, 'projects', 'proj', 'chats', '2026-04-14T10-00-00.000Z')
    await mkdir(chatDir, { recursive: true })
    await writeFile(join(chatDir, 'chat-messages.json'), 'not-valid-json')

    const provider = createCodebuffProvider(tmpDir)
    const source = { path: chatDir, project: 'proj', provider: 'codebuff' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(call)
    }
    expect(calls).toHaveLength(0)
  })
})

describe('codebuff provider - display names', () => {
  const provider = createCodebuffProvider('/tmp')

  it('has the correct identifiers', () => {
    expect(provider.name).toBe('codebuff')
    expect(provider.displayName).toBe('Codebuff')
  })

  it('maps known Codebuff tiers to readable names', () => {
    expect(provider.modelDisplayName('codebuff')).toBe('Codebuff')
    expect(provider.modelDisplayName('codebuff-base2')).toBe('Codebuff Base 2')
    expect(provider.modelDisplayName('codebuff-lite')).toBe('Codebuff Lite')
  })

  it('returns the raw name for unknown models', () => {
    expect(provider.modelDisplayName('claude-sonnet-4-6')).toBe('claude-sonnet-4-6')
  })

  it('normalizes tool names to the canonical set', () => {
    expect(provider.toolDisplayName('read_files')).toBe('Read')
    expect(provider.toolDisplayName('str_replace')).toBe('Edit')
    expect(provider.toolDisplayName('run_terminal_command')).toBe('Bash')
    expect(provider.toolDisplayName('unknown_tool')).toBe('unknown_tool')
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { createMuxProvider } from '../../src/providers/mux.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'mux-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

// ~/.mux/config.json shape: { projects: Array<[projectPath, { workspaces: [{ id }] }]> }
async function writeConfig(root: string, entries: Array<[string, string[]]>) {
  const data = {
    projects: entries.map(([projectPath, ids]) => [
      projectPath,
      { workspaces: ids.map(id => ({ id, name: 'main', path: `${projectPath}/wt-${id}` })) },
    ]),
  }
  await writeFile(join(root, 'config.json'), JSON.stringify(data))
}

async function writeWorkspace(root: string, workspaceId: string, lines: string[]) {
  const dir = join(root, 'sessions', workspaceId)
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, 'chat.jsonl')
  await writeFile(filePath, lines.join('\n') + '\n')
  return filePath
}

// Sub-agent transcripts live nested under the parent workspace, not as a
// top-level sessions/<id> dir.
async function writeSubagent(root: string, workspaceId: string, childTaskId: string, lines: string[]) {
  const dir = join(root, 'sessions', workspaceId, 'subagent-transcripts', childTaskId)
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, 'chat.jsonl')
  await writeFile(filePath, lines.join('\n') + '\n')
  return filePath
}

function userMessage(text: string, id = 'msg-user-1') {
  return JSON.stringify({
    id,
    role: 'user',
    parts: [{ type: 'text', text }],
    metadata: { historySequence: 0, timestamp: 1776023210000 },
  })
}

type AsstOpts = {
  id?: string
  timestamp?: number
  model?: string
  input?: number
  output?: number
  reasoning?: number
  cacheRead?: number
  cacheCreate?: number
  tools?: Array<{ name: string; script?: string }>
  text?: string
}

function assistantMessage(opts: AsstOpts = {}) {
  const parts: Array<Record<string, unknown>> = [{ type: 'text', text: opts.text ?? 'done' }]
  for (const t of opts.tools ?? []) {
    parts.push({
      type: 'dynamic-tool',
      toolCallId: `call-${t.name}`,
      toolName: t.name,
      input: t.script !== undefined ? { script: t.script } : {},
      state: 'output-available',
      output: {},
    })
  }
  const metadata: Record<string, unknown> = {
    historySequence: 1,
    model: opts.model ?? 'anthropic:claude-opus-4-8',
    timestamp: opts.timestamp ?? 1776023230000,
    usage: {
      inputTokens: opts.input ?? 1000,
      outputTokens: opts.output ?? 200,
      reasoningTokens: opts.reasoning ?? 0,
      cachedInputTokens: opts.cacheRead ?? 0,
    },
    ...(opts.cacheCreate
      ? { providerMetadata: { anthropic: { cacheCreationInputTokens: opts.cacheCreate } } }
      : {}),
  }
  return JSON.stringify({ id: opts.id ?? 'msg-asst-1', role: 'assistant', parts, metadata })
}

describe('mux provider - session discovery', () => {
  it('discovers chat.jsonl per workspace and resolves project from config.json', async () => {
    await writeWorkspace(tmpDir, 'ws-abc', [userMessage('hi'), assistantMessage({})])
    await writeConfig(tmpDir, [['/Users/test/myproject', ['ws-abc']]])

    const provider = createMuxProvider(tmpDir)
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.provider).toBe('mux')
    expect(sessions[0]!.project).toBe('myproject')
    expect(sessions[0]!.path).toContain(join('sessions', 'ws-abc', 'chat.jsonl'))
  })

  it('falls back to the workspaceId when config.json has no mapping', async () => {
    await writeWorkspace(tmpDir, 'ws-orphan', [assistantMessage({})])
    // no config.json written

    const provider = createMuxProvider(tmpDir)
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.project).toBe('ws-orphan')
  })

  it('discovers multiple workspaces across projects', async () => {
    await writeWorkspace(tmpDir, 'ws-1', [assistantMessage({})])
    await writeWorkspace(tmpDir, 'ws-2', [assistantMessage({})])
    await writeConfig(tmpDir, [
      ['/Users/test/project-a', ['ws-1']],
      ['/Users/test/project-b', ['ws-2']],
    ])

    const provider = createMuxProvider(tmpDir)
    const sessions = await provider.discoverSessions()

    expect(sessions.map(s => s.project).sort()).toEqual(['project-a', 'project-b'])
  })

  it('returns empty for a non-existent root', async () => {
    const provider = createMuxProvider('/nonexistent/path/that/does/not/exist')
    expect(await provider.discoverSessions()).toEqual([])
  })

  it('skips workspace directories without a chat.jsonl', async () => {
    await mkdir(join(tmpDir, 'sessions', 'ws-empty'), { recursive: true })
    const provider = createMuxProvider(tmpDir)
    expect(await provider.discoverSessions()).toEqual([])
  })

  it('discovers sub-agent transcripts and attributes them to the parent project', async () => {
    await writeWorkspace(tmpDir, 'ws-parent', [assistantMessage({ id: 'parent-1' })])
    await writeSubagent(tmpDir, 'ws-parent', 'child-a', [assistantMessage({ id: 'child-a-1' })])
    await writeSubagent(tmpDir, 'ws-parent', 'child-b', [assistantMessage({ id: 'child-b-1' })])
    await writeConfig(tmpDir, [['/Users/test/myproject', ['ws-parent']]])

    const provider = createMuxProvider(tmpDir)
    const sessions = await provider.discoverSessions()

    // parent chat.jsonl + two sub-agent transcripts, all under one project.
    expect(sessions).toHaveLength(3)
    expect(sessions.every(s => s.project === 'myproject')).toBe(true)
    const subagentPaths = sessions
      .map(s => s.path)
      .filter(p => p.includes('subagent-transcripts'))
      .sort()
    expect(subagentPaths).toHaveLength(2)
    expect(subagentPaths[0]).toContain(join('subagent-transcripts', 'child-a', 'chat.jsonl'))
  })

  it('discovers a sub-agent transcript even when the workspace has no top-level chat.jsonl', async () => {
    // mkdir the workspace dir without a chat.jsonl, but with a sub-agent transcript.
    await writeSubagent(tmpDir, 'ws-parent', 'child-only', [assistantMessage({ id: 'child-only-1' })])

    const provider = createMuxProvider(tmpDir)
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.path).toContain(join('subagent-transcripts', 'child-only', 'chat.jsonl'))
  })

  it('counts sub-agent calls once, with a workspace-distinct dedup key', async () => {
    const seenKeys = new Set<string>()
    await writeWorkspace(tmpDir, 'ws-parent', [assistantMessage({ id: 'shared-id', input: 100 })])
    // Same message id inside the sub-agent must NOT collide with the parent's.
    await writeSubagent(tmpDir, 'ws-parent', 'child-a', [assistantMessage({ id: 'shared-id', input: 200 })])

    const provider = createMuxProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    const calls: ParsedProviderCall[] = []
    for (const source of sessions) {
      for await (const call of provider.createSessionParser(source, seenKeys).parse()) calls.push(call)
    }

    expect(calls).toHaveLength(2)
    expect(new Set(calls.map(c => c.deduplicationKey))).toEqual(
      new Set(['mux:ws-parent:shared-id', 'mux:child-a:shared-id']),
    )
    expect(calls.map(c => c.sessionId).sort()).toEqual(['child-a', 'ws-parent'])
  })
})

describe('mux provider - chat.jsonl parsing', () => {
  it('decomposes inclusive input/output usage into codeburn token fields', async () => {
    // input is inclusive of cache; output is inclusive of reasoning.
    const filePath = await writeWorkspace(tmpDir, 'ws-abc', [
      userMessage('implement the feature'),
      assistantMessage({
        id: 'msg-1',
        input: 1000,
        output: 230,
        reasoning: 30,
        cacheRead: 200,
        cacheCreate: 50,
      }),
    ])

    const provider = createMuxProvider(tmpDir)
    const source = { path: filePath, project: 'myproject', provider: 'mux' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(call)
    }

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.provider).toBe('mux')
    expect(call.model).toBe('claude-opus-4-8') // provider prefix stripped so codeburn prices/displays it
    expect(call.inputTokens).toBe(750) // 1000 - 200 cacheRead - 50 cacheCreate
    expect(call.outputTokens).toBe(200) // 230 - 30 reasoning
    expect(call.reasoningTokens).toBe(30)
    expect(call.cacheReadInputTokens).toBe(200)
    expect(call.cachedInputTokens).toBe(200)
    expect(call.cacheCreationInputTokens).toBe(50)
    expect(call.webSearchRequests).toBe(0)
    expect(call.sessionId).toBe('ws-abc')
    expect(call.userMessage).toBe('implement the feature')
    expect(call.timestamp).toBe(new Date(1776023230000).toISOString())
    expect(call.costUSD).toBeGreaterThan(0)
    expect(call.deduplicationKey).toBe('mux:ws-abc:msg-1')
  })

  it('maps tool names and extracts bash command programs', async () => {
    const filePath = await writeWorkspace(tmpDir, 'ws-abc', [
      assistantMessage({
        tools: [
          { name: 'file_read' },
          { name: 'file_edit_replace_string' },
          { name: 'bash', script: 'git status && bun test' },
        ],
      }),
    ])

    const provider = createMuxProvider(tmpDir)
    const source = { path: filePath, project: 'myproject', provider: 'mux' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(call)
    }

    expect(calls[0]!.tools).toEqual(['Read', 'Edit', 'Bash'])
    expect(calls[0]!.bashCommands).toEqual(['git', 'bun'])
  })

  it('skips assistant messages without a usage blob', async () => {
    const filePath = await writeWorkspace(tmpDir, 'ws-abc', [
      JSON.stringify({
        id: 'no-usage',
        role: 'assistant',
        parts: [{ type: 'text', text: 'thinking...' }],
        metadata: { model: 'anthropic:claude-opus-4-8', timestamp: 1 },
      }),
    ])

    const provider = createMuxProvider(tmpDir)
    const source = { path: filePath, project: 'myproject', provider: 'mux' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(call)
    }
    expect(calls).toHaveLength(0)
  })

  it('skips assistant messages with all-zero tokens', async () => {
    const filePath = await writeWorkspace(tmpDir, 'ws-abc', [
      assistantMessage({ input: 0, output: 0 }),
    ])

    const provider = createMuxProvider(tmpDir)
    const source = { path: filePath, project: 'myproject', provider: 'mux' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(call)
    }
    expect(calls).toHaveLength(0)
  })

  it('deduplicates calls seen across multiple parses', async () => {
    const filePath = await writeWorkspace(tmpDir, 'ws-abc', [assistantMessage({ id: 'dup' })])

    const provider = createMuxProvider(tmpDir)
    const source = { path: filePath, project: 'myproject', provider: 'mux' }
    const seenKeys = new Set<string>()

    const first: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, seenKeys).parse()) first.push(call)
    const second: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, seenKeys).parse()) second.push(call)

    expect(first).toHaveLength(1)
    expect(second).toHaveLength(0)
  })

  it('yields one call per assistant message and pairs the preceding user prompt', async () => {
    const filePath = await writeWorkspace(tmpDir, 'ws-multi', [
      userMessage('first question', 'u1'),
      assistantMessage({ id: 'a1', input: 500, output: 100 }),
      userMessage('second question', 'u2'),
      assistantMessage({ id: 'a2', input: 600, output: 120 }),
    ])

    const provider = createMuxProvider(tmpDir)
    const source = { path: filePath, project: 'myproject', provider: 'mux' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(2)
    expect(calls[0]!.userMessage).toBe('first question')
    expect(calls[0]!.inputTokens).toBe(500)
    expect(calls[1]!.userMessage).toBe('second question')
    expect(calls[1]!.inputTokens).toBe(600)
  })

  it('handles a missing session file gracefully', async () => {
    const provider = createMuxProvider(tmpDir)
    const source = { path: join(tmpDir, 'sessions', 'nope', 'chat.jsonl'), project: 'x', provider: 'mux' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) calls.push(call)
    expect(calls).toHaveLength(0)
  })

  it('keeps distinct id-less assistant messages via the line-index fallback', async () => {
    const asst = (text: string, input: number) =>
      JSON.stringify({
        role: 'assistant',
        parts: [{ type: 'text', text }],
        // No `id`, identical historySequence — the fallback must stay unique.
        metadata: { model: 'anthropic:claude-opus-4-8', timestamp: 1, historySequence: 5, usage: { inputTokens: input, outputTokens: 5 } },
      })
    const filePath = await writeWorkspace(tmpDir, 'ws-noid', [asst('a', 10), asst('b', 11)])

    const provider = createMuxProvider(tmpDir)
    const source = { path: filePath, project: 'p', provider: 'mux' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(2)
    expect(new Set(calls.map(c => c.deduplicationKey)).size).toBe(2)
  })

  it('tolerates malformed lines without dropping later valid turns', async () => {
    const filePath = await writeWorkspace(tmpDir, 'ws-abc', [
      // parts is an object, not an array (corrupt) — must not throw the loop
      JSON.stringify({ id: 'bad-parts', role: 'assistant', parts: { type: 'text', text: 'x' }, metadata: { model: 'anthropic:claude-opus-4-8', timestamp: 1, usage: { inputTokens: 10, outputTokens: 5 } } }),
      // out-of-range timestamp — must not throw; timestamp falls back to ''
      JSON.stringify({ id: 'bad-ts', role: 'assistant', parts: [{ type: 'text', text: 'x' }], metadata: { model: 'anthropic:claude-opus-4-8', timestamp: 1.7e18, usage: { inputTokens: 10, outputTokens: 5 } } }),
      assistantMessage({ id: 'good', input: 100, output: 20 }),
    ])

    const provider = createMuxProvider(tmpDir)
    const source = { path: filePath, project: 'p', provider: 'mux' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) calls.push(call)

    expect(calls).toHaveLength(3) // none of the malformed lines aborted the parse
    expect(calls.find(c => c.deduplicationKey === 'mux:ws-abc:good')?.inputTokens).toBe(100)
    expect(calls.find(c => c.deduplicationKey === 'mux:ws-abc:bad-ts')?.timestamp).toBe('')
  })
})

describe('mux provider - display names', () => {
  const provider = createMuxProvider('/tmp')

  it('has correct name and displayName', () => {
    expect(provider.name).toBe('mux')
    expect(provider.displayName).toBe('Mux')
  })

  it('strips the provider prefix and humanizes the model', () => {
    expect(provider.modelDisplayName('anthropic:claude-opus-4-8')).toBe('Opus 4.8')
    expect(provider.modelDisplayName('anthropic:claude-sonnet-4-6')).toBe('Sonnet 4.6')
  })

  it('returns the bare id for unknown / prefixless models', () => {
    expect(provider.modelDisplayName('ollama:some-random-model')).toBe('some-random-model')
    expect(provider.modelDisplayName('some-random-model')).toBe('some-random-model')
  })

  it('normalizes tool names to the canonical set', () => {
    expect(provider.toolDisplayName('bash')).toBe('Bash')
    expect(provider.toolDisplayName('file_read')).toBe('Read')
    expect(provider.toolDisplayName('file_edit_insert')).toBe('Edit')
    expect(provider.toolDisplayName('task')).toBe('Agent')
    expect(provider.toolDisplayName('unknown_tool')).toBe('unknown_tool')
  })
})

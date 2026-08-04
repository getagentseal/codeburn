import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { openclaude, createOpenClaudeProvider, getOpenClaudeProjectsDir } from '../../src/providers/openclaude.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'
import { calculateCost, loadPricing } from '../../src/models.js'

let tmpDir: string
let uuidSeq: number
let msgSeq: number

function nextUuid(): string {
  uuidSeq += 1
  return `00000000-0000-4000-8000-${String(uuidSeq).padStart(12, '0')}`
}

function nextMessageId(): string {
  msgSeq += 1
  return `msg_${msgSeq}`
}

type UsageSpec = {
  inputTokens?: number
  outputTokens?: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
  webSearchRequests?: number
}

type ContentBlock = Record<string, unknown>

type MessageSpec = {
  role: 'user' | 'assistant'
  id?: string
  model?: string
  text?: string
  content?: ContentBlock[]
  usage?: UsageSpec | null
}

type EventSpec = {
  type: 'user' | 'assistant' | 'queue-operation' | 'last-prompt'
  sessionId?: string
  timestamp?: string
  uuid?: string
  cwd?: string
  slug?: string
  isSidechain?: boolean
  message?: MessageSpec
  payload?: Record<string, unknown>
}

const DEFAULT_TIMESTAMP = '2026-08-04T00:44:18.625Z'

function buildMessage(spec: MessageSpec): Record<string, unknown> {
  const message: Record<string, unknown> = {
    id: spec.id ?? nextMessageId(),
    role: spec.role,
    content: [],
  }
  if (spec.model) message['model'] = spec.model
  if (spec.content) {
    message['content'] = spec.content
  } else if (spec.text !== undefined) {
    message['content'] = spec.role === 'user' ? spec.text : [{ type: 'text', text: spec.text }]
  }
  if (spec.usage !== undefined) {
    message['usage'] = spec.usage === null ? null : {
      input_tokens: spec.usage?.inputTokens ?? 0,
      output_tokens: spec.usage?.outputTokens ?? 0,
      cache_creation_input_tokens: spec.usage?.cacheCreationInputTokens ?? 0,
      cache_read_input_tokens: spec.usage?.cacheReadInputTokens ?? 0,
      server_tool_use: {
        web_search_requests: spec.usage?.webSearchRequests ?? 0,
        web_fetch_requests: 0,
      },
    }
  }
  return message
}

function buildEvent(spec: EventSpec, sessionId: string): Record<string, unknown> {
  const event: Record<string, unknown> = { type: spec.type, ...(spec.payload ?? {}) }
  event['sessionId'] = spec.sessionId ?? sessionId
  if (spec.type !== 'last-prompt') event['timestamp'] = spec.timestamp ?? DEFAULT_TIMESTAMP
  if (spec.type === 'user' || spec.type === 'assistant') {
    event['uuid'] = spec.uuid ?? nextUuid()
    if (spec.cwd) event['cwd'] = spec.cwd
    if (spec.slug) event['slug'] = spec.slug
    if (spec.isSidechain !== undefined) event['isSidechain'] = spec.isSidechain
    if (spec.message) event['message'] = buildMessage(spec.message)
  }
  return event
}

/** Write one REAL-schema OpenClaude transcript at <projectsDir>/<slug>/<fileUuid>.jsonl. */
async function writeSession(projectsDir: string, slug: string, fileUuid: string, opts?: {
  sessionId?: string
  cwd?: string
  events?: EventSpec[]
}): Promise<string> {
  const dir = join(projectsDir, slug)
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${fileUuid}.jsonl`)
  const sessionId = opts?.sessionId ?? fileUuid
  const events = (opts?.events ?? []).map((spec) => {
    const event = buildEvent(spec, sessionId)
    if ((spec.type === 'user' || spec.type === 'assistant') && opts?.cwd && event['cwd'] === undefined) {
      event['cwd'] = opts.cwd
    }
    return event
  })
  await writeFile(path, events.map((event) => JSON.stringify(event)).join('\n') + '\n')
  return path
}

async function collect(projectsDir: string): Promise<ParsedProviderCall[]> {
  const provider = createOpenClaudeProvider(projectsDir)
  const sources = await provider.discoverSessions()
  const seenKeys = new Set<string>()
  const calls: ParsedProviderCall[] = []
  for (const source of sources) {
    for await (const call of provider.createSessionParser(source, seenKeys).parse()) calls.push(call)
  }
  return calls
}

beforeAll(async () => {
  await loadPricing()
})

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'openclaude-test-'))
  uuidSeq = 0
  msgSeq = 0
  delete process.env['CODEBURN_OPENCLAUDE_DIR']
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('openclaude provider - identity', () => {
  it('registers under its own provider name', () => {
    expect(openclaude.name).toBe('openclaude')
    expect(openclaude.displayName).toBe('OpenClaude')
  })

  it('passes tool names through unchanged (Claude Code canonical)', () => {
    expect(openclaude.toolDisplayName('Write')).toBe('Write')
    expect(openclaude.toolDisplayName('Read')).toBe('Read')
    expect(openclaude.toolDisplayName('Bash')).toBe('Bash')
    expect(openclaude.toolDisplayName('Grep')).toBe('Grep')
    expect(openclaude.toolDisplayName('Edit')).toBe('Edit')
    expect(openclaude.toolDisplayName('WebFetch')).toBe('WebFetch')
    expect(openclaude.toolDisplayName('future_tool_xyz')).toBe('future_tool_xyz')
  })
})

describe('openclaude provider - projects dir resolution', () => {
  it('defaults to ~/.openclaude/projects', () => {
    expect(getOpenClaudeProjectsDir()).toBe(join(process.env['HOME'] ?? '', '.openclaude', 'projects'))
  })

  it('honors the CODEBURN_OPENCLAUDE_DIR override', () => {
    process.env['CODEBURN_OPENCLAUDE_DIR'] = '/tmp/oc-projects'
    expect(getOpenClaudeProjectsDir()).toBe(join('/tmp/oc-projects', 'projects'))
  })
})

describe('openclaude provider - probe roots', () => {
  it('reports the projects dir with the projects label', async () => {
    const provider = createOpenClaudeProvider('/tmp/x')
    expect(await provider.probeRoots!()).toEqual([{ path: '/tmp/x', label: 'projects' }])
  })

  it('defaults to the standard projects dir for the exported provider', async () => {
    expect(await openclaude.probeRoots!()).toEqual([
      { path: join(process.env['HOME'] ?? '', '.openclaude', 'projects'), label: 'projects' },
    ])
  })
})

describe('openclaude provider - discovery', () => {
  it('finds one source per .jsonl transcript, nested under project slugs', async () => {
    const projects = join(tmpDir, 'projects')
    await writeSession(projects, 'demo-proj', '11111111-1111-1111-1111-111111111111')
    await writeSession(projects, 'demo-proj', '22222222-2222-2222-2222-222222222222')
    await writeSession(projects, 'other-proj', '33333333-3333-3333-3333-333333333333')
    const provider = createOpenClaudeProvider(projects)
    const sources = await provider.discoverSessions()
    expect(sources).toHaveLength(3)
    expect(sources.map((source) => source.project).sort()).toEqual(['demo-proj', 'demo-proj', 'other-proj'])
  })

  it('skips .replay.json siblings, non-jsonl files and non-directories', async () => {
    const projects = join(tmpDir, 'projects')
    const sessionDir = join(projects, 'demo-proj')
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(sessionDir, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl'), '{"type":"assistant","sessionId":"s1","message":{"id":"m1","role":"assistant","model":"deepseek-chat","usage":{"input_tokens":100,"output_tokens":10,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}\n')
    await writeFile(join(sessionDir, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.replay.json'), '{"replay":true}')
    await writeFile(join(sessionDir, 'notes.txt'), 'not a transcript')
    await writeFile(join(projects, 'loose-file.jsonl'), '{"type":"assistant"}\n')
    const provider = createOpenClaudeProvider(projects)
    const sources = await provider.discoverSessions()
    expect(sources).toHaveLength(1)
    expect(sources[0]?.path).toBe(join(sessionDir, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl'))
  })

  it('returns [] when the projects dir is missing', async () => {
    const provider = createOpenClaudeProvider(join(tmpDir, 'does-not-exist'))
    expect(await provider.discoverSessions()).toEqual([])
  })
})

describe('openclaude provider - parsing', () => {
  it('emits one call per assistant line with usage, mapping token fields, model and web searches', async () => {
    const projects = join(tmpDir, 'projects')
    await writeSession(projects, 'demo-proj', 'e317d7f4-file', {
      sessionId: 'e317d7f4-7921-400e-9cc5-38fe0b81cd52',
      cwd: '/Users/husamsoboh/scratch/openclaude-real/demo-proj',
      events: [
        { type: 'queue-operation', payload: { operation: 'enqueue' } },
        { type: 'user', message: { role: 'user', text: 'Write a fibonacci function' } },
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            id: 'msg_32979ac8b65848e4903c37cd533475a1',
            model: 'deepseek-chat',
            usage: { inputTokens: 16217, outputTokens: 125 },
          },
        },
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            id: 'msg_0c0dd9d7a75b43b0b2cb3735ebc2cac7',
            model: 'deepseek-chat',
            content: [{ type: 'tool_use', id: 'call_00_Kd4Zg8NLsX0L9rTnWrwq1798', name: 'Bash', input: { command: 'python3 -c "from fib import fib"' } }],
            usage: { inputTokens: 500, outputTokens: 60, webSearchRequests: 2 },
          },
        },
        { type: 'last-prompt', payload: { lastPrompt: 'Write a fibonacci function' } },
      ],
    })
    const calls = await collect(projects)
    expect(calls).toHaveLength(2)
    const first = calls[0]!
    const second = calls[1]!
    expect(first.provider).toBe('openclaude')
    expect(first.sessionId).toBe('e317d7f4-7921-400e-9cc5-38fe0b81cd52')
    expect(first.model).toBe('deepseek-chat')
    expect(first.inputTokens).toBe(16217)
    expect(first.outputTokens).toBe(125)
    expect(first.cacheCreationInputTokens).toBe(0)
    expect(first.cacheReadInputTokens).toBe(0)
    expect(first.webSearchRequests).toBe(0)
    expect(first.userMessage).toBe('Write a fibonacci function')
    expect(first.timestamp).toBe(DEFAULT_TIMESTAMP)
    expect(first.deduplicationKey).toBe('openclaude:e317d7f4-7921-400e-9cc5-38fe0b81cd52:msg_32979ac8b65848e4903c37cd533475a1')
    expect(second.webSearchRequests).toBe(2)
    expect(second.tools).toEqual(['Bash'])
    expect(second.bashCommands.length).toBeGreaterThan(0)
  })

  it('ignores queue-operation, last-prompt, user and usage-less assistant lines', async () => {
    const projects = join(tmpDir, 'projects')
    await writeSession(projects, 'demo-proj', 'file-1', {
      events: [
        { type: 'queue-operation', payload: { operation: 'enqueue' } },
        { type: 'user', message: { role: 'user', text: 'hello' } },
        { type: 'assistant', message: { role: 'assistant', id: 'no-usage', text: 'thinking only' } },
        { type: 'assistant', message: { role: 'assistant', id: 'null-usage', usage: null, text: 'hi' } },
        { type: 'last-prompt', payload: { lastPrompt: 'hello' } },
        { type: 'assistant', message: { role: 'assistant', id: 'real', usage: { inputTokens: 100, outputTokens: 10 } } },
      ],
    })
    const calls = await collect(projects)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.deduplicationKey).toBe('openclaude:file-1:real')
    expect(calls[0]?.userMessage).toBe('hello')
  })

  it('skips corrupt lines without killing the file', async () => {
    const projects = join(tmpDir, 'projects')
    const sessionDir = join(projects, 'demo-proj')
    await mkdir(sessionDir, { recursive: true })
    const path = join(sessionDir, 'file-1.jsonl')
    await writeFile(path, [
      '{"type":"user","sessionId":"s1","message":{"role":"user","content":"prompt"}}',
      '{definitely not json',
      '{"type":"assistant","sessionId":"s1","message":{"id":"m1","role":"assistant","model":"deepseek-chat","usage":{"input_tokens":100,"output_tokens":10,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}',
      '{"type":"assistant","sessionId":"s1","message":{"id":"m2","role":"assistant","usage":{"input_tokens":50,"output_tokens":5,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}',
    ].join('\n') + '\n')
    const calls = await collect(projects)
    expect(calls).toHaveLength(2)
    expect(calls.map((call) => call.deduplicationKey)).toEqual(['openclaude:s1:m1', 'openclaude:s1:m2'])
    expect(calls[0]?.userMessage).toBe('prompt')
    expect(calls[1]?.model).toBe('unknown')
  })

  it('takes the first user line with non-empty text as the user message (tool results ignored)', async () => {
    const projects = join(tmpDir, 'projects')
    await writeSession(projects, 'demo-proj', 'file-1', {
      events: [
        {
          type: 'user',
          message: { role: 'user', content: [{ tool_use_id: 'call_00_x', type: 'tool_result', content: 'File created' }] },
        },
        { type: 'user', message: { role: 'user', text: 'Write a fibonacci function' } },
        { type: 'user', message: { role: 'user', text: 'Second prompt, ignored' } },
        { type: 'assistant', message: { role: 'assistant', id: 'a', usage: { inputTokens: 100, outputTokens: 10 } } },
      ],
    })
    const calls = await collect(projects)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.userMessage).toBe('Write a fibonacci function')
  })
})

describe('openclaude provider - dedup', () => {
  it('counts the same message.id within one sessionId once across files', async () => {
    const projects = join(tmpDir, 'projects')
    const usage = { inputTokens: 100, outputTokens: 10 }
    await writeSession(projects, 'proj-a', 'file-1', {
      sessionId: 'shared-session',
      events: [{ type: 'assistant', message: { role: 'assistant', id: 'dup-1', usage } }],
    })
    await writeSession(projects, 'proj-b', 'file-2', {
      sessionId: 'shared-session',
      events: [{ type: 'assistant', message: { role: 'assistant', id: 'dup-1', usage } }],
    })
    const calls = await collect(projects)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.deduplicationKey).toBe('openclaude:shared-session:dup-1')
  })

  it('counts repeated message.id inside one file once (multi-block assistant messages)', async () => {
    const projects = join(tmpDir, 'projects')
    await writeSession(projects, 'proj-a', 'file-1', {
      sessionId: 's1',
      events: [
        { type: 'assistant', message: { role: 'assistant', id: 'msg_x', text: 'text first', usage: { inputTokens: 100, outputTokens: 10 } } },
        { type: 'assistant', message: { role: 'assistant', id: 'msg_x', usage: { inputTokens: 40, outputTokens: 5 } } },
      ],
    })
    const calls = await collect(projects)
    expect(calls).toHaveLength(1)
  })
})

describe('openclaude provider - sidechain', () => {
  it('counts isSidechain assistant lines as real spend', async () => {
    const projects = join(tmpDir, 'projects')
    await writeSession(projects, 'demo-proj', 'file-1', {
      events: [
        { type: 'assistant', isSidechain: true, message: { role: 'assistant', id: 'sub-1', usage: { inputTokens: 100, outputTokens: 10 } } },
        { type: 'assistant', isSidechain: false, message: { role: 'assistant', id: 'main-1', usage: { inputTokens: 100, outputTokens: 10 } } },
      ],
    })
    const calls = await collect(projects)
    expect(calls).toHaveLength(2)
    expect(calls.map((call) => call.deduplicationKey)).toEqual(['openclaude:file-1:sub-1', 'openclaude:file-1:main-1'])
  })
})

describe('openclaude provider - project resolution', () => {
  it('uses basename of cwd, else the project slug dir', async () => {
    const projects = join(tmpDir, 'projects')
    await writeSession(projects, 'slug-dir', 'file-1', {
      cwd: '/Users/dev/work/real-project',
      events: [{ type: 'assistant', message: { role: 'assistant', id: 'a', usage: { inputTokens: 100, outputTokens: 10 } } }],
    })
    await writeSession(projects, 'slug-dir', 'file-2', {
      events: [{ type: 'assistant', slug: 'line-slug', message: { role: 'assistant', id: 'b', usage: { inputTokens: 100, outputTokens: 10 } } }],
    })
    await writeSession(projects, 'slug-dir', 'file-3', {
      events: [{ type: 'assistant', message: { role: 'assistant', id: 'c', usage: { inputTokens: 100, outputTokens: 10 } } }],
    })
    const calls = await collect(projects)
    expect(calls).toHaveLength(3)
    const byId = new Map(calls.map((call) => [call.deduplicationKey, call.project]))
    expect(byId.get('openclaude:file-1:a')).toBe('real-project')
    expect(byId.get('openclaude:file-2:b')).toBe('slug-dir')
    expect(byId.get('openclaude:file-3:c')).toBe('slug-dir')
  })
})

describe('openclaude provider - cost', () => {
  it('computes an estimated cost for every call (transcripts carry no cost field)', async () => {
    const projects = join(tmpDir, 'projects')
    await writeSession(projects, 'demo-proj', 'file-1', {
      events: [
        { type: 'assistant', message: { role: 'assistant', id: 'a', model: 'deepseek-chat', usage: { inputTokens: 16217, outputTokens: 125 } } },
        { type: 'assistant', message: { role: 'assistant', id: 'b', usage: { inputTokens: 50, outputTokens: 5 } } },
        { type: 'assistant', isSidechain: true, message: { role: 'assistant', id: 'c', usage: { inputTokens: 10, outputTokens: 2 } } },
      ],
    })
    const calls = await collect(projects)
    expect(calls).toHaveLength(3)
    for (const call of calls) {
      expect(call.costIsEstimated).toBe(true)
      expect(Number.isFinite(call.costUSD)).toBe(true)
    }
    // Priced through the shared tables, self-consistent with calculateCost.
    expect(calls[0]?.costUSD).toBeGreaterThan(0)
    expect(calls[0]?.costUSD).toBeCloseTo(calculateCost('deepseek-chat', 16217, 125, 0, 0, 0), 10)
    expect(calls[1]?.costUSD).toBe(0)
  })
})

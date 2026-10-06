import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { commandCode, createCommandCodeProvider, getCommandCodeProjectsDir } from '../../src/providers/command-code.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'
import { calculateCost, loadPricing } from '../../src/models.js'

let tmpDir: string
let msgSeq: number

const DEFAULT_TIMESTAMP = '2026-10-06T06:59:04.138Z'

type UsageSpec = {
  inputTokens?: number
  outputTokens?: number
  cacheWriteTokens?: number
  cacheReadTokens?: number
  costUsd?: number
}

type ContentBlock = Record<string, unknown>

type MessageSpec = {
  role: 'user' | 'assistant'
  id?: string
  model?: string
  text?: string
  content?: ContentBlock[]
  usage?: UsageSpec | null
  timestamp?: string
}

function buildMessage(spec: MessageSpec): Record<string, unknown> {
  const id = spec.id ?? `msg_${++msgSeq}`
  const message: Record<string, unknown> = {
    role: spec.role,
    content: spec.content ?? (spec.text !== undefined ? [{ type: 'text', text: spec.text }] : []),
    meta: { source: 'user', messageId: id },
  }
  const record: Record<string, unknown> = {
    type: 'message',
    id,
    parentId: null,
    timestamp: spec.timestamp ?? DEFAULT_TIMESTAMP,
    message,
  }
  if (spec.model) record['model'] = spec.model
  if (spec.usage !== undefined) {
    record['usage'] = spec.usage === null ? null : {
      inputTokens: spec.usage?.inputTokens ?? 0,
      outputTokens: spec.usage?.outputTokens ?? 0,
      cacheReadTokens: spec.usage?.cacheReadTokens ?? 0,
      cacheWriteTokens: spec.usage?.cacheWriteTokens ?? 0,
      // Only written when the caller asked for it, so a fixture can model a
      // call the tool did not price (no costUsd at all).
      ...(spec.usage?.costUsd !== undefined ? { costUsd: spec.usage.costUsd } : {}),
    }
  }
  return record
}

/** Write one REAL-schema Command Code transcript at <projectsDir>/<slug>/<fileUuid>.jsonl. */
async function writeSession(projectsDir: string, slug: string, fileUuid: string, opts?: {
  sessionId?: string
  cwd?: string
  messages?: MessageSpec[]
}): Promise<string> {
  const dir = join(projectsDir, slug)
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${fileUuid}.jsonl`)
  const session: Record<string, unknown> = {
    type: 'session',
    version: 3,
    id: opts?.sessionId ?? fileUuid,
    timestamp: DEFAULT_TIMESTAMP,
    // Only written when the caller asked for it, so a fixture can model a
    // transcript with no cwd (project then falls back to the slug dir).
    ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
  }
  const records = [session, ...(opts?.messages ?? []).map(buildMessage)]
  await writeFile(path, records.map((record) => JSON.stringify(record)).join('\n') + '\n')
  return path
}

async function collect(projectsDir: string): Promise<ParsedProviderCall[]> {
  const provider = createCommandCodeProvider(projectsDir)
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
  tmpDir = await mkdtemp(join(tmpdir(), 'command-code-test-'))
  msgSeq = 0
  delete process.env['CODEBURN_COMMANDCODE_DIR']
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('command-code provider - identity', () => {
  it('registers under its own provider name', () => {
    expect(commandCode.name).toBe('command-code')
    expect(commandCode.displayName).toBe('Command Code')
  })

  it('maps native tool names to CodeBurn canonical ones', () => {
    expect(commandCode.toolDisplayName('shell_command')).toBe('Bash')
    expect(commandCode.toolDisplayName('read_file')).toBe('Read')
    expect(commandCode.toolDisplayName('write_file')).toBe('Write')
    expect(commandCode.toolDisplayName('edit_file')).toBe('Edit')
    expect(commandCode.toolDisplayName('grep')).toBe('Grep')
    expect(commandCode.toolDisplayName('glob')).toBe('Glob')
    expect(commandCode.toolDisplayName('read_directory')).toBe('Glob')
    expect(commandCode.toolDisplayName('todo_write')).toBe('TodoWrite')
    expect(commandCode.toolDisplayName('activate_skill')).toBe('Skill')
    expect(commandCode.toolDisplayName('agent')).toBe('Agent')
    expect(commandCode.toolDisplayName('web_search')).toBe('WebSearch')
    expect(commandCode.toolDisplayName('mcp__server__tool')).toBe('mcp__server__tool')
    expect(commandCode.toolDisplayName('future_tool_xyz')).toBe('future_tool_xyz')
  })
})

describe('command-code provider - projects dir resolution', () => {
  it('defaults to ~/.commandcode/projects', () => {
    expect(getCommandCodeProjectsDir()).toBe(join(process.env['HOME'] ?? '', '.commandcode', 'projects'))
  })

  it('honors the CODEBURN_COMMANDCODE_DIR override', () => {
    process.env['CODEBURN_COMMANDCODE_DIR'] = '/tmp/cc-home'
    expect(getCommandCodeProjectsDir()).toBe(join('/tmp/cc-home', 'projects'))
  })
})

describe('command-code provider - probe roots', () => {
  it('reports the projects dir with the projects label', async () => {
    const provider = createCommandCodeProvider('/tmp/x')
    expect(await provider.probeRoots!()).toEqual([{ path: '/tmp/x', label: 'projects' }])
  })

  it('defaults to the standard projects dir for the exported provider', async () => {
    expect(await commandCode.probeRoots!()).toEqual([
      { path: join(process.env['HOME'] ?? '', '.commandcode', 'projects'), label: 'projects' },
    ])
  })
})

describe('command-code provider - discovery', () => {
  it('finds one source per .jsonl transcript, nested under project slugs', async () => {
    const projects = join(tmpDir, 'projects')
    await writeSession(projects, 'users-denis', '11111111-1111-1111-1111-111111111111')
    await writeSession(projects, 'users-denis', '22222222-2222-2222-2222-222222222222')
    await writeSession(projects, 'users-denis-ai-stack', '33333333-3333-3333-3333-333333333333')
    const provider = createCommandCodeProvider(projects)
    const sources = await provider.discoverSessions()
    expect(sources).toHaveLength(3)
    expect(sources.map((source) => source.project).sort()).toEqual(['users-denis', 'users-denis', 'users-denis-ai-stack'])
  })

  it('skips .checkpoints.jsonl siblings, non-jsonl files and loose files', async () => {
    const projects = join(tmpDir, 'projects')
    const sessionDir = join(projects, 'users-denis')
    await mkdir(sessionDir, { recursive: true })
    const session = '{"type":"session","version":3,"id":"s1","timestamp":"2026-10-06T06:59:04.138Z","cwd":"/Users/dev/project"}\n'
    await writeFile(join(sessionDir, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl'), session)
    await writeFile(join(sessionDir, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.checkpoints.jsonl'), '{"id":"c1"}\n')
    await writeFile(join(sessionDir, 'notes.txt'), 'not a transcript')
    await writeFile(join(projects, 'loose-file.jsonl'), session)
    const provider = createCommandCodeProvider(projects)
    const sources = await provider.discoverSessions()
    expect(sources).toHaveLength(1)
    expect(sources[0]?.path).toBe(join(sessionDir, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl'))
  })

  it('returns [] when the projects dir is missing', async () => {
    const provider = createCommandCodeProvider(join(tmpDir, 'does-not-exist'))
    expect(await provider.discoverSessions()).toEqual([])
  })
})

describe('command-code provider - parsing', () => {
  it('emits one call per assistant message with usage, mapping tokens, model and recorded cost', async () => {
    const projects = join(tmpDir, 'projects')
    await writeSession(projects, 'users-denis', 'file-1', {
      sessionId: 'f4745de3-4e12-48bf-be4d-62ca22c1f93a',
      cwd: '/Users/Denis/ai-stack',
      messages: [
        { role: 'user', text: 'Write a fibonacci function' },
        {
          role: 'assistant',
          id: 'm1',
          model: 'deepseek/deepseek-v4.1-flash',
          usage: { inputTokens: 26220, outputTokens: 378, cacheReadTokens: 8192, cacheWriteTokens: 0, costUsd: 0.002955576 },
        },
        {
          role: 'assistant',
          id: 'm2',
          model: 'deepseek/deepseek-v4.1-flash',
          content: [{ type: 'tool_use', id: 'call_00_x', name: 'shell_command', input: { command: 'git status --short' } }],
          usage: { inputTokens: 500, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.0001 },
        },
      ],
    })
    const calls = await collect(projects)
    expect(calls).toHaveLength(2)
    const first = calls[0]!
    const second = calls[1]!
    expect(first.provider).toBe('command-code')
    expect(first.sessionId).toBe('f4745de3-4e12-48bf-be4d-62ca22c1f93a')
    expect(first.model).toBe('deepseek/deepseek-v4.1-flash')
    expect(first.inputTokens).toBe(26220)
    expect(first.outputTokens).toBe(378)
    expect(first.cacheReadInputTokens).toBe(8192)
    expect(first.cacheCreationInputTokens).toBe(0)
    expect(first.costUSD).toBeCloseTo(0.002955576, 12)
    expect(first.costFromBilling).toBe(true)
    expect(first.costIsEstimated).toBe(false)
    expect(first.userMessage).toBe('Write a fibonacci function')
    expect(first.project).toBe('ai-stack')
    expect(first.projectPath).toBe('/Users/Denis/ai-stack')
    expect(first.deduplicationKey).toBe('command-code:f4745de3-4e12-48bf-be4d-62ca22c1f93a:m1')
    expect(second.tools).toEqual(['Bash'])
    expect(second.bashCommands.length).toBeGreaterThan(0)
  })

  it('ignores user messages, usage-less assistant messages and the session header', async () => {
    const projects = join(tmpDir, 'projects')
    await writeSession(projects, 'users-denis', 'file-1', {
      messages: [
        { role: 'user', text: 'hello' },
        { role: 'assistant', id: 'no-usage', content: [{ type: 'text', text: 'thinking only' }] },
        { role: 'assistant', id: 'null-usage', usage: null, content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', id: 'real', usage: { inputTokens: 100, outputTokens: 10 } },
      ],
    })
    const calls = await collect(projects)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.deduplicationKey).toBe('command-code:file-1:real')
    expect(calls[0]?.userMessage).toBe('hello')
  })

  it('skips corrupt lines without killing the file', async () => {
    const projects = join(tmpDir, 'projects')
    const sessionDir = join(projects, 'users-denis')
    await mkdir(sessionDir, { recursive: true })
    const path = join(sessionDir, 'file-1.jsonl')
    await writeFile(path, [
      '{"type":"session","version":3,"id":"s1","timestamp":"2026-10-06T06:59:04.138Z","cwd":"/Users/dev/project"}',
      '{definitely not json',
      '{"type":"message","id":"m1","timestamp":"2026-10-06T06:59:05.000Z","model":"mimo","message":{"role":"assistant","content":[]},"usage":{"inputTokens":100,"outputTokens":10}}',
      '{"type":"message","id":"m2","timestamp":"2026-10-06T06:59:06.000Z","message":{"role":"assistant","content":[]},"usage":{"inputTokens":50,"outputTokens":5}}',
    ].join('\n') + '\n')
    const calls = await collect(projects)
    expect(calls).toHaveLength(2)
    expect(calls.map((call) => call.deduplicationKey)).toEqual(['command-code:s1:m1', 'command-code:s1:m2'])
    expect(calls[0]?.model).toBe('mimo')
    expect(calls[1]?.model).toBe('unknown')
  })

  it('takes the first user message with non-empty text (tool results ignored)', async () => {
    const projects = join(tmpDir, 'projects')
    await writeSession(projects, 'users-denis', 'file-1', {
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_00_x', content: [{ type: 'text', text: 'File created' }] }] },
        { role: 'user', text: 'Write a fibonacci function' },
        { role: 'user', text: 'Second prompt, ignored' },
        { role: 'assistant', id: 'a', usage: { inputTokens: 100, outputTokens: 10 } },
      ],
    })
    const calls = await collect(projects)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.userMessage).toBe('Write a fibonacci function')
  })
})

describe('command-code provider - cost', () => {
  it('preserves a metered costUsd (presence check: a metered $0 stays reported)', async () => {
    const projects = join(tmpDir, 'projects')
    await writeSession(projects, 'users-denis', 'file-1', {
      messages: [
        { role: 'assistant', id: 'metered', model: 'stealth/ox-alpha', usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.00123 } },
        { role: 'assistant', id: 'free', model: 'stealth/ox-alpha', usage: { inputTokens: 100, outputTokens: 10, costUsd: 0 } },
      ],
    })
    const calls = await collect(projects)
    expect(calls).toHaveLength(2)
    expect(calls[0]?.costUSD).toBeCloseTo(0.00123, 12)
    expect(calls[0]?.costFromBilling).toBe(true)
    expect(calls[0]?.costIsEstimated).toBe(false)
    expect(calls[1]?.costUSD).toBe(0)
    expect(calls[1]?.costFromBilling).toBe(true)
    expect(calls[1]?.costIsEstimated).toBe(false)
  })

  it('falls back to token pricing when the tool recorded no costUsd', async () => {
    const projects = join(tmpDir, 'projects')
    await writeSession(projects, 'users-denis', 'file-1', {
      messages: [
        { role: 'assistant', id: 'unpriced', model: 'deepseek/deepseek-v4.1-flash', usage: { inputTokens: 16217, outputTokens: 125 } },
      ],
    })
    const calls = await collect(projects)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.costIsEstimated).toBe(true)
    expect(calls[0]?.costFromBilling).toBeUndefined()
    expect(calls[0]?.costUSD).toBeCloseTo(calculateCost('deepseek/deepseek-v4.1-flash', 16217, 125, 0, 0, 0), 12)
  })
})

describe('command-code provider - dedup', () => {
  it('counts the same message id within one session once', async () => {
    const projects = join(tmpDir, 'projects')
    const usage = { inputTokens: 100, outputTokens: 10 }
    await writeSession(projects, 'proj-a', 'file-1', {
      sessionId: 'shared-session',
      messages: [{ role: 'assistant', id: 'dup-1', usage }],
    })
    await writeSession(projects, 'proj-b', 'file-2', {
      sessionId: 'shared-session',
      messages: [{ role: 'assistant', id: 'dup-1', usage }],
    })
    const calls = await collect(projects)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.deduplicationKey).toBe('command-code:shared-session:dup-1')
  })
})

describe('command-code provider - project resolution', () => {
  it('uses basename of cwd, else the project slug dir', async () => {
    const projects = join(tmpDir, 'projects')
    await writeSession(projects, 'slug-dir', 'file-1', {
      cwd: '/Users/dev/work/real-project',
      messages: [{ role: 'assistant', id: 'a', usage: { inputTokens: 100, outputTokens: 10 } }],
    })
    await writeSession(projects, 'slug-dir', 'file-2', {
      messages: [{ role: 'assistant', id: 'b', usage: { inputTokens: 100, outputTokens: 10 } }],
    })
    const calls = await collect(projects)
    expect(calls).toHaveLength(2)
    const byId = new Map(calls.map((call) => [call.deduplicationKey, call.project]))
    expect(byId.get('command-code:file-1:a')).toBe('real-project')
    expect(byId.get('command-code:file-2:b')).toBe('slug-dir')
  })
})

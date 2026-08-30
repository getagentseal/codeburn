import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join, basename } from 'path'
import { tmpdir } from 'os'

import { bahulam, createBahulamProvider } from '../../src/providers/bahulam.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

let tmpDir: string

const T1 = '2026-08-02T20:04:18.000Z'
const T2 = '2026-08-02T20:05:18.000Z'
const T3 = '2026-08-02T20:06:18.000Z'

function bahulamEntry(type: string, overrides?: Record<string, unknown>): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    type,
    timestamp: new Date('2026-08-02T20:04:18.628Z').toISOString(),
    cwd: '/Users/dev/work/my-repo',
  }
  if (overrides) Object.assign(entry, overrides)
  return entry
}

function userMessage(text: string, ts?: string): Record<string, unknown> {
  return bahulamEntry('user', {
    message: { role: 'user', content: text },
    timestamp: ts ?? T1,
  })
}

function completeEvent(usage: Record<string, unknown>, ts?: string): Record<string, unknown> {
  return bahulamEntry('bahulam_event', {
    event: { type: 'complete', data: { usage } },
    timestamp: ts ?? T2,
  })
}

function toolCallEvent(name: string, command?: string, overrides?: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = { tool: name }
  if (command) data['args'] = { command }
  return bahulamEntry('bahulam_event', {
    event: { type: 'tool_call', data },
    ...(overrides ?? {}),
  })
}

function sessionInfoEvent(models: Record<string, string>): Record<string, unknown> {
  return bahulamEntry('bahulam_event', {
    event: { type: 'session_info', data: { models } },
  })
}

async function writeSession(
  sessionsDir: string,
  projectSlug: string,
  sessionId: string,
  entries: Record<string, unknown>[],
): Promise<string> {
  const dir = join(sessionsDir, projectSlug)
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, `${sessionId}.jsonl`)
  const lines = entries.map(e => JSON.stringify(e)).join('\n')
  await writeFile(filePath, lines + '\n')
  return filePath
}

async function collect(sessionsDir: string): Promise<ParsedProviderCall[]> {
  const provider = createBahulamProvider(sessionsDir)
  const sources = await provider.discoverSessions()
  const seenKeys = new Set<string>()
  const calls: ParsedProviderCall[] = []
  for (const source of sources) {
    for await (const call of provider.createSessionParser(source, seenKeys).parse()) calls.push(call)
  }
  return calls
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'bahulam-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('bahulam provider - identity', () => {
  it('registers under its own provider name', () => {
    expect(bahulam.name).toBe('bahulam')
    expect(bahulam.displayName).toBe('Bahulam Code')
  })

  it('passes through tool display names', () => {
    expect(bahulam.toolDisplayName('Bash')).toBe('Bash')
    expect(bahulam.toolDisplayName('Edit')).toBe('Edit')
  })
})

describe('bahulam provider - sessions dir resolution', () => {
  afterEach(() => {
    delete process.env['BAHULAM_PROJECTS_DIR']
  })

  it('defaults to ~/.bahulam/projects', async () => {
    await expect(createBahulamProvider().probeRoots()).resolves.toEqual(
      [{ path: join(process.env['HOME'] ?? '', '.bahulam', 'projects'), label: 'projects' }]
    )
  })

  it('honors BAHULAM_PROJECTS_DIR', async () => {
    process.env['BAHULAM_PROJECTS_DIR'] = '/custom/projects'
    await expect(createBahulamProvider().probeRoots()).resolves.toEqual(
      [{ path: '/custom/projects', label: 'projects' }]
    )
  })

  it('reports the resolved root for doctor', async () => {
    process.env['BAHULAM_PROJECTS_DIR'] = tmpDir
    const result = await createBahulamProvider().probeRoots()
    expect(result).toEqual([{ path: tmpDir, label: 'projects' }])
  })
})

describe('bahulam provider - discovery', () => {
  it('discovers one source per .jsonl file under project slug dirs', async () => {
    await writeSession(tmpDir, 'my-project', 'sess-a', [completeEvent({ total_input_tokens: 10, total_output_tokens: 5 })])
    await writeSession(tmpDir, 'my-project', 'sess-b', [completeEvent({ total_input_tokens: 20, total_output_tokens: 10 })])

    const sources = await createBahulamProvider(tmpDir).discoverSessions()

    expect(sources).toHaveLength(2)
    expect(sources.map(s => s.provider)).toEqual(['bahulam', 'bahulam'])
    expect(sources.map(s => s.project)).toEqual(['my-project', 'my-project'])
  })

  it('skips non-jsonl files', async () => {
    await writeSession(tmpDir, 'my-project', 'sess-a', [])
    await writeFile(join(tmpDir, 'my-project', 'notes.txt'), 'not a session')

    const sources = await createBahulamProvider(tmpDir).discoverSessions()
    expect(sources).toHaveLength(1)
  })

  it('skips non-directory entries in the root', async () => {
    await writeSession(tmpDir, 'my-project', 'sess-a', [completeEvent({ total_input_tokens: 1, total_output_tokens: 1 })])
    await writeFile(join(tmpDir, 'not-a-dir.jsonl'), '{}')

    const sources = await createBahulamProvider(tmpDir).discoverSessions()
    expect(sources).toHaveLength(1)
  })

  it('returns nothing when the root dir does not exist', async () => {
    expect(await createBahulamProvider(join(tmpDir, 'missing')).discoverSessions()).toHaveLength(0)
  })
})

describe('bahulam provider - parsing', () => {
  it('emits one call per complete event with usage', async () => {
    await writeSession(tmpDir, 'my-project', 'sess-a', [
      userMessage('do the thing', T1),
      completeEvent({ total_input_tokens: 100, total_output_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 2, reasoning_tokens: 1 }, T2),
      userMessage('and another', T2),
      completeEvent({ total_input_tokens: 200, total_output_tokens: 20 }, T3),
    ])

    const calls = await collect(tmpDir)

    expect(calls).toHaveLength(2)
    expect(calls.map(c => c.inputTokens)).toEqual([93, 200])
    expect(calls.map(c => c.outputTokens)).toEqual([10, 20])
    expect(calls[0]?.cacheReadInputTokens).toBe(5)
    expect(calls[0]?.cacheCreationInputTokens).toBe(2)
    expect(calls[0]?.reasoningTokens).toBe(1)
    expect(calls.every(c => c.provider === 'bahulam')).toBe(true)
  })

  it('carries session identity, project and timestamps onto each call', async () => {
    await writeSession(tmpDir, 'awesome-repo', 'sess-a', [
      userMessage('hi', T1),
      completeEvent({ total_input_tokens: 1, total_output_tokens: 1 }, T2),
    ])

    const [call] = await collect(tmpDir)

    expect(call?.sessionId).toBe('sess-a')
    expect(call?.project).toBe('awesome-repo')
    expect(call?.projectPath).toBe('/Users/dev/work/my-repo')
    expect(call?.workingDirectory).toBe('/Users/dev/work/my-repo')
    expect(call?.timestamp).toBe(T2)
  })

  it('uses the first user text as the session user message', async () => {
    await writeSession(tmpDir, 'my-project', 'sess-a', [
      userMessage('the real prompt', T1),
      completeEvent({ total_input_tokens: 1, total_output_tokens: 1 }, T2),
    ])

    const [call] = await collect(tmpDir)

    expect(call?.userMessage).toBe('the real prompt')
  })

  it('extracts tools and bash commands from tool_call events', async () => {
    await writeSession(tmpDir, 'my-project', 'sess-a', [
      userMessage('run commands', T1),
      toolCallEvent('shell', 'git status'),
      toolCallEvent('shell', 'ls -la'),
      toolCallEvent('read_file'),
      completeEvent({ total_input_tokens: 100, total_output_tokens: 10 }, T2),
    ])

    const [call] = await collect(tmpDir)

    expect(call?.tools).toEqual(['Bash', 'Bash', 'Read'])
    expect(call?.bashCommands).toContain('git')
    expect(call?.bashCommands).toContain('ls')
  })

  it('extracts legacy tool_name and arguments aliases', async () => {
    await writeSession(tmpDir, 'my-project', 'sess-a', [
      userMessage('run command', T1),
      bahulamEntry('bahulam_event', {
        event: { type: 'tool_request', data: { tool_name: 'shell', arguments: { command: 'npm test' } } },
      }),
      completeEvent({ total_input_tokens: 100, total_output_tokens: 10 }, T2),
    ])

    const [call] = await collect(tmpDir)

    expect(call?.tools).toEqual(['Bash'])
    expect(call?.bashCommands).toContain('npm')
  })

  it('deduplicates repeated parses via the shared seenKeys set', async () => {
    await writeSession(tmpDir, 'my-project', 'sess-a', [
      userMessage('a', T1),
      completeEvent({ total_input_tokens: 5, total_output_tokens: 1 }, T2),
    ])

    const provider = createBahulamProvider(tmpDir)
    const [source] = await provider.discoverSessions()
    const seenKeys = new Set<string>()

    const first: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source!, seenKeys).parse()) first.push(call)
    const second: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source!, seenKeys).parse()) second.push(call)

    expect(first).toHaveLength(1)
    expect(second).toHaveLength(0)
  })

  it('survives a corrupt JSONL line without dropping the session', async () => {
    const dir = join(tmpDir, 'my-project')
    await mkdir(dir, { recursive: true })
    const lines = [
      JSON.stringify(userMessage('work', T1)),
      JSON.stringify(completeEvent({ total_input_tokens: 10, total_output_tokens: 5 }, T2)),
      'not valid json',
      JSON.stringify(completeEvent({ total_input_tokens: 20, total_output_tokens: 10 }, T3)),
    ].join('\n') + '\n'
    await writeFile(join(dir, 'sess-a.jsonl'), lines)

    const calls = await collect(tmpDir)

    expect(calls).toHaveLength(2)
  })

  it('resolves model from session_info', async () => {
    await writeSession(tmpDir, 'my-project', 'sess-a', [
      sessionInfoEvent({ coder: 'claude-sonnet-4-6', main: 'claude-sonnet-4-6' }),
      userMessage('work', T1),
      completeEvent({ total_input_tokens: 10, total_output_tokens: 5 }, T2),
    ])

    const [call] = await collect(tmpDir)

    expect(call?.model).toBe('anthropic/claude-sonnet-4-6')
  })

  it('skips events without usage data', async () => {
    await writeSession(tmpDir, 'my-project', 'sess-a', [
      userMessage('work', T1),
      bahulamEntry('bahulam_event', { event: { type: 'complete', data: {} } }),
    ])

    expect(await collect(tmpDir)).toHaveLength(0)
  })
})

describe('bahulam provider - cost semantics', () => {
  it('keeps a reported $0 cost instead of re-estimating it', async () => {
    await writeSession(tmpDir, 'my-project', 'sess-a', [
      userMessage('free call', T1),
      completeEvent({ total_input_tokens: 1000, total_output_tokens: 100, cost: 0 }, T2),
    ])

    const [call] = await collect(tmpDir)

    expect(call?.costUSD).toBe(0)
    expect(call?.costIsEstimated).toBe(false)
  })

  it('keeps a reported cost as-is when present', async () => {
    await writeSession(tmpDir, 'my-project', 'sess-a', [
      userMessage('paid call', T1),
      completeEvent({ total_input_tokens: 1000, total_output_tokens: 100, cost: 0.05 }, T2),
    ])

    const [call] = await collect(tmpDir)

    expect(call?.costUSD).toBe(0.05)
    expect(call?.costIsEstimated).toBe(false)
  })

  it('estimates cost when no cost field is reported', async () => {
    await writeSession(tmpDir, 'my-project', 'sess-a', [
      userMessage('no cost', T1),
      completeEvent({ total_input_tokens: 1000, total_output_tokens: 100 }, T2),
    ])

    const [call] = await collect(tmpDir)

    expect(call?.costIsEstimated).toBe(true)
    expect(call?.costUSD).toBeGreaterThan(0)
  })

  it('treats a negative cost as absent and estimates instead', async () => {
    await writeSession(tmpDir, 'my-project', 'sess-a', [
      userMessage('bad cost', T1),
      completeEvent({ total_input_tokens: 1000, total_output_tokens: 100, cost: -5 }, T2),
    ])

    const [call] = await collect(tmpDir)

    expect(call?.costIsEstimated).toBe(true)
    expect(call?.costUSD).toBeGreaterThan(0)
  })
})

describe('bahulam provider - multi-model', () => {
  it('emits one call per model when usage.models has multiple entries', async () => {
    await writeSession(tmpDir, 'my-project', 'sess-a', [
      userMessage('multi', T1),
      completeEvent({
        total_input_tokens: 300,
        total_output_tokens: 30,
        models: [
          { model: 'claude-sonnet-4-6', input_tokens: 100, output_tokens: 10, cache_read_tokens: 5, cache_creation_tokens: 2, cost: 0.01 },
          { model: 'claude-opus-4-5', input_tokens: 200, output_tokens: 20, cost: 0.03 },
        ],
      }, T2),
    ])

    const calls = await collect(tmpDir)

    expect(calls).toHaveLength(2)
    expect(calls.map(c => c.model)).toEqual(['anthropic/claude-sonnet-4-6', 'anthropic/claude-opus-4-5'])
    expect(calls.map(c => c.inputTokens)).toEqual([93, 200])
    expect(calls.map(c => c.outputTokens)).toEqual([10, 20])
    expect(calls.map(c => c.costUSD)).toEqual([0.01, 0.03])
    expect(calls.every(c => c.costIsEstimated === false)).toBe(true)
    expect(calls.map(c => c.cacheReadInputTokens)).toEqual([5, 0])
    expect(calls.map(c => c.cacheCreationInputTokens)).toEqual([2, 0])
    expect(calls[0]?.turnId).toBe(calls[1]?.turnId)
    expect(new Set(calls.map(c => c.deduplicationKey))).toHaveLength(2)
  })

  it('does not collide multi-model calls across complete events without response ids', async () => {
    await writeSession(tmpDir, 'my-project', 'sess-a', [
      userMessage('first', T1),
      completeEvent({
        models: [
          { model: 'claude-sonnet-4-6', total_input_tokens: 100, total_output_tokens: 10, cost: 0.01 },
          { model: 'claude-opus-4-5', total_input_tokens: 200, total_output_tokens: 20, cost: 0.03 },
        ],
      }, T2),
      userMessage('second', T2),
      completeEvent({
        models: [
          { model: 'claude-sonnet-4-6', total_input_tokens: 300, total_output_tokens: 30, cost: 0.04 },
          { model: 'claude-opus-4-5', total_input_tokens: 400, total_output_tokens: 40, cost: 0.06 },
        ],
      }, T2),
    ])

    const calls = await collect(tmpDir)

    expect(calls).toHaveLength(4)
    expect(new Set(calls.map(c => c.deduplicationKey))).toHaveLength(4)
    expect(new Set(calls.slice(0, 2).map(c => c.turnId))).toHaveLength(1)
    expect(new Set(calls.slice(2).map(c => c.turnId))).toHaveLength(1)
  })

  it('falls back to aggregate when usage.models has a single entry', async () => {
    await writeSession(tmpDir, 'my-project', 'sess-a', [
      userMessage('single', T1),
      completeEvent({
        total_input_tokens: 100,
        total_output_tokens: 10,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 2,
        cost: 0.01,
        models: [{ model: 'claude-sonnet-4-6', total_input_tokens: 100, total_output_tokens: 10, cost: 0.01 }],
      }, T2),
    ])

    const calls = await collect(tmpDir)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.model).toBe('anthropic/claude-sonnet-4-6')
    expect(calls[0]?.inputTokens).toBe(93)
    expect(calls[0]?.outputTokens).toBe(10)
    expect(calls[0]?.costUSD).toBe(0.01)
  })

  it('falls back to aggregate when usage.models is absent', async () => {
    await writeSession(tmpDir, 'my-project', 'sess-a', [
      userMessage('no model breakdown', T1),
      completeEvent({ total_input_tokens: 100, total_output_tokens: 10 }, T2),
    ])

    const calls = await collect(tmpDir)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.model).toBeTruthy()
  })
})

describe('bahulam provider - probeRoots', () => {
  it('returns the configured root path', async () => {
    const result = await createBahulamProvider(tmpDir).probeRoots()
    expect(result).toEqual([{ path: tmpDir, label: 'projects' }])
  })
})

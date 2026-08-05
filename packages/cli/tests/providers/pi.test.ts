import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, truncate, stat } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { createPiProvider, createOmpProvider } from '../../src/providers/pi.js'
import { MAX_SESSION_FILE_BYTES } from '../../src/fs-utils.js'
import { priceProviderCall } from '../../src/pricing-pass.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'
import { classifyTurn } from '../../src/classifier.js'
import type { ParsedApiCall, ParsedTurn } from '../../src/types.js'

// Mirrors src/parser.ts providerCallToTurn so we can assert that a Pi call's
// skills survive the classifier into `subCategory`, which is the sole input the
// session summary reads to build the "Skills & Agents" breakdown (#588).
function turnFromPiCall(call: ParsedProviderCall, userMessage = ''): ParsedTurn {
  const apiCall: ParsedApiCall = {
    provider: call.provider,
    model: call.model,
    usage: {
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      cacheCreationInputTokens: call.cacheCreationInputTokens,
      cacheReadInputTokens: call.cacheReadInputTokens,
      cachedInputTokens: call.cachedInputTokens,
      reasoningTokens: call.reasoningTokens,
      webSearchRequests: call.webSearchRequests,
    },
    costUSD: call.costUSD,
    tools: call.tools,
    mcpTools: call.tools.filter(t => t.startsWith('mcp__')),
    skills: call.skills ?? [],
    subagentTypes: call.subagentTypes ?? [],
    hasAgentSpawn: call.tools.includes('Agent'),
    hasPlanMode: call.tools.includes('EnterPlanMode'),
    speed: call.speed,
    timestamp: call.timestamp,
    bashCommands: call.bashCommands,
    deduplicationKey: call.deduplicationKey,
  }
  return { userMessage, assistantCalls: [apiCall], timestamp: call.timestamp, sessionId: call.sessionId }
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'pi-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function sessionMeta(opts: { id?: string; cwd?: string } = {}) {
  return JSON.stringify({
    type: 'session',
    version: 3,
    id: opts.id ?? 'sess-001',
    timestamp: '2026-04-14T10:00:00.000Z',
    cwd: opts.cwd ?? '/Users/test/myproject',
  })
}

// Oh My Pi (issue #845): a fixed-width title metadata line written before the
// `type: "session"` header, per upstream can1357/oh-my-pi@0ce330a.
function titleSlot(opts: { title?: string; pad?: string } = {}) {
  return JSON.stringify({
    type: 'title',
    v: 1,
    title: opts.title ?? 'My Session',
    updatedAt: '2026-04-14T10:00:00.000Z',
    pad: opts.pad ?? '',
  })
}

function userMessage(text: string, timestamp?: string) {
  return JSON.stringify({
    type: 'message',
    id: 'msg-user-1',
    timestamp: timestamp ?? '2026-04-14T10:00:10.000Z',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
      timestamp: 1776023210000,
    },
  })
}

function assistantMessage(opts: {
  id?: string
  responseId?: string
  timestamp?: string
  model?: string
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  tools?: Array<{ name: string; command?: string; path?: string; filePath?: string }>
}) {
  const content = (opts.tools ?? []).map(t => {
    const args: Record<string, unknown> = {}
    if (t.command !== undefined) args['command'] = t.command
    if (t.path !== undefined) args['path'] = t.path
    if (t.filePath !== undefined) args['file_path'] = t.filePath
    return {
      type: 'toolCall',
      id: `call-${t.name}`,
      name: t.name,
      arguments: args,
    }
  })

  return JSON.stringify({
    type: 'message',
    id: opts.id ?? 'msg-asst-1',
    timestamp: opts.timestamp ?? '2026-04-14T10:00:30.000Z',
    message: {
      role: 'assistant',
      content,
      api: 'openai-codex-responses',
      provider: 'openai-codex',
      model: opts.model ?? 'gpt-5.4',
      responseId: opts.responseId ?? 'resp-001',
      usage: {
        input: opts.input ?? 1000,
        output: opts.output ?? 200,
        cacheRead: opts.cacheRead ?? 0,
        cacheWrite: opts.cacheWrite ?? 0,
        totalTokens: (opts.input ?? 1000) + (opts.output ?? 200) + (opts.cacheRead ?? 0),
        cost: { input: 0.0025, output: 0.003, cacheRead: 0, cacheWrite: 0, total: 0.0055 },
      },
      stopReason: 'stop',
      timestamp: 1776023230000,
    },
  })
}

async function writeSession(projectDir: string, filename: string, lines: string[]) {
  await mkdir(projectDir, { recursive: true })
  const filePath = join(projectDir, filename)
  await writeFile(filePath, lines.join('\n') + '\n')
  return filePath
}

describe('pi provider - session discovery', () => {
  it('discovers sessions grouped by project directory', async () => {
    const projectDir = join(tmpDir, '--Users-test-myproject--')
    await writeSession(projectDir, '2026-04-14T10-00-00-000Z_sess-001.jsonl', [
      sessionMeta({ cwd: '/Users/test/myproject' }),
      assistantMessage({}),
    ])

    const provider = createPiProvider(tmpDir)
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.provider).toBe('pi')
    expect(sessions[0]!.project).toBe('myproject')
    expect(sessions[0]!.path).toContain('sess-001.jsonl')
  })

  it('discovers sessions across multiple project directories', async () => {
    const dir1 = join(tmpDir, '--Users-test-project-a--')
    const dir2 = join(tmpDir, '--Users-test-project-b--')
    await writeSession(dir1, 'session1.jsonl', [sessionMeta({ cwd: '/Users/test/project-a' }), assistantMessage({})])
    await writeSession(dir2, 'session2.jsonl', [sessionMeta({ cwd: '/Users/test/project-b' }), assistantMessage({})])

    const provider = createPiProvider(tmpDir)
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(2)
    const projects = sessions.map(s => s.project).sort()
    expect(projects).toEqual(['project-a', 'project-b'])
  })

  it('returns empty for non-existent directory', async () => {
    const provider = createPiProvider('/nonexistent/path/that/does/not/exist')
    const sessions = await provider.discoverSessions()
    expect(sessions).toEqual([])
  })

  it('skips files without a session entry', async () => {
    const projectDir = join(tmpDir, '--Users-test-myproject--')
    await writeSession(projectDir, 'bad.jsonl', [
      JSON.stringify({ type: 'message', id: 'x' }),
    ])

    const provider = createPiProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toEqual([])
  })

  it('skips non-jsonl files', async () => {
    const projectDir = join(tmpDir, '--Users-test-myproject--')
    await mkdir(projectDir, { recursive: true })
    await writeFile(join(projectDir, 'notes.txt'), 'not a session')

    const provider = createPiProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toEqual([])
  })

  // Issue #845: OMP writes a `type: "title"` metadata line before the
  // `type: "session"` header. Discovery must scan past it instead of only
  // checking the first physical line.
  it('discovers an OMP transcript with a title slot before the session record', async () => {
    const projectDir = join(tmpDir, '--Users-test-myproject--')
    await writeSession(projectDir, 'omp-session.jsonl', [
      titleSlot({ title: 'Fix the bug' }),
      sessionMeta({ cwd: '/Users/test/myproject' }),
      assistantMessage({}),
    ])

    const provider = createOmpProvider(tmpDir)
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.provider).toBe('omp')
    expect(sessions[0]!.project).toBe('myproject')
  })

  it('Pi and OMP discover an identical title-slot transcript the same way', async () => {
    const projectDir = join(tmpDir, '--Users-test-myproject--')
    const lines = [titleSlot(), sessionMeta({ cwd: '/Users/test/myproject' }), assistantMessage({})]
    await writeSession(projectDir, 'shared.jsonl', lines)

    const piSessions = await createPiProvider(tmpDir).discoverSessions()
    const ompSessions = await createOmpProvider(tmpDir).discoverSessions()

    expect(piSessions).toHaveLength(1)
    expect(ompSessions).toHaveLength(1)
    expect(piSessions[0]!.project).toBe(ompSessions[0]!.project)
  })

  it('tolerates blank lines before the session record', async () => {
    const projectDir = join(tmpDir, '--Users-test-myproject--')
    await writeSession(projectDir, 'blank-padded.jsonl', [
      titleSlot(),
      '',
      '',
      sessionMeta({ cwd: '/Users/test/myproject' }),
      assistantMessage({}),
    ])

    const provider = createOmpProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toHaveLength(1)
  })

  it('skips a malformed leading JSON line without throwing', async () => {
    const projectDir = join(tmpDir, '--Users-test-myproject--')
    await writeSession(projectDir, 'malformed-head.jsonl', [
      '{not valid json',
      sessionMeta({ cwd: '/Users/test/myproject' }),
      assistantMessage({}),
    ])

    const provider = createOmpProvider(tmpDir)
    await expect(provider.discoverSessions()).resolves.toHaveLength(1)
  })

  it('does not crash on a malformed session record with a non-string cwd (e.g. cwd: 42)', async () => {
    const projectDir = join(tmpDir, '--Users-test-myproject--')
    await writeSession(projectDir, 'bad-cwd.jsonl', [
      titleSlot({ title: 'Malformed record' }),
      JSON.stringify({ type: 'session', id: 'sess-bad', timestamp: '2026-04-14T10:00:00.000Z', cwd: 42 }),
      assistantMessage({}),
    ])

    // The title line puts the session record on line 2, past the old
    // first-line-only scan; a non-string cwd must fall back to the project
    // directory instead of reaching an unchecked basename(cwd).
    const provider = createOmpProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toHaveLength(1)
    // Falls back to the project dir name (basename of the single-segment
    // dirName), exactly as a missing cwd does.
    expect(sessions[0]!.project).toBe('--Users-test-myproject--')
  })

  it('excludes a message-only file with no session record', async () => {
    const projectDir = join(tmpDir, '--Users-test-myproject--')
    await writeSession(projectDir, 'messages-only.jsonl', [
      titleSlot(),
      userMessage('hello'),
      assistantMessage({}),
    ])

    const provider = createOmpProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toEqual([])
  })

  it('does not discover a session record beyond the bounded leading-line scan', async () => {
    const projectDir = join(tmpDir, '--Users-test-myproject--')
    // 25 non-session leading lines exceeds MAX_HEADER_LINES_SCANNED (20), so
    // the session record on line 26 must NOT be found. This guards the exact
    // bound: it fails if the scan is ever widened past 25 lines or replaced
    // by a scan-to-EOF for the session record. (The old first-line reader
    // happens to pass it too, so it is NOT the old-vs-new discriminator —
    // the oversize-transcript test below is: it fails against the old
    // whole-file reader.)
    const junkLines = Array.from({ length: 25 }, (_, i) => JSON.stringify({ type: 'message', id: `junk-${i}` }))
    await writeSession(projectDir, 'too-deep.jsonl', [
      ...junkLines,
      sessionMeta({ cwd: '/Users/test/myproject' }),
      assistantMessage({}),
    ])

    const provider = createOmpProvider(tmpDir)
    const sessions = await provider.discoverSessions()
    expect(sessions).toEqual([])
  })

  it('finds a session at the head of a transcript too large for the whole-file reader', async () => {
    const projectDir = join(tmpDir, '--Users-test-myproject--')
    // The old discovery read the entire transcript with the whole-file reader,
    // which refuses anything over MAX_SESSION_FILE_BYTES (128 MiB) — so a
    // session whose transcript is larger than that was silently invisible.
    // Discovery now streams a bounded twenty leading lines, so the record at
    // the head is found no matter how large the tail is. This is the
    // observable that distinguishes the bounded scan from a whole-file read:
    // against the old reader this test is red (oversize => no session found),
    // against the new one it is green. The file is extended past the cap with
    // a sparse hole via truncate, so no 128 MiB is actually written.
    const filePath = join(projectDir, 'oversize.jsonl')
    await writeSession(projectDir, 'oversize.jsonl', [
      titleSlot(),
      sessionMeta({ cwd: '/Users/test/myproject' }),
      assistantMessage({}),
    ])
    await truncate(filePath, MAX_SESSION_FILE_BYTES + 1024 * 1024)
    expect((await stat(filePath)).size).toBeGreaterThan(MAX_SESSION_FILE_BYTES)

    const provider = createOmpProvider(tmpDir)
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.project).toBe('myproject')
  })
})

describe('pi provider - JSONL parsing', () => {
  it('extracts token usage and metadata from an assistant message', async () => {
    const projectDir = join(tmpDir, '--Users-test-myproject--')
    const filePath = await writeSession(projectDir, 'session.jsonl', [
      sessionMeta({ id: 'sess-abc', cwd: '/Users/test/myproject' }),
      userMessage('implement the feature'),
      assistantMessage({
        responseId: 'resp-abc',
        timestamp: '2026-04-14T10:00:30.000Z',
        model: 'gpt-5.4',
        input: 2000,
        output: 400,
        cacheRead: 5000,
        cacheWrite: 100,
      }),
    ])

    const provider = createPiProvider(tmpDir)
    const source = { path: filePath, project: 'myproject', provider: 'pi' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(priceProviderCall(call))
    }

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.provider).toBe('pi')
    expect(call.model).toBe('gpt-5.4')
    expect(call.inputTokens).toBe(2000)
    expect(call.outputTokens).toBe(400)
    expect(call.cacheReadInputTokens).toBe(5000)
    expect(call.cachedInputTokens).toBe(5000)
    expect(call.cacheCreationInputTokens).toBe(100)
    expect(call.sessionId).toBe('sess-abc')
    expect(call.userMessage).toBe('implement the feature')
    expect(call.timestamp).toBe('2026-04-14T10:00:30.000Z')
    expect(call.costUSD).toBeGreaterThan(0)
    expect(call.deduplicationKey).toContain('pi:')
    expect(call.deduplicationKey).toContain('resp-abc')
  })

  it('does not crash when a user message content is a string instead of an array (issue #441)', async () => {
    const projectDir = join(tmpDir, '--Users-test-myproject--')
    // Pi legitimately writes string `content` for some (e.g. injected) user turns.
    // Before the fix this threw `content.filter is not a function`, which aborted
    // the whole backfill and silently emptied the trend/history.
    const stringContentUser = JSON.stringify({
      type: 'message',
      id: 'msg-user-str',
      timestamp: '2026-04-14T10:00:10.000Z',
      message: { role: 'user', content: 'test message from file watcher', timestamp: 1776023210000 },
    })
    const filePath = await writeSession(projectDir, 'session.jsonl', [
      sessionMeta({ id: 'sess-str', cwd: '/Users/test/myproject' }),
      stringContentUser,
      assistantMessage({ responseId: 'resp-str', input: 500, output: 80 }),
    ])

    const provider = createPiProvider(tmpDir)
    const source = { path: filePath, project: 'myproject', provider: 'pi' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(priceProviderCall(call))
    }

    // The assistant turn is still parsed, and the string user content is paired.
    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens).toBe(500)
    expect(calls[0]!.userMessage).toBe('test message from file watcher')
  })

  it('collects tool names from toolCall content items', async () => {
    const projectDir = join(tmpDir, '--Users-test-myproject--')
    const filePath = await writeSession(projectDir, 'session.jsonl', [
      sessionMeta(),
      assistantMessage({
        tools: [
          { name: 'read' },
          { name: 'edit' },
          { name: 'bash', command: 'git status' },
        ],
      }),
    ])

    const provider = createPiProvider(tmpDir)
    const source = { path: filePath, project: 'myproject', provider: 'pi' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(priceProviderCall(call))
    }

    expect(calls[0]!.tools).toEqual(['Read', 'Edit', 'Bash'])
  })

  it('extracts bash commands from bash tool arguments', async () => {
    const projectDir = join(tmpDir, '--Users-test-myproject--')
    const filePath = await writeSession(projectDir, 'session.jsonl', [
      sessionMeta(),
      assistantMessage({
        tools: [
          { name: 'bash', command: 'git status && bun test' },
        ],
      }),
    ])

    const provider = createPiProvider(tmpDir)
    const source = { path: filePath, project: 'myproject', provider: 'pi' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(priceProviderCall(call))
    }

    expect(calls[0]!.bashCommands).toEqual(['git', 'bun'])
  })

  it('classifies a SKILL.md read as a skill load, not a Read (#588)', async () => {
    const projectDir = join(tmpDir, '--Users-test-myproject--')
    const filePath = await writeSession(projectDir, 'session.jsonl', [
      sessionMeta(),
      assistantMessage({
        tools: [
          { name: 'read', path: '/Volumes/T7/repos/cuneiform/.pi/skills/bmad-create-story/SKILL.md' },
          { name: 'read', path: '/Volumes/T7/repos/cuneiform/workflow.md' },
          { name: 'edit', path: '/Volumes/T7/repos/cuneiform/workflow.md' },
        ],
      }),
    ])

    const provider = createPiProvider(tmpDir)
    const source = { path: filePath, project: 'myproject', provider: 'pi' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(priceProviderCall(call))
    }

    // The SKILL.md read is surfaced as the Skill tool (not Read); the plain
    // read stays a Read.
    expect(calls[0]!.skills).toEqual(['bmad-create-story'])
    expect(calls[0]!.tools).toEqual(['Skill', 'Read', 'Edit'])
  })

  it('classifies a skill:// read as a skill load (OMP-style URI)', async () => {
    const projectDir = join(tmpDir, '--Users-test-myproject--')
    const filePath = await writeSession(projectDir, 'session.jsonl', [
      sessionMeta(),
      assistantMessage({
        tools: [{ name: 'read', path: 'skill://commit-workflow' }],
      }),
    ])

    const provider = createPiProvider(tmpDir)
    const source = { path: filePath, project: 'myproject', provider: 'pi' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(priceProviderCall(call))
    }

    expect(calls[0]!.skills).toEqual(['commit-workflow'])
    expect(calls[0]!.tools).toEqual(['Skill'])
  })

  it('reads the file_path key as a fallback for skill loads', async () => {
    const projectDir = join(tmpDir, '--Users-test-myproject--')
    const filePath = await writeSession(projectDir, 'session.jsonl', [
      sessionMeta(),
      assistantMessage({
        tools: [{ name: 'read', filePath: '/home/u/.agents/skills/deep-research/SKILL.md' }],
      }),
    ])

    const provider = createPiProvider(tmpDir)
    const source = { path: filePath, project: 'myproject', provider: 'pi' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(priceProviderCall(call))
    }

    expect(calls[0]!.skills).toEqual(['deep-research'])
    expect(calls[0]!.tools).toEqual(['Skill'])
  })

  it('leaves a normal read (no SKILL.md) as a Read with no skills', async () => {
    const projectDir = join(tmpDir, '--Users-test-myproject--')
    const filePath = await writeSession(projectDir, 'session.jsonl', [
      sessionMeta(),
      assistantMessage({
        tools: [{ name: 'read', path: '/home/u/project/src/skill-loader.ts' }],
      }),
    ])

    const provider = createPiProvider(tmpDir)
    const source = { path: filePath, project: 'myproject', provider: 'pi' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(priceProviderCall(call))
    }

    expect(calls[0]!.skills).toEqual([])
    expect(calls[0]!.tools).toEqual(['Read'])
  })

  it('a pure skill-load turn classifies as general with the skill as subCategory (feeds the Skills breakdown, #588)', async () => {
    const projectDir = join(tmpDir, '--Users-test-myproject--')
    const filePath = await writeSession(projectDir, 'session.jsonl', [
      sessionMeta(),
      assistantMessage({
        tools: [{ name: 'read', path: '/home/u/.pi/agent/skills/systematic-debugging/SKILL.md' }],
      }),
    ])

    const provider = createPiProvider(tmpDir)
    const source = { path: filePath, project: 'myproject', provider: 'pi' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(priceProviderCall(call))
    }

    // End to end: the parsed skill load must reach `subCategory`, or the
    // Skills & Agents breakdown stays empty (the second half of #588).
    const classified = classifyTurn(turnFromPiCall(calls[0]!))
    expect(classified.category).toBe('general')
    expect(classified.subCategory).toBe('systematic-debugging')
  })

  it('skips assistant messages with zero tokens', async () => {
    const projectDir = join(tmpDir, '--Users-test-myproject--')
    const filePath = await writeSession(projectDir, 'session.jsonl', [
      sessionMeta(),
      assistantMessage({ input: 0, output: 0 }),
    ])

    const provider = createPiProvider(tmpDir)
    const source = { path: filePath, project: 'myproject', provider: 'pi' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(priceProviderCall(call))
    }

    expect(calls).toHaveLength(0)
  })

  it('deduplicates calls seen across multiple parses', async () => {
    const projectDir = join(tmpDir, '--Users-test-myproject--')
    const filePath = await writeSession(projectDir, 'session.jsonl', [
      sessionMeta(),
      assistantMessage({ responseId: 'resp-dup' }),
    ])

    const provider = createPiProvider(tmpDir)
    const source = { path: filePath, project: 'myproject', provider: 'pi' }
    const seenKeys = new Set<string>()

    const firstRun: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, seenKeys).parse()) {
      firstRun.push(priceProviderCall(call))
    }

    const secondRun: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, seenKeys).parse()) {
      secondRun.push(priceProviderCall(call))
    }

    expect(firstRun).toHaveLength(1)
    expect(secondRun).toHaveLength(0)
  })

  it('yields one call per assistant message in a multi-turn session', async () => {
    const projectDir = join(tmpDir, '--Users-test-myproject--')
    const filePath = await writeSession(projectDir, 'session.jsonl', [
      sessionMeta({ id: 'sess-multi' }),
      userMessage('first question'),
      assistantMessage({ responseId: 'resp-1', timestamp: '2026-04-14T10:00:30.000Z', input: 500, output: 100 }),
      userMessage('second question'),
      assistantMessage({ responseId: 'resp-2', timestamp: '2026-04-14T10:01:00.000Z', input: 600, output: 120 }),
    ])

    const provider = createPiProvider(tmpDir)
    const source = { path: filePath, project: 'myproject', provider: 'pi' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(priceProviderCall(call))
    }

    expect(calls).toHaveLength(2)
    expect(calls[0]!.userMessage).toBe('first question')
    expect(calls[0]!.inputTokens).toBe(500)
    expect(calls[1]!.userMessage).toBe('second question')
    expect(calls[1]!.inputTokens).toBe(600)
  })

  it('handles missing session file gracefully', async () => {
    const provider = createPiProvider(tmpDir)
    const source = { path: '/nonexistent/session.jsonl', project: 'test', provider: 'pi' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) {
      calls.push(priceProviderCall(call))
    }
    expect(calls).toHaveLength(0)
  })
})

describe('pi provider - display names', () => {
  const provider = createPiProvider('/tmp')

  it('has correct name and displayName', () => {
    expect(provider.name).toBe('pi')
    expect(provider.displayName).toBe('Pi')
  })

  it('maps known models to readable names', () => {
    expect(provider.modelDisplayName('gpt-5.4')).toBe('GPT-5.4')
    expect(provider.modelDisplayName('gpt-5.4-mini')).toBe('GPT-5.4 Mini')
    expect(provider.modelDisplayName('gpt-5')).toBe('GPT-5')
  })

  it('returns raw name for unknown models', () => {
    expect(provider.modelDisplayName('some-future-model')).toBe('some-future-model')
  })

  it('normalizes tool names to capitalized form', () => {
    expect(provider.toolDisplayName('bash')).toBe('Bash')
    expect(provider.toolDisplayName('read')).toBe('Read')
    expect(provider.toolDisplayName('unknown_tool')).toBe('unknown_tool')
  })
})

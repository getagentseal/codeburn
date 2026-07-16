import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { createOpenCodeProvider } from '../../src/providers/opencode.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'opencode-file-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

type Msg = { id: string; data: Record<string, unknown>; parts?: Array<Record<string, unknown>> }

// Mirrors the OpenCode 1.1+ on-disk layout under <dataDir>/storage/. `root`
// overrides the store root (default `tmpDir/opencode`) so a fork layout that
// lives outside an `opencode` subdir can be exercised via OPENCODE_DATA_DIR.
async function writeSession(opts: {
  sessionId?: string
  projectId?: string
  directory?: string
  title?: string
  root?: string
  messages: Msg[]
}) {
  const storage = join(opts.root ?? join(tmpDir, 'opencode'), 'storage')
  const sessionId = opts.sessionId ?? 'ses_test1'
  const projectId = opts.projectId ?? 'global'

  const sessionDir = join(storage, 'session', projectId)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, `${sessionId}.json`), JSON.stringify({
    id: sessionId,
    slug: 'cosmic-engine',
    version: '1.1.65',
    projectID: projectId,
    directory: opts.directory ?? '/Users/test/myproject',
    title: opts.title ?? 'Test session',
    time: { created: 1781886356809, updated: 1781886683506 },
  }))

  const messageDir = join(storage, 'message', sessionId)
  await mkdir(messageDir, { recursive: true })
  for (const m of opts.messages) {
    await writeFile(join(messageDir, `${m.id}.json`), JSON.stringify({ id: m.id, sessionID: sessionId, ...m.data }))
    if (m.parts?.length) {
      const partDir = join(storage, 'part', m.id)
      await mkdir(partDir, { recursive: true })
      let i = 0
      for (const p of m.parts) {
        await writeFile(join(partDir, `prt_${m.id}_${String(i++).padStart(3, '0')}.json`), JSON.stringify(p))
      }
    }
  }
  return { sessionId }
}

async function parseAll(seen = new Set<string>()): Promise<ParsedProviderCall[]> {
  const provider = createOpenCodeProvider(tmpDir)
  const sources = await provider.discoverSessions()
  const calls: ParsedProviderCall[] = []
  for (const source of sources) {
    for await (const call of provider.createSessionParser(source, seen).parse()) calls.push(call)
  }
  return calls
}

describe('opencode file-based provider - discovery', () => {
  it('discovers a file-based session and derives the project from directory', async () => {
    await writeSession({
      directory: '/Users/test/myproject',
      messages: [{
        id: 'msg_a',
        data: {
          role: 'assistant', modelID: 'gpt-5.3-codex-spark', cost: 0,
          tokens: { input: 1000, output: 200, reasoning: 50, cache: { read: 5000, write: 0 } },
          time: { created: 1781886356900 },
        },
        parts: [{ type: 'text', text: 'hello' }],
      }],
    })
    const provider = createOpenCodeProvider(tmpDir)
    const sources = await provider.discoverSessions()
    expect(sources).toHaveLength(1)
    expect(sources[0]!.provider).toBe('opencode')
    expect(sources[0]!.project).toBe('Users-test-myproject')
    expect(sources[0]!.path.endsWith('.json')).toBe(true)
  })

  it('returns nothing when neither file storage nor a DB exists', async () => {
    const provider = createOpenCodeProvider(tmpDir)
    expect(await provider.discoverSessions()).toEqual([])
  })
})

describe('opencode file-based provider - parsing', () => {
  it('extracts tokens, tools, bash commands, and the preceding user message', async () => {
    await writeSession({
      messages: [
        {
          id: 'msg_user',
          data: { role: 'user', time: { created: 1 } },
          parts: [{ type: 'text', text: 'find the git repos' }],
        },
        {
          id: 'msg_a',
          data: {
            role: 'assistant', modelID: 'gpt-5.3-codex-spark', cost: 0,
            tokens: { input: 1200, output: 300, reasoning: 100, cache: { read: 8000, write: 0 } },
            time: { created: 2 },
          },
          parts: [
            { type: 'reasoning' },
            { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'git status' } } },
            { type: 'tool', tool: 'read', state: { input: { filePath: '/x' } } },
            { type: 'text', text: 'done' },
          ],
        },
      ],
    })
    const calls = await parseAll()
    expect(calls).toHaveLength(1)
    const c = calls[0]!
    expect(c.provider).toBe('opencode')
    expect(c.model).toBe('gpt-5.3-codex-spark')
    expect(c.inputTokens).toBe(1200)
    expect(c.outputTokens).toBe(300)
    expect(c.reasoningTokens).toBe(100)
    expect(c.cacheReadInputTokens).toBe(8000)
    expect(c.cachedInputTokens).toBe(8000)
    expect(c.tools).toEqual(['Bash', 'Read'])
    expect(c.bashCommands).toContain('git')
    expect(c.userMessage).toBe('find the git repos')
    expect(c.deduplicationKey).toBe('opencode:ses_test1:msg_a')
  })

  it('extracts skill names and subagent types from skill/task tool parts', async () => {
    await writeSession({
      messages: [{
        id: 'msg_a',
        data: {
          role: 'assistant', modelID: 'gpt-5.3-codex-spark', cost: 0,
          tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1 },
        },
        parts: [
          { type: 'tool', tool: 'skill', state: { input: { name: 'commit' } } },
          { type: 'tool', tool: 'task', state: { input: { description: 'find files', subagent_type: 'explore' } } },
          { type: 'text', text: 'done' },
        ],
      }],
    })
    const calls = await parseAll()
    expect(calls).toHaveLength(1)
    const c = calls[0]!
    expect(c.tools).toEqual(['Skill', 'Agent'])
    expect(c.skills).toEqual(['commit'])
    expect(c.subagentTypes).toEqual(['explore'])
  })

  it('leaves skills and subagentTypes empty when no skill/task parts are present', async () => {
    await writeSession({
      messages: [{
        id: 'msg_a',
        data: {
          role: 'assistant', modelID: 'gpt-5.3-codex-spark', cost: 0,
          tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1 },
        },
        parts: [{ type: 'tool', tool: 'bash', state: { input: { command: 'ls' } } }],
      }],
    })
    const calls = await parseAll()
    expect(calls[0]!.skills).toEqual([])
    expect(calls[0]!.subagentTypes).toEqual([])
  })

  it('skips an errored or empty assistant turn (all-zero tokens, no parts)', async () => {
    await writeSession({
      messages: [{
        id: 'msg_err',
        data: {
          role: 'assistant', modelID: 'gpt-5.3-codex', cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1 },
        },
      }],
    })
    expect(await parseAll()).toHaveLength(0)
  })

  it('falls back to message.cost when the model has no price table', async () => {
    await writeSession({
      messages: [{
        id: 'msg_a',
        data: {
          role: 'assistant', modelID: 'totally-unknown-model-xyz', cost: 0.42,
          tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1 },
        },
        parts: [{ type: 'text', text: 'x' }],
      }],
    })
    const calls = await parseAll()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.costUSD).toBeCloseTo(0.42)
  })

  it('deduplicates across repeated parses', async () => {
    await writeSession({
      messages: [{
        id: 'msg_a',
        data: {
          role: 'assistant', modelID: 'gpt-5.3-codex-spark',
          tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1 },
        },
        parts: [{ type: 'text', text: 'x' }],
      }],
    })
    const seen = new Set<string>()
    expect(await parseAll(seen)).toHaveLength(1)
    expect(await parseAll(seen)).toHaveLength(0)
  })

  it('reads sessions across multiple project folders', async () => {
    await writeSession({
      sessionId: 'ses_one', projectId: 'global', directory: '/Users/test/a',
      messages: [{ id: 'm1', data: { role: 'assistant', modelID: 'gpt-5.3-codex-spark', tokens: { input: 10, output: 2 }, time: { created: 1 } }, parts: [{ type: 'text', text: 'x' }] }],
    })
    await writeSession({
      sessionId: 'ses_two', projectId: 'proj_hash', directory: '/Users/test/b',
      messages: [{ id: 'm2', data: { role: 'assistant', modelID: 'gpt-5.3-codex-spark', tokens: { input: 20, output: 4 }, time: { created: 1 } }, parts: [{ type: 'text', text: 'y' }] }],
    })
    const calls = await parseAll()
    expect(calls).toHaveLength(2)
    expect(calls.map((c) => c.sessionId).sort()).toEqual(['ses_one', 'ses_two'])
  })
})

describe('opencode file-based provider - env override discovery', () => {
  it('honors OPENCODE_DATA_DIR for a store under storage/session/ and parses its messages', async () => {
    // A renamed/forked OpenCode-compatible build writes file-based storage
    // directly under <forkDir>/storage (NOT under an 'opencode' subdir).
    const forkDir = join(tmpDir, 'mimocode')
    await writeSession({
      root: forkDir,
      sessionId: 'ses_mimo',
      directory: '/Users/test/mimoproject',
      messages: [{
        id: 'msg_a',
        data: {
          role: 'assistant', modelID: 'gpt-5.3-codex-spark', cost: 0,
          tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1 },
        },
        parts: [{ type: 'text', text: 'mimo output' }],
      }],
    })

    process.env.OPENCODE_DATA_DIR = forkDir
    const provider = createOpenCodeProvider() // no arg — must read env
    const sources = await provider.discoverSessions()

    expect(sources).toHaveLength(1)
    expect(sources[0]!.provider).toBe('opencode')
    expect(sources[0]!.path).toBe(join(forkDir, 'storage', 'session', 'global', 'ses_mimo.json'))

    const calls: ParsedProviderCall[] = []
    for (const source of sources) {
      for await (const call of provider.createSessionParser(source, new Set()).parse()) calls.push(call)
    }
    expect(calls).toHaveLength(1)
    expect(calls[0]!.sessionId).toBe('ses_mimo')
    expect(calls[0]!.deduplicationKey).toBe('opencode:ses_mimo:msg_a')
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { getAllProviders } from '../../src/providers/index.js'
import { createCursorAgentProvider } from '../../src/providers/cursor-agent.js'
import type { ParsedProviderCall, Provider, SessionSource } from '../../src/providers/types.js'
import { isSqliteAvailable } from '../../src/sqlite.js'

const CHARS_PER_TOKEN = 4
const CURSOR_AGENT_DEFAULT_MODEL = 'claude-sonnet-4-5'
const FIXED_UUID = '123e4567-e89b-12d3-a456-426614174000'

const skipUnlessSqlite = isSqliteAvailable() ? describe : describe.skip

type TestDb = {
  exec(sql: string): void
  prepare(sql: string): { run(...params: unknown[]): void }
  close(): void
}

let tempRoots: string[] = []

beforeEach(() => {
  tempRoots = []
})

afterEach(async () => {
  await Promise.all(tempRoots.filter(existsSync).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function makeBaseDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cursor-agent-test-'))
  tempRoots.push(dir)
  return dir
}

async function collectCalls(provider: Provider, source: SessionSource): Promise<ParsedProviderCall[]> {
  const calls: ParsedProviderCall[] = []
  for await (const call of provider.createSessionParser(source, new Set()).parse()) {
    calls.push(call)
  }
  return calls
}

function withTestDb(dbPath: string, fn: (db: TestDb) => void): void {
  const { DatabaseSync: Database } = require('node:sqlite')
  const db = new Database(dbPath)
  fn(db)
  db.close()
}

describe('cursor-agent provider', () => {
  it('is registered', async () => {
    const all = await getAllProviders()
    const provider = all.find((p) => p.name === 'cursor-agent')

    expect(provider).toBeDefined()
    expect(provider?.displayName).toBe('Cursor Agent')
  })

  it('maps default model to auto with estimation label', () => {
    const provider = createCursorAgentProvider('/tmp/nonexistent-cursor-agent-fixture')
    expect(provider.modelDisplayName('default')).toBe('Auto (Sonnet est.)')
  })

  it('maps known models and appends estimation label', () => {
    const provider = createCursorAgentProvider('/tmp/nonexistent-cursor-agent-fixture')

    expect(provider.modelDisplayName('claude-4.5-opus-high-thinking')).toBe('Opus 4.5 (Thinking) (est.)')
    expect(provider.modelDisplayName('claude-4.6-sonnet')).toBe('Sonnet 4.6 (est.)')
    expect(provider.modelDisplayName('composer-1')).toBe('Composer 1 (est.)')
  })

  it('falls through to raw model name for unknown models with single est. suffix', () => {
    const provider = createCursorAgentProvider('/tmp/nonexistent-cursor-agent-fixture')

    expect(provider.modelDisplayName('claude-5-future-model')).toBe('claude-5-future-model (est.)')
    expect(provider.modelDisplayName('gpt-9')).toBe('gpt-9 (est.)')
  })

  it('returns identity for tool display name', () => {
    const provider = createCursorAgentProvider('/tmp/nonexistent-cursor-agent-fixture')
    expect(provider.toolDisplayName('cursor:edit')).toBe('cursor:edit')
  })

  it('returns empty discovery when projects dir is missing', async () => {
    const baseDir = await makeBaseDir()
    const provider = createCursorAgentProvider(baseDir)
    const sources = await provider.discoverSessions()

    expect(sources).toEqual([])
  })

  it('discovers a single transcript', async () => {
    const baseDir = await makeBaseDir()
    const transcriptDir = join(baseDir, 'projects', 'test-proj', 'agent-transcripts')
    await mkdir(transcriptDir, { recursive: true })
    const transcriptPath = join(transcriptDir, `${FIXED_UUID}.txt`)
    await writeFile(transcriptPath, 'user:\n<user_query>hello</user_query>\nA:\nworld\n')

    const provider = createCursorAgentProvider(baseDir)
    const sources = await provider.discoverSessions()

    expect(sources).toHaveLength(1)
    expect(sources[0]!.provider).toBe('cursor-agent')
    expect(sources[0]!.path).toBe(transcriptPath)
  })

  it('discovers transcripts across multiple projects', async () => {
    const baseDir = await makeBaseDir()
    const transcriptA = join(baseDir, 'projects', 'proj-one', 'agent-transcripts')
    const transcriptB = join(baseDir, 'projects', 'proj-two', 'agent-transcripts')
    await mkdir(transcriptA, { recursive: true })
    await mkdir(transcriptB, { recursive: true })
    await writeFile(join(transcriptA, `${FIXED_UUID}.txt`), 'user:\n<user_query>a</user_query>\nA:\na\n')
    await writeFile(join(transcriptB, `${FIXED_UUID}.txt`), 'user:\n<user_query>b</user_query>\nA:\nb\n')

    const provider = createCursorAgentProvider(baseDir)
    const sources = await provider.discoverSessions()

    expect(sources).toHaveLength(2)
    expect(sources.every((s) => s.provider === 'cursor-agent')).toBe(true)
  })

  it('parses one user/assistant pair with estimated token counts', async () => {
    const baseDir = await makeBaseDir()
    const transcriptDir = join(baseDir, 'projects', 'my-proj', 'agent-transcripts')
    await mkdir(transcriptDir, { recursive: true })

    const userText = 'explain parser output'
    const assistantText = 'first line\nsecond line'
    const transcriptPath = join(transcriptDir, `${FIXED_UUID}.txt`)

    await writeFile(
      transcriptPath,
      `user:\n<user_query>${userText}</user_query>\nA:\n${assistantText}\n`
    )

    const provider = createCursorAgentProvider(baseDir)
    const source = (await provider.discoverSessions())[0]!
    const calls = await collectCalls(provider, source)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.provider).toBe('cursor-agent')
    expect(calls[0]!.model).toBe(CURSOR_AGENT_DEFAULT_MODEL)
    expect(calls[0]!.inputTokens).toBe(Math.ceil(userText.length / CHARS_PER_TOKEN))
    expect(calls[0]!.outputTokens).toBe(Math.ceil(assistantText.length / CHARS_PER_TOKEN))
    expect(calls[0]!.reasoningTokens).toBe(0)
    expect(calls[0]!.deduplicationKey).toBe(`cursor-agent:${FIXED_UUID}:0`)
  })

  it('parses without sqlite db and defaults model', async () => {
    const baseDir = await makeBaseDir()
    const transcriptDir = join(baseDir, 'projects', 'fallback-proj', 'agent-transcripts')
    await mkdir(transcriptDir, { recursive: true })
    const transcriptPath = join(transcriptDir, `${FIXED_UUID}.txt`)

    await writeFile(transcriptPath, 'user:\n<user_query>hello world</user_query>\nA:\n[Thinking]private\nvisible\n')

    const provider = createCursorAgentProvider(baseDir)
    const source = (await provider.discoverSessions())[0]!
    const calls = await collectCalls(provider, source)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.model).toBe(CURSOR_AGENT_DEFAULT_MODEL)
    expect(calls[0]!.reasoningTokens).toBe(2)
    expect(calls[0]!.outputTokens).toBe(2)
  })

  it('skips unrecognized transcript format and writes stderr message', async () => {
    const baseDir = await makeBaseDir()
    const transcriptDir = join(baseDir, 'projects', 'bad-proj', 'agent-transcripts')
    await mkdir(transcriptDir, { recursive: true })
    const transcriptPath = join(transcriptDir, `${FIXED_UUID}.txt`)
    await writeFile(transcriptPath, 'no markers in this transcript')

    const provider = createCursorAgentProvider(baseDir)
    const source = (await provider.discoverSessions())[0]!
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const calls = await collectCalls(provider, source)

    expect(calls).toHaveLength(0)
    expect(stderrSpy).toHaveBeenCalled()
    expect(String(stderrSpy.mock.calls[0]?.[0] ?? '')).toContain('unrecognized cursor-agent transcript format')

    stderrSpy.mockRestore()
  })

  it('falls back to stable sha1 conversation id for non-uuid filenames', async () => {
    const baseDir = await makeBaseDir()
    const transcriptDir = join(baseDir, 'projects', 'sha-proj', 'agent-transcripts')
    await mkdir(transcriptDir, { recursive: true })
    const transcriptPath = join(transcriptDir, 'not-a-uuid.txt')
    await writeFile(transcriptPath, 'user:\n<user_query>test</user_query>\nA:\nresult\n')

    const provider = createCursorAgentProvider(baseDir)
    const source = (await provider.discoverSessions())[0]!

    const callsFirst = await collectCalls(provider, source)
    const callsSecond = await collectCalls(provider, source)

    expect(callsFirst).toHaveLength(1)
    expect(callsSecond).toHaveLength(1)
    expect(callsFirst[0]!.sessionId).toHaveLength(16)
    expect(callsFirst[0]!.deduplicationKey.startsWith('cursor-agent:')).toBe(true)
    expect(callsFirst[0]!.sessionId).toBe(callsSecond[0]!.sessionId)
    expect(callsFirst[0]!.deduplicationKey).toBe(callsSecond[0]!.deduplicationKey)
  })
})

skipUnlessSqlite('cursor-agent sqlite metadata', () => {
  it('uses model metadata from ai-code-tracking db when present', async () => {
    const baseDir = await makeBaseDir()
    const transcriptDir = join(baseDir, 'projects', 'proj-with-db', 'agent-transcripts')
    const aiTrackingDir = join(baseDir, 'ai-tracking')
    await mkdir(transcriptDir, { recursive: true })
    await mkdir(aiTrackingDir, { recursive: true })

    await writeFile(
      join(transcriptDir, `${FIXED_UUID}.txt`),
      'user:\n<user_query>estimate cost</user_query>\nA:\nanswer\n'
    )

    const dbPath = join(aiTrackingDir, 'ai-code-tracking.db')
    withTestDb(dbPath, (db) => {
      db.exec('CREATE TABLE conversation_summaries (conversationId TEXT, title TEXT, tldr TEXT, model TEXT, mode TEXT, updatedAt INTEGER)')
      db.prepare('INSERT INTO conversation_summaries (conversationId, title, tldr, model, mode, updatedAt) VALUES (?, ?, ?, ?, ?, ?)')
        .run(FIXED_UUID, 'Demo title', '', 'claude-4.6-sonnet', 'agent', 1735689600000)
    })

    const provider = createCursorAgentProvider(baseDir)
    const source = (await provider.discoverSessions())[0]!
    const calls = await collectCalls(provider, source)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.model).toBe('claude-4.6-sonnet')
    expect(calls[0]!.timestamp).toBe('2025-01-01T00:00:00.000Z')
  })
})

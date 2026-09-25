import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { getAllProviders } from '../../src/providers/index.js'
import { createCursorAgentProvider } from '../../src/providers/cursor-agent.js'
import { estimateTokensFromChars } from '../../src/token-estimate.js'
import type { ParsedProviderCall, Provider, SessionSource } from '../../src/providers/types.js'
import { isSqliteAvailable } from '../../src/sqlite.js'

const CURSOR_AGENT_DEFAULT_MODEL = 'cursor-agent-auto'
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

  it('maps default model to Cursor (auto) label', () => {
    const provider = createCursorAgentProvider('/tmp/nonexistent-cursor-agent-fixture')
    expect(provider.modelDisplayName('cursor-agent-auto')).toBe('Cursor (auto)')
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
    expect(provider.modelDisplayName('gpt-5.6-sol')).toBe('GPT-5.6 Sol (est.)')
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

  it('does not scan a workspace root when agent-transcripts is missing', async () => {
    const baseDir = await makeBaseDir()
    const workspaceRoot = join(baseDir, 'projects', 'workspace-without-transcripts')
    await mkdir(workspaceRoot, { recursive: true })
    await writeFile(
      join(workspaceRoot, 'extension-state.txt'),
      'user:\n<user_query>not a transcript</user_query>\nA:\nnot a cursor-agent answer\n',
    )

    const provider = createCursorAgentProvider(baseDir)
    const sources = await provider.discoverSessions()

    expect(sources).toEqual([])
  })

  it('prefers jsonl over same-session txt inside UUID transcript dirs', async () => {
    const baseDir = await makeBaseDir()
    const sessionDir = join(baseDir, 'projects', 'proj-with-duplicates', 'agent-transcripts', FIXED_UUID)
    const jsonlPath = join(sessionDir, `${FIXED_UUID}.jsonl`)
    const txtPath = join(sessionDir, `${FIXED_UUID}.txt`)
    await mkdir(sessionDir, { recursive: true })
    await writeFile(
      jsonlPath,
      '{"role":"user","message":{"content":[{"type":"text","text":"<user_query>jsonl wins</user_query>"}]}}\n{"role":"assistant","message":{"content":[{"type":"text","text":"jsonl answer"}]}}\n',
    )
    await writeFile(txtPath, 'user:\n<user_query>txt duplicate</user_query>\nA:\ntxt answer\n')

    const provider = createCursorAgentProvider(baseDir)
    const sources = await provider.discoverSessions()

    expect(sources).toHaveLength(1)
    expect(sources[0]!.path).toBe(jsonlPath)
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
    expect(calls[0]!.inputTokens).toBe(estimateTokensFromChars(userText.length))
    expect(calls[0]!.outputTokens).toBe(estimateTokensFromChars(assistantText.length))
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

  it('warns only once for the same unrecognized transcript', async () => {
    const baseDir = await makeBaseDir()
    const transcriptDir = join(baseDir, 'projects', 'bad-proj-repeat', 'agent-transcripts')
    await mkdir(transcriptDir, { recursive: true })
    const transcriptPath = join(transcriptDir, 'repeat-bad.txt')
    await writeFile(transcriptPath, 'no cursor-agent markers here')

    const provider = createCursorAgentProvider(baseDir)
    const source = (await provider.discoverSessions())[0]!
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    await collectCalls(provider, source)
    await collectCalls(provider, source)

    const warnings = stderrSpy.mock.calls
      .map(call => String(call[0] ?? ''))
      .filter(message => message.includes('unrecognized cursor-agent transcript format'))
    expect(warnings).toHaveLength(1)

    stderrSpy.mockRestore()
  })

  it('does not warn for a jsonl transcript that ended before any assistant message', async () => {
    const baseDir = await makeBaseDir()
    const sessionDir = join(baseDir, 'projects', 'stub-proj', 'agent-transcripts', FIXED_UUID)
    await mkdir(sessionDir, { recursive: true })
    await writeFile(
      join(sessionDir, `${FIXED_UUID}.jsonl`),
      '{"type":"turn_ended","status":"error","error":"Other Models usage limit reached"}\n',
    )

    const provider = createCursorAgentProvider(baseDir)
    const source = (await provider.discoverSessions())[0]!
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const calls = await collectCalls(provider, source)

    expect(calls).toHaveLength(0)
    expect(stderrSpy).not.toHaveBeenCalled()

    stderrSpy.mockRestore()
  })

  it('discovers jsonl transcripts stored directly under project dir (workspace-less layout)', async () => {
    const baseDir = await makeBaseDir()
    const fixtureRoot = join(import.meta.dirname, '../fixtures/cursor-agent/workspace-less')
    const sessionDir = join(baseDir, 'projects', 'agent-transcripts', '1031d227-0c67-4e17-8954-0b6e2b3322f0')
    await mkdir(sessionDir, { recursive: true })
    await writeFile(
      join(sessionDir, '1031d227-0c67-4e17-8954-0b6e2b3322f0.jsonl'),
      await readFile(
        join(
          fixtureRoot,
          'projects/agent-transcripts/1031d227-0c67-4e17-8954-0b6e2b3322f0/1031d227-0c67-4e17-8954-0b6e2b3322f0.jsonl',
        ),
        'utf-8',
      ),
    )

    const provider = createCursorAgentProvider(baseDir)
    const sources = await provider.discoverSessions()

    expect(sources).toHaveLength(1)
    expect(sources[0]!.project).toBe('transcripts')
    expect(sources[0]!.path.endsWith('.jsonl')).toBe(true)

    const calls = await collectCalls(provider, sources[0]!)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.sessionId).toBe('1031d227-0c67-4e17-8954-0b6e2b3322f0')
    expect(calls[0]!.userMessage).toBe('Run a quick smoke test')
    expect(calls[0]!.costUSD).toBeGreaterThan(0)
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

  it('counts every assistant message after one user message (jsonl)', async () => {
    const baseDir = await makeBaseDir()
    const sessionDir = join(baseDir, 'projects', 'multi-proj', 'agent-transcripts', FIXED_UUID)
    await mkdir(sessionDir, { recursive: true })
    await writeFile(
      join(sessionDir, `${FIXED_UUID}.jsonl`),
      '{"role":"user","message":{"content":[{"type":"text","text":"<user_query>do it</user_query>"}]}}\n' +
      '{"role":"assistant","message":{"content":[{"type":"text","text":"step one"}]}}\n' +
      '{"role":"assistant","message":{"content":[{"type":"text","text":"step two"}]}}\n' +
      '{"role":"assistant","message":{"content":[{"type":"text","text":"step three"}]}}\n',
    )

    const provider = createCursorAgentProvider(baseDir)
    const source = (await provider.discoverSessions())[0]!
    const calls = await collectCalls(provider, source)

    expect(calls).toHaveLength(3)
    expect(calls.map(c => c.deduplicationKey)).toEqual([
      `cursor-agent:${FIXED_UUID}:0`,
      `cursor-agent:${FIXED_UUID}:1`,
      `cursor-agent:${FIXED_UUID}:2`,
    ])
    expect(calls.every(c => c.userMessage === 'do it')).toBe(true)
    expect(calls.map(c => c.inputTokens)).toEqual([estimateTokensFromChars('do it'.length), 0, 0])
  })

  it('counts tool_use inputs in output tokens (jsonl)', async () => {
    const baseDir = await makeBaseDir()
    const sessionDir = join(baseDir, 'projects', 'tool-proj', 'agent-transcripts', FIXED_UUID)
    await mkdir(sessionDir, { recursive: true })
    const toolInput = { path: '/some/very/long/path/to/a/file/that/adds/chars.txt' }
    await writeFile(
      join(sessionDir, `${FIXED_UUID}.jsonl`),
      '{"role":"user","message":{"content":[{"type":"text","text":"<user_query>read it</user_query>"}]}}\n' +
      `{"role":"assistant","message":{"content":[{"type":"text","text":"ok"},{"type":"tool_use","name":"Read","input":${JSON.stringify(toolInput)}}]}}\n`,
    )

    const provider = createCursorAgentProvider(baseDir)
    const source = (await provider.discoverSessions())[0]!
    const calls = await collectCalls(provider, source)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.tools).toEqual(['cursor:read'])
    expect(calls[0]!.outputTokens).toBe(
      estimateTokensFromChars(('ok\n' + JSON.stringify(toolInput)).trim().length),
    )
  })

  it('accounts full user text while keeping display truncated (jsonl)', async () => {
    const baseDir = await makeBaseDir()
    const sessionDir = join(baseDir, 'projects', 'long-proj', 'agent-transcripts', FIXED_UUID)
    await mkdir(sessionDir, { recursive: true })
    const longText = 'x'.repeat(2000)
    await writeFile(
      join(sessionDir, `${FIXED_UUID}.jsonl`),
      `{"role":"user","message":{"content":[{"type":"text","text":"<user_query>${longText}</user_query>"}]}}\n` +
      '{"role":"assistant","message":{"content":[{"type":"text","text":"done"}]}}\n',
    )

    const provider = createCursorAgentProvider(baseDir)
    const source = (await provider.discoverSessions())[0]!
    const calls = await collectCalls(provider, source)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens).toBe(estimateTokensFromChars(longText.length))
    expect(calls[0]!.userMessage).toHaveLength(500)
  })

  it('counts every assistant block after one user block (txt)', async () => {
    const baseDir = await makeBaseDir()
    const transcriptDir = join(baseDir, 'projects', 'txt-multi', 'agent-transcripts')
    await mkdir(transcriptDir, { recursive: true })
    await writeFile(
      join(transcriptDir, `${FIXED_UUID}.txt`),
      'user:\n<user_query>go</user_query>\nA:\nfirst\nA:\nsecond\n',
    )

    const provider = createCursorAgentProvider(baseDir)
    const source = (await provider.discoverSessions())[0]!
    const calls = await collectCalls(provider, source)

    expect(calls).toHaveLength(2)
    expect(calls.every(c => c.userMessage === 'go')).toBe(true)
    expect(calls.map(c => c.inputTokens)).toEqual([estimateTokensFromChars('go'.length), 0])
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

const STORE_AGENT_ID = '0b9e6f3a-5c2d-4e8f-9a1b-2c3d4e5f6a7b'

function protoVarint(n: number): number[] {
  const out: number[] = []
  while (n >= 128) {
    out.push((n % 128) | 0x80)
    n = Math.floor(n / 128)
  }
  out.push(n)
  return out
}

function protoBytes(field: number, bytes: Uint8Array): number[] {
  return [...protoVarint(field * 8 + 2), ...protoVarint(bytes.length), ...bytes]
}

type StoreFixture = { roots: object[][]; createdAt?: number; meta?: string; workspace?: string }

// Shape redacted from a real Cursor CLI store.db: hex JSON meta under key '0',
// JSON message blobs and protobuf conversation roots in `blobs`.
function writeStoreDb(dbPath: string, fixture: StoreFixture): void {
  const { createHash } = require('crypto')
  withTestDb(dbPath, (db) => {
    db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
    const insert = db.prepare('INSERT OR IGNORE INTO blobs (id, data) VALUES (?, ?)')
    let latest = ''
    for (const messages of fixture.roots) {
      const root: number[] = []
      for (const message of messages) {
        const data = Buffer.from(JSON.stringify(message))
        const id = createHash('sha256').update(data).digest()
        insert.run(id.toString('hex'), data)
        root.push(...protoBytes(1, id))
      }
      root.push(...protoBytes(9, Buffer.from(fixture.workspace ?? 'file:///Users/dev/Projects/store-app')))
      root.push(...protoVarint(26 * 8), ...protoVarint(fixture.createdAt ?? 1788443573805))
      const rootData = Buffer.from(root)
      latest = createHash('sha256').update(rootData).digest('hex')
      insert.run(latest, rootData)
    }
    const meta = fixture.meta ?? Buffer.from(JSON.stringify({
      agentId: STORE_AGENT_ID,
      latestRootBlobId: latest,
      name: 'New Agent',
      mode: 'default',
      isRunEverything: false,
      createdAt: fixture.createdAt ?? 1788443573805,
      blobEncryptionKey: 'fixture-secret-never-read',
    })).toString('hex')
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('0', meta)
  })
}

async function makeStore(baseDir: string, fixture: StoreFixture): Promise<string> {
  const dir = join(baseDir, 'chats', '1fcd87990ff06081250de865a4bb5c27', STORE_AGENT_ID)
  await mkdir(dir, { recursive: true })
  const dbPath = join(dir, 'store.db')
  writeStoreDb(dbPath, fixture)
  return dbPath
}

const SYSTEM_MSG = { role: 'system', content: 'You are an AI coding assistant.' }
const USER_INFO_MSG = { role: 'user', content: '<user_info>\nOS Version: darwin\n</user_info>' }
const PROMPT_MSG = {
  role: 'user',
  content: [{ type: 'text', text: '<timestamp>Thursday, Sep 3, 2026, 6:52 AM (UTC-7)</timestamp>\n<user_query>\nfix the build\n</user_query>' }],
}
const STEP_ONE = {
  id: '1',
  role: 'assistant',
  content: [
    { type: 'reasoning', text: 'Looking at the build.', signature: 'sig', providerOptions: { cursor: { modelName: 'claude-4.6-sonnet' } } },
    { type: 'tool-call', toolCallId: 'toolu_1', toolName: 'Shell', args: { command: 'npm run build' } },
  ],
}
const TOOL_RESULT = { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'toolu_1', toolName: 'Shell', result: 'ok' }] }
const STEP_TWO = { id: '1', role: 'assistant', content: [{ type: 'text', text: 'Build fixed.' }] }

skipUnlessSqlite('cursor-agent store.db sessions', () => {
  it('reads a store-only session with the transcript accounting rules', async () => {
    const baseDir = await makeBaseDir()
    const dbPath = await makeStore(baseDir, {
      roots: [[SYSTEM_MSG, USER_INFO_MSG, PROMPT_MSG, STEP_ONE, TOOL_RESULT, { role: 'assistant', content: [] }, STEP_TWO]],
    })

    const provider = createCursorAgentProvider(baseDir)
    const sources = await provider.discoverSessions()
    expect(sources.map(s => s.path)).toEqual([dbPath])

    const calls = await collectCalls(provider, sources[0]!)
    expect(calls).toHaveLength(2)
    expect(calls.map(c => c.deduplicationKey)).toEqual([`cursor-agent:${STORE_AGENT_ID}:0`, `cursor-agent:${STORE_AGENT_ID}:1`])
    expect(calls[0]!.inputTokens).toBe(estimateTokensFromChars('fix the build'.length))
    expect(calls[1]!.inputTokens).toBe(0)
    expect(calls[0]!.outputTokens).toBe(estimateTokensFromChars(JSON.stringify({ command: 'npm run build' }).length))
    expect(calls[0]!.reasoningTokens).toBe(estimateTokensFromChars('Looking at the build.'.length))
    expect(calls[0]!.tools).toEqual(['cursor:shell'])
    expect(calls.every(c => c.model === CURSOR_AGENT_DEFAULT_MODEL)).toBe(true)
    expect(calls.every(c => c.timestamp === '2026-09-03T13:52:00.000Z')).toBe(true)
    expect(calls.every(c => c.costIsEstimated && c.sessionId === STORE_AGENT_ID && c.project === 'app')).toBe(true)
    expect(calls[0]!.userMessage).toBe('fix the build')
  })

  it('skips a store whose session has a transcript, so it counts once', async () => {
    const baseDir = await makeBaseDir()
    await makeStore(baseDir, { roots: [[SYSTEM_MSG, PROMPT_MSG, STEP_TWO]] })
    const transcriptDir = join(baseDir, 'projects', 'Users-dev-Projects-store-app', 'agent-transcripts', STORE_AGENT_ID)
    await mkdir(transcriptDir, { recursive: true })
    const transcriptPath = join(transcriptDir, `${STORE_AGENT_ID}.jsonl`)
    await writeFile(transcriptPath, [
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '<user_query>fix the build</user_query>' }] } }),
      JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'Build fixed.' }] } }),
    ].join('\n'))

    const sources = await createCursorAgentProvider(baseDir).discoverSessions()
    expect(sources.map(s => s.path)).toEqual([transcriptPath])
  })

  it('keeps messages Cursor summarized out of the latest root', async () => {
    const baseDir = await makeBaseDir()
    const summary = { role: 'user', content: [{ type: 'text', text: '[Previous conversation summary] ...' }] }
    const secondPrompt = { role: 'user', content: [{ type: 'text', text: '<timestamp>Thursday, Sep 3, 2026, 11:05 PM (UTC-7)</timestamp>\n<user_query>now ship it</user_query>' }] }
    const shipped = { role: 'assistant', content: [{ type: 'text', text: 'Shipped.' }] }
    await makeStore(baseDir, {
      roots: [
        [SYSTEM_MSG, PROMPT_MSG, STEP_ONE],
        [SYSTEM_MSG, PROMPT_MSG, STEP_ONE, TOOL_RESULT, STEP_TWO],
        [SYSTEM_MSG, summary, secondPrompt, shipped],
      ],
    })

    const provider = createCursorAgentProvider(baseDir)
    const calls = await collectCalls(provider, (await provider.discoverSessions())[0]!)
    expect(calls.map(c => c.userMessage)).toEqual(['fix the build', 'fix the build', 'now ship it'])
    expect(calls.map(c => c.inputTokens > 0)).toEqual([true, false, true])
    expect(calls[2]!.timestamp).toBe('2026-09-04T06:05:00.000Z')
  })

  it('skips a store with malformed meta without leaking it', async () => {
    const baseDir = await makeBaseDir()
    await makeStore(baseDir, { roots: [[PROMPT_MSG, STEP_TWO]], meta: 'zz-not-hex-fixture-secret' })
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const provider = createCursorAgentProvider(baseDir)
    const calls = await collectCalls(provider, (await provider.discoverSessions())[0]!)
    const written = stderr.mock.calls.map(c => String(c[0])).join('')
    stderr.mockRestore()

    expect(calls).toEqual([])
    expect(written).toContain('unrecognized cursor-agent store')
    expect(written).not.toContain('fixture-secret')
  })
})

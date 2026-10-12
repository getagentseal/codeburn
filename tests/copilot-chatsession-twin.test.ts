// A VS Code chat session that also ran on the agent host is counted once, from
// the agent host. Decided at serve time over the whole cached Copilot set.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createRequire } from 'node:module'

import { isSqliteAvailable } from '../src/sqlite.js'
import { clearLoadCacheMemo } from '../src/session-cache.js'
import { clearSessionCache, parseAllSessions } from '../src/parser.js'

const requireForTest = createRequire(import.meta.url)
type TestDb = { exec(sql: string): void; prepare(sql: string): { run(...p: unknown[]): void }; close(): void }

const ENV_KEYS = ['HOME', 'USERPROFILE', 'CODEBURN_CACHE_DIR', 'CODEBURN_COPILOT_SESSION_STORE_DB', 'CODEBURN_COPILOT_DISABLE_OTEL',
  'CODEBURN_COPILOT_SESSION_STATE_DIR', 'CODEBURN_COPILOT_WS_STORAGE_DIR', 'CODEBURN_COPILOT_GLOBAL_STORAGE_DIR', 'CODEBURN_COPILOT_JETBRAINS_DIR']
let saved: Record<string, string | undefined>
let tmp: string

const ev = (type: string, timestamp: string, data: Record<string, unknown>) => JSON.stringify({ type, timestamp, data })

async function writeJournal(sessionId: string) {
  const dir = join(tmp, 'global', 'emptyWindowChatSessions')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${sessionId}.jsonl`), JSON.stringify({ kind: 0, v: { sessionId, creationDate: Date.parse('2026-08-05T12:00:00Z'), requests: [{
    requestId: 'r1', modelId: 'copilot/gpt-4o', timestamp: Date.parse('2026-08-05T12:00:00Z'), promptTokens: 1000, completionTokens: 50, copilotCredits: 2,
  }] } }) + '\n')
}

async function writeSessionState(sessionId: string, lines: string[]) {
  const dir = join(tmp, 'session-state', sessionId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'workspace.yaml'), `id: ${sessionId}\ncwd: /tmp/proj\n`)
  await writeFile(join(dir, 'events.jsonl'), lines.join('\n') + '\n')
}

function writeStore(sessionId: string) {
  const { DatabaseSync } = requireForTest('node:sqlite') as { DatabaseSync: new (path: string) => TestDb }
  const db = new DatabaseSync(join(tmp, 'session-store.db'))
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, branch TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE assistant_usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), model TEXT NOT NULL,
      input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER,
      total_nano_aiu INTEGER, request_multiplier REAL, created_at TEXT DEFAULT (datetime('now'))
    );
  `)
  db.prepare(`INSERT INTO sessions (id, cwd) VALUES (?, '/tmp/proj')`).run(sessionId)
  db.prepare(`INSERT INTO assistant_usage_events (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_nano_aiu, created_at)
    VALUES (?, 'gpt-4o', 1000, 50, 0, 0, 0, 2000000000, '2026-08-05T12:00:01.000Z')`).run(sessionId)
  db.close()
}

async function servedKeys(): Promise<string[]> {
  clearSessionCache()
  const projects = await parseAllSessions(undefined, 'copilot')
  return projects.flatMap(p => p.sessions).flatMap(s => s.turns).flatMap(t => t.assistantCalls).map(c => c.deduplicationKey).sort()
}

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
  tmp = await mkdtemp(join(tmpdir(), 'copilot-twin-'))
  Object.assign(process.env, {
    HOME: tmp, USERPROFILE: tmp, CODEBURN_CACHE_DIR: join(tmp, 'cache'),
    CODEBURN_COPILOT_SESSION_STORE_DB: join(tmp, 'session-store.db'), CODEBURN_COPILOT_DISABLE_OTEL: '1',
    CODEBURN_COPILOT_SESSION_STATE_DIR: join(tmp, 'session-state'), CODEBURN_COPILOT_WS_STORAGE_DIR: join(tmp, 'no-ws'),
    CODEBURN_COPILOT_GLOBAL_STORAGE_DIR: join(tmp, 'global'), CODEBURN_COPILOT_JETBRAINS_DIR: join(tmp, 'no-jb'),
  })
})

afterEach(async () => {
  clearSessionCache()
  clearLoadCacheMemo()
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  await rm(tmp, { recursive: true, force: true })
})

describe('copilot chat-session twins of agent-host sessions', () => {
  it('drops the journal copy when a session-state rollup bills the session', async () => {
    await writeJournal('twin')
    await writeJournal('solo')
    await writeSessionState('twin', [
      ev('session.start', '2026-08-05T11:59:00Z', { selectedModel: 'gpt-4o' }),
      ev('assistant.message', '2026-08-05T12:00:00Z', { messageId: 'm1', model: 'gpt-4o', toolRequests: [] }),
      ev('session.shutdown', '2026-08-05T12:01:00Z', {
        shutdownType: 'routine',
        modelMetrics: { 'gpt-4o': { usage: { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 }, totalNanoAiu: 2_000_000_000 } },
      }),
    ])

    const keys = await servedKeys()
    expect(keys).toContain('copilot-chatsession:solo:r1')
    expect(keys).not.toContain('copilot-chatsession:twin:r1')
    expect(keys.some(k => k.startsWith('copilot:twin:shutdown:'))).toBe(true)
  })

  it('keeps the journal when the session-state file has no usage', async () => {
    await writeJournal('pending')
    await writeSessionState('pending', [
      ev('session.start', '2026-08-05T11:59:00Z', { selectedModel: 'gpt-4o' }),
      ev('assistant.message', '2026-08-05T12:00:00Z', { messageId: 'm1', model: 'gpt-4o', toolRequests: [] }),
    ])

    expect(await servedKeys()).toContain('copilot-chatsession:pending:r1')
  })

  it.skipIf(!isSqliteAvailable())('drops the journal copy when only session-store rows bill the session', async () => {
    await writeJournal('stored')
    writeStore('stored')

    const keys = await servedKeys()
    expect(keys).not.toContain('copilot-chatsession:stored:r1')
    expect(keys.some(k => k.startsWith('copilot-store:stored:'))).toBe(true)
  })
})

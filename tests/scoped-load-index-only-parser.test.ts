// Parser-layer guards for #1034. Cache-helper tests cannot see a stub installed
// into section.files at scanProjectDirs / parseProviderSources; these would
// fail that sabotage because an in-range save would then replace the real
// out-of-range body with turns: [].
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clearLoadCacheMemo,
  loadCache,
  sessionCacheDir,
} from '../src/session-cache.js'
import type { DateRange } from '../src/types.js'

let home: string
let cacheDir: string
let clearParserCache: (() => void) | undefined

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'codeburn-1034-parser-home-'))
  cacheDir = await mkdtemp(join(tmpdir(), 'codeburn-1034-parser-cache-'))
  process.env['HOME'] = home
  process.env['USERPROFILE'] = home
  process.env['CODEBURN_CACHE_DIR'] = cacheDir
  process.env['CLAUDE_CONFIG_DIR'] = join(home, '.claude')
  process.env['CODEX_HOME'] = join(home, 'codex')
  clearLoadCacheMemo()
})

afterEach(async () => {
  clearParserCache?.()
  clearParserCache = undefined
  vi.resetModules()
  clearLoadCacheMemo()
  await rm(home, { recursive: true, force: true })
  await rm(cacheDir, { recursive: true, force: true })
})

async function loadParser() {
  vi.resetModules()
  const parser = await import('../src/parser.js')
  clearParserCache = parser.clearSessionCache
  return parser.parseAllSessions
}

const juneRange: DateRange = {
  start: new Date('2026-06-01T00:00:00Z'),
  end: new Date('2026-06-30T23:59:59Z'),
}

function claudeUser(sessionId: string, timestamp: string, text: string): string {
  return JSON.stringify({
    type: 'user',
    sessionId,
    timestamp,
    cwd: '/projects/app',
    message: { role: 'user', content: text },
  })
}

function claudeAssistant(sessionId: string, timestamp: string, messageId: string, text: string): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId,
    timestamp,
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 100, output_tokens: 20 },
    },
  })
}

async function writeClaudeSession(name: string, sessionId: string, timestamp: string, text: string): Promise<string> {
  const projectDir = join(home, '.claude', 'projects', 'app')
  await mkdir(projectDir, { recursive: true })
  const path = join(projectDir, name)
  await writeFile(path, [
    claudeUser(sessionId, timestamp, text),
    claudeAssistant(sessionId, timestamp.replace('T10:00:00Z', 'T10:00:30Z'), `${sessionId}-a`, `ok ${text}`),
  ].join('\n'))
  return path
}

function codexRollout(sessionId: string, timestamp: string, prompt: string): string {
  return [
    JSON.stringify({
      type: 'session_meta',
      timestamp,
      payload: { session_id: sessionId, model: 'gpt-5.5', cwd: '/Users/test/app', originator: 'codex_cli_rs' },
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp,
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] },
    }),
    JSON.stringify({
      type: 'event_msg',
      timestamp: timestamp.replace('T10:00:00Z', 'T10:01:00Z'),
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 100, output_tokens: 20 },
          total_token_usage: { total_tokens: 120 },
        },
      },
    }),
  ].join('\n') + '\n'
}

async function writeCodexSession(day: string, name: string, sessionId: string, timestamp: string, prompt: string): Promise<string> {
  const [y, m, d] = day.split('-') as [string, string, string]
  const dir = join(home, 'codex', 'sessions', y, m, d)
  await mkdir(dir, { recursive: true })
  const path = join(dir, name)
  await writeFile(path, codexRollout(sessionId, timestamp, prompt))
  return path
}

function geminiSession(sessionId: string, timestamp: string, prompt: string): string {
  return JSON.stringify({
    sessionId,
    startTime: timestamp,
    messages: [
      { id: 'u1', timestamp, type: 'user', content: prompt },
      {
        id: 'g1',
        timestamp: timestamp.replace('T10:00:00.000Z', 'T10:00:05.000Z'),
        type: 'gemini',
        content: `ok ${prompt}`,
        model: 'gemini-3.1-pro-preview',
        tokens: { input: 40, output: 10 },
      },
    ],
  })
}

async function writeGeminiSession(name: string, sessionId: string, timestamp: string, prompt: string): Promise<string> {
  const chatsDir = join(home, '.gemini', 'tmp', 'project-a', 'chats')
  await mkdir(chatsDir, { recursive: true })
  const path = join(chatsDir, name)
  await writeFile(path, geminiSession(sessionId, timestamp, prompt))
  return path
}

async function poisonProviderTurns(provider: string, path: string, poison: string): Promise<void> {
  const env = JSON.parse(await readFile(join(sessionCacheDir(), 'envelope.json'), 'utf-8')) as {
    providers: Record<string, { shards: Record<string, { name: string }> }>
  }
  const shards = env.providers[provider]?.shards ?? {}
  for (const ref of Object.values(shards)) {
    const shardPath = join(sessionCacheDir(), ref.name)
    const files = JSON.parse(await readFile(shardPath, 'utf-8')) as Record<string, { turns: Array<{ userMessage?: string }> }>
    if (!files[path]) continue
    for (const turn of files[path]!.turns) turn.userMessage = poison
    await writeFile(shardPath, JSON.stringify(files))
    return
  }
  throw new Error(`no shard held ${path}`)
}

describe('scoped-load index-only parser guards', () => {
  it('Claude: an in-range save keeps the real out-of-range body', async () => {
    await writeClaudeSession('mar.jsonl', 's-mar', '2026-03-10T10:00:00Z', 'march work')
    const junePath = await writeClaudeSession('jun.jsonl', 's-jun', '2026-06-10T10:00:00Z', 'june work')

    const parseAllSessions = await loadParser()
    await parseAllSessions(undefined, 'claude')
    await writeFile(junePath, [
      claudeUser('s-jun', '2026-06-10T10:00:00Z', 'june work'),
      claudeAssistant('s-jun', '2026-06-10T10:00:30Z', 's-jun-a', 'ok june work'),
      claudeUser('s-jun', '2026-06-20T10:00:00Z', 'june follow-up'),
      claudeAssistant('s-jun', '2026-06-20T10:00:30Z', 's-jun-b', 'ok follow-up'),
    ].join('\n'))
    clearParserCache?.()
    await parseAllSessions(juneRange, 'claude')

    clearParserCache?.()
    clearLoadCacheMemo()
    const full = await loadCache()
    const mar = Object.entries(full.providers['claude']?.files ?? {}).find(([p]) => p.endsWith('mar.jsonl'))?.[1]
    expect(mar?.turns.length).toBeGreaterThan(0)
    expect(mar?.turns[0]?.timestamp).toMatch(/^2026-03-10/)
    expect(mar?.turns.some(t => t.userMessage.includes('march work'))).toBe(true)
  })

  it('Codex: an in-range save keeps the real out-of-range body', async () => {
    await writeCodexSession('2026-03-10', 'rollout-mar.jsonl', 'c-mar', '2026-03-10T10:00:00Z', 'march codex')
    const junePath = await writeCodexSession('2026-06-10', 'rollout-jun.jsonl', 'c-jun', '2026-06-10T10:00:00Z', 'june codex')

    const parseAllSessions = await loadParser()
    await parseAllSessions(undefined, 'codex')
    await writeFile(junePath, codexRollout('c-jun', '2026-06-10T10:00:00Z', 'june codex')
      + JSON.stringify({
        type: 'response_item',
        timestamp: '2026-06-20T10:00:00Z',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'june follow-up' }] },
      }) + '\n'
      + JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-06-20T10:01:00Z',
        payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, output_tokens: 5 }, total_token_usage: { total_tokens: 135 } } },
      }) + '\n')
    clearParserCache?.()
    await parseAllSessions(juneRange, 'codex')

    clearParserCache?.()
    clearLoadCacheMemo()
    const full = await loadCache()
    const mar = Object.entries(full.providers['codex']?.files ?? {}).find(([p]) => p.endsWith('rollout-mar.jsonl'))?.[1]
    expect(mar?.turns.length).toBeGreaterThan(0)
    expect(mar?.turns[0]?.timestamp).toMatch(/^2026-03-10/)
    expect(mar?.turns.some(t => (t.userMessage ?? '').includes('march codex'))).toBe(true)
  })

  it('Gemini index-only still reparses (body-dependent override)', async () => {
    const marPath = await writeGeminiSession('session-mar.json', 'g-mar', '2026-03-10T10:00:00.000Z', 'march gemini')
    const junPath = await writeGeminiSession('session-jun.json', 'g-jun', '2026-06-10T10:00:00.000Z', 'june gemini')

    vi.resetModules()
    const parser = await import('../src/parser.js')
    const cache = await import('../src/session-cache.js')
    clearParserCache = parser.clearSessionCache
    await parser.parseAllSessions(undefined, 'gemini')
    parser.clearSessionCache()
    cache.clearLoadCacheMemo()
    const seeded = await cache.loadCache(cache.monthScopeForRange(juneRange.start, juneRange.end))
    cache.markCacheDirty(seeded, 'gemini')
    await cache.saveCache(seeded)
    await poisonProviderTurns('gemini', marPath, 'POISON')
    await writeFile(junPath, geminiSession('g-jun', '2026-06-10T10:00:00.000Z', 'june gemini plus'))
    parser.clearSessionCache()
    cache.clearLoadCacheMemo()
    const june = await cache.loadCache(cache.monthScopeForRange(juneRange.start, juneRange.end))
    expect(cache.isIndexOnly(june, 'gemini', marPath)).toBe(true)
    expect(june.providers['gemini']?.files[marPath]).toBeUndefined()
    await parser.parseAllSessions(juneRange, 'gemini')

    parser.clearSessionCache()
    cache.clearLoadCacheMemo()
    const full = await cache.loadCache()
    const mar = full.providers['gemini']?.files[marPath]
    expect(mar?.turns.length).toBeGreaterThan(0)
    expect(mar?.turns.some(t => t.userMessage === 'POISON')).toBe(false)
    expect(mar?.turns.some(t => (t.userMessage ?? '').includes('march gemini'))).toBe(true)
  })
})

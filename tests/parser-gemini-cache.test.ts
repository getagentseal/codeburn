import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { clearSessionCache, parseAllSessions } from '../src/parser.js'
import { CACHE_VERSION, computeEnvFingerprint } from '../src/session-cache.js'
import type { DateRange } from '../src/types.js'

let home: string
let cacheDir: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'codeburn-gemini-home-'))
  cacheDir = await mkdtemp(join(tmpdir(), 'codeburn-gemini-cache-'))
  process.env['HOME'] = home
  process.env['CODEBURN_CACHE_DIR'] = cacheDir
})

afterEach(async () => {
  clearSessionCache()
  await rm(home, { recursive: true, force: true })
  await rm(cacheDir, { recursive: true, force: true })
})

describe('Gemini session cache migration', () => {
  it('reparses cached legacy aggregate Gemini entries into granular calls', async () => {
    const chatsDir = join(home, '.gemini', 'tmp', 'project-a', 'chats')
    await mkdir(chatsDir, { recursive: true })
    const sessionPath = join(chatsDir, 'session-2026-05-16.json')
    await writeFile(sessionPath, JSON.stringify({
      sessionId: 'gemini-session-1',
      startTime: '2026-05-16T10:00:00.000Z',
      messages: [
        { id: 'u1', timestamp: '2026-05-16T10:00:00.000Z', type: 'user', content: 'work' },
        {
          id: 'g1',
          timestamp: '2026-05-16T10:00:05.000Z',
          type: 'gemini',
          content: 'first',
          model: 'gemini-3.1-pro-preview',
          tokens: { input: 10, output: 5 },
        },
        {
          id: 'g2',
          timestamp: '2026-05-16T10:00:10.000Z',
          type: 'gemini',
          content: 'second',
          model: 'gemini-3.1-pro-preview',
          tokens: { input: 12, output: 6 },
        },
      ],
    }))

    const fileStat = await stat(sessionPath)
    await writeFile(join(cacheDir, 'session-cache.json'), JSON.stringify({
      version: CACHE_VERSION,
      providers: {
        gemini: {
          envFingerprint: computeEnvFingerprint('gemini'),
          files: {
            [sessionPath]: {
              fingerprint: {
                dev: fileStat.dev,
                ino: fileStat.ino,
                mtimeMs: fileStat.mtimeMs,
                sizeBytes: fileStat.size,
              },
              mcpInventory: [],
              turns: [{
                timestamp: '2026-05-16T10:00:00.000Z',
                sessionId: 'gemini-session-1',
                userMessage: 'work',
                calls: [{
                  provider: 'gemini',
                  model: 'gemini-3.1-pro-preview',
                  usage: {
                    inputTokens: 22,
                    outputTokens: 11,
                    cacheCreationInputTokens: 0,
                    cacheReadInputTokens: 0,
                    cachedInputTokens: 0,
                    reasoningTokens: 0,
                    webSearchRequests: 0,
                    cacheCreationOneHourTokens: 0,
                  },
                  speed: 'standard',
                  timestamp: '2026-05-16T10:00:00.000Z',
                  tools: [],
                  bashCommands: [],
                  skills: [],
                  deduplicationKey: 'gemini:gemini-session-1',
                }],
              }],
            },
          },
        },
      },
    }))

    const range: DateRange = {
      start: new Date('2026-05-16T00:00:00.000Z'),
      end: new Date('2026-05-16T23:59:59.999Z'),
    }

    const projects = await parseAllSessions(range, 'gemini')
    const keys = projects.flatMap(project =>
      project.sessions.flatMap(session =>
        session.turns.flatMap(turn => turn.assistantCalls.map(call => call.deduplicationKey)),
      ),
    )

    expect(projects[0]!.totalApiCalls).toBe(2)
    expect(keys).toEqual([
      'gemini:gemini-session-1:g1',
      'gemini:gemini-session-1:g2',
    ])

    const savedCache = JSON.parse(await readFile(join(cacheDir, 'session-cache.json'), 'utf-8'))
    const savedKeys = savedCache.providers.gemini.files[sessionPath].turns.flatMap((turn: { calls: Array<{ deduplicationKey: string }> }) =>
      turn.calls.map(call => call.deduplicationKey),
    )
    expect(savedKeys).toEqual(keys)
  })
})

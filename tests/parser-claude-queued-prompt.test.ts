import { copyFile, mkdir, mkdtemp, rm } from 'fs/promises'
import { createHash } from 'crypto'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import { describe, expect, it } from 'vitest'

import { clearSessionCache, compactEntry, groupIntoTurns, parseAllSessions } from '../src/parser.js'
import { PROVIDER_ENV_VARS } from '../src/session-cache.js'
import type { DateRange, JournalEntry } from '../src/types.js'
import { setHome } from './setup/home.js'
import { readCacheOnDisk, writeCacheOnDisk } from './fixtures/session-cache-io.js'

function user(timestamp: string, content: string): JournalEntry {
  return {
    type: 'user',
    timestamp,
    sessionId: 'session-1',
    message: { role: 'user', content },
  }
}

function assistant(timestamp: string, id: string): JournalEntry {
  return {
    type: 'assistant',
    timestamp,
    sessionId: 'session-1',
    message: {
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-20250514',
      id,
      content: [],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  }
}

function attachment(timestamp: string, type: string, commandMode: string, prompt: unknown): JournalEntry {
  return {
    type: 'attachment',
    timestamp,
    sessionId: 'session-1',
    attachment: { type, commandMode, prompt, discarded: 'large unused payload' },
  }
}

describe('Claude queued human prompts', () => {
  it('keeps a bounded queued prompt while dropping unrelated attachment data', () => {
    const raw = attachment('2026-07-01T10:00:03Z', 'queued_command', 'prompt', [
      { type: 'image', data: 'ignored' },
      { type: 'text', text: '  please continue the task  ' },
      { type: 'text', text: 'later text is not the first text' },
    ])

    const compacted = compactEntry(raw)
    const saved = compacted['attachment'] as Record<string, unknown>

    expect(saved).toEqual({
      type: 'queued_command',
      commandMode: 'prompt',
      prompt: '  please continue the task  ',
    })

    const longPrompt = attachment('2026-07-01T10:00:03Z', 'queued_command', 'prompt', 'p'.repeat(5000))
    const longSaved = compactEntry(longPrompt)['attachment'] as Record<string, unknown>
    expect(longSaved['prompt']).toBe('p'.repeat(2000))

    const unrelated = compactEntry(attachment('2026-07-01T10:00:03Z', 'queued_command', 'task-notification', 'finished'))
    expect(unrelated['attachment']).toBeUndefined()

    const peer = compactEntry({
      type: 'attachment',
      timestamp: '2026-07-01T10:00:03Z',
      sessionId: 'session-1',
      attachment: {
        type: 'queued_command',
        commandMode: 'prompt',
        prompt: '<agent-message from="peer-session">continue</agent-message>',
        isMeta: true,
        origin: { kind: 'peer' },
      },
    } as JournalEntry)
    expect(peer['attachment']).toBeUndefined()

    const missingOrigin = compactEntry(attachment('2026-07-01T10:00:03Z', 'queued_command', 'prompt', 'no origin field'))
    expect((missingOrigin['attachment'] as Record<string, unknown>)['prompt']).toBe('no origin field')
  })

  it('starts a separate turn for a typed queued prompt and ignores other attachments', () => {
    const entries = [
      user('2026-07-01T10:00:00Z', 'implement the parser change'),
      assistant('2026-07-01T10:00:02Z', 'message-1'),
      // This can repeat the exact text of a user entry: queued events represent
      // a separate send and must not be deduplicated by prompt text.
      attachment('2026-07-01T10:00:03Z', 'queued_command', 'prompt', [
        { type: 'text', text: 'implement the parser change' },
      ]),
      assistant('2026-07-01T10:00:04Z', 'message-2'),
      attachment('2026-07-01T10:00:05Z', 'queued_command', 'task-notification', 'background task finished'),
      attachment('2026-07-01T10:00:06Z', 'queued_command', 'prompt', '<ide_opened_file>src/parser.ts</ide_opened_file>'),
      attachment('2026-07-01T10:00:07Z', 'queued_command', 'prompt', '<system-reminder>injected context</system-reminder>'),
      attachment('2026-07-01T10:00:08Z', 'queued_command', 'prompt', '/compact'),
      // A peer/agent-message queued command: not a prompt the user typed, so it
      // must not start a turn.
      {
        type: 'attachment',
        timestamp: '2026-07-01T10:00:08Z',
        sessionId: 'session-1',
        attachment: {
          type: 'queued_command',
          commandMode: 'prompt',
          prompt: '<agent-message from="peer-session">keep going</agent-message>',
          isMeta: true,
          origin: { kind: 'peer' },
        },
      } as JournalEntry,
      attachment('2026-07-01T10:00:09Z', 'other', 'prompt', 'not a queued command'),
      {
        type: 'attachment',
        timestamp: '2026-07-01T10:00:10Z',
        sessionId: 'session-1',
        attachment: { type: 'deferred_tools_delta', addedNames: ['mcp__svc__tool'] },
      } as JournalEntry,
      assistant('2026-07-01T10:00:11Z', 'message-3'),
    ].map(compactEntry)

    const turns = groupIntoTurns(entries, new Set())

    expect(turns).toHaveLength(2)
    expect(turns.map(turn => turn.userMessage)).toEqual([
      'implement the parser change',
      'implement the parser change',
    ])
    expect(turns.map(turn => turn.assistantCalls.map(call => call.deduplicationKey))).toEqual([
      ['message-1'],
      ['message-2', 'message-3'],
    ])
    expect(turns.flatMap(turn => turn.assistantCalls)).toHaveLength(3)
  })

  it('ignores an uncompacted peer queued prompt passed straight to groupIntoTurns', () => {
    const peerEntry: JournalEntry = {
      type: 'attachment',
      timestamp: '2026-07-01T10:00:03Z',
      sessionId: 'session-1',
      attachment: {
        type: 'queued_command',
        commandMode: 'prompt',
        prompt: '<agent-message from="peer-session">keep going</agent-message>',
        isMeta: true,
        origin: { kind: 'peer' },
      },
    } as JournalEntry

    const turns = groupIntoTurns([
      user('2026-07-01T10:00:00Z', 'typed by the user'),
      assistant('2026-07-01T10:00:01Z', 'message-1'),
      peerEntry,
      assistant('2026-07-01T10:00:02Z', 'message-2'),
    ], new Set())

    expect(turns).toHaveLength(1)
    expect(turns[0]!.assistantCalls.map(call => call.deduplicationKey)).toEqual(['message-1', 'message-2'])
  })

  it('omits a queued prompt without an assistant API call like an ordinary user-only message', () => {
    expect(groupIntoTurns([user('2026-07-01T10:00:00Z', 'ordinary prompt')], new Set())).toEqual([])
    expect(groupIntoTurns([
      attachment('2026-07-01T10:00:00Z', 'queued_command', 'prompt', 'queued prompt'),
    ], new Set())).toEqual([])
  })

  it('classifies a queued prompt through the JSONL parser and reloads it from session cache', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codeburn-queued-prompt-home-'))
    const cacheDir = await mkdtemp(join(tmpdir(), 'codeburn-queued-prompt-cache-'))
    const envKeys = [
      'HOME',
      'USERPROFILE',
      'CLAUDE_CONFIG_DIR',
      'CLAUDE_CONFIG_DIRS',
      'CODEBURN_CACHE_DIR',
      'CODEBURN_DESKTOP_SESSIONS_DIR',
    ] as const
    const previousEnv = new Map(envKeys.map(key => [key, process.env[key]]))

    try {
      setHome(home)
      const claudeDir = join(home, '.claude')
      const projectDir = join(claudeDir, 'projects', 'queued-prompt-project')
      await mkdir(projectDir, { recursive: true })
      await copyFile(
        resolve('tests/fixtures/claude/queued-human-prompt.jsonl'),
        join(projectDir, 'session-1.jsonl'),
      )
      process.env['CLAUDE_CONFIG_DIR'] = claudeDir
      delete process.env['CLAUDE_CONFIG_DIRS']
      delete process.env['CODEBURN_DESKTOP_SESSIONS_DIR']
      process.env['CODEBURN_CACHE_DIR'] = cacheDir

      const range: DateRange = {
        start: new Date('2026-07-01T00:00:00.000Z'),
        end: new Date('2026-07-01T23:59:59.999Z'),
      }
      const summarize = async () => {
        const projects = await parseAllSessions(range, 'claude')
        const session = projects.flatMap(project => project.sessions).find(candidate => candidate.sessionId === 'session-1')
        expect(session).toBeDefined()
        return {
          turns: session!.turns.map(turn => ({
            userMessage: turn.userMessage,
            category: turn.category,
            calls: turn.assistantCalls.map(call => call.deduplicationKey),
          })),
          apiCalls: session!.apiCalls,
          totalInputTokens: session!.totalInputTokens,
          totalOutputTokens: session!.totalOutputTokens,
          totalCostUSD: session!.totalCostUSD,
        }
      }

      clearSessionCache()
      const cold = await summarize()
      expect(cold).toMatchObject({
        turns: [
          {
            userMessage: 'How does the parser assign turns?',
            category: 'exploration',
            calls: ['message-1'],
          },
          {
            userMessage: 'Implement a parser change in src/parser.ts',
            category: 'feature',
            calls: ['message-2', 'message-3'],
          },
        ],
        apiCalls: 3,
        totalInputTokens: 41,
        totalOutputTokens: 15,
      })

      // A pre-fix cache placed every assistant call under the ordinary user
      // prompt. Simulate that warm cache with its prior parser fingerprint.
      const cache = await readCacheOnDisk()
      const section = cache.providers['claude']!
      const oldParseVersion = 'advisor-usage-v1-skills-rich-capture-v1-cross-provider-pr-v1-session-lineage-capture-v1'
      const fingerprintParts = PROVIDER_ENV_VARS['claude']!.map(key => `${key}=${process.env[key] ?? ''}`)
      fingerprintParts.push(`parser=${oldParseVersion}`)
      section.envFingerprint = createHash('sha256').update(fingerprintParts.join('\0')).digest('hex').slice(0, 16)
      let staleTurnFound = false
      for (const file of Object.values(section.files)) {
        if (file.turns.length < 2) continue
        const first = file.turns[0]!
        first.calls.push(...file.turns[1]!.calls)
        file.turns = [first]
        staleTurnFound = true
      }
      expect(staleTurnFound).toBe(true)
      await writeCacheOnDisk(cache)

      clearSessionCache()
      expect(await summarize()).toEqual(cold)
    } finally {
      clearSessionCache()
      for (const key of envKeys) {
        const value = previousEnv.get(key)
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(home, { recursive: true, force: true })
      await rm(cacheDir, { recursive: true, force: true })
    }
  })
})

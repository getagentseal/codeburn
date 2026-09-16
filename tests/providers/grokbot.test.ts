import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { calculateCost } from '../../src/models.js'
import { providers } from '../../src/providers/index.js'
import { grokbot, grokbotPersistenceDir } from '../../src/providers/grokbot.js'
import type { ParsedProviderCall, SessionSource } from '../../src/providers/types.js'

const ACCOUNT = 'google-oauth2%7Cuser_TEST'
const BOT_A = '11111111-1111-4111-8111-111111111111'
const BOT_B = '22222222-2222-4222-8222-222222222222'

// 2026-09-12T10:00:00.000Z and onwards, the ms-epoch shape the app writes.
const T0 = Date.UTC(2026, 8, 12, 10, 0, 0)

let dir: string
let originalDir: string | undefined

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

/** The app names each slice file base32(sliceKey), lowercase and unpadded. */
function encodeBase32(value: string): string {
  const bytes = Buffer.from(value, 'utf-8')
  let out = ''
  let bits = 0
  let acc = 0
  for (const byte of bytes) {
    acc = (acc << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += BASE32_ALPHABET[(acc >>> bits) & 0x1f]
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(acc << (5 - bits)) & 0x1f]
  return out
}

async function writeSlice(key: string, schemaVersion: number, value: unknown): Promise<string> {
  const path = join(dir, `${encodeBase32(key)}.blob`)
  await writeFile(path, JSON.stringify({ schemaVersion, value }))
  return path
}

async function writeRoster(rows: Array<Record<string, unknown>>): Promise<void> {
  await writeSlice(`sand.client.slice.account.${ACCOUNT}.roster.last-roster`, 3, { rows })
}

async function writeTranscript(agentId: string, entries: unknown[]): Promise<string> {
  return writeSlice(
    `sand.client.slice.account.${ACCOUNT}.transcript.replicas.${agentId}`,
    1,
    { entries, persistedAt: T0, epochHint: null, acceptedSequenceHint: null },
  )
}

function userMessage(id: string, requestId: string, content: string, timestampMs: number): Record<string, unknown> {
  return { kind: 'message', id, role: 'user', content, richText: '{}', requestId, timestampMs, isStreaming: false }
}

function botMessage(id: string, requestId: string, content: string, timestampMs: number, wake?: string): Record<string, unknown> {
  return {
    kind: 'send-message',
    id,
    message: { type: 'text', content },
    requestId,
    timestampMs,
    ...(wake ? { wake } : {}),
  }
}

async function collect(source: SessionSource, seen = new Set<string>()): Promise<ParsedProviderCall[]> {
  const calls: ParsedProviderCall[] = []
  for await (const call of grokbot.createSessionParser(source, seen).parse()) calls.push(call)
  return calls
}

async function parseAll(): Promise<ParsedProviderCall[]> {
  const seen = new Set<string>()
  const sources = await grokbot.discoverSessions()
  const calls: ParsedProviderCall[] = []
  for (const source of sources) calls.push(...await collect(source, seen))
  return calls
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'grokbot-provider-test-'))
  originalDir = process.env['CODEBURN_GROKBOT_DIR']
  process.env['CODEBURN_GROKBOT_DIR'] = dir
})

afterEach(async () => {
  if (originalDir === undefined) delete process.env['CODEBURN_GROKBOT_DIR']
  else process.env['CODEBURN_GROKBOT_DIR'] = originalDir
  await rm(dir, { recursive: true, force: true })
})

describe('grokbot provider', () => {
  it('is registered in the provider list', () => {
    const registered = providers.find(p => p.name === 'grokbot')
    expect(registered?.displayName).toBe('Grok Bot')
  })

  it('resolves the Electron userData persistence dir per platform', () => {
    delete process.env['CODEBURN_GROKBOT_DIR']
    expect(grokbotPersistenceDir('darwin', '/home/x'))
      .toBe(join('/home/x', 'Library', 'Application Support', 'Grok Bot', 'sand-client-persistence'))
    expect(grokbotPersistenceDir('linux', '/home/x'))
      .toBe(join('/home/x', '.config', 'Grok Bot', 'sand-client-persistence'))
    process.env['CODEBURN_GROKBOT_DIR'] = '/override'
    expect(grokbotPersistenceDir('darwin', '/home/x')).toBe('/override')
  })

  it('discovers one source per transcript replica and labels it with the bot name', async () => {
    await writeRoster([
      { id: BOT_A, name: 'Reddit Bot', avatarColor: 'red', unreadCount: 3 },
      { id: BOT_B, name: 'HN Reviewer' },
    ])
    await writeTranscript(BOT_A, [userMessage('t0u', 'r1', 'hello', T0)])
    await writeTranscript(BOT_B, [userMessage('t0u', 'r1', 'hello', T0)])

    const sources = await grokbot.discoverSessions()
    expect(sources.map(s => [s.project, s.sourceId, s.agentName]).sort()).toEqual([
      ['HN Reviewer', BOT_B, 'HN Reviewer'],
      ['Reddit Bot', BOT_A, 'Reddit Bot'],
    ])
    expect(sources.every(s => s.provider === 'grokbot')).toBe(true)
  })

  it('falls back to the agent id when the roster has no row for it', async () => {
    await writeTranscript(BOT_A, [userMessage('t0u', 'r1', 'hello', T0)])
    const sources = await grokbot.discoverSessions()
    expect(sources[0]?.project).toBe(BOT_A)
    expect(sources[0]?.agentName).toBeUndefined()
  })

  it('reports an empty root as no sessions and still probes it', async () => {
    expect(await grokbot.discoverSessions()).toEqual([])
    expect(await grokbot.probeRoots?.()).toEqual([{ path: dir, label: 'client persistence' }])
  })

  it('groups a multi-turn conversation into one call per requestId', async () => {
    await writeRoster([{ id: BOT_A, name: 'Reddit Bot' }])
    await writeTranscript(BOT_A, [
      userMessage('t0u', 'r1', 'a'.repeat(40), T0),
      botMessage('t1s0', 'r1', 'b'.repeat(80), T0 + 1_000),
      botMessage('t1s1', 'r1', 'c'.repeat(80), T0 + 2_000),
      userMessage('t2u', 'r2', 'd'.repeat(20), T0 + 60_000),
      botMessage('t3s0', 'r2', 'e'.repeat(20), T0 + 61_000),
    ])

    const calls = await parseAll()
    expect(calls).toHaveLength(2)
    expect(calls[0]!.sessionId).toBe(BOT_A)
    expect(calls[0]!.project).toBe('Reddit Bot')
    // 40 chars in, 160 chars out, at 4 chars per token.
    expect(calls[0]!.inputTokens).toBe(10)
    expect(calls[0]!.outputTokens).toBe(40)
    expect(calls[0]!.timestamp).toBe(new Date(T0).toISOString())
    expect(calls[0]!.userMessage).toBe('a'.repeat(40))
    expect(calls[1]!.inputTokens).toBe(5)
    expect(calls[1]!.outputTokens).toBe(5)
    expect(new Set(calls.map(c => c.deduplicationKey)).size).toBe(2)
  })

  it('leaves routine and agent-to-agent runs without a human userMessage', async () => {
    await writeRoster([{ id: BOT_A, name: 'Reddit Bot' }])
    await writeTranscript(BOT_A, [
      botMessage('t0s0', 'r1', 'posted the weekday roundup', T0, 'background-revival'),
      {
        kind: 'message',
        id: 't1u',
        role: 'user',
        content: 'Review of draft: APPROVE',
        requestId: 'r2',
        timestampMs: T0 + 1_000,
        fromAgent: { id: BOT_B, name: 'Reddit Reviewer' },
      },
      botMessage('t2s0', 'r2', 'thanks', T0 + 2_000),
    ])

    const calls = await parseAll()
    expect(calls).toHaveLength(2)
    expect(calls.every(c => c.userMessage === '')).toBe(true)
    // The inbound bot message still counts as input the agent had to read.
    expect(calls[1]!.inputTokens).toBeGreaterThan(0)
  })

  it('counts the bot\'s own outbound message to another bot as output, not input', async () => {
    await writeTranscript(BOT_A, [
      userMessage('t0u', 'r1', 'x'.repeat(40), T0),
      {
        kind: 'message',
        id: 'agent-outbound-abc',
        role: 'assistant',
        content: 'y'.repeat(80),
        requestId: 'r1',
        timestampMs: T0 + 1_000,
        toAgent: { id: BOT_B, name: 'Reddit Reviewer', kind: 'agent' },
      },
    ])

    const calls = await parseAll()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens).toBe(10)
    expect(calls[0]!.outputTokens).toBe(20)
    expect(calls[0]!.userMessage).toBe('x'.repeat(40))
  })

  it('reports no tool calls or bash commands, because the mirror has none', async () => {
    await writeTranscript(BOT_A, [
      userMessage('t0u', 'r1', 'open x and check the profile', T0),
      botMessage('t1s0', 'r1', 'done', T0 + 1_000),
    ])
    const calls = await parseAll()
    expect(calls[0]!.tools).toEqual([])
    expect(calls[0]!.bashCommands).toEqual([])
  })

  it('prices every call as an estimate at the grokbot-auto rate', async () => {
    await writeTranscript(BOT_A, [
      userMessage('t0u', 'r1', 'x'.repeat(4_000), T0),
      botMessage('t1s0', 'r1', 'y'.repeat(2_000), T0 + 1_000),
    ])
    const calls = await parseAll()
    const call = calls[0]!
    expect(call.model).toBe('grokbot-auto')
    expect(call.costIsEstimated).toBe(true)
    expect(call.cacheReadInputTokens).toBe(0)
    expect(call.cacheCreationInputTokens).toBe(0)
    expect(call.reasoningTokens).toBe(0)
    // grokbot-auto prices through the grok-4.6 row; a non-zero cost proves the
    // alias resolves rather than silently falling through to $0.
    expect(call.costUSD).toBe(calculateCost('grokbot-auto', 1_000, 500, 0, 0, 0))
    expect(call.costUSD).toBeGreaterThan(0)
    expect(grokbot.modelDisplayName('grokbot-auto')).toBe('Grok Bot (auto)')
  })

  it('deduplicates a source parsed twice with the same seen-key set', async () => {
    await writeTranscript(BOT_A, [
      userMessage('t0u', 'r1', 'hello there', T0),
      botMessage('t1s0', 'r1', 'hi', T0 + 1_000),
    ])
    const [source] = await grokbot.discoverSessions()
    const seen = new Set<string>()
    expect(await collect(source!, seen)).toHaveLength(1)
    expect(await collect(source!, seen)).toHaveLength(0)
  })

  it('skips malformed rows and unknown kinds without dropping the rest of the file', async () => {
    await writeTranscript(BOT_A, [
      'not an object',
      { kind: 'event', id: 'e0', event: { type: 'automation-changed', action: 'created' }, timestampMs: T0 },
      { kind: 'some-future-kind', id: 'f0', requestId: 'r0', timestampMs: T0 },
      userMessage('t0u', 'r1', 'hello there', T0),
      { kind: 'send-message', id: 't1s0', message: { type: 'text' }, requestId: 'r1', timestampMs: 'not a number' },
      botMessage('t2s0', 'r1', 'hi back', T0 + 1_000),
      userMessage('t3u', 'r2', 'ignored, no timestamp', Number.NaN),
    ])

    const calls = await parseAll()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.userMessage).toBe('hello there')
  })

  it('returns nothing for a file that is not JSON', async () => {
    const path = await writeTranscript(BOT_A, [])
    await writeFile(path, '{ this is not json')
    const [source] = await grokbot.discoverSessions()
    expect(await collect(source!)).toEqual([])
  })

  it('changes the cache fingerprint when the directory override changes', async () => {
    const { computeEnvFingerprint } = await import('../../src/session-cache.js')
    const first = computeEnvFingerprint('grokbot')
    process.env['CODEBURN_GROKBOT_DIR'] = `${dir}-other`
    expect(computeEnvFingerprint('grokbot')).not.toBe(first)
  })
})

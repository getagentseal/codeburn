import { readdir } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'

import { FS_SCAN_CONCURRENCY, mapWithConcurrency, readSessionFile } from '../fs-utils.js'
import { calculateCost, getShortModelName } from '../models.js'
import { estimateTokensFromChars } from '../token-estimate.js'
import { importSource, importSourceParser } from '../cursor-import.js'
import type { ParsedProviderCall, ProbeRoot, Provider, SessionParser, SessionSource } from './types.js'

// Grok Bot is xAI's Electron desktop agent app (bundle id com.anysphere.sand),
// not Grok Build — xAI's coding CLI, which is the separate `grok` provider.
//
// Mapped against app version 0.30.0. The authoritative agent store lives on the
// remote box (`/home/box/sand-data/agents/<id>/store.db`); the app mirrors a
// sliding window of roughly the last 200 transcript entries per bot into its
// Electron userData directory as `sand-client-persistence/<base32 key>.blob`,
// plain UTF-8 JSON. `~/.grokbot` (the `$SAND_DATA_ROOT` marked by
// `.grokbot-data-root-v1`) holds host plumbing, settings and secrets — on 0.30
// its `agents/*/store.db` transcript tables are empty, so nothing is read there.
//
// The mirror records no token counts, no cost and no model id, so every figure
// here is estimated from message text and every cost is marked estimated.
// Unknown entry kinds and unknown fields are ignored rather than rejected: the
// app self-updates and the schema moves with it.

const PERSISTENCE_DIR = 'sand-client-persistence'
const TRANSCRIPT_SLICE = /^sand\.client\.slice\.account\.(.+)\.transcript\.replicas\.(.+)$/
const ROSTER_SLICE = /^sand\.client\.slice\.account\.(.+)\.roster\.last-roster$/

// The app's own synthetic model id: Grok Bot serves opaque `sand-*` aliases and
// never records which one answered, so there is no real id to report.
const MODEL_ID = 'grokbot-auto'

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

/** RFC 4648 base32, lowercase and unpadded — how the app names its slice files. */
function decodeBase32(name: string): string | null {
  const bytes: number[] = []
  let value = 0
  let bits = 0
  for (const char of name) {
    const index = BASE32_ALPHABET.indexOf(char)
    if (index < 0) return null
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((value >>> bits) & 0xff)
    }
  }
  try {
    return Buffer.from(bytes).toString('utf-8')
  } catch {
    return null
  }
}

export function grokbotPersistenceDir(
  platform: string = process.platform,
  home: string = homedir(),
): string {
  const configured = process.env['CODEBURN_GROKBOT_DIR']?.trim()
  if (configured) return configured
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Grok Bot', PERSISTENCE_DIR)
  if (platform === 'win32') {
    const appData = process.env['APPDATA']?.trim() || join(home, 'AppData', 'Roaming')
    return join(appData, 'Grok Bot', PERSISTENCE_DIR)
  }
  return join(home, '.config', 'Grok Bot', PERSISTENCE_DIR)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

async function readSlice(path: string): Promise<Record<string, unknown> | null> {
  const content = await readSessionFile(path)
  if (content === null) return null
  try {
    const parsed = JSON.parse(content) as unknown
    if (!isRecord(parsed)) return null
    return isRecord(parsed['value']) ? parsed['value'] : null
  } catch {
    return null
  }
}

/** agentId -> the bot name shown in the app's sidebar ("Reddit Bot"). */
async function readRoster(path: string): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  const value = await readSlice(path)
  const rows = value?.['rows']
  if (!Array.isArray(rows)) return names
  for (const row of rows) {
    if (!isRecord(row)) continue
    const id = nonEmptyString(row['id'])
    const name = nonEmptyString(row['name'])
    if (id && name) names.set(id, name)
  }
  return names
}

// The app writes ms since the epoch. Anything outside a plausible range is a
// schema change or a corrupt row, not a date worth reporting.
const MIN_TIMESTAMP_MS = Date.UTC(2020, 0, 1)
const MAX_TIMESTAMP_MS = Date.UTC(2100, 0, 1)

function timestampOf(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  // Some slices could plausibly gain a seconds-scale stamp; promote it.
  const ms = value < MIN_TIMESTAMP_MS ? value * 1000 : value
  return ms >= MIN_TIMESTAMP_MS && ms < MAX_TIMESTAMP_MS ? ms : null
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (!isRecord(value)) return ''
  const content = value['content']
  return typeof content === 'string' ? content : ''
}

type GrokbotRequest = {
  key: string
  inputChars: number
  outputChars: number
  firstTimestampMs: number
  /** Empty when no human wrote into this request — a Routine or a wake-driven run. */
  userMessage: string
}

/**
 * One request is one `requestId`: the app stamps a prompt and every message the
 * bot emits in reply with the same id. `message` entries arrive at the bot
 * (from the person, or from another bot via `fromAgent`); `send-message`
 * entries are the bot's own output.
 */
function groupRequests(entries: unknown[]): GrokbotRequest[] {
  const requests = new Map<string, GrokbotRequest>()

  for (const entry of entries) {
    if (!isRecord(entry)) continue
    const kind = entry['kind']
    if (kind !== 'message' && kind !== 'send-message') continue

    const timestampMs = timestampOf(entry['timestampMs'])
    if (timestampMs === null) continue

    const key = nonEmptyString(entry['requestId']) ?? nonEmptyString(entry['id'])
    if (!key) continue

    let request = requests.get(key)
    if (!request) {
      request = { key, inputChars: 0, outputChars: 0, firstTimestampMs: timestampMs, userMessage: '' }
      requests.set(key, request)
    }
    if (timestampMs < request.firstTimestampMs) request.firstTimestampMs = timestampMs

    if (kind === 'send-message') {
      request.outputChars += textOf(entry['message']).length
      continue
    }

    const content = textOf(entry['content'])
    // Direction comes from `role`, not from the entry kind: a `message` with
    // role assistant is this bot's own text on its way out, usually addressed
    // to another bot via `toAgent`. Role user is what arrived here — from the
    // person, or from another bot via `fromAgent`.
    if (entry['role'] === 'assistant') {
      request.outputChars += content.length
      continue
    }
    request.inputChars += content.length
    // A `message` carrying `fromAgent` was sent by another bot, so only a bare
    // user message makes this a human turn. Routine and background-revival runs
    // keep an empty userMessage, which is what stops the task classifier from
    // reading them as something a person asked for.
    if (!request.userMessage && entry['role'] === 'user' && !isRecord(entry['fromAgent'])) {
      request.userMessage = content
    }
  }

  return [...requests.values()]
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const value = await readSlice(source.path)
      const entries = value?.['entries']
      if (!Array.isArray(entries)) return

      const sessionId = source.sourceId ?? source.project

      for (const request of groupRequests(entries)) {
        const inputTokens = estimateTokensFromChars(request.inputChars)
        const outputTokens = estimateTokensFromChars(request.outputChars)
        if (inputTokens + outputTokens === 0) continue

        const deduplicationKey = `grokbot:${sessionId}:${request.key}`
        if (seenKeys.has(deduplicationKey)) continue
        seenKeys.add(deduplicationKey)

        yield {
          provider: 'grokbot',
          model: MODEL_ID,
          inputTokens,
          outputTokens,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          cachedInputTokens: 0,
          reasoningTokens: 0,
          webSearchRequests: 0,
          costUSD: calculateCost(MODEL_ID, inputTokens, outputTokens, 0, 0, 0),
          costIsEstimated: true,
          // The mirror carries chat entries only: no tool call and no shell
          // command the bot ran on its box reaches this machine.
          tools: [],
          bashCommands: [],
          timestamp: new Date(request.firstTimestampMs).toISOString(),
          speed: 'standard',
          deduplicationKey,
          userMessage: request.userMessage,
          sessionId,
          project: source.project,
        }
      }
    },
  }
}

async function discoverSessions(dir: string): Promise<SessionSource[]> {
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return []
  }

  const slices = files
    .filter(file => file.endsWith('.blob'))
    .map(file => ({ file, key: decodeBase32(file.slice(0, -'.blob'.length)) }))
    .filter((slice): slice is { file: string; key: string } => slice.key !== null)

  const rosterFiles = slices.filter(slice => ROSTER_SLICE.test(slice.key))
  const rosters = await mapWithConcurrency(rosterFiles, FS_SCAN_CONCURRENCY, slice =>
    readRoster(join(dir, slice.file)))
  const names = new Map<string, string>()
  for (const roster of rosters) for (const [id, name] of roster) names.set(id, name)

  const sources: SessionSource[] = []
  for (const slice of slices) {
    const match = TRANSCRIPT_SLICE.exec(slice.key)
    if (!match) continue
    const agentId = match[2]!
    const botName = names.get(agentId)
    sources.push({
      path: join(dir, slice.file),
      // Grok Bot has no project: work is organised by bot, so the bot's own
      // name is what the report groups by, with the same name as the agent
      // label for surfaces that show both.
      project: botName ?? agentId,
      provider: 'grokbot',
      sourceId: agentId,
      ...(botName ? { sourceLabel: botName, agentName: botName } : {}),
    })
  }
  return sources
}

export function createGrokbotProvider(persistenceDir?: string): Provider {
  // Resolved per call, not at import, so CODEBURN_GROKBOT_DIR set after the
  // module loads still moves discovery.
  const resolveDir = (): string => persistenceDir ?? grokbotPersistenceDir()

  return {
    name: 'grokbot',
    displayName: 'Grok Bot',

    async probeRoots(): Promise<ProbeRoot[]> {
      return [{ path: resolveDir(), label: 'client persistence' }]
    },

    modelDisplayName(model: string): string {
      return getShortModelName(model)
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      return [...await discoverSessions(resolveDir()), ...importSource('grokbot')]
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return importSourceParser(source, seenKeys, 'grokbot') ?? createParser(source, seenKeys)
    },
  }
}

export const grokbot = createGrokbotProvider()

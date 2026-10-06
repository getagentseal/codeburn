import { readdir } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

import { readSessionFile } from '../fs-utils.js'
import { calculateCost, getShortModelName } from '../models.js'
import type { ProbeRoot, Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'

// Amp (Sourcegraph's coding agent, ampcode.com) mirrors every thread it
// serves as one JSON document per thread at <amp-data>/threads/<id>.json,
// where amp-data is $AMP_DATA_DIR (comma-separated for extra roots) or
// ~/.local/share/amp. Mapped against the format ccusage's amp adapter reads
// (rust/adapters/amp/src/parser.rs) - the same layout its own tests fixture:
//
//   { id, messages: [...], usageLedger?: { events: [...] } }
//
// usageLedger.events is the authoritative per-request record: { id, timestamp,
// model, tokens: { input, output, total }, toMessageId, credits }. Cache
// tokens are not on the event - they live on the thread message the event
// billed for (toMessageId -> message.messageId ->
// usage.cacheCreationInputTokens / usage.cacheReadInputTokens). Threads
// without a ledger fall back to the per-assistant-message usage blocks
// ({ inputTokens, outputTokens, cacheCreationInputTokens,
// cacheReadInputTokens, totalTokens, timestamp, model }). For ledger
// events, any positive remainder of tokens.total after input, output and
// cache counts is added to output; a message block with no individual
// counts uses its totalTokens as the output count.
//
// Costs are priced from tokens; Amp's own credits field is not converted.
// Every cost uses CodeBurn's model pricing (models.ts) and carries
// costIsEstimated. Thread files carry no project/cwd, so sessions group under
// the provider name. Amp's model ids are the underlying OpenAI/Anthropic/
// Google ids and price through the standard catalog.

// Amp's data dir can be relocated via AMP_DATA_DIR (its own env var,
// comma-separated for multiple roots, matching Amp's semantics).
function ampDataDirs(): string[] {
  const override = process.env['AMP_DATA_DIR']
  if (override) {
    const dirs = override.split(',').map(part => part.trim()).filter(Boolean)
    if (dirs.length > 0) return [...new Set(dirs)]
  }
  return [join(homedir(), '.local/share/amp')]
}

function threadsDirFor(ampDataDir: string): string {
  return join(ampDataDir, 'threads')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Thread files are third-party input that moves with Amp releases. Keep the
// check local so bad usage fields become absent rather than leaking NaN,
// negative tokens, or a throwing arithmetic operation into the aggregate.
function finiteNonNegative(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.min(value, Number.MAX_SAFE_INTEGER)
  }
  return undefined
}

function readNumber(record: Record<string, unknown>, field: string): number {
  return finiteNonNegative(record[field]) ?? 0
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

// User text feeds the `userMessage` column. Content may be a plain string or
// a block array; only the text blocks are usable.
function messageText(message: Record<string, unknown>): string {
  const content = message['content']
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(isRecord)
      .map(block => nonEmptyString(block['text']) ?? '')
      .filter(Boolean)
      .join(' ')
  }
  return nonEmptyString(message['text']) ?? ''
}

type AmpCallRecord = {
  model: string
  timestamp: string
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  // Ledger-only: the event id dedups re-reads of the same thread file.
  eventId: string | undefined
  // Index into the thread's message array the record billed for (ledger
  // toMessageId, or the message's own index on the fallback path) - anchors
  // userMessage attribution.
  messageIndex: number | undefined
}

type ParsedThread = {
  threadId: string
  calls: AmpCallRecord[]
  userMessages: { index: number; text: string }[]
}

function parseThreadFile(content: string): ParsedThread | null {
  let thread: Record<string, unknown>
  try {
    thread = JSON.parse(content) as Record<string, unknown>
  } catch {
    return null
  }
  if (!isRecord(thread)) return null
  const threadId = nonEmptyString(thread['id'])
  if (!threadId) return null

  const messages = Array.isArray(thread['messages']) ? thread['messages'].filter(isRecord) : []
  const userMessages = messages
    .map((message, index) => ({ index, text: messageText(message) }))
    .filter(entry => entry.text.length > 0)

  // Cache tokens per billed message id: ledger events join
  // toMessageId -> messages[].messageId -> usage.cache*InputTokens. The
  // message's array index travels with it to anchor userMessage attribution.
  const cacheTokensByMessageId = new Map<number, { index: number; creation: number; read: number }>()
  messages.forEach((message, index) => {
    if (message['role'] !== 'assistant') return
    const usage = message['usage']
    if (!isRecord(usage)) return
    const messageId = message['messageId']
    if (typeof messageId !== 'number' || !Number.isInteger(messageId)) return
    cacheTokensByMessageId.set(messageId, {
      index,
      creation: readNumber(usage, 'cacheCreationInputTokens'),
      read: readNumber(usage, 'cacheReadInputTokens'),
    })
  })

  const calls: AmpCallRecord[] = []

  // Preferred path: the usage ledger, one event per billed request.
  const ledger = thread['usageLedger']
  const events = isRecord(ledger) && Array.isArray(ledger['events']) ? ledger['events'] : []
  for (const raw of events) {
    if (!isRecord(raw)) continue
    const timestamp = nonEmptyString(raw['timestamp'])
    const model = nonEmptyString(raw['model'])
    const tokens = raw['tokens']
    if (!timestamp || !model || !isRecord(tokens)) continue

    const inputTokens = readNumber(tokens, 'input')
    const outputTokens = readNumber(tokens, 'output')
    const total = finiteNonNegative(tokens['total'])
    const toMessageId = raw['toMessageId']
    const billed = typeof toMessageId === 'number' && Number.isInteger(toMessageId)
      ? cacheTokensByMessageId.get(toMessageId)
      : undefined
    // Attribute any positive remainder to output, after accounting for the
    // explicit input/output counts and both joined cache-token counts.
    const accountedTokens = inputTokens + outputTokens + (billed?.creation ?? 0) + (billed?.read ?? 0)
    const billedOutput = outputTokens + Math.max(0, (total ?? 0) - accountedTokens)

    calls.push({
      model,
      timestamp,
      inputTokens,
      outputTokens: billedOutput,
      cacheCreationInputTokens: billed?.creation ?? 0,
      cacheReadInputTokens: billed?.read ?? 0,
      eventId: nonEmptyString(raw['id']) ?? (typeof raw['id'] === 'number' ? String(raw['id']) : undefined),
      messageIndex: billed?.index,
    })
  }

  if (calls.length > 0) return { threadId, calls, userMessages }

  // Fallback: per-assistant-message usage blocks (threads without a ledger).
  messages.forEach((message, index) => {
    if (message['role'] !== 'assistant') return
    const usage = message['usage']
    if (!isRecord(usage)) return
    const timestamp = nonEmptyString(usage['timestamp']) ?? nonEmptyString(message['timestamp'])
    const model = nonEmptyString(usage['model']) ?? nonEmptyString(message['model'])
    if (!timestamp || !model) return

    const inputTokens = readNumber(usage, 'inputTokens')
    const outputTokens = readNumber(usage, 'outputTokens')
    const cacheCreationInputTokens = readNumber(usage, 'cacheCreationInputTokens')
    const cacheReadInputTokens = readNumber(usage, 'cacheReadInputTokens')
    const total = finiteNonNegative(usage['totalTokens'])
    const hasParts = inputTokens > 0 || outputTokens > 0 || cacheCreationInputTokens > 0 || cacheReadInputTokens > 0
    const billedOutput = hasParts ? outputTokens : total ?? 0

    calls.push({
      model,
      timestamp,
      inputTokens,
      outputTokens: billedOutput,
      cacheCreationInputTokens,
      cacheReadInputTokens,
      eventId: undefined,
      messageIndex: index,
    })
  })

  return { threadId, calls, userMessages }
}

function userMessageFor(parsed: ParsedThread, record: AmpCallRecord): string {
  // Nearest user message at or before the billed message; the thread's first
  // user text when the record carries no anchor.
  const anchor = record.messageIndex ?? Number.MAX_SAFE_INTEGER
  for (let i = parsed.userMessages.length - 1; i >= 0; i--) {
    if (parsed.userMessages[i].index < anchor) return parsed.userMessages[i].text
  }
  return parsed.userMessages[0]?.text ?? ''
}

function hasPositiveTokens(record: AmpCallRecord): boolean {
  return record.inputTokens > 0
    || record.outputTokens > 0
    || record.cacheCreationInputTokens > 0
    || record.cacheReadInputTokens > 0
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const content = await readSessionFile(source.path)
      if (content === null) return
      const parsed = parseThreadFile(content)
      if (!parsed) return

      const threadId = parsed.threadId

      for (const record of parsed.calls) {
        if (!hasPositiveTokens(record)) continue

        const deduplicationKey = record.eventId
          ? `${source.provider}:${threadId}:${record.eventId}`
          : `${source.provider}:${threadId}:${record.timestamp}:${record.model}:${record.inputTokens}x${record.outputTokens}`
        if (seenKeys.has(deduplicationKey)) continue
        seenKeys.add(deduplicationKey)

        yield {
          provider: source.provider,
          model: record.model,
          inputTokens: record.inputTokens,
          outputTokens: record.outputTokens,
          cacheCreationInputTokens: record.cacheCreationInputTokens,
          cacheReadInputTokens: record.cacheReadInputTokens,
          cachedInputTokens: record.cacheReadInputTokens,
          reasoningTokens: 0,
          webSearchRequests: 0,
          costUSD: calculateCost(
            record.model,
            record.inputTokens,
            record.outputTokens,
            record.cacheCreationInputTokens,
            record.cacheReadInputTokens,
            0,
          ),
          // Priced from tokens; Amp's own credits field is not converted.
          costIsEstimated: true,
          tools: [],
          bashCommands: [],
          timestamp: record.timestamp,
          speed: 'standard',
          deduplicationKey,
          userMessage: userMessageFor(parsed, record),
          sessionId: threadId,
          project: source.project,
        }
      }
    },
  }
}

async function discoverThreads(roots: string[]): Promise<SessionSource[]> {
  const sources: SessionSource[] = []

  for (const root of roots) {
    const threadsDir = threadsDirFor(root)
    let entries: string[]
    try {
      entries = await readdir(threadsDir, { recursive: true })
    } catch {
      continue
    }

    // Discovery only walks names. The parser reads and validates each thread
    // once, skipping malformed JSON and files without a thread id.
    for (const name of entries) {
      if (!name.endsWith('.json')) continue
      sources.push({ path: join(threadsDir, name), project: 'Amp', provider: 'amp' })
    }
  }

  return sources
}

export function createAmpProvider(overrideDirs?: string[]): Provider {
  const roots = overrideDirs ?? ampDataDirs()

  return {
    name: 'amp',
    displayName: 'Amp',

    async probeRoots(): Promise<ProbeRoot[]> {
      return roots.map(root => ({ path: threadsDirFor(root), label: 'threads' }))
    },

    modelDisplayName(model: string): string {
      return getShortModelName(model)
    },

    toolDisplayName(rawTool: string): string {
      return rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      return discoverThreads(roots)
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const amp = createAmpProvider()

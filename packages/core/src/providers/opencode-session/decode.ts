// OpenCode-session rich decode.
//
// Pure record decode: no fs, no SQLite, no env, no process, no pricing, no
// strip-ansi. The CLI hands core a tagged envelope; core returns rich calls.

import { keyedDetail, type RecordDiagnostic } from '../../diagnostics.js'
import type { DecodeContext } from '../../contracts.js'
import type {
  FileMessageData,
  MessageData,
  OpenCodeSessionDecodedCall,
  OpenCodeSessionEnvelope,
  OpenCodeSessionTokens,
  PartData,
} from './types.js'

// ── tool-name normalization (moved verbatim from session-message.ts) ─────────

export const openCodeToolNameMap: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  edit: 'Edit',
  write: 'Write',
  glob: 'Glob',
  grep: 'Grep',
  task: 'Agent',
  fetch: 'WebFetch',
  search: 'WebSearch',
  todo: 'TodoWrite',
  skill: 'Skill',
  patch: 'Patch',
}

/**
 * Normalize an OpenCode-style tool name.
 *
 * NOTE: this preserves a pre-existing prototype leak: the bare Record lookup
 * followed by a truthy hit check means names like 'constructor' return
 * Object.prototype.constructor. It is moved byte-for-byte to keep parity with
 * the CLI output; do not "harden" it here.
 */
export function normalizeToolName(rawTool?: string): string {
  if (!rawTool) return ''
  if (rawTool.startsWith('mcp__')) return rawTool
  const builtIn = openCodeToolNameMap[rawTool]
  if (builtIn) return builtIn
  const serverSeparator = rawTool.indexOf('_')
  if (serverSeparator > 0 && serverSeparator < rawTool.length - 1) {
    const server = rawTool.slice(0, serverSeparator)
    const tool = rawTool.slice(serverSeparator + 1)
    return `mcp__${server}__${tool}`
  }
  return rawTool
}

export function parseTimestamp(raw: number): string {
  const ms = raw < 1e12 ? raw * 1000 : raw
  return new Date(ms).toISOString()
}

// ── shared assistant-turn builder ────────────────────────────────────────────

function buildAssistantCall(opts: {
  providerName: string
  dedupKey: string
  sessionId: string
  data: MessageData
  parts: PartData[]
  timeCreatedMs: number
  userMessage: string
}): OpenCodeSessionDecodedCall | null {
  const { data, parts } = opts

  const tokens = {
    input: data.tokens?.input ?? data.usage?.input_tokens ?? 0,
    output: data.tokens?.output ?? data.usage?.output_tokens ?? 0,
    reasoning: data.tokens?.reasoning ?? 0,
    cacheRead: data.tokens?.cache?.read ?? data.usage?.cache_read_input_tokens ?? 0,
    cacheWrite: data.tokens?.cache?.write ?? data.usage?.cache_creation_input_tokens ?? 0,
  }

  const toolParts = parts.filter((p) => (p.type === 'tool' || p.type === 'tool-call' || p.type === 'tool_call') && normalizeToolName(p.tool))
  const hasTextOutput = parts.some((p) => p.type === 'text' && typeof p.text === 'string' && p.text.trim().length > 0)
  const hasToolOrTextParts = hasTextOutput || toolParts.length > 0
  const hasAnySubstantiveParts = parts.some((p) =>
    p.type === 'text' || p.type === 'tool' || p.type === 'tool-call' || p.type === 'tool_call' ||
    p.type === 'tool-result' || p.type === 'tool_result' || p.type === 'reasoning' || p.type === 'file'
  )
  const hasActivity = hasToolOrTextParts || hasAnySubstantiveParts

  const allZero =
    tokens.input === 0 &&
    tokens.output === 0 &&
    tokens.reasoning === 0 &&
    tokens.cacheRead === 0 &&
    tokens.cacheWrite === 0
  if (allZero && (data.cost ?? 0) === 0 && !hasActivity) return null

  const tools = toolParts
    .map((p) => normalizeToolName(p.tool))
    .filter(Boolean)

  const rawBashCommands = toolParts
    .filter((p) => p.tool === 'bash' && typeof p.state?.input?.command === 'string')
    .map((p) => p.state!.input!.command!)

  const skills = toolParts
    .filter((p) => p.tool === 'skill' && typeof p.state?.input?.name === 'string')
    .map((p) => p.state!.input!.name!)
    .filter(Boolean)

  const subagentTypes = toolParts
    .filter((p) => p.tool === 'task' && typeof p.state?.input?.subagent_type === 'string')
    .map((p) => p.state!.input!.subagent_type!)
    .filter(Boolean)

  const model = data.modelID ?? data.model ?? 'unknown'

  return {
    arm: 'message',
    provider: opts.providerName,
    model,
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    cacheCreationInputTokens: tokens.cacheWrite,
    cacheReadInputTokens: tokens.cacheRead,
    cachedInputTokens: tokens.cacheRead,
    reasoningTokens: tokens.reasoning,
    webSearchRequests: 0,
    ...(typeof data.cost === 'number' ? { fallbackCostUSD: data.cost } : {}),
    tools,
    rawBashCommands,
    skills,
    subagentTypes,
    timestamp: parseTimestamp(opts.timeCreatedMs),
    speed: 'standard',
    deduplicationKey: opts.dedupKey,
    userMessage: opts.userMessage,
    sessionId: opts.sessionId,
  }
}

// ── arm dispatch ─────────────────────────────────────────────────────────────

export type OpenCodeSessionDecodeInput = {
  records: unknown[]
  context: DecodeContext
  seenKeys?: Set<string>
}

export type OpenCodeSessionDecodeResult = {
  calls: OpenCodeSessionDecodedCall[]
  diagnostics: RecordDiagnostic[]
}

function decodeSqlite(
  envelope: Extract<OpenCodeSessionEnvelope, { kind: 'sqlite' }>,
  providerName: string,
  seenKeys: Set<string>,
  privacyKey: string,
): OpenCodeSessionDecodeResult {
  const calls: OpenCodeSessionDecodedCall[] = []
  const diagnostics: RecordDiagnostic[] = []

  const partsByMsg = new Map<string, PartData[]>()
  for (const part of envelope.parts) {
    try {
      const parsed = JSON.parse(part.data) as PartData
      const list = partsByMsg.get(part.message_id) ?? []
      list.push(parsed)
      partsByMsg.set(part.message_id, list)
    } catch {
      // skip corrupt part data
    }
  }

  const currentUserMessageBySession = new Map<string, string>()

  for (const msg of envelope.messages) {
    let data: MessageData
    try {
      data = JSON.parse(msg.data) as MessageData
    } catch (err) {
      // Keyed fingerprint of the error, never its message: a hostile msg.data
      // could otherwise smuggle content through the parse failure. Without a
      // privacy key the detail is omitted entirely (D1: no unkeyed digest).
      const detail = keyedDetail(err, privacyKey)
      diagnostics.push(detail ? { index: 0, code: 'malformed-json', detail } : { index: 0, code: 'malformed-json' })
      continue
    }

    if (data.role === 'user') {
      const textParts = (partsByMsg.get(msg.id) ?? [])
        .filter((p) => p.type === 'text')
        .map((p) => p.text ?? '')
        .filter(Boolean)
      if (textParts.length > 0) {
        currentUserMessageBySession.set(msg.session_id, textParts.join(' '))
      }
      continue
    }

    if (data.role !== 'assistant' && data.role !== 'model') {
      diagnostics.push({ index: 0, code: 'unknown-shape' })
      continue
    }

    const dedupKey = `${providerName}:${msg.session_id}:${msg.id}`
    if (seenKeys.has(dedupKey)) continue

    const call = buildAssistantCall({
      providerName,
      dedupKey,
      sessionId: envelope.sessionId,
      data,
      parts: partsByMsg.get(msg.id) ?? [],
      timeCreatedMs: msg.time_created,
      userMessage: currentUserMessageBySession.get(msg.session_id) ?? '',
    })
    if (!call) continue

    seenKeys.add(dedupKey)
    calls.push(call)
  }

  if (calls.length === 0 && envelope.messages.length > 0) {
    const sessionTokens = envelope.sessionTokens
    if (
      sessionTokens &&
      (sessionTokens.cost > 0 || sessionTokens.input > 0 || sessionTokens.output > 0)
    ) {
      const dedupKey = `${providerName}:${envelope.sessionId}:session-level`
      if (!seenKeys.has(dedupKey)) {
        seenKeys.add(dedupKey)
        calls.push({
          arm: 'session-level',
          provider: providerName,
          model: sessionTokens.model ?? 'unknown',
          inputTokens: sessionTokens.input,
          outputTokens: sessionTokens.output,
          cacheCreationInputTokens: sessionTokens.cacheWrite,
          cacheReadInputTokens: sessionTokens.cacheRead,
          cachedInputTokens: sessionTokens.cacheRead,
          reasoningTokens: sessionTokens.reasoning,
          webSearchRequests: 0,
          ...(sessionTokens.cost > 0 ? { fallbackCostUSD: sessionTokens.cost } : {}),
          tools: [],
          rawBashCommands: [],
          skills: [],
          subagentTypes: [],
          timestamp: parseTimestamp(envelope.messages[0]!.time_created),
          speed: 'standard',
          deduplicationKey: dedupKey,
          userMessage: '',
          sessionId: envelope.sessionId,
        })
      }
    }
  }

  return { calls, diagnostics }
}

function decodeFile(
  envelope: Extract<OpenCodeSessionEnvelope, { kind: 'file' }>,
  providerName: string,
  seenKeys: Set<string>,
): OpenCodeSessionDecodeResult {
  const calls: OpenCodeSessionDecodedCall[] = []

  const messages = envelope.messages.slice()
  messages.sort((a, b) => {
    const byTime = (a.data.time?.created ?? 0) - (b.data.time?.created ?? 0)
    if (byTime !== 0) return byTime
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })

  let currentUserMessage = ''

  for (const { id, data } of messages) {
    if (data.role === 'user') {
      const parts: PartData[] = []
      for (const raw of envelope.partsRawByMessageId.get(id) ?? []) {
        try {
          parts.push(JSON.parse(raw) as PartData)
        } catch {
          // skip corrupt part file
        }
      }
      const text = parts
        .filter((p) => p.type === 'text')
        .map((p) => p.text ?? '')
        .filter(Boolean)
        .join(' ')
      if (text) currentUserMessage = text
      continue
    }

    if (data.role !== 'assistant' && data.role !== 'model') continue

    const dedupKey = `${providerName}:${envelope.sessionId}:${id}`
    if (seenKeys.has(dedupKey)) continue

    const parts: PartData[] = []
    for (const raw of envelope.partsRawByMessageId.get(id) ?? []) {
      try {
        parts.push(JSON.parse(raw) as PartData)
      } catch {
        // skip corrupt part file
      }
    }

    const call = buildAssistantCall({
      providerName,
      dedupKey,
      sessionId: envelope.sessionId,
      data,
      parts,
      timeCreatedMs: data.time?.created ?? envelope.metaTimeCreatedMs ?? 0,
      userMessage: currentUserMessage,
    })
    if (!call) continue

    seenKeys.add(dedupKey)
    calls.push(call)
  }

  return { calls, diagnostics: [] }
}

export function decodeOpenCodeSession(input: OpenCodeSessionDecodeInput): OpenCodeSessionDecodeResult {
  const seenKeys = input.seenKeys ?? new Set<string>()
  const envelope = input.records[0] as OpenCodeSessionEnvelope | undefined
  const providerName = input.context.providerId

  if (!envelope) return { calls: [], diagnostics: [] }

  switch (envelope.kind) {
    case 'sqlite':
      return decodeSqlite(envelope, providerName, seenKeys, input.context.privacyKey)
    case 'file':
      return decodeFile(envelope, providerName, seenKeys)
    default:
      return { calls: [], diagnostics: [{ index: 0, code: 'unknown-shape' }] }
  }
}

// @codeburn/core Forge decoder: pure decode over a host-supplied conversation
// row (the sqlite driver + query stay CLI-side; the `context` JSON blob is
// still a serialized string when it reaches this decoder). No fs/env/sqlite/
// pricing/strip-ansi here — bash base-name extraction stays host-side, this
// decoder emits raw command strings only.

import type { DecodeContext } from '../../contracts.js'
import type { RecordDiagnostic } from '../../diagnostics.js'
import { normalizeModelIdentifier } from '../../schema.js'
import type { ForgeConversationRow, ForgeContextMessage, ForgeDecodedCall } from './types.js'

function sqliteTimestampToIso(value: string | null | undefined): string {
  if (!value) return new Date(0).toISOString()

  const match = value.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?$/)
  if (match) {
    const ms = (match[3] ?? '').padEnd(3, '0').slice(0, 3)
    const parsed = new Date(`${match[1]}T${match[2]}.${ms}Z`)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  }

  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString()
}

function actual(value: unknown): number {
  if (!value || typeof value !== 'object') return 0
  const raw = (value as Record<string, unknown>)['actual']
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
}

function usageActual(usage: unknown, key: string): number {
  if (!usage || typeof usage !== 'object') return 0
  return actual((usage as Record<string, unknown>)[key])
}

// Kept as a `switch` (not a lookup object) and not exported: tool names come
// straight from the conversation JSON, so an object-literal map would resolve
// inherited `Object.prototype` members ("constructor", "toString", "__proto__")
// to non-string values instead of falling through to the identity default. The
// pre-migration CLI's `toolDisplayName` was an identity function anyway (raw
// tool ids never surfaced; `tools` already carries the mapped canonical name
// from this decode), so this has no consumer outside the extraction below.
function mapToolName(name: string): string {
  switch (name) {
    case 'shell':
    case 'bash':
      return 'Bash'
    case 'read':
    case 'Read':
      return 'Read'
    case 'write':
    case 'Write':
      return 'Write'
    case 'patch':
    case 'Edit':
    case 'edit':
      return 'Edit'
    case 'fs_search':
    case 'grep':
      return 'Grep'
    case 'task':
    case 'dispatch_agent':
      return 'Agent'
    default:
      return name
  }
}

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value)
}

function toolCallsOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(v => v && typeof v === 'object') as Record<string, unknown>[] : []
}

function extractToolsAndCommands(calls: Record<string, unknown>[]): { tools: string[]; rawBashCommands: string[]; firstCallId?: string } {
  const tools: string[] = []
  const rawBashCommands: string[] = []
  let firstCallId: string | undefined

  for (const call of calls) {
    const rawName = call['name']
    if (typeof rawName !== 'string') continue
    if (!firstCallId && typeof call['call_id'] === 'string') firstCallId = call['call_id']

    const tool = mapToolName(rawName)
    pushUnique(tools, tool)

    if (tool === 'Bash') {
      const args = call['arguments']
      if (args && typeof args === 'object') {
        const command = (args as Record<string, unknown>)['command']
        if (typeof command === 'string') {
          rawBashCommands.push(command)
        }
      }
    }
  }

  return { tools, rawBashCommands, firstCallId }
}

export type ForgeDecodeInput = {
  records: unknown[]
  context: DecodeContext
  seenKeys?: Set<string>
}

export type ForgeDecodeResult = {
  calls: ForgeDecodedCall[]
  diagnostics: RecordDiagnostic[]
}

/**
 * Decode one Forge `conversations` row into rich, cost-free calls, one per
 * assistant message that carries token usage. The nearest previous user
 * message in the same conversation is attributed as `userMessage`. Dedup keys
 * on the tool call's `call_id` when present, else a positional fallback,
 * against the live `seenKeys` set (host-owned).
 */
export function decodeForge({ records, seenKeys: liveSeen }: ForgeDecodeInput): ForgeDecodeResult {
  const seen = liveSeen ?? new Set<string>()
  const calls: ForgeDecodedCall[] = []

  for (const raw of records) {
    const row = raw as ForgeConversationRow
    if (!row.context) continue

    let parsed: unknown
    try {
      parsed = JSON.parse(row.context)
    } catch {
      continue
    }
    const messages = Array.isArray((parsed as { messages?: unknown }).messages)
      ? (parsed as { messages: ForgeContextMessage[] }).messages
      : []

    let userMessage = ''
    for (let i = 0; i < messages.length; i++) {
      const text = messages[i]?.message?.text
      const role = typeof text?.role === 'string' ? text.role.toLowerCase() : ''
      const content = typeof text?.content === 'string' ? text.content : ''

      if (role === 'user') {
        userMessage = content.length > 500 ? content.slice(0, 500) : content
        continue
      }
      if (role !== 'assistant') continue

      const promptTokens = usageActual(messages[i]?.usage, 'prompt_tokens')
      const outputTokens = usageActual(messages[i]?.usage, 'completion_tokens')
      const cachedInputTokens = usageActual(messages[i]?.usage, 'cached_tokens')
      const inputTokens = Math.max(0, promptTokens - cachedInputTokens)
      if (inputTokens === 0 && outputTokens === 0) continue

      const model = typeof text?.model === 'string' ? text.model : 'unknown'
      const toolCalls = toolCallsOf(text?.tool_calls)
      const { tools, rawBashCommands, firstCallId } = extractToolsAndCommands(toolCalls)
      // The fallback stableId normalizes the model component exactly as the
      // observation boundary does: this key ships on the envelope, so a
      // display-name model must collapse to 'unknown' inside it, never ride
      // it raw (the primary path uses the tool-call id, which is a machine id).
      const stableId = firstCallId ?? `${normalizeModelIdentifier(model)}:${promptTokens}:${outputTokens}:${i}`
      const deduplicationKey = `forge:${row.conversation_id}:${stableId}`
      if (seen.has(deduplicationKey)) continue
      seen.add(deduplicationKey)

      calls.push({
        provider: 'forge',
        model,
        inputTokens,
        outputTokens,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: cachedInputTokens,
        cachedInputTokens,
        reasoningTokens: 0,
        webSearchRequests: 0,
        tools,
        rawBashCommands,
        timestamp: sqliteTimestampToIso(row.updated_at ?? row.created_at),
        speed: 'standard',
        deduplicationKey,
        userMessage,
        sessionId: row.conversation_id,
      })
    }
  }

  return { calls, diagnostics: [] }
}

// @codeburn/core vscode-cline decoder: pure decode over host-supplied task
// envelopes. The host reads ui_messages.json and api_conversation_history.json;
// this decoder performs no I/O.

import { basename } from 'node:path'

import type { DecodeContext } from '../../contracts.js'
import { keyedDetail, type RecordDiagnostic } from '../../diagnostics.js'
import type { ClineHistoryMessage, ClineRecordEnvelope, ClineUiMessage, VscodeClineDecodedCall } from './types.js'

const MODEL_TAG_RE = /<model>([^<]+)<\/model>/
const WORKSPACE_DIR_RE = /Current Workspace Directory \(([^)]+)\)/

type HistoryMeta = { model: string; workspace: string | null }

function extractHistoryMeta(historyRaw: string | null, fallbackModel: string): HistoryMeta {
  if (historyRaw === null) return { model: fallbackModel, workspace: null }
  try {
    const msgs = JSON.parse(historyRaw) as ClineHistoryMessage[]
    if (!Array.isArray(msgs)) return { model: fallbackModel, workspace: null }
    let model: string | null = null
    let workspace: string | null = null
    for (const msg of msgs) {
      if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
      for (const block of msg.content) {
        if (typeof block.text !== 'string') continue
        if (!model) {
          const mm = MODEL_TAG_RE.exec(block.text)
          if (mm) model = mm[1].includes('/') ? mm[1].split('/').pop()! : mm[1]
        }
        if (!workspace) {
          const wm = WORKSPACE_DIR_RE.exec(block.text)
          if (wm) workspace = wm[1]
        }
        if (model && workspace) break
      }
      if (model && workspace) break
    }
    return { model: model ?? fallbackModel, workspace }
  } catch {
    return { model: fallbackModel, workspace: null }
  }
}

function workspaceToProject(workspace: string): string {
  return basename(workspace) || workspace
}

export interface VscodeClineDecodeInput {
  records: unknown[]
  context: DecodeContext
  seenKeys?: Set<string>
  /** Per-consumer knob. Defaults to 'cline-auto'; ibm-bob passes 'ibm-bob-auto'. */
  fallbackModel?: string
}

export interface VscodeClineDecodeResult {
  calls: VscodeClineDecodedCall[]
  diagnostics: RecordDiagnostic[]
}

/**
 * Decode vscode-cline task envelopes into rich, cost-free-or-measured calls.
 * Dedup is keyed on `<providerId>:<taskId>:<apiReqIndex>` against the live
 * `seenKeys` set (host-owned). A zero-token entry burns its dedup key before it
 * is skipped, matching the pre-migration behavior.
 */
export function decodeVscodeCline(input: VscodeClineDecodeInput): VscodeClineDecodeResult {
  const seenKeys = input.seenKeys ?? new Set<string>()
  const providerName = input.context.providerId
  const fallbackModel = input.fallbackModel ?? 'cline-auto'
  const calls: VscodeClineDecodedCall[] = []
  const diagnostics: RecordDiagnostic[] = []

  for (const [index, raw] of input.records.entries()) {
    const envelope = raw as ClineRecordEnvelope
    if (!envelope || envelope.kind !== 'cline-task') {
      diagnostics.push({ index, code: 'unknown-shape' })
      continue
    }

    let uiMessages: ClineUiMessage[]
    try {
      uiMessages = JSON.parse(envelope.uiRaw)
    } catch (err) {
      // Keyed fingerprint of the error, never its message: a hostile uiRaw
      // could otherwise smuggle content through the parse failure. Without a
      // privacy key the detail is omitted entirely (D1: no unkeyed digest).
      const detail = keyedDetail(err, input.context.privacyKey)
      diagnostics.push(detail ? { index, code: 'malformed-json', detail } : { index, code: 'malformed-json' })
      continue
    }

    if (!Array.isArray(uiMessages)) {
      diagnostics.push({ index, code: 'unknown-shape' })
      continue
    }

    const meta = extractHistoryMeta(envelope.historyRaw, fallbackModel)
    const model = meta.model
    const project = meta.workspace ? workspaceToProject(meta.workspace) : undefined
    const projectPath = meta.workspace ?? undefined

    let userMessage = ''
    for (const msg of uiMessages) {
      if (msg.type === 'say' && (msg.say === 'user_feedback' || msg.say === 'text')) {
        userMessage = (msg.text ?? '').slice(0, 500)
        break
      }
    }

    const apiReqEntries = uiMessages.filter(m => m.type === 'say' && m.say === 'api_req_started')

    for (const [entryIndex, entry] of apiReqEntries.entries()) {
      const dedupKey = `${providerName}:${envelope.taskId}:${entryIndex}`
      if (seenKeys.has(dedupKey)) continue
      seenKeys.add(dedupKey)

      let tokensIn = 0
      let tokensOut = 0
      let cacheReads = 0
      let cacheWrites = 0
      let cost: number | undefined

      if (entry.text) {
        try {
          const parsed = JSON.parse(entry.text) as {
            tokensIn?: number
            tokensOut?: number
            cacheReads?: number
            cacheWrites?: number
            cost?: number
          }
          tokensIn = parsed.tokensIn ?? 0
          tokensOut = parsed.tokensOut ?? 0
          cacheReads = parsed.cacheReads ?? 0
          cacheWrites = parsed.cacheWrites ?? 0
          cost = parsed.cost
        } catch {}
      }

      if (tokensIn === 0 && tokensOut === 0) continue

      const timestamp = entry.ts ? new Date(entry.ts).toISOString() : ''

      calls.push({
        provider: providerName,
        model,
        inputTokens: tokensIn,
        outputTokens: tokensOut,
        cacheCreationInputTokens: cacheWrites,
        cacheReadInputTokens: cacheReads,
        cachedInputTokens: cacheReads,
        reasoningTokens: 0,
        webSearchRequests: 0,
        ...(cost != null ? { measuredCostUSD: cost } : {}),
        tools: [],
        rawBashCommands: [],
        timestamp,
        speed: 'standard',
        deduplicationKey: dedupKey,
        userMessage: entryIndex === 0 ? userMessage : '',
        sessionId: envelope.taskId,
        project,
        projectPath,
      })
    }
  }

  return { calls, diagnostics }
}

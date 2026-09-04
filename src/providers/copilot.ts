// =============================================================================
// copilot.ts — Modified CodeBurn Copilot provider
// =============================================================================
//
// WHAT CHANGED:
//   The original provider only reads Copilot's JSONL session-state files from
//   ~/.copilot/session-state/, which only log output tokens. Input tokens,
//   cache-read tokens, and cache-creation tokens are never written there, so
//   CodeBurn underreports Copilot costs by 60-80%.
//
//   This modified version adds VS Code sources that can carry fuller token
//   data: the OTel SQLite store (agent-traces.db), VS Code core chatSessions
//   journals, and legacy extension transcripts. OTel and chatSessions contain
//   input/output token breakdowns for Copilot Chat users; legacy JSONL remains
//   a fallback when richer sources are absent.
//
// HOW TO ENABLE THE OTEL SQLITE STORE:
//   TWO settings must both be enabled in VS Code settings.json:
//
//     {
//       "github.copilot.chat.otel.enabled": true,
//       "github.copilot.chat.otel.dbSpanExporter.enabled": true
//     }
//
//   The first enables the OTel pipeline; the second (defaults to false) enables
//   the SQLite span exporter that actually writes agent-traces.db.
//   After changing these settings, restart VS Code — the extension watches for
//   these changes and requires a reload to take effect.
//
//   Or set the environment variable before launching VS Code:
//
//     export COPILOT_OTEL_ENABLED=true
//
//   The DB file is created in VS Code's global storage directory:
//     ~/Library/Application Support/Code/User/globalStorage/github.copilot-chat/agent-traces.db
//
// ENVIRONMENT VARIABLES:
//   CODEBURN_COPILOT_OTEL_DB    — Override the agent-traces.db path
//   CODEBURN_COPILOT_DISABLE_OTEL=1 — Skip OTel entirely, use only JSONL
//   CODEBURN_COPILOT_WS_STORAGE_DIR — Override VS Code workspaceStorage
//   CODEBURN_COPILOT_GLOBAL_STORAGE_DIR — Override VS Code globalStorage
//   CODEBURN_COPILOT_JETBRAINS_DIR — Override the JetBrains github-copilot root
//   CODEBURN_COPILOT_SESSION_STORE_DB — Override the ~/.copilot/session-store.db path
//
// ARCHITECTURE:
//   discoverSessions() returns OTel sessions and legacy JSONL sessions. When
//   OTel is present, VS Code core chatSessions are skipped because they mirror
//   the same Copilot turns under different IDs. OTel sessions carry the full
//   token breakdown; JSONL sessions only carry output tokens (the original
//   behaviour, as a fallback).
//
// LIMITATIONS:
//   - The OTel DB only contains Copilot Chat and Agent mode spans. Inline
//     completions (ghost text) and Agent Host spans are NOT yet written to
//     this DB (see https://github.com/microsoft/vscode/issues/315901).
//   - The DB schema is inferred from the official OTel GenAI semantic
//     conventions and the Copilot Budget extension's approach. If VS Code
//     changes the schema, this parser will need updating.
// =============================================================================

import { readdir, stat } from 'fs/promises'
import { homedir, platform } from 'os'
import { join, basename, dirname, posix, win32 } from 'path'
import { existsSync } from 'fs'
import { createHash } from 'crypto'
import { readSessionFile } from '../fs-utils.js'
import { calculateCost, getShortModelName } from '../models.js'
import { extractBashCommands } from '../bash-utils.js'
import { estimateTokens } from '../context-tree.js'
import type {
  Provider,
  ProbeRoot,
  SessionSource,
  SessionParser,
  ParsedProviderCall,
} from './types.js'

const COPILOT_OPENAI_AUTO = 'copilot-openai-auto'
const COPILOT_ANTHROPIC_AUTO = 'copilot-anthropic-auto'

const transcriptToolCallModelHints: Array<{ prefix: string; model: string }> = [
  // Anthropic tool-call ID variants observed in Copilot transcript logs.
  { prefix: 'toolu_bdrk_', model: COPILOT_ANTHROPIC_AUTO },
  { prefix: 'toolu_vrtx_', model: COPILOT_ANTHROPIC_AUTO },
  { prefix: 'tooluse_', model: COPILOT_ANTHROPIC_AUTO },
  { prefix: 'toolu_', model: COPILOT_ANTHROPIC_AUTO },
  // OpenAI tool-call IDs.
  { prefix: 'call_', model: COPILOT_OPENAI_AUTO },
]

// Legacy chat-session JSON format helpers
function normaliseLegacyModelId(raw: string): string {
  const stripped = raw.replace(/^[^/]+\//, '')
  return stripped.replace(/(\d+)\.(\d+)/g, '$1-$2')
}

const CHARS_PER_TOKEN_LEGACY = 4

interface LegacyRenderNode {
  type?: number
  text?: string
  children?: LegacyRenderNode[]
}

export interface ChatCompletionContentPartText {
  text: string
  type: ChatCompletionContentPartKind.Text
}

export interface ChatCompletionContentPartCacheBreakpoint {
  type: ChatCompletionContentPartKind.CacheBreakpoint
  cacheType?: string
}

export enum ChatCompletionContentPartKind {
  Image,
  Text,
  Opaque,
  CacheBreakpoint,
  Document,
}

export type ChatCompletionContentPart = ChatCompletionContentPartText | ChatCompletionContentPartCacheBreakpoint

export const openAIContextManagementCompactionType = 'compaction'

export interface OpenAIContextManagementResponse {
  encrypted_content: string
  type: typeof openAIContextManagementCompactionType
  id: string
}

export interface ThinkingData {
  id: string
  text: string | string[]
  metadata?: { [key: string]: any }
  tokens?: number
  encrypted?: string
}

export interface IToolCall {
  name: string
  arguments: string
  id: string
}

export interface IToolCallRound {
  id: string
  summary?: string
  response: string
  toolInputRetry: number
  toolCalls: IToolCall[]
  thinking?: ThinkingData
  statefulMarker?: string
  compaction?: OpenAIContextManagementResponse
  timestamp?: number
  hookContext?: string
  phase?: string
  phaseModelId?: string
}

interface LanguageModelToolResult {
  content?: Array<{
    value?: string | { node?: LegacyRenderNode }
  }>
}

interface IResultMetadata {
  metadata?: {
    renderedUserMessage?: ChatCompletionContentPart[]
    renderedGlobalContext?: ChatCompletionContentPart[]
    toolCallRounds?: readonly IToolCallRound[]
    toolCallResults?: Record<string, LanguageModelToolResult>
  }
  details?: string
}

export interface IParsedChatRequestPart {
  readonly kind: string
  readonly range: unknown
  readonly editorRange: unknown
  readonly text: string
  readonly promptText: string
}

export interface IParsedChatRequest {
  readonly parts: ReadonlyArray<IParsedChatRequestPart>
  readonly text: string
}

export interface SerializedChatResponsePart {
  kind?: string
  value?: string
  invocationMessage?: string
  toolSpecificData?: unknown
}

/** Shape of a single request entry in the legacy chatSessions JSON. */
interface LegacyChatRequest {
  requestId: string
  message?: string | IParsedChatRequest
  variableData?: unknown
  response?: SerializedChatResponsePart[]
  timestamp?: number
  modelId?: string
  result?: IResultMetadata
  promptTokens?: number
  completionTokens?: number
}

interface LegacyChatSession {
  sessionId?: string
  customTitle?: string
  creationDate?: number
  lastMessageDate?: number
  requests?: LegacyChatRequest[]
  inputState?: {
    selectedModel?: {
      identifier?: string
      metadata?: {
        version?: string
        family?: string
      }
    }
  }
}

/**
 * Recursively collect all text strings from a VSCode render-tree node.
 *
 * The render tree stores content as leaf nodes with `type === 2` and a `.text`
 * string at arbitrary nesting depth via `.children[]` arrays. Every tool
 * result (file reads, terminal output, edit confirmations, …) uses this shape,
 * regardless of the root `ctorName` (`tse`, `Wy`, etc.).
 */
function extractRenderNodeTexts(node: LegacyRenderNode | null | undefined): string {
  if (!node || typeof node !== 'object') return ''
  let out = ''
  if (node.type === 2 && typeof node.text === 'string') {
    out += node.text
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      out += extractRenderNodeTexts(child)
    }
  }
  return out
}

/**
 * Extract text from a toolCallResults entry's content array.
 * Handles two observed shapes:
 *  - $mid:21 — value is a plain string (terminal output, error messages)
 *  - $mid:23 — value is an object with a .node render tree (edit confirmations, etc.)
 */
function extractToolCallResultContent(
  results: NonNullable<NonNullable<LegacyChatRequest['result']>['metadata']>['toolCallResults'],
): string {
  if (!results) return ''
  let out = ''
  for (const result of Object.values(results)) {
    for (const item of result.content ?? []) {
      if (typeof item.value === 'string') {
        out += item.value + '\n'
      } else if (item.value && typeof item.value === 'object' && 'node' in item.value) {
        out += extractRenderNodeTexts(item.value.node) + '\n'
      }
    }
  }
  return out
}

/**
 * Extract the model's output text from toolCallRounds.
 * This is more accurate than scanning req.response, because req.response also
 * embeds terminal output (toolSpecificData.terminalCommandOutput.text) via its
 * generic .text key — which inflates the apparent output size with content that
 * is actually a tool result fed back as input, not model-generated output.
 *
 * Sources included:
 *  - toolCallRounds[x].response  — the model's text reply per reasoning round
 *  - toolCallRounds[x].toolCalls[x].arguments  — JSON args the model emitted
 *  - response[x].invocationMessage  — short narration strings ("Using 'Run in Terminal'")
 */

interface LegacyResponsePart {
  kind?: string
  value?: string | string[]
  content?: string | { value?: string }
  toolCallId?: string
  toolId?: string
  toolSpecificData?: {
    terminalCommandOutput?: {
      text?: string
    }
  }
  resultDetails?: {
    output?: {
      type?: string
      base64Data?: string
    }
  }
}

interface LegacyResultMetadata {
  promptTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cachedTokens?: number
  cacheCreationTokens?: number
  cacheWriteTokens?: number
  metadata?: {
    promptTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cachedTokens?: number
    cacheCreationTokens?: number
    cacheWriteTokens?: number
  }
  usage?: {
    promptTokens?: number
    prompt_tokens?: number
    completionTokens?: number
    completion_tokens?: number
    cacheReadTokens?: number
    cache_read_tokens?: number
    cachedTokens?: number
    cached_tokens?: number
    cacheCreationTokens?: number
    cache_creation_tokens?: number
    cacheWriteTokens?: number
    cache_write_tokens?: number
  }
}

function inferModelFromLegacySession(session: LegacyChatSession): string {
  // 1. Try to find the first request that has a non-empty modelId
  for (const req of session.requests ?? []) {
    if (req.modelId) {
      const normalized = normaliseLegacyModelId(req.modelId)
      if (normalized !== 'auto' && normalized !== 'unknown') {
        return normalized
      }
    }
  }

  // 1.5. Look in inputState.selectedModel.identifier and metadata
  const selectedModel = session.inputState?.selectedModel
  if (selectedModel) {
    const version = selectedModel.metadata?.version || selectedModel.metadata?.family || selectedModel.identifier
    if (version && version !== 'copilot/auto' && version !== 'auto') {
      return normaliseLegacyModelId(version)
    }
  }

  // 2. Try to find if there are any tool calls or IDs that hint at the model, like in transcript parser
  for (const req of session.requests ?? []) {
    const rounds = req.result?.metadata?.toolCallRounds
    for (const round of rounds ?? []) {
      for (const tc of round.toolCalls ?? []) {
        const id = tc.id ?? ''
        for (const hint of transcriptToolCallModelHints) {
          if (id.startsWith(hint.prefix)) {
            return hint.model
          }
        }
      }
    }
    const response = req.response
    for (const item of response ?? []) {
      if (item && typeof item === 'object') {
        const itemTyped = item as LegacyResponsePart
        const id = itemTyped.toolCallId ?? ''
        for (const hint of transcriptToolCallModelHints) {
          if (id.startsWith(hint.prefix)) {
            return hint.model
          }
        }
      }
    }
  }

  // 3. Fallback to copilot-auto
  return 'copilot-auto'
}

function extractToolCallResultContentFromParts(response: LegacyChatRequest['response']): string {
  if (!response) return ''
  let out = ''
  for (const item of response) {
    if (!item || typeof item !== 'object') continue
    if (item.kind === 'toolInvocationSerialized') {
      const itemTyped = item as LegacyResponsePart
      const spec = itemTyped.toolSpecificData
      if (spec) {
        // Handle terminal commands output
        if (spec.terminalCommandOutput && typeof spec.terminalCommandOutput.text === 'string') {
          out += spec.terminalCommandOutput.text + '\n'
        }
      }

      // Handle resultDetails containing base64 data
      const resultDetails = itemTyped.resultDetails
      if (resultDetails && typeof resultDetails === 'object') {
        if (resultDetails.output && resultDetails.output.type === 'data') {
          const base64 = resultDetails.output.base64Data
          if (typeof base64 === 'string') {
            const decoded = Buffer.from(base64, 'base64').toString('utf8')
            out += decoded + '\n'
          }
        }
      }
    }
  }
  return out
}

interface LegacyOutputs {
  outputText: string
  reasoningText: string
}

function extractLegacyOutputs(req: LegacyChatRequest): LegacyOutputs {
  let outputText = ''
  let reasoningText = ''

  const rounds = req.result?.metadata?.toolCallRounds
  const response = req.response

  if (rounds && rounds.length > 0) {
    for (const round of rounds) {
      if (typeof round.response === 'string' && round.response) {
        outputText += round.response + '\n'
      }
      for (const tc of round.toolCalls ?? []) {
        if (typeof tc.arguments === 'string' && tc.arguments) {
          outputText += tc.arguments + '\n'
        }
      }
      if (round.thinking) {
        const text = round.thinking.text
        if (typeof text === 'string' && text) {
          reasoningText += text + '\n'
        } else if (Array.isArray(text)) {
          reasoningText += text.join('\n') + '\n'
        }
      }
    }
  } else if (response && response.length > 0) {
    // Fallback: extract from response parts
    for (const itemRaw of response) {
      if (!itemRaw || typeof itemRaw !== 'object') continue
      const item = itemRaw as LegacyResponsePart

      // Plain IMarkdownString or item.kind === 'markdownContent' or item.kind === 'markdownVuln'
      if ('value' in item && typeof item.value === 'string' && !('kind' in item)) {
        outputText += item.value + '\n'
      } else if ((item.kind === 'markdownContent' || item.kind === 'markdownVuln') && item.content) {
        if (typeof item.content === 'string') {
          outputText += item.content + '\n'
        } else if (typeof item.content === 'object' && item.content !== null && 'value' in item.content && typeof item.content.value === 'string') {
          outputText += item.content.value + '\n'
        }
      } else if (item.kind === 'thinking' && item.value) {
        if (typeof item.value === 'string') {
          reasoningText += item.value + '\n'
        } else if (Array.isArray(item.value)) {
          reasoningText += item.value.join('\n') + '\n'
        }
      } else if (item.kind === 'textEditGroup') {
        const edits = (item as { edits?: unknown[] }).edits
        if (Array.isArray(edits)) {
          for (const edit of edits) {
            if (Array.isArray(edit)) {
              for (const e of edit) {
                if (e && typeof e === 'object' && 'text' in e && typeof (e as { text: unknown }).text === 'string') {
                  outputText += (e as { text: string }).text + '\n'
                }
              }
            } else if (edit && typeof edit === 'object' && 'text' in edit && typeof (edit as { text: unknown }).text === 'string') {
              outputText += (edit as { text: string }).text + '\n'
            }
          }
        }
      }
    }
  }

  // invocationMessage strings are model narration in the UI ("Checking terminal output",
  // "Using 'Multi-Replace String'", etc.) — short but part of model output.
  for (const item of response ?? []) {
    if (item && typeof item === 'object') {
      const inv = (item as { invocationMessage?: unknown }).invocationMessage
      if (typeof inv === 'string' && inv) {
        outputText += inv + '\n'
      } else if (inv && typeof inv === 'object' && 'value' in inv && typeof (inv as { value: unknown }).value === 'string') {
        outputText += (inv as { value: string }).value + '\n'
      }
    }
  }

  return { outputText, reasoningText }
}

function extractModelFromRequest(req: LegacyChatRequest, session: LegacyChatSession): string {
  const result = req.result as Record<string, unknown> | undefined
  const metadata = result?.['metadata'] as Record<string, unknown> | undefined

  // 1. Check resolved model from result metadata
  const resolvedMeta = readString(metadata?.['resolvedModel']) || readString(metadata?.['model'])
  if (resolvedMeta && resolvedMeta !== 'auto' && resolvedMeta !== 'copilot-auto') {
    return normaliseLegacyModelId(resolvedMeta)
  }

  // 2. Check resolved model directly on result
  const resultResolved = readString(result?.['resolvedModel']) || readString(result?.['model'])
  if (resultResolved && resultResolved !== 'auto' && resultResolved !== 'copilot-auto') {
    return normaliseLegacyModelId(resultResolved)
  }

  // 3. Check response parts for autoModeResolution or model info
  for (const part of req.response ?? []) {
    if (part && typeof part === 'object') {
      const p = part as Record<string, unknown>
      if (p.kind === 'autoModeResolution') {
        const resolved = readString(p['resolvedModel']) || readString(p['model']) || readString(p['modelId'])
        if (resolved && resolved !== 'auto') return normaliseLegacyModelId(resolved)
      }
    }
  }

  // 4. Check details if string contains model identifier
  if (typeof result?.['details'] === 'string') {
    const detailsModel = findJetBrainsModelToken(result['details'])
    if (detailsModel) return detailsModel
  }

  // 5. Check request modelId
  if (req.modelId && req.modelId !== 'auto' && req.modelId !== 'copilot/auto') {
    return normaliseLegacyModelId(req.modelId)
  }

  // 6. Inferred session model or fallback
  const inferred = inferModelFromLegacySession(session)
  if (inferred && inferred !== 'auto' && inferred !== 'copilot-auto') {
    return inferred
  }

  return 'claude-sonnet-4-5'
}

function parseLegacyChatSession(
  session: LegacyChatSession,
  sessionId: string,
  project: string,
  seenKeys: Set<string>,
): ParsedProviderCall[] {
  if (!session || !Array.isArray(session.requests)) return []

  const results: ParsedProviderCall[] = []

  for (const [reqIndex, req] of session.requests.entries()) {
    const model = extractModelFromRequest(req, session)
    const meta = req.result?.metadata

    const rounds = meta?.toolCallRounds ?? []

    const globalParts = (meta?.renderedGlobalContext ?? []).filter((p) => p.type === ChatCompletionContentPartKind.Text && typeof p.text === 'string') as ChatCompletionContentPartText[];
    const userParts = (meta?.renderedUserMessage ?? []).filter((p) => p.type === ChatCompletionContentPartKind.Text && typeof p.text === 'string') as ChatCompletionContentPartText[];
    const globalCacheMarkers = (meta?.renderedGlobalContext ?? []).filter((p) => p.type === ChatCompletionContentPartKind.CacheBreakpoint) as ChatCompletionContentPartCacheBreakpoint[];
    const userCacheMarkers = (meta?.renderedUserMessage ?? []).filter((p) => p.type === ChatCompletionContentPartKind.CacheBreakpoint) as ChatCompletionContentPartCacheBreakpoint[];

    // ── INPUT ──────────────────────────────────────────────────────────────────
    // Primary source: renderedGlobalContext + renderedUserMessage are the exact
    // strings VSCode assembled for the LLM prompt. This is more accurate than
    // scanning req.message/variableData, which are the raw user inputs before
    // the system prompt, file context, and instructions are added.
    //
    // When metadata is absent (older format), fall back to message text.
    const hasRenderedMetadata = globalParts.length > 0 || userParts.length > 0

    let inputTokens: number = 0
    let cacheCreationInputTokens = 0
    let cacheReadInputTokens = 0

    const msgText = typeof req.message === 'string' ? req.message : (req.message?.text ?? '')

    if (hasRenderedMetadata) {
      const globalText = globalParts.map((p) => p.text as string).join('\n')
      const userText = userParts.map((p) => p.text as string).join('\n')

      if (globalCacheMarkers.length > 0 || userCacheMarkers.length > 0) {
        // Cache semantics in VSCode Copilot Chat (ephemeral / 5-min cache):
        //
        // renderedGlobalContext (system prompt + workspace context) is STABLE across
        // all turns within a session — VSCode caches it once and reads it on every
        // subsequent turn.  Treat as cacheRead.
        //
        // renderedUserMessage attachments (file excerpts, editor context, tool output)
        // are NEW each turn — VSCode writes them to the ephemeral cache per message.
        // Treat as cacheCreation.
        //
        // Only count a section as cached if it actually has cache markers.
        if (globalCacheMarkers.length > 0) {
          cacheReadInputTokens = Math.ceil(globalText.length / CHARS_PER_TOKEN_LEGACY)
        } else {
          // Global context present but not marked cached — regular input.
          inputTokens = Math.ceil(globalText.length / CHARS_PER_TOKEN_LEGACY)
        }

        const attachmentText = userText.replace(msgText, '')
        if (userCacheMarkers.length > 0 && attachmentText.length > 0) {
          cacheCreationInputTokens = Math.ceil(attachmentText.length / CHARS_PER_TOKEN_LEGACY)
        } else if (userCacheMarkers.length === 0) {
          // User message not cached — all of it is regular input.
          inputTokens = (inputTokens ?? 0) + Math.ceil(userText.length / CHARS_PER_TOKEN_LEGACY)
          inputTokens -= Math.ceil(msgText.length / CHARS_PER_TOKEN_LEGACY) // will re-add below
        }
        // Bare user message is always regular (non-cached) input.
        inputTokens = (inputTokens ?? 0) + Math.ceil(msgText.length / CHARS_PER_TOKEN_LEGACY)
      } else {
        inputTokens = Math.ceil((globalText + '\n' + userText).length / CHARS_PER_TOKEN_LEGACY)
      }
    } else {
      // Fallback: no rendered metadata — use the raw message text
      inputTokens = Math.ceil(msgText.length / CHARS_PER_TOKEN_LEGACY)
    }

    // Tool results (file contents, terminal output, command results) are fed back
    // to the model as input for subsequent reasoning rounds.
    // We use a targeted extractor instead of the generic key traversal to avoid
    // double-counting text that appears in req.response.toolSpecificData.
    let toolResultText = extractToolCallResultContent(meta?.toolCallResults)
    if (!toolResultText) {
      toolResultText = extractToolCallResultContentFromParts(req.response)
    }
    const toolResultTokens = Math.ceil(toolResultText.length / CHARS_PER_TOKEN_LEGACY)

    let totalInputTokens = inputTokens + toolResultTokens

    // ── OUTPUT & REASONING ─────────────────────────────────────────────────────
    const { outputText, reasoningText } = extractLegacyOutputs(req)
    let outputTokens = Math.ceil(outputText.length / CHARS_PER_TOKEN_LEGACY)
    let reasoningTokens = Math.ceil(reasoningText.length / CHARS_PER_TOKEN_LEGACY)
    let isEstimated = true

    // Check for exact token counts
    if (typeof req.promptTokens === 'number' && typeof req.completionTokens === 'number') {
      totalInputTokens = req.promptTokens
      outputTokens = req.completionTokens
      isEstimated = false
    }

    const resultObj = req.result as LegacyResultMetadata
    if (resultObj) {
      let foundExact = false
      if (typeof resultObj.promptTokens === 'number' && typeof resultObj.outputTokens === 'number') {
        totalInputTokens = resultObj.promptTokens
        outputTokens = resultObj.outputTokens
        cacheReadInputTokens = resultObj.cacheReadTokens ?? resultObj.cachedTokens ?? cacheReadInputTokens
        cacheCreationInputTokens = resultObj.cacheCreationTokens ?? resultObj.cacheWriteTokens ?? cacheCreationInputTokens
        foundExact = true
      } else if (resultObj.metadata && typeof resultObj.metadata.promptTokens === 'number' && typeof resultObj.metadata.outputTokens === 'number') {
        totalInputTokens = resultObj.metadata.promptTokens
        outputTokens = resultObj.metadata.outputTokens
        cacheReadInputTokens = resultObj.metadata.cacheReadTokens ?? resultObj.metadata.cachedTokens ?? cacheReadInputTokens
        cacheCreationInputTokens = resultObj.metadata.cacheCreationTokens ?? resultObj.metadata.cacheWriteTokens ?? cacheCreationInputTokens
        foundExact = true
      } else if (resultObj.usage) {
        totalInputTokens = resultObj.usage.promptTokens ?? resultObj.usage.prompt_tokens ?? totalInputTokens
        outputTokens = resultObj.usage.completionTokens ?? resultObj.usage.completion_tokens ?? outputTokens
        cacheReadInputTokens = resultObj.usage.cacheReadTokens ?? resultObj.usage.cache_read_tokens ?? resultObj.usage.cachedTokens ?? resultObj.usage.cached_tokens ?? cacheReadInputTokens
        cacheCreationInputTokens = resultObj.usage.cacheCreationTokens ?? resultObj.usage.cache_creation_tokens ?? resultObj.usage.cacheWriteTokens ?? resultObj.usage.cache_write_tokens ?? cacheCreationInputTokens
        foundExact = true
      }
      if (foundExact) isEstimated = false
    }

    if (outputTokens === 0 && totalInputTokens === 0 && cacheCreationInputTokens === 0 && reasoningTokens === 0) continue

    let tools: string[] = []
    if (rounds.length > 0) {
      tools = rounds
        .flatMap((r) => r.toolCalls ?? [])
        .map((t) => t.name ?? '')
        .filter(Boolean)
        .map((n) => toolNameMap[n] ?? n)
    } else {
      tools = (req.response ?? [])
        .filter((item) => item && typeof item === 'object' && item.kind === 'toolInvocationSerialized')
        .map((item) => (item as LegacyResponsePart).toolId)
        .map((n) => normalizeTool(n ?? ''))
    }

    // Index-based fallback matches upstream's inline loop, so a cached
    // pre-fork parse and a re-parse produce identical dedup keys.
    const reqId = req.requestId || `request-${reqIndex}`
    const dedupKey = `copilot-chatsession:${sessionId}:${reqId}`
    if (seenKeys.has(dedupKey)) continue
    seenKeys.add(dedupKey)

    const costUSD = calculateCost(
      model,
      totalInputTokens,
      outputTokens + reasoningTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
      reasoningTokens,
    )

    // The timestamp field on each request is a Unix ms epoch integer.
    // Fall back to the session's creationDate like upstream so undated legacy
    // requests stay visible to date-range filters instead of vanishing.
    const ts = timestampToISO(req.timestamp) || timestampToISO(session.creationDate)

    results.push({
      provider: 'copilot',
      model,
      inputTokens: totalInputTokens,
      outputTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
      cachedInputTokens: 0,
      reasoningTokens,
      webSearchRequests: 0,
      costUSD,
      costIsEstimated: isEstimated,
      tools,
      bashCommands: [],
      timestamp: ts,
      speed: 'standard',
      deduplicationKey: dedupKey,
      userMessage: msgText.slice(0, 500),
      sessionId,
      project,
    })
  }

  return results
}

// ---------------------------------------------------------------------------
// Model display names (unchanged from original)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Tool name normalisation (unchanged from original, plus OTel tool names)
// ---------------------------------------------------------------------------
const toolNameMap: Record<string, string> = {
  // JSONL session-state tool names
  bash: 'Bash',
  skill: 'Skill',
  read_file: 'Read',
  write_file: 'Edit',
  edit_file: 'Edit',
  delete_file: 'Delete',
  github_repo: 'GitHub',
  web_search: 'WebSearch',
  run_in_terminal: 'Shell',
  // JetBrains Copilot agent tool names (snake_case)
  insert_edit_into_file: 'Edit',
  create_file: 'Edit',
  get_errors: 'Diagnostics',
  file_search: 'Search',
  grep_search: 'Search',
  semantic_search: 'Search',
  list_dir: 'Search',
  fetch_webpage: 'Web',
  // OTel execute_tool span names from Copilot Chat:
  readFile: 'Read',
  writeFile: 'Edit',
  editFile: 'Edit',
  runCommand: 'Shell',
  runInTerminal: 'Shell',
  findFiles: 'Search',
  grepSearch: 'Search',
  codebaseSearch: 'Search',
  getErrors: 'Diagnostics',
  listCodeUsages: 'Search',
  createFile: 'Edit',
  deleteFile: 'Delete',
  renameOrMoveFile: 'Edit',
  fetchWebpage: 'Web',
}

/**
 * Normalise a raw tool name to its display form.
 * - Known tools are mapped via toolNameMap.
 * - MCP tools (containing both '-' and '_') are formatted as
 *   mcp__server_name__tool_name.
 * - Everything else is returned unchanged.
 */
function normalizeTool(rawTool: string): string {
  const mapped = toolNameMap[rawTool]
  if (mapped) return mapped
  // MCP tool names follow the pattern: server-name-tool_operand
  // e.g. github-mcp-server-list_issues → mcp__github_mcp_server__list_issues
  const dashIdx = rawTool.lastIndexOf('-')
  if (dashIdx > 0 && rawTool.includes('_')) {
    const server = rawTool.slice(0, dashIdx).replace(/-/g, '_')
    const tool = rawTool.slice(dashIdx + 1)
    return `mcp__${server}__${tool}`
  }
  return rawTool
}

// Tool names that represent shell/bash execution. When the AI calls one of
// these, we extract the `arguments.command` string into bashCommands[].
const BASH_TOOL_NAMES = new Set(['bash', 'run_in_terminal', 'runInTerminal', 'runCommand'])

// ---------------------------------------------------------------------------
// Types for JSONL session state events (unchanged from original)
// ---------------------------------------------------------------------------
type ToolRequest = {
  toolName?: string  // older format
  name?: string      // newer format (copilot-agent)
  arguments?: Record<string, unknown>
}

type SessionStartData = {
  selectedModel?: string
}

const CHARS_PER_TOKEN = 4

// --- VS Code transcript format (workspaceStorage transcripts) ---

type TranscriptToolRequest = {
  toolCallId?: string
  name?: string
  arguments?: string
  type?: string
}

type TranscriptEvent =
  | { type: 'session.start'; timestamp?: string; data: { sessionId: string; producer?: string } }
  | { type: 'user.message'; timestamp?: string; data: { content: string; attachments?: unknown[] } }
  | { type: 'assistant.message'; timestamp?: string; data: { messageId: string; content?: string; reasoningText?: string; toolRequests?: TranscriptToolRequest[]; outputTokens?: number } }
  | { type: string; timestamp?: string; data: Record<string, unknown> }

function inferModelFromToolCallIds(events: TranscriptEvent[]): string {
  const modelCounts = new Map<string, number>()

  for (const e of events) {
    // Some newer events (like tool.execution_complete) explicitly include the model ID.
    const data = e.data as { model?: string }
    if (typeof data?.model === 'string' && data.model) {
      modelCounts.set(data.model, (modelCounts.get(data.model) ?? 0) + 100)
    }

    // NEW: Also check for llm_request attrs
    const attrs = (e as any).attrs
    if (attrs && typeof attrs.model === 'string' && attrs.model) {
      modelCounts.set(attrs.model, (modelCounts.get(attrs.model) ?? 0) + 100)
    }

    if (e.type !== 'assistant.message') continue
    const msg = e as { data: { toolRequests?: TranscriptToolRequest[] } }
    for (const t of msg.data.toolRequests ?? []) {
      const toolCallId = t.toolCallId ?? ''
      for (const hint of transcriptToolCallModelHints) {
        if (!toolCallId.startsWith(hint.prefix)) continue
        modelCounts.set(hint.model, (modelCounts.get(hint.model) ?? 0) + 1)
        break
      }
    }
  }

  if (modelCounts.size > 0) {
    return [...modelCounts.entries()].sort((a, b) => b[1] - a[1])[0]![0]
  }

  return 'copilot-auto'
}

// --- Parser ---

function isChatSessionJsonFormat(path: string, content: string): boolean {
  // The legacy chatSessions files are plain .json files (not .jsonl).
  if (!path.endsWith('.json')) return false
  try {
    const obj = JSON.parse(content) as Record<string, unknown>
    return Array.isArray(obj['requests'])
  } catch {
    return false
  }
}

type ModelChangeData = {
  newModel: string
  previousModel?: string
}

type UserMessageData = {
  content: string
  interactionId?: string
}

type AssistantMessageData = {
  messageId: string
  model?: string       // present in newer copilot-agent format
  outputTokens: number
  interactionId?: string
  toolRequests?: ToolRequest[]
}

type SubagentSelectedData = {
  agentName: string
  agentDisplayName?: string
  tools?: string[]
  // Present on subagent.started/completed (CLI ≥ ~1.0.7x): the delegation
  // tool call that launched the run, used to pair completed with started.
  toolCallId?: string
}

// Per-model usage rollup the CLI writes into session.shutdown. inputTokens is
// cache-INCLUSIVE (input + cache_read + cache_write); see the shutdown handler.
type ShutdownModelUsage = {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

type SessionShutdownData = {
  modelMetrics?: Record<string, { usage?: ShutdownModelUsage }>
  sessionStartTime?: number
}

// In-session compaction. The CLI emits compaction_start when it decides to
// summarize and compaction_complete when the summarization call returns; only
// the latter carries `success`, and only a successful one resets the
// session.shutdown rollup counters. Every other field here is read
// tolerantly - the payload also carries token counts, the summarization
// call's own usage (compactionTokensUsed), messagesRemoved, model, requestId
// and a manual/background `trigger`, none of which this parser needs.
type SessionCompactionCompleteData = {
  success?: boolean
}

type CopilotEvent =
  | { type: 'session.start'; data: SessionStartData; timestamp?: string }
  | { type: 'session.model_change'; data: ModelChangeData; timestamp?: string }
  | { type: 'user.message'; data: UserMessageData; timestamp?: string }
  | { type: 'assistant.message'; data: AssistantMessageData; timestamp?: string }
  | { type: 'subagent.selected'; data: SubagentSelectedData; timestamp?: string }
  | { type: 'subagent.started'; data: SubagentSelectedData; timestamp?: string }
  | { type: 'subagent.completed'; data: SubagentSelectedData; timestamp?: string }
  | { type: 'session.shutdown'; data: SessionShutdownData; timestamp?: string }
  | { type: 'llm_request' | 'llm.request'; attrs?: { model?: string }; timestamp?: string; data?: any }
  | { type: 'session.compaction_start'; data: Record<string, unknown>; timestamp?: string }
  | { type: 'session.compaction_complete'; data: SessionCompactionCompleteData; timestamp?: string }

type ChatJournalPathSegment = string | number

// ---------------------------------------------------------------------------
// Types for OTel span rows from agent-traces.db
// ---------------------------------------------------------------------------

// The OTel SQLite store schema uses a spans table where attributes are stored
// either as a JSON blob or as individual columns. We handle both patterns.
// The Copilot Budget extension reads from this same DB and uses per-span
// token counts, confirming this schema is stable enough to depend on.

// Parsed attribute bag from a span
interface SpanAttributes {
  'gen_ai.operation.name'?: string
  'gen_ai.response.model'?: string
  'gen_ai.request.model'?: string
  'gen_ai.usage.input_tokens'?: number
  'gen_ai.usage.output_tokens'?: number
  'gen_ai.usage.cache_read.input_tokens'?: number
  'gen_ai.usage.cache_creation.input_tokens'?: number
  'gen_ai.conversation.id'?: string
  'gen_ai.agent.name'?: string
  'gen_ai.tool.name'?: string
  'gen_ai.tool.call.arguments'?: string
  'copilot_chat.parent_chat_session_id'?: string
  'github.copilot.chat.turn.id'?: string
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function getCopilotSessionStateDir(override?: string): string {
  return override ?? process.env['CODEBURN_COPILOT_SESSION_STATE_DIR'] ?? join(homedir(), '.copilot', 'session-state')
}

function getSessionStoreDbPath(override?: string): string {
  return override ?? process.env['CODEBURN_COPILOT_SESSION_STORE_DB'] ?? join(homedir(), '.copilot', 'session-store.db')
}

/**
 * Locate the agent-traces.db file.
 *
 * Priority:
 *   1. CODEBURN_COPILOT_OTEL_DB env var
 *   2. Platform-specific default VS Code global storage path
 *   3. VSCodium variant paths
 */
function getAgentTracesDbPath(): string | null {
  // Allow explicit override
  const envOverride = process.env['CODEBURN_COPILOT_OTEL_DB']
  if (envOverride) {
    return existsSync(envOverride) ? envOverride : null
  }

  const home = homedir()
  const candidates: string[] = []

  const p = platform()
  if (p === 'darwin') {
    // macOS: VS Code, VS Code Insiders, VSCodium
    candidates.push(
      join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db'),
      join(home, 'Library', 'Application Support', 'Code - Insiders', 'User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db'),
      join(home, 'Library', 'Application Support', 'VSCodium', 'User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db'),
    )
  } else if (p === 'linux') {
    // Linux: VS Code, VS Code Insiders, VSCodium
    candidates.push(
      join(home, '.config', 'Code', 'User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db'),
      join(home, '.config', 'Code - Insiders', 'User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db'),
      join(home, '.config', 'VSCodium', 'User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db'),
    )
  } else if (p === 'win32') {
    // Windows
    const appdata = process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming')
    candidates.push(
      join(appdata, 'Code', 'User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db'),
      join(appdata, 'Code - Insiders', 'User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db'),
      join(appdata, 'VSCodium', 'User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db'),
    )
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Locate the GitHub Copilot config root used by the JetBrains IDE plugin
 * (IntelliJ IDEA, PyCharm, RubyMine, …). The JetBrains Copilot agent persists
 * chat/agent sessions here — a location none of the VS Code or CLI sources
 * touch, so this is the only way JetBrains-driven Copilot usage becomes
 * visible to CodeBurn.
 *
 * The path mirrors the plugin's own `getXdgConfigPath` logic (observed in the
 * bundled copilot-agent language server):
 *   - $XDG_CONFIG_HOME/github-copilot (when set to an absolute path)
 *   - macOS / Linux: ~/.config/github-copilot
 *   - Windows:       %USERPROFILE%\AppData\Local\github-copilot
 *
 * Under this root, each IDE has its own subdir (e.g. `iu` for IntelliJ IDEA
 * Ultimate, `intellij` for the community edition) containing
 * chat-agent-sessions/, chat-sessions/, and chat-edit-sessions/.
 */
function getJetBrainsCopilotRoot(override?: string): string {
  const envOverride = override ?? process.env['CODEBURN_COPILOT_JETBRAINS_DIR']
  if (envOverride) return envOverride

  const xdg = process.env['XDG_CONFIG_HOME']
  if (xdg && (posix.isAbsolute(xdg) || win32.isAbsolute(xdg))) {
    return join(xdg, 'github-copilot')
  }

  if (platform() === 'win32') {
    const local = process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local')
    return join(local, 'github-copilot')
  }

  return join(homedir(), '.config', 'github-copilot')
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseCwd(yaml: string): string | null {
  const match = yaml.match(/^cwd:\s*(.+)$/m)
  if (!match?.[1]) return null
  let raw = match[1].trim()
  // Strip inline YAML comments (# preceded by optional whitespace)
  raw = raw.replace(/\s*#.*$/, '')
  // Strip surrounding single/double quotes
  raw = raw.replace(/^['"]|['"]$/g, '').trim()
  return raw || null
}

/**
 * Load span attributes from the span_attributes table (key-value pairs).
 * This handles the modern VS Code Copilot Chat schema where attributes
 * are stored as separate key-value rows rather than a JSON blob.
 */
function loadSpanAttributesFromTable(
  db: ReturnType<typeof import('../sqlite.js')['openDatabase']>,
  spanId: string
): SpanAttributes {
  try {
    const rows = db.query<{ key: string; value: string | null }>(
      `SELECT key, value FROM span_attributes WHERE span_id = ?`,
      [spanId]
    )
    const attrs: SpanAttributes = {}
    for (const row of rows) {
      if (row.key && row.value) {
        try {
          // Try to parse numeric values
          const numValue = Number(row.value)
          attrs[row.key as keyof SpanAttributes] = Number.isNaN(numValue)
            ? row.value
            : numValue
        } catch {
          attrs[row.key as keyof SpanAttributes] = row.value
        }
      }
    }
    return attrs
  } catch {
    return {}
  }
}

/**
 * Convert nanosecond or millisecond epoch to ISO timestamp.
 * The OTel spec uses nanoseconds, but some implementations use milliseconds.
 */
function epochToISO(epoch: number): string {
  // Guard malformed rows: new Date(NaN).toISOString() throws. Fall back to the
  // epoch (1970) so a bad timestamp is excluded from period totals, not crashing.
  if (!Number.isFinite(epoch) || epoch <= 0) return new Date(0).toISOString()
  // If the value looks like nanoseconds (> 1e15), convert to ms
  const ms = epoch > 1e15 ? Math.floor(epoch / 1e6) : epoch > 1e12 ? epoch : epoch * 1000
  return new Date(ms).toISOString()
}

function timestampToISO(raw: unknown): string {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return epochToISO(raw)
  }
  if (typeof raw !== 'string') return ''
  const trimmed = raw.trim()
  if (!trimmed) return ''
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return epochToISO(Number(trimmed))
  }
  const parsed = Date.parse(trimmed)
  return Number.isNaN(parsed) ? '' : new Date(parsed).toISOString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isReplayContainer(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}

function createReplayObject(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>
}

const FORBIDDEN_CHAT_JOURNAL_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

function parseChatJournalPath(rawPath: unknown, fallback?: ChatJournalPathSegment[]): ChatJournalPathSegment[] | null {
  const value = rawPath === undefined ? fallback : rawPath
  if (!Array.isArray(value)) return null

  const path: ChatJournalPathSegment[] = []
  for (const segment of value) {
    if (typeof segment === 'number') {
      if (!Number.isInteger(segment) || segment < 0) return null
      path.push(segment)
      continue
    }
    if (typeof segment === 'string') {
      if (FORBIDDEN_CHAT_JOURNAL_KEYS.has(segment)) return null
      path.push(segment)
      continue
    }
    return null
  }
  return path
}

function getReplayValue(container: object, segment: ChatJournalPathSegment): unknown {
  return (container as Record<string, unknown>)[String(segment)]
}

function setReplayValue(container: object, segment: ChatJournalPathSegment, value: unknown): void {
  ; (container as Record<string, unknown>)[String(segment)] = value
}

function createContainerForNext(segment: ChatJournalPathSegment): unknown[] | Record<string, unknown> {
  return typeof segment === 'number' ? [] : createReplayObject()
}

function ensureReplayParent(root: object, path: ChatJournalPathSegment[]): object | null {
  let current: object = root
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i]!
    const nextSegment = path[i + 1]!
    let child = getReplayValue(current, segment)
    if (!isReplayContainer(child)) {
      const created = createContainerForNext(nextSegment)
      setReplayValue(current, segment, created)
      current = created
      continue
    }
    current = child
  }
  return current
}

function applyChatJournalSet(root: unknown, path: ChatJournalPathSegment[], value: unknown): unknown {
  if (path.length === 0) return value

  const workingRoot = isReplayContainer(root) ? root : createReplayObject()
  const parent = ensureReplayParent(workingRoot, path)
  if (!parent) return workingRoot
  setReplayValue(parent, path[path.length - 1]!, value)
  return workingRoot
}

function applyChatJournalAppend(root: unknown, path: ChatJournalPathSegment[], items: unknown[]): unknown {
  const workingRoot = isReplayContainer(root) ? root : createReplayObject()

  if (path.length === 0) {
    if (Array.isArray(workingRoot)) {
      for (const item of items) workingRoot.push(item)
    }
    return workingRoot
  }

  const parent = ensureReplayParent(workingRoot, path)
  if (!parent) return workingRoot

  const last = path[path.length - 1]!
  let target = getReplayValue(parent, last)
  const targetArray: unknown[] = Array.isArray(target) ? target : []
  if (target !== targetArray) {
    setReplayValue(parent, last, targetArray)
  }
  for (const item of items) targetArray.push(item)
  return workingRoot
}

function replayChatSessionJournal(content: string): unknown {
  let root: unknown = createReplayObject()
  const lines = content.split('\n').filter((l) => l.trim())

  for (const line of lines) {
    let entry: unknown
    try {
      entry = JSON.parse(line) as unknown
    } catch {
      continue
    }
    if (!isRecord(entry)) continue

    const kind = entry['kind']
    if (kind === 0) {
      root = entry['v']
      continue
    }

    if (kind === 1) {
      const path = parseChatJournalPath(entry['k'])
      if (!path) continue
      root = applyChatJournalSet(root, path, entry['v'])
      continue
    }

    if (kind === 2) {
      const hasPath = Object.prototype.hasOwnProperty.call(entry, 'k')
      const path = parseChatJournalPath(hasPath ? entry['k'] : undefined, ['requests'])
      const items = Array.isArray(entry['v']) ? entry['v'] : []
      if (!path) continue
      root = applyChatJournalAppend(root, path, items)
    }
  }

  return root
}

function numberOrZero(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0
}

function readString(raw: unknown): string {
  return typeof raw === 'string' ? raw : ''
}

/**
 * Extract a shell command string from an OTel execute_tool span's
 * `gen_ai.tool.call.arguments` attribute. The attribute is a JSON-encoded
 * argument object (e.g. `{"command":"ls -la"}`); we pull out the `command`
 * field. Returns null when the attribute is absent or doesn't carry a command,
 * so callers can skip shell-command extraction cleanly.
 */
function parseToolCommand(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const command = parsed['command']
    return typeof command === 'string' ? command : null
  } catch {
    return null
  }
}

// Shell control-flow keywords. These lead a statement but are not commands, so
// they must never be reported as bash commands.
const OTEL_SHELL_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi',
  'for', 'while', 'until', 'do', 'done',
  'case', 'esac', 'select', 'function', 'in', 'time', 'coproc',
])

/**
 * Normalise an OTEL shell command before command-name extraction.
 *
 * Unlike the Copilot CLI / VS Code JSONL logs — which record a single command
 * per tool call (e.g. `cd x && python3 y`) — the OTEL store records the FULL
 * multi-line script the agent ran (heredocs, for/if blocks, newline-separated
 * statements). The shared extractBashCommands helper only splits on `;`/`&&`/`|`
 * and has no concept of shell keywords, so those scripts leak control-flow words
 * (`for`, `do`, `if`, `then`, …) and collapse newline-separated statements.
 *
 * Normalising here — rather than in the shared helper — keeps every other
 * provider's behaviour unchanged. We (1) turn newlines into `;` so each
 * statement is its own segment, then (2) drop shell control-flow keywords.
 */
function extractOtelBashCommands(command: string): string[] {
  const normalized = command.replace(/\r?\n/g, '; ')
  return extractBashCommands(normalized).filter(c => !OTEL_SHELL_KEYWORDS.has(c))
}

// ---------------------------------------------------------------------------
// Helpers for JSONL / transcript parsing
// ---------------------------------------------------------------------------

/**
 * Safely coerce a raw toolRequests value to an array of ToolRequest.
 * Non-array values (string, null, undefined) are treated as empty arrays
 * so that a corrupt event.data doesn't abort the whole file parse loop.
 */
function coerceToolRequests(raw: unknown): ToolRequest[] {
  return Array.isArray(raw) ? (raw as ToolRequest[]) : []
}

/**
 * Infer the model bucket for a VS Code transcript file by counting the
 * toolCallId prefixes across all assistant messages:
 *   call_*           → OpenAI
 *   tooluse_* / toolu_*  → Anthropic
 * The dominant prefix determines the model for the whole session.
 * Returns '' if no toolCallIds are present.
 */
function inferTranscriptModel(lines: string[]): string {
  let openaiCount = 0
  let anthropicCount = 0

  for (const line of lines) {
    try {
      const event = JSON.parse(line) as CopilotEvent

      if (event.type === 'llm_request' || event.type === 'llm.request') {
        const attrs = (event as any).attrs as { model?: string } | undefined
        if (typeof attrs?.model === 'string' && attrs.model) {
          return normaliseLegacyModelId(attrs.model)
        }
      }

      if (event.type !== 'assistant.message') continue
      const data = event.data as AssistantMessageData & { toolRequests?: Array<{ toolCallId?: string }> }
      const reqs = coerceToolRequests(data.toolRequests)
      for (const req of reqs) {
        const id = (req as { toolCallId?: unknown }).toolCallId
        if (typeof id !== 'string') continue
        if (id.startsWith('call_')) openaiCount++
        else if (/^tooluse_|^toolu_/.test(id)) anthropicCount++
      }
    } catch {
      continue
    }
  }

  if (openaiCount === 0 && anthropicCount === 0) return ''
  return openaiCount >= anthropicCount ? 'copilot-openai-auto' : 'copilot-anthropic-auto'
}

// ---------------------------------------------------------------------------
// JSONL parser (handles both regular CLI session-state events and the VS Code
// transcript format — the same event vocabulary, but transcripts carry no
// token counts and no session.shutdown rollup)
// ---------------------------------------------------------------------------

/**
 * `isTranscript` comes from discovery (where the file lives), never from
 * content: the Copilot CLI writes the same session.start producer
 * ('copilot-agent') that VS Code transcripts carry, so producer sniffing
 * misread every CLI session as a transcript and dropped its session.shutdown
 * input/cache rollup (#944).
 */
function createJsonlParser(
  source: SessionSource,
  seenKeys: Set<string>,
  isTranscript: boolean
): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const content = await readSessionFile(source.path)
      if (!content) return
      // Legacy chatSessions/*.json — whole JSON object with a `requests` array.
      if (isChatSessionJsonFormat(source.path, content)) {
        const sessionId = basename(source.path, '.json')
        let sessionObj: LegacyChatSession
        try {
          sessionObj = JSON.parse(content) as LegacyChatSession
        } catch {
          return
        }
        const calls = parseLegacyChatSession(sessionObj, sessionId, source.project, seenKeys)
        for (const call of calls) {
          yield call
        }
        return
      }

      // CLI session-state files live at <sessionId>/events.jsonl; transcripts
      // at transcripts/<sessionId>.jsonl — keying the latter on the parent dir
      // would collapse every transcript into one "transcripts" session (and
      // one shared dedup namespace).
      const sessionId = isTranscript
        ? basename(source.path, '.jsonl')
        : basename(dirname(source.path))
      const lines = content.split('\n').filter((l) => l.trim())

      let currentModel = ''
      let pendingUserMessage = ''
      // Subagent attribution. Older CLIs write subagent.selected — sticky
      // until replaced, never cleared. CLI ≥ ~1.0.7x brackets each run with
      // started/completed instead; runs can nest or overlap, so completed
      // removes ONLY its own toolCallId's entry and the label falls back to
      // the still-active run (or the sticky selected value) rather than
      // wiping attribution for everything in flight.
      let selectedSubagentType: string | undefined
      const activeSubagents: Array<{ toolCallId: string; name: string }> = []
      const currentSubagentType = (): string | undefined =>
        activeSubagents[activeSubagents.length - 1]?.name ?? selectedSubagentType

      if (isTranscript) {
        // Tool-call-id prefix inference seeds the model; it must not gate the
        // whole file, or a transcript carrying explicit model info
        // (session.model_change / per-message model) but no tool calls would
        // yield nothing. Messages that still end up modelless are skipped
        // individually below.
        currentModel = inferTranscriptModel(lines)
      }

      // Shutdown rollups may lack their own timestamp; remember the last
      // stamped event so the supplementary call is never left with an empty
      // timestamp, which the date-range filters silently drop.
      let lastEventTimestamp = ''

      // Stamp of the most recent SUCCESSFUL session.compaction_complete seen so
      // far. Carried onto each shutdown leg because a compaction resets the
      // rollup counters, so the leg only describes requests after this point.
      let lastCompactionTs = ''

      // A resumed session appends one session.shutdown PER LEG, each carrying
      // CUMULATIVE per-model totals. Emitting each rollup whole would need the
      // cache to update a prior call in place — the durable merge is
      // append-only by dedup key — so we emit per-leg DELTAS keyed by
      // occurrence (`:n`): re-parses of a growing file append only the new
      // leg, and each leg lands on its own timestamp. Discovery only yields
      // `<sid>/events.jsonl`, so two journals cannot share a session id.
      const prevShutdownUsage = new Map<string, ShutdownModelUsage>()
      const shutdownCountByModel = new Map<string, number>()

      for (const line of lines) {
        let event: CopilotEvent
        try {
          event = JSON.parse(line) as CopilotEvent
        } catch {
          continue
        }
        if (typeof event.timestamp === 'string' && event.timestamp) lastEventTimestamp = event.timestamp

        if (event.type === 'session.start') {
          if (!isTranscript) {
            currentModel = (event.data as SessionStartData).selectedModel ?? currentModel
          }
          continue
        }

        if (event.type === 'session.model_change') {
          currentModel = (event.data as ModelChangeData).newModel ?? currentModel
          continue
        }

        // In-session compaction RESETS the session.shutdown rollup counters,
        // so a leg that contains one describes only its post-compaction
        // requests. Carrying the compaction's stamp onto the leg lets the
        // serve-time reconciliation start that leg's store-row interval here
        // instead of at the previous leg, which is the difference between
        // subtracting only the requests the rollup actually covers and
        // subtracting the whole pre-compaction conversation from it.
        // compaction_start is recognized but carries nothing we need: only a
        // COMPLETE with success:true reset anything (a failed or abandoned
        // compaction leaves the counters alone).
        if (event.type === 'session.compaction_complete') {
          const data = event.data as SessionCompactionCompleteData | undefined
          const ts = typeof event.timestamp === 'string' ? event.timestamp : ''
          if (data?.success === true && ts && !Number.isNaN(new Date(ts).getTime())) {
            lastCompactionTs = ts
          }
          continue
        }
        if (event.type === 'session.compaction_start') continue

        if (event.type === 'subagent.selected') {
          selectedSubagentType = (event.data as SubagentSelectedData).agentName
          continue
        }

        if (event.type === 'subagent.started') {
          const data = event.data as SubagentSelectedData
          activeSubagents.push({ toolCallId: data.toolCallId ?? '', name: data.agentName })
          continue
        }

        if (event.type === 'subagent.completed') {
          const id = (event.data as SubagentSelectedData).toolCallId ?? ''
          if (!id) {
            // ID-less completion (transitional CLIs that key nothing, like
            // subagent.selected): end the most recently started run; explicit
            // no-op on an empty stack.
            activeSubagents.pop()
            continue
          }
          for (let i = activeSubagents.length - 1; i >= 0; i--) {
            if (activeSubagents[i]!.toolCallId === id) {
              activeSubagents.splice(i, 1)
              break
            }
          }
          // A non-empty id that matches nothing refers to a run we never saw
          // start — leave the active runs alone rather than evicting an
          // unrelated one.
          continue
        }

        if (event.type === 'user.message') {
          pendingUserMessage = (event.data as UserMessageData).content ?? ''
          continue
        }

        if (event.type === 'session.shutdown') {
          // The Copilot CLI writes a per-model token/cost rollup here at
          // shutdown: the only place a CLI session records input, cache-read
          // and cache-write tokens (assistant.message events carry output
          // only). VS Code transcripts never carry this rollup, so this path
          // is gated to the CLI (non-transcript) format, leaving VS Code,
          // JetBrains and OTel sources untouched.
          //
          // We emit one supplementary call per model PER SHUTDOWN LEG (resumed
          // sessions write one cumulative rollup per leg; see the delta
          // tracking above) carrying ONLY the input/cache tokens the per-turn
          // events lack; output is excluded so the assistant.message output
          // (and its cost) is not double-counted. Combined with the per-turn
          // output cost, this yields the full, CLI-measured session cost.
          if (isTranscript) continue
          // When session-store.db holds per-request usage rows for this
          // session, those rows are authoritative for input/cache: written
          // per request instead of only on clean shutdown, and they describe
          // the SAME tokens this rollup lumps together. That precedence is
          // enforced at SERVE time, not here: this rollup is always parsed
          // and cached, and the reconciliation in parseProviderSources
          // decides per (session, model) — store rows replace the rollup,
          // with any usage the rollup carried beyond the rows' sum served as
          // a residual (see reconcileCopilotCalls there). Read-time
          // precedence over one coherent serve set cannot be raced by
          // writers between a coverage probe and this parse, and a briefly
          // unreadable store never blocks this file.
          const shutdownData = event.data as SessionShutdownData
          const modelMetrics = shutdownData.modelMetrics
          if (!isRecord(modelMetrics)) continue

          // Prefer lastEventTimestamp over sessionStartTime. sessionStartTime
          // is identical for every stampless leg of a resumed session, so
          // using it for the call timestamp (or, previously, the key) collapsed
          // those legs onto one date. lastEventTimestamp is the last stamped
          // event in this journal — distinct per leg when intervening events
          // are stamped, and still a real time when they are not.
          //
          // Fallback order matters for accounting, not just display: this
          // stamp anchors the leg's interval in the serve-time reconciliation,
          // which subtracts the store rows written up to it. A shutdown
          // happens at the END of a leg, so the last event seen is the
          // nearest true anchor; sessionStartTime is BEFORE every row, and
          // anchoring there would leave the leg covering nothing and re-mint
          // its whole usage as a residual beside the rows it duplicates.
          const shutdownTimestamp =
            (event.timestamp ?? '') || lastEventTimestamp || timestampToISO(shutdownData.sessionStartTime)

          for (const [model, metrics] of Object.entries(modelMetrics)) {
            if (!model || !isRecord(metrics)) continue
            const usage = metrics['usage']
            if (!isRecord(usage)) continue

            const cumulative: Required<ShutdownModelUsage> = {
              inputTokens: numberOrZero(usage['inputTokens']),
              outputTokens: numberOrZero(usage['outputTokens']),
              cacheReadTokens: numberOrZero(usage['cacheReadTokens']),
              cacheWriteTokens: numberOrZero(usage['cacheWriteTokens']),
              reasoningTokens: numberOrZero(usage['reasoningTokens']),
            }
            const prevRaw = prevShutdownUsage.get(model)
            prevShutdownUsage.set(model, cumulative)
            const n = (shutdownCountByModel.get(model) ?? 0) + 1
            shutdownCountByModel.set(model, n)

            // A cumulative total BELOW the previous rollup means the CLI reset
            // its counters (a fresh accounting epoch): delta from zero, else
            // this leg's post-reset usage would be clamped away entirely.
            // inputTokens is the monotonic sentinel — it is cache-inclusive,
            // so any usage at all grows it. In-session COMPACTION is a
            // confirmed reset trigger (CLI 1.0.78: a clean single-process
            // 107-request session's sole rollup covered exactly its five
            // post-compaction requests), so rollup-only accounting
            // undercounts any compacted session — usage between the last
            // pre-reset rollup and the reset is simply never written here.
            // Only the per-request session-store rows record it; that is why
            // they are authoritative for covered sessions.
            const prev =
              prevRaw && cumulative.inputTokens < numberOrZero(prevRaw.inputTokens)
                ? undefined
                : prevRaw

            // This leg's contribution: cumulative minus the previous rollup.
            // The clamp guards any remaining non-monotonic field.
            const delta = (k: keyof ShutdownModelUsage): number =>
              Math.max(0, cumulative[k] - numberOrZero(prev?.[k]))
            const cacheReadTokens = delta('cacheReadTokens')
            const cacheWriteTokens = delta('cacheWriteTokens')
            const reasoningTokens = delta('reasoningTokens')
            // usage.inputTokens is cache-INCLUSIVE (input + cache_read +
            // cache_write). calculateCost expects the uncached input alone with
            // cache tokens billed separately, so subtract the cache components.
            // Clamp at 0 in case a future schema reports input non-inclusively.
            const inputTokens = Math.max(
              0,
              delta('inputTokens') - cacheReadTokens - cacheWriteTokens
            )

            // Nothing this call would add over the per-turn events, so skip it
            // to avoid an empty $0 row (output is intentionally excluded).
            if (inputTokens === 0 && cacheReadTokens === 0 && cacheWriteTokens === 0 && reasoningTokens === 0) continue

            const dedupKey = `copilot:${sessionId}:shutdown:${model}:${n}`
            if (seenKeys.has(dedupKey)) continue
            seenKeys.add(dedupKey)

            // Tokens are real counts written by the CLI, so this cost is
            // measured, not char-estimated: costIsEstimated is false.
            const costUSD = calculateCost(model, inputTokens, 0, cacheWriteTokens, cacheReadTokens, 0)

            yield {
              provider: 'copilot',
              sessionId,
              model,
              inputTokens,
              outputTokens: 0,
              cacheCreationInputTokens: cacheWriteTokens,
              cacheReadInputTokens: cacheReadTokens,
              cachedInputTokens: 0,
              reasoningTokens,
              webSearchRequests: 0,
              costUSD,
              costIsEstimated: false,
              tools: [],
              bashCommands: [],
              timestamp: shutdownTimestamp,
              speed: 'standard' as const,
              deduplicationKey: dedupKey,
              userMessage: '',
              ...(lastCompactionTs ? { compactedAt: lastCompactionTs } : {}),
            }
          }
          continue
        }

        if (event.type === 'assistant.message') {
          const msgData = event.data as AssistantMessageData
          const { messageId, model: msgModel, outputTokens = 0 } = msgData
          const rawRequests = (msgData as { toolRequests?: unknown }).toolRequests
          const toolRequests = coerceToolRequests(rawRequests)

          // model may be carried per-message in newer copilot-agent format
          if (msgModel) currentModel = msgModel
          // Regular JSONL: skip zero-token messages; transcripts don't have tokens
          if (!isTranscript && outputTokens === 0) continue
          if (!currentModel) continue

          const dedupKey = `copilot:${sessionId}:${messageId}`
          if (seenKeys.has(dedupKey)) continue
          seenKeys.add(dedupKey)

          const tools = toolRequests
            .map((t) => {
              const raw = typeof t === 'object' && t !== null
                ? ((t as { name?: unknown; toolName?: unknown }).name ?? (t as { name?: unknown; toolName?: unknown }).toolName)
                : null
              return typeof raw === 'string' ? normalizeTool(raw) : null
            })
            .filter((t): t is string => t !== null)

          const skills = toolRequests.flatMap((t) => {
            if (typeof t !== 'object' || t === null) return []
            const name = (t.name ?? t.toolName) ?? ''
            if (name !== 'skill') return []
            const skill = t.arguments?.['skill']
            return typeof skill === 'string' && skill.trim().length > 0 ? [skill.trim()] : []
          })

          // Extract base command names from bash-type tool requests, routing the
          // raw command through the shared extractBashCommands helper so chained
          // commands are normalised the same way as every other provider
          // (see bash-utils.ts, parser.ts, forge.ts, grok.ts, etc.).
          const bashCommands = toolRequests.flatMap((t) => {
            if (typeof t !== 'object' || t === null) return []
            const name = (t.name ?? t.toolName) ?? ''
            if (!BASH_TOOL_NAMES.has(name)) return []
            const cmd = t.arguments?.['command']
            return typeof cmd === 'string' ? extractBashCommands(cmd) : []
          })

          // Copilot JSONL only logs outputTokens; inputTokens are NOT available.
          // Cost will be lower than actual API cost. This is the original
          // behaviour — OTel data (below) replaces it when available.
          const costUSD = calculateCost(currentModel, 0, outputTokens, 0, 0, 0)
          const subagentType = currentSubagentType()

          yield {
            provider: 'copilot',
            sessionId,
            model: currentModel,
            inputTokens: 0,
            outputTokens,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            cachedInputTokens: 0,
            reasoningTokens: 0,
            webSearchRequests: 0,
            costUSD,
            tools,
            bashCommands,
            skills: skills.length > 0 ? skills : undefined,
            subagentTypes: subagentType ? [subagentType] : undefined,
            timestamp: event.timestamp ?? '',
            speed: 'standard' as const,
            deduplicationKey: dedupKey,
            userMessage: pendingUserMessage,
          }
          pendingUserMessage = ''
        }
      }
    },
  }
}

function createChatSessionParser(
  source: ChatSessionSource,
  seenKeys: Set<string>
): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const content = await readSessionFile(source.path)
      if (!content) return

      const root = replayChatSessionJournal(content)
      if (!isRecord(root)) return

      const sessionId = readString(root['sessionId']) || basename(source.path, '.jsonl')
      const calls = parseLegacyChatSession(root as unknown as LegacyChatSession, sessionId, source.project, seenKeys)
      for (const call of calls) {
        yield call
      }
    },
  }
}

// ---------------------------------------------------------------------------
// JetBrains parser (Nitrite .db from ~/.config/github-copilot)
// ---------------------------------------------------------------------------
//
// The JetBrains Copilot plugin stores each chat/agent session in a Nitrite
// (H2 MVStore) .db of Java-serialized documents. There is NO token accounting
// anywhere in the store, so we estimate output tokens from the assistant reply
// text (the same char-count approach CodeBurn already uses for Cursor and
// legacy Copilot JSONL). Cost is therefore marked costIsEstimated.
//
// The model (e.g. "claude-opus-4.5", "gpt-4.1") is not always tagged on each
// turn, so we recover it by scanning the raw buffer for a known model token.

// Known JetBrains Copilot model tokens, longest-first so we match the most
// specific name (e.g. "gpt-4.1-mini" before "gpt-4.1").
const JETBRAINS_MODEL_TOKENS = [
  'claude-opus-4.7',
  'claude-opus-4.6',
  'claude-opus-4.5',
  'claude-opus-4.1',
  'claude-opus-4',
  'claude-sonnet-4.6',
  'claude-sonnet-4.5',
  'claude-sonnet-4',
  'claude-haiku-4.5',
  'gpt-5.4-mini',
  'gpt-5.4',
  'gpt-5.3-codex',
  'gpt-5.3',
  'gpt-5.2',
  'gpt-5.1',
  'gpt-5-mini',
  'gpt-5',
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'gpt-4.1',
  'gpt-4o-mini',
  'gpt-4o',
  'gemini-3.1-pro',
  'gemini-3-pro',
  'gemini-2.5-pro',
  'gemini-2.0-flash',
  'o3-mini',
  'o4-mini',
  'o3',
]

/**
 * Normalise a raw JetBrains model token to CodeBurn's canonical model id.
 * Claude names use dots on disk (claude-opus-4.5) but dashes in the pricing
 * tables (claude-opus-4-5); GPT/Gemini names are kept verbatim.
 */
function normalizeJetBrainsModelName(raw: string): string {
  const t = raw.trim()
  if (!t) return ''
  if (t.startsWith('claude-')) return t.replace(/\./g, '-')
  return t
}

/** Match a known model token at an alnum boundary anywhere in a string. */
function findJetBrainsModelToken(s: string): string {
  for (const token of JETBRAINS_MODEL_TOKENS) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // "o3" etc. must not match inside words like "iso3166".
    if (new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`).test(s)) {
      return normalizeJetBrainsModelName(token)
    }
  }
  return ''
}

/** Recover a model from a raw buffer by scanning for a known token. */
function inferJetBrainsModel(raw: string): string {
  return findJetBrainsModelToken(raw)
}

/**
 * Infer the project (repository name) from the file:// URIs a chat referenced.
 *
 * The JetBrains store has no workspace/cwd record, and there is no reliable
 * marker inside a path for where the repo root sits (users nest repos under
 * arbitrary container dirs). So for each referenced file we walk UP the real
 * filesystem to the nearest ancestor containing a `.git` entry and use that
 * directory's basename — the true repo root. This is the one approach that
 * yields a clean, consistent name (e.g. `my-service`) instead of a deep subdir
 * or an inconsistent prose-scraped guess.
 *
 * Returns undefined when the chat referenced no files or none resolve to a repo
 * that still exists on disk (caller then falls back to a generic bucket).
 */
function inferJetBrainsProject(raw: string): string | undefined {
  // Capture referenced paths (supports Linux / Unix / Windows paths in file:// URIs)
  const re = /file:\/\/(?:localhost)?(?:\/)?([A-Za-z]:[\\/][^"'\x00\r\n]+|\/[^"'\x00\r\n]+?)(?=(?:["'\x00\r\n]|\s+file:\/\/|$))/g
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) {
    let p = m[1].trim()
    try { p = decodeURIComponent(p) } catch { /* leave as-is */ }
    const dir = p.slice(0, p.lastIndexOf('/'))
    // A Windows URL is file:///C:/repo/One.ts, so the captured path carries a
    // leading slash that is part of the URL, not of the drive path.
    if (dir.startsWith('/')) seen.add(dir.replace(/^\/(?=[a-zA-Z]:\/)/, ''))
  }
  if (seen.size === 0) return undefined

  for (const dir of seen) {
    const repo = findGitRepoRoot(dir)
    if (repo) return repo
  }
  return undefined
}

/** Walk up from `dir` to the nearest ancestor containing `.git`; return its basename. */
function findGitRepoRoot(dir: string): string | undefined {
  let cur = dir
  // Bound the walk to avoid pathological loops; repos are never this deep.
  for (let i = 0; i < 40 && cur && cur !== '/'; i++) {
    if (existsSync(join(cur, '.git'))) {
      const name = basename(cur)
      return name || undefined
    }
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return undefined
}

/**
 * Recover the plugin-recorded project label from a Nitrite .db.
 *
 * JetBrains Copilot 1.12+ serialises a `projectName` field on the session doc
 * (e.g. `my-service`, `codeburn`). It is the plugin's OWN authoritative
 * label — the JetBrains analogue of the OTel source's
 * `github.copilot.git.repository` — so it is preferred over the file-path
 * git-walk heuristic when present.
 *
 * The field is a Java-serialized string: the key bytes `projectName` are
 * followed immediately by TC_STRING framing `0x74 <u16 big-endian length>
 * <UTF-8 bytes>`. We read exactly `length` bytes (so an embedded newline or
 * quote can't truncate it) and accept the first occurrence whose value is a
 * plausible short, printable repo name. Older plugins that don't write the
 * field simply yield undefined (callers fall back to the git-walk).
 *
 * Note: the field lives on the session doc, which the plugin writes into the
 * `chat-sessions` / `chat-edit-sessions` stores — often NOT the
 * `chat-agent-sessions` store where the billable turns live. Discovery joins
 * the two by store id; see resolveJetBrainsProjectNames.
 */
function extractJetBrainsProjectName(raw: string): string | undefined {
  const re = /projectName\x74([\x00-\xff])([\x00-\xff])/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) {
    const len = (m[1]!.charCodeAt(0) << 8) | m[2]!.charCodeAt(0)
    // Repo names are short; a huge length means we matched a schema/key
    // occurrence rather than a value-bearing one — skip it.
    if (len < 1 || len > 128) continue
    const start = m.index + m[0].length
    // The .db is read as latin1, so re-interpret the length-delimited bytes as
    // UTF-8 (repo names can contain non-ASCII). Reject only if the decoded value
    // holds control chars — a sign we matched a non-value occurrence, not a name.
    const val = Buffer.from(raw.slice(start, start + len), 'latin1').toString('utf8')
    // eslint-disable-next-line no-control-regex
    if (val.length > 0 && !/[\x00-\x1f]/.test(val)) return val
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Nitrite .db (H2 MVStore) extraction
// ---------------------------------------------------------------------------
//
// JetBrains Copilot sessions store their conversation in the Nitrite .db
// (copilot-*-nitrite.db). One .db holds many conversations. Assistant replies
// are stored as a distinct blob shape:
//
//   {"__first__":{"type":"Subgraph","value":"..."}, ...}
//
// which is more deeply escaped than the user-message value-maps. The reply text
// is recovered by progressive unescaping and collecting "text":"..." fields.
// Failed turns ("Sorry, an error occurred …") carry an error status and no reply
// text — they are detected and billed as $0.

// One assistant turn recovered from a .db.
type JBDbTurn = {
  replyText: string
  model: string
  errored: boolean
  // The owning conversation (chat tab): its internal GUID and title. One .db
  // holds many conversations; turns are grouped back to their tab by this id.
  conversationId: string
  conversationTitle: string
  // The file path this conversation referenced (home-relative common dir), or
  // '' if the chat touched no files. Used as the project label.
  conversationProject: string
}

// A conversation (chat tab) recovered from a .db: internal GUID → title.
type JBConversation = { id: string; title: string }

/**
 * Recover the conversation (chat-tab) records from a raw .db buffer. Each is
 * stored as `$<GUID> … name … value <title> … source copilot`. Returns the
 * GUID→title map so turns can be grouped back to the tab the user sees.
 */
function extractJetBrainsConversations(raw: string): JBConversation[] {
  // A conversation's title EVOLVES as the user chats: it starts as "New Agent
  // Session", may pass through an auto-generated name, and ends at the final
  // title shown in the UI. The same `$<GUID> … name … value <title> … source`
  // record is rewritten each time, so we collect every occurrence per GUID and
  // keep the LAST meaningful (non-default) one.
  const DEFAULT_TITLES = new Set(['New Agent Session', 'New Session', 'New Chat'])
  const byId = new Map<string, string>()
  const re = /\$([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[\s\S]{0,8}name/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) {
    const id = m[1]
    const window = raw.slice(m.index, m.index + 400)
    // The title is the Java-UTF string between the `value` marker and `source`.
    const tm = window.match(/value.{1,6}?([\x20-\x7e]{3,80}?)t\x00\x06source/)
    if (!tm) continue
    const title = Buffer.from(tm[1].replace(/^[^A-Za-z0-9]*/, ''), 'latin1').toString('utf8').trim()
    if (!title) continue
    // Keep the latest non-default title; only fall back to a default if no
    // meaningful title has been seen for this conversation yet.
    const existing = byId.get(id)
    if (existing && !DEFAULT_TITLES.has(existing) && DEFAULT_TITLES.has(title)) continue
    byId.set(id, title)
  }
  return [...byId.entries()].map(([id, title]) => ({ id, title }))
}

/** Brace-match a JSON object starting at `start`, tolerating escaped quotes. */
function matchJsonObject(raw: string, start: number): { chunk: string; end: number } {
  let depth = 0
  let inStr = false
  let esc = false
  let i = start
  for (; i < raw.length; i++) {
    const c = raw[i]
    if (esc) { esc = false; continue }
    if (c === '\\') { esc = true; continue }
    if (c === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) { i++; break } }
  }
  return { chunk: raw.slice(start, i), end: i }
}

/**
 * Recover the assistant reply text from a `__first__`/Subgraph response blob.
 *
 * JetBrains Copilot has two turn shapes, both handled here:
 *
 *  - **Ask mode:** the reply is a `Markdown` record whose `data` is an escaped
 *    JSON document `{"text":"…","annotations":…}`.
 *  - **Agent mode** (e.g. PyCharm agent sessions): the reply is the `reply`
 *    field of an `AgentRound` record `{"roundId":N,"reply":"…","toolCalls":[…]}`.
 *    In agent mode the `Markdown` records hold the USER's prompts, not the
 *    reply, so we must NOT read them — the assistant output is the AgentRound
 *    reply.
 *
 * Both are read STRUCTURALLY rather than by fully unescaping the blob (which
 * would strip the reply's own quotes and make regex extraction ambiguous): we
 * locate each `data`/`reply` value, read it as a properly-delimited JSON-string
 * literal (honouring escaping), unescape one level, and `JSON.parse` to reach
 * the text. We unescape the blob one level at a time and extract at the first
 * depth that yields text, never accumulating across depths (which would union a
 * quote-truncated half-unescaped capture with the full one and garble the
 * reply, inflating the token/cost estimate).
 *
 * Steps/error/progress-only blobs (no Markdown text and no AgentRound reply)
 * yield '' and are billed as $0 upstream.
 */
function extractResponseText(blob: string): string {
  let s = blob
  for (let depth = 0; depth < 8; depth++) {
    // Decide the mode by the PRESENCE of an AgentRound record, not by whether it
    // yielded a reply. In agent mode the Markdown record holds the USER prompt,
    // so an agent blob whose reply is empty (a failed turn, or a pure tool-call
    // round) must NOT fall back to Markdown — that would bill the user's prompt
    // as the assistant's output. Ask-mode blobs have no AgentRound record and
    // use Markdown. (Verified across every observed store: the two reply shapes
    // never coexist in one blob, so this mode split is unambiguous.)
    const isAgentMode = /"type":"AgentRound"/.test(s)
    if (isAgentMode || /"type":"Markdown"/.test(s)) {
      const decoded = isAgentMode ? extractAgentRoundReplies(s) : extractMarkdownTexts(s)
      // The .db is read as latin1 (byte-stable), so multibyte UTF-8 characters
      // are split into separate code units. Re-interpret as UTF-8 so the char
      // count (→ token estimate) reflects real content length, not byte count.
      // decoded may be empty (failed/tool-only agent turn) → '' (billed $0).
      return Buffer.from(decoded.join('\n').trim(), 'latin1').toString('utf8')
    }
    // Not yet at the depth where record markers appear bare — unescape one level
    // in a single left-to-right pass so `\\` and `\"` resolve together (a
    // two-pass replace would turn `\\"` into `\"` not `\\` + `"`).
    const next = s.replace(/\\([\\"])/g, '$1')
    if (next === s) break
    s = next
  }
  return ''
}

/**
 * Collect the `text` of every `Markdown` record in `s`, treating each record's
 * `data` value as a one-level-escaped JSON string parsed structurally (so the
 * reply's own quotes never truncate it). Returns [] if `s` is not yet at the
 * right unescape depth (no bare `"type":"Markdown"` with a parseable `data`).
 * Scoping to Markdown skips `Error` (`message`) and `Steps` records — not
 * billable output. Revisions repeat a reply, so identical texts are de-duped.
 */
function extractMarkdownTexts(s: string): string[] {
  return extractRecordStrings(s, '"type":"Markdown"', '"data":"', 'text')
}

/**
 * Collect the non-empty `reply` of every `AgentRound` record (agent mode). A
 * single blob can hold several rounds (a multi-turn agent session); each round's
 * `reply` is the assistant's text for that step (empty on pure tool-call rounds).
 * Deduped in order.
 */
function extractAgentRoundReplies(s: string): string[] {
  return extractRecordStrings(s, '"type":"AgentRound"', '"data":"', 'reply')
}

/**
 * Shared structural reader: for every `<marker>` in `s`, find the following
 * `<dataKey>` string literal (a one-level-escaped JSON document), parse it, and
 * collect `doc[field]` when it is a non-empty string. Reading the value as a
 * delimited literal — not a greedy regex — means the payload's own quotes never
 * truncate it. Returns [] when `s` is not yet at the depth where the marker
 * appears bare with a parseable payload. De-dupes in order (the store keeps
 * byte-copies/revisions of each reply).
 */
function extractRecordStrings(s: string, marker: string, dataKey: string, field: string): string[] {
  const texts: string[] = []
  const seen = new Set<string>()
  const re = new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    const dk = s.indexOf(dataKey, m.index)
    if (dk === -1 || dk - m.index > 200) continue
    // The value runs from after `<dataKey>` to the first UNescaped quote (an odd
    // run of preceding backslashes escapes it).
    const start = dk + dataKey.length
    let i = start
    for (; i < s.length; i++) {
      if (s[i] !== '"') continue
      let bs = 0
      for (let j = i - 1; j >= start && s[j] === '\\'; j--) bs++
      if (bs % 2 === 0) break
    }
    const literal = s.slice(start, i)
    try {
      // Wrapping in quotes + parsing unescapes exactly one level → the inner
      // JSON document as a string; parsing THAT reaches { <field>, … }.
      const doc = JSON.parse(JSON.parse('"' + literal + '"') as string) as Record<string, unknown>
      const text = typeof doc[field] === 'string' ? (doc[field] as string) : ''
      if (text && !seen.has(text)) {
        seen.add(text)
        texts.push(text)
      }
    } catch {
      // Not the right depth (or not a matching record) — skip.
    }
  }
  return texts
}

/**
 * Extract assistant turns from a raw (latin1) Nitrite .db buffer. Each turn is
 * one `{"__first__":{"type":"Subgraph"…}` blob; the per-turn model is recovered
 * from inside the blob when present, else the whole-store default. Each turn is
 * grouped back to its owning conversation (chat tab) by the nearest preceding
 * conversation GUID. Duplicate byte-copies of the same reply (the store keeps
 * several) are de-duplicated by content, per conversation.
 */
function extractJetBrainsDbTurns(raw: string): JBDbTurn[] {
  const conversations = extractJetBrainsConversations(raw)
  // Precompute the byte offset of each conversation GUID's full form so a turn
  // can be attributed to the conversation whose id most recently precedes it.
  const convById = new Map(conversations.map((c) => [c.id, c]))

  const turns: JBDbTurn[] = []
  const seenReplies = new Set<string>() // keyed by `${conversationId}::${reply}`
  const re = /\{"__first__":\{"type":"Subgraph"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) {
    const { chunk, end } = matchJsonObject(raw, m.index)
    re.lastIndex = end

    // Attribute this turn to the conversation whose GUID last appears before it.
    let conversationId = ''
    let conversationTitle = ''
    let bestPos = -1
    for (const c of convById.values()) {
      const p = raw.lastIndexOf(c.id, m.index)
      if (p > bestPos) {
        bestPos = p
        conversationId = c.id
        conversationTitle = c.title
      }
    }

    const replyText = extractResponseText(chunk)
    // The files this turn referenced (home-relative common dir) → project label.
    const conversationProject = inferJetBrainsProject(chunk) ?? ''
    // A per-turn model token sometimes appears inside the blob.
    const model = findJetBrainsModelToken(chunk)
    // A failed turn carries an error status / phrase AND produces no reply text.
    // Requiring empty text avoids misclassifying a genuine reply that merely
    // *discusses* an error (e.g. explaining a stack trace) as a failed turn.
    const hasErrorMarker = /error occurred|"isError":true|\\+"status\\+":\\+"(?:error|failed)\\+"/i.test(chunk)
    if (hasErrorMarker && !replyText) {
      turns.push({ replyText: '', model, errored: true, conversationId, conversationTitle, conversationProject })
      continue
    }
    if (!replyText) continue // Steps/progress-only blob — no billable output
    const dedupeKey = `${conversationId}::${replyText}`
    if (seenReplies.has(dedupeKey)) continue
    seenReplies.add(dedupeKey)
    turns.push({ replyText, model, errored: false, conversationId, conversationTitle, conversationProject })
  }

  // ---------------------------------------------------------------------------
  // Fallback: old JetBrains Copilot plugin format (≤1.5.x, e.g. 1.5.59-243)
  // ---------------------------------------------------------------------------
  // In this format ALL session turns are stored inside ONE large outer Nitrite
  // document — a binary-framed JSON object with UUID-keyed Value entries — rather
  // than the per-turn {"__first__":{"type":"Subgraph",...}} blobs used by newer
  // plugins (≥1.12.x). The AgentRound entries sit one escaping level deeper
  // inside the outer document's string values, so `extractResponseText`'s
  // depth-unescape loop handles extraction correctly once we feed it the right
  // chunk. MVStore keeps two identical copies of the collection; `seenReplies`
  // deduplicates them automatically.
  //
  // Detection heuristic: the __first__/Subgraph path produced no turns AND the
  // raw file contains bare 'AgentRound' text (meaning old-format data is present).
  if (turns.length === 0 && raw.includes('AgentRound')) {
    // The outer Nitrite document is preceded by a single binary framing byte
    // (0x81 in practice, but any non-printable/non-ASCII byte in MVStore).
    // It starts with a UUID-keyed Value entry: {"<uuid>":{"type":"Value",...}}.
    // Hex is matched case-insensitively — an uppercase UUID must not cause the
    // whole session to fall through to $0 (the exact bug this path fixes).
    const outerDocRe = /[\x00-\x1f\x7f-\xff]\{"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}":\{"type":"Value"/g
    let dm: RegExpExecArray | null
    while ((dm = outerDocRe.exec(raw))) {
      // Skip the leading binary byte; matchJsonObject starts at the '{'.
      const docStart = dm.index + 1
      const { chunk, end } = matchJsonObject(raw, docStart)
      outerDocRe.lastIndex = end

      // Skip documents that contain no AgentRound data (e.g. empty sessions).
      if (!chunk.includes('AgentRound')) continue

      // Attribute to the conversation whose GUID most recently precedes this doc.
      let conversationId = ''
      let conversationTitle = ''
      let bestPos = -1
      for (const c of convById.values()) {
        const p = raw.lastIndexOf(c.id, docStart)
        if (p > bestPos) {
          bestPos = p
          conversationId = c.id
          conversationTitle = c.title
        }
      }

      // extractResponseText handles the depth-1 unescape needed to surface the
      // AgentRound records, then calls extractAgentRoundReplies for each turn.
      // Because the outer document holds ALL turns in one blob we get back a
      // single joined string; split it on the '\n' join to yield per-turn texts.
      const allReplies = extractResponseText(chunk)
      if (!allReplies) continue

      const conversationProject = inferJetBrainsProject(chunk) ?? ''
      const storeModel = findJetBrainsModelToken(chunk)

      // extractResponseText joins multiple replies with '\n'. Since individual
      // replies can themselves span multiple lines we cannot cleanly split here —
      // instead we emit one ParsedProviderCall per outer document (one session).
      const dedupeKey = `${conversationId}::${allReplies}`
      if (seenReplies.has(dedupeKey)) continue
      seenReplies.add(dedupeKey)

      turns.push({
        replyText: allReplies,
        model: storeModel,
        errored: false,
        conversationId,
        conversationTitle,
        conversationProject,
      })
    }
  }

  // A project derived from ANY turn of a conversation applies to all its turns
  // (the files are usually referenced in the first substantive turn only).
  const projByConv = new Map<string, string>()
  for (const t of turns) {
    if (t.conversationProject && !projByConv.has(t.conversationId)) {
      projByConv.set(t.conversationId, t.conversationProject)
    }
  }
  for (const t of turns) {
    if (!t.conversationProject) t.conversationProject = projByConv.get(t.conversationId) ?? ''
  }

  return turns
}

// ---------------------------------------------------------------------------
// JetBrains parser: one ParsedProviderCall per assistant turn in the .db
// ---------------------------------------------------------------------------

function createJetBrainsParser(
  source: JetBrainsSessionSource,
  seenKeys: Set<string>
): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const sessionId = source.sessionId

      // Nitrite .db (the store's authoritative session content). Read as latin1
      // so byte offsets are stable through the binary MVStore framing.
      if (source.dbPath) {
        let dbRaw: string | null = null
        try {
          dbRaw = await readSessionFile(source.dbPath, 'latin1')
        } catch {
          dbRaw = null
        }
        if (dbRaw) {
          const storeModel = inferJetBrainsModel(dbRaw)
          const turns = extractJetBrainsDbTurns(dbRaw)
          // Dedup keys derive from the reply CONTENT, not the scan position:
          // copilot is a durable provider (cached turns are never deleted and a
          // re-parse appends any key it hasn't seen), while MVStore compaction
          // can rewrite the file with blobs in a different byte order. With
          // positional keys, a rewrite that puts a new blob ahead of an old one
          // hands the new turn the old turn's key (skipped as seen) and re-emits
          // the old turn under a fresh index — double-billing it. The per-hash
          // counter keeps genuinely repeated replies and errored turns (which
          // share replyText '') distinct within a conversation.
          const perContentIndex = new Map<string, number>()
          for (const turn of turns) {
            // One .db holds many chat tabs; group each turn under its own
            // conversation so the user sees one session per tab, not per file.
            const convId = turn.conversationId || sessionId
            const contentHash = createHash('sha256').update(turn.replyText).digest('hex').slice(0, 12)
            const nth = (perContentIndex.get(`${convId}:${contentHash}`) ?? 0) + 1
            perContentIndex.set(`${convId}:${contentHash}`, nth)
            const dedupKey = `copilot:jb:${convId}:${contentHash}:${nth}`
            if (seenKeys.has(dedupKey)) continue
            seenKeys.add(dedupKey)

            // Prefer the per-turn model, else the store default, else a generic
            // Copilot bucket so a real reply is never mis-priced as free.
            const model = turn.model || storeModel || 'copilot-anthropic-auto'
            // Errored turns (failed generation) contribute no billable output.
            const outputTokens = turn.errored ? 0 : estimateTokens(turn.replyText)
            const costUSD = outputTokens > 0 ? calculateCost(model, 0, outputTokens, 0, 0, 0) : 0
            // Project resolution precedence:
            //   1. projectName — the plugin's own recorded label (1.12+),
            //      joined across kind dirs by store id. Authoritative.
            //   2. the git repo root of a file:// path the chat referenced
            //      (older plugins / when projectName is absent).
            //   3. one honest bucket when neither signal exists.
            // The conversation TITLE is a chat-thread name, NOT a project, and is
            // kept out of `project` (it would otherwise pollute By-Project).
            const project =
              source.projectName || turn.conversationProject || 'copilot-jetbrains'

            yield {
              provider: 'copilot',
              sessionId: convId,
              project,
              model,
              inputTokens: 0,
              outputTokens,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 0,
              cachedInputTokens: 0,
              reasoningTokens: 0,
              webSearchRequests: 0,
              costUSD,
              costIsEstimated: true,
              tools: [],
              bashCommands: [],
              timestamp: source.mtime,
              speed: 'standard' as const,
              deduplicationKey: dedupKey,
              // Surface the chat-thread name here (it is the session's label, not
              // a project) so it remains visible in session-level views.
              userMessage: turn.conversationTitle,
            }
          }
        }
      }

    },
  }
}

// ---------------------------------------------------------------------------
// OTel SQLite parser — reads agent-traces.db for FULL token data
// ---------------------------------------------------------------------------

function createOtelParser(
  source: SessionSource,
  seenKeys: Set<string>
): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      // Lazy-load the SQLite module (same pattern as Cursor/OpenCode providers)
      const { openDatabase } = await import('../sqlite.js')

      // One DB open handles ALL conversations — avoids N opens for N conversations.
      const db = openDatabase(source.path)

      try {
        // ---------------------------------------------------------------
        // Get all distinct conversations in the DB with their project names.
        // ---------------------------------------------------------------
        const conversationRows = db.query<{
          conversation_id: string
          project: string | null
          min_start: number
        }>(
          `SELECT DISTINCT
             sa_conv.value AS conversation_id,
             COALESCE(sa_repo.value, 'copilot-chat') AS project,
             MIN(s.start_time_ms) AS min_start
           FROM spans s
           LEFT JOIN span_attributes sa_conv
             ON s.span_id = sa_conv.span_id AND sa_conv.key = 'gen_ai.conversation.id'
           LEFT JOIN span_attributes sa_repo
             ON s.span_id = sa_repo.span_id AND sa_repo.key = 'github.copilot.git.repository'
           WHERE sa_conv.value IS NOT NULL
           GROUP BY sa_conv.value
           ORDER BY min_start DESC`
        )

        for (const convRow of conversationRows) {
          const conversationId = convRow.conversation_id
          if (!conversationId) continue

          let project = convRow.project ?? 'copilot-chat'
          if (project.includes('/')) {
            project = basename(project.replace(/\.git$/, ''))
          }

          // -----------------------------------------------------------
          // Query all 'chat' spans for this conversation.
          // -----------------------------------------------------------

          const spanIdRows = db.query<{ span_id: string; trace_id: string }>(
            `SELECT DISTINCT s.span_id, s.trace_id
             FROM spans s
             INNER JOIN span_attributes sa 
               ON s.span_id = sa.span_id AND sa.key = 'gen_ai.conversation.id' AND sa.value = ?
             ORDER BY s.start_time_ms ASC`,
            [conversationId]
          )

          // Collect trace IDs and span IDs belonging to this conversation
          const traceIds = new Set<string>()
          for (const row of spanIdRows) {
            traceIds.add(row.trace_id)
          }

          if (traceIds.size === 0) {
            continue
          }

          // Now query all spans within those traces to find chat and tool spans.
          // Pull the metadata columns in the same query so we don't re-query the
          // spans table once per chat span below (avoids an N+1).
          const traceIdArr = [...traceIds]
          const tracePlaceholders = traceIdArr.map(() => '?').join(',')
          const traceSpans = db.query<{
            span_id: string
            trace_id: string
            operation_name: string | null
            start_time_ms: number
            response_model: string | null
          }>(
            `SELECT span_id, trace_id, operation_name, start_time_ms, response_model FROM spans WHERE trace_id IN (${tracePlaceholders})`,
            traceIdArr
          )

          // Collect tool names, shell commands and subagent names from the
          // execute_tool / invoke_agent spans for each trace. These mirror the
          // metadata the JSONL path captures, so the OTel source stays
          // equivalent (tools + bashCommands + subagentTypes are all first-class
          // call metadata per types.ts).
          //
          // Subagent attribution: VS Code records a subagent run as an
          // invoke_agent span carrying copilot_chat.parent_chat_session_id. The
          // root turn agent (gen_ai.agent.name = 'GitHub Copilot Chat') has NO
          // parent session and is intentionally excluded, otherwise it would
          // surface as a bogus 'GitHub Copilot Chat' entry in the agents view.
          // A subagent's invoke_agent span lives in the same trace as that
          // subagent's own chat spans, so attributing the agent name per-trace
          // labels exactly the subagent's calls.
          const toolsByTrace = new Map<string, string[]>()
          const bashByTrace = new Map<string, string[]>()
          const subagentsByTrace = new Map<string, string[]>()
          const chatSpanIds: string[] = []
          const spanMetaById = new Map<string, { trace_id: string; start_time_ms: number; response_model: string | null }>()

          for (const span of traceSpans) {
            const opName = span.operation_name || ''
            spanMetaById.set(span.span_id, span)

            if (opName === 'chat') {
              chatSpanIds.push(span.span_id)
              continue
            }

            if (opName === 'execute_tool') {
              // Load tool name from attributes and normalise to display form
              const attrs = loadSpanAttributesFromTable(db, span.span_id)
              const rawToolName = attrs['gen_ai.tool.name'] as string | undefined
              if (rawToolName) {
                const existing = toolsByTrace.get(span.trace_id) ?? []
                existing.push(normalizeTool(rawToolName))
                toolsByTrace.set(span.trace_id, existing)

                // For shell tools, extract command names via the OTEL-specific
                // normaliser (handles the full multi-line scripts the OTEL store
                // records; see extractOtelBashCommands).
                if (BASH_TOOL_NAMES.has(rawToolName)) {
                  const command = parseToolCommand(attrs['gen_ai.tool.call.arguments'])
                  if (command) {
                    const bash = bashByTrace.get(span.trace_id) ?? []
                    bash.push(...extractOtelBashCommands(command))
                    bashByTrace.set(span.trace_id, bash)
                  }
                }
              }
              continue
            }

            // Genuine subagent invocation: an invoke_agent span with a parent
            // chat session. The root turn agent ('GitHub Copilot Chat') has no
            // parent session and is skipped to avoid a bogus agents-view entry.
            if (opName === 'invoke_agent') {
              const attrs = loadSpanAttributesFromTable(db, span.span_id)
              const parentSession = attrs['copilot_chat.parent_chat_session_id']
              const agentName = attrs['gen_ai.agent.name'] as string | undefined
              if (parentSession && agentName) {
                const subs = subagentsByTrace.get(span.trace_id) ?? []
                subs.push(agentName)
                subagentsByTrace.set(span.trace_id, subs)
              }
            }
          }

          // Yield one ParsedProviderCall per chat span
          for (const spanId of chatSpanIds) {
            const attrs = loadSpanAttributesFromTable(db, spanId)

            const spanMetadata = spanMetaById.get(spanId)
            if (!spanMetadata) continue

            const model =
              (attrs['gen_ai.response.model'] as string | undefined) ??
              (attrs['gen_ai.request.model'] as string | undefined) ??
              spanMetadata.response_model ??
              'unknown'

            const inputTokens = Number(attrs['gen_ai.usage.input_tokens'] ?? 0)
            const outputTokens = Number(attrs['gen_ai.usage.output_tokens'] ?? 0)
            const cacheReadTokens = Number(attrs['gen_ai.usage.cache_read.input_tokens'] ?? 0)
            const cacheCreationTokens = Number(attrs['gen_ai.usage.cache_creation.input_tokens'] ?? 0)

            if (inputTokens === 0 && outputTokens === 0) {
              continue
            }

            // Dedup key uses span_id which is globally unique
            const dedupKey = `copilot-otel:${spanId}`
            if (seenKeys.has(dedupKey)) continue
            seenKeys.add(dedupKey)

            // Also add a JSONL-style dedupKey pattern so that if the same
            // interaction appears in both OTel and JSONL, we don't double-count.
            // We use the turn ID from Copilot attributes if available.
            const turnId = attrs['github.copilot.chat.turn.id'] as string | undefined
            if (turnId) {
              const jsonlDedupKey = `copilot:${conversationId}:${turnId}`
              seenKeys.add(jsonlDedupKey)
            }

            const tools = toolsByTrace.get(spanMetadata.trace_id) ?? []
            const bashCommands = bashByTrace.get(spanMetadata.trace_id) ?? []
            const subagentTypes = subagentsByTrace.get(spanMetadata.trace_id)
            const timestamp = epochToISO(spanMetadata.start_time_ms)

            // calculateCost with FULL token data — this is the key improvement.
            const costUSD = calculateCost(
              model,
              inputTokens,
              outputTokens,
              cacheCreationTokens,
              cacheReadTokens,
              0 // webSearchRequests — not applicable to OTel spans
            )

            yield {
              provider: 'copilot',
              sessionId: conversationId,
              project,
              model,
              inputTokens,
              outputTokens,
              cacheCreationInputTokens: cacheCreationTokens,
              cacheReadInputTokens: cacheReadTokens,
              cachedInputTokens: 0,
              reasoningTokens: 0,
              webSearchRequests: 0,
              costUSD,
              tools,
              bashCommands,
              subagentTypes: subagentTypes && subagentTypes.length > 0 ? subagentTypes : undefined,
              timestamp,
              speed: 'standard' as const,
              deduplicationKey: dedupKey,
              userMessage: '', // Not available in OTel spans by default
            }
          }
        }
      } finally {
        db.close()
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Session-store SQLite parser — per-request usage rows from session-store.db
// ---------------------------------------------------------------------------
//
// The Copilot CLI and the GitHub Copilot desktop app both write
// ~/.copilot/session-store.db unconditionally. Its assistant_usage_events
// table records one row per API request AS IT HAPPENS, where the
// session.shutdown rollup in events.jsonl is written only on clean shutdown
// (a crash loses the whole session's input/cache accounting) and lumps a
// session leg into one per-model total. The DB rows are therefore
// authoritative for input/cache tokens; the serve-time reconciliation in
// parseProviderSources replaces the covered (session, model) rollup calls
// with the rows plus a residual for anything the rollup carried beyond them.
//
// The emitted calls mirror the shutdown-call contract exactly: input/cache/
// reasoning only, output 0 — per-turn output (and its tools/userMessage
// metadata) stays owned by the events.jsonl assistant.message calls, so
// emitting output here would double-count it. The ONE exception is the
// `initiator='compaction'` row: that request is the CLI summarizing its own
// context, it has no assistant.message anywhere in events.jsonl, and nothing
// else in the journal carries its output — so leaving it at 0 simply loses
// those tokens (measured: a matched 30-session corpus reconciled to the
// store's own row totals within -3,085 tokens, exactly one compaction row's
// output). It is counted here because here is the only place it exists.
// The per-request billing
// metadata (total_nano_aiu, request_multiplier) is captured onto the cached
// calls but not priced or displayed — that design is upstream #890; the
// throughput/latency columns are deliberately not read yet.

// The one REQUIRED usage query, shared verbatim between the discovery probe
// and the parser so the two can never diverge on schema: discovery runs it
// LIMIT 1 (prepare validates every table and column it touches) before
// emitting the source, so a store whose shape the parser cannot read is
// classified absent — its sessions keep their shutdown rollups — instead of
// surfacing a source that could only ever fail.
const SESSION_STORE_USAGE_COLUMNS = `e.id, e.session_id, e.model,
       e.input_tokens, e.cache_read_tokens, e.cache_write_tokens,
       e.reasoning_tokens, e.created_at,
       s.cwd, s.repository, s.created_at AS session_created_at`
const SESSION_STORE_USAGE_FROM = `
  FROM assistant_usage_events e
  LEFT JOIN sessions s ON s.id = e.session_id`
const SESSION_STORE_USAGE_SELECT = `SELECT ${SESSION_STORE_USAGE_COLUMNS}${SESSION_STORE_USAGE_FROM}`

// OPTIONAL enrichment: the billing-metadata columns plus `initiator`, tried
// first at parse time and never probed at discovery — older CLI stores predate
// them, and requiring them would classify a perfectly readable store as
// absent. A `no such column` failure falls back to the base select above, so
// an old store parses identically, just without the enrichment.
//
// `initiator` names what caused the request. The one value that changes
// accounting is 'compaction': that row is the CLI summarizing its own context,
// not a user turn, so it has no assistant.message to pair with and it belongs
// to the compaction that resets the shutdown rollup. It is optional in the
// strongest sense — on a real 2,509-row store 1,504 rows carried NULL here
// (the column exists, the CLI just did not always populate it), so every rule
// below prefers the label when present and falls back to the timestamp
// geometry when it is not.
// Widest first, then narrower, then the discovery-validated base. Each step
// drops the newest optional column, so a store that has the billing columns
// but not `initiator` keeps its billing metadata instead of falling all the
// way back — the columns arrived in different CLI releases and a single
// all-or-nothing enrichment would lose the older one.
//
// `output_tokens` rides on the SAME rung as `initiator` deliberately: it is
// only ever read for a row the label identifies as a compaction, so a store
// too old to have the label has no use for it either and must not be pushed
// down another fallback rung for it.
const SESSION_STORE_USAGE_SELECTS = [
  `SELECT ${SESSION_STORE_USAGE_COLUMNS},
       e.total_nano_aiu, e.request_multiplier, e.initiator, e.output_tokens${SESSION_STORE_USAGE_FROM}`,
  `SELECT ${SESSION_STORE_USAGE_COLUMNS},
       e.total_nano_aiu, e.request_multiplier${SESSION_STORE_USAGE_FROM}`,
  SESSION_STORE_USAGE_SELECT,
]

// Type alias, not interface: db.query's Row constraint needs the implicit
// index signature only anonymous object types carry.
type SessionStoreUsageRow = {
  id: number
  session_id: string
  model: string
  input_tokens: number | null
  cache_read_tokens: number | null
  cache_write_tokens: number | null
  reasoning_tokens: number | null
  created_at: string | null
  cwd: string | null
  repository: string | null
  session_created_at: string | null
  // Present only when the billing select succeeded (schema has the columns).
  total_nano_aiu?: number | null
  request_multiplier?: number | null
  initiator?: string | null
  output_tokens?: number | null
}

// FNV-1a 64-bit over the row's identifying content, base36. Collisions only
// matter between two rows sharing the SAME session_id and row id — i.e. a
// same-path DB reset that happens to reuse an id — where the content strings
// differ; 64 bits keeps even adversarial token tuples from aliasing (32-bit
// FNV collisions between plausible tuples are constructible).
function fnv1a64(s: string): string {
  let h = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i))
    h = (h * prime) & mask
  }
  return h.toString(36)
}

function createSessionStoreParser(
  source: SessionStoreSessionSource,
  seenKeys: Set<string>
): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      // Lazy-load the SQLite module (same pattern as the OTel source)
      const { openDatabase, isSqliteBusyError } = await import('../sqlite.js')

      // The open sits inside the same classify-and-defer boundary as the
      // query: discovery validated this store moments ago, so a failure HERE
      // (EACCES/CANTOPEN/EMFILE race) is transient-shaped — letting it
      // propagate raw would cache a failed marker at the current fingerprint
      // and zero the covered sessions until the file next changes.
      let db: ReturnType<typeof openDatabase>
      try {
        db = openDatabase(source.path)
      } catch (err) {
        if (isSqliteBusyError(err)) throw err
        throw Object.assign(
          new Error('copilot session-store.db unreadable at open; deferring'),
          { code: 'SQLITE_BUSY' }
        )
      }
      try {
        let rows: SessionStoreUsageRow[] | undefined
        try {
          for (const select of SESSION_STORE_USAGE_SELECTS) {
            try {
              rows = db.query<SessionStoreUsageRow>(`${select} ORDER BY e.id ASC`)
              break
            } catch (selectErr) {
              // Only an OPTIONAL column may be missing (older store schema):
              // step down to the next narrower select. The last entry is the
              // discovery-validated base, so a `no such column` there is a
              // real shape change and re-throws with everything else.
              const msg = selectErr instanceof Error ? selectErr.message : String(selectErr)
              if (!/no such column/i.test(msg) || select === SESSION_STORE_USAGE_SELECT) throw selectErr
            }
          }
          if (!rows) throw new Error('copilot session-store.db: no usable select')
        } catch (err) {
          // Discovery prepare-validated this exact query moments ago, so any
          // failure here means the store became unreadable or changed shape
          // mid-run. Yielding nothing would cache an EMPTY success at this
          // fingerprint while the covered sessions' rollups stay suppressed
          // — a silent under-count that persists until the file changes.
          // Every failure defers instead: parseProviderSources
          // skips-and-retries on the busy shape without writing the cache.
          if (isSqliteBusyError(err)) throw err
          throw Object.assign(
            new Error('copilot session-store.db unreadable mid-parse; deferring'),
            { code: 'SQLITE_BUSY' }
          )
        }

        // created_at defaults to SQLite's datetime('now') — UTC but
        // timezone-less ('2026-08-07 17:56:38', or with fractional seconds
        // under 'subsec'), which Date.parse reads as LOCAL time and would
        // shift the request onto the wrong day. The CLI writes explicit
        // ISO-Z strings (audited: every observed row), so this normalizes
        // only the defensive zoneless shapes to UTC; anything carrying its
        // own zone/offset passes through untouched.
        const normalizeTimestamp = (raw: string | null): string =>
          raw
            ? timestampToISO(
                /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(raw)
                  ? raw.replace(' ', 'T') + 'Z'
                  : raw
              )
            : ''
        let prevTimestamp = ''

        for (const row of rows) {
          if (!row.session_id) continue

          // A call with an empty timestamp is invisible to every date-range
          // filter, so never emit one: fall back from the row's own
          // created_at to the previous row's timestamp, then to the
          // session's created_at. The previous row deliberately outranks the
          // session's own created_at even across sessions — ids are GLOBALLY
          // insertion-ordered, so the previous row is the nearest earlier
          // clock reading, while a resumed session's created_at can be days
          // stale. Both columns carry SQLite defaults, so an empty chain is
          // unreachable outside a hand-built store; such a row is skipped,
          // and if that desert covers a whole session its rollup simply
          // stays unsuppressed at serve time.
          const timestamp =
            normalizeTimestamp(row.created_at) ||
            prevTimestamp ||
            normalizeTimestamp(row.session_created_at)
          if (!timestamp) continue
          prevTimestamp = timestamp
          // TEXT NOT NULL still admits '': a billable row must NEVER be
          // dropped for an unnameable model — its session's rollup was
          // suppressed on the promise that every billable row is emitted
          // (the coverage predicate does not know about models). Price as
          // 'unknown' instead; the pricing engine reports unknown models at
          // $0 with a fix-it hint rather than silently losing the tokens.
          const model = row.model || 'unknown'

          const cacheReadTokens = numberOrZero(row.cache_read_tokens)
          const cacheWriteTokens = numberOrZero(row.cache_write_tokens)
          const reasoningTokens = numberOrZero(row.reasoning_tokens)
          // input_tokens is cache-INCLUSIVE (input + cache_read + cache_write),
          // the same convention the shutdown rollup uses — confirmed against
          // token_details_json, whose tokenType:"input" entries hold exactly
          // this difference. calculateCost expects the uncached remainder with
          // cache tokens billed separately, so subtract; clamp guards a future
          // schema that reports input non-inclusively.
          const inputTokens = Math.max(
            0,
            numberOrZero(row.input_tokens) - cacheReadTokens - cacheWriteTokens
          )

          // A compaction row's output has no assistant.message to own it, so
          // this row is the only place it can be counted. Every other row's
          // output IS owned by a per-turn call and stays excluded here.
          const outputTokens = row.initiator === 'compaction' ? numberOrZero(row.output_tokens) : 0

          // Nothing this call would add over the per-turn events, so skip it to
          // avoid an empty $0 row.
          if (inputTokens === 0 && cacheReadTokens === 0 && cacheWriteTokens === 0 && reasoningTokens === 0 && outputTokens === 0) continue

          // `id` is AUTOINCREMENT: stable across re-parses and never reused
          // WITHIN one database lifetime — but recreating the DB at the same
          // path restarts the sequence, and a bare `<sid>:<id>` key would then
          // make the durable union swallow the new row as "already cached"
          // while its usage differs. A content discriminator (raw created_at
          // + token counts + model) makes a genuinely different request under
          // a reused id a NEW key; a byte-identical re-insert (backup restore,
          // VACUUM INTO) still collapses to the same key.
          const dedupKey = `copilot-store:${row.session_id}:${row.id}:${fnv1a64(
            `${row.created_at ?? ''}|${row.input_tokens ?? ''}|${row.cache_read_tokens ?? ''}|${row.cache_write_tokens ?? ''}|${row.reasoning_tokens ?? ''}|${row.model}`
          )}`
          if (seenKeys.has(dedupKey)) continue
          seenKeys.add(dedupKey)

          // One DB spans every project, so the project must ride each call
          // (the per-source fallback would lump them all together). Prefer
          // the label discovery derived from the session's own session-state
          // dir (workspace.yaml cwd — the same one its per-turn output calls
          // carry, so the session never splits across two projects); the
          // store's sessions.cwd/repository names only sessions with no
          // session-state dir on this machine.
          const project =
            source.projectsBySessionId?.get(row.session_id) ??
            (row.cwd
              ? basename(row.cwd)
              : row.repository
                ? basename(row.repository.replace(/\.git$/, ''))
                : row.session_id)

          // Tokens are real per-request counts written by the CLI, so this
          // cost is measured, not char-estimated. reasoning_tokens rides as
          // metadata only, never as a cost line: it is a SUBSET of the row's
          // output_tokens (the row's own token_details_json prices exactly
          // input/cache_read/cache_write/output, no reasoning entry), and
          // output — reasoning included — is billed by the per-turn
          // assistant.message call. Pricing reasoning here would double-count.
          // `outputTokens` is non-zero only for the compaction row, whose
          // output no per-turn call bills, so it is priced exactly once.
          const costUSD = calculateCost(model, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, 0)

          yield {
            provider: 'copilot',
            sessionId: row.session_id,
            project,
            model,
            inputTokens,
            outputTokens,
            cacheCreationInputTokens: cacheWriteTokens,
            cacheReadInputTokens: cacheReadTokens,
            cachedInputTokens: 0,
            reasoningTokens,
            webSearchRequests: 0,
            costUSD,
            costIsEstimated: false,
            tools: [],
            bashCommands: [],
            timestamp,
            speed: 'standard' as const,
            deduplicationKey: dedupKey,
            userMessage: '',
            // Billing metadata rides as capture-only fields (deliberately
            // OUTSIDE the dedup-key content hash: it identifies a charge, not
            // the request). Omitted when the schema predates the columns.
            ...(typeof row.total_nano_aiu === 'number' ? { nanoAiu: row.total_nano_aiu } : {}),
            ...(typeof row.request_multiplier === 'number' ? { requestMultiplier: row.request_multiplier } : {}),
            ...(row.initiator ? { initiator: row.initiator } : {}),
          }
        }
      } finally {
        db.close()
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Extended SessionSource for OTel sessions
// ---------------------------------------------------------------------------

interface OTelSessionSource extends SessionSource {
  conversationId?: string
  sourceType: 'otel'
}

interface JsonlSessionSource extends SessionSource {
  sourceType: 'jsonl'
}

// The Copilot CLI / GitHub desktop-app session store (~/.copilot/session-store.db).
// One source per DB file; the parser iterates every session's usage rows in a
// single DB open, mirroring the OTel source.
interface SessionStoreSessionSource extends SessionSource {
  sourceType: 'session-store'
  // sessionId → project label derived from the session-state dirs
  // (workspace.yaml cwd), attached at discovery. The store's own
  // sessions.cwd can lag or miss what the session actually ran in, and the
  // per-turn output calls already carry the jsonl-derived label — using the
  // same one keeps a session's store rows and output calls in one session.
  projectsBySessionId?: Map<string, string>
}

// A VS Code workspaceStorage transcript. Distinct from 'jsonl' (CLI
// session-state) so classification rides provenance, not file contents (#944).
interface TranscriptSessionSource extends SessionSource {
  sourceType: 'transcript'
}

interface ChatSessionSource extends SessionSource {
  // Optional so legacy `.json` session sources (which route through
  // createJsonlParser instead) can share this array type without lying.
  sourceType?: 'chatsession'
}

interface JetBrainsSessionSource extends SessionSource {
  sourceType: 'jetbrains'
  // Fallback conversation id for turns whose own GUID can't be recovered (the
  // on-disk store dir name). Normally each turn is grouped by its own tab GUID.
  sessionId: string
  // On-disk store directory name — the join key for the projectName lookup
  // across sibling kind dirs (chat-sessions / chat-edit-sessions).
  storeId: string
  // Nitrite .db (copilot-*-nitrite.db) — the store's session content.
  dbPath: string
  // File mtime (ISO). The store has no reliable per-turn timestamp, so this
  // places every turn on a day — without it, calls fall outside date ranges.
  mtime: string
  // Plugin-recorded project label (JetBrains Copilot 1.12+), resolved across
  // all kind dirs by store id. The billable turns live in chat-agent-sessions,
  // but the projectName field is usually written only into the sibling
  // chat-sessions / chat-edit-sessions store, so discovery joins them by id.
  // Undefined for older plugins that don't record it.
  projectName?: string
}

function isOtelSource(source: SessionSource): source is OTelSessionSource {
  return (source as OTelSessionSource).sourceType === 'otel'
}

function isChatSessionSource(source: SessionSource): source is ChatSessionSource {
  return (source as ChatSessionSource).sourceType === 'chatsession'
}

function isJetBrainsSource(source: SessionSource): source is JetBrainsSessionSource {
  return (source as JetBrainsSessionSource).sourceType === 'jetbrains'
}

function isTranscriptSource(source: SessionSource): source is TranscriptSessionSource {
  return (source as TranscriptSessionSource).sourceType === 'transcript'
}

function isSessionStoreSource(source: SessionSource): source is SessionStoreSessionSource {
  return (source as SessionStoreSessionSource).sourceType === 'session-store'
}

// ---------------------------------------------------------------------------
// Session discovery: JSONL (original)
// ---------------------------------------------------------------------------

async function discoverJsonlSessions(
  sessionStateDir: string
): Promise<JsonlSessionSource[]> {
  const sources: JsonlSessionSource[] = []

  let sessionDirs: string[]
  try {
    sessionDirs = await readdir(sessionStateDir)
  } catch {
    return sources
  }

  for (const sessionId of sessionDirs) {
    const eventsPath = join(sessionStateDir, sessionId, 'events.jsonl')
    const s = await stat(eventsPath).catch(() => null)
    if (!s?.isFile()) continue

    let project = sessionId
    try {
      const yaml = await readSessionFile(
        join(sessionStateDir, sessionId, 'workspace.yaml')
      )
      const cwd = parseCwd(yaml ?? '')
      if (cwd) project = basename(cwd)
    } catch {
      // workspace.yaml may not exist
    }

    sources.push({
      path: eventsPath,
      project,
      provider: 'copilot',
      sourceType: 'jsonl',
    })
  }

  return sources
}

// ---------------------------------------------------------------------------
// Session discovery: OTel SQLite
// ---------------------------------------------------------------------------

async function discoverOtelSessions(
  dbPath: string
): Promise<OTelSessionSource[]> {
  // Verify the DB file exists. Return one source per DB file; the parser
  // opens the DB once and iterates all conversations in a single DB open,
  // which is far more efficient than one source (and one DB open) per conversation.
  try {
    await stat(dbPath)
  } catch {
    return []
  }
  return [{ path: dbPath, project: 'copilot-chat', provider: 'copilot', sourceType: 'otel' }]
}

// ---------------------------------------------------------------------------
// Session discovery: session-store SQLite
// ---------------------------------------------------------------------------

/**
 * Probe session-store.db. This decides only whether a store SOURCE exists;
 * which sessions it covers is decided at serve time from what its parse
 * actually cached (see reconcileCopilotCalls in parseProviderSources), so
 * nothing a writer does between this probe and the parse can change
 * accounting.
 *
 * Permanent absence — no file, no sqlite driver, or a schema the parser's
 * own query cannot prepare against ("no such table": CLI builds before the
 * store existed; "no such column": a future migration) — returns null: no
 * source, no suppression, and the shutdown-rollup path carries the sessions
 * exactly as before.
 *
 * EVERY other failure still emits the source. Measured against the real
 * driver (node:sqlite, WAL store): a write lock never blocks readers and a
 * hot -wal without its -shm reads fine, so the reachable failures here are
 * corruption-class — SQLITE_CORRUPT (11), SQLITE_NOTADB (26, e.g. mid
 * atomic-replace), SQLITE_CANTOPEN (14, deleted after the stat) — plus the
 * classic busy/locked pair and stat-level EACCES/EIO. None of those prove
 * the store is gone, so the path must stay discovered: the parse raises the
 * busy shape parseProviderSources skips-and-retries, previously cached rows
 * keep serving, and serve-time suppression keeps holding from the cache
 * instead of flapping the covered sessions' rollups back in.
 */
async function discoverSessionStoreSource(
  dbPath: string
): Promise<SessionStoreSessionSource | null> {
  const source: SessionStoreSessionSource = {
    path: dbPath,
    project: 'copilot',
    provider: 'copilot',
    sourceType: 'session-store',
    // The store IS the durable record: while it sits on disk, its cached rows
    // must never age out (crash-only rows have no rollup to fall back to).
    // Journal-style sources keep the ordinary durable age-out.
    retainWhilePresent: true,
  }
  try {
    await stat(dbPath)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? null : source
  }
  const { openDatabase, isSqliteAvailable } = await import('../sqlite.js')
  if (!isSqliteAvailable()) return null
  try {
    const db = openDatabase(dbPath)
    try {
      db.query(`${SESSION_STORE_USAGE_SELECT} LIMIT 1`)
    } finally {
      db.close()
    }
    return source
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return /no such (table|column)/i.test(message) ? null : source
  }
}

// ---------------------------------------------------------------------------
// Session discovery: JetBrains (IntelliJ IDEA, PyCharm, …)
// ---------------------------------------------------------------------------

// The three JetBrains Copilot session kinds (agent / ask / edit mode). Each
// store directory holds a Nitrite .db with that kind's session content.
const JETBRAINS_SESSION_KINDS = ['chat-agent-sessions', 'chat-sessions', 'chat-edit-sessions']

// Candidate Nitrite .db filenames per kind, plus a generic fallback.
const JETBRAINS_DB_NAMES: Record<string, string> = {
  'chat-agent-sessions': 'copilot-agent-sessions-nitrite.db',
  'chat-sessions': 'copilot-chat-nitrite.db',
  'chat-edit-sessions': 'copilot-edit-sessions-nitrite.db',
}

/** Locate the Nitrite .db in a store dir (known name, else any *-nitrite.db). */
async function findNitriteDbPath(storeDir: string, kind: string): Promise<string | null> {
  const known = JETBRAINS_DB_NAMES[kind]
  if (known) {
    const p = join(storeDir, known)
    if ((await stat(p).catch(() => null))?.isFile()) return p
  }
  let files: string[]
  try {
    files = await readdir(storeDir)
  } catch {
    return null
  }
  const db = files.find((f) => f.endsWith('-nitrite.db'))
  return db ? join(storeDir, db) : null
}

/**
 * Discover JetBrains Copilot sessions under the github-copilot config root.
 *
 * Layout: <root>/<ide>/<kind>/<storeId>/copilot-*-nitrite.db
 *   <ide>  — per-IDE dir (iu, intellij, PyCharm2025.2, …)
 *   <kind> — one of JETBRAINS_SESSION_KINDS
 *
 * Emits one source per store directory that has a Nitrite .db. The store
 * records no token counts, so the parser estimates output tokens from the
 * assistant reply text (see createJetBrainsParser).
 */
async function discoverJetBrainsSessions(
  root: string
): Promise<JetBrainsSessionSource[]> {
  const sources: JetBrainsSessionSource[] = []

  let ideDirs: string[]
  try {
    ideDirs = await readdir(root)
  } catch {
    return sources
  }

  for (const ide of ideDirs) {
    for (const kind of JETBRAINS_SESSION_KINDS) {
      const kindDir = join(root, ide, kind)
      let storeDirs: string[]
      try {
        storeDirs = await readdir(kindDir)
      } catch {
        continue // this IDE doesn't have this session kind
      }

      for (const storeId of storeDirs) {
        const storeDir = join(kindDir, storeId)
        const dbPath = await findNitriteDbPath(storeDir, kind)
        if (!dbPath) continue

        const dbStat = await stat(dbPath).catch(() => null)
        const mtime = (dbStat?.mtime ?? new Date(0)).toISOString()

        sources.push({
          path: dbPath,
          project: 'copilot-jetbrains',
          provider: 'copilot',
          sourceType: 'jetbrains',
          sessionId: storeId,
          storeId,
          dbPath,
          mtime,
        })
      }
    }
  }

  // Join projectName across kinds by store id. The plugin records the label on
  // the session doc, which usually lands in the chat-sessions/chat-edit-sessions
  // store — NOT the chat-agent-sessions store where the billable turns live.
  // Without this join, every current agent session falls to the generic bucket
  // even though its repo name is sitting one store dir over.
  await resolveJetBrainsProjectNames(sources)

  return sources
}

/**
 * Populate each source's `projectName` from whichever store dir (of the same
 * store id) actually recorded it. Reads each source's .db once; a store whose
 * own .db lacks the field inherits it from a sibling-kind store with the same
 * id. Best-effort — read/parse failures leave projectName undefined.
 */
async function resolveJetBrainsProjectNames(
  sources: JetBrainsSessionSource[]
): Promise<void> {
  const byStore = new Map<string, string>()
  for (const src of sources) {
    // Already found this store's name via a sibling-kind source — skip the read.
    if (!src.dbPath || byStore.has(src.storeId)) continue
    let raw: string | null = null
    try {
      raw = await readSessionFile(src.dbPath, 'latin1')
    } catch {
      raw = null
    }
    if (!raw) continue
    const name = extractJetBrainsProjectName(raw)
    if (name) byStore.set(src.storeId, name)
  }
  for (const src of sources) {
    const name = byStore.get(src.storeId)
    if (name) src.projectName = name
  }
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

/**
 * Returns the VS Code workspaceStorage directories for all VS Code variants
 * (Code, Code Insiders, VSCodium) on the given platform. Used to discover
 * transcript sessions written by the Copilot Chat extension.
 *
 * Accepts explicit `home` and `os` arguments so callers (and tests) can pass
 * custom values without relying on process-level globals.
 */
export function getVSCodeWorkspaceStorageDirs(home: string, os: string): string[] {
  const j = os === 'win32' ? win32.join : posix.join
  if (os === 'darwin') {
    return [
      j(home, 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage'),
      j(home, 'Library', 'Application Support', 'Code - Insiders', 'User', 'workspaceStorage'),
      j(home, 'Library', 'Application Support', 'VSCodium', 'User', 'workspaceStorage'),
    ]
  }
  if (os === 'linux') {
    return [
      j(home, '.config', 'Code', 'User', 'workspaceStorage'),
      j(home, '.config', 'Code - Insiders', 'User', 'workspaceStorage'),
      j(home, '.config', 'VSCodium', 'User', 'workspaceStorage'),
    ]
  }
  // win32
  return [
    j(home, 'AppData', 'Roaming', 'Code', 'User', 'workspaceStorage'),
    j(home, 'AppData', 'Roaming', 'Code - Insiders', 'User', 'workspaceStorage'),
    j(home, 'AppData', 'Roaming', 'VSCodium', 'User', 'workspaceStorage'),
  ]
}

export function getVSCodeGlobalStorageDirs(home: string, os: string): string[] {
  const j = os === 'win32' ? win32.join : posix.join
  if (os === 'darwin') {
    return [
      j(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage'),
      j(home, 'Library', 'Application Support', 'Code - Insiders', 'User', 'globalStorage'),
      j(home, 'Library', 'Application Support', 'VSCodium', 'User', 'globalStorage'),
    ]
  }
  if (os === 'linux') {
    return [
      j(home, '.config', 'Code', 'User', 'globalStorage'),
      j(home, '.config', 'Code - Insiders', 'User', 'globalStorage'),
      j(home, '.config', 'VSCodium', 'User', 'globalStorage'),
    ]
  }
  return [
    j(home, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage'),
    j(home, 'AppData', 'Roaming', 'Code - Insiders', 'User', 'globalStorage'),
    j(home, 'AppData', 'Roaming', 'VSCodium', 'User', 'globalStorage'),
  ]
}

async function resolveWorkspaceProject(wsDir: string, hashDir: string): Promise<string> {
  let project = hashDir
  try {
    const wsJson = await readSessionFile(join(wsDir, hashDir, 'workspace.json'))
    if (wsJson) {
      const data = JSON.parse(wsJson) as { folder?: string }
      if (typeof data.folder === 'string') {
        // folder is a URI like 'file:///home/user/myapp' or 'file:///C:/Users/...'
        const folder = data.folder.replace(/^file:\/\//, '').replace(/\/+$/, '')
        const name = basename(folder)
        if (name) project = name
      }
    }
  } catch {
    // workspace.json may be absent or malformed
  }
  return project
}

async function hasChatSessionFiles(chatSessionsDir: string): Promise<boolean> {
  let files: string[]
  try {
    files = await readdir(chatSessionsDir)
  } catch {
    return false
  }

  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue
    const s = await stat(join(chatSessionsDir, file)).catch(() => null)
    if (s?.isFile()) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Session discovery: VS Code core chatSessions
// ---------------------------------------------------------------------------

async function discoverWorkspaceChatSessions(
  workspaceStorageDirs: string[]
): Promise<ChatSessionSource[]> {
  const sources: ChatSessionSource[] = []

  for (const wsDir of workspaceStorageDirs) {
    let hashDirs: string[]
    try {
      hashDirs = await readdir(wsDir)
    } catch {
      continue
    }

    for (const hashDir of hashDirs) {
      const candidates = [
        join(wsDir, hashDir, 'chatSessions'),
        join(wsDir, hashDir, 'GitHub.copilot-chat', 'chatSessions'),
        join(wsDir, hashDir, 'github.copilot-chat', 'chatSessions'),
        join(wsDir, hashDir, 'GitHub.copilot', 'chatSessions'),
        join(wsDir, hashDir, 'github.copilot', 'chatSessions'),
      ]

      let project: string | undefined

      for (const chatSessionsDir of candidates) {
        if (!existsSync(chatSessionsDir)) continue
        let files: string[]
        try {
          files = await readdir(chatSessionsDir)
        } catch {
          continue
        }

        if (project === undefined) {
          project = await resolveWorkspaceProject(wsDir, hashDir)
        }

        for (const file of files) {
          if (!file.endsWith('.json') && !file.endsWith('.jsonl')) continue
          const path = join(chatSessionsDir, file)
          const s = await stat(path).catch(() => null)
          if (!s?.isFile()) continue
          if (file.endsWith('.jsonl')) {
            sources.push({
              path,
              project,
              provider: 'copilot',
              sourceType: 'chatsession',
            })
          } else {
            sources.push({
              path,
              project,
              provider: 'copilot',
            })
          }
        }
      }
    }
  }

  return sources
}

async function discoverEmptyWindowChatSessions(
  globalStorageDirs: string[]
): Promise<ChatSessionSource[]> {
  const sources: ChatSessionSource[] = []

  for (const globalDir of globalStorageDirs) {
    const chatSessionsDir = join(globalDir, 'emptyWindowChatSessions')
    let files: string[]
    try {
      files = await readdir(chatSessionsDir)
    } catch {
      continue
    }

    for (const file of files) {
      if (!file.endsWith('.json') && !file.endsWith('.jsonl')) continue
      const path = join(chatSessionsDir, file)
      const s = await stat(path).catch(() => null)
      if (!s?.isFile()) continue
      if (file.endsWith('.jsonl')) {
        sources.push({
          path,
          project: 'copilot-chat',
          provider: 'copilot',
          sourceType: 'chatsession',
        })
      } else {
        sources.push({
          path,
          project: 'copilot-chat',
          provider: 'copilot',
        })
      }
    }
  }

  return sources
}

// ---------------------------------------------------------------------------
// Session discovery: VS Code workspace transcripts
// ---------------------------------------------------------------------------

/**
 * Discover Copilot Chat transcript sessions stored in VS Code workspaceStorage.
 * Structure: {wsDir}/{hash}/GitHub.copilot-chat/transcripts/{session}.jsonl
 * Project is read from {wsDir}/{hash}/workspace.json (folder URI).
 */
async function discoverTranscriptSessions(
  workspaceStorageDirs: string[]
): Promise<TranscriptSessionSource[]> {
  const sources: TranscriptSessionSource[] = []

  for (const wsDir of workspaceStorageDirs) {
    let hashDirs: string[]
    try {
      hashDirs = await readdir(wsDir)
    } catch {
      continue
    }

    for (const hashDir of hashDirs) {
      const chatSessionsDir = join(wsDir, hashDir, 'chatSessions')
      if (await hasChatSessionFiles(chatSessionsDir)) continue

      const transcriptsDir = join(wsDir, hashDir, 'GitHub.copilot-chat', 'transcripts')
      const project = await resolveWorkspaceProject(wsDir, hashDir)

      let transcriptFiles: string[]
      try {
        transcriptFiles = await readdir(transcriptsDir)
      } catch {
        continue
      }

      for (const file of transcriptFiles) {
        if (!file.endsWith('.jsonl')) continue
        const s = await stat(join(transcriptsDir, file)).catch(() => null)
        if (!s?.isFile()) continue
        sources.push({
          path: join(transcriptsDir, file),
          project,
          provider: 'copilot',
          sourceType: 'transcript',
        })
      }
    }
  }

  return sources
}

export function createCopilotProvider(
  sessionStateDir?: string,
  workspaceStorageDir?: string,
  globalStorageDir?: string,
  jetbrainsDir?: string,
  sessionStoreDb?: string
): Provider {
  // jsonlDir is resolved lazily inside discoverSessions so that env-var
  // overrides set after module load (e.g. in tests) are respected.

  /**
   * Returns the workspaceStorage directories to scan for transcript sessions.
   * When workspaceStorageDir is explicitly provided (e.g. in tests), that single
   * directory is used. The CODEBURN_COPILOT_WS_STORAGE_DIR env var provides a
   * single-dir override (useful for tests). Otherwise all platform-default VS
   * Code variant paths are returned.
   */
  function getWsDirs(): string[] {
    if (workspaceStorageDir !== undefined) return [workspaceStorageDir]
    const envDir = process.env['CODEBURN_COPILOT_WS_STORAGE_DIR']
    if (envDir) return [envDir]
    return getVSCodeWorkspaceStorageDirs(homedir(), platform())
  }

  function getGlobalDirs(): string[] {
    if (globalStorageDir !== undefined) return [globalStorageDir]
    const envDir = process.env['CODEBURN_COPILOT_GLOBAL_STORAGE_DIR']
    if (envDir) return [envDir]
    return getVSCodeGlobalStorageDirs(homedir(), platform())
  }

  return {
    name: 'copilot',
    displayName: 'Copilot',
    durableSources: true,

    // Every directory discovery scans, resolved the same way. Besides the
    // doctor, a resident process's root watchers are built from these — a
    // provider without them is silently invisible to the validated-reuse
    // "clean" verdict, which would let a memoized complete parse outlive a
    // store append + lock that a fresh parse would have deferred on. The
    // store DB contributes its PARENT directory, not the file: SQLite appends
    // land in -wal/-shm siblings a file watch would miss.
    async probeRoots(): Promise<ProbeRoot[]> {
      const roots = new Map<string, ProbeRoot>()
      const add = (path: string | null, label: string): void => {
        if (path && !roots.has(path)) roots.set(path, { path, label })
      }
      add(dirname(getSessionStoreDbPath(sessionStoreDb)), 'session store')
      add(getCopilotSessionStateDir(sessionStateDir), 'CLI session state')
      for (const dir of getWsDirs()) add(dir, 'VS Code workspaceStorage')
      for (const dir of getGlobalDirs()) add(dir, 'VS Code globalStorage')
      add(getJetBrainsCopilotRoot(jetbrainsDir), 'JetBrains')
      const otelDb = getAgentTracesDbPath()
      if (otelDb) add(dirname(otelDb), 'OTel agent traces')
      return [...roots.values()]
    },

    modelDisplayName(model: string): string {
      return getShortModelName(model)
    },

    toolDisplayName(rawTool: string): string {
      return normalizeTool(rawTool)
    },

    async discoverSessions(): Promise<SessionSource[]> {
      const sources: SessionSource[] = []
      let discoveredOtel = false

      // 1. Discover OTel sessions (preferred — full token data)
      const disableOtel = process.env['CODEBURN_COPILOT_DISABLE_OTEL'] === '1'
      if (!disableOtel) {
        const dbPath = getAgentTracesDbPath()
        if (dbPath) {
          try {
            const otelSources = await discoverOtelSessions(dbPath)
            discoveredOtel = otelSources.length > 0
            sources.push(...otelSources)
          } catch {
            // OTel discovery failed — fall through to JSONL
          }
        }
      }

      // 1b. Discover the CLI / GitHub desktop-app session store. Written per
      // API request (crash-proof) where the events.jsonl shutdown rollup
      // exists only after a clean exit, so its rows are authoritative for
      // input/cache tokens; the serve-time reconciliation
      // (reconcileCopilotCalls in parseProviderSources) replaces the covered
      // (session, model) rollups with the served rows plus a residual. True
      // absence (older CLI schema, no sqlite driver) leaves the rollup path
      // untouched; an unreadable store still surfaces the source so its
      // parse defers and cached rows keep serving (see
      // discoverSessionStoreSource).
      let storeSource: SessionStoreSessionSource | null = null
      try {
        storeSource = await discoverSessionStoreSource(getSessionStoreDbPath(sessionStoreDb))
      } catch {
        // Unreachable in practice (the probe catches its own errors): a
        // throw here means the sqlite module itself is unusable, and
        // rollup-only accounting is then the correct mode — the same
        // fallback as a missing driver.
        storeSource = null
      }
      if (storeSource) sources.push(storeSource)

      // 2. Discover JSONL sessions (fallback — output tokens only)
      try {
        const jsonlDir = getCopilotSessionStateDir(sessionStateDir)
        const jsonlSources = await discoverJsonlSessions(jsonlDir)
        if (storeSource) {
          // Same sessionId derivation as createJsonlParser: the CLI keys
          // session-state dirs and session-store rows by the same id, so the
          // store parser can attribute each session's rows to the same
          // project its per-turn output calls carry.
          storeSource.projectsBySessionId = new Map(
            jsonlSources.map(src => [basename(dirname(src.path)), src.project])
          )
        }
        sources.push(...jsonlSources)
      } catch {
        // JSONL discovery failed
      }

      // Prefer OTel over chatSessions: they can mirror the same turns under
      // incompatible IDs, and OTel carries richer token/cache data.
      if (!discoveredOtel) {
        // 3. Discover VS Code core chatSessions journals
        try {
          const chatSessionSources = await discoverWorkspaceChatSessions(getWsDirs())
          sources.push(...chatSessionSources)
        } catch {
          // Workspace chatSessions discovery failed
        }

        // 4. Discover VS Code empty-window chatSessions journals
        try {
          const emptyWindowSources = await discoverEmptyWindowChatSessions(getGlobalDirs())
          sources.push(...emptyWindowSources)
        } catch {
          // Empty-window chatSessions discovery failed
        }
      }

      // 5. Discover VS Code workspace transcript sessions
      try {
        const transcriptSources = await discoverTranscriptSessions(getWsDirs())
        sources.push(...transcriptSources)
      } catch {
        // Transcript discovery failed
      }

      // 6. Discover JetBrains IDE sessions (IntelliJ, PyCharm, …). These live
      // in a store none of the VS Code / CLI sources touch, so there is no
      // overlap to dedupe against; the shared seenKeys set still guards it.
      try {
        const jetbrainsSources = await discoverJetBrainsSessions(
          getJetBrainsCopilotRoot(jetbrainsDir)
        )
        sources.push(...jetbrainsSources)
      } catch {
        // JetBrains discovery failed
      }

      return sources
    },

    createSessionParser(
      source: SessionSource,
      seenKeys: Set<string>
    ): SessionParser {
      // Route to the correct parser based on source type.
      // The dedup key set (seenKeys) is shared across both parsers,
      // so if OTel already yielded a span, the JSONL parser will skip
      // the matching assistant.message (and vice versa).
      if (isOtelSource(source)) {
        return createOtelParser(source, seenKeys)
      }
      if (isSessionStoreSource(source)) {
        return createSessionStoreParser(source, seenKeys)
      }
      if (isChatSessionSource(source)) {
        return createChatSessionParser(source, seenKeys)
      }
      if (isJetBrainsSource(source)) {
        return createJetBrainsParser(source, seenKeys)
      }
      return createJsonlParser(source, seenKeys, isTranscriptSource(source))
    },
  }
}

// Default export for the provider registry
export const copilot = createCopilotProvider()

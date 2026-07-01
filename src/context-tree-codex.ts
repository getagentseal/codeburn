import { open, readdir, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { basename, join } from 'path'
import { homedir } from 'os'

import { readSessionLines } from './fs-utils.js'
import {
  add,
  estimateTokens,
  IMAGE_TOKEN_FALLBACK,
  newAcc,
  snapshot,
  type Acc,
  type ContextTreeResult,
  type SessionRef,
} from './context-tree.js'

// Codex rollout counterpart of the Claude Code context tree. Rollouts carry
// full response items plus token_count events with exact totals: the last
// token_count gives the live context size and model_context_window, and the
// cumulative reasoning_output_tokens total prices reasoning exactly (reasoning
// item text is encrypted). `compacted` entries mark compactions and include
// the replacement_history the next window starts from.

type CodexItem = {
  type?: string
  role?: string
  content?: unknown
  name?: string
  arguments?: unknown
  input?: unknown
  action?: unknown
  output?: unknown
}

type CodexEntry = {
  type?: string
  payload?: {
    type?: string
    role?: string
    model?: string
    cwd?: string
    id?: string
    base_instructions?: { text?: unknown } | null
    message?: unknown
    replacement_history?: unknown
    info?: {
      total_token_usage?: { reasoning_output_tokens?: number }
      last_token_usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number }
      model_context_window?: number
    } | null
  } & CodexItem
}

// Injected harness content: any tag-shaped block that isn't an image marker,
// plus the AGENTS.md / mentioned-files preambles Codex prepends to turns.
function isCodexMetaText(text: string): boolean {
  const t = text.trimStart()
  if (t.startsWith('<')) return !t.startsWith('<image')
  return t.startsWith('# AGENTS.md') || t.startsWith('# Files mentioned')
}

function addCodexItem(accs: Acc[], item: CodexItem): void {
  if (item.type === 'message' && item.role === 'assistant') {
    for (const acc of accs) {
      acc.assistantCount += 1
      acc.messages += 1
    }
    if (!Array.isArray(item.content)) return
    for (const block of item.content) {
      if (block == null || typeof block !== 'object') continue
      const b = block as { type?: string; text?: unknown }
      if ((b.type === 'output_text' || b.type === 'text') && typeof b.text === 'string') {
        for (const acc of accs) add(acc.assistantText, estimateTokens(b.text))
      }
    }
  } else if (item.type === 'message' && item.role === 'user') {
    for (const acc of accs) {
      acc.userCount += 1
      acc.messages += 1
    }
    if (!Array.isArray(item.content)) return
    for (const block of item.content) {
      if (block == null || typeof block !== 'object') continue
      const b = block as { type?: string; text?: unknown }
      if (b.type === 'input_image') {
        for (const acc of accs) add(acc.userImage, IMAGE_TOKEN_FALLBACK)
      } else if ((b.type === 'input_text' || b.type === 'text') && typeof b.text === 'string') {
        // Rollouts reference images as short "<image name=...>" markers; the
        // pixels never hit the file, so charge a flat estimate per marker.
        if (b.text.trimStart().startsWith('<image')) {
          for (const acc of accs) add(acc.userImage, IMAGE_TOKEN_FALLBACK)
        } else if (isCodexMetaText(b.text)) {
          for (const acc of accs) add(acc.userMeta, estimateTokens(b.text))
        } else {
          for (const acc of accs) add(acc.userText, estimateTokens(b.text))
        }
      }
    }
  } else if (item.type === 'reasoning') {
    // Tokens are patched from cumulative usage after the walk.
    for (const acc of accs) acc.assistantReasoning.count += 1
  } else if (item.type === 'function_call' || item.type === 'custom_tool_call' || item.type === 'local_shell_call' || item.type === 'web_search_call') {
    const tool =
      typeof item.name === 'string' && item.name
        ? item.name
        : item.type === 'local_shell_call'
          ? 'shell'
          : item.type === 'web_search_call'
            ? 'web_search'
            : 'unknown'
    let argText = ''
    if (typeof item.arguments === 'string') argText = item.arguments
    else if (typeof item.input === 'string') argText = item.input
    else {
      try {
        argText = JSON.stringify(item.arguments ?? item.input ?? item.action ?? {})
      } catch {
        argText = ''
      }
    }
    const tokens = estimateTokens(argText)
    for (const acc of accs) {
      add(acc.toolCall, tokens)
      const stat = acc.byTool.get(tool) ?? { count: 0, tokens: 0 }
      add(stat, tokens)
      acc.byTool.set(tool, stat)
    }
  } else if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
    let out = ''
    if (typeof item.output === 'string') out = item.output
    else {
      try {
        out = JSON.stringify(item.output ?? '')
      } catch {
        out = ''
      }
    }
    const tokens = estimateTokens(out)
    for (const acc of accs) add(acc.toolResult, tokens)
  }
}

export async function buildCodexContextTree(session: SessionRef): Promise<ContextTreeResult> {
  const full = newAcc()
  let segment = newAcc()
  let compactions = 0
  let model = 'unknown'
  let systemTokens = 0
  let contextWindow: number | null = null
  let lastTotalReasoning = 0
  let segmentStartReasoning = 0
  let lastUsage: { input_tokens?: number; output_tokens?: number; total_tokens?: number } | null = null

  for await (const line of readSessionLines(session.filePath)) {
    const text = line as string
    if (!text || text.charCodeAt(0) !== 123) continue
    let entry: CodexEntry
    try {
      entry = JSON.parse(text) as CodexEntry
    } catch {
      continue
    }
    const payload = entry.payload
    if (!payload) continue

    if (entry.type === 'session_meta') {
      const instructions = payload.base_instructions?.text
      if (typeof instructions === 'string') systemTokens = estimateTokens(instructions)
    } else if (entry.type === 'turn_context') {
      if (typeof payload.model === 'string' && payload.model) model = payload.model
    } else if (entry.type === 'compacted') {
      compactions += 1
      segment = newAcc()
      segmentStartReasoning = lastTotalReasoning
      if (typeof payload.message === 'string' && payload.message) {
        add(segment.userCompactSummary, estimateTokens(payload.message))
      }
      // The originals already landed in `full`, so the replacement history
      // seeds only the new live window.
      if (Array.isArray(payload.replacement_history)) {
        for (const item of payload.replacement_history) {
          if (item != null && typeof item === 'object') addCodexItem([segment], item as CodexItem)
        }
      }
    } else if (entry.type === 'response_item') {
      addCodexItem([full, segment], payload)
    } else if (entry.type === 'event_msg' && payload.type === 'token_count') {
      const info = payload.info
      const totalReasoning = info?.total_token_usage?.reasoning_output_tokens
      if (typeof totalReasoning === 'number') lastTotalReasoning = totalReasoning
      if (info?.last_token_usage) lastUsage = info.last_token_usage
      if (typeof info?.model_context_window === 'number' && info.model_context_window > 0) {
        contextWindow = info.model_context_window
      }
    }
  }

  full.assistantReasoning.tokens = lastTotalReasoning
  segment.assistantReasoning.tokens = Math.max(0, lastTotalReasoning - segmentStartReasoning)
  if (systemTokens > 0) {
    add(full.system, systemTokens)
    add(segment.system, systemTokens)
  }

  let reported: ContextTreeResult['reported'] = null
  if (lastUsage) {
    const context = lastUsage.total_tokens ?? (lastUsage.input_tokens ?? 0) + (lastUsage.output_tokens ?? 0)
    if (context > 0) {
      reported = { context, window: contextWindow ?? (context > 220_000 ? 1_000_000 : 200_000) }
    }
  }

  return {
    session,
    model,
    compactions,
    reported,
    effective: snapshot(segment),
    full: snapshot(full),
  }
}

const ROLLOUT_RE = /^rollout-.{19}-(.+)\.jsonl$/

export async function listCodexSessionRefs(): Promise<SessionRef[]> {
  const root = join(homedir(), '.codex', 'sessions')
  if (!existsSync(root)) return []
  let files: string[]
  try {
    files = await readdir(root, { recursive: true })
  } catch {
    return []
  }
  const refs: SessionRef[] = []
  for (const rel of files) {
    const base = basename(rel)
    const match = ROLLOUT_RE.exec(base)
    if (!match) continue
    const filePath = join(root, rel)
    try {
      const info = await stat(filePath)
      if (!info.isFile() || info.size === 0) continue
      refs.push({
        filePath,
        sessionId: match[1],
        project: '',
        mtimeMs: info.mtimeMs,
        sizeBytes: info.size,
      })
    } catch {
      continue
    }
  }
  refs.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return refs
}

// Codex stores no session name; use the head chunk for the cwd (project) and
// the first real user message as a stand-in title.
async function readCodexHeadInfo(ref: SessionRef): Promise<{ project: string; title: string }> {
  let chunk: string
  try {
    const fd = await open(ref.filePath, 'r')
    try {
      const buf = Buffer.alloc(262_144)
      const { bytesRead } = await fd.read(buf, 0, buf.length, 0)
      chunk = buf.subarray(0, bytesRead).toString('utf-8')
    } finally {
      await fd.close()
    }
  } catch {
    return { project: '', title: '' }
  }
  let project = ''
  let title = ''
  for (const line of chunk.split('\n')) {
    if (project && title) break
    let entry: CodexEntry
    try {
      entry = JSON.parse(line) as CodexEntry
    } catch {
      continue
    }
    const payload = entry.payload
    if (!payload) continue
    if (!project && entry.type === 'session_meta' && typeof payload.cwd === 'string' && payload.cwd) {
      project = basename(payload.cwd)
    }
    if (!title && entry.type === 'response_item' && payload.type === 'message' && payload.role === 'user' && Array.isArray(payload.content)) {
      for (const block of payload.content) {
        const b = block as { type?: string; text?: unknown }
        if ((b.type === 'input_text' || b.type === 'text') && typeof b.text === 'string' && b.text.trim() && !isCodexMetaText(b.text)) {
          title = b.text.replace(/\s+/g, ' ').trim().slice(0, 80)
          break
        }
      }
    }
  }
  return { project, title }
}

export async function listRecentCodexSessions(limit = 15): Promise<Array<SessionRef & { title: string }>> {
  const refs = (await listCodexSessionRefs()).slice(0, limit)
  return Promise.all(
    refs.map(async (ref) => {
      const info = await readCodexHeadInfo(ref)
      return { ...ref, project: info.project, title: info.title }
    }),
  )
}

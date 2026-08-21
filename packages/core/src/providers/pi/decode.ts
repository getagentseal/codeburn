// @codeburn/core Pi/OMP decoder: pure decode over host-supplied JSONL records.
// The host reads the .jsonl session file; this decoder extracts token buckets,
// tool calls, and user message threading with no fs, env, clock, or pricing.
// Pi and OMP share the same decode logic.

import { basename } from 'node:path'

import type { DecodeContext } from '../../contracts.js'
import type { RecordDiagnostic } from '../../diagnostics.js'
import { sourceRefFingerprint } from '../../fingerprint.js'
import type { PiDecodedCall, PiEntry } from './types.js'

// Pi/OMP tool ids mapped to the canonical vocabulary. Unknown ids pass through.
export const piToolNameMap: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  edit: 'Edit',
  write: 'Write',
  glob: 'Glob',
  grep: 'Grep',
  task: 'Agent',
  dispatch_agent: 'Agent',
  fetch: 'WebFetch',
  search: 'WebSearch',
  todo: 'TodoWrite',
  patch: 'Patch',
}

// Pi/OMP have no dedicated skill tool the way Claude Code does. A native skill
// load is emitted as an ordinary `read` tool call whose path points at the
// skill's `SKILL.md` (Pi resolves skills from many roots: ~/.pi/agent/skills,
// project .pi/skills, .agents/skills, package skills/, --skill <path>), or, in
// newer OMP builds, at a `skill://<name>` URI. Left untouched these inflate the
// Read tool count and leave the Skills dimension empty (issue #588). Return the
// skill name when a read is really a skill load, else null so it stays a Read.
function skillLoadName(name: string | undefined, args: Record<string, unknown> | undefined): string | null {
  if (name !== 'read') return null
  const raw = args?.['path'] ?? args?.['file_path']
  if (typeof raw !== 'string') return null
  const path = raw.trim()
  if (path.length === 0) return null

  if (path.startsWith('skill://')) {
    const rest = path.slice('skill://'.length).replace(/^\/+/, '')
    const first = rest.split(/[/?#]/)[0]?.trim() ?? ''
    return first.length > 0 ? first : null
  }

  // Match on the SKILL.md basename, not a directory prefix, because skill roots
  // live in many locations. Split on both separators so Windows paths work.
  const segments = path.split(/[\\/]/).filter(Boolean)
  if (segments[segments.length - 1] !== 'SKILL.md') return null
  const parent = segments[segments.length - 2]?.trim()
  return parent && parent.length > 0 ? parent : null
}

export type PiDecodeInput = {
  // records[i] is one raw JSONL line of the session file; the host does no
  // parsing, only the read + split.
  records: unknown[]
  context: DecodeContext
  seenKeys?: Set<string>
}

export type PiDecodeResult = {
  calls: PiDecodedCall[]
  diagnostics: RecordDiagnostic[]
}

// Moved verbatim from the CLI's `content-utils.ts`. A clean array (the
// overwhelming common case) is returned by reference; a string is wrapped into
// a single text block; anything else yields no blocks.
function normalizeContentBlocks<T extends { type?: string; text?: string }>(
  content: T[] | string | null | undefined,
): T[] {
  if (Array.isArray(content)) {
    const isBlock = (b: T): boolean => b != null && typeof b === 'object'
    return content.every(isBlock) ? content : content.filter(isBlock)
  }
  if (typeof content === 'string') return [{ type: 'text', text: content } as T]
  return []
}

/**
 * Decode Pi/OMP session records into rich, cost-free calls. A single pass over
 * the entries: user messages set pending prompt; assistant messages with token
 * usage flush into calls. Dedup is keyed on
 * `<provider>:<sourceRefFingerprint>:<responseId>` against live seenKeys — the
 * source path is fingerprinted, never emitted raw (dedupKey ships on the
 * envelope). `provider` ('pi' or 'omp') comes from `context.providerId`, since
 * Pi and OMP share this exact decode.
 */
export function decodePi({
  records,
  context,
  seenKeys: liveSeen,
}: PiDecodeInput): PiDecodeResult {
  const seen = liveSeen ?? new Set<string>()
  const calls: PiDecodedCall[] = []
  const diagnostics: RecordDiagnostic[] = []
  const provider: 'pi' | 'omp' = context.providerId === 'omp' ? 'omp' : 'pi'
  const sourcePath = context.sourceRef

  let sessionId = basename(sourcePath, '.jsonl')
  let pendingUserMessage = ''

  for (const [lineIdx, record] of records.entries()) {
    if (typeof record !== 'string') continue

    const line = record.trim()
    if (!line) continue

    let entry: PiEntry
    try {
      entry = JSON.parse(line) as PiEntry
    } catch {
      continue
    }

    if (entry.type === 'session') {
      sessionId = entry.id ?? sessionId
      continue
    }

    if (entry.type !== 'message') continue

    const msg = entry.message
    if (!msg) continue

    if (msg.role === 'user') {
      const texts = normalizeContentBlocks(msg.content)
        .filter(c => c.type === 'text')
        .map(c => c.text ?? '')
        .filter(Boolean)
      if (texts.length > 0) pendingUserMessage = texts.join(' ')
      continue
    }

    if (msg.role !== 'assistant' || !msg.usage) continue

    // Coerce undefined/null token fields to 0. Pi/OMP session files
    // sometimes omit individual usage fields; the destructure used to
    // pass undefined into calculateCost which then returned NaN, and
    // that NaN propagated into every aggregate cost total.
    const input = msg.usage.input ?? 0
    const output = msg.usage.output ?? 0
    const cacheRead = msg.usage.cacheRead ?? 0
    const cacheWrite = msg.usage.cacheWrite ?? 0
    if (input === 0 && output === 0) continue

    const model = msg.model ?? 'gpt-5'
    const responseId = msg.responseId ?? ''
    // The dedup key threads a FINGERPRINT of the session file path, never the
    // raw path — dedupKey ships on the envelope, so the raw path must not
    // cross into an observation output. (The basename-derived sessionId below
    // stays the host's session identity; it is not a path.)
    const dedupKey = `${provider}:${sourceRefFingerprint(context.privacyKey, context.sourceRef)}:${responseId || entry.id || entry.timestamp || String(lineIdx)}`

    if (seen.has(dedupKey)) continue
    seen.add(dedupKey)

    const toolCalls = normalizeContentBlocks(msg.content).filter(c => c.type === 'toolCall' && c.name)

    // A SKILL.md-loading read is surfaced as the `Skill` tool (not `Read`)
    // and its name is recorded in `skills`. This mirrors how the Claude
    // parser represents a skill invocation, so the shared classifier tags
    // the turn `general` and the "Skills & Agents" breakdown picks it up,
    // instead of over-counting a Read and leaving Skills empty (#588).
    // Every other call stays a normal tool.
    const tools: string[] = []
    const skills: string[] = []
    for (const c of toolCalls) {
      const skill = skillLoadName(c.name, c.arguments)
      if (skill !== null) {
        skills.push(skill)
        tools.push('Skill')
        continue
      }
      tools.push(piToolNameMap[c.name!] ?? c.name!)
    }

    const bashCommands = toolCalls
      .filter(c => c.name === 'bash')
      .flatMap(c => {
        const cmd = c.arguments?.['command']
        return typeof cmd === 'string' ? [cmd] : []
      })

    const timestamp = entry.timestamp ?? ''

    calls.push({
      provider,
      model,
      inputTokens: input,
      outputTokens: output,
      cacheCreationInputTokens: cacheWrite,
      cacheReadInputTokens: cacheRead,
      cachedInputTokens: cacheRead,
      reasoningTokens: 0,
      webSearchRequests: 0,
      tools,
      rawBashCommands: bashCommands,
      skills: skills.length > 0 ? skills : undefined,
      timestamp,
      speed: 'standard',
      deduplicationKey: dedupKey,
      userMessage: pendingUserMessage,
      sessionId,
    })
    pendingUserMessage = ''
  }

  return { calls, diagnostics }
}

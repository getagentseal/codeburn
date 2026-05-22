import { readdir, stat } from 'fs/promises'
import { createReadStream } from 'fs'
import { createInterface } from 'readline'
import { basename, join } from 'path'
import { homedir } from 'os'

import { readSessionLines } from '../fs-utils.js'
import { calculateCost } from '../models.js'
import { readCachedCodexResults, writeCachedCodexResults, getCachedCodexProject, fingerprintFile } from '../codex-cache.js'
import type { ToolCall } from '../types.js'
import type { Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'

const modelDisplayNames: Record<string, string> = {
  'codex-auto-review': 'Codex Auto Review',
  'gpt-5.5': 'GPT-5.5',
  'gpt-5.4-mini': 'GPT-5.4 Mini',
  'gpt-5.4': 'GPT-5.4',
  'gpt-5.3-codex': 'GPT-5.3 Codex',
  'gpt-5.2-low': 'GPT-5.2 Low',
  'gpt-5.2': 'GPT-5.2',
  'gpt-5': 'GPT-5',
  'gpt-4o-mini': 'GPT-4o Mini',
  'gpt-4o': 'GPT-4o',
}

const toolNameMap: Record<string, string> = {
  exec_command: 'Bash',
  read_file: 'Read',
  write_file: 'Edit',
  apply_diff: 'Edit',
  apply_patch: 'Edit',
  spawn_agent: 'Agent',
  close_agent: 'Agent',
  wait_agent: 'Agent',
  read_dir: 'Glob',
}

type CodexEntry = {
  type: string
  timestamp?: string
  payload?: {
    type?: string
    role?: string
    cwd?: string
    model_provider?: string
    originator?: string
    session_id?: string
    forked_from_id?: string
    model?: string
    name?: string
    content?: Array<{ type?: string; text?: string }>
    info?: {
      model?: string
      model_name?: string
      last_token_usage?: CodexTokenUsage
      total_token_usage?: CodexTokenUsage
    }
  }
}

type CodexTokenUsage = {
  input_tokens?: number
  cached_input_tokens?: number
  output_tokens?: number
  reasoning_output_tokens?: number
  total_tokens?: number
}

const CHARS_PER_TOKEN = 4
const RAW_HEAD_BYTES = 64 * 1024
const LARGE_TEXT_CAP = 2000

function getCodexDir(override?: string): string {
  return override ?? process.env['CODEX_HOME'] ?? join(homedir(), '.codex')
}

function sanitizeProject(cwd: string): string {
  return cwd.replace(/^\//, '').replace(/\//g, '-')
}

// Cap how many bytes we'll read while looking for the first newline. Real
// Codex session_meta lines are ~22-27 KB; this leaves plenty of headroom while
// keeping memory bounded if a corrupt file has no newline at all.
const FIRST_LINE_READ_CAP = 1024 * 1024

async function readFirstLine(filePath: string): Promise<CodexEntry | null> {
  // Codex CLI 0.128+ writes a session_meta line that can exceed 20 KB because
  // it embeds the full base_instructions / system prompt. A fixed-size buffer
  // would miss the trailing newline and reject the session as invalid.
  // Stream the file via readline so we can read the first line up to
  // FIRST_LINE_READ_CAP, which keeps memory bounded if the file has no newline.
  const stream = createReadStream(filePath, {
    encoding: 'utf-8',
    start: 0,
    end: FIRST_LINE_READ_CAP - 1,
  })
  // Silence stream errors so a late read-ahead error after we've already
  // returned the first line cannot escape as an unhandled 'error' event.
  // readline's async iterator re-throws underlying stream errors (ENOENT,
  // EACCES, etc.) on Node 16+, which the catch below handles for the cases
  // that matter for validation.
  stream.on('error', () => {})
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  let firstLine: string | undefined
  try {
    for await (const line of rl) {
      firstLine = line
      break
    }
  } catch {
    return null
  } finally {
    rl.close()
    stream.destroy()
  }
  if (!firstLine || !firstLine.trim()) return null
  try {
    return JSON.parse(firstLine) as CodexEntry
  } catch {
    return null
  }
}

async function isValidCodexSession(filePath: string): Promise<{ valid: boolean; meta?: CodexEntry }> {
  const entry = await readFirstLine(filePath)
  if (!entry) return { valid: false }
  const valid = entry.type === 'session_meta' &&
    typeof entry.payload?.originator === 'string' &&
    entry.payload.originator.toLowerCase().startsWith('codex')
  return { valid, meta: valid ? entry : undefined }
}

function getRawJsonStringField(head: string, field: string): string | undefined {
  const re = new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`)
  const match = re.exec(head)
  if (!match) return undefined
  try {
    return JSON.parse(`"${match[1]}"`) as string
  } catch {
    return match[1]
  }
}

function payloadHead(head: string): string {
  const idx = head.indexOf('"payload"')
  return idx === -1 ? head : head.slice(idx)
}

function countJsonStringBytes(source: Buffer, valueStart: number): number {
  let count = 0
  for (let i = valueStart; i < source.length; i++) {
    const ch = source[i]
    if (ch === 0x5c) {
      i++
      count++
      continue
    }
    if (ch === 0x22) return count
    count++
  }
  return count
}

function extractFirstJsonText(source: Buffer, cap = LARGE_TEXT_CAP): string {
  const key = Buffer.from('"text"')
  const idx = source.indexOf(key)
  if (idx === -1) return ''
  const colon = source.indexOf(0x3a, idx + key.length)
  if (colon === -1) return ''
  const qStart = source.indexOf(0x22, colon + 1)
  if (qStart === -1) return ''
  const chunks: number[] = []
  for (let i = qStart + 1; i < source.length && chunks.length < cap; i++) {
    const ch = source[i]
    if (ch === 0x5c) {
      const next = source[++i]
      if (next === 0x6e) chunks.push(0x0a)
      else if (next === 0x72) chunks.push(0x0d)
      else if (next === 0x74) chunks.push(0x09)
      else if (next !== undefined) chunks.push(next)
      continue
    }
    if (ch === 0x22) break
    chunks.push(ch)
  }
  return Buffer.from(chunks).toString('utf-8')
}

function countFirstJsonText(source: Buffer): number {
  const key = Buffer.from('"text"')
  const idx = source.indexOf(key)
  if (idx === -1) return 0
  const colon = source.indexOf(0x3a, idx + key.length)
  if (colon === -1) return 0
  const qStart = source.indexOf(0x22, colon + 1)
  if (qStart === -1) return 0
  return countJsonStringBytes(source, qStart + 1)
}

function parseCodexLine(line: string | Buffer): CodexEntry | null {
  if (typeof line === 'string') {
    const trimmed = line.trim()
    if (!trimmed) return null
    try {
      return JSON.parse(trimmed) as CodexEntry
    } catch {
      return null
    }
  }

  if (line.length === 0) return null
  const head = line.subarray(0, RAW_HEAD_BYTES).toString('utf-8')
  const type = getRawJsonStringField(head, 'type')
  if (!type) return null
  const pHead = payloadHead(head)
  const payloadType = getRawJsonStringField(pHead, 'type')
  const role = getRawJsonStringField(pHead, 'role')

  const entry: CodexEntry = {
    type,
    timestamp: getRawJsonStringField(head, 'timestamp'),
    payload: {
      type: payloadType,
      role,
      cwd: getRawJsonStringField(pHead, 'cwd'),
      model_provider: getRawJsonStringField(pHead, 'model_provider'),
      originator: getRawJsonStringField(pHead, 'originator'),
      session_id: getRawJsonStringField(pHead, 'session_id'),
      forked_from_id: getRawJsonStringField(pHead, 'forked_from_id'),
      model: getRawJsonStringField(pHead, 'model'),
      name: getRawJsonStringField(pHead, 'name'),
    },
  }

  if (type === 'response_item' && payloadType === 'message' && role === 'user') {
    entry.payload!.content = [{ type: 'input_text', text: extractFirstJsonText(line) }]
  } else if (type === 'response_item' && payloadType === 'message' && role === 'assistant') {
    entry.payload!.content = [{ type: 'output_text', text: 'x'.repeat(Math.min(countFirstJsonText(line), LARGE_TEXT_CAP)) }]
  }

  return entry
}

async function discoverSessionsInDir(codexDir: string): Promise<SessionSource[]> {
  const sessionsDir = join(codexDir, 'sessions')
  const sources: SessionSource[] = []

  let years: string[]
  try {
    years = await readdir(sessionsDir)
  } catch {
    return sources
  }

  for (const year of years) {
    if (!/^\d{4}$/.test(year)) continue
    const yearDir = join(sessionsDir, year)
    const months = await readdir(yearDir).catch(() => [] as string[])

    for (const month of months) {
      if (!/^\d{2}$/.test(month)) continue
      const monthDir = join(yearDir, month)
      const days = await readdir(monthDir).catch(() => [] as string[])

      for (const day of days) {
        if (!/^\d{2}$/.test(day)) continue
        const dayDir = join(monthDir, day)
        const files = await readdir(dayDir).catch(() => [] as string[])

        for (const file of files) {
          if (!file.startsWith('rollout-') || !file.endsWith('.jsonl')) continue
          const filePath = join(dayDir, file)
          const s = await stat(filePath).catch(() => null)
          if (!s?.isFile()) continue

          const cachedProject = await getCachedCodexProject(filePath)
          if (cachedProject) {
            sources.push({ path: filePath, project: cachedProject, provider: 'codex' })
            continue
          }

          const { valid, meta } = await isValidCodexSession(filePath)
          if (!valid || !meta) continue

          const cwd = meta.payload?.cwd ?? 'unknown'
          sources.push({ path: filePath, project: sanitizeProject(cwd), provider: 'codex' })
        }
      }
    }
  }

  return sources
}

function resolveModel(info: CodexEntry['payload'], sessionModel?: string): string {
  return info?.model
    ?? info?.info?.model
    ?? info?.info?.model_name
    ?? sessionModel
    ?? 'gpt-5'
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const cached = await readCachedCodexResults(source.path)
      if (cached) {
        for (const call of cached) {
          if (seenKeys.has(call.deduplicationKey)) continue
          seenKeys.add(call.deduplicationKey)
          yield call
        }
        return
      }

      const fp = await fingerprintFile(source.path)
      if (!fp) return

      let sessionModel: string | undefined
      let sessionId = ''
      let forkedFromId = ''
      let forkCutoff = ''
      // Null sentinel rather than `0` so the FIRST event is never confused
      // with a duplicate. A session that only emits last_token_usage (no
      // total_token_usage) reports cumulativeTotal=0 on every event; with a
      // 0-initialized prev, the first event would have matched and been
      // dropped. Once we've observed any event, we record its cumulative
      // total and dedup on equality regardless of whether it is zero.
      let prevCumulativeTotal: number | null = null
      let prevInput = 0
      let prevCached = 0
      let prevOutput = 0
      let prevReasoning = 0
      let pendingTools: string[] = []
      let pendingToolSequence: ToolCall[][] = []
      let pendingUserMessage = ''
      let pendingOutputChars = 0
      let estCounter = 0
      let turnCounter = 0
      let currentTurnId = `${sessionId}:t0`
      let sawAnyLine = false
      const results: ParsedProviderCall[] = []

      // Stream the session file line by line. Heavy Codex sessions can exceed
      // 250 MB on disk; reading the entire file into a string would either hit
      // the readSessionFile cap or push V8 toward its 512 MB string limit
      // after split('\n'). readSessionLines streams raw buffers and hands
      // huge lines to the compact parser without full string conversion.
      for await (const rawLine of readSessionLines(source.path, undefined, { largeLineAsBuffer: true })) {
        sawAnyLine = true
        const entry = parseCodexLine(rawLine)
        if (!entry) continue

        if (entry.type === 'session_meta') {
          sessionId = entry.payload?.session_id ?? basename(source.path, '.jsonl')
          forkedFromId = entry.payload?.forked_from_id ?? ''
          if (forkedFromId && entry.timestamp) {
            forkCutoff = new Date(new Date(entry.timestamp).getTime() + 5000).toISOString()
          }
          sessionModel = entry.payload?.model ?? sessionModel
          continue
        }

        if (entry.type === 'turn_context' && entry.payload?.model) {
          sessionModel = entry.payload.model
          continue
        }

        if (entry.type === 'response_item' && entry.payload?.type === 'function_call') {
          const rawName = entry.payload.name ?? ''
          const mapped = toolNameMap[rawName] ?? rawName
          pendingTools.push(mapped)
          const call: ToolCall = { tool: mapped }
          const rawArgs = (entry.payload as Record<string, unknown>)['arguments']
          const args = typeof rawArgs === 'string'
            ? (() => { try { return JSON.parse(rawArgs) as Record<string, unknown> } catch { return null } })()
            : typeof rawArgs === 'object' && rawArgs ? rawArgs as Record<string, unknown> : null
          if (args) {
            const fp = args['file_path'] ?? args['path']
            if (typeof fp === 'string') call.file = fp
            const cmd = args['command'] ?? args['cmd']
            if (typeof cmd === 'string') call.command = cmd
          }
          pendingToolSequence.push([call])
          continue
        }

        if (entry.type === 'event_msg' && entry.payload?.type === 'patch_apply_end') {
          pendingTools.push('Edit')
          const p = entry.payload as Record<string, unknown>
          const changes = p['changes']
          const filePaths = typeof changes === 'object' && changes ? Object.keys(changes as object) : []
          if (filePaths.length > 0) {
            for (const fp of filePaths) {
              pendingToolSequence.push([{ tool: 'Edit', file: fp }])
            }
          } else {
            pendingToolSequence.push([{ tool: 'Edit' }])
          }
          continue
        }

        if (entry.type === 'response_item' && entry.payload?.type === 'message' && entry.payload?.role === 'user') {
          const texts = (entry.payload.content ?? [])
            .filter(c => c.type === 'input_text')
            .map(c => c.text ?? '')
            .filter(Boolean)
          if (texts.length > 0) {
            pendingUserMessage = texts.join(' ').slice(0, 500)
            currentTurnId = `${sessionId}:t${++turnCounter}`
          }
          continue
        }

        if (entry.type === 'response_item' && entry.payload?.type === 'message' && entry.payload?.role === 'assistant') {
          const texts = (entry.payload.content ?? [])
            .filter(c => c.type === 'output_text' || c.type === 'text')
            .map(c => c.text ?? '')
          pendingOutputChars += texts.join('').length
          continue
        }

        if (entry.type === 'event_msg' && entry.payload?.type === 'token_count') {
          // Forked sessions replay the parent's entire event history with
          // timestamps clustered at the fork creation time. Skip replayed
          // events (within 5s of fork) to avoid double-counting.
          if (forkCutoff && entry.timestamp && entry.timestamp < forkCutoff) continue
          const info = entry.payload.info
          if (!info) {
            if (pendingOutputChars === 0 && pendingUserMessage.length === 0) continue
            const estInput = Math.ceil(pendingUserMessage.length / CHARS_PER_TOKEN)
            const estOutput = Math.ceil(pendingOutputChars / CHARS_PER_TOKEN)
            if (estInput === 0 && estOutput === 0) continue

            const model = sessionModel ?? 'gpt-5'
            const timestamp = entry.timestamp ?? ''
            const dedupKey = `codex:${sessionId}:${timestamp}:est${estCounter++}`

            if (seenKeys.has(dedupKey)) { pendingTools = []; pendingToolSequence = []; pendingUserMessage = ''; pendingOutputChars = 0; continue }
            seenKeys.add(dedupKey)

            const costUSD = calculateCost(model, estInput, estOutput, 0, 0, 0)

            results.push({
              provider: 'codex',
              model,
              inputTokens: estInput,
              outputTokens: estOutput,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 0,
              cachedInputTokens: 0,
              reasoningTokens: 0,
              webSearchRequests: 0,
              costUSD,
              costIsEstimated: true,
              tools: pendingTools,
              bashCommands: [],
              timestamp,
              speed: 'standard',
              deduplicationKey: dedupKey,
              turnId: currentTurnId,
              toolSequence: pendingToolSequence.length > 0 ? pendingToolSequence : undefined,
              userMessage: pendingUserMessage,
              sessionId,
            })

            pendingTools = []
            pendingToolSequence = []
            pendingUserMessage = ''
            pendingOutputChars = 0
            continue
          }

          const cumulativeTotal = info.total_token_usage?.total_tokens ?? 0
          // Dedup guard. Two consecutive events with cumulativeTotal=0 but
          // non-empty last_token_usage would have been double-counted with
          // the previous `> 0` clause. The null sentinel ensures the FIRST
          // event always passes (so a session that never reports cumulative
          // doesn't lose its opening turn).
          if (prevCumulativeTotal !== null && cumulativeTotal === prevCumulativeTotal) continue
          prevCumulativeTotal = cumulativeTotal

          const last = info.last_token_usage
          let inputTokens = 0
          let cachedInputTokens = 0
          let outputTokens = 0
          let reasoningTokens = 0

          if (last) {
            inputTokens = last.input_tokens ?? 0
            cachedInputTokens = last.cached_input_tokens ?? 0
            outputTokens = last.output_tokens ?? 0
            reasoningTokens = last.reasoning_output_tokens ?? 0
          } else if (cumulativeTotal > 0) {
            const total = info.total_token_usage
            if (!total) continue
            inputTokens = (total.input_tokens ?? 0) - prevInput
            cachedInputTokens = (total.cached_input_tokens ?? 0) - prevCached
            outputTokens = (total.output_tokens ?? 0) - prevOutput
            reasoningTokens = (total.reasoning_output_tokens ?? 0) - prevReasoning
          }

          // Always advance the prev counters to track the cumulative state.
          // Previously prev was only updated on the fallback branch, so a
          // session with mixed last_token_usage / no-last events would
          // compute the next fallback delta against a stale prev=0 baseline,
          // double-counting the entire cumulative window. The prev value
          // must mirror what cumulative reports regardless of whether this
          // event used `last` or fell back to deltas.
          const total = info.total_token_usage
          if (total) {
            prevInput = total.input_tokens ?? 0
            prevCached = total.cached_input_tokens ?? 0
            prevOutput = total.output_tokens ?? 0
            prevReasoning = total.reasoning_output_tokens ?? 0
          }

          const totalTokens = inputTokens + cachedInputTokens + outputTokens + reasoningTokens
          if (totalTokens === 0) continue

          // OpenAI includes cached tokens inside input_tokens; Anthropic does not.
          // Normalize to Anthropic semantics: inputTokens = non-cached only.
          const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens)

          const model = resolveModel(entry.payload, sessionModel)
          const timestamp = entry.timestamp ?? ''
          const dedupKey = `codex:${forkedFromId || sessionId}:${cumulativeTotal}`

          if (seenKeys.has(dedupKey)) continue
          seenKeys.add(dedupKey)

          const costUSD = calculateCost(
            model,
            uncachedInputTokens,
            outputTokens + reasoningTokens,
            0,
            cachedInputTokens,
            0,
          )

          results.push({
            provider: 'codex',
            model,
            inputTokens: uncachedInputTokens,
            outputTokens,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: cachedInputTokens,
            cachedInputTokens,
            reasoningTokens,
            webSearchRequests: 0,
            costUSD,
            tools: pendingTools,
            bashCommands: [],
            timestamp,
            speed: 'standard',
            deduplicationKey: dedupKey,
            turnId: currentTurnId,
            toolSequence: pendingToolSequence.length > 0 ? pendingToolSequence : undefined,
            userMessage: pendingUserMessage,
            sessionId,
          })

          pendingTools = []
          pendingToolSequence = []
          pendingUserMessage = ''
          pendingOutputChars = 0
        }
      }

      // If the stream yielded nothing the file was unreadable, oversized, or
      // empty. Skip cache write so a transient failure can't pin an empty
      // result set against a fingerprint that would otherwise be re-parsed.
      if (!sawAnyLine) return

      await writeCachedCodexResults(source.path, source.project, results, fp)

      for (const call of results) {
        yield call
      }
    },
  }
}

export function createCodexProvider(codexDir?: string): Provider {
  const dir = getCodexDir(codexDir)

  return {
    name: 'codex',
    displayName: 'Codex',

    modelDisplayName(model: string): string {
      for (const [key, name] of Object.entries(modelDisplayNames)) {
        if (model.startsWith(key)) return name
      }
      return model
    },

    toolDisplayName(rawTool: string): string {
      return toolNameMap[rawTool] ?? rawTool
    },

    async discoverSessions(): Promise<SessionSource[]> {
      return discoverSessionsInDir(dir)
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const codex = createCodexProvider()

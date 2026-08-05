import { readdir, stat } from 'fs/promises'
import { createReadStream } from 'fs'
import { createInterface } from 'readline'
import { basename, join } from 'path'
import { homedir } from 'os'

import { decodeCodex, codexToolNameMap, countUnifiedDiffLoc } from '@codeburn/core/providers/codex'
import type { CodexDecodedCall, CodexDecodeState, CodexEntry } from '@codeburn/core/providers/codex'

import { readSessionLines } from '../fs-utils.js'
import { priceProviderCall } from '../pricing-pass.js'
import {
  readCodexCacheEntry,
  writeCodexCacheEntry,
  getCachedCodexProject,
  fingerprintFile,
} from '../codex-cache.js'
import type { Provider, ProbeRoot, SessionSource, SessionParser, ParsedProviderCall } from './types.js'

// The unified-diff LOC counter now lives in @codeburn/core (the decoder uses it).
// Re-exported so existing importers keep resolving it from this module.
export { countUnifiedDiffLoc }

const modelDisplayNames: Record<string, string> = {
  'codex-auto-review': 'Codex Auto Review',
  'gpt-5.5': 'GPT-5.5',
  'gpt-5.4-mini': 'GPT-5.4 Mini',
  'gpt-5.4': 'GPT-5.4',
  'gpt-5.3-codex-spark': 'GPT-5.3 Codex Spark',
  'gpt-5.3-codex': 'GPT-5.3 Codex',
  'gpt-5.2-low': 'GPT-5.2 Low',
  'gpt-5.2': 'GPT-5.2',
  'gpt-5': 'GPT-5',
  'gpt-4o-mini': 'GPT-4o Mini',
  'gpt-4o': 'GPT-4o',
}

// Longest-first + version-boundary match so an unlisted future minor (gpt-5.6)
// falls through to its raw id instead of collapsing into the base "GPT-5" entry.
const modelDisplayEntries = Object.entries(modelDisplayNames).sort((a, b) => b[0].length - a[0].length)

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

// Validation is STRUCTURAL, never string-matching on `payload.originator`.
// `originator` is a free-form CLIENT IDENTITY string, not a format marker: any
// tool driving `codex app-server` writes structurally identical rollouts under
// ~/.codex/sessions with its own value ("codex-tui", "Codex Desktop",
// "t3code_desktop", "JetBrains.IntelliJ IDEA", ...). Gating on the spelling
// silently dropped every third-party frontend and needed a new allowlist entry
// per client (issues #626, #873).
//
// A `session_meta` first line with a well-formed payload object is signal
// enough: the walker only visits `rollout-*.jsonl` under the strict
// YYYY/MM/DD path or `archived_sessions/`, and codex.ts is the only provider
// that reads ~/.codex, so directory ownership — not originator content —
// decides the provider. Genuinely foreign files (wrong entry type, missing or
// non-object payload, malformed JSON) are still rejected.
async function isValidCodexSession(filePath: string): Promise<{ valid: boolean; meta?: CodexEntry }> {
  const entry = await readFirstLine(filePath)
  if (!entry) return { valid: false }
  // `entry` comes from an unchecked JSON.parse cast, so re-check the payload
  // shape at runtime instead of trusting the declared type.
  const payload: unknown = entry.payload
  const valid = entry.type === 'session_meta' &&
    typeof payload === 'object' &&
    payload !== null &&
    !Array.isArray(payload)
  return { valid, meta: valid ? entry : undefined }
}

async function discoverSessionFile(filePath: string): Promise<SessionSource | null> {
  const s = await stat(filePath).catch(() => null)
  if (!s?.isFile()) return null

  const cachedProject = await getCachedCodexProject(filePath)
  if (cachedProject) {
    return { path: filePath, project: cachedProject, provider: 'codex' }
  }

  const { valid, meta } = await isValidCodexSession(filePath)
  if (!valid || !meta) return null

  // Same unchecked-cast caveat as the payload check above: `cwd` is declared
  // `string` but comes straight off JSON.parse. A rollout carrying a number,
  // object or array here would throw out of sanitizeProject, escape
  // discoverSessions, and make safeDiscoverSessions return [] for the WHOLE
  // codex provider — every Codex report reading zero because of one bad file.
  const rawCwd: unknown = meta.payload?.cwd
  const cwd = typeof rawCwd === 'string' && rawCwd ? rawCwd : 'unknown'
  return { path: filePath, project: sanitizeProject(cwd), provider: 'codex' }
}

async function discoverSessionsInDir(codexDir: string): Promise<SessionSource[]> {
  const sources: SessionSource[] = []
  const sessionsDir = join(codexDir, 'sessions')

  const years = await readdir(sessionsDir).catch(() => [] as string[])

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
          const source = await discoverSessionFile(filePath)
          if (source) sources.push(source)
        }
      }
    }
  }

  // Codex moves archived sessions into a flat directory. Keep them in usage
  // reports so archiving a conversation does not erase its historical usage.
  const archivedDir = join(codexDir, 'archived_sessions')
  const archivedFiles = await readdir(archivedDir).catch(() => [] as string[])
  for (const file of archivedFiles) {
    if (!file.startsWith('rollout-') || !file.endsWith('.jsonl')) continue
    const source = await discoverSessionFile(join(archivedDir, file))
    if (source) sources.push(source)
  }

  return sources
}

// Map a rich, cost-free decoder call into the host's ParsedProviderCall, then
// price it via the estimated-cost seam. Cost leaves the decoder: `costBasis`
// marks the call so the pricing pass fills `costUSD` from the token buckets,
// byte-identical to the two in-decoder pricing calls this retires (issue #809).
function toPricedProviderCall(rich: CodexDecodedCall): ParsedProviderCall {
  const call: ParsedProviderCall = {
    provider: 'codex',
    model: rich.model,
    inputTokens: rich.inputTokens,
    outputTokens: rich.outputTokens,
    cacheCreationInputTokens: rich.cacheCreationInputTokens,
    cacheReadInputTokens: rich.cacheReadInputTokens,
    cachedInputTokens: rich.cachedInputTokens,
    reasoningTokens: rich.reasoningTokens,
    webSearchRequests: rich.webSearchRequests,
    costBasis: 'estimated',
    tools: rich.tools,
    bashCommands: [],
    timestamp: rich.timestamp,
    speed: rich.speed,
    deduplicationKey: rich.deduplicationKey,
    turnId: rich.turnId,
    userMessage: rich.userMessage,
    sessionId: rich.sessionId,
    ...(rich.toolSequence ? { toolSequence: rich.toolSequence } : {}),
    ...(rich.projectPath ? { projectPath: rich.projectPath } : {}),
    ...(rich.workingDirectory ? { workingDirectory: rich.workingDirectory } : {}),
    ...(rich.locAdded !== undefined ? { locAdded: rich.locAdded } : {}),
    ...(rich.locRemoved !== undefined ? { locRemoved: rich.locRemoved } : {}),
    ...(rich.editFailed !== undefined ? { editFailed: rich.editFailed } : {}),
    ...(rich.costIsEstimated ? { costIsEstimated: rich.costIsEstimated } : {}),
  }
  return priceProviderCall(call)
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const currentFp = await fingerprintFile(source.path)
      if (!currentFp) return

      const cached = await readCodexCacheEntry(source.path)

      // Exact hit: the file is unchanged. Serve the cached host-priced calls,
      // deduped against the shared cross-file set (a fork may already own a key).
      if (cached && cached.mtimeMs === currentFp.mtimeMs && cached.sizeBytes === currentFp.sizeBytes) {
        for (const call of cached.calls) {
          if (seenKeys.has(call.deduplicationKey)) continue
          seenKeys.add(call.deduplicationKey)
          yield call
        }
        return
      }

      // Append-resume: the file grew (Codex only appends to a rollout). Reuse the
      // cached end-state + priced calls and decode ONLY the new bytes from the
      // stored byte offset. Prior calls' dedup keys must be visible before the
      // appended records decode so the resumed stream dedups against them.
      let startByteOffset = 0
      let initialState: CodexDecodeState | undefined
      let priorCalls: ParsedProviderCall[] = []
      const resume = !!(cached && cached.byteOffset > 0 && currentFp.sizeBytes > cached.sizeBytes)
      if (resume && cached) {
        startByteOffset = cached.byteOffset
        initialState = cached.state
        priorCalls = cached.calls
        for (const c of priorCalls) seenKeys.add(c.deduplicationKey)
      }

      // Stream raw lines (only the appended tail when resuming). Buffers for huge
      // lines pass straight into the decoder without a full string conversion.
      const records: (string | Buffer)[] = []
      const tracker = { lastCompleteLineOffset: startByteOffset }
      let sawAnyLine = false
      for await (const rawLine of readSessionLines(source.path, undefined, {
        largeLineAsBuffer: true,
        startByteOffset,
        byteOffsetTracker: tracker,
      })) {
        sawAnyLine = true
        records.push(rawLine)
      }

      // A cold decode that streamed nothing means the file was unreadable,
      // oversized, or empty — skip the cache write so a transient failure can't
      // pin an empty result set (mirrors the pre-phase-4 sawAnyLine guard).
      if (!sawAnyLine && !resume) return

      const { calls: richCalls, diagnostics, state: newState } = decodeCodex({
        records,
        context: { privacyKey: '', providerId: 'codex', sourceRef: source.path },
        state: initialState,
        // Live shared dedup set (mutated in place); the decoder leaves
        // state.seenKeys empty when a live set is supplied.
        seenKeys,
        sessionIdFallback: basename(source.path, '.jsonl'),
      })
      if (diagnostics.length > 0) {
        // The decoder drops token_count events whose timestamp is not a
        // parseable string (a number/object/bool from an unchecked cast, or
        // garbage text): such a call would make the day aggregator bucket it
        // under 'NaN-NaN-NaN', a day the daily cache keeps for ten years.
        // Surface the drop on stderr, mirroring the Zed bridge, so the
        // skipped usage is visible instead of silent.
        process.stderr.write(`codeburn: skipped ${diagnostics.length} codex token_count event(s) with unparseable timestamps\n`)
      }

      const newPriced = richCalls.map(toPricedProviderCall)
      const allCalls = resume ? [...priorCalls, ...newPriced] : newPriced

      // Persist the state blob + host-priced calls + resume offset. seenKeys is
      // stripped from the stored state (cross-file dedup is reconstructed each
      // run from the session cache, as the pre-phase-4 shared set was).
      const storedState: CodexDecodeState = { ...newState, seenKeys: [] }
      await writeCodexCacheEntry(source.path, {
        mtimeMs: currentFp.mtimeMs,
        sizeBytes: currentFp.sizeBytes,
        project: source.project,
        byteOffset: tracker.lastCompleteLineOffset,
        state: storedState,
        calls: allCalls,
      })

      for (const call of allCalls) {
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
      for (const [key, name] of modelDisplayEntries) {
        if (model === key || model.startsWith(key + '-')) return name
      }
      return model
    },

    toolDisplayName(rawTool: string): string {
      return codexToolNameMap[rawTool] ?? rawTool
    },

    // Same `dir` discoverSessionsInDir walks: <codexDir>/sessions (dated
    // rollout files) and <codexDir>/archived_sessions. Honors CODEX_HOME.
    async probeRoots(): Promise<ProbeRoot[]> {
      return [
        { path: join(dir, 'sessions'), label: 'sessions' },
        { path: join(dir, 'archived_sessions'), label: 'archived' },
      ]
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

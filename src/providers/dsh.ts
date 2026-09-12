import { open, readdir, readFile, stat } from 'fs/promises'
import { basename, join } from 'path'
import { homedir } from 'os'
import zlib from 'zlib'

import { MAX_SESSION_FILE_BYTES, readSessionFile, readSessionLines } from '../fs-utils.js'
import { billableOutputTokens, calculateCost, getShortModelName } from '../models.js'
import { extractBashCommands } from '../bash-utils.js'
import type { ProbeRoot, Provider, SessionSource, SessionParser, ParsedProviderCall } from './types.js'

// DeepSeek Harness (dsh) stores one session per directory:
//   <DSH_HOME|~/.dsh>/sessions/<encoded-cwd>/session-<uuid>/session.jsonl.zstd
// (or an uncompressed session.jsonl when compression=none). The .zstd file is
// a concatenation of INDEPENDENT zstd frames — one per appended event batch —
// so node:zlib's one-shot zstdDecompressSync (which decodes a single frame)
// must be driven frame-by-frame behind a structural frame-boundary scan. The
// scan below is a port of scanZstdFrames from the official
// @deepseek-ai/dsh-session-persistence-jsonl package, which is third-party code
// under its own license - see THIRD_PARTY_NOTICES.md.

// zstd landed in node:zlib in 22.15 / 23.8; the package floor is lower, so the
// provider degrades with a notice instead of assuming the export exists.
const zstdDecompress = (zlib as { zstdDecompressSync?: (buf: Buffer, opts?: { maxOutputLength?: number }) => Buffer }).zstdDecompressSync

const ZSTD_MAGIC = 0xfd2fb528

// SESSION_FORMAT_VERSION in @deepseek-ai/dsh-session. DSH refuses to load a log
// stamped with any other version, and a bump means an event's meaning changed,
// so a foreign version is skipped rather than read with today's assumptions.
// A zstd frame's declared content size is attacker-controlled, so a few KB of
// crafted input can expand to gigabytes. Every decode is capped: no single
// frame may exceed this, and no file may decode to more than it would have been
// allowed to occupy uncompressed (MAX_SESSION_FILE_BYTES). Overflow throws, and
// the caller skips the WHOLE file rather than counting the frames it got to.
const MAX_FRAME_DECODED_BYTES = 64 * 1024 * 1024

const SUPPORTED_SESSION_FORMAT_VERSIONS = new Set([0, 1, 2, 3])
const SESSION_LOG_NAME = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/u

const MIN_REASONABLE_TIMESTAMP_MS = 1_000_000_000_000

// Discovery walks every session, so a per-file notice would repeat once per
// log; each distinct message is worth saying exactly once.
const noticed = new Set<string>()

function notice(message: string): void {
  if (noticed.has(message)) return
  noticed.add(message)
  process.stderr.write(message)
}

// A notice naming a file cannot dedup on its text: a systematic problem prints
// one line per session and grows `noticed` without bound. Dedup on the kind
// instead and show a few example paths.
const PATH_NOTICE_EXAMPLES = 3
const noticedPaths = new Map<string, number>()

function noticePath(kind: string, detail: string): void {
  const seen = (noticedPaths.get(kind) ?? 0) + 1
  noticedPaths.set(kind, seen)
  if (seen <= PATH_NOTICE_EXAMPLES) process.stderr.write(`codeburn: ${kind}: ${detail}\n`)
  else if (seen === PATH_NOTICE_EXAMPLES + 1) process.stderr.write(`codeburn: ${kind}: further paths suppressed\n`)
}

type ZstdFrame = { start: number; end: number }

// Locate complete frames without decompressing their blocks. An EOF inside the
// final frame (a torn append from a crashed writer) returns its start so the
// caller can ignore the tail; invalid complete structure rejects.
function scanZstdFrames(buffer: Buffer, maxFrames = Number.POSITIVE_INFINITY): { frames: ZstdFrame[]; tornStart?: number } {
  const frames: ZstdFrame[] = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`invalid zstd frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)!
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames }
  }
  return { frames }
}

type DshUsage = {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

type DshEvent = {
  type?: string
  seq?: number
  time?: number
  // Session header fields live at the top level of the first event.
  version?: number
  id?: string
  cwd?: string
  createdAt?: number
  parentSession?: string
  seedLength?: number
  isSeeded?: boolean
  data?: {
    turn?: number
    step?: number
    content?: Array<{ type?: string; text?: string }>
    // `user/message` carries the message author: a real prompt is
    // `{ kind: 'user' }`, agent-injected context is `{ kind: 'plugin' }`.
    source?: { kind?: string }
    header?: { config?: { model?: string; provider?: string } }
    provider?: string
    model?: string
    inherited?: boolean
    message?: { source?: { kind?: string; model?: string; provider?: string } }
    chunk?: { type?: string; usage?: DshUsage }
    stream?: Array<{
      type?: string
      time?: number
      chunk?: { type?: string; usage?: DshUsage }
    }>
    usage?: DshUsage
    name?: string
    arguments?: string
  }
}

type UsageObservation = {
  usage: DshUsage
  time?: number
  model: string
  final: boolean
}

type StepBucket = {
  observations: UsageObservation[]
  tools: string[]
  skills: string[]
  bashCommands: string[]
}

const toolNameMap: Record<string, string> = {
  bash: 'Bash',
  pwsh: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  str_replace_editor: 'Edit',
  glob: 'Glob',
  grep: 'Grep',
  todo_write: 'TodoWrite',
  todo: 'TodoWrite',
  web_search: 'WebSearch',
  skill: 'Skill',
  agent: 'Agent',
  ask_user_question: 'AskUserQuestion',
}

function mapToolName(raw: string): string {
  return toolNameMap[raw] ?? raw
}

// Usage fields are whatever the JSON held. A string or array would flow
// straight into the global token totals and the persisted cache, where
// `0 + [1, 2]` silently becomes "01,2". Same semantics as copilot.ts.
function numberOrZero(raw: unknown): number {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 ? raw : 0
}

function usageIsComplete(usage: DshUsage): boolean {
  const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  return count(usage.inputTokens) && count(usage.outputTokens)
    && [usage.cacheReadTokens, usage.cacheWriteTokens, usage.reasoningTokens].every(value => value === undefined || count(value))
    && (usage.reasoningTokens === undefined || usage.reasoningTokens <= usage.outputTokens)
}

// A log stamped with a version this parser was not written against is skipped
// whole: a bump means an event's meaning changed, so reading it with today's
// assumptions would report confident wrong numbers.
function isReadableVersion(header: DshEvent): boolean {
  if (typeof header.version === 'number' && SUPPORTED_SESSION_FORMAT_VERSIONS.has(header.version)) return true
  // Keyed on the version, not the path: a DSH upgrade makes EVERY session
  // unreadable at once, and one line per session log is noise, not a report.
  notice(`codeburn: skipping DSH sessions written in session format version ${String(header.version)}; upgrade codeburn.\n`)
  return false
}

function generationFromPath(filePath: string): number | undefined {
  const match = SESSION_LOG_NAME.exec(basename(filePath))
  if (!match) return undefined
  return match[1] === undefined ? 0 : Number(match[1])
}

function headerMatchesPath(header: DshEvent, filePath: string): boolean {
  const generation = generationFromPath(filePath)
  if (generation === undefined || header.version !== generation) {
    noticePath('skipping DSH session log whose filename and header versions disagree', filePath)
    return false
  }
  return isReadableVersion(header)
}

// DSH writes epoch milliseconds; promote a seconds-resolution value and reject
// what stays implausible, matching the guard cline-cli.ts uses on the hazard.
function isoTimestamp(value: number | undefined, fallback: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
  const ms = value < MIN_REASONABLE_TIMESTAMP_MS ? value * 1000 : value
  const date = new Date(ms)
  if (Number.isNaN(date.getTime()) || date.getTime() < MIN_REASONABLE_TIMESTAMP_MS) return fallback
  return date.toISOString()
}

function getDshHome(override?: string): string {
  // An empty-string DSH_HOME is treated as unset.
  return override ?? (process.env['DSH_HOME'] || undefined) ?? join(homedir(), '.dsh')
}

// DSH writes native-platform paths into the header (backslashes on Windows);
// split on both separators so discovery is correct on any host.
function projectFromCwd(cwd: string, fallback: string): string {
  const segments = cwd.split(/[\\/]/).filter(Boolean)
  return segments[segments.length - 1] ?? fallback
}

// Decode every complete frame and yield its JSONL lines. A torn final frame is
// ignored; a structurally corrupt file, or one that decodes past `budget`,
// throws for the caller to report. Exported for the decode-budget test.
export function* readZstdLines(
  buffer: Buffer,
  maxFrames = Number.POSITIVE_INFINITY,
  budget = MAX_SESSION_FILE_BYTES,
): Generator<string> {
  const { frames } = scanZstdFrames(buffer, maxFrames)
  let remaining = budget
  for (const frame of frames) {
    if (remaining <= 0) throw new Error(`decodes past the ${budget}-byte cap`)
    // node throws ERR_BUFFER_TOO_LARGE without allocating past the cap, so the
    // per-frame limit doubles as the running budget for the frames after it.
    const decoded = zstdDecompress!(buffer.subarray(frame.start, frame.end), {
      maxOutputLength: Math.min(remaining, MAX_FRAME_DECODED_BYTES),
    })
    remaining -= decoded.length
    for (const line of decoded.toString('utf-8').split('\n')) {
      if (line.trim()) yield line
    }
  }
}

async function readEventLines(filePath: string): Promise<string[] | null> {
  if (filePath.endsWith('.zstd')) {
    if (!zstdDecompress) {
      notice('codeburn: DSH sessions need Node >= 22.15 (zstd support); skipping DSH usage.\n')
      return null
    }
    let buffer: Buffer
    try {
      // The whole log is buffered to scan its frames, so it needs the same
      // oversize guard readSessionFile applies to the uncompressed variant.
      const size = (await stat(filePath)).size
      if (size > MAX_SESSION_FILE_BYTES) {
        noticePath('skipped oversize DSH session log', `${filePath} (${size} bytes)`)
        return null
      }
      buffer = await readFile(filePath)
    } catch {
      return null
    }
    try {
      return [...readZstdLines(buffer)]
    } catch (err) {
      noticePath('skipped corrupt DSH session log', `${filePath}: ${err instanceof Error ? err.message : err}`)
      return null
    }
  }
  const content = await readSessionFile(filePath)
  if (content === null) return null
  return content.split('\n').filter(l => l.trim())
}

// Cheap discovery probe: decompress ONLY the first frame (the session header
// batch) instead of the whole log. The header frame is tiny, so a bounded head
// read almost always contains it; fall back to a full read when it does not.
async function readSessionHeader(filePath: string): Promise<DshEvent | null> {
  const firstLine = async (): Promise<string | null> => {
    if (filePath.endsWith('.zstd')) {
      if (!zstdDecompress) return null
      let head: Buffer
      try {
        const handle = await open(filePath, 'r')
        try {
          const size = (await handle.stat()).size
          const length = Math.min(size, 256 * 1024)
          head = Buffer.alloc(length)
          await handle.read(head, 0, length, 0)
        } finally {
          await handle.close()
        }
      } catch {
        return null
      }
      let { frames } = scanZstdFrames(head, 1)
      if (frames.length === 0) {
        // Head read did not cover one full frame; take the whole file. A fork's
        // first batch carries the whole inherited seed, so this is reachable on
        // a real log and needs the same oversize guard as the parse read.
        try {
          if ((await stat(filePath)).size > MAX_SESSION_FILE_BYTES) return null
          const full = await readFile(filePath)
          frames = scanZstdFrames(full, 1).frames
          if (frames.length === 0) return null
          head = full
        } catch {
          return null
        }
      }
      const text = zstdDecompress(head.subarray(frames[0]!.start, frames[0]!.end), {
        maxOutputLength: MAX_FRAME_DECODED_BYTES,
      }).toString('utf-8')
      return text.split('\n').find(l => l.trim()) ?? null
    }
    for await (const line of readSessionLines(filePath)) {
      if (line.trim()) return line
    }
    return null
  }

  try {
    const line = await firstLine()
    if (!line) return null
    const event = JSON.parse(line) as DshEvent
    if (event.type !== 'session') return null
    return event
  } catch {
    return null
  }
}

async function discoverSessionsInDir(sessionsDir: string, onSkippedVersion?: (version: number) => void): Promise<SessionSource[]> {
  const sources: SessionSource[] = []

  let projectDirs: string[]
  try {
    projectDirs = await readdir(sessionsDir)
  } catch {
    return sources
  }

  for (const dirName of projectDirs) {
    const dirPath = join(sessionsDir, dirName)
    const dirStat = await stat(dirPath).catch(() => null)
    if (!dirStat?.isDirectory()) continue

    let sessionDirs: string[]
    try {
      sessionDirs = await readdir(dirPath)
    } catch {
      continue
    }

    for (const sessionDir of sessionDirs) {
      const sessionPath = join(dirPath, sessionDir)
      const sessionStat = await stat(sessionPath).catch(() => null)
      if (!sessionStat?.isDirectory()) continue

      // DSH keeps migrated generations beside their immutable predecessors.
      // Resolve the numerically highest canonical generation once per Session;
      // never fall back to an older snapshot when that authoritative file is
      // unknown or corrupt, since that would silently report stale usage.
      const generationFiles: Array<{ path: string; version: number; compressed: boolean }> = []
      const slots = new Set<string>()
      let ambiguous: number | undefined
      const names = await readdir(sessionPath).catch(() => [])
      for (const name of names) {
        const match = SESSION_LOG_NAME.exec(name)
        if (!match) continue
        const version = match[1] === undefined ? 0 : Number(match[1])
        const candidate = join(sessionPath, name)
        const fileStat = await stat(candidate).catch(() => null)
        if (!fileStat?.isFile()) continue
        const compressed = name.endsWith('.zstd')
        // `session.v0.jsonl` names the unversioned generation and
        // `session.v03.jsonl` names generation 3, so two files can claim one
        // generation; past 2^53 a generation cannot be ordered at all. Either
        // way no canonical log can be resolved, and dropping the session
        // silently is the omission #1281 was about.
        const slot = `${version}:${String(compressed)}`
        if (!Number.isSafeInteger(version) || slots.has(slot)) {
          ambiguous ??= version
          continue
        }
        slots.add(slot)
        generationFiles.push({ path: candidate, version, compressed })
      }
      if (ambiguous !== undefined) {
        onSkippedVersion?.(ambiguous)
        noticePath('skipping DSH session whose generation filenames are ambiguous', sessionPath)
        continue
      }
      generationFiles.sort((a, b) => b.version - a.version || Number(b.compressed) - Number(a.compressed))
      const selected = generationFiles[0]
      if (!selected) continue
      const filePath = selected.path

      if (!SUPPORTED_SESSION_FORMAT_VERSIONS.has(selected.version)) {
        onSkippedVersion?.(selected.version)
        notice(`codeburn: skipping DSH sessions written in session format version ${selected.version}; upgrade codeburn.\n`)
        continue
      }

      // Without zstd every compressed header reads as unreadable, so say why
      // once rather than naming every session log.
      if (selected.compressed && !zstdDecompress) {
        onSkippedVersion?.(selected.version)
        notice('codeburn: DSH sessions need Node >= 22.15 (zstd support); skipping DSH usage.\n')
        continue
      }

      const header = await readSessionHeader(filePath)
      if (!header) {
        onSkippedVersion?.(selected.version)
        noticePath('skipping unreadable DSH session header', filePath)
        continue
      }
      if (!headerMatchesPath(header, filePath)) {
        onSkippedVersion?.(selected.version)
        continue
      }

      const cwd = typeof header.cwd === 'string' && header.cwd.trim() ? header.cwd : dirName
      sources.push({ path: filePath, project: projectFromCwd(cwd, dirName), provider: 'dsh' })
    }
  }

  return sources
}

function parseToolArguments(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function usageFromStream(stream: NonNullable<DshEvent['data']>['stream']): DshUsage | undefined {
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record?.type === 'chunk' && record.chunk?.type === 'usage') return record.chunk.usage
  }
  return undefined
}

function emptyStepBucket(): StepBucket {
  return { observations: [], tools: [], skills: [], bashCommands: [] }
}

function createParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
  return {
    async *parse(): AsyncGenerator<ParsedProviderCall> {
      const lines = await readEventLines(source.path)
      if (!lines) return

      const events: DshEvent[] = []
      let corruptInterior = false
      for (const [index, line] of lines.entries()) {
        try {
          const value: unknown = JSON.parse(line)
          if (!value || typeof value !== 'object' || Array.isArray(value)) {
            if (index === 0) return
            corruptInterior = true
            continue
          }
          events.push(value as DshEvent)
        } catch {
          if (index === 0) return
          // A torn final append may be discarded. Malformed rows in the middle
          // of a versioned log cannot justify a complete historical total.
          if (index < lines.length - 1) corruptInterior = true
        }
      }

      const header = events[0]
      if (header?.type !== 'session' || !headerMatchesPath(header, source.path)) return
      const formatVersion = header.version!
      if (formatVersion >= 2 && corruptInterior) {
        noticePath('skipping corrupt DSH session with malformed interior rows', source.path)
        return
      }

      const sessionId = typeof header.id === 'string' ? header.id : ''
      const cwd = typeof header.cwd === 'string' ? header.cwd : ''
      let headerModel = 'unknown'
      let contextModel = ''
      let currentTurn = 0
      const sessionStart = isoTimestamp(header.createdAt, '')
      // Events a forked session inherited from its parent. They are a verbatim
      // copy of the parent's log, which codeburn parses as its own session, so
      // counting them here would bill the same calls twice.
      let inheritedCut = formatVersion <= 1 && typeof header.parentSession === 'string' && header.parentSession
        && typeof header.seedLength === 'number'
        ? header.seedLength - 1
        : -1
      if (formatVersion >= 2) {
        const taggedCuts = events
          .filter(event => event.type === 'session/end-seed' && event.data?.inherited === true && typeof event.seq === 'number')
          .map(event => event.seq!)
        if (header.isSeeded === true && taggedCuts.length === 0) {
          noticePath('skipping corrupt seeded DSH session without an inherited end-seed marker', source.path)
          return
        }
        if (header.isSeeded !== true && taggedCuts.length > 0) {
          noticePath('skipping corrupt unseeded DSH session with an inherited end-seed marker', source.path)
          return
        }
        inheritedCut = taggedCuts.at(-1) ?? -1
      }
      const userMessageByTurn = new Map<number, string>()
      const buckets = new Map<string, StepBucket>()
      const activeAttempts = new Map<string, number>()

      for (const event of events) {
        if (event.type === 'session') {
          continue
        }

        // Inherited request state can remain authoritative for the child's
        // first local attempt even though inherited usage is not billable.
        if (event.type === 'request/header') {
          // Emitted at most once per request; steps after the last header
          // inherit its config as their model.
          const nextModel = event.data?.header?.config?.model
          if (typeof nextModel === 'string' && nextModel) {
            if (nextModel !== headerModel) contextModel = ''
            headerModel = nextModel
          }
          continue
        }

        if (event.type === 'request/context') {
          const nextModel = event.data?.model
          if (typeof nextModel === 'string' && nextModel) contextModel = nextModel
          continue
        }

        if (typeof event.seq === 'number' && event.seq <= inheritedCut) continue

        if (event.type === 'turn/start') {
          currentTurn = event.data?.turn ?? currentTurn
          continue
        }

        if (event.type === 'llm/retry-started') {
          const turn = event.data?.turn ?? currentTurn
          const step = event.data?.step ?? 0
          activeAttempts.delete(`${turn}:${step}`)
          continue
        }

        if (event.type === 'user/message') {
          // Plugin-injected context (runtime snapshots, skill bodies, file-change
          // notices) rides the same event type as a typed prompt; only the latter
          // is a useful preview.
          if (event.data?.source?.kind !== 'user') continue
          if (userMessageByTurn.has(currentTurn)) continue
          const content = event.data?.content
          const texts = (Array.isArray(content) ? content : [])
            .filter(c => c?.type === 'text' && typeof c.text === 'string' && c.text)
            .map(c => c.text!)
          if (texts.length > 0) userMessageByTurn.set(currentTurn, texts.join(' ').slice(0, 500))
          continue
        }

        if (event.type === 'tool/call') {
          const turn = event.data?.turn ?? currentTurn
          const step = event.data?.step ?? 0
          const rawName = event.data?.name
          if (typeof rawName !== 'string' || !rawName) continue
          const key = `${turn}:${step}`
          let bucket = buckets.get(key)
          if (!bucket) {
            bucket = emptyStepBucket()
            buckets.set(key, bucket)
          }
          bucket.tools.push(mapToolName(rawName))
          const args = parseToolArguments(event.data?.arguments)
          if ((rawName === 'bash' || rawName === 'pwsh') && typeof args?.['command'] === 'string') {
            bucket.bashCommands.push(...extractBashCommands(args['command']))
          }
          if (rawName === 'skill' && typeof args?.['name'] === 'string') {
            bucket.skills.push(args['name'])
          }
          continue
        }

        let usage: DshUsage | undefined
        let isFinal = false
        // The model that actually served the call, when the message records it.
        // request/header only describes the request codeburn is about to see.
        let reportedModel = contextModel || headerModel
        if (formatVersion <= 1 && event.type === 'assistant/chunk' && event.data?.chunk?.type === 'usage') {
          usage = event.data.chunk.usage
        } else if (event.type === 'assistant/message') {
          usage = event.data?.usage ?? (formatVersion >= 2 ? usageFromStream(event.data?.stream) : undefined)
          isFinal = true
          const messageModel = event.data?.message?.source?.model
          if (typeof messageModel === 'string' && messageModel) reportedModel = messageModel
        } else if (formatVersion >= 2 && event.type === 'assistant/attempt') {
          usage = usageFromStream(event.data?.stream)
          isFinal = true
        } else {
          continue
        }
        const turn = event.data?.turn ?? currentTurn
        const step = event.data?.step ?? 0
        if (![turn, step].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) {
          noticePath('skipping DSH usage with invalid attempt coordinates', source.path)
          continue
        }
        const key = `${turn}:${step}`
        if (!usage) {
          if (!activeAttempts.has(key)) {
            noticePath('DSH session contains an attempt without usage; totals may be incomplete', source.path)
          }
          continue
        }
        let bucket = buckets.get(key)
        if (!bucket) {
          bucket = emptyStepBucket()
          buckets.set(key, bucket)
        }
        const observation = { usage, time: event.time, model: reportedModel, final: isFinal }
        // A different step cannot close this step's replacement slot. Only
        // its own retry-started event makes the next observation additive.
        const activeIndex = activeAttempts.get(key)
        if (activeIndex !== undefined) {
          if (!bucket.observations[activeIndex]?.final || isFinal) {
            bucket.observations[activeIndex] = observation
          }
        } else {
          bucket.observations.push(observation)
          activeAttempts.set(key, bucket.observations.length - 1)
        }
      }

      const sortedKeys = [...buckets.keys()].sort((a, b) => {
        const [ta, sa] = a.split(':').map(Number)
        const [tb, sb] = b.split(':').map(Number)
        return ta! - tb! || sa! - sb!
      })

      for (const key of sortedKeys) {
        const bucket = buckets.get(key)!
        for (let attempt = 0; attempt < bucket.observations.length; attempt += 1) {
          const observation = bucket.observations[attempt]!
          const input = numberOrZero(observation.usage.inputTokens)
          const output = numberOrZero(observation.usage.outputTokens)
          const cacheRead = numberOrZero(observation.usage.cacheReadTokens)
          const cacheWrite = numberOrZero(observation.usage.cacheWriteTokens)
          const reasoning = Math.min(numberOrZero(observation.usage.reasoningTokens), output)
          const completeUsage = usageIsComplete(observation.usage)
          if (!completeUsage) {
            noticePath('DSH session contains incomplete or invalid usage; retained counts are estimated', source.path)
          }
          if (input + output + cacheRead + cacheWrite === 0) continue

          const attemptKey = attempt === 0 ? key : `${key}:attempt:${attempt + 1}`
          const dedupKey = `dsh:${sessionId || source.path}:${attemptKey}`
          if (seenKeys.has(dedupKey)) continue
          seenKeys.add(dedupKey)

          // DSH TokenUsage defines reasoning as informational detail already
          // included in outputTokens. Preserve raw output and use the same
          // shared rule as cache rehydration and display (#1075).
          const costUSD = calculateCost(observation.model, input, billableOutputTokens('dsh', output, reasoning), cacheWrite, cacheRead, 0)
          const [turn] = key.split(':').map(Number)

          yield {
            provider: 'dsh',
            model: observation.model,
            inputTokens: input,
            outputTokens: output,
            cacheCreationInputTokens: cacheWrite,
            cacheReadInputTokens: cacheRead,
            cachedInputTokens: cacheRead,
            reasoningTokens: reasoning,
            webSearchRequests: 0,
            costUSD,
            costIsEstimated: !completeUsage,
            tools: attempt === bucket.observations.length - 1 ? [...new Set(bucket.tools)] : [],
            bashCommands: attempt === bucket.observations.length - 1 ? bucket.bashCommands : [],
            skills: attempt === bucket.observations.length - 1 && bucket.skills.length > 0 ? [...new Set(bucket.skills)] : undefined,
            timestamp: isoTimestamp(observation.time, sessionStart),
            speed: 'standard',
            deduplicationKey: dedupKey,
            userMessage: userMessageByTurn.get(turn!) ?? '',
            sessionId: sessionId || source.path,
            project: cwd ? projectFromCwd(cwd, source.project) : source.project,
            projectPath: cwd || undefined,
            workingDirectory: cwd || undefined,
          }
        }
      }
    },
  }
}

export function createDshProvider(dshHomeOverride?: string): Provider {
  const dshHome = getDshHome(dshHomeOverride)
  const sessionsDir = join(dshHome, 'sessions')

  return {
    name: 'dsh',
    displayName: 'DeepSeek Harness',

    modelDisplayName(model: string): string {
      return getShortModelName(model)
    },

    toolDisplayName(rawTool: string): string {
      return mapToolName(rawTool)
    },

    async probeRoots(): Promise<ProbeRoot[]> {
      return [{ path: sessionsDir, label: 'sessions' }]
    },

    async discoverSessions(onSkippedVersion): Promise<SessionSource[]> {
      return discoverSessionsInDir(sessionsDir, onSkippedVersion)
    },

    createSessionParser(source: SessionSource, seenKeys: Set<string>): SessionParser {
      return createParser(source, seenKeys)
    },
  }
}

export const dsh = createDshProvider()

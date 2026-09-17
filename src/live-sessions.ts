/// "What is using the quota right now": sessions whose transcript was appended
/// inside a short liveness window, with the context each one is holding. Feeds
/// the optional `liveSessions` block of the menubar payload; the app renders
/// only what it finds here.
import { open, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { getClaudeConfigDirs, getDesktopSessionsDirs } from './providers/claude.js'
import { kimicodeHomes, projectFromWorkDir, readState as readKimicodeState } from './providers/kimicode.js'
import { reportedContextWindow } from './context-tree.js'
import { modelRowKey } from './models.js'
import type { ApiUsage, AssistantMessageContent, JournalEntry } from './types.js'

export const LIVE_WINDOW_SECONDS = 600

/// Only the tail of a live transcript is read, and it is scanned backwards only
/// as far as the last assistant turn. A long-running session's file reaches tens
/// of MB and this runs on every payload build; the fields we want (last model,
/// last usage, current branch) all sit at the end.
export const TAIL_BYTES = 256 * 1024

export type LiveSession = {
  id: string
  /// Provider catalog id, matching the dock ring the session runs under.
  provider: string
  project: string
  /// Git branch of the last turn, the second half of the row's title. Null when
  /// the transcript never named one (non-Claude tools, or a non-repo cwd).
  branch: string | null
  /// Short display name of the model that answered last.
  model: string | null
  /// Tokens the next turn would resend, and the window they are measured against.
  /// Both null when the tail held no assistant usage, so the app omits the ring.
  contextTokens: number | null
  contextWindow: number | null
  startedAt: string
  lastActivityAt: string
  /// Seconds since this session last wrote, at the moment the payload was
  /// built. A session can be live but waiting on the user, which reads very
  /// differently from one that is generating.
  idleSeconds: number
}

export type LiveSessionsBlock = {
  windowSeconds: number
  sessions: LiveSession[]
}

export type LiveSessionInput = {
  id: string
  provider: string
  project: string
  branch: string | null
  model: string | null
  contextTokens: number | null
  contextWindow: number | null
  startedMs: number
  lastActivityMs: number
  /// Last-activity time of each sub-agent run belonging to this session.
  subagentActivityMs: number[]
}

/// Pure core: liveness and parent/sub-agent folding, newest first.
export function buildLiveSessions(
  inputs: LiveSessionInput[],
  nowMs: number,
  windowSeconds: number = LIVE_WINDOW_SECONDS,
): LiveSessionsBlock {
  const windowMs = windowSeconds * 1000
  const isLive = (ms: number) => ms > 0 && nowMs - ms <= windowMs
  // A session working through a sub-agent leaves its own transcript untouched
  // for as long as that agent runs, so its sub-agents count as its activity.
  const activityOf = (input: LiveSessionInput) => Math.max(input.lastActivityMs, ...input.subagentActivityMs)
  const sessions = inputs
    .filter(input => isLive(activityOf(input)))
    .map(input => ({
      id: input.id,
      provider: input.provider,
      project: input.project,
      branch: input.branch,
      model: input.model,
      contextTokens: input.contextTokens,
      contextWindow: input.contextWindow,
      startedAt: new Date(input.startedMs).toISOString(),
      lastActivityAt: new Date(activityOf(input)).toISOString(),
      idleSeconds: Math.max(0, Math.round((nowMs - activityOf(input)) / 1000)),
    }))
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
  return { windowSeconds, sessions }
}

async function readTail(filePath: string, maxBytes: number): Promise<string> {
  const handle = await open(filePath, 'r')
  try {
    const { size } = await handle.stat()
    const start = size > maxBytes ? size - maxBytes : 0
    const buffer = Buffer.alloc(size - start)
    if (buffer.length === 0) return ''
    await handle.read(buffer, 0, buffer.length, start)
    const text = buffer.toString('utf8')
    // A mid-file start almost certainly lands inside a line; drop that fragment.
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text
  } finally {
    await handle.close()
  }
}

/// Tokens the next request would carry: everything the model reads back plus
/// what it just wrote. Mirrors the reported-context sum in context-tree.ts.
function contextOf(usage: ApiUsage): number {
  return (usage.input_tokens ?? 0)
    + (usage.cache_read_input_tokens ?? 0)
    + (usage.cache_creation_input_tokens ?? 0)
    + (usage.output_tokens ?? 0)
}

function assistantMessage(entry: JournalEntry): AssistantMessageContent | null {
  const message = entry.message
  if (!message || typeof message !== 'object') return null
  const candidate = message as Partial<AssistantMessageContent>
  if (candidate.role !== 'assistant' || !candidate.usage) return null
  return candidate as AssistantMessageContent
}

type ScannedFile = {
  sessionId: string
  cwd: string
  isSidechain: boolean
  branch: string | null
  model: string | null
  contextTokens: number | null
  contextWindow: number | null
}

/// Reads one live transcript tail and walks it backwards, stopping at the last
/// assistant turn. Never throws: an unreadable or unexpected file yields a bare
/// record rather than taking the payload down.
export async function scanTranscript(filePath: string): Promise<ScannedFile> {
  const result: ScannedFile = {
    sessionId: basename(filePath).replace(/\.jsonl$/, ''),
    cwd: '',
    isSidechain: false,
    branch: null,
    model: null,
    contextTokens: null,
    contextWindow: null,
  }
  let text = ''
  try {
    text = await readTail(filePath, TAIL_BYTES)
  } catch {
    return result
  }
  const lines = text.split('\n')
  let needsIdentity = true
  let needsUsage = true
  // Backwards: the newest turn wins for every field, so the first hit going up
  // is the answer and there is no reason to parse the rest of the tail.
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!needsIdentity && !needsUsage) break
    const line = lines[index]
    if (!line || !line.trim()) continue
    let entry: JournalEntry
    try {
      entry = JSON.parse(line) as JournalEntry
    } catch {
      continue
    }
    if (needsIdentity) {
      if (typeof entry.sessionId === 'string' && entry.sessionId) result.sessionId = entry.sessionId
      if (typeof entry.cwd === 'string' && entry.cwd) result.cwd = entry.cwd
      if (entry.isSidechain === true) result.isSidechain = true
      if (typeof entry.gitBranch === 'string' && entry.gitBranch) result.branch = entry.gitBranch
      // cwd and branch travel together on every user/assistant entry, so one
      // entry carrying them settles identity.
      if (result.cwd && result.branch) needsIdentity = false
    }
    if (!needsUsage) continue
    const assistant = assistantMessage(entry)
    if (!assistant) continue
    const context = contextOf(assistant.usage)
    if (context <= 0) continue
    result.contextTokens = context
    const rawModel = typeof assistant.model === 'string' ? assistant.model : ''
    if (rawModel) result.model = modelRowKey(rawModel)
    // ponytail: the window comes from this one turn, so a session that compacted
    // below 220k on a 1M model reads as 200k until its next big turn. Track a
    // running max again if that misreport ever matters.
    result.contextWindow = reportedContextWindow(rawModel, context)
    needsUsage = false
  }
  return result
}

/// Claude nests sub-agent transcripts under their parent's own directory
/// (`<parent-session-id>/subagents/...`), so the parent file is that directory
/// plus `.jsonl`. Returns null for any other shape.
function parentTranscriptPath(sidechainPath: string): string | null {
  const marker = sidechainPath.lastIndexOf('/subagents/')
  if (marker <= 0) return null
  return `${sidechainPath.slice(0, marker)}.jsonl`
}

type FileTimes = { path: string; mtimeMs: number; birthtimeMs: number }

/// Transcript roots, straight from the Claude config rather than through the
/// provider registry. `discoverAllSessions` walks every provider's tree and
/// costs about half a second on a large history; this block only ever reads
/// Claude transcripts, and it runs on every payload build.
async function transcriptRoots(): Promise<string[]> {
  const configured = await getClaudeConfigDirs().catch(() => [])
  return [...configured.map(dir => join(dir, 'projects')), ...getDesktopSessionsDirs()]
}

/// Every transcript touched inside the window. One recursive listing per root,
/// then a stat per file: nothing is opened until it is known to be live.
async function liveTranscripts(nowMs: number, windowMs: number): Promise<FileTimes[]> {
  const paths: string[] = []
  for (const root of await transcriptRoots()) {
    const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      paths.push(join(entry.parentPath, entry.name))
    }
  }
  const stats = await Promise.all(paths.map(async path => {
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) return null
    if (nowMs - info.mtimeMs > windowMs) return null
    return { path, mtimeMs: info.mtimeMs, birthtimeMs: info.birthtimeMs || info.mtimeMs }
  }))
  return stats.filter((entry): entry is FileTimes => entry !== null)
}

/// Walks the live transcripts and builds the pure-core inputs. Sidechain
/// (sub-agent) transcripts fold into their parent session: they keep it alive
/// while it waits on them.
export async function collectLiveSessionInputs(
  nowMs: number,
  windowSeconds: number,
): Promise<LiveSessionInput[]> {
  const windowMs = windowSeconds * 1000
  const inputs = new Map<string, LiveSessionInput>()
  type PendingSidechain = { sessionId: string; mtimeMs: number; path: string }
  const pendingSidechains: PendingSidechain[] = []

  const toInput = (scan: ScannedFile, times: Omit<FileTimes, 'path'>, fallbackProject: string): LiveSessionInput => ({
    id: scan.sessionId,
    provider: 'claude',
    project: scan.cwd ? basename(scan.cwd) : fallbackProject,
    branch: scan.branch,
    model: scan.model,
    contextTokens: scan.contextTokens,
    contextWindow: scan.contextWindow,
    startedMs: times.birthtimeMs,
    lastActivityMs: times.mtimeMs,
    subagentActivityMs: [],
  })

  /// A parent whose own transcript is idle because its sub-agent is doing the
  /// work. Its file is not live, so read it here to recover its details.
  const loadIdleParent = async (sidechain: PendingSidechain): Promise<LiveSessionInput | null> => {
    const parentPath = parentTranscriptPath(sidechain.path)
    if (!parentPath) return null
    const info = await stat(parentPath).catch(() => null)
    if (!info?.isFile()) return null
    const scan = await scanTranscript(parentPath)
    return toInput(
      scan,
      { mtimeMs: info.mtimeMs, birthtimeMs: info.birthtimeMs || info.mtimeMs },
      basename(parentPath).replace(/\.jsonl$/, ''),
    )
  }

  for (const file of await liveTranscripts(nowMs, windowMs)) {
    const scan = await scanTranscript(file.path)
    if (scan.isSidechain) {
      pendingSidechains.push({ sessionId: scan.sessionId, mtimeMs: file.mtimeMs, path: file.path })
      continue
    }
    inputs.set(scan.sessionId, toInput(scan, file, basename(file.path).replace(/\.jsonl$/, '')))
  }

  // Claude writes the PARENT session id into every sidechain line, so the scan's
  // session id is the parent to attach to.
  for (const sidechain of pendingSidechains) {
    let parent = inputs.get(sidechain.sessionId)
    if (!parent) {
      const recovered = await loadIdleParent(sidechain)
      if (!recovered) continue
      parent = recovered
      inputs.set(parent.id, parent)
    }
    parent.subagentActivityMs.push(sidechain.mtimeMs)
  }

  return [...inputs.values(), ...await collectKimicodeInputs(nowMs, windowMs)]
}

/// What the tail of the main wire file says about the session: the model it
/// last asked for, the context Kimi itself measured after the last turn, and
/// the window it asked for. Tail-only, like the Claude scanner: a running wire
/// file reaches tens of MB and only the end matters.
async function kimicodeTail(wirePath: string): Promise<{ model: string | null; contextTokens: number | null; contextWindow: number | null }> {
  const out = { model: null as string | null, contextTokens: null as number | null, contextWindow: null as number | null }
  let text = ''
  try {
    text = await readTail(wirePath, TAIL_BYTES)
  } catch {
    return out
  }
  const lines = text.split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (!line || !line.trim()) continue
    let record: { type?: unknown; model?: unknown; maxTokens?: unknown; tokens?: unknown }
    try {
      record = JSON.parse(line) as typeof record
    } catch {
      continue
    }
    if (record.type === 'llm.request' && out.model === null) {
      if (typeof record.model === 'string' && record.model) out.model = record.model
      if (typeof record.maxTokens === 'number' && record.maxTokens > 0) out.contextWindow = record.maxTokens
    } else if (record.type === 'token_counting.measured' && out.contextTokens === null) {
      if (typeof record.tokens === 'number' && record.tokens >= 0) out.contextTokens = record.tokens
    }
    if (out.model !== null && out.contextTokens !== null) break
  }
  // A measurement without a window (or the reverse) draws nothing; the app
  // needs both to size the ring.
  if (out.contextTokens === null || out.contextWindow === null) { out.contextTokens = null; out.contextWindow = null }
  return out
}

/// Kimi Code keeps a directory per session, the session's own turns in
/// `agents/main/wire.jsonl` and every sub-agent in a sibling agent directory.
/// A missing or unreadable store is silent: no Kimi install means no rows.
export async function collectKimicodeInputs(
  nowMs: number,
  windowMs: number,
  roots: string[] = kimicodeHomes(),
): Promise<LiveSessionInput[]> {
  // Walked level by level rather than recursively: an agent directory also
  // holds `blobs` and `file-history` trees, and descending into those turns a
  // two-thousand-file scan into an eighteen-thousand-entry one.
  const subdirectories = async (path: string): Promise<string[]> =>
    (await readdir(path, { withFileTypes: true }).catch(() => []))
      .filter(entry => entry.isDirectory())
      .map(entry => join(path, entry.name))

  const paths: string[] = []
  await Promise.all(roots.map(async root => {
    await Promise.all((await subdirectories(join(root, 'sessions'))).map(async workDir => {
      await Promise.all((await subdirectories(workDir)).map(async sessionDir => {
        for (const agent of await subdirectories(join(sessionDir, 'agents'))) {
          paths.push(join(agent, 'wire.jsonl'))
        }
      }))
    }))
  }))

  const bySession = new Map<string, { mainMs: number; subagentMs: number[] }>()
  await Promise.all(paths.map(async path => {
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) return
    const sessionDir = dirname(dirname(dirname(path)))
    const agents = bySession.get(sessionDir) ?? { mainMs: 0, subagentMs: [] }
    if (basename(dirname(path)) === 'main') agents.mainMs = info.mtimeMs
    else if (nowMs - info.mtimeMs <= windowMs) agents.subagentMs.push(info.mtimeMs)
    bySession.set(sessionDir, agents)
  }))

  const inputs: LiveSessionInput[] = []
  for (const [sessionDir, agents] of bySession) {
    const mainIsLive = agents.mainMs > 0 && nowMs - agents.mainMs <= windowMs
    if (!mainIsLive && agents.subagentMs.length === 0) continue
    const state = await readKimicodeState(sessionDir)
    // `createdAt` is absent on stores that never wrote it; the state file itself
    // is created with the session, so its birthtime is the same moment.
    const birthtimeMs = state.createdAtMs
      ? 0
      : (await stat(join(sessionDir, 'state.json')).catch(() => null))?.birthtimeMs ?? 0
    const tail = await kimicodeTail(join(sessionDir, 'agents', 'main', 'wire.jsonl'))
    inputs.push({
      id: basename(sessionDir).replace(/^session_/, ''),
      provider: 'kimicode',
      project: projectFromWorkDir(state.cwd || state.workDir || '', basename(dirname(sessionDir))),
      branch: null,
      model: tail.model,
      contextTokens: tail.contextTokens,
      contextWindow: tail.contextWindow,
      startedMs: state.createdAtMs || birthtimeMs,
      lastActivityMs: agents.mainMs,
      subagentActivityMs: agents.subagentMs,
    })
  }
  return inputs
}

export async function collectLiveSessions(
  nowMs: number = Date.now(),
  windowSeconds: number = LIVE_WINDOW_SECONDS,
): Promise<LiveSessionsBlock> {
  const inputs = await collectLiveSessionInputs(nowMs, windowSeconds)
  return buildLiveSessions(inputs, nowMs, windowSeconds)
}

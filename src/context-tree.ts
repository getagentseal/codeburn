import { open, readdir, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { delimiter, join } from 'path'
import { homedir } from 'os'
import chalk from 'chalk'

import { readSessionLines, type SessionLine } from './fs-utils.js'
import { formatTokens } from './format.js'
import { estimateTokensFromChars } from './token-estimate.js'

// Block token counts are chars/4 estimates; the "context (exact)" line comes
// from the last assistant message's API usage. Transcripts store thinking
// blocks with their text stripped, so reasoning is derived per message as
// output_tokens minus the estimated visible output.

export const IMAGE_TOKEN_FALLBACK = 1600

export type BlockStat = { count: number; tokens: number }

export type ContextSnapshot = {
  messages: number
  tokens: number
  assistant: {
    count: number
    tokens: number
    text: BlockStat
    reasoning: BlockStat
    toolCall: BlockStat
    byTool: Array<{ tool: string; count: number; tokens: number }>
  }
  user: {
    count: number
    tokens: number
    text: BlockStat
    image: BlockStat
    compactSummary: BlockStat
    meta: BlockStat
  }
  toolResult: BlockStat
  system: BlockStat
}

export type SessionRef = {
  filePath: string
  sessionId: string
  project: string
  mtimeMs: number
  sizeBytes: number
}

export type ContextTreeResult = {
  session: SessionRef
  model: string
  compactions: number
  reported: { context: number; window: number | null } | null
  effective: ContextSnapshot
  full: ContextSnapshot
}

// A single line above this decodes to a string near V8's limit; skip it
// instead of letting toString abort the whole walk.
const MAX_LINE_BYTES = 256 * 1024 * 1024

export function lineToText(line: SessionLine): string | null {
  if (typeof line === 'string') return line
  if (line.length > MAX_LINE_BYTES) return null
  try {
    return line.toString('utf-8')
  } catch {
    return null
  }
}

export type Acc = {
  messages: number
  assistantCount: number
  assistantText: BlockStat
  assistantReasoning: BlockStat
  toolCall: BlockStat
  byTool: Map<string, BlockStat>
  userCount: number
  userText: BlockStat
  userImage: BlockStat
  userCompactSummary: BlockStat
  userMeta: BlockStat
  toolResult: BlockStat
  system: BlockStat
}

type RawUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

type RawEntry = {
  type?: string
  subtype?: string
  uuid?: string
  isSidechain?: boolean
  isMeta?: boolean
  isCompactSummary?: boolean
  content?: unknown
  attachment?: unknown
  compactMetadata?: { preTokens?: number; preservedSegment?: { headUuid?: string } }
  message?: {
    id?: string
    role?: string
    model?: string
    content?: unknown
    usage?: RawUsage
  }
}

// Streamed assistant messages arrive as several transcript entries sharing one
// message id. Reasoning can only be settled once the whole message has been
// seen, so per-message state is buffered here and flushed at end of file.
type PendingAssistant = {
  effective: boolean
  visibleEstTokens: number
  thinkingCount: number
  outputTokens: number
}

function newBlockStat(): BlockStat {
  return { count: 0, tokens: 0 }
}

export function newAcc(): Acc {
  return {
    messages: 0,
    assistantCount: 0,
    assistantText: newBlockStat(),
    assistantReasoning: newBlockStat(),
    toolCall: newBlockStat(),
    byTool: new Map(),
    userCount: 0,
    userText: newBlockStat(),
    userImage: newBlockStat(),
    userCompactSummary: newBlockStat(),
    userMeta: newBlockStat(),
    toolResult: newBlockStat(),
    system: newBlockStat(),
  }
}

export function estimateTokens(text: string): number {
  return estimateTokensFromChars(text.length)
}

export function add(stat: BlockStat, tokens: number): void {
  stat.count += 1
  stat.tokens += tokens
}

// Injected harness content (slash-command wrappers, system reminders, hook
// output) rather than something the user typed.
const META_TEXT_RE = /^\s*<(command-name|command-message|command-args|command-contents|local-command-stdout|local-command-stderr|system-reminder|task-notification)/

function pngDims(buf: Buffer): [number, number] | null {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)]
}

function jpegDims(buf: Buffer): [number, number] | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let i = 2
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++
      continue
    }
    const marker = buf[i + 1]
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)]
    const len = buf.readUInt16BE(i + 2)
    if (len < 2) return null
    i += 2 + len
  }
  return null
}

// Anthropic vision pricing: ~(w*h)/750 tokens after the API downscales to fit
// 1568px on the long edge / ~1.15MP total.
function imageTokens(source: unknown): number {
  const data = (source as { data?: unknown } | undefined)?.data
  if (typeof data !== 'string' || data.length === 0) return IMAGE_TOKEN_FALLBACK
  let buf: Buffer
  try {
    buf = Buffer.from(data.slice(0, 262144), 'base64')
  } catch {
    return IMAGE_TOKEN_FALLBACK
  }
  const dims = pngDims(buf) ?? jpegDims(buf)
  if (!dims) return IMAGE_TOKEN_FALLBACK
  const [w, h] = dims
  if (!(w > 0) || !(h > 0)) return IMAGE_TOKEN_FALLBACK
  const scale = Math.min(1, 1568 / Math.max(w, h), Math.sqrt(1_150_000 / (w * h)))
  return Math.max(1, Math.min(IMAGE_TOKEN_FALLBACK, Math.round((w * scale * h * scale) / 750)))
}

function toolResultTokens(content: unknown): number {
  if (typeof content === 'string') return estimateTokens(content)
  if (!Array.isArray(content)) return 0
  let tokens = 0
  for (const block of content) {
    if (block == null || typeof block !== 'object') continue
    const b = block as { type?: string; text?: unknown; source?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') tokens += estimateTokens(b.text)
    else if (b.type === 'image') tokens += imageTokens(b.source)
  }
  return tokens
}

class TreeBuilder {
  full = newAcc()
  effective = newAcc()
  pending = new Map<string, PendingAssistant>()
  model = 'unknown'
  lastUsage: RawUsage | null = null
  maxSeenTokens = 0

  private accs(effective: boolean): Acc[] {
    return effective ? [this.full, this.effective] : [this.full]
  }

  addEntry(entry: RawEntry, effective: boolean): void {
    const role = entry.message?.role
    if (entry.type === 'assistant' && role === 'assistant') {
      this.addAssistant(entry, effective)
    } else if (entry.type === 'user' && role === 'user') {
      this.addUser(entry, effective)
    } else if (entry.type === 'system') {
      const tokens = typeof entry.content === 'string' ? estimateTokens(entry.content) : 0
      for (const acc of this.accs(effective)) add(acc.system, tokens)
    } else if (entry.type === 'attachment') {
      let tokens = 0
      try {
        tokens = entry.attachment == null ? 0 : estimateTokens(JSON.stringify(entry.attachment))
      } catch {
        tokens = 0
      }
      for (const acc of this.accs(effective)) add(acc.userMeta, tokens)
    }
  }

  private addAssistant(entry: RawEntry, effective: boolean): void {
    const msg = entry.message
    if (!msg) return
    if (typeof msg.model === 'string' && msg.model && msg.model !== '<synthetic>') this.model = msg.model
    const usage = msg.usage
    if (usage && ((usage.input_tokens ?? 0) > 0 || (usage.cache_read_input_tokens ?? 0) > 0)) {
      this.lastUsage = usage
    }

    const id = msg.id ?? entry.uuid ?? ''
    let pending = this.pending.get(id)
    if (!pending) {
      pending = { effective, visibleEstTokens: 0, thinkingCount: 0, outputTokens: 0 }
      this.pending.set(id, pending)
      for (const acc of this.accs(effective)) {
        acc.assistantCount += 1
        acc.messages += 1
      }
    }
    if (usage?.output_tokens !== undefined) pending.outputTokens = usage.output_tokens

    const content = msg.content
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (block == null || typeof block !== 'object') continue
      const b = block as { type?: string; text?: unknown; name?: unknown; input?: unknown; content?: unknown }
      if (b.type === 'text' && typeof b.text === 'string') {
        const tokens = estimateTokens(b.text)
        pending.visibleEstTokens += tokens
        for (const acc of this.accs(pending.effective)) add(acc.assistantText, tokens)
      } else if (b.type === 'thinking' || b.type === 'redacted_thinking') {
        pending.thinkingCount += 1
      } else if (b.type === 'tool_use' || b.type === 'server_tool_use') {
        let tokens = 0
        try {
          tokens = estimateTokens(JSON.stringify(b.input ?? {}))
        } catch {
          tokens = 0
        }
        pending.visibleEstTokens += tokens
        const tool = typeof b.name === 'string' && b.name ? b.name : 'unknown'
        for (const acc of this.accs(pending.effective)) {
          add(acc.toolCall, tokens)
          const stat = acc.byTool.get(tool) ?? newBlockStat()
          add(stat, tokens)
          acc.byTool.set(tool, stat)
        }
      } else if (b.type === 'web_search_tool_result' || b.type === 'web_fetch_tool_result') {
        for (const acc of this.accs(pending.effective)) add(acc.toolResult, toolResultTokens(b.content))
      }
    }
  }

  private addUser(entry: RawEntry, effective: boolean): void {
    for (const acc of this.accs(effective)) {
      acc.userCount += 1
      acc.messages += 1
    }
    const content = entry.message?.content
    const bucketFor = (acc: Acc, text: string): BlockStat => {
      if (entry.isCompactSummary) return acc.userCompactSummary
      if (entry.isMeta || META_TEXT_RE.test(text)) return acc.userMeta
      return acc.userText
    }
    if (typeof content === 'string') {
      for (const acc of this.accs(effective)) add(bucketFor(acc, content), estimateTokens(content))
      return
    }
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (block == null || typeof block !== 'object') continue
      const b = block as { type?: string; text?: unknown; source?: unknown; content?: unknown }
      if (b.type === 'text' && typeof b.text === 'string') {
        for (const acc of this.accs(effective)) add(bucketFor(acc, b.text), estimateTokens(b.text))
      } else if (b.type === 'image') {
        const tokens = imageTokens(b.source)
        for (const acc of this.accs(effective)) add(acc.userImage, tokens)
      } else if (b.type === 'tool_result') {
        const tokens = toolResultTokens(b.content)
        for (const acc of this.accs(effective)) add(acc.toolResult, tokens)
      }
    }
  }

  // Transcripts strip thinking text, so estimate reasoning as the message's
  // output_tokens minus its estimated visible output. Only messages that
  // actually contained thinking blocks get a reasoning row; the remainder for
  // other messages is chars/4 drift, not reasoning.
  flushReasoning(): void {
    for (const pending of this.pending.values()) {
      if (pending.thinkingCount === 0) continue
      const tokens = Math.max(0, pending.outputTokens - pending.visibleEstTokens)
      for (const acc of this.accs(pending.effective)) {
        acc.assistantReasoning.count += pending.thinkingCount
        acc.assistantReasoning.tokens += tokens
      }
    }
  }
}

export function snapshot(acc: Acc): ContextSnapshot {
  const assistantTokens = acc.assistantText.tokens + acc.assistantReasoning.tokens + acc.toolCall.tokens
  const userTokens = acc.userText.tokens + acc.userImage.tokens + acc.userCompactSummary.tokens + acc.userMeta.tokens
  const byTool = [...acc.byTool.entries()]
    .map(([tool, stat]) => ({ tool, count: stat.count, tokens: stat.tokens }))
    .sort((a, b) => b.tokens - a.tokens)
  return {
    messages: acc.messages,
    tokens: assistantTokens + userTokens + acc.toolResult.tokens + acc.system.tokens,
    assistant: {
      count: acc.assistantCount,
      tokens: assistantTokens,
      text: acc.assistantText,
      reasoning: acc.assistantReasoning,
      toolCall: acc.toolCall,
      byTool,
    },
    user: {
      count: acc.userCount,
      tokens: userTokens,
      text: acc.userText,
      image: acc.userImage,
      compactSummary: acc.userCompactSummary,
      meta: acc.userMeta,
    },
    toolResult: acc.toolResult,
    system: acc.system,
  }
}

const skipFileSnapshots = (head: string): boolean => head.includes('"type":"file-history-snapshot"')

// Pass 1: locate the last compaction. The live window starts at the preserved
// segment's head (messages Claude Code carried across the compaction), not at
// the boundary itself.
async function findLastBoundary(filePath: string): Promise<{
  headUuid: string | null
  compactions: number
  maxPreTokens: number
}> {
  let headUuid: string | null = null
  let compactions = 0
  let maxPreTokens = 0
  for await (const line of readSessionLines(filePath, skipFileSnapshots, { largeLineAsBuffer: true })) {
    if (typeof line !== 'string') continue
    if (!line.includes('"subtype":"compact_boundary"')) continue
    let entry: RawEntry
    try {
      entry = JSON.parse(line) as RawEntry
    } catch {
      continue
    }
    if (entry.type !== 'system' || entry.subtype !== 'compact_boundary') continue
    compactions += 1
    headUuid = entry.compactMetadata?.preservedSegment?.headUuid ?? null
    maxPreTokens = Math.max(maxPreTokens, entry.compactMetadata?.preTokens ?? 0)
  }
  return { headUuid, compactions, maxPreTokens }
}

// Claude models with a 1M window: opus-4-8 (auto-compactions on disk show
// ~1.0M preTokens) and the "[1m]" long-context variants. Others default to
// 200K unless the session itself proves bigger.
const MILLION_WINDOW_RE = /opus-4-8|\[1m\]/

export async function buildContextTree(session: SessionRef): Promise<ContextTreeResult> {
  const boundary = await findLastBoundary(session.filePath)
  const builder = new TreeBuilder()
  builder.maxSeenTokens = boundary.maxPreTokens

  let boundariesSeen = 0
  let inPreservedSegment = false
  for await (const line of readSessionLines(session.filePath, skipFileSnapshots, { largeLineAsBuffer: true })) {
    const text = lineToText(line)
    if (!text || text.charCodeAt(0) !== 123) continue
    let entry: RawEntry
    try {
      entry = JSON.parse(text) as RawEntry
    } catch {
      continue
    }
    if (entry.isSidechain === true) continue
    if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
      boundariesSeen += 1
      continue
    }
    if (boundary.headUuid && entry.uuid === boundary.headUuid) inPreservedSegment = true
    const effective = boundariesSeen >= boundary.compactions || inPreservedSegment
    builder.addEntry(entry, effective)
  }
  builder.flushReasoning()

  let reported: ContextTreeResult['reported'] = null
  if (builder.lastUsage) {
    const context =
      (builder.lastUsage.input_tokens ?? 0) +
      (builder.lastUsage.cache_read_input_tokens ?? 0) +
      (builder.lastUsage.cache_creation_input_tokens ?? 0) +
      (builder.lastUsage.output_tokens ?? 0)
    builder.maxSeenTokens = Math.max(builder.maxSeenTokens, context)
    const million = MILLION_WINDOW_RE.test(builder.model) || builder.maxSeenTokens > 220_000
    reported = { context, window: million ? 1_000_000 : 200_000 }
  }

  return {
    session,
    model: builder.model,
    compactions: boundary.compactions,
    reported,
    effective: snapshot(builder.effective),
    full: snapshot(builder.full),
  }
}

// Mirrors the env handling of providers/claude.ts so the context views cover
// the same session roots as usage tracking.
function claudeProjectRoots(): string[] {
  const dirsEnv = process.env['CLAUDE_CONFIG_DIRS']
  const dirs = dirsEnv ? dirsEnv.split(delimiter).filter(Boolean) : [process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude')]
  return dirs.map((d) => join(d, 'projects'))
}

type SessionFile = { filePath: string; sessionId: string; project: string }

async function listSessionFiles(): Promise<SessionFile[]> {
  const files: SessionFile[] = []
  for (const root of claudeProjectRoots()) {
    if (!existsSync(root)) continue
    let projectDirs: string[]
    try {
      projectDirs = await readdir(root)
    } catch {
      continue
    }
    for (const dir of projectDirs) {
      let names: string[]
      try {
        names = await readdir(join(root, dir))
      } catch {
        continue
      }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue
        files.push({
          filePath: join(root, dir, name),
          sessionId: name.slice(0, -'.jsonl'.length),
          project: dir.split('-').filter(Boolean).pop() ?? dir,
        })
      }
    }
  }
  return files
}

async function statRef(file: SessionFile): Promise<SessionRef | null> {
  try {
    const info = await stat(file.filePath)
    if (!info.isFile() || info.size === 0) return null
    return { ...file, mtimeMs: info.mtimeMs, sizeBytes: info.size }
  } catch {
    return null
  }
}

function newestFirst(refs: Array<SessionRef | null>): SessionRef[] {
  return refs.filter((r): r is SessionRef => r !== null).sort((a, b) => b.mtimeMs - a.mtimeMs)
}

export async function listRecentSessions(limit = 15): Promise<SessionRef[]> {
  const files = await listSessionFiles()
  return newestFirst(await Promise.all(files.map(statRef))).slice(0, limit)
}

// Id lookups match filenames directly so only the matching files get stated.
export async function findClaudeSession(idPrefix: string): Promise<SessionRef | null> {
  const matches = (await listSessionFiles()).filter((f) => f.sessionId.startsWith(idPrefix))
  return newestFirst(await Promise.all(matches.map(statRef)))[0] ?? null
}

// Claude Code stores an AI-generated session name as "ai-title" entries (the
// last one is current; sessions get re-titled) and, in older sessions, as
// "summary" entries near the top. Scanning one tail and one head chunk finds
// it without reading a potentially 100MB transcript.
const TITLE_CHUNK_BYTES = 262_144

function titleFromChunk(chunk: string): string {
  let title = ''
  let summary = ''
  for (const line of chunk.split('\n')) {
    if (line.includes('"type":"ai-title"')) {
      try {
        const t = (JSON.parse(line) as { aiTitle?: unknown }).aiTitle
        if (typeof t === 'string' && t) title = t
      } catch {
        continue
      }
    } else if (!summary && line.includes('"type":"summary"')) {
      try {
        const t = (JSON.parse(line) as { summary?: unknown }).summary
        if (typeof t === 'string' && t) summary = t
      } catch {
        continue
      }
    }
  }
  return title || summary
}

export async function readChunk(filePath: string, start: number, length: number): Promise<string> {
  const fd = await open(filePath, 'r')
  try {
    const buf = Buffer.alloc(length)
    const { bytesRead } = await fd.read(buf, 0, length, start)
    return buf.subarray(0, bytesRead).toString('utf-8')
  } finally {
    await fd.close()
  }
}

export async function readSessionTitle(ref: SessionRef): Promise<string> {
  try {
    const tailStart = Math.max(0, ref.sizeBytes - TITLE_CHUNK_BYTES)
    let title = titleFromChunk(await readChunk(ref.filePath, tailStart, TITLE_CHUNK_BYTES))
    if (!title && tailStart > 0) title = titleFromChunk(await readChunk(ref.filePath, 0, TITLE_CHUNK_BYTES))
    return title.replace(/\s+/g, ' ').trim()
  } catch {
    return ''
  }
}

async function resolveSession(arg: string | undefined, provider: 'claude' | 'codex'): Promise<SessionRef | null> {
  if (arg && (arg.endsWith('.jsonl') || arg.includes('/'))) {
    if (!existsSync(arg)) return null
    const info = await stat(arg)
    const base = arg.split('/').pop() ?? arg
    return {
      filePath: arg,
      sessionId: base.replace(/\.jsonl$/, ''),
      project: '',
      mtimeMs: info.mtimeMs,
      sizeBytes: info.size,
    }
  }
  if (provider === 'codex') {
    const codex = await import('./context-tree-codex.js')
    if (!arg) return (await codex.listRecentCodexSessions(1))[0] ?? null
    return codex.findCodexSession(arg)
  }
  if (!arg) return (await listRecentSessions(1))[0] ?? null
  return findClaudeSession(arg)
}

function num(n: number): string {
  return n.toLocaleString('en-US')
}

export function relativeAge(mtimeMs: number): string {
  const mins = Math.max(0, Math.round((Date.now() - mtimeMs) / 60_000))
  if (mins < 60) return `${mins}m ago`
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`
  return `${Math.round(mins / (60 * 24))}d ago`
}

export type ContextRow = { depth: number; label: string; count: number; tokens: number; bold?: boolean }

export function snapshotRows(view: ContextSnapshot): ContextRow[] {
  const rows: ContextRow[] = []
  rows.push({ depth: 0, label: 'assistant', count: view.assistant.count, tokens: view.assistant.tokens, bold: true })
  rows.push({ depth: 1, label: 'text', count: view.assistant.text.count, tokens: view.assistant.text.tokens })
  if (view.assistant.reasoning.count > 0) rows.push({ depth: 1, label: 'reasoning', count: view.assistant.reasoning.count, tokens: view.assistant.reasoning.tokens })
  rows.push({ depth: 1, label: 'tool-call', count: view.assistant.toolCall.count, tokens: view.assistant.toolCall.tokens })
  for (const t of view.assistant.byTool) rows.push({ depth: 2, label: t.tool, count: t.count, tokens: t.tokens })
  rows.push({ depth: 0, label: 'user', count: view.user.count, tokens: view.user.tokens, bold: true })
  rows.push({ depth: 1, label: 'text', count: view.user.text.count, tokens: view.user.text.tokens })
  if (view.user.image.count > 0) rows.push({ depth: 1, label: 'image', count: view.user.image.count, tokens: view.user.image.tokens })
  if (view.user.compactSummary.count > 0) rows.push({ depth: 1, label: 'compact-summary', count: view.user.compactSummary.count, tokens: view.user.compactSummary.tokens })
  if (view.user.meta.count > 0) rows.push({ depth: 1, label: 'meta', count: view.user.meta.count, tokens: view.user.meta.tokens })
  rows.push({ depth: 0, label: 'tool', count: view.toolResult.count, tokens: view.toolResult.tokens, bold: true })
  rows.push({ depth: 1, label: 'tool-result', count: view.toolResult.count, tokens: view.toolResult.tokens })
  if (view.system.count > 0) rows.push({ depth: 0, label: 'system', count: view.system.count, tokens: view.system.tokens, bold: true })
  return rows
}

function renderRows(rows: ContextRow[]): string[] {
  const leftLen = (r: ContextRow): number => r.depth * 2 + (r.depth > 0 ? 2 : 0) + r.label.length
  const labelWidth = Math.max(...rows.map(leftLen)) + 2
  const countWidth = Math.max(...rows.map((r) => num(r.count).length)) + 1
  const tokenWidth = Math.max(...rows.map((r) => num(r.tokens).length))
  return rows.map((r) => {
    const indent = '  '.repeat(r.depth)
    const bullet = r.depth > 0 ? chalk.dim('◦ ') : ''
    const label = r.depth === 0 ? chalk.bold(r.label) : r.label
    const pad = ' '.repeat(labelWidth - leftLen(r))
    const count = chalk.dim(`${num(r.count)}x`.padStart(countWidth + 1))
    const tokens = (r.bold ? chalk.cyan.bold : chalk.cyan)(num(r.tokens).padStart(tokenWidth + 2))
    return `  ${indent}${bullet}${label}${pad}${count}${tokens} ${chalk.dim('tokens')}`
  })
}

export function renderContextTree(result: ContextTreeResult, opts: { full?: boolean } = {}): string {
  const view = opts.full ? result.full : result.effective
  const lines: string[] = []
  const scopeLabel = opts.full ? 'full session' : 'effective'

  lines.push('')
  lines.push(`  ${chalk.bold('Context Token Usage')} ${chalk.dim(`(${scopeLabel})`)}`)
  const sizeMb = (result.session.sizeBytes / 1024 / 1024).toFixed(1)
  const project = result.session.project ? `${result.session.project} · ` : ''
  lines.push(chalk.dim(`  session ${result.session.sessionId.slice(0, 8)} · ${project}${result.model} · ${relativeAge(result.session.mtimeMs)} · ${sizeMb}MB on disk`))
  lines.push('')

  const masked = Math.max(0, result.full.tokens - result.effective.tokens)
  lines.push(`  messages: ${chalk.bold(num(view.messages))}`)
  lines.push(`  tokens: ${chalk.bold(formatTokens(result.full.tokens))} ${chalk.dim('estimated across the session')}`)
  if (result.compactions > 0) {
    const pct = result.full.tokens > 0 ? Math.round((result.effective.tokens / result.full.tokens) * 100) : 0
    lines.push(`    ${chalk.dim('◦')} ${formatTokens(masked)} ${chalk.dim(`compacted away (${num(result.compactions)} compaction${result.compactions === 1 ? '' : 's'})`)}`)
    lines.push(`    ${chalk.dim('◦')} ${formatTokens(result.effective.tokens)} ${chalk.dim(`effective (${pct}%)`)}`)
  }
  if (result.reported) {
    const { context, window } = result.reported
    const windowPart = window ? ` ${chalk.dim(`of ${formatTokens(window)} window (${Math.round((context / window) * 100)}%)`)}` : ''
    lines.push(`  context (exact, last turn): ${chalk.bold(formatTokens(context))}${windowPart}`)
    const overhead = result.reported.context - result.effective.tokens
    if (overhead >= 0) {
      lines.push(`    ${chalk.dim('◦')} ${formatTokens(overhead)} ${chalk.dim('system prompt, tools & memory (derived)')}`)
    }
  }
  lines.push('')

  lines.push(...renderRows(snapshotRows(view)))

  lines.push('')
  lines.push(chalk.dim('  block tokens are estimated (chars/4, images by pixel count, reasoning from per-message usage);'))
  lines.push(chalk.dim('  "context (exact)" comes from API usage.'))
  if (!opts.full && result.compactions > 0) lines.push(chalk.dim('  showing the live window since the last compaction; use --full for the whole session.'))
  lines.push('')
  return lines.join('\n')
}

export type TitledSessionRef = SessionRef & { title: string }

function renderSessionList(refs: TitledSessionRef[], provider: 'claude' | 'codex'): string {
  const heading = provider === 'codex' ? 'Recent Codex sessions' : 'Recent Claude Code sessions'
  const hint = provider === 'codex' ? 'codeburn context <id> --provider codex to inspect one' : 'codeburn context <id> to inspect one'
  const lines = ['', `  ${chalk.bold(heading)}`, '']
  const projectWidth = Math.max(...refs.map((r) => r.project.length))
  for (const ref of refs) {
    const sizeMb = (ref.sizeBytes / 1024 / 1024).toFixed(1).padStart(6)
    const shortTitle = ref.title.length > 48 ? `${ref.title.slice(0, 47)}…` : ref.title
    lines.push(`  ${chalk.cyan(ref.sessionId.slice(0, 8))}  ${chalk.dim(`${sizeMb}MB`)}  ${relativeAge(ref.mtimeMs).padStart(7)}  ${chalk.dim(ref.project.padEnd(projectWidth))}  ${shortTitle}`)
  }
  lines.push('')
  lines.push(chalk.dim(`  ${hint}`))
  lines.push('')
  return lines.join('\n')
}

export async function listRecentTitledSessions(limit = 15): Promise<TitledSessionRef[]> {
  const refs = await listRecentSessions(limit)
  const titles = await Promise.all(refs.map(readSessionTitle))
  return refs.map((r, i) => ({ ...r, title: titles[i] ?? '' }))
}

export async function runContextCommand(
  sessionArg: string | undefined,
  opts: { list?: boolean; full?: boolean; json?: boolean; provider?: string },
): Promise<void> {
  const provider: 'claude' | 'codex' = opts.provider === 'codex' ? 'codex' : 'claude'
  if (opts.list) {
    const refs =
      provider === 'codex' ? await (await import('./context-tree-codex.js')).listRecentCodexSessions(15) : await listRecentTitledSessions(15)
    if (refs.length === 0) {
      console.log(provider === 'codex' ? 'No Codex sessions found.' : 'No Claude Code sessions found.')
      return
    }
    if (opts.json) {
      console.log(JSON.stringify({ sessions: refs }, null, 2))
      return
    }
    console.log(renderSessionList(refs, provider))
    return
  }
  const session = await resolveSession(sessionArg, provider)
  if (!session) {
    console.error(sessionArg ? `No ${provider} session matching "${sessionArg}".` : `No ${provider} sessions found.`)
    process.exitCode = 1
    return
  }
  const result =
    provider === 'codex' ? await (await import('./context-tree-codex.js')).buildCodexContextTree(session) : await buildContextTree(session)
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(renderContextTree(result, { full: opts.full }))
}

import { readdir, readFile } from 'fs/promises'
import { basename, join } from 'path'

import { readSessionLines } from './fs-utils.js'
import { calculateCost, getShortModelName } from './models.js'
import {
  collectSessionMeta,
  collectToolResultMeta,
  compactEntry,
  dedupeStreamingMessageIds,
  emptySessionMeta,
  groupIntoTurns,
  parseJsonlLine,
  type ToolResultMeta,
} from './parser.js'
import { estimateTokensFromChars } from './token-estimate.js'
import type { JournalEntry, ParsedApiCall } from './types.js'

// One Claude Code session, read on demand: where its money went, prompt by
// prompt and step by step. Money comes from the parser's own dedupe, turn
// grouping and calculateCost, so totals match `codeburn sessions`. Transcript
// content (prompts, commands, output, diffs) is redacted, capped, and never
// cached, persisted or sent anywhere: the caller prints it and exits.

export const WHY_RULES = {
  hotspotTopShare: 0.2,
  hotspotMedianX: 2,
  hotspotMinShare: 0.1,
  helperShare: 0.1,
  coordinationMinCalls: 5,
  coordinationToolShare: 0.75,
  rereadShare: 0.5,
  rereadMinCalls: 10,
  carryTokens: 10_000,
  prefixTokens: 40_000,
  idleMs: 60_000,
  slowCallMs: 60_000,
}

export type WhyParts = { input: number; output: number; cacheRead: number; cacheWrite: number; webSearch: number }
export type WhyTokens = { input: number; output: number; cacheRead: number; cacheWrite: number }
export type WhyAlt = { model: string; cost: number }
export type WhyError = { exitCode: number | null; cause: string | null; location: string | null; secondary: string[] }
export type WhyHelper = { id: string; description: string; agentType: string; models: string[]; calls: number; cost: number; nested: boolean; loose: boolean }
export type WhyDetail = {
  command?: string
  description?: string
  output?: string
  path?: string
  diff?: string
  lines?: number
  input?: string
  helper?: WhyHelper
}
export type WhyStep =
  | { kind: 'model'; start: number; end: number; model: string; cost: number; parts: WhyParts; tokens: WhyTokens; startedBy: 'prompt' | 'tool' | 'message' }
  | { kind: 'tool'; start: number; end: number; name: string; label: string; isError: boolean; error?: WhyError; helperCost?: number; detail: WhyDetail | null }
export type WhyTurn = {
  i: number
  ts: string
  prompt: { text: string; kind: 'text' | 'pasted' | 'system' }
  cost: number
  parts: WhyParts
  tokens: WhyTokens
  calls: number
  models: string[]
  helperCost: number
  helpers: WhyHelper[]
  wallMs: number
  steps: WhyStep[]
}
type Base = { id: string; turn?: number; step?: number; usd: number | null; share: number | null }
export type WhyFinding = Base & (
  | { kind: 'helpers'; direct: number; nested: number; loose: number; models: string[]; descriptions: string[]; parts: WhyParts; tokens: WhyTokens; calls: number; minCalls: number; maxCalls: number; alt: WhyAlt | null }
  | { kind: 'hotspot'; calls: number; toolCalls: number; models: string[]; median: number; parts: WhyParts; tokens: WhyTokens; alt: WhyAlt | null }
  | { kind: 'coordination'; calls: number; toolCalls: number; model: string; parts: WhyParts; alt: WhyAlt | null }
  | { kind: 'reread'; calls: number; avgTokens: number }
  | { kind: 'failed'; tool: string; label: string; description: string; error: WhyError; userStopped: boolean; afterCalls: number | null }
  | { kind: 'carry'; estimate: true; source: 'tool' | 'paste'; tool: string; label: string; chars: number; tokens: number; calls: number; writeUsd: number; readUsd: number }
  | { kind: 'prefix'; estimate: true; tokens: number; cached: number; uncached: number; writeUsd: number; readUsd: number; laterCalls: number; readCalls: number }
  | { kind: 'idle'; timeMs: number; endedBy: 'prompt' | 'tool' | 'message' | 'helper' }
  | { kind: 'slowCall'; timeMs: number; model: string; outputTokens: number }
)
export type SessionWhy = {
  sessionId: string
  title: string
  project: string
  startedAt: string
  endedAt: string
  cost: number
  calls: number
  parts: WhyParts
  tokens: WhyTokens
  models: Array<{ model: string; cost: number }>
  helperCost: number
  helperCount: number
  median: number
  turns: WhyTurn[]
  findings: WhyFinding[]
  rules: typeof WHY_RULES
  detailsOmitted: boolean
}

// ── redaction and caps ──────────────────────────────────────────────────

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{12,}/g, 'sk-••••'],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, '$1_••••'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_••••'],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, 'glpat-••••'],
  [/\b([sr]k_(?:live|test)_)[A-Za-z0-9]{10,}/g, '$1••••'],
  [/\b(aws_secret_access_key|aws_session_token)(["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1$2••••'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi, '$1••••@'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, 'xox•-••••'],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, '$1••••'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, 'AIza••••'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, 'eyJ••••'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[private key omitted]'],
  [/(authorization|bearer|x-api-key|api[_-]?key|access[_-]?token|token|secret|password|passwd)(["']?\s*[:=]\s*["']?|\s+)(?!•)[^\s"',;]{8,}/gi, '$1$2••••'],
  [/^([A-Z][A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD|PASS|PWD|DSN|CREDENTIALS?)[A-Z0-9_]*\s*=\s*).+$/gm, '$1••••'],
  [/\b[A-Za-z0-9+/]{120,}={0,2}/g, '[base64 omitted]'],
]

export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((acc, [re, rep]) => acc.replace(re, rep), text)
}

const LINE_CHARS = 400
const capLine = (l: string) => (l.length > LINE_CHARS ? l.slice(0, LINE_CHARS) + '…' : l)
function capHead(s: string, n: number): string {
  const ls = s.split('\n')
  return (ls.length > n ? [...ls.slice(0, n), `… ${ls.length - n} more lines`] : ls).map(capLine).join('\n')
}
// Keeps the first lines too: "Exit code N" leads a failed command's output.
function capTail(s: string, n = 40): string {
  const ls = s.split('\n')
  return (ls.length > n ? [...ls.slice(0, 6), `… ${ls.length - n} lines`, ...ls.slice(-(n - 6))] : ls).map(capLine).join('\n')
}

// ── pricing ─────────────────────────────────────────────────────────────

const ZERO_PARTS: WhyParts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearch: 0 }

// calculateCost is linear per token kind for Claude (no provider tier), so the
// parts priced one at a time add up to the call's cost.
export function partsOf(c: ParsedApiCall): WhyParts {
  if (c.costUSD === 0) return { ...ZERO_PARTS }
  const { model: m, speed: s, usage: u } = c
  return {
    input: calculateCost(m, u.inputTokens, 0, 0, 0, 0, s),
    output: calculateCost(m, 0, u.outputTokens, 0, 0, 0, s),
    cacheRead: calculateCost(m, 0, 0, 0, u.cacheReadInputTokens, 0, s),
    cacheWrite: calculateCost(m, 0, 0, u.cacheCreationInputTokens, 0, 0, s, c.cacheCreationOneHourTokens ?? 0),
    webSearch: calculateCost(m, 0, 0, 0, 0, u.webSearchRequests, s),
  }
}

function sumParts(calls: ParsedApiCall[]): { parts: WhyParts; tokens: WhyTokens } {
  const parts = { ...ZERO_PARTS }
  const tokens: WhyTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  for (const c of calls) {
    const p = partsOf(c)
    for (const k of Object.keys(parts) as Array<keyof WhyParts>) parts[k] += p[k]
    tokens.input += c.usage.inputTokens
    tokens.output += c.usage.outputTokens
    tokens.cacheRead += c.usage.cacheReadInputTokens
    tokens.cacheWrite += c.usage.cacheCreationInputTokens
  }
  return { parts, tokens }
}

const costOf = (calls: ParsedApiCall[]) => calls.reduce((s, c) => s + c.costUSD, 0)

// One tier down, offered only as a repricing of the same tokens.
export function tierDown(model: string): string | null {
  const m = model.toLowerCase()
  if (m.includes('fable')) return 'claude-opus-5-5'
  if (m.includes('opus')) return 'claude-sonnet-5'
  if (m.includes('sonnet')) return 'claude-haiku-4-5'
  return null
}

function repriced(calls: ParsedApiCall[]): WhyAlt | null {
  const models = new Set(calls.map(c => c.model))
  const alt = models.size === 1 ? tierDown([...models][0]!) : null
  if (!alt) return null
  const cost = calls.reduce((s, c) => s + calculateCost(alt, c.usage.inputTokens, c.usage.outputTokens, c.usage.cacheCreationInputTokens,
    c.usage.cacheReadInputTokens, c.usage.webSearchRequests, c.speed, c.cacheCreationOneHourTokens ?? 0), 0)
  return cost > 0 && cost < costOf(calls) ? { model: getShortModelName(alt), cost } : null
}

// ── transcript reading ─────────────────────────────────────────────────

type ToolUse = { id: string; name: string; input: Record<string, unknown>; ts: number }
type Result = { ts: number; isError: boolean; text: string; tur: Record<string, unknown> }
type Msg = { firstTs: number; lastTs: number; toolUses: ToolUse[] }
type Read = {
  calls: ParsedApiCall[]
  turns: ReturnType<typeof groupIntoTurns>
  msgs: Map<string, Msg>
  results: Map<string, Result>
  inputs: Array<{ ts: number; kind: 'tool' | 'message' }>
  durations: Array<{ ts: number; ms: number }>
  compactions: number[]
  pastes: Map<number, number>
  systemTs: Set<string>
  title: string
  cwd: string
  spawnLinks: Record<string, string>
  spawnIds: string[]
}

const MAX_CONTENT_LINE_BYTES = 64 * 1024 * 1024
function fullEntry(line: Buffer): JournalEntry | null {
  try { return JSON.parse(line.toString('utf-8')) as JournalEntry } catch { return null }
}

const ms = (ts: unknown) => (typeof ts === 'string' ? Date.parse(ts) : NaN)

function blockText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(b => (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : '')).join('\n')
}

async function readTranscript(filePath: string): Promise<Read> {
  const compacted: JournalEntry[] = []
  const toolMeta = new Map<string, ToolResultMeta>()
  const sessionMeta = emptySessionMeta()
  const r: Read = { calls: [], turns: [], msgs: new Map(), results: new Map(), inputs: [], durations: [], compactions: [], pastes: new Map(), systemTs: new Set(), title: '', cwd: '', spawnLinks: {}, spawnIds: [] }
  for await (const line of readSessionLines(filePath, undefined, { largeLineAsBuffer: true })) {
    const parsed = parseJsonlLine(line)
    if (!parsed) continue
    collectToolResultMeta(parsed, toolMeta)
    collectSessionMeta(parsed, sessionMeta)
    compacted.push(compactEntry(parsed))
    // The parser's large-line scanner keeps only the fields it prices; the
    // content view needs the whole entry (tool output) when it fits.
    const e = Buffer.isBuffer(line) && line.length <= MAX_CONTENT_LINE_BYTES ? fullEntry(line) ?? parsed : parsed
    const ts = ms(e.timestamp)
    if (typeof e.cwd === 'string' && e.cwd) r.cwd = e.cwd
    if (e.type === 'system') {
      if (e['subtype'] === 'turn_duration' && typeof e['durationMs'] === 'number') r.durations.push({ ts, ms: e['durationMs'] })
      if (e['subtype'] === 'compact_boundary') r.compactions.push(ts)
      continue
    }
    const content = (e.message as { content?: unknown } | undefined)?.content
    if (e.type === 'assistant') {
      const id = (e.message as { id?: string } | undefined)?.id
      if (!id) continue
      const m = r.msgs.get(id) ?? { firstTs: ts, lastTs: ts, toolUses: [] }
      m.lastTs = ts
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type !== 'tool_use' || !b.id || m.toolUses.some(t => t.id === b.id)) continue
          m.toolUses.push({ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown>, ts })
          if (b.name === 'Agent' || b.name === 'Task') r.spawnIds.push(b.id)
        }
      }
      r.msgs.set(id, m)
      continue
    }
    if (e.type !== 'user' || !Number.isFinite(ts)) continue
    const hasResult = Array.isArray(content) && content.some(b => b?.type === 'tool_result')
    r.inputs.push({ ts, kind: hasResult ? 'tool' : 'message' })
    if (hasResult) {
      const tur = e['toolUseResult']
      for (const b of content as Array<Record<string, unknown>>) {
        if (b?.['type'] !== 'tool_result' || typeof b['tool_use_id'] !== 'string') continue
        r.results.set(b['tool_use_id'], { ts, isError: b['is_error'] === true, text: blockText(b['content']), tur: tur && typeof tur === 'object' ? tur as Record<string, unknown> : {} })
      }
    } else {
      const text = blockText(content)
      if (e['isMeta'] === true || e['isCompactSummary'] === true || SYSTEM_PROMPT.test(text)) r.systemTs.add(String(e.timestamp))
      const pasted = text.match(/<pasted_content[\s\S]*?(<\/pasted_content>|$)/g)
      if (pasted) r.pastes.set(ts, pasted.join('').length)
    }
  }
  // The parser starts a turn on any user text, including helper hand-backs and
  // other injected messages; fold those into the prompt they arrived under so
  // the list is the prompts a person typed. Every call still lands in one turn.
  for (const t of groupIntoTurns(dedupeStreamingMessageIds(compacted), new Set(), toolMeta)) {
    const prev = r.turns.at(-1)
    if (prev && r.systemTs.has(t.timestamp)) prev.assistantCalls.push(...t.assistantCalls)
    else r.turns.push({ ...t, assistantCalls: [...t.assistantCalls] })
  }
  r.calls = r.turns.flatMap(t => t.assistantCalls)
  r.title = sessionMeta.title ?? ''
  r.spawnLinks = sessionMeta.agentSpawnLinks
  return r
}

// ── helpers (sub-agent transcripts) ─────────────────────────────────────

type HelperRun = WhyHelper & { toolUseId: string; startTs: number; callList: ParsedApiCall[]; spawnIds: string[] }

async function jsonlUnder(dir: string, out: string[] = []): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name)
    if (e.isDirectory()) await jsonlUnder(p, out)
    else if (e.name.endsWith('.jsonl')) out.push(p)
  }
  return out
}

async function readHelpers(sessionFile: string, spawnLinks: Record<string, string>): Promise<HelperRun[]> {
  const files = await jsonlUnder(join(sessionFile.replace(/\.jsonl$/, ''), 'subagents'))
  const helpers: HelperRun[] = []
  for (const file of files.sort()) {
    const read = await readTranscript(file)
    let meta: { toolUseId?: unknown; description?: unknown; agentType?: unknown } = {}
    try { meta = JSON.parse(await readFile(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')) } catch { /* no sidecar */ }
    const id = basename(file, '.jsonl')
    const toolUseId = typeof meta.toolUseId === 'string' ? meta.toolUseId : spawnLinks[id.replace(/^agent-/, '')] ?? ''
    helpers.push({
      id,
      toolUseId,
      description: typeof meta.description === 'string' ? redact(meta.description) : '',
      agentType: typeof meta.agentType === 'string' ? meta.agentType : '',
      models: [...new Set(read.calls.map(c => getShortModelName(c.model)))],
      calls: read.calls.length,
      cost: costOf(read.calls),
      nested: false,
      loose: false,
      startTs: Math.min(...read.calls.map(c => ms(c.timestamp)).filter(Number.isFinite)),
      callList: read.calls,
      spawnIds: read.spawnIds,
    })
  }
  return helpers
}

// ── steps ───────────────────────────────────────────────────────────────

// Tallies and log pointers that follow the real error ("Found 1 error.").
const SUMMARY_LINE = /^\s*(Found \d+ errors?|\d+ (failed|errors?)\b|npm (ERR!|error) (A complete log|code|path|errno|command|Lifecycle|Failed at|This is probably))/
const ERR_LINE = /\b(error|Error|ERROR|ERR!|No such file|not found|failed|FAIL|Exception|denied|fatal)\b/

// What ended a failed command: the exit code, then the exception line of the
// last traceback, otherwise the last error-looking line.
export function errorCause(text: string): WhyError {
  const lines = text.split('\n')
  const exit = /Exit code (\d+)/.exec(lines[0] ?? '')
  const tb = lines.reduce((last, l, i) => (l.startsWith('Traceback (most recent call last)') ? i : last), -1)
  let cause: string | null = null
  let causeIdx = -1
  let location: string | null = null
  if (tb >= 0) {
    for (let i = tb + 1; i < lines.length; i++) if (lines[i]!.trim() && !/^\s/.test(lines[i]!)) { cause = lines[i]!.trim(); causeIdx = i; break }
    for (let i = tb + 1; i < (causeIdx < 0 ? lines.length : causeIdx); i++) {
      const m = /^\s*File "(.+?)", line (\d+)/.exec(lines[i]!)
      if (m) location = `${m[1]}, line ${m[2]}`
    }
  } else {
    for (let i = lines.length - 1; i >= (exit ? 1 : 0); i--) if (ERR_LINE.test(lines[i]!) && !SUMMARY_LINE.test(lines[i]!)) { cause = lines[i]!.trim(); causeIdx = i; break }
    if (!cause) for (let i = lines.length - 1; i >= (exit ? 1 : 0); i--) if (lines[i]!.trim()) { cause = lines[i]!.trim(); causeIdx = i; break }
  }
  const secondary = lines
    .map((l, i) => ({ l: l.trim(), i }))
    .filter(({ l, i }) => i > (exit ? 0 : -1) && ERR_LINE.test(l) && !SUMMARY_LINE.test(l) && (tb < 0 || i < tb) && i !== causeIdx)
    .map(x => redact(capLine(x.l)))
    .slice(-3)
  return { exitCode: exit ? Number(exit[1]) : null, cause: cause === null ? null : redact(capLine(cause)), location, secondary }
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')

// `cd dir && FOO=1 cmd` -> `cmd`: the part that names what ran.
function stripSetup(cmd: string): string {
  let c = cmd.split('\n')[0]!
  for (let prev = ''; prev !== c;) { prev = c; c = c.replace(/^\s*(cd\s+("[^"]*"|'[^']*'|\S+)|[A-Z_]+=("[^"]*"|\S+))\s*(&&|;)\s*/, '') }
  return c
}

function toolLabel(name: string, input: Record<string, unknown>): string {
  if (name === 'Bash') return stripSetup(str(input['command'])).slice(0, 100)
  if (['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) return basename(str(input['file_path']) || str(input['notebook_path']))
  if (name === 'Agent' || name === 'Task') return str(input['description'])
  if (name === 'Grep' || name === 'Glob') return str(input['pattern'])
  if (name === 'WebFetch') return str(input['url'])
  if (name === 'WebSearch' || name === 'ToolSearch') return str(input['query'])
  if (name === 'Skill') return str(input['skill'])
  return ''
}

function toolDetail(name: string, input: Record<string, unknown>, res: Result | undefined): WhyDetail {
  const out = res?.text ?? ''
  const tur = res?.tur ?? {}
  if (name === 'Bash') return { command: redact(capHead(str(input['command']), 40)), description: redact(str(input['description'])), output: redact(capTail(out || [str(tur['stdout']), str(tur['stderr'])].filter(Boolean).join('\n'))) }
  if (name === 'Edit' || name === 'MultiEdit') {
    const patch = Array.isArray(tur['structuredPatch']) ? tur['structuredPatch'] as Array<{ oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }> : []
    const diff = patch.flatMap(h => [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...(Array.isArray(h.lines) ? h.lines : [])]).join('\n')
    return { path: str(input['file_path']), diff: redact(capHead(diff, 60)), ...(res?.isError ? { output: redact(capTail(out)) } : {}) }
  }
  if (name === 'Write') {
    const c = str(input['content'])
    return { path: str(input['file_path']), lines: c.split('\n').length, diff: redact(capHead(c.split('\n').slice(0, 14).map(l => '+' + l).join('\n'), 14)) }
  }
  if (name === 'Read') {
    const f = (tur['file'] ?? {}) as { numLines?: number }
    return { path: str(input['file_path']), ...(typeof f.numLines === 'number' ? { lines: f.numLines } : {}), ...(res?.isError ? { output: redact(capTail(out)) } : {}) }
  }
  return { input: redact(capHead(JSON.stringify(input, null, 1).slice(0, 1200), 30)), output: redact(capTail(out.slice(0, 4000))) }
}

const DETAIL_BUDGET_CHARS = 6_000_000

// ── the view model ──────────────────────────────────────────────────────

const SYSTEM_PROMPT = /^\s*(<task-notification|<command-|<local-command|<system-reminder|<bash-|Another Claude session sent|\[Request interrupted|Caveat:)/
const USER_STOP = /doesn't want to proceed|Request interrupted|was rejected/

function promptOf(text: string, system: boolean): WhyTurn['prompt'] {
  if (system || SYSTEM_PROMPT.test(text)) {
    const cmd = /<command-name>([^<]+)<\/command-name>/.exec(text)?.[1]
    return { text: redact((cmd ?? text.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 200)), kind: 'system' }
  }
  const pasted = /<pasted_content/.test(text)
  return { text: redact(text.replace(/<\/?pasted_content[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 280)), kind: pasted ? 'pasted' : 'text' }
}

function median(values: number[]): number {
  const v = values.filter(x => x > 0).sort((a, b) => a - b)
  if (v.length === 0) return 0
  const mid = v.length >> 1
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2
}

export async function buildSessionWhy(filePath: string): Promise<SessionWhy> {
  const read = await readTranscript(filePath)
  const helpers = await readHelpers(filePath, read.spawnLinks)
  const helperByTool = new Map(helpers.filter(h => h.toolUseId).map(h => [h.toolUseId, h]))
  const stepResult = new Map<WhyStep, Result>()
  let budget = DETAIL_BUDGET_CHARS
  let detailsOmitted = false

  // Every priced call in time order, for "later calls" math.
  const allCalls: Array<{ call: ParsedApiCall; ts: number; turn: number; toolUse: boolean }> = []
  const turns: WhyTurn[] = read.turns.map((pt, ti) => {
    const firstCallTs = ms(pt.assistantCalls[0]?.timestamp)
    const start = Number.isFinite(ms(pt.timestamp)) ? ms(pt.timestamp) : firstCallTs
    const steps: WhyStep[] = []
    const turnHelpers: WhyHelper[] = []
    let end = start
    for (const call of pt.assistantCalls) {
      const id = call.deduplicationKey.split(':advisor:')[0]!
      const m = read.msgs.get(id)
      const firstTs = m?.firstTs ?? ms(call.timestamp)
      const lastTs = m?.lastTs ?? firstTs
      const input = read.inputs.filter(x => x.ts <= firstTs).at(-1)
      const sentAt = input && input.ts >= start ? input.ts : start
      const startedBy = !input || input.ts <= start ? 'prompt' : input.kind
      const isAdvisor = call.deduplicationKey.includes(':advisor:')
      allCalls.push({ call, ts: firstTs, turn: ti + 1, toolUse: !isAdvisor && (m?.toolUses.length ?? 0) > 0 })
      steps.push({
        kind: 'model', start: sentAt - start, end: lastTs - start, model: getShortModelName(call.model), cost: call.costUSD, parts: partsOf(call), startedBy,
        tokens: { input: call.usage.inputTokens, output: call.usage.outputTokens, cacheRead: call.usage.cacheReadInputTokens, cacheWrite: call.usage.cacheCreationInputTokens },
      })
      end = Math.max(end, lastTs)
      if (isAdvisor || !m) continue
      for (const tu of m.toolUses) {
        const res = read.results.get(tu.id)
        const helper = helperByTool.get(tu.id)
        if (helper) turnHelpers.push(helper)
        let detail: WhyDetail | null = toolDetail(tu.name, tu.input, res)
        const size = JSON.stringify(detail).length
        // ponytail: one global budget keeps the payload under the app's 16MB pipe cap; per-turn loading if real sessions hit it.
        if (size > budget) { detail = null; detailsOmitted = true } else budget -= size
        if (detail && helper) detail.helper = publicHelper(helper)
        const step: WhyStep = {
          kind: 'tool', start: tu.ts - start, end: (res?.ts ?? tu.ts) - start, name: tu.name, label: redact(toolLabel(tu.name, tu.input)),
          isError: res?.isError === true, ...(res?.isError ? { error: errorCause(res.text) } : {}), ...(helper ? { helperCost: helper.cost } : {}), detail,
        }
        if (res) stepResult.set(step, res)
        steps.push(step)
        end = Math.max(end, res?.ts ?? tu.ts)
      }
    }
    steps.sort((a, b) => a.start - b.start)
    const nextStart = Number.isFinite(ms(read.turns[ti + 1]?.timestamp)) ? ms(read.turns[ti + 1]!.timestamp) : Infinity
    const wall = Math.max(0, ...read.durations.filter(d => d.ts >= start && d.ts < nextStart).map(d => d.ms))
    const { parts, tokens } = sumParts(pt.assistantCalls)
    return {
      i: ti + 1, ts: new Date(start).toISOString(), prompt: promptOf(pt.userMessage, read.systemTs.has(pt.timestamp)), cost: costOf(pt.assistantCalls), parts, tokens,
      calls: pt.assistantCalls.length, models: [...new Set(pt.assistantCalls.map(c => getShortModelName(c.model)))],
      helperCost: 0, helpers: turnHelpers, wallMs: wall || end - start, steps,
    }
  })
  allCalls.sort((a, b) => a.ts - b.ts)

  // Nested helpers go to the prompt whose helper transcript holds the launch call.
  const turnOfHelper = new Map<string, number>()
  turns.forEach(t => t.helpers.forEach(h => turnOfHelper.set(h.id, t.i)))
  for (let changed = true; changed;) {
    changed = false
    for (const h of helpers) {
      if (turnOfHelper.has(h.id)) continue
      const parent = helpers.find(p => h.toolUseId && p.spawnIds.includes(h.toolUseId) && turnOfHelper.has(p.id))
      if (!parent) continue
      h.nested = true
      turnOfHelper.set(h.id, turnOfHelper.get(parent.id)!)
      changed = true
    }
  }
  for (const h of helpers) {
    if (turnOfHelper.has(h.id)) continue
    const t = [...turns].reverse().find(x => Date.parse(x.ts) <= h.startTs) ?? turns[0]
    if (!t) continue
    h.loose = true
    turnOfHelper.set(h.id, t.i)
  }
  for (const h of helpers) {
    const t = turns[(turnOfHelper.get(h.id) ?? 0) - 1]
    if (!t) continue
    if (!t.helpers.includes(h)) t.helpers.push(h)
  }
  for (const t of turns) {
    t.helperCost = t.helpers.reduce((s, h) => s + h.cost, 0)
    t.helpers = t.helpers.map(h => publicHelper(h as HelperRun))
  }

  const total = costOf(read.calls)
  const helperCost = helpers.reduce((s, h) => s + h.cost, 0)
  const med = median(turns.map(t => t.cost))
  const findings = buildFindings({ read, turns, helpers, turnOfHelper, allCalls, stepResult, total, helperCost, median: med })

  const byModel = new Map<string, number>()
  for (const c of read.calls) byModel.set(getShortModelName(c.model), (byModel.get(getShortModelName(c.model)) ?? 0) + c.costUSD)
  const { parts, tokens } = sumParts(read.calls)
  return {
    sessionId: basename(filePath, '.jsonl'),
    title: redact(read.title),
    project: read.cwd,
    startedAt: turns[0]?.ts ?? '',
    endedAt: read.calls.at(-1)?.timestamp ?? '',
    cost: total,
    calls: read.calls.length,
    parts,
    tokens,
    models: [...byModel].map(([model, cost]) => ({ model, cost })).sort((a, b) => b.cost - a.cost),
    helperCost,
    helperCount: helpers.length,
    median: med,
    turns,
    findings,
    rules: WHY_RULES,
    detailsOmitted,
  }
}

function publicHelper(h: HelperRun | WhyHelper): WhyHelper {
  const { id, description, agentType, models, calls, cost, nested, loose } = h
  return { id, description, agentType, models, calls, cost, nested, loose }
}

type FindingInput = {
  read: Read
  turns: WhyTurn[]
  helpers: HelperRun[]
  turnOfHelper: Map<string, number>
  allCalls: Array<{ call: ParsedApiCall; ts: number; turn: number; toolUse: boolean }>
  stepResult: Map<WhyStep, Result>
  total: number
  helperCost: number
  median: number
}

function buildFindings({ read, turns, helpers, turnOfHelper, allCalls, stepResult, total, helperCost, median: med }: FindingInput): WhyFinding[] {
  const R = WHY_RULES
  const out: WhyFinding[] = []
  const share = (usd: number) => (total > 0 ? usd / total : 0)
  const turnCalls = (i: number) => read.turns[i - 1]!.assistantCalls

  // Helpers launched by one prompt.
  for (const t of turns) {
    if (t.helperCost <= 0 || t.helperCost < R.helperShare * (total + helperCost)) continue
    const runs = helpers.filter(h => turnOfHelper.get(h.id) === t.i)
    const calls = runs.flatMap(h => h.callList)
    const direct = runs.filter(h => !h.nested && !h.loose)
    const perHelper = runs.map(h => h.calls)
    out.push({
      id: '', kind: 'helpers', turn: t.i, usd: t.helperCost, share: t.helperCost / (total + helperCost),
      direct: direct.length, nested: runs.filter(h => h.nested).length, loose: runs.filter(h => h.loose).length,
      models: [...new Set(runs.flatMap(h => h.models))], descriptions: direct.map(h => h.description).filter(Boolean),
      ...sumParts(calls), calls: calls.length, minCalls: Math.min(...perHelper), maxCalls: Math.max(...perHelper), alt: repriced(calls),
    })
  }

  // Costly prompts.
  const priced = turns.filter(t => t.cost > 0)
  const top = [...priced].sort((a, b) => b.cost - a.cost)[0]
  const hot = new Set<number>()
  for (const t of priced) {
    const s = share(t.cost)
    if (!((t === top && s >= R.hotspotTopShare) || (t.cost >= R.hotspotMedianX * med && s >= R.hotspotMinShare))) continue
    hot.add(t.i)
    const calls = turnCalls(t.i)
    out.push({
      id: '', kind: 'hotspot', turn: t.i, usd: t.cost, share: s, calls: calls.length, toolCalls: allCalls.filter(c => c.turn === t.i && c.toolUse).length,
      models: t.models, median: med, parts: t.parts, tokens: t.tokens, alt: repriced(calls),
    })
  }

  // A top-tier model mostly running tools, in a prompt not already flagged as costly.
  for (const t of priced) {
    if (hot.has(t.i) || share(t.cost) < R.hotspotMinShare) continue
    const calls = turnCalls(t.i)
    const models = new Set(calls.map(c => c.model))
    const model = [...models][0]!
    if (models.size !== 1 || !/fable|opus|mythos/i.test(model) || calls.length < R.coordinationMinCalls) continue
    const toolCalls = allCalls.filter(c => c.turn === t.i && c.toolUse).length
    if (toolCalls / calls.length < R.coordinationToolShare) continue
    out.push({ id: '', kind: 'coordination', turn: t.i, usd: t.cost, share: share(t.cost), calls: calls.length, toolCalls, model: getShortModelName(model), parts: t.parts, alt: repriced(calls) })
  }

  // Re-reading the context dominates the session.
  const cacheRead = turns.reduce((s, t) => s + t.parts.cacheRead, 0)
  if (allCalls.length >= R.rereadMinCalls && share(cacheRead) >= R.rereadShare) {
    const topRead = [...turns].sort((a, b) => b.parts.cacheRead - a.parts.cacheRead)[0]!
    const tokens = turns.reduce((s, t) => s + t.tokens.cacheRead, 0)
    out.push({ id: '', kind: 'reread', turn: topRead.i, usd: cacheRead, share: share(cacheRead), calls: allCalls.length, avgTokens: tokens / allCalls.length })
  }

  // Failed steps.
  const toolSteps = turns.flatMap(t => t.steps.flatMap((s, k) => (s.kind === 'tool' ? [{ t, s, k, ts: Date.parse(t.ts) + s.start, endTs: Date.parse(t.ts) + s.end }] : [])))
  for (const x of toolSteps) {
    if (!x.s.isError) continue
    const userStopped = USER_STOP.test(stepResult.get(x.s)?.text ?? '')
    // Only within the same prompt: a later prompt is new work, not recovery.
    const nextOk = userStopped ? undefined : toolSteps.find(y => y.t === x.t && y.s.name === 'Bash' && !y.s.isError && y.ts > x.endTs)
    const after = nextOk ? allCalls.filter(c => c.turn === x.t.i && c.ts >= x.endTs && c.ts <= nextOk.ts) : null
    const usd = after ? after.reduce((s, c) => s + c.call.costUSD, 0) : null
    out.push({
      id: '', kind: 'failed', turn: x.t.i, step: x.k, usd, share: usd === null ? null : share(usd), tool: x.s.name, label: x.s.label,
      description: x.s.detail?.description ?? '', error: x.s.error ?? { exitCode: null, cause: null, location: null, secondary: [] }, userStopped, afterCalls: after ? after.length : null,
    })
  }

  // Estimate: a large result or paste carried by later calls, until the next compaction.
  const carry = (chars: number, ts: number) => {
    const tokens = estimateTokensFromChars(chars)
    const stop = read.compactions.find(c => c > ts) ?? Infinity
    const later = allCalls.filter(c => c.ts >= ts && c.ts < stop)
    if (later.length === 0) return null
    const first = later[0]!.call
    const writeUsd = calculateCost(first.model, 0, 0, tokens, 0, 0, first.speed, (first.cacheCreationOneHourTokens ?? 0) > 0 ? tokens : 0)
    const readUsd = later.slice(1).reduce((s, c) => s + calculateCost(c.call.model, 0, 0, 0, tokens, 0, c.call.speed), 0)
    return { tokens, calls: later.length, writeUsd, readUsd }
  }
  for (const x of toolSteps) {
    const res = stepResult.get(x.s)
    if (!res || estimateTokensFromChars(res.text.length) < R.carryTokens) continue
    const c = carry(res.text.length, res.ts)
    if (!c) continue
    out.push({ id: '', kind: 'carry', estimate: true, turn: x.t.i, step: x.k, usd: c.writeUsd + c.readUsd, share: share(c.writeUsd + c.readUsd), source: 'tool', tool: x.s.name, label: x.s.label, chars: res.text.length, ...c })
  }
  for (const [ts, chars] of read.pastes) {
    if (estimateTokensFromChars(chars) < R.carryTokens) continue
    const c = carry(chars, ts)
    const t = [...turns].reverse().find(x => Date.parse(x.ts) <= ts)
    if (!c || !t) continue
    out.push({ id: '', kind: 'carry', estimate: true, turn: t.i, usd: c.writeUsd + c.readUsd, share: share(c.writeUsd + c.readUsd), source: 'paste', tool: '', label: '', chars, ...c })
  }

  // Estimate: the prefix the first call already carried.
  const first = allCalls[0]?.call
  if (first) {
    const tokens = first.usage.inputTokens + first.usage.cacheReadInputTokens + first.usage.cacheCreationInputTokens
    if (tokens >= R.prefixTokens) {
      const later = allCalls.slice(1)
      // Uncached input is never re-read from the cache, so the re-read size is the cached part.
      const cached = first.usage.cacheReadInputTokens + first.usage.cacheCreationInputTokens
      const readers = later.filter(c => c.call.usage.cacheReadInputTokens >= cached)
      const writeUsd = partsOf(first).cacheWrite
      const readUsd = readers.reduce((s, c) => s + calculateCost(c.call.model, 0, 0, 0, cached, 0, c.call.speed), 0)
      out.push({ id: '', kind: 'prefix', estimate: true, turn: 1, usd: writeUsd + readUsd, share: share(writeUsd + readUsd), tokens, cached, uncached: first.usage.cacheCreationInputTokens, writeUsd, readUsd, laterCalls: later.length, readCalls: readers.length })
    }
  }

  // Time only: idle gaps and single long model calls.
  for (const t of turns) {
    let cursor = 0
    t.steps.forEach((s, k) => {
      const endedBy = s.kind !== 'model' ? 'tool' : s.startedBy === 'message' && t.helpers.length > 0 ? 'helper' : s.startedBy
      if (s.start - cursor >= R.idleMs) out.push({ id: '', kind: 'idle', turn: t.i, step: k, usd: null, share: null, timeMs: s.start - cursor, endedBy })
      if (s.kind === 'model' && s.end - s.start >= R.slowCallMs) out.push({ id: '', kind: 'slowCall', turn: t.i, step: k, usd: null, share: null, timeMs: s.end - s.start, model: s.model, outputTokens: s.tokens.output })
      cursor = Math.max(cursor, s.end)
    })
  }

  const rank = (f: WhyFinding) => (f.kind === 'failed' && !f.userStopped ? 0 : f.kind === 'idle' || f.kind === 'slowCall' || (f.kind === 'failed' && f.userStopped) ? 2 : 1)
  const time = (f: WhyFinding) => ('timeMs' in f ? f.timeMs : 0)
  out.sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0) || rank(a) - rank(b) || time(b) - time(a))
  out.forEach((f, i) => { f.id = `f${i + 1}` })
  return out
}

// ── text output (`codeburn sessions --id <id> --why`) ───────────────────

const usd = (n: number) => `$${n.toFixed(2)}`
const pct = (p: number) => (p > 0 && p < 0.01 ? '<1%' : `${Math.round(p * 100)}%`)
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
export function formatWhyTokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  const t = (v: number) => { const s = v.toFixed(1); return s.endsWith('.0') ? s.slice(0, -2) : s }
  return n < 1e6 ? `${t(n / 1e3)}K` : `${t(n / 1e6)}M`
}
export function formatWhyDuration(d: number): string {
  const s = Math.round(d / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`
}

// "Label chunk 0", …, "Label chunk 9" -> "Label chunk 0–9"
export function describeHelpers(descs: string[]): string {
  const m = descs.map(d => /^(.*?)(\d+)$/.exec(d))
  if (descs.length > 1 && m.every(x => x && x[1] === m[0]![1])) {
    const nums = m.map(x => Number(x![2])).sort((a, b) => a - b)
    if (nums.every((n, i) => i === 0 || n === nums[i - 1]! + 1)) return `'${m[0]![1]}${nums[0]}–${nums.at(-1)}'`
  }
  const uniq = [...new Set(descs)]
  return uniq.slice(0, 2).map(d => `'${d}'`).join(', ') + (uniq.length > 2 ? ` and ${uniq.length - 2} more` : '')
}

function partsText(p: WhyParts, t: WhyTokens, calls: number): string {
  const items = [
    { v: p.output, s: `output ${usd(p.output)} (${formatWhyTokens(t.output)} tokens)` },
    { v: p.cacheRead, s: `re-reading context ${usd(p.cacheRead)} (${formatWhyTokens(t.cacheRead)} tokens over ${plural(calls, 'call')})` },
    { v: p.cacheWrite, s: `cache writes ${usd(p.cacheWrite)} (${formatWhyTokens(t.cacheWrite)} tokens)` },
    { v: p.input, s: `uncached input ${usd(p.input)} (${formatWhyTokens(t.input)} tokens)` },
    { v: p.webSearch, s: `web search ${usd(p.webSearch)}` },
  ].filter(i => i.v >= 0.005).sort((a, b) => b.v - a.v).map(i => i.s).join(', ')
  return items ? items.charAt(0).toUpperCase() + items.slice(1) + '.' : ''
}

// The saving is the difference of the two figures as printed, so they add up.
const cents = (n: number) => Number(n.toFixed(2))
const altText = (alt: WhyAlt | null, cost: number, what: string) =>
  alt ? `If ${alt.model} can do ${what}, the same tokens cost ${usd(alt.cost)} (−${usd(cents(cost) - cents(alt.cost))}).` : null

const ENDED_BY = { prompt: 'your prompt', tool: 'a tool result', message: 'a message sent to the agent', helper: 'a helper reporting back' }

export function findingText(f: WhyFinding, why: SessionWhy): { title: string; lines: string[] } {
  const turnCalls = (i?: number) => why.turns[(i ?? 1) - 1]?.calls ?? 0
  switch (f.kind) {
    case 'helpers': {
      const head = f.direct > 0
        ? `Prompt ${f.turn} launched ${f.direct} ${f.models.join('/')} ${f.direct === 1 ? 'helper' : 'helpers'}${f.descriptions.length ? ` (${describeHelpers(f.descriptions)})` : ''}`
        : `${plural(f.loose, 'helper')} started during prompt ${f.turn}`
      const more = (f.nested ? `; they launched ${f.nested} more` : '') + (f.direct > 0 && f.loose ? `; ${f.loose} more started during this prompt` : '')
      return {
        title: `${head}${more}: ${usd(f.usd ?? 0)} in total`,
        lines: [partsText(f.parts, f.tokens, f.calls),
          `They made ${f.minCalls === f.maxCalls ? plural(f.minCalls, 'call') : `${f.minCalls}–${f.maxCalls} calls`} each and re-read an average of ${formatWhyTokens(f.tokens.cacheRead / Math.max(1, f.calls))} tokens per call.`,
          altText(f.alt, f.usd ?? 0, 'these tasks')].filter((l): l is string => !!l),
      }
    }
    case 'hotspot': {
      const mult = f.median > 0 ? (f.usd ?? 0) / f.median : 0
      return {
        title: mult >= 2
          ? `Prompt ${f.turn}: ${f.calls} ${f.models.join('/')} ${f.calls === 1 ? 'call' : 'calls'}, ${usd(f.usd ?? 0)}, ${Math.round(mult)}× the session's median prompt (${usd(f.median)})`
          : `Prompt ${f.turn}: ${f.calls} ${f.models.join('/')} ${f.calls === 1 ? 'call' : 'calls'}, ${usd(f.usd ?? 0)}, ${pct(f.share ?? 0)} of the session`,
        lines: [partsText(f.parts, f.tokens, f.calls), f.toolCalls ? (f.calls === 1 ? 'The one call ran tools.' : `${f.toolCalls} of the ${f.calls} calls ran tools.`) : '', altText(f.alt, f.usd ?? 0, 'this prompt')].filter((l): l is string => !!l),
      }
    }
    case 'coordination':
      return {
        title: `Prompt ${f.turn}: ${f.toolCalls} of ${f.calls} ${f.model} calls ran tools, ${usd(f.usd ?? 0)}`,
        lines: [partsText(f.parts, why.turns[(f.turn ?? 1) - 1]!.tokens, turnCalls(f.turn)), altText(f.alt, f.usd ?? 0, 'these steps')].filter((l): l is string => !!l),
      }
    case 'reread':
      return {
        title: `Re-reading the context: ${usd(f.usd ?? 0)}, ${pct(f.share ?? 0)} of the session`,
        lines: [`${f.calls} calls re-read an average of ${formatWhyTokens(f.avgTokens)} tokens of context each.`,
          'The context grows through a session; /compact or a fresh session for a new task shrinks what every call re-reads.'],
      }
    case 'failed': {
      if (f.userStopped) return { title: `${f.tool} was stopped by you`, lines: [] }
      const what = f.tool === 'Bash' ? `Command “${(f.description || f.label).slice(0, 80)}”` : `${f.tool}${f.label ? ` (${f.label})` : ''}`
      return {
        title: `${what} failed${f.error.exitCode !== null ? ` with exit code ${f.error.exitCode}` : ''}`,
        lines: [
          f.error.cause ? `Ended with: ${f.error.cause}${f.error.location ? ` (${f.error.location})` : ''}` : 'The tool returned an error.',
          f.error.secondary.length ? `Also in the output: ${f.error.secondary.slice(-2).join('; ')}` : '',
          f.afterCalls !== null ? `After it: ${plural(f.afterCalls, 'model call')} (${usd(f.usd ?? 0)}) up to the next Bash command that succeeded.` : '',
        ].filter(Boolean),
      }
    }
    case 'carry':
      return {
        title: f.source === 'paste'
          ? `Estimate: a pasted block of ${f.chars.toLocaleString('en-US')} characters (≈${formatWhyTokens(f.tokens)} tokens) stayed in context for ${plural(f.calls, 'call')}`
          : `Estimate: one ${f.tool} result of ${f.chars.toLocaleString('en-US')} characters (≈${formatWhyTokens(f.tokens)} tokens) stayed in context for ${plural(f.calls, 'call')}`,
        lines: [`${f.label ? `“${f.label}”. ` : ''}One cache write (${usd(f.writeUsd)}) plus a cache read on each of the ${plural(f.calls - 1, 'call')} after it (${usd(f.readUsd)}): about ${usd(f.usd ?? 0)}.`,
          'Everything in context is re-read by every later call; a narrower read or a capped output keeps it smaller.'],
      }
    case 'prefix':
      return {
        title: `Estimate: the first call already carried ${formatWhyTokens(f.tokens)} tokens`,
        lines: [`Writing the ${formatWhyTokens(f.uncached)} uncached part to the cache cost ${usd(f.writeUsd)} (measured). ${f.readCalls} of the ${plural(f.laterCalls, 'later call')} read at least ${formatWhyTokens(f.cached)} cached tokens; re-reading that much on each of them is about ${usd(f.readUsd)}.`,
          'Fewer MCP tools, a shorter CLAUDE.md or smaller memory files shrink this prefix for every call.'],
      }
    case 'idle':
      return { title: `Prompt ${f.turn}: ${formatWhyDuration(f.timeMs)} ${f.endedBy === 'helper' ? 'waiting on helpers' : 'with nothing running'}`, lines: [`The gap ended with ${ENDED_BY[f.endedBy]}.`] }
    case 'slowCall':
      return { title: `Prompt ${f.turn}: one ${f.model} call took ${formatWhyDuration(f.timeMs)}`, lines: [`Measured from the input that started it to its last streamed block; it produced ${formatWhyTokens(f.outputTokens)} output tokens.`] }
  }
}

export function verdictText(why: SessionWhy): string {
  const top = why.findings.find(f => (f.usd ?? 0) > 0)
  const failed = why.findings.filter(f => f.kind === 'failed' && !f.userStopped).length
  const tail = failed ? ` ${failed === 1 ? 'One step' : `${failed} steps`} failed along the way.` : ''
  if (!top) return 'Nothing stood out: no prompt far above the rest and no helper fan-out.' + tail
  const amount = usd(top.usd ?? 0)
  if (top.kind === 'helpers') return `Helpers launched by prompt ${top.turn} cost ${amount}, ${pct(top.share ?? 0)} of this session and its helpers.` + tail
  if (top.kind === 'hotspot') return `Prompt ${top.turn} alone cost ${amount}, ${pct(top.share ?? 0)} of the session.` + tail
  if (top.kind === 'reread') return `Re-reading the growing context cost ${amount}, ${pct(top.share ?? 0)} of the session.` + tail
  return `${findingText(top, why).title}.` + tail
}

const RULE_TEXT = (r: typeof WHY_RULES) => [
  `Costly prompt: the costliest prompt when it is ≥${r.hotspotTopShare * 100}% of the session, or any prompt ≥${r.hotspotMedianX}× the median prompt and ≥${r.hotspotMinShare * 100}% of the session.`,
  `Helpers: runs launched by one prompt (and the helpers they launched) costing ≥${r.helperShare * 100}% of the session plus its helpers. Each helper is priced like its own row in the Sessions list.`,
  `Tool-heavy prompt: a prompt on a top-tier model where ≥${r.coordinationToolShare * 100}% of ≥${r.coordinationMinCalls} calls ran tools.`,
  `Re-reading: cache reads ≥${r.rereadShare * 100}% of the session over ≥${r.rereadMinCalls} calls.`,
  'Cost parts: uncached input, output, cache reads, cache writes and web search priced separately with CodeBurn\'s pricing (1-hour cache writes at their own rate); they add up to the total.',
  'Repricing: the same calls with the same tokens at the rates of one tier down (Fable → Opus 5.5, any Opus including 4.x → Sonnet 5, Sonnet → Haiku 4.5), shown only when cheaper. It does not predict how many tokens that model would use.',
  'Failed step: the exit code and the line that ended the run (the exception of the last traceback, otherwise the last error line, otherwise the last non-empty line). After it: model calls up to the next Bash command that succeeded in the same prompt.',
  `Estimate, carried result: a tool result or paste ≥${r.carryTokens / 1000}K tokens (characters ÷ 4): one cache write on the next call plus a cache read on each later call, up to the next compaction.`,
  `Estimate, starting context: the first call's prompt when ≥${r.prefixTokens / 1000}K tokens: its measured cache write plus a cache read of its cached part on each later call that read at least that many cached tokens.`,
  `Time only: ≥${r.idleMs / 1000}s inside a prompt with nothing running, or one model call ≥${r.slowCallMs / 1000}s.`,
]

export function renderSessionWhyText(why: SessionWhy): string {
  const out: string[] = []
  const day = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
  const clock = (iso: string) => new Date(iso).toTimeString().slice(0, 5)
  out.push(why.title || why.sessionId)
  out.push(`${why.project ? basename(why.project) + ' · ' : ''}${why.sessionId.slice(0, 8)} · ${day(why.startedAt)} ${clock(why.startedAt)}–${day(why.endedAt) === day(why.startedAt) ? '' : day(why.endedAt) + ' '}${clock(why.endedAt)}`)
  out.push('')
  out.push(`${usd(why.cost)} this session${why.helperCount ? `  +${usd(why.helperCost)} in ${plural(why.helperCount, 'helper')}` : ''}  ·  ${plural(why.turns.length, 'prompt')} · ${plural(why.calls, 'call')} · ${formatWhyDuration(Date.parse(why.endedAt) - Date.parse(why.startedAt))}`)
  out.push(verdictText(why))
  out.push('')
  out.push(why.findings.length ? 'Worth a look, ranked by cost' : 'Nothing flagged.')
  for (const f of why.findings) {
    const { title, lines } = findingText(f, why)
    const figure = f.usd === null ? ('timeMs' in f ? formatWhyDuration(f.timeMs) : '') : `${'estimate' in f ? '≈' : ''}${usd(f.usd)}`
    const of = f.share === null ? '' : `${pct(f.share)} of ${f.kind === 'helpers' ? 'session + helpers' : 'session'}`
    out.push(`  ${figure.padStart(9)}  ${of.padEnd(26)}  ${title}`)
    for (const l of lines) out.push(`${' '.repeat(41)}${l}`)
  }
  out.push('')
  out.push('Spend by prompt')
  out.push(`  ${'#'.padStart(3)}  ${'time'.padEnd(5)}  ${'cost'.padStart(8)}  ${'helpers'.padStart(8)}  ${'wall'.padStart(7)}  prompt`)
  for (const t of why.turns) {
    out.push(`  ${String(t.i).padStart(3)}  ${clock(t.ts)}  ${usd(t.cost).padStart(8)}  ${(t.helperCost ? usd(t.helperCost) : '').padStart(8)}  ${formatWhyDuration(t.wallMs).padStart(7)}  ${t.prompt.kind === 'system' ? '[system] ' : ''}${t.prompt.text.slice(0, 80)}`)
  }
  out.push('')
  out.push('How we flag (≈ marks an estimate)')
  for (const r of RULE_TEXT(why.rules)) out.push(`  - ${r}`)
  out.push('  - Totals use the same parser and pricing as `codeburn sessions`, over every call in this transcript.')
  out.push('  - Prompts are the messages sent to the agent (typed or injected); helper hand-backs, notifications and command output count under the prompt they arrived in.')
  return out.join('\n')
}

export async function runSessionWhy(id: string, format: string): Promise<number> {
  const { findClaudeSession } = await import('./context-tree.js')
  const ref = await findClaudeSession(id)
  if (!ref) {
    process.stderr.write(`codeburn: no Claude Code session matches "${id}". --why reads Claude Code sessions only.\n`)
    return 1
  }
  const why = await buildSessionWhy(ref.filePath)
  process.stdout.write((format === 'json' ? JSON.stringify(why) : renderSessionWhyText(why)) + '\n')
  return 0
}

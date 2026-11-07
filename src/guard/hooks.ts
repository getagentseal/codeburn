// ===========================================================================
// Claude Code hook protocol, verified against the live docs on 2026-07-03
// (https://docs.anthropic.com/en/docs/claude-code/hooks -> 301 ->
// https://code.claude.com/docs/en/hooks, and .../statusline). The spec's field
// names were NOT trusted; these are the doc's:
//
// Event names (exact casing): PreToolUse, SessionStart, Stop.
// stdin JSON (snake_case) common to every event: session_id, transcript_path,
//   cwd, hook_event_name, permission_mode. PreToolUse adds tool_name +
//   tool_input; SessionStart adds source (startup|resume|clear|compact).
//   PreToolUse also carries tool_use_id. The transcript is written
//   asynchronously and may lag, so the incoming call is read from stdin, never
//   assumed to be in the transcript yet.
//   statusLine stdin differs: session_id, transcript_path, workspace.current_dir,
//   cost.total_cost_usd (plain text out; each stdout line renders as its own
//   status row, so we emit exactly one).
// Exit/stdout contract: exit 0 -> stdout parsed as JSON output; exit 2 ->
//   blocking, stderr fed to the model. We ALWAYS exit 0 and encode any decision
//   as JSON, so an internal error is indistinguishable from "no opinion"
//   (fail-open). Empty stdout = no effect.
// PreToolUse block: { hookSpecificOutput: { hookEventName: "PreToolUse",
//   permissionDecision: "deny", permissionDecisionReason } } (permissionDecision
//   is allow|deny|ask|defer). Non-blocking user note anywhere: top-level
//   systemMessage. A note for the model on PreToolUse (checked 2026-11-04):
//   hookSpecificOutput.additionalContext, ignored only under "defer". We send it
//   with no permissionDecision, because "allow" would also skip the user's
//   permission prompt.
// SessionStart context: { hookSpecificOutput: { hookEventName: "SessionStart",
//   additionalContext } }; SessionStart cannot block.
// Stop: may block via top-level { decision: "block", reason } or exit 2; we
//   never do; a non-blocking nudge uses systemMessage (additionalContext on Stop
//   would force the conversation to continue, which we do not want).
// settings.json shape: { hooks: { <Event>: [ { matcher?, hooks: [ { type:
//   "command", command } ] } ] } }. Stop takes no matcher; SessionStart matcher
//   is startup|resume|clear|compact; an omitted matcher matches all. Statusline
//   is a top-level statusLine: { type: "command", command }.
// ===========================================================================
import { BASH_TOOLS } from '../classifier.js'
import { isReadShapedBashCommand } from '../bash-utils.js'
import { readGuardConfig } from './store.js'
import {
  computeSessionUsage,
  GUARD_DENY_MARK,
  identicalRun,
  inputHash,
  isAllowed,
  readCache,
  recordToolCall,
  writeCache,
  type GuardCache,
} from './usage.js'
import { FLAG_STALE_MS, flagsAgeMs, matchFlag, readFlags } from './flags.js'

export type HookOpts = { base?: string }

function str(obj: unknown, key: string): string | undefined {
  if (obj && typeof obj === 'object') {
    const v = (obj as Record<string, unknown>)[key]
    if (typeof v === 'string') return v
  }
  return undefined
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`
}

function reached(n: number, threshold: number | null): boolean {
  return threshold !== null && n >= threshold
}

function markSignal(cache: GuardCache, signal: 'loop' | 'retry'): void {
  if (signal === 'loop') cache.loopWarned = true
  else cache.retryWarned = true
  cache.signalWarnCostUSD ??= cache.costUSD
}

// The shared read list leaves gh out (it has mutating subcommands); these only inspect.
const GH_READ = /^(?:[A-Za-z_]\w*=\S*[^\S\n]+)*gh\s+[\w-]+\s+(?:view|list|checks|status|diff|watch)\b[^;&|\n]*$/
// A bare echo after a sleep is a blind timer wait: no redirection, chaining or substitution.
const BARE_ECHO = /^echo(?:[^\S\n]+(?:[^;&|<>`$\n]|\$(?!\())*)?$/

// `sleep 30 && gh run view 1` waits on something; it is not a loop or a retry as long as
// what runs after the sleep only reads. `sleep 0; npm test` still counts.
// `sleep 0; git status` on repeat is exempt on purpose: the guard stops runaway
// cost, and a repeated read-only check is cheap whatever the sleep length.
function isWaitingCheck(command: string): boolean {
  const m = /^\s*sleep\s+\d+(?:\.\d+)?[smhd]?\s*(?:(&&|;|\|\|)([\s\S]*))?$/.exec(command)
  if (!m) return false
  // The shared read list counts `env` as a read and does not split lines, so
  // `sleep 5 && env CI=1 npm run build` or a second line would pass as a check.
  // Blank and comment lines are dropped; any other later line is work. An env
  // that only sets variables is dropped and what it runs is checked; any other
  // env (flags, or bare) is not a check.
  const lines = (m[2] ?? '').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  if (lines.length > 1) return false
  // `sleep 5 &&` or a check ending in && or | is unfinished, not a check.
  if ((m[1] && m[1] !== ';' && lines.length === 0) || /^(?:&&|\|\|?|;)|(?:&&|\|\|?)$/.test(lines[0] ?? '')) return false
  const rest = (lines[0] ?? '').replace(
    /(^|[;&|][^\S\n]*)env(?:[^\S\n]+[A-Za-z_]\w*=(?:'[^'\n]*'|"[^"\n]*"|[^\s'"])*)*[^\S\n]+/g,
    '$1',
  )
  if (/(?:^|[\s;&|])env(?=\s|$)/.test(rest)) return false
  return !rest || isReadShapedBashCommand(rest) || GH_READ.test(rest) || BARE_ECHO.test(rest)
}

// The reason goes to the model; how to lift the stop goes only to the user, so
// the agent is never told how to lift its own stop.
// Hook contract (code.claude.com/docs/en/hooks): systemMessage is a warning shown to the user; on a PreToolUse deny, permissionDecisionReason is what Claude sees.
function deny(reason: string, userNote: string): string {
  return JSON.stringify({
    systemMessage: userNote,
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  })
}

async function handlePreToolUse(input: unknown, opts: HookOpts): Promise<string> {
  const sessionId = str(input, 'session_id')
  const transcript = str(input, 'transcript_path')
  if (!sessionId || !transcript) return ''

  const config = await readGuardConfig(opts.base)
  const prev = await readCache(sessionId, opts.base)
  const { cache } = await computeSessionUsage(prev, transcript)
  cache.cwd = str(input, 'cwd') ?? cache.cwd

  const toolName = str(input, 'tool_name')
  const toolInput = (input as { tool_input?: unknown }).tool_input
  const call = toolName ? { id: str(input, 'tool_use_id') ?? '', name: toolName, hash: inputHash(toolInput ?? {}) } : null
  const command = toolName && BASH_TOOLS.has(toolName) ? str(toolInput, 'command') : undefined
  const waiting = command !== undefined && isWaitingCheck(command)
  const run = call && !waiting ? identicalRun(cache, call) : 0
  cache.loopRun = Math.max(cache.loopRun, run)
  const failures = command !== undefined && !waiting ? cache.failedCommands[inputHash(command)] ?? 0 : 0
  const shown = command?.slice(0, 60) ?? ''

  let output = ''
  let denied = false
  const notes: string[] = []
  const agentNotes: string[] = []
  const allowed = await isAllowed(sessionId, opts.base)
  if (config.hardUSD !== null && cache.costUSD >= config.hardUSD && !allowed) {
    // A block is a stronger signal than the soft nag; once blocked, don't also
    // fire a soft warning on the next (e.g. post-`allow`) tool call.
    cache.softWarned = true
    denied = true
    output = deny(
      `${GUARD_DENY_MARK} Session cost passed ${usd(config.hardUSD)}. Stop and ask the user how to continue.`,
      `codeburn guard: session cost passed ${usd(config.hardUSD)}. Run 'codeburn guard allow' to lift the cap for this session, or raise hardUSD in guard.json.`,
    )
  } else if (reached(run, config.loopStopAfter) && !allowed) {
    markSignal(cache, 'loop')
    denied = true
    output = deny(
      `${GUARD_DENY_MARK} ${toolName} was called ${run} times in a row with the same input; this session is ${usd(cache.costUSD)}. Change approach or ask the user.`,
      `codeburn guard: stopped ${toolName} after ${run} identical calls in a row. Run 'codeburn guard allow' to lift this for the session, or raise loopStopAfter in guard.json.`,
    )
  } else if (reached(failures, config.retryStopAfter) && !allowed) {
    markSignal(cache, 'retry')
    denied = true
    output = deny(
      `${GUARD_DENY_MARK} The command "${shown}" already failed ${failures} times; this session is ${usd(cache.costUSD)}. Change approach or ask the user.`,
      `codeburn guard: stopped "${shown}" after ${failures} failures in a row. Run 'codeburn guard allow' to lift this for the session, or raise retryStopAfter in guard.json.`,
    )
  } else {
    if (config.softUSD !== null && cache.costUSD >= config.softUSD && !cache.softWarned) {
      cache.softWarned = true
      notes.push(`codeburn guard: this session is ${usd(cache.costUSD)} (soft cap ${usd(config.softUSD)}).`)
    }
    if (reached(run, config.loopWarnAfter) && !cache.loopWarned) {
      markSignal(cache, 'loop')
      notes.push(`codeburn guard: ${toolName} was called ${run} times in a row with the same input.`)
      agentNotes.push(`${notes[notes.length - 1]} Change approach or ask the user.`)
    }
    if (reached(failures, config.retryWarnAfter) && !cache.retryWarned) {
      markSignal(cache, 'retry')
      notes.push(`codeburn guard: the command "${shown}" already failed ${failures} times.`)
      agentNotes.push(`${notes[notes.length - 1]} Change approach or ask the user.`)
    }
    if (notes.length > 0) {
      output = JSON.stringify({
        systemMessage: notes.join('\n'),
        ...(agentNotes.length > 0
          ? { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: agentNotes.join('\n') } }
          : {}),
      })
    }
  }

  // Without a tool_use_id the transcript copy cannot be told apart from ours,
  // so the call is left for the transcript to record.
  if (call?.id) recordToolCall(cache, denied ? { ...call, denied } : call)
  await writeCache(cache, opts.base)
  return output
}

async function handleSessionStart(input: unknown, opts: HookOpts): Promise<string> {
  const cwd = str(input, 'cwd')
  if (!cwd) return ''
  const config = await readGuardConfig(opts.base)
  if (!config.openerEnabled) return ''
  const flags = await readFlags(opts.base)
  if (!flags || flagsAgeMs(flags) > FLAG_STALE_MS) return ''
  const openers = matchFlag(flags, cwd)
  if (openers.length === 0) return ''
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: openers.join('\n\n') },
  })
}

async function handleStop(input: unknown, opts: HookOpts): Promise<string> {
  const sessionId = str(input, 'session_id')
  const transcript = str(input, 'transcript_path')
  if (!sessionId || !transcript) return ''

  const config = await readGuardConfig(opts.base)
  const prev = await readCache(sessionId, opts.base)
  const { cache } = await computeSessionUsage(prev, transcript)

  let output = ''
  const lines: string[] = []
  if (
    config.checkpointUSD !== null
    && cache.costUSD > config.checkpointUSD
    && !cache.sawEdit
    && !cache.sawGitCommit
    && !cache.stopNotified
  ) {
    cache.stopNotified = true
    lines.push(
      `This session is ${usd(cache.costUSD)} with no edits or commits yet. If exploring is the goal, fine; otherwise consider a fresh session with a named deliverable.`,
    )
  }
  if ((cache.loopWarned || cache.retryWarned) && cache.signalWarnCostUSD !== null && !cache.signalStopNotified) {
    cache.signalStopNotified = true
    const what: string[] = []
    if (cache.loopWarned) what.push(`${cache.loopRun} identical tool calls in a row`)
    if (cache.retryWarned) what.push(`a longest streak of ${cache.retryRun} failed runs of one command`)
    lines.push(
      `codeburn guard: ${what.join(' and ')}; the calls after the first warning cost ${usd(Math.max(0, cache.costUSD - cache.signalWarnCostUSD))}.`,
    )
  }
  if (lines.length > 0) output = JSON.stringify({ systemMessage: lines.join('\n') })

  await writeCache(cache, opts.base)
  return output
}

// The fail-open boundary: parse stdin, dispatch, and turn ANY error, malformed
// payload, or unknown event into exit-0-with-empty-output. A broken guard must
// never block a session.
export async function runGuardHook(event: string, raw: string, opts: HookOpts = {}): Promise<string> {
  try {
    const input = JSON.parse(raw) as unknown
    switch (event.toLowerCase()) {
      case 'pretooluse': return await handlePreToolUse(input, opts)
      case 'sessionstart': return await handleSessionStart(input, opts)
      case 'stop': return await handleStop(input, opts)
      default: return ''
    }
  } catch {
    return ''
  }
}

// statusLine is a separate command, not a hook event. One line: guard's session
// cost and how stale the incremental cache is versus a 5-minute turn TTL.
export const STATUSLINE_TTL_MS = 5 * 60 * 1000

export async function runGuardStatusline(raw: string, opts: HookOpts = {}): Promise<string> {
  try {
    const input = JSON.parse(raw) as unknown
    const sessionId = str(input, 'session_id')
    const transcript = str(input, 'transcript_path')
    if (!sessionId || !transcript) return ''
    const prev = await readCache(sessionId, opts.base)
    const { cache } = await computeSessionUsage(prev, transcript)
    cache.cwd = str((input as { workspace?: unknown }).workspace, 'current_dir') ?? str(input, 'cwd') ?? cache.cwd
    await writeCache(cache, opts.base)
    return `codeburn guard ${usd(cache.costUSD)} · ${freshness(cache.lastTurnAt)}`
  } catch {
    return ''
  }
}

function freshness(lastTurnAt: string | null): string {
  if (!lastTurnAt) return 'no turns yet'
  const age = Date.now() - Date.parse(lastTurnAt)
  if (Number.isNaN(age) || age < 0) return 'fresh'
  const label = age < 60_000 ? `${Math.round(age / 1000)}s` : `${Math.round(age / 60_000)}m`
  return age > STATUSLINE_TTL_MS ? `idle ${label}` : label
}

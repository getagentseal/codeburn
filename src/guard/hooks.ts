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
//   systemMessage.
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
import { readGuardConfig } from './store.js'
import { computeSessionUsage, isAllowed, readCache, writeCache } from './usage.js'
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

async function handlePreToolUse(input: unknown, opts: HookOpts): Promise<string> {
  const sessionId = str(input, 'session_id')
  const transcript = str(input, 'transcript_path')
  if (!sessionId || !transcript) return ''

  const config = await readGuardConfig(opts.base)
  const prev = await readCache(sessionId, opts.base)
  const { cache } = await computeSessionUsage(prev, transcript)

  let output = ''
  if (config.hardUSD !== null && cache.costUSD >= config.hardUSD && !(await isAllowed(sessionId, opts.base))) {
    // A block is a stronger signal than the soft nag; once blocked, don't also
    // fire a soft warning on the next (e.g. post-`allow`) tool call.
    cache.softWarned = true
    output = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `Session cost passed ${usd(config.hardUSD)} (codeburn guard). Run 'codeburn guard allow' to lift the cap for this session, or raise hardUSD in guard.json.`,
      },
    })
  } else if (config.softUSD !== null && cache.costUSD >= config.softUSD && !cache.softWarned) {
    cache.softWarned = true
    output = JSON.stringify({
      systemMessage: `codeburn guard: this session is ${usd(cache.costUSD)} (soft cap ${usd(config.softUSD)}).`,
    })
  }

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
  if (
    config.checkpointUSD !== null
    && cache.costUSD > config.checkpointUSD
    && !cache.sawEdit
    && !cache.sawGitCommit
    && !cache.stopNotified
  ) {
    cache.stopNotified = true
    output = JSON.stringify({
      systemMessage:
        `This session is ${usd(cache.costUSD)} with no edits or commits yet. If exploring is the goal, fine; otherwise consider a fresh session with a named deliverable.`,
    })
  }

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

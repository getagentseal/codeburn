/** Maximum timestamp gap between copied records in Codex's fork replay burst. */
export const CODEX_FORK_REPLAY_MAX_GAP_MS = 1000

export type CodexForkReplayState = {
  startedAtMs: number
  lastReplayAtMs: number
  active: boolean
}

export function startCodexForkReplay(timestamp: string | undefined): CodexForkReplayState | undefined {
  if (!timestamp) return undefined
  const startedAtMs = Date.parse(timestamp)
  if (!Number.isFinite(startedAtMs)) return undefined
  return { startedAtMs, lastReplayAtMs: startedAtMs, active: true }
}

/**
 * Codex rewrites fork history into a timestamp cluster near `session_meta`.
 * A gap over one second ends that cluster, even when the first real turn lands
 * within five seconds of the fork. Entries carrying original parent timestamps
 * stay replay records as long as they precede the fork's metadata timestamp.
 */
export function isCodexForkReplay(state: CodexForkReplayState | undefined, timestamp: string | undefined): boolean {
  if (!state?.active || !timestamp) return false
  const timestampMs = Date.parse(timestamp)
  if (!Number.isFinite(timestampMs)) return false

  // Some spawned sub-agent rollouts retain the parent's original timestamps.
  if (timestampMs < state.startedAtMs) return true

  // A burst that never sees a >1s gap (e.g. rapid tool-call chatter) must
  // still end; five seconds past the fork is well outside any real replay.
  if (timestampMs - state.startedAtMs > 5000) {
    state.active = false
    return false
  }

  // Keep a slightly out-of-order record in the burst without moving the
  // boundary backwards; rollout records are usually ordered, but not required
  // to be strictly monotonic.
  if (timestampMs < state.lastReplayAtMs) return true
  if (timestampMs - state.lastReplayAtMs > CODEX_FORK_REPLAY_MAX_GAP_MS) {
    state.active = false
    return false
  }

  state.lastReplayAtMs = timestampMs
  return true
}

export function isCodexForkReplayState(value: unknown): value is CodexForkReplayState {
  if (!value || typeof value !== 'object') return false
  const state = value as Record<string, unknown>
  return typeof state['startedAtMs'] === 'number'
    && Number.isFinite(state['startedAtMs'])
    && typeof state['lastReplayAtMs'] === 'number'
    && Number.isFinite(state['lastReplayAtMs'])
    && typeof state['active'] === 'boolean'
}

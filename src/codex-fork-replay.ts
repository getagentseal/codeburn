import { stat } from 'fs/promises'
import { basename, dirname } from 'path'

import { readSessionLines } from './fs-utils.js'
import { walkRolloutFiles } from './launcher-homes.js'

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

type CodexUsageCounters = {
  input_tokens?: number
  cached_input_tokens?: number
  cache_write_input_tokens?: number
  output_tokens?: number
  reasoning_output_tokens?: number
  total_tokens?: number
}

const usageCounters = (u: CodexUsageCounters | undefined) => u
  ? [u.input_tokens ?? 0, u.cached_input_tokens ?? 0, u.cache_write_input_tokens ?? 0, u.output_tokens ?? 0, u.reasoning_output_tokens ?? 0, u.total_tokens ?? 0]
  : null

/** Identity of one token_count record, shared by a parent and the fork that copied it. */
export function codexReplayUsageIdentity(info: { total_token_usage?: CodexUsageCounters; last_token_usage?: CodexUsageCounters }): string {
  return JSON.stringify([usageCounters(info.total_token_usage), usageCounters(info.last_token_usage)])
}

export const codexReplayResponseIdentity = (responseId: string): string => `response:${responseId}`

// Rollout names are `rollout-YYYY-MM-DDTHH-MM-SS-<id>.jsonl`.
const ROLLOUT_ID_OFFSET = 'rollout-YYYY-MM-DDTHH-MM-SS-'.length
const rolloutIndexes = new Map<string, Map<string, string | null>>()

function findRollout(home: string, id: string): string | undefined {
  let index = rolloutIndexes.get(home)
  if (!index?.has(id)) {
    index = new Map()
    walkRolloutFiles(home, path => index!.set(basename(path).slice(ROLLOUT_ID_OFFSET, -'.jsonl'.length), path))
    if (!index.has(id)) index.set(id, null)
    rolloutIndexes.set(home, index)
  }
  return index.get(id) ?? undefined
}

function codexHomeOf(path: string): string | undefined {
  for (let dir = dirname(path); dir !== dirname(dir); dir = dirname(dir)) {
    const name = basename(dir)
    if (name === 'sessions' || name === 'archived_sessions') return dirname(dir)
  }
  return undefined
}

type ParentUsage = { sig: string; records: Promise<Array<[number, string]>> }
const parentUsage = new Map<string, ParentUsage>()

async function readParentUsage(path: string): Promise<Array<[number, string]>> {
  const records: Array<[number, string]> = []
  const skip = (head: string) => !head.includes('"token_count"') && !head.includes('"token_usage_record"')
  for await (const line of readSessionLines(path, skip)) {
    let entry: { type?: string; timestamp?: string; payload?: { type?: string; response_id?: unknown; info?: Parameters<typeof codexReplayUsageIdentity>[0] } }
    try { entry = JSON.parse(line) } catch { continue }
    const at = entry.timestamp ? Date.parse(entry.timestamp) : NaN
    if (entry.type === 'token_usage_record' && typeof entry.payload?.response_id === 'string') {
      records.push([at, codexReplayResponseIdentity(entry.payload.response_id)])
    } else if (entry.type === 'event_msg' && entry.payload?.type === 'token_count' && entry.payload.info) {
      records.push([at, codexReplayUsageIdentity(entry.payload.info)])
    }
  }
  return records
}

/**
 * Usage identities the parent rollout recorded up to the fork, read from the
 * parent's raw file (its own copied history included, so a chain resolves one
 * level at a time). Null when the parent is not on disk next to the fork; the
 * caller then drops the whole replay burst.
 */
export async function loadCodexParentReplay(forkPath: string, parentId: string, forkedAtMs: number): Promise<Set<string> | null> {
  const home = codexHomeOf(forkPath)
  const path = home ? findRollout(home, parentId) : undefined
  if (!path || path === forkPath) return null
  let sig: string
  try {
    const st = await stat(path)
    sig = `${st.size}:${st.mtimeMs}`
  } catch {
    return null
  }
  let cached = parentUsage.get(path)
  if (cached?.sig !== sig) {
    cached = { sig, records: readParentUsage(path) }
    parentUsage.set(path, cached)
  }
  // Records the parent wrote after the fork were never copied into it.
  const ids = new Set((await cached.records).filter(([at]) => !(at > forkedAtMs)).map(([, id]) => id))
  return ids.size > 0 ? ids : null
}

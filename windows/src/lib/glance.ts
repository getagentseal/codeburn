/// The data behind the Capacity Dock's glance bubble: the sessions running right now and
/// today's totals. Ported from the LiveSession half of
/// mac/Sources/CodeBurnMenubar/Data/MenubarPayload.swift and AppStore.capacityDockToday.
///
/// Nothing here fetches. `src-tauri/src/glance.rs` keeps the slice of every payload the
/// popover's own fetch goes past and broadcasts it on `codeburn://glance`; the one fetch
/// below is the cold-start case, for a dock opened before any window has asked for a payload.

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { t } from '../i18n'
import { USD, formatCurrency } from './currency'

export type LiveSession = {
  id: string
  /// Provider id, matching the rail row the session runs under.
  provider: string
  /// For Claude sessions, the config directory (or Claude Desktop bucket) the transcript
  /// belongs to, matching a claudeProfiles entry's id. Absent on non-Claude providers and on
  /// payloads from a CLI that predates it.
  claudeConfigSourceId?: string
  project: string
  branch: string | null
  model: string | null
  contextTokens: number | null
  contextWindow: number | null
  startedAt: string
  lastActivityAt: string
  /// Seconds since this session last wrote, as of the payload's build. Absent on payloads
  /// from a CLI that predates it, which reads as "not idle".
  idleSeconds?: number
}

export type LiveSessionsBlock = { windowSeconds: number; sessions: LiveSession[] }

export type GlanceToday = {
  cost: number
  calls: number
  sessions: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/// Both halves are absent for different reasons: no live-session block means the CLI never
/// said (so the section hides rather than claiming nothing is running), no today means no
/// today payload has come back yet.
export type Glance = { liveSessions: LiveSessionsBlock | null; today: GlanceToday | null }

export const EMPTY_GLANCE: Glance = { liveSessions: null, today: null }

/// A live session that is waiting on the user rather than generating. The bubble dims these
/// so the two states are told apart at a glance.
export const IDLE_THRESHOLD_SECONDS = 120

export function isIdle(session: LiveSession): boolean {
  return (session.idleSeconds ?? 0) > IDLE_THRESHOLD_SECONDS
}

/// Row title: the folder in flight, plus the branch when the transcript named one.
export function sessionTitle(session: LiveSession): string {
  return session.branch ? `${session.project} · ${session.branch}` : session.project
}

/// Share of the context window in use, null when the CLI could not read a usage record so the
/// row renders without a gauge.
export function contextFraction(session: LiveSession): number | null {
  const { contextTokens, contextWindow } = session
  if (contextTokens === null || contextWindow === null || contextWindow <= 0) return null
  return Math.min(Math.max(contextTokens / contextWindow, 0), 1)
}

export function contextRemaining(session: LiveSession): number | null {
  const { contextTokens, contextWindow } = session
  if (contextTokens === null || contextWindow === null) return null
  return Math.max(0, contextWindow - contextTokens)
}

/// How long this session has been open, in the same shape the quota rows use for resets.
/// Empty when the timestamp is unparseable.
export function elapsedLabel(session: LiveSession, now = Date.now()): string {
  const started = Date.parse(session.startedAt)
  if (!Number.isFinite(started)) return ''
  const minutes = Math.floor(Math.max(0, now - started) / 60_000)
  const hours = Math.floor(minutes / 60)
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`
}

/// The model name identifies the row; the elapsed time says how long it has been at it.
export function sessionSubtitle(session: LiveSession, now = Date.now()): string {
  return [session.model, elapsedLabel(session, now)].filter(Boolean).join(' · ')
}

/// Sessions the CLI reported under this provider, or null when the payload carried no block
/// at all: the section hides rather than saying "none running" on a CLI that cannot answer.
export function sessionsFor(glance: Glance, providerId: string): LiveSession[] | null {
  if (!glance.liveSessions) return null
  return glance.liveSessions.sessions.filter((session) => session.provider === providerId)
}

/// The Claude sessions belonging to one config directory. A session with no
/// claudeConfigSourceId (Claude Desktop bucket, or an older CLI) belongs to no profile.
export function sessionsForSource(glance: Glance, sourceId: string): LiveSession[] | null {
  if (!glance.liveSessions) return null
  return glance.liveSessions.sessions.filter(
    (session) => session.provider === 'claude' && session.claudeConfigSourceId === sourceId,
  )
}

export function runningLabel(count: number): string {
  if (count === 0) return t('none running')
  if (count === 1) return t('1 running')
  return t('%lld running', count)
}

/// The mac's asCompactTokens with its lowercased thousands: 182k beside the uppercase M and B.
export function compactTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`
  return `${Math.round(n)}`
}

export function thousands(n: number): string {
  return `${Math.round(n)}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/// Raw dollars with grouping, the mac's asUSD. The display currency is deliberately not
/// applied: the dock draws what the CLI reported, as the mac's own dock does.
export function usd(n: number): string {
  return formatCurrency(n, USD)
}

/// The dock's own today key. It is the popover's TODAY_ALL, which is what the Rust cache
/// accepts today's totals from, so a cold dock warms the same cache the popover fills.
const TODAY_ALL = {
  period: 'today',
  provider: 'all',
  days: [] as string[],
  scope: 'local',
  claudeConfigSource: null,
  includeOptimize: false,
}

/// The daily budget in dollars, or null when none is armed. The glance falls back to it for a
/// provider with no quota window at all, where money is the only capacity there is.
export function subscribeDailyBudget(onChange: (budget: number | null) => void): () => void {
  let cancelled = false
  const read = () => {
    void invoke<{ cost: number | null }>('daily_budgets')
      .then((budgets) => {
        if (!cancelled) onChange(budgets.cost ?? null)
      })
      .catch(() => null)
  }
  read()
  const unlisten = listen('codeburn://budget-changed', read)
  return () => {
    cancelled = true
    void unlisten.then((off) => off())
  }
}

/// Subscribes to the cached glance. The cold-start fetch runs at most once, and only when
/// nothing has been cached: its own answer comes back through the same broadcast, so there is
/// one path into the state either way.
export function subscribeGlance(onChange: (glance: Glance) => void): () => void {
  let cancelled = false
  void invoke<Glance | null>('dock_glance')
    .then((cached) => {
      if (cancelled) return null
      if (cached) {
        onChange(cached)
        return null
      }
      return invoke('fetch_payload', TODAY_ALL)
    })
    .catch(() => null)
  const unlisten = listen<Glance>('codeburn://glance', (event) => {
    if (!cancelled) onChange(event.payload)
  })
  return () => {
    cancelled = true
    void unlisten.then((off) => off())
  }
}

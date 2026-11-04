import { calculateCost } from './models.js'
import type { ParsedApiCall, ProjectSummary } from './types.js'
import type { Impact, WasteFinding } from './optimize.js'

const FIVE_MINUTE_TTL_MS = 5 * 60_000
const ONE_HOUR_TTL_MS = 60 * 60_000
const ONE_HOUR_CACHE_MIN_USD = 1
const ONE_HOUR_CACHE_HIGH_USD = 20
const ONE_HOUR_CACHE_MEDIUM_USD = 5

export type OneHourCacheWrite = {
  sessionId: string
  tokens: number
  premiumUSD: number
  nextGapMs?: number
  wasted: boolean
}

function oneHourPremiumUSD(call: ParsedApiCall): number {
  const u = call.usage
  const oneHour = call.cacheCreationOneHourTokens ?? 0
  const billed = (h: number) => calculateCost(
    call.model, u.inputTokens, 0, u.cacheCreationInputTokens, u.cacheReadInputTokens, 0, call.speed, h, call.provider,
  )
  return billed(oneHour) - billed(0)
}

export function oneHourCacheWrites(projects: ProjectSummary[]): OneHourCacheWrite[] {
  const writes: OneHourCacheWrite[] = []
  for (const project of projects) {
    for (const session of project.sessions) {
      const byModel = new Map<string, Array<{ call: ParsedApiCall; ts: number }>>()
      for (const turn of session.turns) {
        for (const call of turn.assistantCalls) {
          if (call.supplementaryAccounting) continue
          const ts = Date.parse(call.timestamp)
          if (!Number.isFinite(ts)) continue
          const list = byModel.get(call.model) ?? []
          list.push({ call, ts })
          byModel.set(call.model, list)
        }
      }
      for (const timeline of byModel.values()) {
        timeline.sort((a, b) => a.ts - b.ts)
        // Reads refresh either TTL, so a write needs the hour only when the first later
        // pause on the same model's cache runs past five minutes and still inside the hour.
        let firstPauseAfter: number | undefined
        for (let i = timeline.length - 1; i >= 0; i--) {
          const { call, ts } = timeline[i]!
          const tokens = call.cacheCreationOneHourTokens ?? 0
          if (tokens > 0) {
            const premiumUSD = oneHourPremiumUSD(call)
            if (premiumUSD > 0) {
              writes.push({
                sessionId: session.sessionId,
                tokens,
                premiumUSD,
                nextGapMs: i + 1 < timeline.length ? timeline[i + 1]!.ts - ts : undefined,
                wasted: firstPauseAfter === undefined || firstPauseAfter > ONE_HOUR_TTL_MS,
              })
            }
          }
          const gap = i > 0 ? ts - timeline[i - 1]!.ts : 0
          if (gap > FIVE_MINUTE_TTL_MS) firstPauseAfter = gap
        }
      }
    }
  }
  return writes
}

function formatGap(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 60_000).toFixed(1)} min`
}

export function detectOneHourCacheUnused(projects: ProjectSummary[]): WasteFinding | null {
  const writes = oneHourCacheWrites(projects)
  const wasted = writes.filter(w => w.wasted)
  const savingsUSD = wasted.reduce((sum, w) => sum + w.premiumUSD, 0)
  if (savingsUSD < ONE_HOUR_CACHE_MIN_USD) return null

  const tokensSaved = wasted.reduce((sum, w) => sum + w.tokens, 0)
  const allTokens = writes.reduce((sum, w) => sum + w.tokens, 0)
  const sessions = new Set(wasted.map(w => w.sessionId)).size
  const gaps = wasted.flatMap(w => w.nextGapMs === undefined ? [] : [w.nextGapMs]).sort((a, b) => a - b)
  const typicalGap = gaps.length > 0
    ? ` The next request usually came ${formatGap(gaps[Math.floor(gaps.length / 2)]!)} later.`
    : ''
  const impact: Impact = savingsUSD > ONE_HOUR_CACHE_HIGH_USD ? 'high' : savingsUSD > ONE_HOUR_CACHE_MEDIUM_USD ? 'medium' : 'low'
  const share = Math.round((tokensSaved / allTokens) * 100)

  return {
    id: 'one-hour-cache-unused',
    title: `${wasted.length} one-hour cache write${wasted.length === 1 ? '' : 's'} the next request never needed`,
    explanation: `A one-hour prompt-cache write costs 1.6 times a five-minute one, and only pays off when the session comes back after a pause of five minutes to an hour. ${wasted.length} write${wasted.length === 1 ? '' : 's'} in ${sessions} session${sessions === 1 ? '' : 's'} (${share}% of one-hour write tokens) never saw such a pause, so the extra 60% bought nothing.${typicalGap} On a subscription this counts against plan usage rather than a bill.`,
    impact,
    tokensSaved,
    savingsUSD,
    fix: {
      type: 'paste',
      destination: 'manual',
      label: 'Match the cache to the session pace:',
      text: 'Claude Code picks the one-hour cache on its own for some accounts. Keep fast or scripted sessions moving (next request within five minutes) so the five-minute cache covers them, and accept the premium only for sessions with real pauses.',
    },
  }
}

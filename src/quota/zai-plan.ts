// Shared decoder for Z.ai's usage/quota/limit response. The Z.ai adapter (Pi
// CLI credential) and the ZCode adapter (coding-plan app login) hit the same
// endpoint with different credentials and receive byte-identical bodies, so
// the window extraction lives here once and each adapter reports it under its
// own provider id.
import type { QuotaProvider, QuotaWindow } from './types.js'

export function nonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Numbers have shipped as JSON numbers and as strings. */
export function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/** Reset stamps arrive as ISO-8601, epoch seconds, or epoch milliseconds. */
export function resetsAt(value: unknown): string | null {
  const epoch = num(value)
  if (epoch !== null) {
    const seconds = epoch < 1_000_000_000_000 ? epoch : epoch / 1000
    return new Date(seconds * 1000).toISOString()
  }
  const raw = nonEmpty(value)
  if (!raw) return null
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

/** Z.ai encodes the window as a unit enum plus a count; only the two the plan
 *  actually meters (5-hour and weekly) have a label. */
export function windowLabel(unit: number | null, count: number | null): string | null {
  if (unit === 3 && count === 5) return '5-hour'
  if (unit === 6 && count === 1) return 'Weekly'
  return null
}

/** "pro" → "Pro", "coding_pro" → "Coding Pro"; missing or blank → null. */
export function planLabel(value: unknown): string | null {
  const raw = nonEmpty(value)
  if (!raw) return null
  return raw.replace(/_/g, ' ').toLowerCase().replace(/(^|\s)\w/g, match => match.toUpperCase())
}

export type ZaiPlanDecoded = QuotaProvider | 'rejected' | null

/** `'rejected'` when the body carries an auth error despite the HTTP status,
 *  `null` when it carries no usable window. */
export function decodeZaiPlanUsage(provider: 'zai' | 'zcode', body: unknown): ZaiPlanDecoded {
  if (!body || typeof body !== 'object') return null
  const root = body as Record<string, any>
  const code = num(root.code)
  if (code === 401 || code === 403) return 'rejected'
  if (root.success === false) return null

  const payload = (root.data && typeof root.data === 'object' ? root.data : root) as Record<string, any>
  if (!Array.isArray(payload.limits)) return null

  let fiveHour: QuotaWindow | null = null
  let weekly: QuotaWindow | null = null
  for (const raw of payload.limits) {
    if (!raw || typeof raw !== 'object') continue
    const limit = raw as Record<string, unknown>
    if (limit.type !== 'CREDIT_LIMIT' && limit.type !== 'TOKENS_LIMIT') continue
    const label = windowLabel(num(limit.unit), num(limit.number))
    if (label === null) continue

    let usedPercent = num(limit.percentage)
    if (usedPercent === null) {
      const current = num(limit.currentValue)
      const total = num(limit.usage)
      if (current !== null && total !== null && total > 0) usedPercent = current / total * 100
    }
    if (usedPercent === null) continue

    const window: QuotaWindow = {
      label,
      percent: Math.min(1, Math.max(0, usedPercent / 100)),
      resetsAt: resetsAt(limit.nextResetTime),
    }
    if (label === 'Weekly') weekly = window
    else fiveHour = window
  }

  const details = [fiveHour, weekly].filter((row): row is QuotaWindow => row !== null)
  if (details.length === 0) return null
  return {
    provider,
    connection: 'connected',
    primary: weekly ?? fiveHour,
    details,
    planLabel: planLabel(payload.level),
    footerLines: ['Source: Z.ai Coding Plan'],
  }
}

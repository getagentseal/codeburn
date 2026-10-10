// Live Command Code quota from its billing endpoints:
//
// - GET https://api.commandcode.ai/alpha/billing/credits
//     windowLimits.{fiveHour,weekly}.{used,cap,resetAt}: USD credits spent of
//     the window's cap; resetAt is epoch ms, 0 while no window is open.
//     credits.{monthlyCredits,purchasedCredits,freeCredits}: USD remaining.
// - GET https://api.commandcode.ai/alpha/billing/subscriptions
//     data.{planId,status,currentPeriodEnd} for the plan label and the monthly
//     window; optional, a failure only drops both.
//
// Credential: the CLI's own ~/.commandcode/auth.json `apiKey`, read-only.
// The API refuses requests without a User-Agent, so one is always sent.
import os from 'node:os'
import path from 'node:path'

import { fraction, quotaRequestSignal, readSecureFile, sanitizeError } from './security.js'
import type { QuotaProvider, QuotaWindow } from './types.js'

const API_BASE = 'https://api.commandcode.ai/alpha/billing'
const EXPIRED_FOOTER = ['Command Code session expired. Sign in with the Command Code CLI again.']
const RATE_LIMITED_FOOTER = ['Command Code rate-limited the quota request.']
const UNAVAILABLE_FOOTER = ['Command Code is temporarily unavailable.']
const PARSE_FOOTER = ['Command Code quota response was malformed.']
// Command Code's API gives no monthly cap, so the plan price comes from this table.
const PLAN_MONTHLY_USD: Record<string, number> = {
  'individual-go': 10, 'individual-go-v1': 10, 'individual-goat': 70, 'individual-pro': 30, 'individual-pro-v1': 80,
  'individual-provider': 15, 'individual-max': 150, 'individual-ultra': 300, 'teams-pro': 40,
}

export type CommandCodeDeps = {
  fetch: typeof fetch
  authPath: string
  readFile: typeof readSecureFile
}

function defaultDeps(): CommandCodeDeps {
  const root = process.env['CODEBURN_COMMANDCODE_DIR'] || path.join(os.homedir(), '.commandcode')
  return { fetch: globalThis.fetch, authPath: path.join(root, 'auth.json'), readFile: readSecureFile }
}

function empty(connection: QuotaProvider['connection'], footerLines: string[] = []): QuotaProvider {
  return { provider: 'commandcode', connection, primary: null, details: [], planLabel: null, footerLines }
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function windowOf(label: string, raw: unknown): QuotaWindow | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  const used = num(row['used'])
  const cap = num(row['cap'])
  if (used === null || cap === null || cap <= 0) return null
  const resetAt = num(row['resetAt'])
  return {
    label,
    percent: fraction(used / cap * 100)!,
    resetsAt: resetAt !== null && resetAt > 0 ? new Date(resetAt).toISOString() : null,
  }
}

/** "individual-go-v1" -> "Go". Unknown shapes pass through unchanged. */
export function commandCodePlanLabel(planId: unknown): string | null {
  if (typeof planId !== 'string' || !planId.trim()) return null
  const core = planId.trim().replace(/^individual-/, '').replace(/-v\d+$/, '')
  return core.charAt(0).toUpperCase() + core.slice(1)
}

function creditsNote(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null
  const credits = raw as Record<string, unknown>
  const parts = ([['monthlyCredits', 'monthly'], ['purchasedCredits', 'purchased'], ['freeCredits', 'free']] as const)
    .map(([key, name]) => ({ name, value: num(credits[key]) }))
    .filter((part): part is { name: typeof part.name; value: number } => part.value !== null)
  if (parts.length === 0) return null
  const shown = parts.filter(part => part.value > 0)
  if (shown.length === 0) return 'Credits left: $0.00'
  return `Credits left: ${shown.map(part => `$${part.value.toFixed(2)} ${part.name}`).join(', ')}`
}

export type CommandCodeSubscription = { planId?: unknown; status?: unknown; currentPeriodEnd?: unknown }

/** Monthly credits used of the plan price; purchased and free credits are not part of the plan. */
function monthlyWindow(credits: unknown, subscription: CommandCodeSubscription): QuotaWindow | null {
  if (subscription.status !== 'active' || typeof subscription.planId !== 'string') return null
  const plan = Object.hasOwn(PLAN_MONTHLY_USD, subscription.planId) ? PLAN_MONTHLY_USD[subscription.planId]! : null
  const left = credits && typeof credits === 'object' ? num((credits as Record<string, unknown>)['monthlyCredits']) : null
  if (plan === null || left === null) return null
  const pool = Math.max(plan, left)
  const end = typeof subscription.currentPeriodEnd === 'string' ? Date.parse(subscription.currentPeriodEnd) : NaN
  return {
    label: 'Monthly',
    percent: fraction((pool - left) / pool * 100)!,
    resetsAt: Number.isFinite(end) ? new Date(end).toISOString() : null,
  }
}

/** `null` when neither the 5-hour nor the weekly window is readable. */
export function decodeCommandCodeCredits(body: unknown, subscription: CommandCodeSubscription = {}): QuotaProvider | null {
  if (!body || typeof body !== 'object') return null
  const root = body as Record<string, unknown>
  const limits = root['windowLimits'] && typeof root['windowLimits'] === 'object'
    ? root['windowLimits'] as Record<string, unknown>
    : {}
  const fiveHour = windowOf('5-hour', limits['fiveHour'])
  const weekly = windowOf('Weekly', limits['weekly'])
  if (!fiveHour && !weekly) return null
  const details = [fiveHour, weekly, monthlyWindow(root['credits'], subscription)]
    .filter((row): row is QuotaWindow => row !== null)
  const note = creditsNote(root['credits'])
  return {
    provider: 'commandcode', connection: 'connected',
    primary: weekly ?? fiveHour!,
    details,
    planLabel: commandCodePlanLabel(subscription.planId),
    footerLines: note ? [note] : [],
    ...(note ? { notes: [note] } : {}),
  }
}

async function readApiKey(deps: CommandCodeDeps): Promise<string | null> {
  const raw = await deps.readFile(deps.authPath, 64 * 1024)
  if (!raw) return null
  const key = (JSON.parse(raw) as Record<string, unknown>)['apiKey']
  return typeof key === 'string' && key.trim() ? key.trim() : null
}

export type CommandCodeResult = { quota: QuotaProvider; retryAfterSeconds?: number }

export async function fetchCommandCodeQuota(options: Partial<CommandCodeDeps> & { signal?: AbortSignal } = {}): Promise<CommandCodeResult> {
  const deps = { ...defaultDeps(), ...options }
  try {
    const key = await readApiKey(deps)
    if (!key) return { quota: empty('disconnected') }

    const signal = quotaRequestSignal(options.signal)
    const get = (endpoint: string) => deps.fetch(`${API_BASE}/${endpoint}`, {
      method: 'GET', signal,
      headers: { Accept: 'application/json', Authorization: `Bearer ${key}`, 'User-Agent': 'CodeBurn' },
    })
    const [credits, subscription] = await Promise.all([get('credits'), get('subscriptions').catch(() => null)])
    if (credits.status === 401 || credits.status === 403) return { quota: empty('terminalFailure', EXPIRED_FOOTER) }
    if (credits.status === 429) {
      const raw = credits.headers.get('Retry-After')
      const seconds = raw === null ? NaN : Number(raw)
      return {
        quota: { ...empty('transientFailure', RATE_LIMITED_FOOTER), rateLimited: true },
        retryAfterSeconds: Math.max(Number.isFinite(seconds) ? Math.ceil(seconds) : 300, 60),
      }
    }
    if (credits.status >= 500) return { quota: empty('transientFailure', UNAVAILABLE_FOOTER) }
    if (!credits.ok) return { quota: empty('transientFailure', PARSE_FOOTER) }
    // Never log either body - they carry account data.
    const plan = subscription?.ok
      ? await subscription.json().then(body => (body as { data?: CommandCodeSubscription })?.data, () => undefined)
      : undefined
    const quota = decodeCommandCodeCredits(await credits.json(), plan && typeof plan === 'object' ? plan : {})
    return { quota: quota ?? empty('transientFailure', PARSE_FOOTER) }
  } catch (error) {
    console.warn(`Command Code quota unavailable: ${sanitizeError(error)}`)
    return { quota: empty('transientFailure') }
  }
}

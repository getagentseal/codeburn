import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Anonymous, consent-gated product telemetry for the desktop app ONLY.
// Runs entirely in the Electron main process. Like cli.ts, this module must
// NOT import `electron` so it stays unit-testable in plain node; main.ts
// injects the electron-derived bits (userData path, country, isPackaged).
//
// Privacy invariants (enforced here, not by the caller):
// - Nothing is ever sent before the user completes the onboarding consent
//   screen, and nothing is sent while the toggle is off.
// - EU/EEA/UK/CH installs default the toggle OFF; everywhere else defaults ON.
//   Either way the user decides on the consent screen.
// - The only identifier is a random UUID minted locally. No fingerprinting.
// - Events carry day-granularity timestamps only, and props pass a whitelist
//   sanitizer (short strings / finite numbers / booleans, capped arrays).
// - Dev / unpackaged builds never send (CODEBURN_TELEMETRY_DEV=1 overrides
//   for end-to-end testing).

export const TELEMETRY_ENDPOINT = 'https://api.codeburn.app/v1/telemetry'
export const TELEMETRY_SCHEMA = 1

// EU-27 + EEA (IS, LI, NO) + UK + CH: conservative "default off" region.
const DEFAULT_OFF_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR',
  'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK',
  'SI', 'ES', 'SE', 'IS', 'LI', 'NO', 'GB', 'CH',
])

export function defaultEnabledFor(country: string | null | undefined): boolean {
  if (!country) return false // unknown region: be conservative
  return !DEFAULT_OFF_COUNTRIES.has(country.toUpperCase())
}

export const EVENT_NAMES = new Set([
  'app_open',
  'app_close',
  'section_view',
  'cold_start',
  'usage_snapshot',
  'cli_error',
])

const MAX_QUEUE = 200
const MAX_STRING = 64
const MAX_ARRAY = 12
const MAX_KEYS = 16

export type TelemetryStatus = {
  installId: string
  country: string | null
  enabled: boolean
  defaultEnabled: boolean
  /** True once the user has been through the onboarding consent screen. */
  onboarded: boolean
}

type PersistedState = {
  version: 1
  installId: string
  enabled: boolean
  onboardedAt?: string
  lastSnapshotDay?: string
}

type Deps = {
  /** Directory for the consent/state file (Electron userData in production). */
  stateDir: string
  /** ISO-3166 alpha-2 from the OS locale, or null when unknown. */
  country: string | null
  /** Only packaged builds send (unless CODEBURN_TELEMETRY_DEV=1). */
  isPackaged: boolean
  appVersion: string
  platform?: string
  arch?: string
  endpoint?: string
  fetchFn?: typeof fetch
  now?: () => Date
}

type QueuedEvent = { name: string; day: string; props: Record<string, unknown> }

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function sanitizeValue(value: unknown): unknown | undefined {
  if (typeof value === 'string') return value.slice(0, MAX_STRING)
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'boolean') return value
  return undefined
}

/** Whitelist sanitizer: primitives, plus one level of arrays-of-flat-objects. */
export function sanitizeProps(props: unknown): Record<string, unknown> {
  if (!props || typeof props !== 'object' || Array.isArray(props)) return {}
  const out: Record<string, unknown> = {}
  let keys = 0
  for (const [key, value] of Object.entries(props as Record<string, unknown>)) {
    if (keys >= MAX_KEYS) break
    const k = key.slice(0, MAX_STRING)
    if (Array.isArray(value)) {
      const items: Record<string, unknown>[] = []
      for (const entry of value.slice(0, MAX_ARRAY)) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
        const flat: Record<string, unknown> = {}
        let inner = 0
        for (const [ik, iv] of Object.entries(entry as Record<string, unknown>)) {
          if (inner >= MAX_KEYS) break
          const sv = sanitizeValue(iv)
          if (sv === undefined) continue
          flat[ik.slice(0, MAX_STRING)] = sv
          inner++
        }
        if (Object.keys(flat).length > 0) items.push(flat)
      }
      if (items.length > 0) { out[k] = items; keys++ }
      continue
    }
    const sv = sanitizeValue(value)
    if (sv === undefined) continue
    out[k] = sv
    keys++
  }
  return out
}

export class Telemetry {
  private readonly deps: Required<Pick<Deps, 'stateDir' | 'country' | 'isPackaged' | 'appVersion'>> & Deps
  private state: PersistedState
  private queue: QueuedEvent[] = []
  private openedAt: number

  constructor(deps: Deps) {
    this.deps = deps
    this.state = this.load()
    this.openedAt = Date.now()
  }

  private stateFile(): string {
    return join(this.deps.stateDir, 'telemetry.v1.json')
  }

  private load(): PersistedState {
    try {
      const raw = JSON.parse(readFileSync(this.stateFile(), 'utf-8')) as Partial<PersistedState>
      if (raw && raw.version === 1 && typeof raw.installId === 'string' && typeof raw.enabled === 'boolean') {
        return {
          version: 1,
          installId: raw.installId,
          enabled: raw.enabled,
          onboardedAt: typeof raw.onboardedAt === 'string' ? raw.onboardedAt : undefined,
          lastSnapshotDay: typeof raw.lastSnapshotDay === 'string' ? raw.lastSnapshotDay : undefined,
        }
      }
    } catch { /* first run or unreadable — start fresh */ }
    return { version: 1, installId: randomUUID(), enabled: defaultEnabledFor(this.deps.country) }
  }

  private save(): void {
    try {
      const file = this.stateFile()
      if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(this.state), { mode: 0o600 })
    } catch { /* consent must still work in-memory */ }
  }

  status(): TelemetryStatus {
    return {
      installId: this.state.installId,
      country: this.deps.country,
      enabled: this.state.enabled,
      defaultEnabled: defaultEnabledFor(this.deps.country),
      onboarded: this.state.onboardedAt !== undefined,
    }
  }

  setEnabled(enabled: boolean): TelemetryStatus {
    this.state.enabled = enabled
    // Opting out mints a fresh id so past and future data cannot be linked.
    if (!enabled) {
      this.queue = []
      this.state.installId = randomUUID()
    }
    this.save()
    return this.status()
  }

  /** The onboarding consent screen's final decision. Unlocks sending. */
  completeOnboarding(enabled: boolean): TelemetryStatus {
    this.state.onboardedAt = new Date().toISOString()
    const next = this.setEnabled(enabled)
    this.track('app_open', {})
    return next
  }

  private get canSend(): boolean {
    if (!this.state.enabled || this.state.onboardedAt === undefined) return false
    return this.deps.isPackaged || process.env.CODEBURN_TELEMETRY_DEV === '1'
  }

  /** Queue an event. Unknown names and junk props are dropped, never thrown. */
  track(name: string, props: unknown): void {
    if (!EVENT_NAMES.has(name)) return
    if (!this.state.enabled) return
    // usage_snapshot is an aggregate: at most one per calendar day.
    const now = (this.deps.now ?? (() => new Date()))()
    if (name === 'usage_snapshot') {
      const day = dayKey(now)
      if (this.state.lastSnapshotDay === day) return
      this.state.lastSnapshotDay = day
      this.save()
    }
    if (this.queue.length >= MAX_QUEUE) return
    this.queue.push({ name, day: dayKey(now), props: sanitizeProps(props) })
  }

  /** Record session duration; queued for the next (final) flush. */
  trackClose(): void {
    this.track('app_close', { sessionMinutes: Math.round((Date.now() - this.openedAt) / 60_000) })
  }

  /** Best-effort batch POST. Keeps the queue on failure, clears on success. */
  async flush(): Promise<boolean> {
    if (!this.canSend || this.queue.length === 0) return false
    const events = this.queue
    const body = JSON.stringify({
      schema: TELEMETRY_SCHEMA,
      installId: this.state.installId,
      app: {
        name: 'codeburn-desktop',
        version: this.deps.appVersion,
        platform: this.deps.platform ?? process.platform,
        arch: this.deps.arch ?? process.arch,
        country: this.deps.country,
      },
      events,
    })
    try {
      const fetchFn = this.deps.fetchFn ?? fetch
      const res = await fetchFn(this.deps.endpoint ?? TELEMETRY_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })
      if (!res.ok) {
        // 4xx is a permanent rejection of this batch (schema drift, bad shape):
        // retrying the same payload forever would wedge the queue at its cap.
        // Drop it. 5xx/network are transient — keep the batch for the next beat.
        if (res.status >= 400 && res.status < 500) this.queue = this.queue.filter(e => !events.includes(e))
        return false
      }
      // Only drop what was sent; events tracked mid-flight stay queued.
      this.queue = this.queue.filter(e => !events.includes(e))
      return true
    } catch {
      return false
    }
  }

  /** Visible for tests. */
  get queueLength(): number {
    return this.queue.length
  }
}

// Live GLM Coding Plan quota via Z.ai's own usage endpoint (ported from the
// menubar's ZaiSubscriptionService.swift):
//
// - GET https://api.z.ai/api/monitor/usage/quota/limit
//     The API key goes in a bare Authorization header, not as a bearer.
//
// The response decoder is shared with the ZCode adapter in ./zai-plan.ts.
//
// Credential, in the order the menubar tries them: a key the user supplied
// (there it is a Keychain entry, here the ZAI_API_KEY environment variable),
// then the Z.ai login the Pi CLI already holds in ~/.pi/agent/auth.json.
// Read-only; the key is used for one request and never persisted or logged.
import os from 'node:os'
import path from 'node:path'

import { quotaRequestSignal, readSecureFile, sanitizeError } from './security.js'
import { decodeZaiPlanUsage, nonEmpty } from './zai-plan.js'
import type { QuotaProvider, QuotaWindow } from './types.js'

const USAGE_ENDPOINT = 'https://api.z.ai/api/monitor/usage/quota/limit'
const SOURCE_FOOTER = ['Source: Z.ai Coding Plan']
const REJECTED_FOOTER = ['Z.ai rejected this API key.']
const RATE_LIMITED_FOOTER = ['Z.ai rate-limited the quota request.']
const UNAVAILABLE_FOOTER = ['Z.ai is temporarily unavailable.']
const PARSE_FOOTER = ['Z.ai returned an unrecognized quota response.']

export type ZaiDeps = {
  fetch: typeof fetch
  /** The Pi CLI's own login store. */
  credentialPath: string
  readFile: typeof readSecureFile
  env: NodeJS.ProcessEnv
}

function defaultDeps(): ZaiDeps {
  return {
    fetch: globalThis.fetch,
    credentialPath: path.join(os.homedir(), '.pi', 'agent', 'auth.json'),
    readFile: readSecureFile,
    env: process.env,
  }
}

function empty(connection: QuotaProvider['connection'], footerLines: string[] = []): QuotaProvider {
  return { provider: 'zai', connection, primary: null, details: [], planLabel: null, footerLines }
}

async function apiKey(deps: ZaiDeps): Promise<string | null> {
  const supplied = nonEmpty(deps.env['ZAI_API_KEY'])
  if (supplied) return supplied
  try {
    const raw = await deps.readFile(deps.credentialPath, 64 * 1024)
    if (!raw) return null
    const auth = JSON.parse(raw) as Record<string, unknown>
    const entry = auth['zai']
    return entry && typeof entry === 'object' ? nonEmpty((entry as Record<string, unknown>)['key']) : null
  } catch {
    // A malformed or unreadable login file is the same as no login at all.
    return null
  }
}

export type ZaiDecoded = QuotaProvider | 'rejected' | null

export function decodeZaiUsage(body: unknown): ZaiDecoded {
  return decodeZaiPlanUsage('zai', body)
}

export type ZaiResult = { quota: QuotaProvider; retryAfterSeconds?: number }

export async function fetchZaiQuota(options: Partial<ZaiDeps> & { signal?: AbortSignal } = {}): Promise<ZaiResult> {
  const deps = { ...defaultDeps(), ...options }
  try {
    const key = await apiKey(deps)
    if (!key) return { quota: empty('disconnected') }

    const response = await deps.fetch(USAGE_ENDPOINT, {
      method: 'GET', signal: quotaRequestSignal(options.signal),
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'en-US,en',
        Authorization: key,
        'User-Agent': 'CodeBurn',
      },
    })
    if (response.status === 401 || response.status === 403) return { quota: empty('terminalFailure', REJECTED_FOOTER) }
    if (response.status === 429) {
      const raw = response.headers.get('Retry-After')
      const seconds = raw === null ? NaN : Number(raw)
      return {
        quota: { ...empty('transientFailure', RATE_LIMITED_FOOTER), rateLimited: true },
        retryAfterSeconds: Math.max(Number.isFinite(seconds) ? Math.ceil(seconds) : 300, 60),
      }
    }
    if (response.status >= 500) return { quota: empty('transientFailure', UNAVAILABLE_FOOTER) }
    if (!response.ok) return { quota: empty('transientFailure', PARSE_FOOTER) }
    // Never log the body - it carries account data.
    const decoded = decodeZaiUsage(await response.json())
    if (decoded === 'rejected') return { quota: empty('terminalFailure', REJECTED_FOOTER) }
    return { quota: decoded ?? empty('transientFailure', PARSE_FOOTER) }
  } catch (error) {
    console.warn(`Z.ai quota unavailable: ${sanitizeError(error)}`)
    return { quota: empty('transientFailure') }
  }
}

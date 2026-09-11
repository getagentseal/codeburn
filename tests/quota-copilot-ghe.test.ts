// Copilot on GitHub Enterprise Cloud with data residency (issue #1286). The
// adapter hardcoded api.github.com and dropped the host its credential came
// from, so a `<tenant>.ghe.com` enterprise could only ever report
// "Temporarily unavailable". These tests pin endpoint derivation, which host is
// picked out of a credential file, and that a host we cannot address fails
// naming that host instead of sending the credential to dotcom.
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  copilotAPIHost,
  copilotUsageEndpoint,
  fetchCopilotQuota,
  normalizeCopilotHost,
  preferredCopilotHost,
} from '../src/quota/copilot.js'

const usageBody = JSON.stringify({
  copilot_plan: 'enterprise',
  quota_snapshots: { premium_interactions: { entitlement: 300, percent_remaining: 70 } },
})

function usageResponse(): Response {
  return new Response(usageBody, { status: 200, headers: { 'Content-Type': 'application/json' } })
}

/**
 * Serves one credential file, keyed by file name, and records every URL the
 * adapter requests. The adapter joins the directory and the file name with
 * `path.join`, so the separator is a backslash on Windows: the name has to come
 * out with `path.basename` rather than by splitting on `/`, or every lookup
 * misses there and the credential reads as absent.
 */
function deps(files: Record<string, string>, respond: (url: string) => Response | Promise<Response> = () => usageResponse()) {
  const urls: string[] = []
  const tokens: (string | null)[] = []
  return {
    urls,
    tokens,
    options: {
      configDirs: ['/copilot'],
      readFile: async (filePath: string) => files[path.basename(filePath)] ?? null,
      fetch: (async (url: string, init?: RequestInit) => {
        urls.push(String(url))
        const headers = new Headers(init?.headers)
        tokens.push(headers.get('Authorization'))
        return respond(String(url))
      }) as unknown as typeof fetch,
    },
  }
}

describe('Copilot quota endpoint derivation', () => {
  it('keeps api.github.com for dotcom and for sources with no host', () => {
    expect(copilotAPIHost('github.com')).toBe('api.github.com')
    expect(copilotAPIHost(null)).toBe('api.github.com')
    expect(copilotUsageEndpoint('github.com')).toBe('https://api.github.com/copilot_internal/user')
    expect(copilotUsageEndpoint(null)).toBe('https://api.github.com/copilot_internal/user')
  })

  it('derives the tenant API host for an Enterprise Cloud host', () => {
    expect(copilotAPIHost('acme.ghe.com')).toBe('api.acme.ghe.com')
    expect(copilotUsageEndpoint('acme.ghe.com')).toBe('https://api.acme.ghe.com/copilot_internal/user')
    expect(copilotAPIHost('api.acme.ghe.com')).toBe('api.acme.ghe.com')
  })

  it('normalizes the spellings different clients write', () => {
    for (const spelling of ['ACME.ghe.com', ' acme.ghe.com ', 'https://acme.ghe.com', 'https://acme.ghe.com/', 'acme.ghe.com:443']) {
      expect(copilotAPIHost(spelling)).toBe('api.acme.ghe.com')
    }
    expect(normalizeCopilotHost('  ')).toBeNull()
  })

  it('refuses to derive an endpoint for an unknown host', () => {
    expect(copilotAPIHost('github.acme-corp.net')).toBeNull()
    expect(copilotUsageEndpoint('github.acme-corp.net')).toBeNull()
    // A bare suffix is not a tenant.
    expect(copilotAPIHost('ghe.com')).toBeNull()
  })
})

describe('Copilot host selection', () => {
  it('selects nothing when the file lists no usable entry', () => {
    expect(preferredCopilotHost([])).toBeNull()
  })

  it('uses a single host as-is, including one it cannot address', () => {
    expect(preferredCopilotHost(['acme.ghe.com'])).toBe('acme.ghe.com')
    expect(preferredCopilotHost([null])).toBe('github.com')
    expect(preferredCopilotHost(['github.acme-corp.net'])).toBe('github.acme-corp.net')
  })

  it('prefers dotcom when several hosts are signed in, else the first tenant in sorted order', () => {
    expect(preferredCopilotHost(['acme.ghe.com', 'github.com'])).toBe('github.com')
    expect(preferredCopilotHost(['acme.ghe.com', null])).toBe('github.com')
    expect(preferredCopilotHost(['zeta.ghe.com', 'acme.ghe.com'])).toBe('acme.ghe.com')
    expect(preferredCopilotHost(['github.acme-corp.net', 'acme.ghe.com'])).toBe('acme.ghe.com')
  })
})

describe('Copilot quota on an Enterprise Cloud host', () => {
  it('queries the tenant API host with the tenant token', async () => {
    const harness = deps({ 'hosts.json': JSON.stringify({ 'acme.ghe.com': { oauth_token: 'gho_tenant' } }) })
    const result = await fetchCopilotQuota(harness.options)
    expect(harness.urls).toEqual(['https://api.acme.ghe.com/copilot_internal/user'])
    expect(harness.tokens).toEqual(['token gho_tenant'])
    expect(result.quota.connection).toBe('connected')
    expect(result.quota.planLabel).toBe('Enterprise')
    expect(result.quota.footerLines).toEqual(['Source: api.acme.ghe.com'])
  })

  it('prefers dotcom when both hosts are present and never sends the tenant token to it', async () => {
    const harness = deps({
      'hosts.json': JSON.stringify({
        'acme.ghe.com': { oauth_token: 'gho_tenant' },
        'github.com': { oauth_token: 'gho_dotcom' },
      }),
    })
    await fetchCopilotQuota(harness.options)
    expect(harness.urls).toEqual(['https://api.github.com/copilot_internal/user'])
    expect(harness.tokens).toEqual(['token gho_dotcom'])
  })

  it('keeps the token and the host from the same entry', async () => {
    const harness = deps({
      'hosts.json': JSON.stringify({
        'github.com': { user: 'octocat' },
        'acme.ghe.com': { oauth_token: 'gho_tenant' },
      }),
    })
    await fetchCopilotQuota(harness.options)
    expect(harness.urls).toEqual(['https://api.acme.ghe.com/copilot_internal/user'])
    expect(harness.tokens).toEqual(['token gho_tenant'])
  })

  it('reads the host out of an apps.json key and assumes dotcom for a bare app name', async () => {
    const tenant = deps({ 'apps.json': JSON.stringify({ 'acme.ghe.com:Iv1.b507a08c87ecfe98': { oauth_token: 'gho_apps' } }) })
    await fetchCopilotQuota(tenant.options)
    expect(tenant.urls).toEqual(['https://api.acme.ghe.com/copilot_internal/user'])

    const appName = deps({ 'apps.json': JSON.stringify({ 'Visual Studio Code': { oauth_token: 'ghu_apps' } }) })
    await fetchCopilotQuota(appName.options)
    expect(appName.urls).toEqual(['https://api.github.com/copilot_internal/user'])
  })

  it('fails naming the host when no endpoint can be derived, without any request', async () => {
    const harness = deps({ 'hosts.json': JSON.stringify({ 'github.acme-corp.net': { oauth_token: 'gho_ghes' } }) })
    const result = await fetchCopilotQuota(harness.options)
    expect(harness.urls).toEqual([])
    expect(result.quota.connection).toBe('terminalFailure')
    expect(result.quota.footerLines[0]).toContain('github.acme-corp.net')
  })

  it('names the tenant host when it is unreachable', async () => {
    const harness = deps({ 'hosts.json': JSON.stringify({ 'acme.ghe.com': { oauth_token: 'gho_tenant' } }) }, () => {
      throw new TypeError('fetch failed')
    })
    const result = await fetchCopilotQuota(harness.options)
    expect(result.quota.connection).toBe('transientFailure')
    expect(result.quota.footerLines[0]).toContain('api.acme.ghe.com')
  })
})

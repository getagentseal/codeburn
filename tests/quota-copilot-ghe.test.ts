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
  ghConfigPaths,
  ghCopilotCredential,
  ghCredentialsFromConfig,
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
function deps(
  files: Record<string, string>,
  respond: (url: string) => Response | Promise<Response> = () => usageResponse(),
  env: NodeJS.ProcessEnv = {},
) {
  const urls: string[] = []
  const tokens: (string | null)[] = []
  return {
    urls,
    tokens,
    options: {
      configDirs: ['/copilot'],
      // The environment and gh rungs are inert unless a test supplies them, so
      // a shell that exports GH_TOKEN cannot change what these tests read.
      env,
      ghConfigPaths: ['/gh/hosts.yml'],
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

  it('refuses a host carrying a URL delimiter rather than pointing the request elsewhere', () => {
    for (const crafted of ['evil.com?.ghe.com', 'evil.com#.ghe.com', 'github.com#.ghe.com', 'a b.ghe.com']) {
      expect(copilotAPIHost(crafted)).toBeNull()
      expect(copilotUsageEndpoint(crafted)).toBeNull()
    }
    // The same input before the fix resolved to a host of its own choosing.
    expect(new URL('https://api.evil.com?.ghe.com/copilot_internal/user').host).toBe('api.evil.com')
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

// The rungs that carry no host of their own were always sent to api.github.com,
// so an enterprise-only credential got a 401 and a terminal failure (#1306).
// GH_HOST names the host of an environment token, and gh's hosts.yml carries
// the token and its host in the same entry.
describe('gh hosts.yml parsing', () => {
  const config = [
    '# gh config',
    '---',
    'github.com:',
    '    users:',
    '        octocat:',
    '            oauth_token: gho_dotcom',
    '    git_protocol: https',
    '    oauth_token: gho_dotcom',
    'acme.ghe.com:',
    '    users:',
    '        octocat:',
    '            oauth_token: gho_tenant',
    '',
  ].join('\n')

  it('reads each top-level host with the first token inside its block', () => {
    expect(ghCredentialsFromConfig(config)).toEqual([
      { token: 'gho_dotcom', host: 'github.com' },
      { token: 'gho_tenant', host: 'acme.ghe.com' },
    ])
  })

  it('ignores comments, blank lines, CRLF endings and quoted keys', () => {
    expect(ghCredentialsFromConfig('"ACME.ghe.com":\r\n    oauth_token: "gho_quoted"\r\n')).toEqual([
      { token: 'gho_quoted', host: 'acme.ghe.com' },
    ])
    expect(ghCredentialsFromConfig('')).toEqual([])
    // A host block with no token is not a credential.
    expect(ghCredentialsFromConfig('acme.ghe.com:\n    user: octocat\n')).toEqual([])
    // An indented key is never read as a host.
    expect(ghCredentialsFromConfig('    acme.ghe.com:\n        oauth_token: gho_x\n')).toEqual([])
  })

  it('picks the host gh itself would read the token for', () => {
    // A single login is used as-is, GH_HOST wins over the file, and dotcom
    // wins when several are signed in - gh's own fallback.
    expect(ghCopilotCredential('acme.ghe.com:\n    oauth_token: gho_tenant\n'))
      .toEqual({ token: 'gho_tenant', host: 'acme.ghe.com' })
    expect(ghCopilotCredential(config)).toEqual({ token: 'gho_dotcom', host: 'github.com' })
    expect(ghCopilotCredential(config, 'acme.ghe.com')).toEqual({ token: 'gho_tenant', host: 'acme.ghe.com' })
    // GH_HOST naming a host gh has no login for yields nothing, as gh would.
    expect(ghCopilotCredential(config, 'other.ghe.com')).toBeNull()
    expect(ghCopilotCredential('')).toBeNull()
  })

  it('follows gh\'s own config-directory order', () => {
    expect(ghConfigPaths('darwin', { GH_CONFIG_DIR: '/opt/ghcfg', XDG_CONFIG_HOME: '/xdg' }, '/Users/dev'))
      .toEqual([path.join('/opt/ghcfg', 'hosts.yml')])
    expect(ghConfigPaths('darwin', { XDG_CONFIG_HOME: '/xdg' }, '/Users/dev'))
      .toEqual([path.join('/xdg', 'gh', 'hosts.yml')])
    expect(ghConfigPaths('darwin', {}, '/Users/dev')).toEqual([path.join('/Users/dev', '.config', 'gh', 'hosts.yml')])
    expect(ghConfigPaths('win32', { APPDATA: 'C:\\Users\\dev\\AppData\\Roaming' }, 'C:\\Users\\dev')).toEqual([
      path.join('C:\\Users\\dev\\AppData\\Roaming', 'GitHub CLI', 'hosts.yml'),
      path.join('C:\\Users\\dev', '.config', 'gh', 'hosts.yml'),
    ])
  })
})

describe('Copilot rungs that used to carry no host', () => {
  it('sends an environment token to the host GH_HOST names', async () => {
    const harness = deps({}, () => usageResponse(), { GH_TOKEN: 'gho_env', GH_HOST: 'acme.ghe.com' })
    const result = await fetchCopilotQuota(harness.options)
    expect(harness.urls).toEqual(['https://api.acme.ghe.com/copilot_internal/user'])
    expect(harness.tokens).toEqual(['token gho_env'])
    expect(result.quota.footerLines).toEqual(['Source: api.acme.ghe.com'])
  })

  it('keeps an environment token on dotcom when GH_HOST is unset', async () => {
    const harness = deps({}, () => usageResponse(), { COPILOT_GITHUB_TOKEN: 'gho_env' })
    await fetchCopilotQuota(harness.options)
    expect(harness.urls).toEqual(['https://api.github.com/copilot_internal/user'])
  })

  it('sends a gh login to the host gh recorded for it', async () => {
    const harness = deps({ 'hosts.yml': 'acme.ghe.com:\n    oauth_token: gho_ghcli\n' })
    await fetchCopilotQuota(harness.options)
    expect(harness.urls).toEqual(['https://api.acme.ghe.com/copilot_internal/user'])
    expect(harness.tokens).toEqual(['token gho_ghcli'])
  })

  it('keeps the plugin files ahead of the environment and gh', async () => {
    const harness = deps(
      {
        'hosts.json': JSON.stringify({ 'github.com': { oauth_token: 'gho_plugin' } }),
        'hosts.yml': 'acme.ghe.com:\n    oauth_token: gho_ghcli\n',
      },
      () => usageResponse(),
      { GH_TOKEN: 'gho_env', GH_HOST: 'other.ghe.com' },
    )
    await fetchCopilotQuota(harness.options)
    expect(harness.urls).toEqual(['https://api.github.com/copilot_internal/user'])
    expect(harness.tokens).toEqual(['token gho_plugin'])
  })

  it('reports disconnected when no rung holds a token', async () => {
    const harness = deps({ 'hosts.yml': 'acme.ghe.com:\n    user: octocat\n' })
    const result = await fetchCopilotQuota(harness.options)
    expect(result.quota.connection).toBe('disconnected')
    expect(harness.urls).toEqual([])
  })

  it.each([
    ['GH_HOST', {}, { GH_TOKEN: 'gho_env', GH_HOST: 'evil.com?.ghe.com' }],
    ['gh hosts.yml', { 'hosts.yml': 'evil.com?.ghe.com:\n    oauth_token: gho_ghcli\n' }, {}],
  ] as const)('refuses a crafted host from %s without building a request', async (_source, files, env) => {
    const harness = deps(files as Record<string, string>, () => usageResponse(), env)
    const result = await fetchCopilotQuota(harness.options)
    expect(harness.urls).toEqual([])
    expect(result.quota.connection).toBe('terminalFailure')
    expect(result.quota.footerLines[0]).toContain('evil.com?.ghe.com')
  })
})

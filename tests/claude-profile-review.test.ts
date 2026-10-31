import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { createHash } from 'node:crypto'
import { claudeConfigSourceId, claudeKeychainService, discoverClaudeProfileSources, discoverClaudeSessionOrgSources } from '../src/providers/claude.js'
import { fetchClaudeQuota, readClaudeKeychain } from '../src/quota/claude.js'
import * as security from '../src/quota/security.js'
import { collectQuota } from '../src/quota/index.js'
import { clearSessionCache, computeCorpusFingerprint, filterProjectsByClaudeConfigSource, parseAllSessions } from '../src/parser.js'
import { collectLiveSessionInputs } from '../src/live-sessions.js'
import { buildPeriodData } from '../src/usage-aggregator.js'
import { headlineWindow } from '../windows/src/lib/quotaHeadline.js'

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const CLI_ORG = '22222222-2222-4222-8222-222222222222'
const DESKTOP_ORG = '33333333-3333-4333-8333-333333333333'
let root: string, config: string, desktop: string
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'claude-review-'))
  config = join(root, 'config')
  desktop = join(root, 'desktop')
  await mkdir(config)
  process.env.CLAUDE_CONFIG_DIR = config
  process.env.CODEBURN_DESKTOP_SESSIONS_DIR = join(desktop, 'local-agent-mode-sessions')
  process.env.CODEBURN_CACHE_DIR = join(root, 'cache')
  clearSessionCache()
})

afterEach(async () => {
  vi.restoreAllMocks()
  Object.defineProperty(process, 'platform', platform)
  clearSessionCache()
  await rm(root, { recursive: true, force: true })
})

async function orgSession(org: string, id: string) {
  const dir = join(desktop, 'claude-code-sessions', ACCOUNT, org)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `local_${id}.json`), JSON.stringify({ cliSessionId: id }))
}

describe('Claude review regressions', () => {
  it('uses a directory-specific, account-only Keychain lookup and stops after denial', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    const lookup = vi.spyOn(security, 'readKeychainPassword').mockResolvedValue({ status: 'accessDenied' })
    const service = claudeKeychainService(config)
    expect(service).toBe(`Claude Code-credentials-${createHash('sha256').update(config.normalize('NFC')).digest('hex').slice(0, 8)}`)
    expect(await readClaudeKeychain(service)).toEqual({ status: 'accessDenied' })
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(lookup.mock.calls[0]![0]).toBe(service)
    expect(lookup.mock.calls[0]![1]).toHaveLength(1)
    expect(lookup.mock.calls[0]![1]![0]).toEqual(expect.any(String))
    expect(lookup.mock.calls[0]![1]![0]).not.toBe('')
  })

  it('does not read Keychain without an explicit user action', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    const keychain = vi.fn()
    const fetch = vi.fn()
    const result = await fetchClaudeQuota({ configDir: config, readFile: async () => null, keychain, fetch })
    expect(result.quota.connection).toBe('disconnected')
    expect(keychain).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('never spends a refresh token or writes credentials after expiry and 401', async () => {
    const file = join(config, '.credentials.json')
    const original = JSON.stringify({ claudeAiOauth: { accessToken: 'expired-fixture', refreshToken: 'must-not-be-spent', expiresAt: 1 } })
    await writeFile(file, original, { mode: 0o600 })
    const fetch = vi.fn(async () => new Response('', { status: 401 }))
    const result = await fetchClaudeQuota({ configDir: config, fetch })
    expect(result.quota.connection).toBe('terminalFailure')
    expect(fetch.mock.calls).toHaveLength(1)
    expect(fetch.mock.calls[0]).toEqual([
      'https://api.anthropic.com/api/oauth/usage', expect.objectContaining({ method: 'GET' }),
    ])
    expect(await readFile(file, 'utf8')).toBe(original)
    expect(await readdir(config)).toEqual(['.credentials.json'])
    expect(await readdir(join(root, 'cache')).catch(() => [])).toEqual([])
  })

  it('keeps Desktop-only quota unavailable without borrowing the CLI login', async () => {
    await orgSession(DESKTOP_ORG, 'desktop-session')
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('No network expected') })
    const keychain = vi.spyOn(security, 'readKeychainPassword').mockResolvedValue({ status: 'notFound' })
    const sources = await discoverClaudeProfileSources()
    // Exercise the real profile reader: neither the missing config login nor
    // the Desktop-only identity may invent a usable organization credential.
    const report = await collectQuota({ readers: [], claudeProfileDetail: 'full',
      claudeToday: async () => new Map(),
    })
    expect(sources.find(s => s.orgUuid === DESKTOP_ORG)?.label).toBe(DESKTOP_ORG)
    expect(report.claudeProfiles?.find(s => s.id === `claude-org:${DESKTOP_ORG}`)?.available).toBe(false)
    const quota = await fetchClaudeQuota({ credentialPath: join(root, 'missing'), fetch })
    expect(quota.quota.connection).toBe('disconnected')
    expect(fetch).not.toHaveBeenCalled()
    expect(keychain.mock.calls.every(([service]) => service.startsWith('Claude Code-credentials'))).toBe(true)
  })

  it('uses only non-secret metadata and never guesses a missing organization label', async () => {
    await writeFile(join(config, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: CLI_ORG, organizationName: 'Acme Engineering', accountUuid: ACCOUNT } }))
    await orgSession(CLI_ORG, 'cli-session')
    await orgSession(DESKTOP_ORG, 'desktop-session')
    // A legacy token cache and misleading metadata must be completely ignored.
    await mkdir(join(root, 'cache'))
    await writeFile(join(root, 'cache', 'claude-org-profiles.json'), JSON.stringify({ [DESKTOP_ORG]: { label: 'Team', isDefaultConfigOrg: true } }))
    await writeFile(join(desktop, 'config.json'), '{invalid encrypted token cache')
    const profiles = await discoverClaudeProfileSources()
    expect(profiles.map(p => p.label)).toEqual(['Acme Engineering', DESKTOP_ORG])
    const mapping = await discoverClaudeSessionOrgSources()
    expect(mapping.get('cli-session')?.id).toBe(claudeConfigSourceId(config))
    expect(mapping.get('desktop-session')?.id).toBe(`claude-org:${DESKTOP_ORG}`)
    await rm(join(config, '.claude.json'))
    expect((await discoverClaudeProfileSources()).filter(p => p.orgUuid).map(p => p.label).sort()).toEqual([CLI_ORG, DESKTOP_ORG])
  })

  it('partitions parent and sidechain usage without changing whole-machine counters, including warm parses and live sessions', async () => {
    await orgSession(DESKTOP_ORG, 'org-parent')
    const project = join(config, 'projects', 'example')
    await mkdir(join(project, 'org-parent', 'subagents'), { recursive: true })
    const now = new Date().toISOString()
    const event = (id: string, tokens: number, sidechain = false) => JSON.stringify({ type: 'assistant', sessionId: sidechain ? 'org-parent' : id, isSidechain: sidechain, cwd: '/example', timestamp: now,
      message: { id: `msg-${id}`, role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'fixture' }], usage: { input_tokens: tokens, output_tokens: tokens / 2 } } }) + '\n'
    await writeFile(join(project, 'plain.jsonl'), event('plain', 100))
    await writeFile(join(project, 'org-parent.jsonl'), event('org-parent', 200))
    await writeFile(join(project, 'org-parent', 'subagents', 'agent-child.jsonl'), event('child', 300, true))
    for (let pass = 0; pass < 2; pass++) {
      const projects = await parseAllSessions(undefined, 'claude')
      const all = buildPeriodData('All', projects)
      const configTotal = buildPeriodData('All', filterProjectsByClaudeConfigSource(projects, claudeConfigSourceId(config)))
      const orgTotal = buildPeriodData('All', filterProjectsByClaudeConfigSource(projects, `claude-org:${DESKTOP_ORG}`))
      expect(all.calls).toBe(3)
      expect(configTotal.calls).toBe(1)
      expect(orgTotal.calls).toBe(2)
      for (const key of ['calls', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'cost'] as const) {
        expect(configTotal[key] + orgTotal[key]).toBeCloseTo(all[key], 10)
      }
    }
    const live = await collectLiveSessionInputs(Date.now(), 600)
    expect(live.find(s => s.id === 'org-parent')?.claudeConfigSourceId).toBe(`claude-org:${DESKTOP_ORG}`)
    expect(live.find(s => s.id === 'plain')?.claudeConfigSourceId).toBe(claudeConfigSourceId(config))
  })

  it('reuses main quota only for the first configured directory', async () => {
    const defaultDir = join(homedir(), '.claude')
    await mkdir(defaultDir, { recursive: true })
    process.env.CLAUDE_CONFIG_DIRS = [config, defaultDir].join(delimiter)
    const quota = { provider: 'claude' as const, connection: 'connected' as const,
      primary: { label: '5-hour', percent: 0.2, resetsAt: null }, details: [], planLabel: null, footerLines: [] }
    const read = vi.fn(async (_source: unknown, _signal: AbortSignal) => ({ ...quota, primary: { ...quota.primary, percent: 0.8 } }))
    const result = await collectQuota({ readers: [{ id: 'claude', name: 'Claude', read: async () => quota }],
      claudeProfileDetail: 'full', claudeProfileReader: read, claudeToday: async () => new Map() })
    expect(read).toHaveBeenCalledTimes(1)
    expect(read.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ path: defaultDir }))
    expect(result.claudeProfiles?.find(p => p.id === claudeConfigSourceId(config))?.windows[0]?.usedPct).toBe(20)
    expect(result.claudeProfiles?.find(p => p.id === claudeConfigSourceId(defaultDir))?.windows[0]?.usedPct).toBe(80)
  })

  it('invalidates rendered snapshots when only file-based org attribution changes', async () => {
    const before = await computeCorpusFingerprint('claude')
    await orgSession(DESKTOP_ORG, 'changing-session')
    const after = await computeCorpusFingerprint('claude')
    expect(after.hash).not.toBe(before.hash)
    await orgSession(CLI_ORG, 'changing-session')
    expect((await discoverClaudeSessionOrgSources()).has('changing-session')).toBe(false)
    expect((await computeCorpusFingerprint('claude')).hash).not.toBe(after.hash)
  })

  it('uses the five-hour headline ahead of every model-scoped weekly window on Windows', () => {
    const five = { label: '5-hour', usedPct: 20 }
    expect(headlineWindow([five, { label: 'Weekly · Fable', usedPct: 90 }])).toEqual(five)
    const weekly = { label: 'Weekly', usedPct: 10 }
    expect(headlineWindow([five, weekly, { label: 'Weekly · Fable', usedPct: 90 }])).toEqual(weekly)
  })
})

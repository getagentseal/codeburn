import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as cli from '../src/quota/antigravity.js'
import * as desktop from '../app/electron/quota/antigravity.js'
import { collectQuota } from '../src/quota/index.js'

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/antigravity-quota-216/${name}.json`, import.meta.url), 'utf8'))
const summary = fixture('summary')
const status = fixture('status')
const appLine = '1234 /Applications/Antigravity.app/Contents/Resources/antigravity/language_server --app_data_dir antigravity --csrf_token fixture-token'
const execFile: cli.ExecFileFn = async file => ({
  stdout: file === 'ps' ? appLine : 'server 1234 user 12u IPv4 0x1 0t0 TCP 127.0.0.1:54321 (LISTEN)\n',
})

// Both shipped copies must understand the same live protocol. Importing the
// Electron adapter here needs only Node built-ins, not an Electron/jsdom runtime.
describe.each([['CLI', cli], ['Electron', desktop]] as const)('%s Antigravity 2.16 quota', (_name, reader) => {
  it('decodes the captured response envelope, direct fractions, and reset times', () => {
    const windows = reader.decodeAntigravitySummary(summary)
    expect(windows.map(window => window.label)).toEqual([
      'Gemini Models · Weekly Limit Remaining',
      'Gemini Models · Five Hour Limit Remaining',
      'Claude and GPT models · Weekly Limit Remaining',
      'Claude and GPT models · Five Hour Limit Remaining',
    ])
    expect(windows.map(window => window.resetsAt)).toEqual([
      '2026-10-08T11:42:20.000Z', '2026-10-07T03:08:15.000Z',
      '2026-10-13T22:08:15.000Z', '2026-10-07T03:08:15.000Z',
    ])
    expect(windows[0]!.percent).toBeCloseTo(0.0001467, 7)
    expect(windows.slice(1).every(window => window.percent === 0)).toBe(true)
  })

  it.each([false, true])('retains legacy nested fractions and reset times (wrapped: %s)', wrapped => {
    const payload = { groups: [{ displayName: 'Gemini Models', buckets: [
      { bucketId: 'weekly', remaining: { remainingFraction: 0.25, resetTime: 1_800_000_000 } },
    ] }] }
    expect(reader.decodeAntigravitySummary(wrapped ? { response: payload } : payload)).toEqual([
      { label: 'Gemini Models · weekly', percent: 0.75, resetsAt: new Date(1_800_000_000_000).toISOString() },
    ])
  })

  it('accepts unwrapped direct buckets and prefers their explicit zero over legacy fields', () => {
    expect(reader.decodeAntigravitySummary({ groups: [{ displayName: 'Gemini Models', buckets: [
      { bucketId: 'weekly', remainingFraction: 0, resetTime: '2026-10-08T12:00:00Z', remaining: { remainingFraction: 1, resetTime: '2026-10-09T12:00:00Z' } },
      { bucketId: '5h', remainingFraction: 1 },
    ] }] })).toEqual([
      { label: 'Gemini Models · weekly', percent: 1, resetsAt: '2026-10-08T12:00:00.000Z' },
      { label: 'Gemini Models · 5h', percent: 0, resetsAt: null },
    ])
  })

  it('decodes the captured GetUserStatus label rows', () => {
    expect(reader.decodeAntigravityStatus(status)).toEqual([
      { label: 'Claude Opus 5.5 (Medium)', percent: 0, resetsAt: '2026-10-07T03:04:50.000Z' },
      { label: 'GPT-OSS 120B (Medium)', percent: 0, resetsAt: '2026-10-07T03:04:50.000Z' },
    ])
  })

  it('prefers the current label and falls back to legacy modelName for absent or blank labels', () => {
    const configs = [
      { label: 'Current name', modelName: 'legacy-id', quotaInfo: { remainingFraction: 0 } },
      { label: ' ', modelName: 'Legacy name', quotaInfo: { remainingFraction: 0.5 } },
      { modelName: 'Old model', quotaInfo: { remainingFraction: 1 } },
    ]
    expect(reader.decodeAntigravityStatus({ userStatus: { cascadeModelConfigData: { clientModelConfigs: configs } } })).toEqual([
      { label: 'Current name', percent: 1, resetsAt: null },
      { label: 'Legacy name', percent: 0.5, resetsAt: null },
      { label: 'Old model', percent: 0, resetsAt: null },
    ])
  })

  it('ignores malformed buckets and invalid fractions without losing valid quota', () => {
    expect(reader.decodeAntigravitySummary({ response: { groups: [null, { displayName: 'Gemini', buckets: [
      null, {}, { bucketId: 'missing' }, { bucketId: 'string', remainingFraction: '0.5' },
      { bucketId: 'nan', remainingFraction: NaN }, { bucketId: 'infinite', remainingFraction: Infinity },
      { bucketId: 'valid', remainingFraction: 0.5, resetTime: 'invalid' },
    ] }] } })).toEqual([{ label: 'Gemini · valid', percent: 0.5, resetsAt: null }])
  })

  it('keeps a valid window when its numeric reset time is outside the Date range', () => {
    expect(reader.decodeAntigravitySummary({ response: { groups: [{ buckets: [
      { bucketId: 'weekly', remainingFraction: 0.5, resetTime: Number.MAX_VALUE },
    ] }] } })).toEqual([{ label: 'weekly', percent: 0.5, resetsAt: null }])
  })

  it('returns no windows for malformed response envelopes', () => {
    for (const body of [null, undefined, 'invalid', { response: null }, { response: { groups: {} } }]) {
      expect(reader.decodeAntigravitySummary(body)).toEqual([])
      expect(reader.decodeAntigravityStatus(body)).toEqual([])
    }
  })

  it('reports a discovered 2.16 server as available with all four quota windows', async () => {
    const request = vi.fn<cli.LocalRequestFn>(async () => ({ status: 200, text: JSON.stringify(summary) }))
    const report = await collectQuota({ readers: [{
      id: 'antigravity', name: 'Antigravity',
      read: () => reader.fetchAntigravityQuota({ execFile, request, platform: 'darwin' }),
    }] })
    const provider = report.providers[0]!
    expect(provider.available).toBe(true)
    expect(provider.windows).toHaveLength(4)
    expect(provider.windows[0]).toMatchObject({
      label: 'Gemini Models · Weekly Limit Remaining', resetsAt: '2026-10-08T11:42:20.000Z',
    })
    // The command rounds percentages to one decimal; the decoder test above
    // separately pins the unrounded provider fraction.
    expect(provider.windows[0]!.usedPct).toBe(0)
    expect(request.mock.calls.map(call => call.slice(0, 3))).toEqual([
      [54321, true, '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary'],
      [54321, true, '/exa.language_server_pb.LanguageServerService/GetUserStatus'],
    ])
  })

  it.each([
    ['the Google tier', { name: 'Google AI Ultra' }, 'Google AI Ultra'],
    ['the free tier, not the planInfo name', { id: 'free-tier', name: 'Antigravity Starter Quota' }, 'Antigravity Starter Quota'],
    ['nothing for a blank tier', { name: ' ' }, null],
  ])('labels the summary windows with %s', async (_case, userTier, label) => {
    const request = vi.fn<cli.LocalRequestFn>(async (_port, _tls, pathName) => ({
      status: 200,
      text: JSON.stringify(pathName.endsWith('/GetUserStatus')
        ? { userStatus: { userTier, planStatus: { planInfo: { planName: 'Pro' } } } }
        : summary),
    }))
    const quota = await reader.fetchAntigravityQuota({ execFile, request, platform: 'darwin' })
    expect(quota.details).toHaveLength(4)
    expect(quota.planLabel).toBe(label)
  })

  it('falls back to the captured label-based status when the summary has no quota', async () => {
    const request = vi.fn<cli.LocalRequestFn>(async (_port, _tls, pathName) => ({
      status: 200, text: JSON.stringify(pathName.endsWith('/GetUserStatus') ? status : {}),
    }))
    const quota = await reader.fetchAntigravityQuota({ execFile, request, platform: 'darwin' })
    expect(quota.connection).toBe('connected')
    expect(quota.details).toEqual(reader.decodeAntigravityStatus(status))
    expect(request).toHaveBeenCalledTimes(2)
  })
})

// Process line as Antigravity 2.34 starts it: no --csrf_token on the command line.
const hubLine = '4321 /Applications/Antigravity.app/Contents/Resources/bin/language_server --standalone'
  + ' --override_ide_name antigravity --subclient_type hub --override_ide_version 2.34.0'
  + ' --override_user_agent_name antigravity --https_server_port 0 --app_data_dir antigravity'
  + ' --api_server_url https://generativelanguage.googleapis.com --cloud_code_endpoint https://daily-cloudcode-pa.googleapis.com'
  + ' --enable_sidecars --host_bridge_url=http://127.0.0.1:50000 --read_host_bridge_token_from_stdin'
const hubToken = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'

describe.each([['CLI', cli], ['Electron', desktop]] as const)('%s Antigravity daemon file', (_name, reader) => {
  let home: string
  let dir: string
  const writeHub = (name: string, body: string, mtimeSeconds = 2_000_000_000) => {
    writeFileSync(join(dir, name), body, { mode: 0o600 })
    utimesSync(join(dir, name), mtimeSeconds, mtimeSeconds)
  }
  const hub = (pid: number, csrfToken = hubToken) => JSON.stringify({ pid, httpsPort: 54321, httpPort: 54322, lsVersion: '2.34.0', csrfToken })

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'codeburn-agy-'))
    dir = join(home, '.gemini', 'antigravity', 'daemon')
    mkdirSync(dir, { recursive: true })
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })

  it('takes the token from the newest file naming the server pid', () => {
    writeHub('hub_59999.json', hub(4321, 'stale-token'), 1_900_000_000)
    writeHub('hub_54322.json', hub(4321))
    expect(reader.classifyProcessLine(hubLine, dir)).toEqual({ pid: '4321', cli: false, csrf: hubToken, extPort: undefined })
  })

  it('skips the server when no file names its pid', () => {
    writeHub('hub_54322.json', hub(9999))
    expect(reader.classifyProcessLine(hubLine, dir)).toBeNull()
  })

  it('skips the server when the file is malformed', () => {
    writeHub('hub_54322.json', '{"pid": 4321, "csrfToken":')
    writeHub('hub_54323.json', JSON.stringify({ pid: 4321, csrfToken: 'bad token\r\nX: 1' }))
    expect(reader.classifyProcessLine(hubLine, dir)).toBeNull()
  })

  it('skips the server when there is no file', () => {
    expect(reader.classifyProcessLine(hubLine, dir)).toBeNull()
    expect(reader.classifyProcessLine(hubLine, join(home, 'missing'))).toBeNull()
  })

  it('keeps the command-line token of an older server', () => {
    writeHub('hub_54322.json', hub(1234))
    expect(reader.classifyProcessLine(appLine, dir)).toMatchObject({ pid: '1234', csrf: 'fixture-token' })
  })

  it('sends the file token when probing a 2.34 server found in the home folder', async () => {
    writeHub('hub_54322.json', hub(4321))
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    const request = vi.fn<cli.LocalRequestFn>(async () => ({ status: 200, text: JSON.stringify(summary) }))
    const quota = await reader.fetchAntigravityQuota({
      execFile: async file => ({ stdout: file === 'ps' ? hubLine : 'server 4321 user 12u IPv4 0x1 0t0 TCP 127.0.0.1:54322 (LISTEN)\n' }),
      request,
      platform: 'darwin',
    })
    expect(quota.connection).toBe('connected')
    expect(request.mock.calls[0]).toEqual([54322, true, '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary', '{}', hubToken])
  })
})

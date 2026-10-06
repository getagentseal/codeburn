import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

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
    expect(request).toHaveBeenCalledExactlyOnceWith(
      54321, true, '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary', '{}', 'fixture-token',
    )
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

import { describe, expect, it, vi } from 'vitest'

import { QuotaService } from './index'
import type { ProviderName, QuotaProvider } from './types'

const quota = (provider: ProviderName): QuotaProvider => ({
  provider, connection: 'connected', primary: null, details: [], planLabel: null, footerLines: [],
})

// Every construction stubs all eight fetchers: a missing dep falls back to the
// real fetcher, which would touch disk or the network inside a test. Grok Bot's
// install check is stubbed too, so the row does not depend on the host machine.
const noopFetchers = () => ({
  claude: vi.fn(async () => ({ quota: quota('claude') })),
  codex: vi.fn(async () => ({ quota: quota('codex') })),
  gemini: vi.fn(async () => ({ quota: quota('gemini') })),
  copilot: vi.fn(async () => ({ quota: quota('copilot') })),
  antigravity: vi.fn(async () => ({ quota: quota('antigravity') })),
  kimi: vi.fn(async () => ({ quota: quota('kimi') })),
  zcode: vi.fn(async () => ({ quota: quota('zcode') })),
  grokbot: vi.fn(async () => ({ quota: quota('grokbot') })),
})

describe('QuotaService', () => {
  it('fetches and returns every registered provider', async () => {
    const fetchers = noopFetchers()
    const service = new QuotaService({
      ...fetchers, grokbotInstalled: () => true, now: () => 1000,
      readFile: vi.fn(async () => null), writeFile: vi.fn(async () => undefined),
    })
    const results = await service.getQuota({ force: true })
    expect(results.map(row => row.provider)).toEqual(['claude', 'codex', 'gemini', 'copilot', 'antigravity', 'kimi', 'zcode', 'grokbot'])
    for (const fetcher of Object.values(fetchers)) expect(fetcher).toHaveBeenCalledTimes(1)
    // Antigravity is local-only; it must not receive keychain permission.
    expect(fetchers.antigravity).toHaveBeenCalledWith({ signal: expect.any(AbortSignal), allowKeychain: false })
  })

  // The snap declares no Codex credential path, because the live gauge would
  // need write access to the Codex CLI's own auth.json to rotate the token.
  // Under $SNAP the Codex fetch must not run at all; Claude is unaffected.
  it('skips the Codex live gauge under snap confinement', async () => {
    const previous = process.env['SNAP']
    process.env['SNAP'] = '/snap/codeburn/current'
    try {
      const fetchers = noopFetchers()
      const service = new QuotaService({
        ...fetchers, grokbotInstalled: () => true, now: () => Date.parse('2026-08-14T00:00:00Z'),
        readFile: vi.fn(async () => null),
        writeFile: vi.fn(async () => {}),
        statePath: '/mock/backoff.json',
      })
      const results = await service.getQuota({ force: true })
      expect(fetchers.codex).not.toHaveBeenCalled()
      expect(fetchers.claude).toHaveBeenCalledTimes(1)
      expect(results.find(row => row.provider === 'codex')?.connection).toBe('disconnected')
      expect(results.find(row => row.provider === 'claude')?.connection).toBe('connected')
    } finally {
      if (previous === undefined) delete process.env['SNAP']
      else process.env['SNAP'] = previous
    }
  })

  // Grok Bot is an optional desktop app: with it absent there is no row to
  // show, only someone else's Cursor allowance under a Grok Bot label.
  it('omits Grok Bot entirely when the app is not installed', async () => {
    const fetchers = noopFetchers()
    const service = new QuotaService({
      ...fetchers, grokbotInstalled: () => false, now: () => 1000,
      readFile: vi.fn(async () => null), writeFile: vi.fn(async () => undefined),
    })
    const results = await service.getQuota({ force: true })
    expect(results.map(row => row.provider)).toEqual(['claude', 'codex', 'gemini', 'copilot', 'antigravity', 'kimi', 'zcode'])
    expect(fetchers.grokbot).not.toHaveBeenCalled()
  })

  it('omits disabled providers from polling and results', async () => {
    const fetchers = noopFetchers()
    const service = new QuotaService({
      ...fetchers, grokbotInstalled: () => true, now: () => 1000,
      readFile: vi.fn(async () => null), writeFile: vi.fn(async () => undefined),
    })
    // Unknown names are ignored rather than throwing.
    const results = await service.getQuota({ force: true, disabled: ['gemini', 'copilot', 'bogus' as ProviderName] })
    expect(results.map(row => row.provider)).toEqual(['claude', 'codex', 'antigravity', 'kimi', 'zcode', 'grokbot'])
    expect(fetchers.gemini).not.toHaveBeenCalled()
    expect(fetchers.copilot).not.toHaveBeenCalled()
  })

  it('persists provider 429 blocked-until and gates the next forced fetch', async () => {
    const writes: string[] = []
    const fetchers = noopFetchers()
    fetchers.claude.mockImplementation(async () => ({ quota: quota('claude'), retryAfterSeconds: 60 }))
    fetchers.gemini.mockImplementation(async () => ({ quota: quota('gemini'), retryAfterSeconds: 120 }))
    const service = new QuotaService({
      ...fetchers, grokbotInstalled: () => true, now: () => Date.parse('2026-07-12T00:00:00Z'),
      readFile: vi.fn(async () => writes.at(-1) ?? null),
      writeFile: vi.fn(async (_path, value) => { writes.push(value) }),
      statePath: '/mock/backoff.json',
    })
    await service.getQuota({ force: true })
    const saved = JSON.parse(writes.at(-1)!)
    expect(saved.claude).toBe('2026-07-12T00:01:00.000Z')
    expect(saved.gemini).toBe('2026-07-12T00:02:00.000Z')
    await service.getQuota({ force: true })
    expect(fetchers.claude).toHaveBeenCalledTimes(1)
    expect(fetchers.gemini).toHaveBeenCalledTimes(1)
    expect(fetchers.codex).toHaveBeenCalledTimes(2)
  })

  it('force re-fetches within the cache window by invalidating first', async () => {
    const fetchers = noopFetchers()
    const service = new QuotaService({
      ...fetchers, grokbotInstalled: () => true, now: () => 1000, refreshMs: 120_000,
      readFile: vi.fn(async () => null), writeFile: vi.fn(async () => undefined),
    })
    await service.getQuota()
    await service.getQuota() // fresh cache, no re-fetch
    expect(fetchers.claude).toHaveBeenCalledTimes(1)
    await service.getQuota({ force: true }) // force clears the still-fresh cache
    expect(fetchers.claude).toHaveBeenCalledTimes(2)
  })

  it('single-flights simultaneous callers', async () => {
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const fetchers = noopFetchers()
    fetchers.claude.mockImplementation(async () => { await pending; return { quota: quota('claude') } })
    const service = new QuotaService({
      ...fetchers, grokbotInstalled: () => true,
      readFile: vi.fn(async () => null), writeFile: vi.fn(async () => undefined),
    })
    const first = service.getQuota({ force: true })
    const second = service.getQuota({ force: true })
    release()
    expect(await first).toEqual(await second)
    expect(fetchers.claude).toHaveBeenCalledTimes(1)
  })
})


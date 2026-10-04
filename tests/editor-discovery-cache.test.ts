import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { clearSessionCache, parseAllSessions } from '../src/parser.js'
import { currentTzKey, ensureCacheHydrated, toDateString } from '../src/daily-cache.js'
import { aggregateProjectsIntoDays } from '../src/day-aggregator.js'
import { calculateCost } from '../src/models.js'

afterEach(() => {
  clearSessionCache()
  vi.unstubAllEnvs()
})

it.skipIf(process.platform === 'darwin')('backfills redirected editor history in a finalized v50 cache while retaining other providers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'editor-discovery-cache-'))
  try {
    const cache = join(root, 'cache')
    vi.stubEnv('CODEBURN_CACHE_DIR', cache)
    vi.stubEnv('APPDATA', root)
    vi.stubEnv('XDG_CONFIG_HOME', root)
    vi.stubEnv('CODEBURN_COPILOT_DISABLE_OTEL', '1')
    vi.stubEnv('CODEBURN_COPILOT_SESSION_STATE_DIR', join(root, 'no-cli'))
    vi.stubEnv('CODEBURN_COPILOT_SESSION_STORE_DB', join(root, 'no-store'))
    vi.stubEnv('CODEBURN_COPILOT_JETBRAINS_DIR', join(root, 'no-jb'))
    const chats = join(root, 'Code', 'User', 'globalStorage', 'emptyWindowChatSessions')
    await mkdir(chats, { recursive: true })
    const timestamp = new Date(Date.now() - 4 * 86400000).toISOString()
    const date = toDateString(new Date(timestamp))
    await writeFile(join(chats, 'redirected.jsonl'), JSON.stringify({ kind: 0, v: {
      sessionId: 'redirected', creationDate: Date.parse(timestamp), requests: [{
        requestId: 'r', modelId: 'copilot/gpt-4o', completionTokens: 20,
        result: { metadata: { promptTokens: 100 } },
      }],
    } }) + '\n')
    clearSessionCache()
    const parse = () => parseAllSessions(undefined, 'copilot')
    const fresh = await parse()
    expect(aggregateProjectsIntoDays(fresh)[0]).toMatchObject({ date, calls: 1, inputTokens: 100, outputTokens: 20 })

    const historical = structuredClone(fresh)
    for (const project of historical) for (const session of project.sessions) for (const turn of session.turns) for (const call of turn.assistantCalls) {
      call.provider = 'claude'
      call.model = 'claude-sonnet-4-6'
      call.usage.inputTokens = 50
      call.usage.outputTokens = 10
      call.costUSD = calculateCost(call.model, 50, 10, 0, 0, 0)
    }
    await mkdir(cache, { recursive: true })
    await writeFile(join(cache, 'daily-cache.v50.json'), JSON.stringify({
      version: 50, savingsConfigHash: '', tzKey: currentTzKey(),
      lastComputedDate: toDateString(new Date(Date.now() - 86400000)),
      days: aggregateProjectsIntoDays(historical), complete: true, watermarkTrusted: true,
    }))
    const hydrated = await ensureCacheHydrated(parse, aggregateProjectsIntoDays)
    const day = hydrated.days.find(d => d.date === date)!
    expect(day).toMatchObject({ calls: 2, inputTokens: 150, outputTokens: 30 })
    expect(day.providers.copilot).toMatchObject({ calls: 1, inputTokens: 100, outputTokens: 20 })
    expect(day.providers.claude).toMatchObject({ calls: 1, inputTokens: 50, outputTokens: 10 })
  } finally {
    clearSessionCache()
    await rm(root, { recursive: true, force: true })
  }
})

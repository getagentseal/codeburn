import { afterEach, describe, expect, it } from 'vitest'

import { parseProviderSources } from '../src/parser.js'
import { CACHE_VERSION, computeEnvFingerprint, type CachedFile, type SessionCache } from '../src/session-cache.js'
import { setWslHomes } from '../src/wsl.js'

const WSL_HOME = '\\\\wsl$\\Ubuntu\\home\\me'
const WSL_PATH = `${WSL_HOME}\\.copilot\\session-state\\session.jsonl`

function cachedDurableFile(): CachedFile {
  const timestamp = new Date().toISOString()
  return {
    fingerprint: { dev: 0, ino: 0, mtimeMs: Date.now(), sizeBytes: 100 },
    mcpInventory: [],
    turns: [{
      timestamp,
      sessionId: 'durable-wsl-session',
      userMessage: 'hi',
      calls: [{
        provider: 'copilot',
        model: 'gpt-4.1',
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          cachedInputTokens: 0,
          reasoningTokens: 0,
          webSearchRequests: 0,
          cacheCreationOneHourTokens: 0,
        },
        costUSD: 0.01,
        speed: 'standard',
        timestamp,
        tools: [],
        bashCommands: [],
        skills: [],
        subagentTypes: [],
        deduplicationKey: 'durable-wsl-call',
        project: 'durable-wsl-project',
        projectPath: '/home/me/durable-wsl-project',
      }],
    }],
  }
}

afterEach(() => setWslHomes(undefined))

describe('durable provider WSL orphan reconciliation', () => {
  it('keeps an active-root orphan visible when durable history retains the cache row', async () => {
    setWslHomes([WSL_HOME])
    const cache: SessionCache = {
      version: CACHE_VERSION,
      complete: true,
      providers: {
        copilot: {
          envFingerprint: computeEnvFingerprint('copilot'),
          durable: true,
          files: { [WSL_PATH]: cachedDurableFile() },
        },
      },
    }

    const projects = await parseProviderSources('copilot', [], new Set(), cache)

    expect(projects.map(project => project.project)).toContain('durable-wsl-project')
    expect(cache.providers['copilot']?.files[WSL_PATH]).toBeDefined()
  })
})

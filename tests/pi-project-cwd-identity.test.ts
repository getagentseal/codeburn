/**
 * #1260: a real Pi JSONL header cwd=/b/vault
 * must survive discovery → parseProviderSources → mergeProjectsByCrossProviderKey
 * and must NOT fold into an unrelated /a/vault via basename-only identity.
 */
import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPiProvider } from '../src/providers/pi.js'
import { parseProviderSources, mergeProjectsByCrossProviderKey } from '../src/parser.js'
import { CACHE_VERSION } from '../src/session-cache.js'
import type { ProjectSummary } from '../src/types.js'

it('does not attribute a Pi session from /b/vault to the unrelated /a/vault', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-cwd-identity-'))
  try {
    const dir = join(root, 'sessions', '--b-vault--')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'pi-real-cwd.jsonl'), [
      { type: 'session', version: 3, id: 'pi-real-cwd', cwd: '/b/vault', timestamp: '2026-04-14T10:00:00Z' },
      { type: 'message', id: 'pi-message', timestamp: '2026-04-14T10:01:00Z', message: {
        role: 'assistant', model: 'gpt-5.4', content: [], responseId: 'pi-response',
        usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost: { total: 1 } },
      } },
    ].map(JSON.stringify).join('\n') + '\n')

    const sources = await createPiProvider(join(root, 'sessions')).discoverSessions()
    expect(sources).toHaveLength(1)
    expect(sources[0]!.sourcePath).toBe('/b/vault')
    expect(sources[0]!.project).toBe('vault')

    const pi = await parseProviderSources('pi', sources, new Set(), { version: CACHE_VERSION, providers: {} })
    expect(pi).toHaveLength(1)
    expect(pi[0]!.sessions).toHaveLength(1)
    // Production-path assertion: abs cwd preserved end-to-end (not basename "vault").
    expect(pi[0]!.projectPath.replace(/\\/g, '/')).toMatch(/\/b\/vault$|^\/b\/vault$/)
    expect(pi[0]!.sessions[0]!.workingDirectory?.replace(/\\/g, '/')).toBe('/b/vault')

    const unrelated: ProjectSummary = {
      project: 'vault', projectPath: '/a/vault', sessions: [],
      totalCostUSD: 10, totalApiCalls: 1, totalProxiedCostUSD: 0,
    }
    const after = mergeProjectsByCrossProviderKey(structuredClone([unrelated, ...pi]))
    expect(after.size).toBe(2)
    // Pi is not on the reported-cost allowlist, so token reprice (~0.0055) is
    // expected — same figure Codex observed. Guard attribution, not nominal $1.
    const byKey = Object.fromEntries([...after.entries()].map(([k, v]) => [k, v.totalCostUSD]))
    const aKey = Object.keys(byKey).find(k => k.includes('a/vault'))
    const bKey = Object.keys(byKey).find(k => k.includes('b/vault'))
    expect(aKey).toBeTruthy()
    expect(bKey).toBeTruthy()
    expect(byKey[aKey!]).toBe(10)
    expect(byKey[bKey!]).toBeGreaterThan(0)
    expect(byKey[bKey!]).toBeLessThan(10)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/**
 * #1260: two Pi sessions with cwd=/a/vault and /b/vault both
 * display as basename "vault". parseProviderSources must keep them distinct
 * through cold/warm cache and either discovery order, then merge must report
 * both abs projectPaths.
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPiProvider } from '../src/providers/pi.js'
import { parseProviderSources, mergeProjectsByCrossProviderKey } from '../src/parser.js'
import { CACHE_VERSION } from '../src/session-cache.js'
import type { ProjectSummary, SessionSource } from '../src/types.js'

async function writeTwoVaultRoots(root: string): Promise<string> {
  const sessionsRoot = join(root, 'sessions')
  for (const parent of ['a', 'b']) {
    const dir = join(sessionsRoot, `--${parent}-vault--`)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `pi-${parent}.jsonl`), [
      { type: 'session', version: 3, id: `pi-${parent}`, cwd: `/${parent}/vault`, timestamp: '2026-04-14T10:00:00Z' },
      { type: 'message', id: `message-${parent}`, timestamp: '2026-04-14T10:01:00Z', message: {
        role: 'assistant', model: 'gpt-5.4', content: [], responseId: `response-${parent}`,
        usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost: { total: 1 } },
      } },
    ].map(x => JSON.stringify(x)).join('\n') + '\n')
  }
  return sessionsRoot
}

function sortedPaths(projects: ProjectSummary[]): string[] {
  return projects.map(p => p.projectPath.replace(/\\/g, '/')).sort()
}

function reorder(sources: SessionSource[], firstParent: 'a' | 'b'): SessionSource[] {
  const prefer = `/${firstParent}/vault`
  return [...sources].sort((x, y) => {
    const ax = x.sourcePath === prefer ? 0 : 1
    const bx = y.sourcePath === prefer ? 0 : 1
    return ax - bx
  })
}

describe('two Pi roots same display basename (#1260)', () => {
  it('preserves both explicit cwd roots when two Pi sessions share the basename vault', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-two-pi-'))
    try {
      const sessionsRoot = await writeTwoVaultRoots(root)
      const sources = await createPiProvider(sessionsRoot).discoverSessions()
      expect(sources).toHaveLength(2)
      const pi = await parseProviderSources('pi', sources, new Set(), { version: CACHE_VERSION, providers: {} })
      const merged = mergeProjectsByCrossProviderKey(pi)
      expect([...merged.values()].map(p => p.projectPath.replace(/\\/g, '/')).sort()).toEqual(['/a/vault', '/b/vault'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps both roots under cold then warm cache serve', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-two-pi-cache-'))
    try {
      const sessionsRoot = await writeTwoVaultRoots(root)
      const sources = await createPiProvider(sessionsRoot).discoverSessions()
      const cache = { version: CACHE_VERSION, providers: {} }
      const cold = await parseProviderSources('pi', sources, new Set(), cache)
      expect(sortedPaths(cold)).toEqual(['/a/vault', '/b/vault'])
      const warm = await parseProviderSources('pi', sources, new Set(), cache)
      expect(sortedPaths(warm)).toEqual(['/a/vault', '/b/vault'])
      expect(sortedPaths([...mergeProjectsByCrossProviderKey(warm).values()])).toEqual(['/a/vault', '/b/vault'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('is stable across both discovery orders', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-two-pi-order-'))
    try {
      const sessionsRoot = await writeTwoVaultRoots(root)
      const sources = await createPiProvider(sessionsRoot).discoverSessions()
      for (const first of ['a', 'b'] as const) {
        const ordered = reorder(sources, first)
        const projects = await parseProviderSources('pi', ordered, new Set(), { version: CACHE_VERSION, providers: {} })
        expect(sortedPaths(projects)).toEqual(['/a/vault', '/b/vault'])
        expect(sortedPaths([...mergeProjectsByCrossProviderKey(projects).values()])).toEqual(['/a/vault', '/b/vault'])
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('same basename across different providers stays distinct by abs path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-two-pi-xprov-'))
    try {
      const sessionsRoot = await writeTwoVaultRoots(root)
      const sources = await createPiProvider(sessionsRoot).discoverSessions()
      const pi = await parseProviderSources('pi', sources, new Set(), { version: CACHE_VERSION, providers: {} })
      const foreign: ProjectSummary = {
        project: 'vault',
        projectPath: '/a/vault',
        sessions: [],
        totalCostUSD: 10,
        totalApiCalls: 1,
        totalProxiedCostUSD: 0,
      }
      const merged = mergeProjectsByCrossProviderKey([foreign, ...pi])
      // /a/vault folds with matching Pi root; /b/vault stays separate.
      expect(merged.size).toBe(2)
      expect(sortedPaths([...merged.values()])).toEqual(['/a/vault', '/b/vault'])
      const a = [...merged.values()].find(p => p.projectPath.replace(/\\/g, '/') === '/a/vault')!
      expect(a.totalCostUSD).toBeGreaterThan(10)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPiProvider } from '../src/providers/pi.js'
import {
  mergeProjectsByCrossProviderKey,
  normalizeAbsProjectPathKey,
  normalizeProjectPathKey,
  parseProviderSources,
} from '../src/parser.js'
import { CACHE_VERSION } from '../src/session-cache.js'
import { buildPayloadProjects } from '../src/usage-aggregator.js'
import type { ProjectSummary } from '../src/types.js'
import type { DailyEntry } from '../src/daily-cache.js'

describe('exported path-identity helpers', () => {
  it('preserves POSIX case and casefolds identified Windows drive/UNC paths', () => {
    expect(normalizeAbsProjectPathKey('/a/Vault')).toBe('a/Vault')
    expect(normalizeAbsProjectPathKey('/a/vault')).toBe('a/vault')
    expect(normalizeAbsProjectPathKey('/a/Vault')).not.toBe(normalizeAbsProjectPathKey('/a/vault'))
    expect(normalizeAbsProjectPathKey('C:/root/vault')).toBe('c:/root/vault')
    expect(normalizeAbsProjectPathKey('C:\\root\\vault')).toBe('c:/root/vault')
    expect(normalizeAbsProjectPathKey('C:\\Work\\Vault')).toBe('c:/work/vault')
    expect(normalizeAbsProjectPathKey('c:/work/vault')).toBe('c:/work/vault')
    expect(normalizeAbsProjectPathKey('\\\\Server\\Share\\Vault')).toBe(
      normalizeAbsProjectPathKey('//server/share/vault'),
    )
    expect(normalizeAbsProjectPathKey('\\\\Server\\Share\\Vault')).toBe('server/share/vault')
    expect(normalizeAbsProjectPathKey('a-vault')).toBeNull()

    expect(normalizeProjectPathKey('/a/Vault')).toBe('/a/Vault')
    expect(normalizeProjectPathKey('/a/vault')).toBe('/a/vault')
    expect(normalizeProjectPathKey('C:\\Work\\Vault')).toBe('c:/work/vault')
  })
})

describe('cold+warm Pi cwd case identity', () => {
  it('keeps /a/Vault and /a/vault distinct through cache and payload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'posix-case-pi-'))
    try {
      const sessionsRoot = join(root, 'sessions')
      // Dir/file names must not differ only by case: the host volume may be
      // case-insensitive. Identity under test is the cwd string in the JSONL.
      const rows = [
        { cwd: '/a/Vault', slot: 'upper', cost: 2 },
        { cwd: '/a/vault', slot: 'lower', cost: 3 },
      ] as const
      for (const row of rows) {
        const dir = join(sessionsRoot, row.slot)
        await mkdir(dir, { recursive: true })
        await writeFile(join(dir, 'session.jsonl'), [
          { type: 'session', version: 3, id: `pi-${row.slot}`, cwd: row.cwd, timestamp: '2026-04-14T10:00:00Z' },
          { type: 'message', id: `message-${row.slot}`, timestamp: '2026-04-14T10:01:00Z', message: {
            role: 'assistant', model: 'gpt-5.4', content: [], responseId: `response-${row.slot}`,
            usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost: { total: row.cost } },
          } },
        ].map(x => JSON.stringify(x)).join('\n') + '\n')
      }

      const sources = await createPiProvider(sessionsRoot).discoverSessions()
      const cache = { version: CACHE_VERSION, providers: {} }
      const cold = await parseProviderSources('pi', sources, new Set(), cache)
      const warm = await parseProviderSources('pi', sources, new Set(), cache)
      const paths = (projects: ProjectSummary[]) => projects.map(p => p.projectPath.replace(/\\/g, '/')).sort()
      expect(paths(cold)).toEqual(['/a/Vault', '/a/vault'])
      expect(paths(warm)).toEqual(['/a/Vault', '/a/vault'])

      const reloaded = JSON.parse(JSON.stringify(cache))
      expect(paths(await parseProviderSources('pi', sources, new Set(), reloaded))).toEqual(['/a/Vault', '/a/vault'])

      const merged = mergeProjectsByCrossProviderKey(warm)
      expect([...merged.values()].map(p => p.projectPath.replace(/\\/g, '/')).sort()).toEqual(['/a/Vault', '/a/vault'])

      const payload = buildPayloadProjects([...merged.values()], null, '/Users/synthetic')
      expect(payload.map(p => p.id).sort()).toEqual(['/a/Vault', '/a/vault'])
      expect(payload).toHaveLength(2)
      expect(payload.every(p => p.cost > 0)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('Windows drive case in payload identity', () => {
  it('folds a C:\\Work\\Vault cache row into the live c:/work/vault row', () => {
    const live = [{
      project: 'Vault',
      projectPath: 'c:/work/vault',
      sessions: [],
      totalCostUSD: 1,
      totalSavingsUSD: 0,
      totalApiCalls: 1,
      totalProxiedCostUSD: 0,
    }] as unknown as ProjectSummary[]
    const day = {
      date: '2026-09-02',
      cost: 2,
      calls: 1,
      sessions: 1,
      savingsUSD: 0,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      editTurns: 0,
      oneShotTurns: 0,
      models: {},
      categories: {},
      projects: { Vault: { path: 'C:\\Work\\Vault', cost: 2, calls: 1, savingsUSD: 0, sessions: 1 } },
      providers: {},
    } as unknown as DailyEntry

    const rows = buildPayloadProjects(live, [day], '/Users/synthetic')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.cost).toBe(2)
  })
})

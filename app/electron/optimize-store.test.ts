// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Stub electron so importing main.ts does not require an Electron runtime.
vi.mock('electron', () => ({
  app: { name: 'CodeBurn', whenReady: () => Promise.resolve(), on: () => {}, quit: () => {} },
  BrowserWindow: class {},
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: () => {} },
  Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: () => {} },
  shell: { openExternal: vi.fn() },
}))

import { createBridgeHandlers } from './main'
import { readOptimizeSnapshots, readOptimizeSnapshot, sameLocalDay, writeOptimizeSnapshot, type OptimizeSnapshot } from './optimize-store'

const DAY_MS = 24 * 60 * 60 * 1000
const STORE = 'optimize-snapshots.json'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codeburn-optimize-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.useRealTimers()
})

function block(savingsUSD: number) {
  return { findingCount: 1, savingsUSD, topFindings: [{ title: 'Trim preamble', impact: 'high' as const, savingsUSD }] }
}

function handlers(stateDir: string, payloadSavings = 12) {
  const calls: string[][] = []
  const spawnCli = vi.fn(async (args: string[]) => {
    calls.push(args)
    return { optimize: block(payloadSavings) }
  })
  const bridge = createBridgeHandlers({
    spawnCli,
    spawnCliAction: vi.fn(),
    resolveCodeburnPath: () => '/usr/local/bin/codeburn',
    getQuota: vi.fn(),
    stateDir,
    appVersion: '1.2.3',
  } as unknown as Parameters<typeof createBridgeHandlers>[0])
  return { snapshot: bridge['codeburn:getOptimizeSnapshot']!, calls }
}

describe('optimize snapshot store', () => {
  it('computes with optimize ON (the poll argv runs --no-optimize) and writes the result', async () => {
    const dir = tempDir()
    const { snapshot, calls } = handlers(dir)

    const res = await snapshot('today', 'all') as { ok: true; value: OptimizeSnapshot }

    expect(res.ok).toBe(true)
    expect(calls[0]).not.toContain('--no-optimize')
    expect(calls[0]).toEqual(['status', '--format', 'menubar-json', '--period', 'today', '--no-timeline'])
    expect(res.value.optimize.savingsUSD).toBe(12)
    expect(res.value.appVersion).toBe('1.2.3')
    // Persisted for the next launch, keyed by the argv it was computed for.
    const stored = JSON.parse(readFileSync(join(dir, STORE), 'utf8')) as OptimizeSnapshot[]
    expect(stored).toHaveLength(1)
    expect(stored[0]!.scope).toBe(calls[0]!.join(' '))
  })

  it('serves a stored result younger than a day without spawning', async () => {
    const dir = tempDir()
    const first = handlers(dir)
    const written = await first.snapshot('today', 'all') as { value: OptimizeSnapshot }

    const second = handlers(dir, 99)
    const res = await second.snapshot('today', 'all') as { ok: true; value: OptimizeSnapshot }

    expect(second.calls).toHaveLength(0)
    expect(res.value.computedAt).toBe(written.value.computedAt)
    expect(res.value.optimize.savingsUSD).toBe(12)
  })

  it('recomputes a stored result older than a day', async () => {
    const dir = tempDir()
    writeOptimizeSnapshot(dir, {
      scope: ['status', '--format', 'menubar-json', '--period', 'today', '--no-timeline'].join(' '),
      computedAt: new Date(Date.now() - DAY_MS - 60_000).toISOString(),
      appVersion: '1.2.3',
      optimize: block(5),
    })

    const { snapshot, calls } = handlers(dir, 42)
    const res = await snapshot('today', 'all') as { value: OptimizeSnapshot }

    expect(calls).toHaveLength(1)
    expect(res.value.optimize.savingsUSD).toBe(42)
  })

  it('recomputes on demand (maxAgeMs 0) even with a fresh stored result', async () => {
    const dir = tempDir()
    const first = handlers(dir)
    await first.snapshot('today', 'all')

    const second = handlers(dir, 77)
    const res = await second.snapshot('today', 'all', undefined, null, undefined, 0) as { value: OptimizeSnapshot }

    expect(second.calls).toHaveLength(1)
    expect(res.value.optimize.savingsUSD).toBe(77)
  })

  it("never serves one scope's savings for another", async () => {
    const dir = tempDir()
    const today = handlers(dir, 12)
    await today.snapshot('today', 'all')

    // Different period, different provider, different config source: each is a
    // distinct scope, so each recomputes instead of reading the other's figure.
    for (const args of [['week', 'all'], ['today', 'claude'], ['today', 'all', undefined, 'claude-config:abc']]) {
      const other = handlers(dir, 500)
      const res = await other.snapshot(...args) as { value: OptimizeSnapshot }
      expect(other.calls).toHaveLength(1)
      expect(res.value.optimize.savingsUSD).toBe(500)
    }

    // The original scope is still served from disk, unchanged.
    const again = handlers(dir, 999)
    const res = await again.snapshot('today', 'all') as { value: OptimizeSnapshot }
    expect(again.calls).toHaveLength(0)
    expect(res.value.optimize.savingsUSD).toBe(12)
  })

  it('recomputes across local midnight even though the scan is minutes old', async () => {
    const dir = tempDir()
    vi.useFakeTimers()
    // 23:50 local. The argv says `--period today`, which names a window that
    // moves at midnight, so age alone is not freshness.
    vi.setSystemTime(new Date(2026, 8, 18, 23, 50, 0))
    const evening = handlers(dir, 12)
    await evening.snapshot('today', 'all')
    expect(evening.calls).toHaveLength(1)

    // 00:10 the next day: 20 minutes old, well inside the 24h bound, but a
    // different local day → recompute.
    vi.setSystemTime(new Date(2026, 8, 19, 0, 10, 0))
    const after = handlers(dir, 42)
    const res = await after.snapshot('today', 'all') as { value: OptimizeSnapshot }
    expect(after.calls).toHaveLength(1)
    expect(res.value.optimize.savingsUSD).toBe(42)

    // Later the same day the fresh scan is reused, no spawn.
    vi.setSystemTime(new Date(2026, 8, 19, 9, 30, 0))
    const sameDay = handlers(dir, 999)
    const reused = await sameDay.snapshot('today', 'all') as { value: OptimizeSnapshot }
    expect(sameDay.calls).toHaveLength(0)
    expect(reused.value.optimize.savingsUSD).toBe(42)
  })

  it('applies the same-day rule to rolling windows and pinned custom ranges alike', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 18, 23, 50, 0))
    for (const args of [['week', 'all'], ['30days', 'all'], ['month', 'all'], ['today', 'all', { from: '2026-09-01', to: '2026-09-18' }]]) {
      const dir = tempDir()
      const evening = handlers(dir, 12)
      await evening.snapshot(...args)
      vi.setSystemTime(new Date(2026, 8, 19, 0, 10, 0))
      const after = handlers(dir, 42)
      const res = await after.snapshot(...args) as { value: OptimizeSnapshot }
      expect(after.calls).toHaveLength(1)
      expect(res.value.optimize.savingsUSD).toBe(42)
      vi.setSystemTime(new Date(2026, 8, 18, 23, 50, 0))
    }
  })

  it('sameLocalDay compares calendar days, not elapsed time', () => {
    const lateNight = new Date(2026, 8, 18, 23, 50).getTime()
    expect(sameLocalDay(lateNight, new Date(2026, 8, 18, 0, 1).getTime())).toBe(true)
    expect(sameLocalDay(lateNight, new Date(2026, 8, 19, 0, 10).getTime())).toBe(false)
    expect(sameLocalDay(lateNight, new Date(2025, 8, 18, 23, 50).getTime())).toBe(false)
    expect(sameLocalDay(lateNight, NaN)).toBe(false)
  })

  it('drops rows from other app versions on write instead of letting them fill the cap', () => {
    const dir = tempDir()
    for (let i = 0; i < 8; i++) {
      writeOptimizeSnapshot(dir, {
        scope: `old-${i}`,
        computedAt: new Date().toISOString(),
        appVersion: '0.0.1',
        optimize: block(i),
      })
    }
    expect(readOptimizeSnapshots(dir)).toHaveLength(8)

    writeOptimizeSnapshot(dir, {
      scope: 'current',
      computedAt: new Date().toISOString(),
      appVersion: '1.2.3',
      optimize: block(7),
    })

    // The unservable rows are gone, so the cap belongs to rows that can be used.
    const rows = readOptimizeSnapshots(dir)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.scope).toBe('current')
  })

  it('ignores a store written by a different app version', async () => {
    const dir = tempDir()
    writeOptimizeSnapshot(dir, {
      scope: ['status', '--format', 'menubar-json', '--period', 'today', '--no-timeline'].join(' '),
      computedAt: new Date().toISOString(),
      appVersion: '0.0.1',
      optimize: block(5),
    })

    const { snapshot, calls } = handlers(dir, 42)
    const res = await snapshot('today', 'all') as { value: OptimizeSnapshot }

    expect(calls).toHaveLength(1)
    expect(res.value.optimize.savingsUSD).toBe(42)
  })

  it('ignores a corrupt or truncated store file instead of throwing', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, STORE), '{"scope": "today", trunc', 'utf8')
    expect(readOptimizeSnapshot(dir, 'anything', '1.2.3')).toBeNull()

    const { snapshot, calls } = handlers(dir, 42)
    const res = await snapshot('today', 'all') as { ok: true; value: OptimizeSnapshot }

    expect(res.ok).toBe(true)
    expect(calls).toHaveLength(1)
    // The corrupt file is replaced by a valid one.
    expect(readOptimizeSnapshot(dir, calls[0]!.join(' '), '1.2.3')?.optimize.savingsUSD).toBe(42)
  })

  it('drops rows that are not snapshots rather than serving them', () => {
    const dir = tempDir()
    writeFileSync(join(dir, STORE), JSON.stringify([{ scope: 's', computedAt: 'x' }, 7, null]), 'utf8')
    expect(readOptimizeSnapshot(dir, 's', '1.2.3')).toBeNull()
  })
})

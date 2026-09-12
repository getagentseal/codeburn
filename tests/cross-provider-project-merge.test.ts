import { describe, expect, it } from 'vitest'
import type { ProjectSummary } from '../src/types.js'
import {
  crossProviderProjectKey,
  mergeProjectsByCrossProviderKey,
  normalizeAbsProjectPathKey,
  normalizeProjectPathKey,
} from '../src/parser.js'

function summary(
  project: string,
  projectPath: string,
  opts: { cost?: number; calls?: number; wd?: string; savings?: number } = {},
): ProjectSummary {
  return {
    project,
    projectPath,
    sessions: opts.wd
      ? ([{ workingDirectory: opts.wd }] as ProjectSummary['sessions'])
      : [],
    totalCostUSD: opts.cost ?? 1,
    totalSavingsUSD: opts.savings ?? 0,
    totalApiCalls: opts.calls ?? 1,
    totalProxiedCostUSD: 0,
  } as ProjectSummary
}

function costsByKey(merged: Map<string, ProjectSummary>): Record<string, number> {
  return Object.fromEntries([...merged.entries()].map(([k, v]) => [k, v.totalCostUSD]))
}

describe('crossProviderProjectKey (#1260)', () => {
  it('keys absolute POSIX paths as path:… without folding case', () => {
    expect(crossProviderProjectKey(summary('vault', '/root/vault'))).toBe('path:root/vault')
    expect(crossProviderProjectKey(summary('Vault', '/a/Vault'))).toBe('path:a/Vault')
    expect(crossProviderProjectKey(summary('vault', '/a/vault'))).toBe('path:a/vault')
  })

  it('keys Codex-style stripped abs paths as path:…', () => {
    expect(crossProviderProjectKey(summary('root-vault', 'root/vault'))).toBe('path:root/vault')
  })

  it('falls back to session.workingDirectory when projectPath is a slug', () => {
    expect(
      crossProviderProjectKey(summary('vault', 'vault', { wd: '/root/vault' })),
    ).toBe('path:root/vault')
  })

  it('uses a label: key for basename-only rows with no abs hint', () => {
    expect(crossProviderProjectKey(summary('vault', 'vault')).startsWith('label:')).toBe(true)
  })
})

describe('mergeProjectsByCrossProviderKey (#1260)', () => {
  it('folds -root-vault / root-vault / vault into one when abs paths align', () => {
    const merged = mergeProjectsByCrossProviderKey([
      summary('-root-vault', '/root/vault', { cost: 10, calls: 2 }),
      summary('root-vault', 'root/vault', { cost: 5, calls: 1 }),
      summary('vault', 'vault', { cost: 3, calls: 1 }),
    ])
    expect(merged.size).toBe(1)
    const p = [...merged.values()][0]!
    expect(p.totalCostUSD).toBe(18)
    expect(p.totalApiCalls).toBe(4)
    expect(normalizePathish(p.projectPath)).toMatch(/root\/vault$/)
  })

  it('keeps distinct parents with the same basename separate', () => {
    const merged = mergeProjectsByCrossProviderKey([
      summary('a-vault', '/a/vault', { cost: 1 }),
      summary('b-vault', '/b/vault', { cost: 2 }),
      summary('vault', 'vault', { cost: 99 }), // ambiguous — must NOT fold into either
    ])
    expect(merged.size).toBe(3)
    const costs = [...merged.values()].map(p => p.totalCostUSD).sort((a, b) => a - b)
    expect(costs).toEqual([1, 2, 99])
  })

  it('attaches a unique basename slug to the only matching abs parent', () => {
    const merged = mergeProjectsByCrossProviderKey([
      summary('-root-vault', '/root/vault', { cost: 4 }),
      summary('vault', 'vault', { cost: 6 }),
    ])
    expect(merged.size).toBe(1)
    expect([...merged.values()][0]!.totalCostUSD).toBe(10)
  })

  it('still merges identical abs paths across providers (regression #639)', () => {
    const merged = mergeProjectsByCrossProviderKey([
      summary('shared', '/repos/shared', { cost: 10 }),
      summary('shared', '/repos/shared', { cost: 5 }),
    ])
    expect(merged.size).toBe(1)
    expect([...merged.values()][0]!.totalCostUSD).toBe(15)
  })

  it('does not attach slug via sanitized when basename also matches another parent', () => {
    // High #1: /root/vault → sanitized root-vault, basename vault
    // /other/root-vault → sanitized other-root-vault, basename root-vault
    // slug root-vault must NOT fold into /root/vault (sanitized hit) while
    // a distinct parent's leaf is literally root-vault.
    const merged = mergeProjectsByCrossProviderKey([
      summary('root-vault', '/root/vault', { cost: 1 }),
      summary('other-root-vault', '/other/root-vault', { cost: 2 }),
      summary('root-vault', 'root-vault', { cost: 99 }),
    ])
    expect(merged.size).toBe(3)
    const costs = [...merged.values()].map(p => p.totalCostUSD).sort((a, b) => a - b)
    expect(costs).toEqual([1, 2, 99])
    const labelRows = [...merged.entries()].filter(([k]) => k.startsWith('label:'))
    expect(labelRows).toHaveLength(1)
    expect(labelRows[0]![1].totalCostUSD).toBe(99)
  })

  it('does not attach slug when dash/slash sanitized labels collide', () => {
    // High #2: /foo/bar/baz and /foo/bar-baz both sanitize to foo-bar-baz.
    // Slug foo-bar-baz must stay separate (not last-write-wins attach).
    const merged = mergeProjectsByCrossProviderKey([
      summary('foo-bar-baz', '/foo/bar/baz', { cost: 1 }),
      summary('foo-bar-baz', '/foo/bar-baz', { cost: 2 }),
      summary('foo-bar-baz', 'foo-bar-baz', { cost: 99 }),
    ])
    expect(merged.size).toBe(3)
    const costs = [...merged.values()].map(p => p.totalCostUSD).sort((a, b) => a - b)
    expect(costs).toEqual([1, 2, 99])
    const labelRows = [...merged.entries()].filter(([k]) => k.startsWith('label:'))
    expect(labelRows).toHaveLength(1)
    expect(labelRows[0]![1].totalCostUSD).toBe(99)
  })

  it('sanitized collision retains full member set (label-only $5)', () => {
    // /root/vault + /root-vault both sanitize to root-vault. Label-only
    // project:'root-vault' must NOT fold into path:root-vault via basename
    // after ignoring the sanitized collision.
    const merged = mergeProjectsByCrossProviderKey([
      summary('vault', '/root/vault', { cost: 10 }),
      summary('root-vault', '/root-vault', { cost: 20 }),
      summary('root-vault', '', { cost: 5 }),
    ])
    expect(merged.size).toBe(3)
    const byKey = costsByKey(merged)
    expect(byKey['path:root/vault']).toBe(10)
    expect(byKey['path:root-vault']).toBe(20)
    const labelRows = [...merged.entries()].filter(([k]) => k.startsWith('label:'))
    expect(labelRows).toHaveLength(1)
    expect(labelRows[0]![1].totalCostUSD).toBe(5)
  })

  it.each([
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ] as const)('order permutation %i,%i,%i keeps third label-only', (a, b, c) => {
    const rows = [
      summary('vault', '/root/vault', { cost: 10 }),
      summary('root-vault', '/root-vault', { cost: 20 }),
      summary('root-vault', '', { cost: 5 }),
    ]
    const merged = mergeProjectsByCrossProviderKey([rows[a]!, rows[b]!, rows[c]!])
    expect(merged.size).toBe(3)
    const byKey = costsByKey(merged)
    expect(byKey['path:root/vault']).toBe(10)
    expect(byKey['path:root-vault']).toBe(20)
    const labelRows = [...merged.entries()].filter(([k]) => k.startsWith('label:'))
    expect(labelRows).toHaveLength(1)
    expect(labelRows[0]![1].totalCostUSD).toBe(5)
  })

  it('leading-dash alias also stays label-only on collision', () => {
    const merged = mergeProjectsByCrossProviderKey([
      summary('vault', '/root/vault', { cost: 10 }),
      summary('root-vault', '/root-vault', { cost: 20 }),
      summary('-root-vault', '', { cost: 5 }),
    ])
    expect(merged.size).toBe(3)
    const byKey = costsByKey(merged)
    expect(byKey['path:root/vault']).toBe(10)
    expect(byKey['path:root-vault']).toBe(20)
    const labelRows = [...merged.entries()].filter(([k]) => k.startsWith('label:'))
    expect(labelRows).toHaveLength(1)
    expect(labelRows[0]![1].totalCostUSD).toBe(5)
  })

  it('shallow /a/b + /a-b sanitized collision keeps empty-path slug separate', () => {
    const merged = mergeProjectsByCrossProviderKey([
      summary('b', '/a/b', { cost: 1 }),
      summary('a-b', '/a-b', { cost: 2 }),
      summary('a-b', '', { cost: 99 }),
    ])
    expect(merged.size).toBe(3)
    const byKey = costsByKey(merged)
    expect(byKey['path:a/b']).toBe(1)
    expect(byKey['path:a-b']).toBe(2)
    const labelRows = [...merged.entries()].filter(([k]) => k.startsWith('label:'))
    expect(labelRows).toHaveLength(1)
    expect(labelRows[0]![1].totalCostUSD).toBe(99)
  })

  it('Windows drive paths fold same abs; sanitized collision retains members', () => {
    // Same abs via forward/backslash and mixed directory case.
    const mixed = mergeProjectsByCrossProviderKey([
      summary('Vault', 'C:\\Work\\Vault', { cost: 2 }),
      summary('Vault', 'c:/work/vault', { cost: 2 }),
    ])
    expect(mixed.size).toBe(1)
    expect([...mixed.values()][0]!.totalCostUSD).toBe(4)

    const same = mergeProjectsByCrossProviderKey([
      summary('vault', 'C:/root/vault', { cost: 10 }),
      summary('vault', 'C:\\root\\vault', { cost: 5 }),
    ])
    expect(same.size).toBe(1)
    expect([...same.values()][0]!.totalCostUSD).toBe(15)
    expect(costsByKey(same)['path:c:/root/vault']).toBe(15)

    // Drive-letter sanitized collision (c:-root-vault) must expand members;
    // slug matching that sanitized form stays label-only (not basename-wins).
    const merged = mergeProjectsByCrossProviderKey([
      summary('vault', 'C:/root/vault', { cost: 10 }),
      summary('root-vault', 'C:/root-vault', { cost: 20 }),
      summary('c:-root-vault', '', { cost: 5 }),
    ])
    expect(merged.size).toBe(3)
    const byKey = costsByKey(merged)
    expect(byKey['path:c:/root/vault']).toBe(10)
    expect(byKey['path:c:/root-vault']).toBe(20)
    const labelRows = [...merged.entries()].filter(([k]) => k.startsWith('label:'))
    expect(labelRows).toHaveLength(1)
    expect(labelRows[0]![1].totalCostUSD).toBe(5)
  })

  it('empty projectPath with no wd stays label-only', () => {
    expect(crossProviderProjectKey(summary('vault', '')).startsWith('label:')).toBe(true)
    const merged = mergeProjectsByCrossProviderKey([
      summary('vault', '', { cost: 7 }),
    ])
    expect(merged.size).toBe(1)
    expect([...merged.keys()][0]!.startsWith('label:')).toBe(true)
    expect([...merged.values()][0]!.totalCostUSD).toBe(7)
  })

  it('documents multi-segment relative looksAbs over-merge residual', () => {
    // looksAbs treats "packages/api"-style relatives as abs-ish (Codex stripped).
    // Unrelated trees that share the same relative string therefore fold — known
    // residual, pinned here; not expanded into a #1260 fix.
    const over = mergeProjectsByCrossProviderKey([
      summary('api', 'packages/api', { cost: 10 }),
      summary('api', 'packages/api', { cost: 5 }),
    ])
    expect(over.size).toBe(1)
    expect([...over.values()][0]!.totalCostUSD).toBe(15)
    expect(costsByKey(over)['path:packages/api']).toBe(15)

    // Distinct relative trees stay separate.
    const distinct = mergeProjectsByCrossProviderKey([
      summary('api', 'packages/api', { cost: 10 }),
      summary('web', 'packages/web', { cost: 5 }),
    ])
    expect(distinct.size).toBe(2)
  })

  it('leading-dash project label aliases attach to unique abs parent', () => {
    const merged = mergeProjectsByCrossProviderKey([
      summary('vault', '/root/vault', { cost: 4 }),
      summary('-root-vault', '', { cost: 6 }),
    ])
    expect(merged.size).toBe(1)
    expect([...merged.values()][0]!.totalCostUSD).toBe(10)
  })

  it('Windows drive and POSIX abs of different roots stay separate', () => {
    const merged = mergeProjectsByCrossProviderKey([
      summary('vault', 'C:/root/vault', { cost: 10 }),
      summary('vault', '/root/vault', { cost: 5 }),
    ])
    expect(merged.size).toBe(2)
    const byKey = costsByKey(merged)
    expect(byKey['path:c:/root/vault']).toBe(10)
    expect(byKey['path:root/vault']).toBe(5)
  })

  it('UNC-style paths key as path and fold slash-normalized forms', () => {
    const unc = '\\\\server\\share\\vault' // JS: \\server\share\vault
    const a = crossProviderProjectKey(summary('share', unc))
    const b = crossProviderProjectKey(summary('share', '//server/share/vault'))
    expect(a.startsWith('path:')).toBe(true)
    expect(a).toBe(b)
    const merged = mergeProjectsByCrossProviderKey([
      summary('share', unc, { cost: 10 }),
      summary('share', '//server/share/vault', { cost: 5 }),
    ])
    expect(merged.size).toBe(1)
    expect([...merged.values()][0]!.totalCostUSD).toBe(15)

    const mixedUnc = mergeProjectsByCrossProviderKey([
      summary('share', '\\\\Server\\Share\\Vault', { cost: 10 }),
      summary('share', '//server/share/vault', { cost: 5 }),
    ])
    expect(mixedUnc.size).toBe(1)
    expect([...mixedUnc.values()][0]!.totalCostUSD).toBe(15)

    // Light \\?\ prefix form — still path-keyed after slash normalize.
    const long = crossProviderProjectKey(summary('vault', '\\\\?\\C:\\root\\vault'))
    expect(long.startsWith('path:')).toBe(true)
  })

  it('promotes display projectPath when existing lacks abs and incoming has abs', () => {
    // First row keys via wd but projectPath is a slug; second promotes display path.
    const merged = mergeProjectsByCrossProviderKey([
      summary('vault', 'vault', { cost: 3, wd: '/root/vault' }),
      summary('vault', '/root/vault', { cost: 7 }),
    ])
    expect(merged.size).toBe(1)
    const p = [...merged.values()][0]!
    expect(p.totalCostUSD).toBe(10)
    expect(normalizePathish(p.projectPath)).toMatch(/root\/vault$/)
  })

  it('display projectPath promotion is order-dependent when both look abs', () => {
    // Both Codex-stripped and POSIX look abs → first writer keeps projectPath.
    const aFirst = mergeProjectsByCrossProviderKey([
      summary('vault', 'root/vault', { cost: 1 }),
      summary('vault', '/root/vault', { cost: 2 }),
    ])
    const bFirst = mergeProjectsByCrossProviderKey([
      summary('vault', '/root/vault', { cost: 2 }),
      summary('vault', 'root/vault', { cost: 1 }),
    ])
    expect([...aFirst.values()][0]!.projectPath).toBe('root/vault')
    expect([...bFirst.values()][0]!.projectPath).toBe('/root/vault')
    expect([...aFirst.values()][0]!.totalCostUSD).toBe(3)
    expect([...bFirst.values()][0]!.totalCostUSD).toBe(3)
  })

  it('keeps a lowercase slug unattached when it matches two case-distinct roots', () => {
    const merged = mergeProjectsByCrossProviderKey([
      summary('Vault', '/a/Vault', { cost: 2 }),
      summary('vault', '/a/vault', { cost: 3 }),
      summary('a-vault', '', { cost: 7 }),
    ])
    expect(merged.size).toBe(3)
    expect([...merged.values()].map(p => p.totalCostUSD).sort((a, b) => a - b)).toEqual([2, 3, 7])
  })

  it('sums totalSavingsUSD when the same abs root is grouped', () => {
    const merged = mergeProjectsByCrossProviderKey([
      summary('shared', '/repos/shared', { cost: 10, savings: 30 }),
      summary('shared', '/repos/shared', { cost: 5, savings: 2 }),
    ])
    expect(merged.size).toBe(1)
    const p = [...merged.values()][0]!
    expect(p.totalCostUSD).toBe(15)
    expect(p.totalSavingsUSD).toBe(32)
  })
})

function normalizePathish(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()
}

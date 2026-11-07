import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error plain ESM script helpers
import { copilotOtelDbPath, assertInside, changedFiles, treeStats, warmReparseProblems } from '../../scripts/upgrade-path/lib.mjs'

describe('copilot fixture path', () => {
  const cases: [string, string, string][] = [
    ['darwin', '/tmp/h', '/tmp/h/Library/Application Support/Code/User/globalStorage/github.copilot-chat/agent-traces.db'],
    ['linux', '/tmp/h', '/tmp/h/.config/Code/User/globalStorage/github.copilot-chat/agent-traces.db'],
    ['win32', 'C:\\h', 'C:\\h\\AppData\\Roaming\\Code\\User\\globalStorage\\github.copilot-chat\\agent-traces.db'],
  ]
  for (const [platform, home, expected] of cases) {
    it(`${platform} stays under the corpus home`, () => {
      const p = copilotOtelDbPath(home, platform)
      expect(p).toBe(expected)
      expect(() => assertInside(home, p, platform)).not.toThrow()
    })
  }
  it('accepts a drive-root and a UNC-root home on win32', () => {
    for (const home of ['C:\\', '\\\\server\\share\\']) {
      expect(() => assertInside(home, copilotOtelDbPath(home, 'win32'), 'win32')).not.toThrow()
    }
  })
  it('refuses paths outside the home', () => {
    expect(() => assertInside('/tmp/h', '/tmp/other/x.db', 'linux')).toThrow(/outside corpus home/)
    expect(() => assertInside('/tmp/h', '/tmp/h/../x.db', 'linux')).toThrow()
    expect(() => assertInside('C:\\h', 'D:\\x.db', 'win32')).toThrow()
  })
  it('accepts a child whose name starts with two dots', () => {
    expect(() => assertInside('/tmp/h', '/tmp/h/..cache/x.db', 'linux')).not.toThrow()
  })
})

describe('compare.mjs parity', () => {
  const runRec = (base: object, up: object) => {
    const d = mkdtempSync(join(tmpdir(), 'cmp-'))
    for (const [dir, rec] of [['a', base], ['b', up]] as const) {
      mkdirSync(join(d, dir))
      writeFileSync(join(d, dir, 'menubar.json'), '{}')
      writeFileSync(join(d, dir, 'export.json'), JSON.stringify({ records: [{ provider: 'copilot', ...rec }] }))
    }
    const r = spawnSync(process.execPath, ['scripts/upgrade-path/compare.mjs', join(d, 'a'), join(d, 'b')], { encoding: 'utf8' })
    rmSync(d, { recursive: true, force: true })
    return r
  }
  const run = (baseTokens: number, upTokens: number) => {
    const d = mkdtempSync(join(tmpdir(), 'cmp-'))
    for (const [dir, t] of [['a', baseTokens], ['b', upTokens]] as const) {
      mkdirSync(join(d, dir))
      writeFileSync(join(d, dir, 'menubar.json'), '{}')
      writeFileSync(join(d, dir, 'export.json'), JSON.stringify({ records: [{ provider: 'zzz', cost: 1, inputTokens: t }] }))
    }
    const r = spawnSync(process.execPath, ['scripts/upgrade-path/compare.mjs', join(d, 'a'), join(d, 'b')], { encoding: 'utf8' })
    rmSync(d, { recursive: true, force: true })
    return r
  }
  it('fails on an unclassified provider that differs', () => {
    const r = run(1, 2)
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('FAIL: zzz')
  })
  it('copilot: the corpus-shaped input and cost drop passes', () => {
    const r = runRec({ cost: 3.62203, inputTokens: 875808, outputTokens: 5, cacheReadTokens: 248632 }, { cost: 3.0159764, inputTokens: 627176, outputTokens: 5, cacheReadTokens: 248632 })
    expect(r.status).toBe(0)
  })
  it('copilot: any figure off the pin fails', () => {
    const base = { cost: 3.62203, inputTokens: 875808, outputTokens: 5, cacheReadTokens: 10 }
    const pinned = { ...base, cost: 3.015976, inputTokens: 627176 }
    expect(runRec(base, pinned).status).toBe(0)
    const r = runRec(base, { ...pinned, inputTokens: 627175 })
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('#1830')
    expect(runRec(base, { ...pinned, cost: 3.015977 }).status).toBe(1)
    expect(runRec(base, { ...pinned, outputTokens: 4 }).status).toBe(1)
    expect(runRec(base, { ...pinned, cacheReadTokens: 11 }).status).toBe(1)
  })
  it('passes when an unclassified provider is identical', () => {
    expect(run(1, 1).status).toBe(0)
  })
})

describe('warm run check', () => {
  it('passes with no worker line and no changed files', () => {
    expect(warmReparseProblems([], changedFiles({ a: '1:2' }, { a: '1:2' }))).toEqual([])
  })
  it('fails when a cache file changed even with no worker line', () => {
    expect(warmReparseProblems([], changedFiles({ a: '1:2' }, { a: '2:2' }))).toHaveLength(1)
    expect(warmReparseProblems([], changedFiles({ a: '1:2' }, { a: '1:2', b: '1:1' }))).toHaveLength(1)
  })
  it('fails on a worker line reporting pending work', () => {
    expect(warmReparseProblems(['codeburn: parse workers=3 (12 pending files)'], [])).toHaveLength(1)
    expect(warmReparseProblems(['codeburn: parse workers=0 (0 pending files)'], [])).toEqual([])
    expect(warmReparseProblems(['codeburn: parse workers=3 (10 pending files)'], [])).toHaveLength(1)
  })
  it('treeStats ignores the envelope and index files but hashes pieces', () => {
    const d = mkdtempSync(join(tmpdir(), 'ts-'))
    writeFileSync(join(d, 'envelope.json'), '1'); writeFileSync(join(d, 'index.codex.aa.json'), '1'); writeFileSync(join(d, 'piece.json'), 'p')
    const before = treeStats(d)
    expect(Object.keys(before)).toEqual(['piece.json'])
    writeFileSync(join(d, 'envelope.json'), '2'); rmSync(join(d, 'index.codex.aa.json')); writeFileSync(join(d, 'index.codex.bb.json'), '1')
    expect(changedFiles(before, treeStats(d))).toEqual([])
    rmSync(d, { recursive: true, force: true })
  })
  it('treeStats skips a dangling symlink', () => {
    const d = mkdtempSync(join(tmpdir(), 'ts-'))
    symlinkSync(join(d, 'missing'), join(d, 'dangling'))
    writeFileSync(join(d, 'piece.json'), 'p')
    expect(Object.keys(treeStats(d))).toEqual(['piece.json'])
    rmSync(d, { recursive: true, force: true })
  })
  it('treeStats catches a same-size rewrite', () => {
    const d = mkdtempSync(join(tmpdir(), 'ts-'))
    writeFileSync(join(d, 'f'), 'aaaa')
    const before = treeStats(d)
    writeFileSync(join(d, 'f'), 'bbbb')
    expect(changedFiles(before, treeStats(d))).toEqual(['f'])
    rmSync(d, { recursive: true, force: true })
  })
})

describe('script wiring', () => {
  it('gen-corpus writes the Copilot fixture under the corpus home, not APPDATA', () => {
    const d = mkdtempSync(join(tmpdir(), 'gc-'))
    const home = join(d, 'home'); const appdata = join(d, 'real-appdata')
    mkdirSync(appdata)
    const code = `process.argv[2]=${JSON.stringify(home)};await import(${JSON.stringify(join(process.cwd(), 'scripts/upgrade-path/gen-corpus.mjs'))})`
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, APPDATA: appdata } })
    const fixture = copilotOtelDbPath(home, process.platform)
    const ok = r.status === 0 && existsSync(fixture) && readdirSync(appdata).length === 0
    rmSync(d, { recursive: true, force: true })
    expect(ok).toBe(true)
  })
  it('run.mjs uses the shared warm helpers', () => {
    const src = readFileSync('scripts/upgrade-path/run.mjs', 'utf8')
    expect(src).toMatch(/import \{[^}]*warmReparseProblems[^}]*\} from '\.\/lib\.mjs'/)
    expect(src).toMatch(/warmReparseProblems\(pending, changedFiles\(beforeTree, treeStats\(upgradeCache\)\)\)/)
  })
})

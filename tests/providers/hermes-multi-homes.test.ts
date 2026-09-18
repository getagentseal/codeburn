import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import { delimiter, dirname, join } from 'path'
import { homedir, tmpdir } from 'os'
import { createRequire } from 'node:module'
import { createHermesProvider } from '../../src/providers/hermes.js'
import { getHermesHomes } from '../../src/provider-dirs.js'
import { isSqliteAvailable } from '../../src/sqlite.js'
import { resetHermesSessionLedgerForTests } from '../../src/hermes-session-ledger.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return { ...actual, readdir: vi.fn(actual.readdir), stat: vi.fn(actual.stat) }
})

const requireForTest = createRequire(import.meta.url)

describe.skipIf(!isSqliteAvailable())('Hermes multi-home discovery', () => {
  let root: string
  let first: string
  let second: string

  async function session(home: string, id: string, profile?: string) {
    const dbPath = join(home, ...(profile ? ['profiles', profile] : []), 'state.db')
    await fs.mkdir(dirname(dbPath), { recursive: true })
    const { DatabaseSync } = requireForTest('node:sqlite')
    const db = new DatabaseSync(dbPath)
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY, model TEXT, input_tokens INTEGER,
          output_tokens INTEGER, started_at REAL
        );
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,
          tool_calls TEXT, timestamp REAL
        );
      `)
      db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)').run(id, 'gpt-5.5', 100, 20, 1779549200)
    } finally {
      db.close()
    }
    return `${dbPath}#hermes-session=${id}`
  }

  async function calls(provider = createHermesProvider()) {
    const result: ParsedProviderCall[] = []
    const seen = new Set<string>()
    for (const source of await provider.discoverSessions()) {
      for await (const call of provider.createSessionParser(source, seen).parse()) result.push(call)
    }
    return result
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'hermes-multi-'))
    first = join(root, 'first')
    second = join(root, 'second')
    vi.stubEnv('HERMES_HOME', undefined)
    vi.stubEnv('HERMES_HOMES', undefined)
    vi.stubEnv('CODEBURN_CACHE_DIR', join(root, 'cache'))
    resetHermesSessionLedgerForTests()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    resetHermesSessionLedgerForTests()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('keeps the default home and probe root', async () => {
    const home = join(homedir(), '.hermes')
    expect(getHermesHomes()).toEqual([home])
    expect(await createHermesProvider().probeRoots!()).toEqual([{ path: home, label: 'home' }])
  })

  it('keeps the legacy HERMES_HOME', async () => {
    vi.stubEnv('HERMES_HOME', first)
    const path = await session(first, 'one')
    expect((await createHermesProvider().discoverSessions()).map(source => source.path)).toEqual([path])
  })

  it('aggregates sessions from two homes and probes both', async () => {
    vi.stubEnv('HERMES_HOMES', [first, second].join(delimiter))
    const paths = [await session(first, 'one'), await session(second, 'two')]
    const provider = createHermesProvider()
    expect((await provider.discoverSessions()).map(source => source.path)).toEqual(paths)
    expect(await provider.probeRoots!()).toHaveLength(2)
    expect((await calls(provider)).map(call => call.sessionId)).toEqual(['one', 'two'])
  })

  it('prioritizes HERMES_HOMES over HERMES_HOME', async () => {
    vi.stubEnv('HERMES_HOME', first)
    vi.stubEnv('HERMES_HOMES', second)
    await session(first, 'ignored')
    await session(second, 'two')
    expect((await calls()).map(call => call.sessionId)).toEqual(['two'])
  })

  it('ignores empty entries and trims paths', () => {
    vi.stubEnv('HERMES_HOMES', ['', ` ${first} `, '', second, ''].join(delimiter))
    expect(getHermesHomes()).toEqual([first, second])
  })

  it.each(['', `${delimiter}  ${delimiter}`])('falls back to HOME for empty list %j', value => {
    vi.stubEnv('HERMES_HOME', first)
    vi.stubEnv('HERMES_HOMES', value)
    expect(getHermesHomes()).toEqual([first])
  })

  it('falls back to the default for an empty list without HOME', () => {
    vi.stubEnv('HERMES_HOMES', delimiter)
    expect(getHermesHomes()).toEqual([join(homedir(), '.hermes')])
  })

  it('skips missing, empty and invalid homes or databases', async () => {
    const invalid = join(root, 'invalid')
    const file = join(root, 'file')
    await fs.mkdir(invalid)
    await fs.writeFile(join(invalid, 'state.db'), 'not sqlite')
    await fs.writeFile(file, '')
    vi.stubEnv('HERMES_HOMES', [first, join(root, 'missing'), root, invalid, file, second].join(delimiter))
    await session(first, 'one')
    await session(second, 'two')
    expect(await calls()).toHaveLength(2)
  })

  it('skips unreadable homes without failing other homes', async () => {
    vi.stubEnv('HERMES_HOMES', [first, second].join(delimiter))
    await session(first, 'one')
    await session(second, 'two')
    for (const method of ['stat', 'readdir'] as const) {
      const original = fs[method]
      vi.spyOn(fs, method).mockImplementation(((...args: Parameters<typeof original>) => {
        if (String(args[0]).startsWith(first))
          return Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }))
        return (original as (...args: unknown[]) => unknown)(...args)
      }) as typeof original)
    }
    expect((await calls()).map(call => call.sessionId)).toEqual(['two'])
  })

  it('deduplicates repeated, normalized and symlinked homes', async () => {
    await session(first, 'one')
    const alias = join(root, 'alias')
    await fs.symlink(first, alias, process.platform === 'win32' ? 'junction' : 'dir')
    vi.stubEnv('HERMES_HOMES', [first, first, join(first, '..', 'first'), alias].join(delimiter))
    expect(await createHermesProvider().discoverSessions()).toHaveLength(1)
    expect(await calls()).toHaveLength(1)
  })

  it('deduplicates copies by the existing profile/session identity', async () => {
    vi.stubEnv('HERMES_HOMES', [first, second].join(delimiter))
    const path = await session(first, 'same')
    await session(second, 'same')
    expect((await createHermesProvider().discoverSessions()).map(source => source.path)).toEqual([path])
    expect(await calls()).toHaveLength(1)
  })

  it('discovers and parses named profiles in every home', async () => {
    vi.stubEnv('HERMES_HOMES', [first, second].join(delimiter))
    await session(first, 'same', 'coder')
    await session(second, 'same', 'analytics')
    const result = await calls()
    expect(result.map(call => call.deduplicationKey)).toEqual(['hermes:coder:same', 'hermes:analytics:same'])
    expect((await createHermesProvider().discoverSessions()).map(source => source.project)).toEqual([
      'coder',
      'analytics'
    ])
  })

  it.each([false, true])('deduplicates overlapping profile/home paths (profile first: %j)', async profileFirst => {
    await session(first, 'same', 'coder')
    const profileHome = join(first, 'profiles', 'coder')
    vi.stubEnv('HERMES_HOMES', (profileFirst ? [profileHome, first] : [first, profileHome]).join(delimiter))
    expect(await createHermesProvider().discoverSessions()).toHaveLength(1)
    expect((await calls()).map(call => call.deduplicationKey)).toEqual([
      profileFirst ? 'hermes:default:same' : 'hermes:coder:same'
    ])
  })

  it('prefers a real row in the second home over a ledger-only entry in the first', async () => {
    await session(first, 'one')
    const path = await session(second, 'two')
    await calls(createHermesProvider(second))
    vi.stubEnv('HERMES_HOMES', [first, second].join(delimiter))
    const sources = await createHermesProvider().discoverSessions()
    expect(sources.find(source => source.path.endsWith('=two'))?.path).toBe(path)
    expect((await calls()).map(call => call.sessionId)).toEqual(['one', 'two'])
  })

  it('keeps an explicit factory home ahead of environment overrides', async () => {
    vi.stubEnv('HERMES_HOMES', second)
    const path = await session(first, 'explicit')
    await session(second, 'ignored')
    expect((await createHermesProvider(first).discoverSessions()).map(source => source.path)).toEqual([path])
  })

  it('expands tilde in multi-home paths', () => {
    vi.stubEnv('HERMES_HOMES', ['~/.hermes', '~\\.hermes2'].join(delimiter))
    expect(getHermesHomes()).toEqual([join(homedir(), '.hermes'), join(homedir(), '.hermes2')])
  })
})

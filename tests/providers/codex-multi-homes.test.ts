import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import { delimiter, join } from 'path'
import { homedir, tmpdir } from 'os'
import { createCodexProvider } from '../../src/providers/codex.js'
import { getCodexHomes } from '../../src/provider-dirs.js'
import { listCodexSessionRefs } from '../../src/context-tree-codex.js'

// Wrap only readdir so EACCES can be simulated even when tests run as root.
vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return { ...actual, readdir: vi.fn(actual.readdir) }
})

describe('codex multi-home discovery', () => {
  const multi = 'CODEX_HOMES'
  const single = 'CODEX_HOME'
  let root: string
  let first: string
  let second: string

  async function session(home: string, id: string, archived = false) {
    const dir = join(home, archived ? 'archived_sessions' : 'sessions/2026/09/18')
    await fs.mkdir(dir, { recursive: true })
    const file = `rollout-2026-09-18T10-00-00-${id}.jsonl`
    await fs.writeFile(
      join(dir, file),
      JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/test/project' } }) + '\n'
    )
    return join(dir, file)
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'codex-multi-'))
    first = join(root, 'first')
    second = join(root, 'second')
    vi.stubEnv(multi, undefined)
    vi.stubEnv(single, undefined)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('keeps the default home and probe roots', async () => {
    expect(getCodexHomes()).toEqual([join(homedir(), '.codex')])
    expect((await createCodexProvider().probeRoots!()).map(r => r.path)).toEqual([
      join(homedir(), '.codex', 'sessions'),
      join(homedir(), '.codex', 'archived_sessions')
    ])
  })

  it('discovers through the legacy HOME', async () => {
    vi.stubEnv(single, first)
    const file = await session(first, 'one')
    expect((await createCodexProvider().discoverSessions()).map(s => s.path)).toEqual([file])
  })

  it('discovers sessions in two homes and reports both probe roots', async () => {
    vi.stubEnv(multi, [first, second].join(delimiter))
    const files = [await session(first, 'one'), await session(second, 'two')]
    expect((await createCodexProvider().discoverSessions()).map(s => s.path)).toEqual(files)
    expect(await createCodexProvider().probeRoots!()).toHaveLength(4)
    expect((await listCodexSessionRefs()).map(s => s.sessionId).sort()).toEqual(['one', 'two'])
  })

  it('gives HOMES priority over HOME', async () => {
    vi.stubEnv(single, first)
    vi.stubEnv(multi, second)
    await session(first, 'ignored')
    const file = await session(second, 'two')
    expect((await createCodexProvider().discoverSessions()).map(s => s.path)).toEqual([file])
  })

  it('ignores empty entries and trims paths', async () => {
    vi.stubEnv(multi, ['', ` ${first} `, '', second, ''].join(delimiter))
    expect(getCodexHomes()).toEqual([first, second])
    await session(first, 'one')
    await session(second, 'two')
    expect(await createCodexProvider().discoverSessions()).toHaveLength(2)
  })

  it.each(['', `${delimiter}  ${delimiter}`])('falls back to HOME for an empty list %j', async value => {
    vi.stubEnv(single, first)
    vi.stubEnv(multi, value)
    await session(first, 'one')
    expect(getCodexHomes()).toEqual([first])
    expect(await createCodexProvider().discoverSessions()).toHaveLength(1)
  })

  it('skips missing, empty and non-directory homes', async () => {
    const empty = join(root, 'empty')
    const file = join(root, 'file')
    await fs.mkdir(empty)
    await fs.writeFile(file, '')
    vi.stubEnv(multi, [first, join(root, 'missing'), empty, file, second].join(delimiter))
    await session(first, 'one')
    await session(second, 'two')
    expect(await createCodexProvider().discoverSessions()).toHaveLength(2)
  })

  it('continues when a home is unreadable', async () => {
    await session(first, 'one')
    await session(second, 'two')
    vi.stubEnv(multi, [first, second].join(delimiter))
    const original = fs.readdir
    vi.spyOn(fs, 'readdir').mockImplementation(((path: string) => {
      if (String(path).startsWith(first)) return Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }))
      return original(path)
    }) as typeof fs.readdir)
    expect(await createCodexProvider().discoverSessions()).toHaveLength(1)
  })

  it('deduplicates repeated, normalized and symlinked paths', async () => {
    await session(first, 'one')
    const alias = join(root, 'alias')
    await fs.symlink(first, alias, process.platform === 'win32' ? 'junction' : 'dir')
    vi.stubEnv(multi, [first, first, join(first, '..', 'first'), alias].join(delimiter))
    expect(await createCodexProvider().discoverSessions()).toHaveLength(1)
  })

  it('deduplicates copies of a session across homes', async () => {
    vi.stubEnv(multi, [first, second].join(delimiter))
    await session(first, 'same')
    await session(second, 'same', true)
    await session(second, 'unique')
    expect(await createCodexProvider().discoverSessions()).toHaveLength(2)
  })

  it('keeps an explicit factory path ahead of environment overrides', async () => {
    vi.stubEnv(multi, second)
    vi.stubEnv(single, second)
    const file = await session(first, 'explicit')
    await session(second, 'ignored')
    const explicit = createCodexProvider(first)
    expect((await explicit.discoverSessions()).map(source => source.path)).toEqual([file])
  })

  it('uses the default when the multi list is entirely empty and HOME is unset', () => {
    vi.stubEnv(multi, `${delimiter} ${delimiter}`)
    expect(getCodexHomes()).toEqual([join(homedir(), '.codex')])
  })

  it('expands tilde in multi-home paths', () => {
    vi.stubEnv(multi, ['~/.codex', '~\\.codex2'].join(delimiter))
    expect(getCodexHomes()).toEqual([join(homedir(), '.codex'), join(homedir(), '.codex2')])
  })
})

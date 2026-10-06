import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, posix, win32 } from 'node:path'
import { tmpdir } from 'node:os'
import * as os from 'os'
import { createRequire } from 'node:module'
import { createCopilotProvider, getVSCodeGlobalStorageDirs, getVSCodeWorkspaceStorageDirs } from '../src/providers/copilot.js'
import { clearCursorWorkspaceMapCache, createCursorProvider } from '../src/providers/cursor.js'
import { computeEnvFingerprint } from '../src/session-cache.js'
import { isSqliteAvailable } from '../src/sqlite.js'

const requireForTest = createRequire(import.meta.url)
vi.mock('os', async importOriginal => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, platform: vi.fn(actual.platform) }
})
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'codeburn-editor-roots-'))
  vi.stubEnv('APPDATA', root)
  vi.stubEnv('XDG_CONFIG_HOME', root)
  vi.stubEnv('CODEBURN_COPILOT_DISABLE_OTEL', '1')
  clearCursorWorkspaceMapCache()
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  clearCursorWorkspaceMapCache()
  await rm(root, { recursive: true, force: true })
})

describe('redirected editor data paths', () => {
  it.each([
    ['win32', 'C:\\Users\\fixture', 'D:\\redirected-roaming', win32.join],
    ['linux', '/home/fixture', '/mnt/redirected-config', posix.join],
  ] as const)('uses the %s application-data override for every VS Code variant', (os, home, redirected, j) => {
    vi.stubEnv(os === 'win32' ? 'APPDATA' : 'XDG_CONFIG_HOME', redirected)
    for (const [getDirs, storage] of [
      [getVSCodeWorkspaceStorageDirs, 'workspaceStorage'],
      [getVSCodeGlobalStorageDirs, 'globalStorage'],
    ] as const) {
      expect(getDirs(home, os)).toEqual(['Code', 'Code - Insiders', 'VSCodium'].map(editor => j(redirected, editor, 'User', storage)))
    }
  })

  it.each([undefined, ''])('keeps platform defaults for absent or empty overrides (%s)', value => {
    vi.stubEnv('APPDATA', value)
    vi.stubEnv('XDG_CONFIG_HOME', value)
    expect(getVSCodeWorkspaceStorageDirs('C:\\Users\\fixture', 'win32')[0]).toBe(win32.join('C:\\Users\\fixture', 'AppData', 'Roaming', 'Code', 'User', 'workspaceStorage'))
    expect(getVSCodeGlobalStorageDirs('/home/fixture', 'linux')[0]).toBe('/home/fixture/.config/Code/User/globalStorage')
  })

  it('keeps macOS paths independent of APPDATA and XDG_CONFIG_HOME', () => {
    expect(getVSCodeGlobalStorageDirs('/Users/fixture', 'darwin')).toEqual(['Code', 'Code - Insiders', 'VSCodium'].map(editor => posix.join('/Users/fixture', 'Library', 'Application Support', editor, 'User', 'globalStorage')))
  })

  it.skipIf(process.platform === 'darwin')('discovers Copilot journals and watches both redirected storage folders', async () => {
    const workspace = join(root, 'Code', 'User', 'workspaceStorage')
    const global = join(root, 'Code', 'User', 'globalStorage')
    const wsChats = join(workspace, 'hash', 'chatSessions')
    const globalChats = join(global, 'emptyWindowChatSessions')
    await mkdir(wsChats, { recursive: true })
    await mkdir(globalChats, { recursive: true })
    await writeFile(join(workspace, 'hash', 'workspace.json'), JSON.stringify({ folder: 'file:///work/redirected' }))
    const journal = JSON.stringify({ kind: 0, v: { sessionId: 'redirected', requests: [] } }) + '\n'
    const wsPath = join(wsChats, 'workspace.jsonl')
    const globalPath = join(globalChats, 'empty.jsonl')
    await writeFile(wsPath, journal)
    await writeFile(globalPath, journal)
    const provider = createCopilotProvider(join(root, 'no-cli'), undefined, undefined, join(root, 'no-jb'), join(root, 'no-store'))
    expect((await provider.discoverSessions()).map(s => s.path).sort()).toEqual([wsPath, globalPath].sort())
    expect((await provider.probeRoots!()).map(r => r.path)).toEqual(expect.arrayContaining([workspace, global]))
  })

  it.skipIf(process.platform === 'darwin' || !isSqliteAvailable())('discovers the redirected Cursor database and its sibling workspace mapping', async () => {
    const { DatabaseSync } = requireForTest('node:sqlite') as typeof import('node:sqlite')
    const global = join(root, 'Cursor', 'User', 'globalStorage')
    const workspace = join(root, 'Cursor', 'User', 'workspaceStorage', 'hash')
    await mkdir(global, { recursive: true })
    await mkdir(workspace, { recursive: true })
    const dbPath = join(global, 'state.vscdb')
    const globalDb = new DatabaseSync(dbPath)
    globalDb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)')
    globalDb.close()
    const workspaceDb = new DatabaseSync(join(workspace, 'state.vscdb'))
    workspaceDb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)')
    workspaceDb.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('composer.composerData', JSON.stringify({ allComposers: [{ composerId: 'redirected-composer' }] }))
    workspaceDb.close()
    await writeFile(join(workspace, 'workspace.json'), JSON.stringify({ folder: 'file:///work/redirected' }))

    const provider = createCursorProvider()
    expect(await provider.probeRoots!()).toEqual([{ path: dbPath, label: 'db' }])
    expect((await provider.discoverSessions()).map(s => s.project)).toContain('-work-redirected')
  })

  it('keeps constructor storage overrides ahead of application-data defaults', async () => {
    const workspace = join(root, 'explicit-ws')
    const global = join(root, 'explicit-global')
    const provider = createCopilotProvider(join(root, 'no-cli'), workspace, global, join(root, 'no-jb'), join(root, 'no-store'))
    const roots = (await provider.probeRoots!()).map(r => r.path)
    expect(roots).toEqual(expect.arrayContaining([workspace, global]))
    expect(roots).not.toContain(join(root, 'Code', 'User', 'workspaceStorage'))
    expect(await createCursorProvider(join(root, 'explicit.vscdb')).probeRoots!()).toEqual([{ path: join(root, 'explicit.vscdb'), label: 'db' }])
  })

  it.skipIf(!isSqliteAvailable())('discovers OTel in a redirected Linux global-storage root', async () => {
    vi.stubEnv('APPDATA', join(root, 'unused-windows-root'))
    const { DatabaseSync } = requireForTest('node:sqlite') as typeof import('node:sqlite')
    // posix.join can operate on this temporary Windows path too: Node's fs
    // accepts its forward slashes, so Linux discovery is exercised on any host.
    const global = getVSCodeGlobalStorageDirs(root, 'linux')[0]!
    const otelDir = posix.join(global, 'github.copilot-chat')
    const dbPath = posix.join(otelDir, 'agent-traces.db')
    await mkdir(otelDir, { recursive: true })
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE spans (span_id TEXT PRIMARY KEY, trace_id TEXT, operation_name TEXT, start_time_ms INTEGER, response_model TEXT);
      CREATE TABLE span_attributes (id INTEGER PRIMARY KEY, span_id TEXT, key TEXT, value TEXT);
      INSERT INTO spans VALUES ('span', 'trace', 'chat', 1780157113020, 'gpt-4o');
      INSERT INTO span_attributes VALUES (1, 'span', 'gen_ai.conversation.id', 'redirected-otel');
      INSERT INTO span_attributes VALUES (2, 'span', 'gen_ai.usage.input_tokens', '100');
      INSERT INTO span_attributes VALUES (3, 'span', 'gen_ai.usage.output_tokens', '20');
    `)
    db.close()
    vi.spyOn(os, 'platform').mockReturnValue('linux')
    vi.stubEnv('CODEBURN_COPILOT_DISABLE_OTEL', '')
    const provider = createCopilotProvider(join(root, 'no-cli'), undefined, undefined, join(root, 'no-jb'), join(root, 'no-store'))
    expect((await provider.discoverSessions()).map(s => s.path)).toContain(join(dbPath))
    expect((await provider.probeRoots!()).map(r => r.path)).toContain(join(otelDir))
  })

  it.each(['APPDATA', 'XDG_CONFIG_HOME'])('invalidates Cursor caches on %s changes without discarding durable Copilot history', variable => {
    const cursorBefore = computeEnvFingerprint('cursor')
    const copilotBefore = computeEnvFingerprint('copilot')
    vi.stubEnv(variable, join(root, 'moved'))
    expect(computeEnvFingerprint('cursor')).not.toBe(cursorBefore)
    expect(computeEnvFingerprint('copilot')).toBe(copilotBefore)
  })
})

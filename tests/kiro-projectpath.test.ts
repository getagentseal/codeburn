/**
 * Tests for kiro projectPath emission (sync attribution support).
 *
 * The kiro provider historically reduced the session's working directory to
 * `basename(cwd)` for display and discarded the full path. Sync attribution
 * (`codeburn sync push --attribution`) needs the full path on
 * `ParsedProviderCall.projectPath` to resolve the git repo — without it,
 * every kiro session is attribution-blind.
 *
 * Also covers the cache side: projectPath is persisted via CachedCall, so
 * entries cached BEFORE the parser learned to emit it must re-parse. That is
 * driven by the PROVIDER_PARSE_VERSIONS.kiro bump (project-path-v1); a cache
 * seeded at the pre-bump fingerprint must be discarded.
 */

import { mkdir, writeFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

import { clearSessionCache, parseAllSessions } from '../src/parser.js'
import {
  CACHE_VERSION,
  computeEnvFingerprint,
  fingerprintFile,
  type SessionCache,
} from '../src/session-cache.js'
import { writeCacheOnDisk } from './fixtures/session-cache-io.js'

// The kiro provider reads homedir()/env at call time in discovery; HOME must
// point at the test root before ../src/parser.js is evaluated (see the
// equivalent note in kiro-cache-invalidation.test.ts).
const testRoot = vi.hoisted(() => {
  const root = `${process.env['TMPDIR'] || '/tmp'}/kiro-projpath-${process.pid}-${Date.now()}`
  process.env['HOME'] = `${root}/home`
  process.env['USERPROFILE'] = `${root}/home`
  return root
})

const HOME = join(testRoot, 'home')
const CACHE_DIR = join(testRoot, 'cache')
const KIRO_SESSIONS = join(HOME, '.kiro', 'sessions')
const CLI_DIR = join(KIRO_SESSIONS, 'cli')

const CLI_CWD = '/local/home/testuser/workplace/my-project'
const V2_WORKSPACE = '/local/home/testuser/workplace/ide-project'

beforeEach(() => {
  process.env['HOME'] = HOME
  process.env['USERPROFILE'] = HOME
  process.env['CODEBURN_CACHE_DIR'] = CACHE_DIR
  delete process.env['KIRO_HOME']
  clearSessionCache()
})

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true })
})

/** Write a minimal kiro CLI session: <id>.jsonl entries + companion .json meta. */
async function seedCliSession(id: string, cwd: string): Promise<string> {
  await mkdir(CLI_DIR, { recursive: true })
  const jsonlPath = join(CLI_DIR, `${id}.jsonl`)
  const entries = [
    { kind: 'Prompt', data: { content: [{ kind: 'text', data: 'add a feature' }] } },
    { kind: 'AssistantMessage', data: { content: [{ kind: 'text', data: 'Done — added the feature and tests.' }] } },
  ]
  await writeFile(jsonlPath, entries.map(e => JSON.stringify(e)).join('\n'))
  await writeFile(join(CLI_DIR, `${id}.json`), JSON.stringify({
    session_id: id,
    cwd,
    created_at: '2026-08-01T10:00:00Z',
    updated_at: '2026-08-01T10:05:00Z',
    session_state: {
      rts_model_state: { model_info: { model_id: 'auto' } },
      conversation_metadata: {
        user_turn_metadatas: [
          { end_timestamp: '2026-08-01T10:05:00Z', metering_usage: [] },
        ],
      },
    },
  }))
  return jsonlPath
}

/** Write a minimal v2 IDE session: sessions/<hash>/sess_<id>/{session.json,messages.jsonl}. */
async function seedV2Session(id: string, workspacePath: string): Promise<void> {
  const sessDir = join(KIRO_SESSIONS, 'f'.repeat(32), `sess_${id}`)
  await mkdir(sessDir, { recursive: true })
  await writeFile(join(sessDir, 'session.json'), JSON.stringify({
    id,
    modelId: 'auto',
    workspacePaths: [workspacePath],
    createdAt: '2026-08-01T11:00:00Z',
  }))
  const events = [
    { timestamp: '2026-08-01T11:00:00Z', payload: { type: 'user', content: 'fix the bug' } },
    { timestamp: '2026-08-01T11:00:01Z', payload: { type: 'turn_start', executionId: 'x1' } },
    { timestamp: '2026-08-01T11:00:05Z', payload: { type: 'assistant', content: 'Fixed the bug in handler.ts by checking null first.' } },
    { timestamp: '2026-08-01T11:00:06Z', payload: { type: 'turn_end', executionId: 'x1' } },
  ]
  await writeFile(join(sessDir, 'messages.jsonl'), events.map(e => JSON.stringify(e)).join('\n'))
}

function kiroAgentDir(): string {
  if (process.platform === 'darwin') {
    return join(HOME, 'Library', 'Application Support', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent')
  }
  if (process.platform === 'win32') {
    return join(HOME, 'AppData', 'Roaming', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent')
  }
  return join(HOME, '.config', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent')
}

/** Write a minimal IDE workspace-session:
 *  <agentDir>/workspace-sessions/<base64(workspacePath), '='→'_'>/<sessionId>.json */
async function seedWorkspaceSession(id: string, workspaceDirectory: string): Promise<void> {
  const encoded = Buffer.from(workspaceDirectory, 'utf-8').toString('base64').replace(/=/g, '_')
  const dir = join(kiroAgentDir(), 'workspace-sessions', encoded)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${id}.json`), JSON.stringify({
    sessionId: id,
    selectedModel: 'auto',
    workspaceDirectory,
    history: [
      { message: { role: 'user', content: 'refactor the config loader' } },
      { message: { role: 'assistant', content: 'Refactored the loader into three small functions with tests.' } },
    ],
  }))
}

async function kiroCalls() {
  const projects = await parseAllSessions(undefined, 'kiro')
  return projects.flatMap(p => p.sessions.map(s => ({
    project: p.project,
    projectPath: p.projectPath,
    workingDirectory: s.workingDirectory,
    session: s,
  })))
}

describe('kiro projectPath emission', () => {
  it('CLI session: projectPath is the full meta.cwd, project the basename', async () => {
    await seedCliSession('cli-001', CLI_CWD)
    const rows = await kiroCalls()
    const row = rows.find(r => r.project === 'my-project')
    expect(row).toBeDefined()
    expect(row!.projectPath).toBe(CLI_CWD)
  })

  it('v2 IDE session: projectPath is workspacePaths[0]', async () => {
    await seedV2Session('v2-001', V2_WORKSPACE)
    const rows = await kiroCalls()
    const row = rows.find(r => r.project === 'ide-project')
    expect(row).toBeDefined()
    expect(row!.projectPath).toBe(V2_WORKSPACE)
  })

  it('workspace session: projectPath is workspaceDirectory', async () => {
    const WS_DIR = '/local/home/testuser/workplace/ws-project'
    await seedWorkspaceSession('ws-001', WS_DIR)
    const rows = await kiroCalls()
    const row = rows.find(r => r.project === 'ws-project')
    expect(row).toBeDefined()
    expect(row!.projectPath).toBe(WS_DIR)
  })
})

/**
 * Sync attribution reads `session.workingDirectory`, NOT projectPath:
 * computeAttributionRecords calls buildRepoGroups in "trusted-session-cwd"
 * mode, resolves the repo from that field, and drops any session whose own
 * directory does not resolve. project-path-v1 populated projectPath alone, so
 * kiro sessions stayed attribution-blind while appearing to carry the path.
 */
describe('kiro workingDirectory emission (sync attribution)', () => {
  it('CLI session: workingDirectory is the full meta.cwd', async () => {
    await seedCliSession('cli-101', CLI_CWD)
    const rows = await kiroCalls()
    const row = rows.find(r => r.project === 'my-project')
    expect(row).toBeDefined()
    expect(row!.workingDirectory).toBe(CLI_CWD)
  })

  it('v2 IDE session: workingDirectory is workspacePaths[0]', async () => {
    await seedV2Session('v2-101', V2_WORKSPACE)
    const rows = await kiroCalls()
    const row = rows.find(r => r.project === 'ide-project')
    expect(row).toBeDefined()
    expect(row!.workingDirectory).toBe(V2_WORKSPACE)
  })

  it('workspace session: workingDirectory is workspaceDirectory', async () => {
    const WS_DIR = '/local/home/testuser/workplace/ws-wd-project'
    await seedWorkspaceSession('ws-101', WS_DIR)
    const rows = await kiroCalls()
    const row = rows.find(r => r.project === 'ws-wd-project')
    expect(row).toBeDefined()
    expect(row!.workingDirectory).toBe(WS_DIR)
  })

  // Provenance is asserted implicitly by the three cases above rather than by a
  // test of its own. parser.ts only promotes a call's workingDirectory onto the
  // session when workingDirectoryProvenance === 'provider-field', failing closed
  // otherwise (an unmarked value may have been synthesized from projectPath by
  // an older build). So a populated session.workingDirectory is itself proof the
  // marker was stamped; the marker lives on cached calls, which parseAllSessions
  // does not surface.

  // A home-root cwd is rejected by isTrustedAbsoluteWorkingDirectory, so the
  // field must be absent rather than present-and-untrusted. Real Kiro IDE
  // sessions opened on the home directory hit this: 5 of 8 observed
  // session.json files carried workspacePaths: ['/home/<user>'].
  it('a home-root cwd yields projectPath but no workingDirectory', async () => {
    await seedCliSession('cli-103', HOME)
    const rows = await kiroCalls()
    const row = rows.find(r => r.projectPath === HOME)
    expect(row).toBeDefined()
    expect(row!.workingDirectory).toBeUndefined()
  })
})

describe('kiro projectPath cache invalidation (project-path-v1 bump)', () => {
  // The fingerprint a cache written by the PREVIOUS release carries: same env
  // vars, but the parser version before the project-path-v1 bump.
  function preBumpFingerprint(): string {
    const parts = [`KIRO_HOME=${process.env['KIRO_HOME'] ?? ''}`, 'parser=ide-parsing-v1-est-cost']
    return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16)
  }

  it('the bump changed the env fingerprint', () => {
    expect(computeEnvFingerprint('kiro')).not.toBe(preBumpFingerprint())
  })

  it('a pre-bump cache entry (no projectPath) is re-parsed and gains projectPath', async () => {
    const jsonlPath = await seedCliSession('cli-002', CLI_CWD)

    // Seed a cache exactly as the pre-bump release would have left it:
    // correct file fingerprint, pre-bump env fingerprint, turns WITHOUT
    // projectPath on the cached calls.
    const fp = await fingerprintFile(jsonlPath)
    if (!fp) throw new Error('failed to fingerprint seeded session file')
    const cache: SessionCache = {
      version: CACHE_VERSION,
      providers: {
        kiro: {
          envFingerprint: preBumpFingerprint(),
          files: {
            [jsonlPath]: { fingerprint: fp, mcpInventory: [], turns: [] },
          },
        },
      },
    }
    await mkdir(CACHE_DIR, { recursive: true })
    await writeCacheOnDisk(cache)
    clearSessionCache()

    const rows = await kiroCalls()
    const row = rows.find(r => r.project === 'my-project')
    expect(row).toBeDefined()
    expect(row!.projectPath).toBe(CLI_CWD)
  })
})

/**
 * The working-directory-v1 bump. A cache written by the project-path-v1 release
 * holds projectPath but no workingDirectory, and without a fingerprint change
 * those entries would be served forever — leaving attribution broken for exactly
 * the users who already had a warm cache, which is everyone upgrading.
 */
describe('kiro workingDirectory cache invalidation (working-directory-v1 bump)', () => {
  /** The fingerprint the project-path-v1 release wrote. */
  function projectPathV1Fingerprint(): string {
    const parts = [
      `KIRO_HOME=${process.env['KIRO_HOME'] ?? ''}`,
      'parser=ide-parsing-v1-est-cost-project-path-v1',
    ]
    return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16)
  }

  it('the bump changed the env fingerprint', () => {
    expect(computeEnvFingerprint('kiro')).not.toBe(projectPathV1Fingerprint())
  })

  it('a project-path-v1 cache entry is re-parsed and gains workingDirectory', async () => {
    const jsonlPath = await seedCliSession('cli-201', CLI_CWD)
    const fp = await fingerprintFile(jsonlPath)
    if (!fp) throw new Error('failed to fingerprint seeded session file')
    const cache: SessionCache = {
      version: CACHE_VERSION,
      providers: {
        kiro: {
          envFingerprint: projectPathV1Fingerprint(),
          files: {
            [jsonlPath]: { fingerprint: fp, mcpInventory: [], turns: [] },
          },
        },
      },
    }
    await mkdir(CACHE_DIR, { recursive: true })
    await writeCacheOnDisk(cache)
    clearSessionCache()

    const rows = await kiroCalls()
    const row = rows.find(r => r.project === 'my-project')
    expect(row).toBeDefined()
    expect(row!.workingDirectory).toBe(CLI_CWD)
  })
})

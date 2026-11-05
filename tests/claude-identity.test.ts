import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  applyClaudeIdentities, identityAt, identityId, identityLogPath, identitySplit, observeClaudeIdentities,
  readIdentityLog, setIdentityLabel, type IdentityLog,
} from '../src/claude-identity.js'
import { parseAllSessions } from '../src/parser.js'
import { buildOtlpPayload } from '../src/sync/otlp.js'
import { collectUnsentCalls } from '../src/sync/push.js'
import { setHome } from './setup/home.js'

const ACCOUNT_A = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ORG_A = '22222222-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ACCOUNT_B = '33333333-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ORG_B = '44444444-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const hash = (uuid: string) => createHash('sha256').update(uuid).digest('hex').slice(0, 12)

let home: string
let configDir: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'codeburn-identity-'))
  configDir = join(home, '.claude')
  setHome(home)
  process.env['CLAUDE_CONFIG_DIR'] = configDir
  process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] = join(home, 'desktop-sessions')
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

async function signIn(accountUuid: string, orgUuid: string, orgName: string, mtime: Date): Promise<void> {
  const file = join(home, '.claude.json')
  await writeFile(file, JSON.stringify({
    numStartups: 3,
    oauthAccount: { accountUuid, organizationUuid: orgUuid, organizationName: orgName, emailAddress: 'me@example.com', displayName: 'Me' },
  }))
  await utimes(file, mtime, mtime)
}

function entry(accountUuid: string, orgUuid: string, label: string, observedAt: string, dir = configDir) {
  return { accountHash: hash(accountUuid), orgHash: hash(orgUuid), label, observedAt, configDir: dir }
}

async function seedLog(entries: ReturnType<typeof entry>[]): Promise<void> {
  await mkdir(join(home, '.config', 'codeburn'), { recursive: true })
  await writeFile(identityLogPath(), JSON.stringify({ version: 1, entries, labels: {} }))
}

function sessionLines(sessionId: string, timestamp: string): string {
  return [
    { type: 'user', sessionId, timestamp, message: { role: 'user', content: 'add feature' } },
    {
      type: 'assistant', sessionId, timestamp,
      message: { id: `msg-${sessionId}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1000, output_tokens: 100 } },
    },
  ].map(line => JSON.stringify(line)).join('\n') + '\n'
}

async function writeSession(sessionId: string, timestamp: string): Promise<void> {
  const dir = join(configDir, 'projects', 'notes-app')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${sessionId}.jsonl`), sessionLines(sessionId, timestamp))
}

describe('observeClaudeIdentities', () => {
  it('logs hashes and the organization name, never a raw id or email, mode 0600', async () => {
    await signIn(ACCOUNT_A, ORG_A, 'Acme Corp', new Date('2026-11-01T10:00:00Z'))
    await observeClaudeIdentities(new Date('2026-11-01T10:00:00Z'))
    const text = await readFile(identityLogPath(), 'utf-8')
    expect(JSON.parse(text).entries).toEqual([entry(ACCOUNT_A, ORG_A, 'Acme Corp', '2026-11-01T10:00:00.000Z')])
    for (const secret of [ACCOUNT_A, ORG_A, 'me@example.com']) expect(text).not.toContain(secret)
    if (process.platform !== 'win32') expect((await stat(identityLogPath())).mode & 0o777).toBe(0o600)
  })

  it('appends only when the account or organization changes, and never rewrites history', async () => {
    await signIn(ACCOUNT_A, ORG_A, 'Acme Corp', new Date('2026-11-01T10:00:00Z'))
    await observeClaudeIdentities(new Date('2026-11-01T10:00:00Z'))
    await signIn(ACCOUNT_A, ORG_A, 'Acme Corp', new Date('2026-11-01T11:00:00Z'))
    await observeClaudeIdentities(new Date('2026-11-01T11:00:00Z'))
    expect((await readIdentityLog())!.entries).toHaveLength(1)

    await signIn(ACCOUNT_B, ORG_B, 'Home', new Date('2026-11-01T12:00:00Z'))
    await observeClaudeIdentities(new Date('2026-11-01T12:00:00Z'))
    await signIn(ACCOUNT_A, ORG_A, 'Acme Corp', new Date('2026-11-01T13:00:00Z'))
    await observeClaudeIdentities(new Date('2026-11-01T13:00:00Z'))
    expect((await readIdentityLog())!.entries.map(e => [e.accountHash, e.observedAt])).toEqual([
      [hash(ACCOUNT_A), '2026-11-01T10:00:00.000Z'],
      [hash(ACCOUNT_B), '2026-11-01T12:00:00.000Z'],
      [hash(ACCOUNT_A), '2026-11-01T13:00:00.000Z'],
    ])
  })

  it('logs one account moving between two organizations as two identities', async () => {
    await signIn(ACCOUNT_A, ORG_A, 'Personal', new Date('2026-11-01T10:00:00Z'))
    await observeClaudeIdentities(new Date('2026-11-01T10:00:00Z'))
    await signIn(ACCOUNT_A, ORG_B, 'Team', new Date('2026-11-01T11:00:00Z'))
    await observeClaudeIdentities(new Date('2026-11-01T11:00:00Z'))
    const log = (await readIdentityLog())!
    expect(log.entries.map(e => [e.accountHash, e.orgHash, e.label])).toEqual([[hash(ACCOUNT_A), hash(ORG_A), 'Personal'], [hash(ACCOUNT_A), hash(ORG_B), 'Team']])
    expect(new Set(log.entries.map(identityId)).size).toBe(2)
  })

  it('writes nothing for a config without a signed-in account', async () => {
    await writeFile(join(home, '.claude.json'), JSON.stringify({ primaryApiKey: 'sk-test', numStartups: 1 }))
    await observeClaudeIdentities()
    expect((await readIdentityLog())!.entries).toEqual([])
  })
})

describe('identityAt', () => {
  const log: IdentityLog = {
    version: 1,
    labels: {},
    entries: [
      entry(ACCOUNT_A, ORG_A, 'Acme Corp', '2026-11-01T10:00:00.000Z', '/c'),
      entry(ACCOUNT_B, ORG_B, 'Home', '2026-11-01T12:00:00.000Z', '/c'),
      entry(ACCOUNT_B, ORG_B, 'Home', '2026-11-01T09:00:00.000Z', '/other'),
    ],
  }
  it('takes the last observation at or before the session start, per config dir', () => {
    expect(identityAt(log, '/c', '2026-11-01T09:59:59.000Z').hash).toBe('unattributed')
    expect(identityAt(log, '/c', '2026-11-01T10:00:00.000Z')).toEqual({ hash: hash(ORG_A), label: 'Acme Corp' })
    expect(identityAt(log, '/c', '2026-11-01T11:59:00.000Z').hash).toBe(hash(ORG_A))
    expect(identityAt(log, '/c', '2026-11-01T12:00:00.000Z').hash).toBe(hash(ORG_B))
    expect(identityAt(log, '/c', '2026-11-02T00:00:00.000Z').hash).toBe(hash(ORG_B))
    expect(identityAt(log, '/other', '2026-11-01T10:00:00.000Z').hash).toBe(hash(ORG_B))
    expect(identityAt(log, undefined, '2026-11-01T13:00:00.000Z').hash).toBe('unattributed')
  })

  it('splits one account across two organizations, and falls back to the account without one', () => {
    const orgs: IdentityLog = {
      version: 1,
      labels: {},
      entries: [
        entry(ACCOUNT_A, ORG_A, 'Personal', '2026-11-01T10:00:00.000Z', '/c'),
        entry(ACCOUNT_A, ORG_B, 'Team', '2026-11-01T12:00:00.000Z', '/c'),
        { accountHash: hash(ACCOUNT_B), label: '', observedAt: '2026-11-01T14:00:00.000Z', configDir: '/c' },
      ],
    }
    expect(identityAt(orgs, '/c', '2026-11-01T11:00:00.000Z')).toEqual({ hash: hash(ORG_A), label: 'Personal' })
    expect(identityAt(orgs, '/c', '2026-11-01T13:00:00.000Z')).toEqual({ hash: hash(ORG_B), label: 'Team' })
    expect(identityAt(orgs, '/c', '2026-11-01T15:00:00.000Z')).toEqual({ hash: hash(ACCOUNT_B), label: hash(ACCOUNT_B) })
  })

  it('prefers a local label override, without touching the entries', async () => {
    await seedLog(log.entries)
    await setIdentityLabel(hash(ORG_A), 'work')
    const saved = (await readIdentityLog())!
    expect(identityAt(saved, '/c', '2026-11-01T11:00:00.000Z').label).toBe('work')
    expect(saved.entries).toEqual(log.entries)
    await expect(setIdentityLabel('ffffffffffff', 'x')).rejects.toThrow(/no Claude identity/)
  })
})

describe('applyClaudeIdentities on parsed sessions', () => {
  it('stays silent with one identity and stamps sessions with two', async () => {
    const now = Date.now()
    const iso = (offsetMin: number) => new Date(now + offsetMin * 60_000).toISOString()
    await writeSession('before', iso(-180))
    await writeSession('during-a', iso(-90))
    await writeSession('during-b', iso(-30))
    const range = { start: new Date(now - 86_400_000), end: new Date(now + 60_000) }

    await seedLog([entry(ACCOUNT_A, ORG_A, 'Acme Corp', iso(-120))])
    await signIn(ACCOUNT_A, ORG_A, 'Acme Corp', new Date(now - 120 * 60_000))
    const single = await parseAllSessions(range, 'claude')
    expect(single.flatMap(p => p.sessions).some(s => 'identity' in s)).toBe(false)
    expect(identitySplit(single)).toBeUndefined()

    await seedLog([entry(ACCOUNT_A, ORG_A, 'Acme Corp', iso(-120)), entry(ACCOUNT_B, ORG_B, 'Home', iso(-60))])
    await signIn(ACCOUNT_B, ORG_B, 'Home', new Date(now - 60 * 60_000))
    const projects = await parseAllSessions(range, 'claude')
    const byId = Object.fromEntries(projects.flatMap(p => p.sessions).map(s => [s.sessionId, s.identity?.label]))
    expect(byId).toEqual({ before: 'unattributed', 'during-a': 'Acme Corp', 'during-b': 'Home' })
    expect(identitySplit(projects)!.map(r => r.label).sort()).toEqual(['Acme Corp', 'Home', 'unattributed'])
    expect((await readIdentityLog())!.entries).toHaveLength(2)

    const wire = JSON.stringify(buildOtlpPayload(collectUnsentCalls(projects).allCalls))
    for (const leak of [hash(ACCOUNT_A), hash(ACCOUNT_B), hash(ORG_A), hash(ORG_B), 'Acme Corp', 'Home', 'unattributed']) expect(wire).not.toContain(leak)
  })

  it('leaves non-Claude sessions alone', async () => {
    await seedLog([entry(ACCOUNT_A, ORG_A, 'A', '2026-11-01T10:00:00.000Z'), entry(ACCOUNT_B, ORG_B, 'B', '2026-11-01T11:00:00.000Z')])
    const codex = { sessionId: 'x', firstTimestamp: '2026-11-01T12:00:00.000Z', turns: [{ assistantCalls: [{ provider: 'codex' }] }], modelBreakdown: {} }
    const [project] = await applyClaudeIdentities([{ project: 'p', sessions: [codex] }] as never, true)
    expect(project!.sessions[0]).toBe(codex)
  })
})

describe('CLI surfaces', () => {
  function run(args: string[]) {
    return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      cwd: process.cwd(),
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, HOME: home, USERPROFILE: home, CODEBURN_CACHE_DIR: join(home, 'cache'), TZ: 'UTC' },
      encoding: 'utf-8',
    })
  }

  async function fixture(twoIdentities: boolean): Promise<void> {
    const now = Date.now()
    const iso = (offsetMin: number) => new Date(now + offsetMin * 60_000).toISOString()
    await writeSession('before', iso(-180))
    await writeSession('during-a', iso(-90))
    await writeSession('during-b', iso(-30))
    const a = entry(ACCOUNT_A, ORG_A, 'Acme Corp', iso(-120))
    await seedLog(twoIdentities ? [a, entry(ACCOUNT_B, ORG_B, 'Home', iso(-60))] : [a])
    if (twoIdentities) await signIn(ACCOUNT_B, ORG_B, 'Home', new Date(now - 60 * 60_000))
    else await signIn(ACCOUNT_A, ORG_A, 'Acme Corp', new Date(now - 120 * 60_000))
  }

  it('splits report, sessions and export by account, and filters by label or hash', async () => {
    await fixture(true)
    const report = JSON.parse(run(['report', '--format', 'json', '-p', 'week']).stdout)
    expect(report.identities.map((r: { label: string; sessions: number }) => [r.label, r.sessions]).sort()).toEqual([['Acme Corp', 1], ['Home', 1], ['unattributed', 1]])
    const sum = report.identities.reduce((s: number, r: { cost: number }) => s + r.cost, 0)
    expect(sum).toBeCloseTo(report.overview.cost, 6)

    const work = JSON.parse(run(['report', '--format', 'json', '-p', 'week', '--identity', 'acme corp']).stdout)
    expect(work.overview.sessions).toBe(1)
    expect(work.overview.cost).toBeCloseTo(report.identities.find((r: { label: string }) => r.label === 'Acme Corp').cost, 6)
    expect(work.identities.map((r: { label: string }) => r.label)).toEqual(['Acme Corp'])

    const rows = JSON.parse(run(['sessions', '--format', 'json', '-p', 'week']).stdout)
    expect(Object.fromEntries(rows.map((r: { sessionId: string; identity: { label: string } }) => [r.sessionId, r.identity.label])))
      .toEqual({ before: 'unattributed', 'during-a': 'Acme Corp', 'during-b': 'Home' })
    const home2 = JSON.parse(run(['sessions', '--format', 'json', '-p', 'week', '--identity', hash(ORG_B)]).stdout)
    expect(home2.map((r: { sessionId: string; identity: { label: string } }) => [r.sessionId, r.identity.label])).toEqual([['during-b', 'Home']])

    const out = join(home, 'export')
    expect(run(['export', '-f', 'csv', '-o', out]).status).toBe(0)
    const sessionsCsv = (await readFile(join(out, 'sessions.csv'), 'utf-8')).split('\n')
    expect(sessionsCsv[0]!.split(',').at(-1)).toBe('identity')
    expect(sessionsCsv.some(line => line.endsWith(',Home'))).toBe(true)

    const unknown = run(['sessions', '--format', 'json', '--identity', 'nobody'])
    expect(unknown.status).toBe(1)
    expect(unknown.stderr).toContain('unknown Claude identity')

    expect(run(['identity-label', hash(ORG_A), 'work']).status).toBe(0)
    const list = run(['identity', 'list']).stdout
    expect(list).toContain(hash(ORG_A))
    expect(list).toContain('work')
    expect(list).toContain('Home')
    expect(list).toContain('unattributed')
  }, 180_000)

  it('adds nothing for a single identity', async () => {
    await fixture(false)
    const report = JSON.parse(run(['report', '--format', 'json', '-p', 'week']).stdout)
    expect(report.identities).toBeUndefined()
    const rows = JSON.parse(run(['sessions', '--format', 'json', '-p', 'week']).stdout)
    expect(rows.some((r: object) => 'identity' in r)).toBe(false)
    const out = join(home, 'export')
    expect(run(['export', '-f', 'csv', '-o', out]).status).toBe(0)
    expect(await readFile(join(out, 'sessions.csv'), 'utf-8')).not.toContain('identity')
    expect((await readIdentityLog())!.entries).toHaveLength(1)
  }, 120_000)
})

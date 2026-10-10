import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { parseAllSessions, clearSessionCache } from '../src/parser.js'
import { loadPricing } from '../src/models.js'
import { buildPrAttribution } from '../src/sessions-report.js'
import { buildSessionWhy } from '../src/session-why.js'
import { createHead, ghPrCommands, isPush, namedPr, pushes, rounds } from '../src/pr-signals.js'
import type { ProjectSummary } from '../src/types.js'

// One orchestrator session in the shape Claude Code writes it: pr-link entries,
// Agent spawns with their results, subagent transcripts whose first user line is
// the run's prompt, and Bash tool_use commands. Modeled on the 10 Oct 2026 case
// where review runs for #1729 and #1712 folded into a stale #24 link.

let tmpDir: string
let configDir: string
const CWD = '/tmp/prins-proj'
const REPO = 'https://github.com/getagentseal/codeburn/pull/'
const PARENT = '22222222-2222-4222-8222-222222222222'
const PR = (n: number) => `${REPO}${n}`

type Tool = { name: string; input: Record<string, unknown>; id?: string }
let msg = 0
const line = (o: Record<string, unknown>) => JSON.stringify({ sessionId: PARENT, cwd: CWD, ...o }) + '\n'
const user = (ts: string, content: unknown, extra: Record<string, unknown> = {}) => line({ type: 'user', timestamp: ts, message: { role: 'user', content }, ...extra })
const asst = (ts: string, tools: Tool[], model = 'claude-sonnet-4-5', extra: Record<string, unknown> = {}) => line({
  type: 'assistant', timestamp: ts, ...extra,
  message: {
    id: `m${msg++}`, type: 'message', role: 'assistant', model,
    content: tools.map((t, i) => ({ type: 'tool_use', id: t.id ?? `tu${msg}_${i}`, name: t.name, input: t.input })),
    usage: { input_tokens: 1000, output_tokens: 500 },
  },
})
const bash = (command: string): Tool => ({ name: 'Bash', input: { command } })
const prLink = (ts: string, n: number) => line({ type: 'pr-link', timestamp: ts, prUrl: PR(n) })
const spawn = (id: string, description: string): Tool => ({ name: 'Agent', id, input: { description, prompt: '', subagent_type: 'general-purpose' } })
const spawnResult = (ts: string, toolUseId: string, agentId: string) =>
  user(ts, [{ type: 'tool_result', tool_use_id: toolUseId, content: 'done' }], { toolUseResult: { status: 'completed', agentId, content: 'done' } })

type Child = { agentId: string; spawnId: string; description: string; prompt: string; at: string; tools: Array<[string, Tool[]]> }

const CHILDREN: Child[] = [
  {
    agentId: 'aR1694', spawnId: 'toolu_r1694', description: 'Review PR 1694 tooltip',
    prompt: 'Read audit-0926/PR-REVIEW-BRIEF.md and follow it. PR #1694 by iamtoruk: "fix(menubar): tooltip" (+40/-3).',
    at: '2026-10-10T08:30:00.000Z',
    tools: [['2026-10-10T08:31:00.000Z', [bash('gh pr view 1694 --json files,commits')]], ['2026-10-10T08:32:00.000Z', [bash('gh pr diff 1694')]]],
  },
  {
    agentId: 'aF1694', spawnId: 'toolu_f1694', description: 'Apply fixes to PR 1694',
    prompt: 'Apply the review fixes to PR #1694 and push them onto its branch.',
    at: '2026-10-10T09:00:00.000Z',
    tools: [
      ['2026-10-10T09:04:00.000Z', [bash('git commit -am "fix: review nits"')]],
      ['2026-10-10T09:05:00.000Z', [bash('git push')]],
      ['2026-10-10T09:08:00.000Z', [bash('git push --force-with-lease')]],
    ],
  },
  {
    agentId: 'aR1729', spawnId: 'toolu_r1729', description: 'Review PR 1729 Claude quota dir',
    prompt: 'Read audit-0926/PR-REVIEW-BRIEF.md and follow it. PR #1729 by renaudjx: "fix(quota): read the Claude login of a non-default CLAUDE_CONFIG_DIR on macOS" (+114/-20).',
    at: '2026-10-10T10:01:00.000Z',
    tools: [['2026-10-10T10:02:00.000Z', [bash('gh pr checkout 1729 && git diff main...HEAD')]]],
  },
  {
    agentId: 'aR1712', spawnId: 'toolu_r1712', description: 'Review PR 1712 Antigravity',
    prompt: 'Read audit-0926/PR-REVIEW-BRIEF.md and follow it. PR #1712 by dcaldr (2 merged PRs here, incl. #1620): "fix(antigravity): robust model resolution" (+80/-4).',
    at: '2026-10-10T10:01:00.000Z',
    tools: [['2026-10-10T10:03:00.000Z', [bash('gh pr view 1712 --json files')]]],
  },
  {
    agentId: 'aMulti', spawnId: 'toolu_multi', description: 'Apply review fixes to PRs 1689-1692',
    prompt: 'Apply the review fixes to PRs 1689-1692, one commit each, and push.',
    at: '2026-10-10T10:01:00.000Z',
    tools: [['2026-10-10T10:20:00.000Z', [bash('git commit -am fix && git push')]]],
  },
]

async function writeTranscripts(): Promise<void> {
  const projDir = join(configDir, 'projects', 'prins-proj')
  const subDir = join(projDir, PARENT, 'subagents')
  await mkdir(subDir, { recursive: true })
  const c = (id: string) => CHILDREN.find(ch => ch.agentId === id)!
  await writeFile(join(projDir, `${PARENT}.jsonl`), [
    user('2026-10-10T07:00:00.000Z', 'look around first'),
    asst('2026-10-10T07:00:05.000Z', [bash('git status')]),
    // #1694: pushed and opened here.
    user('2026-10-10T08:00:00.000Z', 'ship the tooltip fix'),
    asst('2026-10-10T08:00:05.000Z', [{ ...bash('git push -u origin fix/tooltip && gh pr create -R getagentseal/codeburn --base main --head fix/tooltip --title "fix(menubar): tooltip" --body-file /tmp/b.md'), id: 'toolu_create' }]),
    user('2026-10-10T08:00:15.000Z', [{ type: 'tool_result', tool_use_id: 'toolu_create', content: `${PR(1694)}\n` }]),
    prLink('2026-10-10T08:00:20.000Z', 1694),
    user('2026-10-10T08:29:00.000Z', 'get it reviewed'),
    asst('2026-10-10T08:29:30.000Z', [spawn(c('aR1694').spawnId, c('aR1694').description)]),
    spawnResult('2026-10-10T08:40:00.000Z', c('aR1694').spawnId, 'aR1694'),
    user('2026-10-10T08:59:00.000Z', 'apply the fixes'),
    asst('2026-10-10T08:59:30.000Z', [spawn(c('aF1694').spawnId, c('aF1694').description)]),
    spawnResult('2026-10-10T09:10:00.000Z', c('aF1694').spawnId, 'aF1694'),
    user('2026-10-10T09:30:00.000Z', 'merge it'),
    // A push naming the PR's head counts; a bare push from the top-level
    // session (it may be in any checkout) does not.
    asst('2026-10-10T09:30:01.000Z', [bash('git push origin fix/tooltip'), bash('cd ../other && git push')]),
    asst('2026-10-10T09:30:05.000Z', [bash('gh pr merge 1694 --squash --admin')]),
    // A stale pr-link for an old closed PR; nothing here names 24.
    user('2026-10-10T10:00:00.000Z', 'review the open contributor PRs'),
    asst('2026-10-10T10:00:05.000Z', [bash('gh pr list --state open')]),
    prLink('2026-10-10T10:00:10.000Z', 24),
    asst('2026-10-10T10:00:30.000Z', ['aR1729', 'aR1712', 'aMulti'].map(id => spawn(c(id).spawnId, c(id).description))),
    spawnResult('2026-10-10T10:30:00.000Z', c('aR1729').spawnId, 'aR1729'),
    spawnResult('2026-10-10T10:30:01.000Z', c('aR1712').spawnId, 'aR1712'),
    spawnResult('2026-10-10T10:30:02.000Z', c('aMulti').spawnId, 'aMulti'),
  ].join(''))
  for (const ch of CHILDREN) {
    const side = { isSidechain: true, agentId: ch.agentId }
    await writeFile(join(subDir, `agent-${ch.agentId}.jsonl`), [
      user(ch.at, ch.prompt, side),
      line({ type: 'attachment', timestamp: ch.at, ...side }),
      // Claude Code injects this before the first reply, so the cached turn's
      // userMessage is the reminder, never the prompt.
      user(ch.at, '<system-reminder>\nYour final report is delivered through SubagentHandback.\n</system-reminder>', { ...side, isMeta: true }),
      ...ch.tools.map(([ts, tools]) => asst(ts, tools, 'claude-opus-4-8', side)),
    ].join(''))
    await writeFile(join(subDir, `agent-${ch.agentId}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: ch.description, toolUseId: ch.spawnId, model: 'opus' }))
  }
}

let projects: ProjectSummary[]

beforeEach(async () => {
  clearSessionCache()
  tmpDir = await mkdtemp(join(tmpdir(), 'prins-'))
  configDir = join(tmpDir, 'claude')
  process.env['CLAUDE_CONFIG_DIR'] = configDir
  process.env['CODEBURN_CACHE_DIR'] = join(tmpDir, 'cache')
  await loadPricing()
  await writeTranscripts()
  projects = await parseAllSessions({ start: new Date('2026-10-10T00:00:00Z'), end: new Date('2026-10-10T23:59:59Z') }, 'claude')
})

afterEach(async () => {
  clearSessionCache()
  delete process.env['CLAUDE_CONFIG_DIR']
  delete process.env['CODEBURN_CACHE_DIR']
  await rm(tmpDir, { recursive: true, force: true })
})

const sessionCost = (id: string) => projects.flatMap(p => p.sessions).find(s => s.sessionId === id)!.totalCostUSD

describe('a run whose prompt names one PR outranks the carried pr-link', () => {
  it('moves the #1729 and #1712 review runs off the stale #24 and keeps totals', () => {
    const { rows, totals } = buildPrAttribution(projects)
    const row = (n: number) => rows.find(r => r.url === PR(n))
    expect(row(1729)?.cost).toBeCloseTo(sessionCost('agent-aR1729'), 9)
    expect(row(1712)?.cost).toBeCloseTo(sessionCost('agent-aR1712'), 9)
    // #24 keeps its own parent turn and the multi-PR run (a range is not one PR).
    const parentTurn24 = projects.flatMap(p => p.sessions).find(s => s.sessionId === PARENT)!
      .turns.filter(t => t.timestamp >= '2026-10-10T10:00:00').reduce((s, t) => s + t.assistantCalls.reduce((n, c) => n + c.costUSD, 0), 0)
    expect(row(24)?.cost).toBeCloseTo(parentTurn24 + sessionCost('agent-aMulti'), 9)
    expect(rows.reduce((s, r) => s + r.cost, 0)).toBeCloseTo(totals.attributedCost, 9)
  })
})

describe('PR dates and runs come from the attributed work, not the session', () => {
  it('dates each PR by its own turns and counts its agent runs', () => {
    const { rows } = buildPrAttribution(projects)
    const row = (n: number) => rows.find(r => r.url === PR(n))!
    expect(row(1694).firstStarted).toBe('2026-10-10T08:00:05.000Z')
    expect(row(1694).lastEnded).toBe('2026-10-10T09:30:05.000Z')
    expect(row(24).firstStarted).toBe('2026-10-10T10:00:05.000Z')
    expect(row(1729).firstStarted).toBe('2026-10-10T10:02:00.000Z')
    expect(row(1694).sessions).toBe(1)
    expect(row(1694).runs).toBe(3)
    expect(row(24).runs).toBe(2)
    expect(row(1729).runs).toBe(1)
  })
})

describe('local PR signals', () => {
  const turnCost = (from: string, to: string) => projects.flatMap(p => p.sessions).find(s => s.sessionId === PARENT)!
    .turns.filter(t => t.timestamp >= from && t.timestamp < to).reduce((s, t) => s + t.assistantCalls.reduce((n, c) => n + c.costUSD, 0), 0)

  it('reads open, follow-up rounds, review, merge and the cost split for a PR opened here', () => {
    const r = buildPrAttribution(projects).rows.find(x => x.url === PR(1694))!
    expect(r.openedAt).toBe('2026-10-10T08:00:05.000Z')
    // The push in the create command itself is not a follow-up; the fix run's two
    // pushes three minutes apart are one round, the push to fix/tooltip at 09:30
    // a second.
    expect(r.followUpPushes).toBe(3)
    expect(r.followUpRounds).toBe(2)
    expect(r.oneShot).toBe(false)
    expect(r.reviewRuns).toEqual([{ kind: 'agent', label: 'general-purpose', model: 'Opus 4.8', costUSD: sessionCost('agent-aR1694'), at: '2026-10-10T08:31:00.000Z', evidence: 'reads-pr' }])
    expect(r.reviewCostUSD).toBeCloseTo(sessionCost('agent-aR1694'), 12)
    expect(r.mergedAt).toBe('2026-10-10T09:30:05.000Z')
    expect(r.timeToMergeMs).toBe(90 * 60 * 1000)
    expect(r.linkEvidence).toBe('explicit')
    const { buildUSD, reviewUSD, fixesUSD } = r.costSplit
    expect(buildUSD + reviewUSD + fixesUSD).toBeCloseTo(r.cost, 12)
    expect(buildUSD).toBeCloseTo(turnCost('2026-10-10T08:00', '2026-10-10T08:30'), 12)
    expect(fixesUSD).toBeCloseTo(sessionCost('agent-aF1694') + turnCost('2026-10-10T08:59', '2026-10-10T10:00'), 12)
  })

  it('never calls a PR one shot when its open was not seen, and flags a pr-link-only row', () => {
    const rows = buildPrAttribution(projects).rows
    const r24 = rows.find(x => x.url === PR(24))!
    expect(r24.linkEvidence).toBe('pr-link-only')
    expect(r24.openedAt).toBeNull()
    expect(r24.oneShot).toBeNull()
    // The multi-PR fix run folds here by carry but its push is not this PR's round.
    expect(r24.followUpRounds).toBeNull()
    expect(r24.reviewRuns).toEqual([])
    expect(r24.mergedAt).toBeNull()
    expect(r24.timeToMergeMs).toBeNull()
    expect(r24.costSplit).toEqual({ buildUSD: r24.cost, reviewUSD: 0, fixesUSD: 0 })
    const r1729 = rows.find(x => x.url === PR(1729))!
    expect(r1729.oneShot).toBeNull()
    expect(r1729.followUpRounds).toBeNull()
    expect(r1729.linkEvidence).toBe('explicit')
    expect(r1729.reviewRuns.map(x => x.evidence)).toEqual(['reads-pr'])
    expect(r1729.reviewCostUSD).toBeCloseTo(r1729.cost, 12)
  })
})

describe('pr-signals command reading', () => {
  it('reads the PR a gh pr command names, ignoring quoted text', () => {
    expect(ghPrCommands('cd /x && gh pr review 1483 --request-changes -b "fix the 12 nits" && gh pr merge -R getagentseal/codeburn 1490 --squash'))
      .toMatchObject([{ verb: 'review', number: 1483 }, { verb: 'merge', number: 1490, repo: 'getagentseal/codeburn' }])
    expect(ghPrCommands('gh pr merge https://github.com/o/r/pull/7 --admin')).toMatchObject([{ verb: 'merge', number: 7, repo: 'o/r' }])
    expect(ghPrCommands('gh pr list --limit 50')[0]!.number).toBeUndefined()
    expect(isPush('git -C /tmp/wt push --force-with-lease')).toBe(true)
    expect(isPush('git stash push -m wip')).toBe(false)
    expect(pushes('git push -q origin feat/x 2>&1 | tail -2; git push contributor HEAD:refs/heads/fix/y')).toEqual([['feat/x'], ['fix/y']])
    expect(pushes('git push -q origin --delete feat/old')).toEqual([])
    // Text being written (a script, a test) is not a command that ran.
    expect(ghPrCommands("asst('x', [bash('gh pr merge 1694 --squash')])")).toEqual([])
    expect(createHead(ghPrCommands('gh pr create -R o/r --head "$br" --title "$t"')[0]!.args)).toBeUndefined()
    expect(rounds([0, 5 * 60_000, 9 * 60_000, 30 * 60_000])).toBe(2)
  })

  it('names one PR only from a PR prefix or URL', () => {
    expect(namedPr('Review PR 1729 Claude quota dir')).toEqual({ number: 1729 })
    expect(namedPr('Apply review fixes to PRs 1689-1692')).toBe('multi')
    expect(namedPr('Review core library worker #22')).toBeNull()
    expect(namedPr('Scope-check PR 1478 and PR 1476')).toBe('multi')
  })
})

describe('session why: PR work', () => {
  it('reports the PR this session opened, its follow-up rounds and the review runs', async () => {
    const why = await buildSessionWhy(join(configDir, 'projects', 'prins-proj', `${PARENT}.jsonl`))
    expect(why.prWork.opened).toEqual([{ url: PR(1694), at: '2026-10-10T08:00:05.000Z', head: 'fix/tooltip', followUpRounds: 2, followUpPushes: 3 }])
    expect(why.prWork.reviewRuns.map(r => [r.description, r.pr])).toEqual([
      ['Review PR 1694 tooltip', 1694], ['Review PR 1712 Antigravity', 1712], ['Review PR 1729 Claude quota dir', 1729],
    ])
    expect(why.prWork.reviewCost).toBeCloseTo(['agent-aR1694', 'agent-aR1712', 'agent-aR1729'].reduce((n, id) => n + sessionCost(id), 0), 12)
  })
})

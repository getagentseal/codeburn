#!/usr/bin/env node
// Reproducible end-to-end fixture for the session-groups feature (goal 7).
// Builds a synthetic $HOME with a Claude project containing:
//   - an orchestration root session (cost $2) that spawned two subagents,
//   - subagent A "Explore" ($3) and subagent B "general-purpose" ($5) as
//     provider-recorded sidechains of that root,
//   - an independent session ($7) with no lineage.
// Costs are made exact by pricing the fixture model at $1 per 1M input tokens
// through `codeburn price-override` (rates live under the synthetic HOME, so
// the real user config is never touched).
//
// Usage: node scripts/goal7-fixture.mjs <targetHome>
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const home = process.argv[2]
if (!home) {
  console.error('usage: node scripts/goal7-fixture.mjs <targetHome>')
  process.exit(1)
}

const MODEL = 'goal7-fixture-model'
const DAY = '2026-08-20'
const rootId = 'root-session-0001'
const agentA = 'agent-aaaaaaaaaaaa'
const agentB = 'agent-bbbbbbbbbbbb'
const soloId = 'solo-session-0002'
const projectSlug = '-private-tmp-goal7-fixture'
const projectDir = join(home, '.claude', 'projects', projectSlug)

const usage = inputTokens => ({
  input_tokens: inputTokens,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
})

// ————— Root session: user turn that spawned agent A + B, then its own call.
// The spawn results record toolUseResult.agentId, which the parser pairs with
// the tool_result's tool_use_id to mark this session an orchestration root.
const rootFile = [
  {
    type: 'user',
    timestamp: `${DAY}T10:00:00.000Z`,
    sessionId: rootId,
    cwd: '/tmp/goal7-fixture',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_spawn_a', content: 'spawned agent a' }],
    },
    toolUseResult: { agentId: 'aaaaaaaaaaaa' },
    isSidechain: false,
  },
  {
    type: 'user',
    timestamp: `${DAY}T10:00:01.000Z`,
    sessionId: rootId,
    cwd: '/tmp/goal7-fixture',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_spawn_b', content: 'spawned agent b' }],
    },
    toolUseResult: { agentId: 'bbbbbbbbbbbb' },
    isSidechain: false,
  },
  {
    type: 'assistant',
    timestamp: `${DAY}T10:02:00.000Z`,
    sessionId: rootId,
    cwd: '/tmp/goal7-fixture',
    message: {
      id: 'msg_root_1',
      role: 'assistant',
      model: MODEL,
      content: [{ type: 'text', text: 'Plan laid out.' }],
      usage: usage(2_000_000),
    },
  },
]

// ————— Sidechain transcripts: every entry carries isSidechain: true and the
// PARENT's sessionId, exactly as Claude records delegation.
const sidechain = (sessionId, agentKey, inputTokens, when) => [
  {
    type: 'assistant',
    timestamp: `${DAY}T${when}Z`,
    sessionId,
    cwd: '/tmp/goal7-fixture',
    isSidechain: true,
    message: {
      id: `msg_${agentKey}_1`,
      role: 'assistant',
      model: MODEL,
      content: [{ type: 'text', text: `${agentKey} report` }],
      usage: usage(inputTokens),
    },
  },
]

// ————— Independent session: no lineage, plain exchange.
const soloFile = [
  {
    type: 'user',
    timestamp: `${DAY}T12:00:00.000Z`,
    sessionId: soloId,
    cwd: '/tmp/goal7-fixture',
    message: { role: 'user', content: 'just ship it' },
  },
  {
    type: 'assistant',
    timestamp: `${DAY}T12:01:00.000Z`,
    sessionId: soloId,
    cwd: '/tmp/goal7-fixture',
    message: {
      id: 'msg_solo_1',
      role: 'assistant',
      model: MODEL,
      content: [{ type: 'text', text: 'shipped' }],
      usage: usage(7_000_000),
    },
  },
]

const writeJsonl = (path, entries) => writeFileSync(path, entries.map(e => JSON.stringify(e)).join('\n') + '\n')

mkdirSync(projectDir, { recursive: true })
mkdirSync(join(projectDir, 'subagents'), { recursive: true })
writeJsonl(join(projectDir, `${rootId}.jsonl`), rootFile)
writeJsonl(join(projectDir, `${soloId}.jsonl`), soloFile)
writeJsonl(join(projectDir, 'subagents', `${agentA}.jsonl`), sidechain(rootId, 'agent_a', 3_000_000, '10:05:00.000'))
writeJsonl(join(projectDir, 'subagents', `${agentA}.meta.json`), [])
writeFileSync(join(projectDir, 'subagents', `${agentA}.meta.json`), JSON.stringify({ agentType: 'Explore' }) + '\n')
writeJsonl(join(projectDir, 'subagents', `${agentB}.jsonl`), sidechain(rootId, 'agent_b', 5_000_000, '10:10:00.000'))
writeFileSync(join(projectDir, 'subagents', `${agentB}.meta.json`), JSON.stringify({ agentType: 'general-purpose' }) + '\n')

console.log(JSON.stringify({
  home,
  projectDir,
  rootId,
  agentA,
  agentB,
  soloId,
  model: MODEL,
  expected: { global: 17, group: 10, children: 8, root: 2, solo: 7 },
}, null, 2))

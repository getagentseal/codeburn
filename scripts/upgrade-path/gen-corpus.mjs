// Deterministic multi-provider fixture corpus for the upgrade-path check.
//
//   node scripts/upgrade-path/gen-corpus.mjs <homeDir>
//
// Lays sessions out at each provider's DEFAULT path under <homeDir>, so the run
// only has to set HOME/USERPROFILE and no per-provider override var. Everything
// is seeded off a fixed constant: two invocations against the same day produce
// byte-identical files, which is what makes the worker-determinism and
// 0.9.20-vs-main payload comparisons meaningful.
//
// Day anchoring is the one thing that moves: sessions are dated relative to
// today so they land inside the daily cache's backfill window. That is fine —
// every comparison this corpus feeds happens inside a single run.

import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)

const HOME = process.argv[2]
if (!HOME) {
  console.error('usage: gen-corpus.mjs <homeDir>')
  process.exit(2)
}

// mulberry32 — same seed, same corpus.
let seedState = 0x9e3779b9
function rnd() {
  seedState = (seedState + 0x6d2b79f5) | 0
  let t = seedState
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = arr => arr[Math.floor(rnd() * arr.length)]
const between = (lo, hi) => lo + Math.floor(rnd() * (hi - lo))

// Day 0 = 92 days ago (UTC midnight); the corpus spans day 0..91.
const DAY_MS = 86_400_000
const SPAN_DAYS = 92
const day0 = Math.floor(Date.now() / DAY_MS) * DAY_MS - (SPAN_DAYS - 1) * DAY_MS
const at = (day, hour, min = 0, sec = 0) =>
  new Date(day0 + day * DAY_MS + hour * 3_600_000 + min * 60_000 + sec * 1000)
const iso = d => d.toISOString()

const write = (path, body) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, body)
}
const writeLines = (path, lines) => write(path, lines.join('\n') + '\n')

const PROJECTS = ['/work/api-gateway', '/work/billing', '/work/web app', '/work/infra']

// ── claude ───────────────────────────────────────────────────────────────────
// 204 transcripts across the span: 200 plain, 2 parent/sidechain pairs. One
// plain transcript carries a single line over 32 KB (the large-line scanner
// path); the parent/sidechain pairs exercise the v7 spawn-link capture that the
// migration has to carry forward.

const CLAUDE_MODELS = ['claude-sonnet-4-5', 'claude-opus-4-8', 'claude-haiku-4-5']

function claudeUser(sessionId, ts, cwd, text) {
  return JSON.stringify({ type: 'user', sessionId, timestamp: iso(ts), cwd, gitBranch: 'main', message: { role: 'user', content: text } })
}

function claudeAssistant(sessionId, ts, cwd, msgId, model, usage, content) {
  return JSON.stringify({
    type: 'assistant', sessionId, timestamp: iso(ts), cwd, gitBranch: 'main',
    message: { id: msgId, type: 'message', role: 'assistant', model, content, usage },
  })
}

function claudeSession(sessionId, day, cwd, turns, opts = {}) {
  const lines = []
  for (let t = 0; t < turns; t++) {
    const ts = at(day, 9 + (t % 8), (t * 7) % 60)
    lines.push(claudeUser(sessionId, ts, cwd, `task ${t} for ${sessionId}`))
    const content = [
      { type: 'text', text: `step ${t}` },
      { type: 'tool_use', id: `tu-${sessionId}-${t}`, name: t % 3 === 0 ? 'Edit' : 'Read', input: { file_path: `${cwd}/src/f${t}.ts` } },
    ]
    // One line north of 32 KB, on the file the caller asked for it on.
    if (opts.hugeLineAtTurn === t) content.push({ type: 'text', text: 'y'.repeat(40 * 1024) })
    lines.push(claudeAssistant(sessionId, at(day, 9 + (t % 8), (t * 7) % 60, 30), cwd, `msg-${sessionId}-${t}`, pick(CLAUDE_MODELS), {
      input_tokens: between(400, 4000),
      output_tokens: between(40, 900),
      cache_read_input_tokens: between(0, 20000),
      cache_creation_input_tokens: between(0, 3000),
    }, content))
  }
  return lines
}

function genClaude() {
  const projectsDir = join(HOME, '.claude', 'projects')
  let files = 0
  for (let i = 0; i < 200; i++) {
    const cwd = PROJECTS[i % PROJECTS.length]
    const day = (i * 7) % SPAN_DAYS
    const sid = `c-${String(i).padStart(4, '0')}`
    const dirName = cwd.replace(/[/ ]/g, '-')
    writeLines(join(projectsDir, dirName, `${sid}.jsonl`), claudeSession(sid, day, cwd, between(4, 14), i === 137 ? { hugeLineAtTurn: 2 } : {}))
    files++
  }

  // Two parent transcripts, each spawning one subagent whose transcript lives
  // under <parent-uuid>/subagents/agent-<id>.jsonl and is marked isSidechain.
  for (let p = 0; p < 2; p++) {
    const cwd = PROJECTS[p]
    const dirName = cwd.replace(/[/ ]/g, '-')
    const parent = `p-000${p}`
    const agent = `a-000${p}`
    const day = 40 + p * 10
    const parentLines = claudeSession(parent, day, cwd, 5)
    parentLines.push(JSON.stringify({
      type: 'assistant', sessionId: parent, timestamp: iso(at(day, 12)), cwd,
      message: { id: `m-spawn-${p}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id: `toolu_spawn_${p}`, name: 'Agent', input: {} }], usage: { input_tokens: 120, output_tokens: 30 } },
    }))
    parentLines.push(JSON.stringify({
      type: 'user', sessionId: parent, timestamp: iso(at(day, 12, 1)), cwd,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_spawn_${p}`, content: 'subagent done' }] },
      toolUseResult: { status: 'completed', agentId: agent, content: 'subagent done' },
    }))
    parentLines.push(JSON.stringify({ type: 'pr-link', sessionId: parent, timestamp: iso(at(day, 12, 2)), cwd, prUrl: `https://github.com/acme/repo/pull/${100 + p}` }))
    writeLines(join(projectsDir, dirName, `${parent}.jsonl`), parentLines)
    files++

    const side = []
    for (let t = 0; t < 4; t++) {
      side.push(JSON.stringify({ type: 'user', isSidechain: true, sessionId: parent, agentId: agent, timestamp: iso(at(day, 12, 3 + t)), cwd, message: { role: 'user', content: `sub task ${t}` } }))
      side.push(JSON.stringify({
        type: 'assistant', isSidechain: true, sessionId: parent, agentId: agent, timestamp: iso(at(day, 12, 3 + t, 20)), cwd,
        message: { id: `sub-${p}-${t}`, type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: between(800, 2000), output_tokens: between(100, 400), cache_read_input_tokens: between(0, 5000) } },
      }))
    }
    writeLines(join(projectsDir, dirName, parent, 'subagents', `agent-${agent}.jsonl`), side)
    write(join(projectsDir, dirName, parent, 'subagents', `agent-${agent}.meta.json`), JSON.stringify({ agentType: 'reviewer' }))
    files++
  }
  return files
}

// ── codex ────────────────────────────────────────────────────────────────────
// token_count carries a CUMULATIVE total_token_usage; the parser diffs
// consecutive events, so the running totals below must only ever grow.

function genCodex() {
  const root = join(HOME, '.codex', 'sessions')
  let files = 0
  for (let i = 0; i < 24; i++) {
    const day = (i * 4) % SPAN_DAYS
    const d = new Date(day0 + day * DAY_MS)
    const cwd = PROJECTS[i % PROJECTS.length]
    const sid = `codex-${String(i).padStart(3, '0')}`
    const lines = [JSON.stringify({ type: 'session_meta', timestamp: iso(at(day, 10)), payload: { cwd, originator: 'codex-cli', session_id: sid, model: 'gpt-5.3-codex' } })]
    const total = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 }
    for (let t = 0; t < between(3, 9); t++) {
      const ts = iso(at(day, 10, t * 5))
      const last = { input_tokens: between(500, 6000), cached_input_tokens: between(0, 2000), output_tokens: between(50, 800), reasoning_output_tokens: between(0, 300), total_tokens: 0 }
      last.total_tokens = last.input_tokens + last.output_tokens
      for (const k of Object.keys(total)) total[k] += last[k]
      lines.push(JSON.stringify({ type: 'event_msg', timestamp: ts, payload: { type: 'task_started' } }))
      lines.push(JSON.stringify({ type: 'response_item', timestamp: ts, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `task ${t}` }] } }))
      lines.push(JSON.stringify({ type: 'response_item', timestamp: ts, payload: { type: 'function_call', name: 'shell', call_id: `c${t}`, arguments: JSON.stringify({ command: 'ls' }) } }))
      lines.push(JSON.stringify({ type: 'response_item', timestamp: ts, payload: { type: 'function_call_output', call_id: `c${t}` } }))
      lines.push(JSON.stringify({ type: 'response_item', timestamp: ts, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } }))
      lines.push(JSON.stringify({ type: 'event_msg', timestamp: ts, payload: { type: 'token_count', info: { last_token_usage: last, total_token_usage: { ...total } } } }))
      lines.push(JSON.stringify({ type: 'event_msg', timestamp: ts, payload: { type: 'task_complete', duration_ms: 4000 } }))
    }
    const dir = join(root, String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0'))
    writeLines(join(dir, `rollout-${sid}.jsonl`), lines)
    files++
  }
  return files
}

// ── gemini ───────────────────────────────────────────────────────────────────

function genGemini() {
  const messages = []
  for (let t = 0; t < 12; t++) {
    messages.push({ id: `u${t}`, timestamp: iso(at(60, 9, t * 3)), type: 'user', content: `inspect ${t}` })
    messages.push({
      id: `g${t}`, timestamp: iso(at(60, 9, t * 3, 20)), type: 'gemini', content: 'reading files',
      model: 'gemini-3.1-pro-preview',
      tokens: { input: between(200, 3000), cached: between(0, 1000), output: between(30, 400), thoughts: between(0, 200) },
      toolCalls: [{ id: `t${t}`, name: 'read_file', args: { path: 'src/index.ts' } }],
    })
  }
  write(join(HOME, '.gemini', 'tmp', 'api-gateway', 'chats', 'session-upgrade-1.json'),
    JSON.stringify({ sessionId: 'gemini-session-1', startTime: iso(at(60, 9)), messages }))
  return 1
}

// ── kiro ─────────────────────────────────────────────────────────────────────

function genKiro() {
  const dir = join(HOME, '.kiro', 'sessions', 'cli')
  const id = 'kiro-upgrade-1'
  const lines = []
  for (let t = 0; t < 6; t++) {
    lines.push(JSON.stringify({ kind: 'Prompt', data: { content: [{ kind: 'text', data: `add feature ${t}` }] } }))
    lines.push(JSON.stringify({ kind: 'AssistantMessage', data: { content: [{ kind: 'text', data: `Done — added feature ${t} and its tests.` }] } }))
  }
  writeLines(join(dir, `${id}.jsonl`), lines)
  write(join(dir, `${id}.json`), JSON.stringify({
    session_id: id, cwd: '/work/billing',
    created_at: iso(at(70, 10)), updated_at: iso(at(70, 11)),
    session_state: {
      rts_model_state: { model_info: { model_id: 'auto' } },
      conversation_metadata: { user_turn_metadatas: [{ end_timestamp: iso(at(70, 11)), metering_usage: [] }] },
    },
  }))
  return 2
}

// ── dsh ──────────────────────────────────────────────────────────────────────
// Written UNCOMPRESSED on purpose so both matrix legs count the same numbers
// from the same bytes.

function genDsh() {
  const cwd = '/work/api-gateway'
  const encoded = `--${cwd.replace(/[/\\]/g, '-')}--`
  const dir = join(HOME, '.dsh', 'sessions', encoded, 'session-upgrade-0001')
  const lines = [
    JSON.stringify({ type: 'session', version: 0, id: 'session-upgrade-0001', createdAt: at(75, 10).getTime(), cwd, delegationDepth: 0, agentPreset: 'cordis' }),
    JSON.stringify({ type: 'request/header', seq: 1, time: at(75, 10).getTime(), data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-v3.2', reasoningEffort: 'max', maxTokens: 256000 } } } }),
  ]
  let seq = 2
  for (let turn = 1; turn <= 8; turn++) {
    const base = at(75, 10, turn * 5).getTime()
    lines.push(JSON.stringify({ type: 'turn/start', seq: seq++, time: base, data: { turn } }))
    lines.push(JSON.stringify({ type: 'user/message', seq: seq++, time: base + 100, data: { content: [{ type: 'text', text: `build ${turn}` }], source: { kind: 'user' }, role: 'user', id: `msg-${turn}` } }))
    lines.push(JSON.stringify({ type: 'tool/call', seq: seq++, time: base + 200, data: { turn, step: 1, callId: `call_${turn}`, name: 'bash', arguments: JSON.stringify({ command: 'git status' }) } }))
    lines.push(JSON.stringify({
      type: 'assistant/message', seq: seq++, time: base + 900,
      data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] }, usage: { inputTokens: between(2000, 20000), outputTokens: between(100, 900), cacheReadTokens: between(0, 5000), reasoningTokens: between(0, 600) } },
    }))
  }
  writeLines(join(dir, 'session.jsonl'), lines)
  return 1
}

// ── grok ─────────────────────────────────────────────────────────────────────
// Uses the authoritative `turn_completed.usage` records that #1015 switched to.

function genGrok() {
  const cwd = '/work/infra'
  const root = join(HOME, '.grok', 'sessions', encodeURIComponent(cwd))
  let files = 0
  for (let i = 0; i < 3; i++) {
    const id = `019edf9c-0000-7000-8000-00000000000${i + 1}`
    const day = 80 + i
    const dir = join(root, id)
    write(join(dir, 'summary.json'), JSON.stringify({
      info: { id, cwd }, created_at: iso(at(day, 11)), updated_at: iso(at(day, 12)), last_active_at: iso(at(day, 12)),
      num_messages: 12, current_model_id: 'grok-build', session_summary: 'repo work', generated_title: 'repo work',
    }))
    write(join(dir, 'signals.json'), JSON.stringify({
      primaryModelId: 'grok-build', modelsUsed: ['grok-build'], toolsUsed: ['read_file', 'grep'],
      contextTokensUsed: 40000, contextWindowTokens: 512000,
    }))
    const updates = []
    let running = 0
    for (let t = 0; t < 5; t++) {
      // Streamed chunk carrying the running context counter. This is all the
      // published CLI can see, and what it estimates from; main ignores it in
      // favour of the turn_completed record below. Both are present in a real
      // session, so the corpus carries both and the two versions have something
      // to disagree about.
      running += between(3000, 12000)
      updates.push(JSON.stringify({
        timestamp: iso(at(day, 11, t * 5)), method: 'session/update',
        params: { sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `chunk ${t}` } }, _meta: { totalTokens: running, promptId: `p${t}`, updateType: 'AgentMessageChunk', modelId: 'grok-build' } },
      }))
      const usage = {
        inputTokens: between(1000, 9000), outputTokens: between(80, 700), totalTokens: 0,
        cachedReadTokens: between(0, 40000), cacheCreationTokens: between(0, 2000), reasoningTokens: between(0, 300),
        modelCalls: 1, apiDurationMs: 1000, costUsdTicks: 125117780000, numTurns: 1,
      }
      usage.totalTokens = usage.inputTokens + usage.outputTokens
      usage.modelUsage = { 'grok-4.6-build': { ...usage } }
      updates.push(JSON.stringify({
        timestamp: Math.floor(at(day, 11, t * 5).getTime() / 1000), method: '_x.ai/session/update',
        params: { sessionId: id, update: { sessionUpdate: 'turn_completed', prompt_id: `p${t}`, usage }, _meta: { eventId: `event-${t}`, agentTimestampMs: at(day, 11, t * 5).getTime() } },
      }))
    }
    writeLines(join(dir, 'updates.jsonl'), updates)
    files += 3
  }
  return files
}

// ── cursor (WAL-mode SQLite) ─────────────────────────────────────────────────
// Left with an un-checkpointed -wal sidecar and NO -shm: that is what a live
// Cursor database looks like on disk, and it is the shape that made
// read-only opens fail before #1017.

function genCursor() {
  let DatabaseSync
  try { ({ DatabaseSync } = require_('node:sqlite')) } catch { return 0 }

  const userDir = process.platform === 'darwin'
    ? join(HOME, 'Library', 'Application Support', 'Cursor', 'User')
    : process.platform === 'win32'
      ? join(HOME, 'AppData', 'Roaming', 'Cursor', 'User')
      : join(HOME, '.config', 'Cursor', 'User')

  const globalDir = join(userDir, 'globalStorage')
  mkdirSync(globalDir, { recursive: true })
  const dbPath = join(globalDir, 'state.vscdb')
  for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true })
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)')
  db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB)')
  const ins = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)')

  const composers = []
  for (let c = 0; c < 6; c++) {
    const composerId = `composer-${c}`
    composers.push({ composerId, name: `session-${c}`, unifiedMode: 'agent' })
    ins.run(`composerData:${composerId}`, JSON.stringify({
      promptTokenBreakdown: { totalUsedTokens: between(10000, 90000) },
      createdAt: at(85, 9 + c).getTime(),
    }))
    for (let b = 0; b < 8; b++) {
      const createdAt = iso(at(85, 9 + c, b * 4))
      ins.run(`bubbleId:${composerId}:u${b}`, JSON.stringify({ type: 1, conversationId: composerId, createdAt, text: `ask ${b}`, codeBlocks: '[]' }))
      ins.run(`bubbleId:${composerId}:a${b}`, JSON.stringify({
        type: 2, conversationId: composerId, createdAt, text: `reply ${b}`, codeBlocks: '[]',
        tokenCount: { inputTokens: between(300, 4000), outputTokens: between(40, 500) },
        modelInfo: { modelName: 'claude-4.6-sonnet' },
        requestId: `req-${c}-${b}`,
      }))
    }
  }
  // Checkpoint what is written so far, then stop auto-checkpointing and append
  // more: the tail rows live only in the -wal the copy below carries.
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  db.exec('PRAGMA wal_autocheckpoint=0')
  ins.run('composerData:composer-tail', JSON.stringify({ promptTokenBreakdown: { totalUsedTokens: 12345 }, createdAt: at(86, 9).getTime() }))
  ins.run('bubbleId:composer-tail:a0', JSON.stringify({
    type: 2, conversationId: 'composer-tail', createdAt: iso(at(86, 9)), text: 'tail reply', codeBlocks: '[]',
    tokenCount: { inputTokens: 2222, outputTokens: 333 }, modelInfo: { modelName: 'claude-4.6-sonnet' },
  }))
  composers.push({ composerId: 'composer-tail', name: 'session-tail', unifiedMode: 'agent' })
  db.close()

  // Per-workspace DB naming the composers, plus the workspace.json that gives
  // the project its name.
  const wsDir = join(userDir, 'workspaceStorage', 'ws0000000000000000000000000000000')
  mkdirSync(wsDir, { recursive: true })
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(wsDir, 'state.vscdb' + suffix), { force: true })
  const wsDb = new DatabaseSync(join(wsDir, 'state.vscdb'))
  wsDb.exec('CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB)')
  wsDb.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('composer.composerData', JSON.stringify({ allComposers: composers }))
  wsDb.close()
  write(join(wsDir, 'workspace.json'), JSON.stringify({ folder: 'file:///work/billing' }))

  return existsSync(dbPath + '-wal') ? 3 : 2
}

// ── copilot ─────────────────────────────────────────────────────────────────
// The OTel span store VS Code's Copilot Chat writes. It is here for one thing
// the transcript providers cannot exercise: a DURABLE source that keeps its
// file forever while the extension prunes rows out of it. run.mjs caches this
// with the published CLI, prunes conversations, then upgrades — the cache is
// the only remaining record of the pruned days, and a parse-version bump must
// not take them with it. Platform-specific default path, no override var,
// matching the rest of this corpus.

const COPILOT_MODELS = ['gpt-4.1', 'claude-sonnet-4-5']

function copilotOtelDbPath() {
  if (process.platform === 'darwin') {
    return join(HOME, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db')
  }
  if (process.platform === 'win32') {
    const appdata = process.env['APPDATA'] ?? join(HOME, 'AppData', 'Roaming')
    return join(appdata, 'Code', 'User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db')
  }
  return join(HOME, '.config', 'Code', 'User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db')
}

function genCopilot() {
  const { DatabaseSync } = require_('node:sqlite')
  const dbPath = copilotOtelDbPath()
  mkdirSync(join(dbPath, '..'), { recursive: true })
  for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true })

  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE spans (
      span_id        TEXT    PRIMARY KEY NOT NULL,
      trace_id       TEXT    NOT NULL,
      operation_name TEXT,
      start_time_ms  INTEGER NOT NULL DEFAULT 0,
      response_model TEXT
    );
    CREATE TABLE span_attributes (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      span_id TEXT    NOT NULL,
      key     TEXT    NOT NULL,
      value   TEXT
    );
  `)
  const insSpan = db.prepare('INSERT INTO spans (span_id, trace_id, operation_name, start_time_ms, response_model) VALUES (?, ?, ?, ?, ?)')
  const insAttr = db.prepare('INSERT INTO span_attributes (span_id, key, value) VALUES (?, ?, ?)')

  // Two spans a day over the last 40 days, so pruning by day leaves a valid,
  // still-populated DB rather than an empty one — "extant but pruned" is the
  // shape that matters, and an empty DB would also pass a naive carry-forward.
  let n = 0
  for (let day = SPAN_DAYS - 40; day < SPAN_DAYS; day++) {
    for (let i = 0; i < 2; i++) {
      const spanId = `cp-span-${String(n).padStart(4, '0')}`
      const model = COPILOT_MODELS[n % COPILOT_MODELS.length]
      const ts = at(day, 9 + i * 4, between(0, 59))
      insSpan.run(spanId, `cp-trace-${day}-${i}`, 'chat', ts.getTime(), model)
      const attrs = {
        'gen_ai.conversation.id': `cp-conv-${day}-${i}`,
        'gen_ai.response.model': model,
        'gen_ai.usage.input_tokens': between(2000, 20000),
        'gen_ai.usage.output_tokens': between(200, 3000),
        'gen_ai.usage.cache_read.input_tokens': between(0, 8000),
        'gen_ai.usage.cache_creation.input_tokens': 0,
      }
      for (const [k, v] of Object.entries(attrs)) insAttr.run(spanId, k, String(v))
      n++
    }
  }
  db.close()
  return n
}

// ── run ──────────────────────────────────────────────────────────────────────

const counts = {
  claude: genClaude(),
  codex: genCodex(),
  gemini: genGemini(),
  kiro: genKiro(),
  dsh: genDsh(),
  grok: genGrok(),
  cursor: genCursor(),
  copilot: genCopilot(),
}
console.log(JSON.stringify(counts))

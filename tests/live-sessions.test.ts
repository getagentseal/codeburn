import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LIVE_WINDOW_SECONDS, TAIL_BYTES, buildLiveSessions, collectKimicodeInputs, scanTranscript, type LiveSessionInput } from '../src/live-sessions.js'

const NOW = Date.parse('2026-09-01T12:00:00.000Z')

function input(over: Partial<LiveSessionInput> = {}): LiveSessionInput {
  return {
    id: 'session-a',
    provider: 'claude',
    project: 'codeburn',
    branch: 'main',
    model: 'Opus 4.8',
    contextTokens: 100_000,
    contextWindow: 200_000,
    startedMs: NOW - 3_600_000,
    lastActivityMs: NOW - 10_000,
    subagentActivityMs: [],
    ...over,
  }
}

describe('buildLiveSessions', () => {
  it('keeps sessions touched inside the window and drops older ones', () => {
    const block = buildLiveSessions([
      input({ id: 'fresh', lastActivityMs: NOW - 10_000 }),
      input({ id: 'stale', lastActivityMs: NOW - 3_600_000 }),
    ], NOW, LIVE_WINDOW_SECONDS)
    expect(block.sessions.map(s => s.id)).toEqual(['fresh'])
    expect(block.windowSeconds).toBe(LIVE_WINDOW_SECONDS)
  })

  it('counts a session idle for minutes as still live, at ten minutes wide', () => {
    expect(LIVE_WINDOW_SECONDS).toBe(600)
    // A session waiting on the user for five minutes is still open, not gone.
    const block = buildLiveSessions([
      input({ id: 'thinking', lastActivityMs: NOW - 5_000 }),
      input({ id: 'waiting', lastActivityMs: NOW - 300_000 }),
    ], NOW, LIVE_WINDOW_SECONDS)
    expect(block.sessions.map(s => s.id)).toEqual(['thinking', 'waiting'])
    expect(block.sessions.map(s => s.idleSeconds)).toEqual([5, 300])
  })

  it('reports idle from the sub-agent that kept the session alive', () => {
    const block = buildLiveSessions([
      input({ lastActivityMs: NOW - 400_000, subagentActivityMs: [NOW - 20_000] }),
    ], NOW, LIVE_WINDOW_SECONDS)
    expect(block.sessions[0]!.idleSeconds).toBe(20)
  })

  it('keeps a parent alive while only its sub-agent is writing', () => {
    const block = buildLiveSessions([
      input({ id: 'parent', lastActivityMs: NOW - 3_600_000, subagentActivityMs: [NOW - 5_000] }),
    ], NOW, LIVE_WINDOW_SECONDS)
    expect(block.sessions).toHaveLength(1)
    // The sub-agent's write is the session's last activity.
    expect(block.sessions[0]!.lastActivityAt).toBe(new Date(NOW - 5_000).toISOString())
  })

  it('ignores a sub-agent that is itself stale', () => {
    const block = buildLiveSessions([
      input({ lastActivityMs: NOW - 3_600_000, subagentActivityMs: [NOW - 3_700_000] }),
    ], NOW, LIVE_WINDOW_SECONDS)
    expect(block.sessions).toEqual([])
  })

  it('sorts newest first and carries the context fields through', () => {
    const block = buildLiveSessions([
      input({ id: 'older', lastActivityMs: NOW - 60_000 }),
      input({ id: 'newer', lastActivityMs: NOW - 1_000, contextTokens: 42, contextWindow: 1_000_000 }),
    ], NOW, LIVE_WINDOW_SECONDS)
    expect(block.sessions.map(s => s.id)).toEqual(['newer', 'older'])
    expect(block.sessions[0]).toMatchObject({ contextTokens: 42, contextWindow: 1_000_000, branch: 'main' })
  })

  it('treats a missing timestamp as not live rather than as the epoch', () => {
    expect(buildLiveSessions([input({ lastActivityMs: 0 })], NOW, LIVE_WINDOW_SECONDS).sessions).toEqual([])
  })
})

describe('scanTranscript', () => {
  async function transcript(lines: unknown[]): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'live-sessions-'))
    const path = join(dir, 'abc123.jsonl')
    await writeFile(path, lines.map(l => JSON.stringify(l)).join('\n'))
    return path
  }

  it('reads branch, model and the last assistant context', async () => {
    const path = await transcript([
      { type: 'user', sessionId: 's1', cwd: '/Users/x/codeburn', gitBranch: 'feat/dock' },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'claude-opus-4-5-20260101',
          usage: { input_tokens: 10, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 1_000, output_tokens: 500 },
        },
      },
    ])
    const scan = await scanTranscript(path)
    expect(scan.sessionId).toBe('s1')
    expect(scan.cwd).toBe('/Users/x/codeburn')
    expect(scan.branch).toBe('feat/dock')
    expect(scan.contextTokens).toBe(91_510)
    expect(scan.contextWindow).toBe(200_000)
    expect(scan.model).toBeTruthy()
  })

  it('takes the last assistant turn, not the largest', async () => {
    const usage = (input: number) => ({
      type: 'assistant',
      message: { role: 'assistant', model: 'claude-sonnet-4-5', usage: { input_tokens: input } },
    })
    const scan = await scanTranscript(await transcript([usage(150_000), usage(20_000)]))
    expect(scan.contextTokens).toBe(20_000)
  })

  it('widens the window when the session outgrew 200k', async () => {
    const scan = await scanTranscript(await transcript([
      { type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-4-5', usage: { input_tokens: 300_000 } } },
      { type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-4-5', usage: { input_tokens: 250_000 } } },
    ]))
    expect(scan.contextWindow).toBe(1_000_000)
  })

  it('flags a sidechain and degrades with no usage at all', async () => {
    const scan = await scanTranscript(await transcript([
      { type: 'user', sessionId: 'parent-1', isSidechain: true, cwd: '/Users/x/atlas' },
    ]))
    expect(scan.isSidechain).toBe(true)
    expect(scan.sessionId).toBe('parent-1')
    expect(scan.contextTokens).toBeNull()
    expect(scan.contextWindow).toBeNull()
    expect(scan.model).toBeNull()
  })

  it('reads only the last 256 KB, so anything older than the tail is not seen', async () => {
    expect(TAIL_BYTES).toBe(256 * 1024)
    const usage = {
      type: 'assistant',
      message: { role: 'assistant', model: 'claude-sonnet-4-5', usage: { input_tokens: 4242 } },
    }
    // One real turn, then enough filler to push it clear out of the tail window.
    const filler = { type: 'user', cwd: '/Users/x/codeburn', gitBranch: 'main', pad: 'x'.repeat(2000) }
    const fillerCount = Math.ceil(TAIL_BYTES / JSON.stringify(filler).length) + 20
    const dir = await mkdtemp(join(tmpdir(), 'live-sessions-'))
    const path = join(dir, 'long.jsonl')
    await writeFile(path, [usage, ...Array(fillerCount).fill(filler)].map(l => JSON.stringify(l)).join('\n'))

    const scan = await scanTranscript(path)
    // The identity fields still resolve, because they repeat on every entry.
    expect(scan.branch).toBe('main')
    // The assistant turn is beyond the tail, so no context is reported at all
    // rather than a stale figure read from the head of a huge file.
    expect(scan.contextTokens).toBeNull()
    expect(scan.contextWindow).toBeNull()
  })

  it('still finds a turn that sits just inside the tail', async () => {
    const filler = { type: 'user', cwd: '/Users/x/codeburn', gitBranch: 'main', pad: 'x'.repeat(2000) }
    const fillerCount = Math.floor(TAIL_BYTES / JSON.stringify(filler).length / 2)
    const usage = {
      type: 'assistant',
      message: { role: 'assistant', model: 'claude-sonnet-4-5', usage: { input_tokens: 4242 } },
    }
    const dir = await mkdtemp(join(tmpdir(), 'live-sessions-'))
    const path = join(dir, 'short.jsonl')
    await writeFile(path, [usage, ...Array(fillerCount).fill(filler)].map(l => JSON.stringify(l)).join('\n'))
    expect((await scanTranscript(path)).contextTokens).toBe(4242)
  })

  it('survives malformed lines and an unreadable file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'live-sessions-'))
    const path = join(dir, 'broken.jsonl')
    await writeFile(path, '{not json\n{"type":"user","gitBranch":"main"}\n')
    expect((await scanTranscript(path)).branch).toBe('main')
    expect((await scanTranscript(join(dir, 'missing.jsonl'))).contextTokens).toBeNull()
  })
})

describe('collectKimicodeInputs', () => {
  const WINDOW_MS = LIVE_WINDOW_SECONDS * 1000

  async function wire(sessionDir: string, agent: string, mtimeMs: number, lines: unknown[] = []): Promise<void> {
    const dir = join(sessionDir, 'agents', agent)
    await mkdir(dir, { recursive: true })
    const path = join(dir, 'wire.jsonl')
    await writeFile(path, lines.map(l => JSON.stringify(l)).join('\n'))
    await utimes(path, new Date(mtimeMs), new Date(mtimeMs))
  }

  async function session(root: string, workDirKey: string, name: string, state: string): Promise<string> {
    const dir = join(root, 'sessions', workDirKey, name)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'state.json'), state)
    return dir
  }

  async function store(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kimi-live-'))
    const live = await session(root, 'wd_atlas_aaaaaaaaaaaa', 'session_live-1', JSON.stringify({
      id: 'session_live-1',
      cwd: '/Users/x/Projects/atlas',
      createdAt: NOW - 3_600_000,
    }))
    await wire(live, 'main', NOW - 30_000, [
      { type: 'llm.request', model: 'k2', modelAlias: 'kimi-code/k2', time: NOW - 120_000 },
      { type: 'llm.request', model: 'k3', modelAlias: 'kimi-code/k3', maxTokens: 1_048_576, time: NOW - 30_000 },
      { type: 'usage.record', model: 'kimi-code/k3', usage: { output: 12 }, time: NOW - 30_000 },
      { type: 'token_counting.measured', tokens: 664_620, time: NOW - 30_000 },
    ])
    await wire(live, 'agent-0', NOW - 5_000, [{ type: 'llm.request', model: 'k3' }])

    const stale = await session(root, 'wd_atlas_aaaaaaaaaaaa', 'session_stale-1', JSON.stringify({ cwd: '/Users/x/Projects/atlas' }))
    await wire(stale, 'main', NOW - 3_600_000, [{ type: 'llm.request', model: 'k3' }])

    const broken = await session(root, 'wd_doors_bbbbbbbbbbbb', 'session_broken-1', '{not json')
    await wire(broken, 'main', NOW - 3_600_000, [{ type: 'llm.request', model: 'k3' }])
    return root
  }

  it('reports only the session whose wire was touched inside the window', async () => {
    const inputs = await collectKimicodeInputs(NOW, WINDOW_MS, [await store()])
    expect(inputs).toHaveLength(1)
    expect(inputs[0]).toMatchObject({
      id: 'live-1',
      provider: 'kimicode',
      project: 'atlas',
      branch: null,
      model: 'k3',
      contextTokens: 664_620,
      contextWindow: 1_048_576,
      startedMs: NOW - 3_600_000,
      lastActivityMs: NOW - 30_000,
      subagentActivityMs: [NOW - 5_000],
    })
    // The sub-agent wrote more recently than the session itself, so it is the
    // session's last activity.
    expect(buildLiveSessions(inputs, NOW, LIVE_WINDOW_SECONDS).sessions[0]!.idleSeconds).toBe(5)
  })

  it('keeps a session whose own wire went quiet while a sub-agent runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kimi-live-'))
    const dir = await session(root, 'wd_atlas_aaaaaaaaaaaa', 'session_delegating', JSON.stringify({ cwd: '/Users/x/atlas' }))
    await wire(dir, 'main', NOW - 3_600_000, [{ type: 'llm.request', model: 'k3' }])
    await wire(dir, 'agent-1', NOW - 9_000)
    const inputs = await collectKimicodeInputs(NOW, WINDOW_MS, [root])
    expect(inputs.map(i => i.id)).toEqual(['delegating'])
    expect(buildLiveSessions(inputs, NOW, LIVE_WINDOW_SECONDS).sessions).toHaveLength(1)
  })

  it('falls back to the work-dir key when state.json is unreadable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kimi-live-'))
    const dir = await session(root, 'wd_doors_bbbbbbbbbbbb', 'session_nostate', '{not json')
    await wire(dir, 'main', NOW - 20_000, [{ type: 'llm.request', model: 'k3' }])
    const inputs = await collectKimicodeInputs(NOW, WINDOW_MS, [root])
    expect(inputs).toHaveLength(1)
    expect(inputs[0]).toMatchObject({ project: 'doors', model: 'k3' })
    expect(inputs[0]!.startedMs).toBeGreaterThan(0)
  })

  it('ignores a wire.jsonl buried in an agent blob or file-history tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kimi-live-'))
    const dir = await session(root, 'wd_atlas_aaaaaaaaaaaa', 'session_decoys', JSON.stringify({ cwd: '/Users/x/atlas' }))
    await wire(dir, 'main', NOW - 20_000, [{ type: 'llm.request', model: 'k3' }])
    await wire(dir, join('main', 'blobs'), NOW - 1_000)
    await wire(dir, join('main', 'file-history', 'src'), NOW - 1_000)
    const inputs = await collectKimicodeInputs(NOW, WINDOW_MS, [root])
    expect(inputs.map(i => i.id)).toEqual(['decoys'])
    expect(inputs[0]!.subagentActivityMs).toEqual([])
    expect(inputs[0]!.lastActivityMs).toBe(NOW - 20_000)
  })

  it('stays silent on a store that is not there', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kimi-live-'))
    expect(await collectKimicodeInputs(NOW, WINDOW_MS, [join(root, 'missing')])).toEqual([])
  })
})

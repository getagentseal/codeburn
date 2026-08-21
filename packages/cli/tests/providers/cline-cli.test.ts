import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { clineCli, createClineCliProvider, getClineCliSessionsDir } from '../../src/providers/cline-cli.js'
import { priceProviderCall } from '../../src/pricing-pass.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

let tmpDir: string

type MessageSpec = {
  role: 'user' | 'assistant'
  text?: string
  metrics?: Record<string, number>
  model?: string
  ts?: number
  toolUse?: { name: string; input: Record<string, unknown> }
}

async function writeSession(sessionsDir: string, sessionId: string, opts?: {
  messages?: MessageSpec[]
  usage?: Record<string, number>
  totalCost?: number
  model?: string
  workspaceRoot?: string
  cwd?: string
  startedAt?: string
  endedAt?: string
  messagesPath?: string
  omitMeta?: boolean
  omitMessagesFile?: boolean
}): Promise<string> {
  const dir = join(sessionsDir, sessionId)
  await mkdir(dir, { recursive: true })
  const metaPath = join(dir, `${sessionId}.json`)
  const messagesPath = join(dir, `${sessionId}.messages.json`)

  if (!opts?.omitMeta) {
    const metadata: Record<string, unknown> = {}
    if (opts?.usage) metadata['usage'] = opts.usage
    if (opts?.totalCost !== undefined) metadata['totalCost'] = opts.totalCost

    await writeFile(metaPath, JSON.stringify({
      version: 1,
      session_id: sessionId,
      source: 'cli',
      status: 'completed',
      provider: 'cline-pass',
      model: opts?.model ?? 'z-ai/glm-5.2',
      cwd: opts?.cwd ?? '/Users/dev/work/my-repo',
      workspace_root: opts?.workspaceRoot ?? opts?.cwd ?? '/Users/dev/work/my-repo',
      started_at: opts?.startedAt ?? '2026-08-02T20:04:18.628Z',
      ended_at: opts?.endedAt ?? '2026-08-02T20:08:27.768Z',
      metadata,
      messages_path: opts?.messagesPath ?? messagesPath,
    }))
  }

  if (!opts?.omitMessagesFile) {
    const messages = (opts?.messages ?? []).map((spec, index) => {
      const content: unknown[] = []
      if (spec.text) content.push({ type: 'text', text: spec.text })
      if (spec.toolUse) content.push({ type: 'tool_use', id: `call_${index}`, ...spec.toolUse })

      const message: Record<string, unknown> = {
        id: `msg_${index}`,
        role: spec.role,
        content,
        ts: spec.ts ?? 1785701064304 + index * 1000,
      }
      if (spec.metrics) message['metrics'] = spec.metrics
      if (spec.model) message['modelInfo'] = { id: spec.model, provider: 'cline-pass' }
      return message
    })

    await writeFile(messagesPath, JSON.stringify({
      version: 1, updated_at: opts?.endedAt, agent: 'lead', sessionId, messages, system_prompt: 'sp',
    }))
  }

  return dir
}

async function collect(sessionsDir: string): Promise<ParsedProviderCall[]> {
  const provider = createClineCliProvider(sessionsDir)
  const sources = await provider.discoverSessions()
  const seenKeys = new Set<string>()
  const calls: ParsedProviderCall[] = []
  for (const source of sources) {
    for await (const call of provider.createSessionParser(source, seenKeys).parse()) calls.push(priceProviderCall(call))
  }
  return calls
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'cline-cli-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('cline-cli provider - identity', () => {
  it('registers under its own provider name', () => {
    expect(clineCli.name).toBe('cline-cli')
    expect(clineCli.displayName).toBe('Cline CLI')
  })

  it('maps CLI tool names onto codeburn canonical names', () => {
    expect(clineCli.toolDisplayName('run_commands')).toBe('Bash')
    expect(clineCli.toolDisplayName('read_files')).toBe('Read')
    expect(clineCli.toolDisplayName('search_codebase')).toBe('Grep')
    expect(clineCli.toolDisplayName('apply_patch')).toBe('Edit')
    expect(clineCli.toolDisplayName('spawn_agent')).toBe('Agent')
    // Unknown tools pass through rather than being dropped.
    expect(clineCli.toolDisplayName('team_mission_log')).toBe('team_mission_log')
  })
})

describe('cline-cli provider - sessions dir resolution', () => {
  beforeEach(() => {
    delete process.env['CLINE_DIR']
    delete process.env['CLINE_DATA_DIR']
    delete process.env['CLINE_SESSION_DATA_DIR']
  })

  it('defaults to ~/.cline/data/sessions', () => {
    expect(getClineCliSessionsDir()).toBe(join(process.env['HOME'] ?? '', '.cline', 'data', 'sessions'))
  })

  it('honors CLINE_DIR', () => {
    process.env['CLINE_DIR'] = '/custom/root'
    expect(getClineCliSessionsDir()).toBe(join('/custom/root', 'data', 'sessions'))
  })

  it('honors CLINE_DATA_DIR over CLINE_DIR', () => {
    process.env['CLINE_DIR'] = '/custom/root'
    process.env['CLINE_DATA_DIR'] = '/custom/data'
    expect(getClineCliSessionsDir()).toBe(join('/custom/data', 'sessions'))
  })

  it('honors CLINE_SESSION_DATA_DIR over everything else', () => {
    process.env['CLINE_DIR'] = '/custom/root'
    process.env['CLINE_DATA_DIR'] = '/custom/data'
    process.env['CLINE_SESSION_DATA_DIR'] = '/custom/sessions'
    expect(getClineCliSessionsDir()).toBe('/custom/sessions')
  })

  it('reports the resolved root for doctor', async () => {
    process.env['CLINE_SESSION_DATA_DIR'] = '/custom/sessions'
    expect(await clineCli.probeRoots?.()).toEqual([{ path: '/custom/sessions', label: 'Cline CLI sessions' }])
  })
})

describe('cline-cli provider - discovery', () => {
  it('discovers one source per session directory', async () => {
    await writeSession(tmpDir, 'sess-a')
    await writeSession(tmpDir, 'sess-b')

    const sources = await createClineCliProvider(tmpDir).discoverSessions()

    expect(sources).toHaveLength(2)
    expect(sources.map(s => s.provider)).toEqual(['cline-cli', 'cline-cli'])
    expect(sources[0]?.path).toBe(join(tmpDir, 'sess-a', 'sess-a.json'))
  })

  it('names the project from the workspace root', async () => {
    await writeSession(tmpDir, 'sess-a', { workspaceRoot: '/Users/dev/work/awesome-repo' })

    const [source] = await createClineCliProvider(tmpDir).discoverSessions()

    expect(source?.project).toBe('awesome-repo')
  })

  it('skips directories without a session metadata file', async () => {
    await mkdir(join(tmpDir, 'not-a-session'), { recursive: true })
    await writeSession(tmpDir, 'sess-a')

    const sources = await createClineCliProvider(tmpDir).discoverSessions()

    expect(sources).toHaveLength(1)
  })

  it('skips a session whose metadata file is corrupt', async () => {
    const dir = join(tmpDir, 'sess-bad')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'sess-bad.json'), '{ not json')

    expect(await createClineCliProvider(tmpDir).discoverSessions()).toHaveLength(0)
  })

  it('returns nothing when the sessions dir does not exist', async () => {
    expect(await createClineCliProvider(join(tmpDir, 'missing')).discoverSessions()).toHaveLength(0)
  })
})

describe('cline-cli provider - parsing', () => {
  it('emits one call per assistant message carrying metrics', async () => {
    await writeSession(tmpDir, 'sess-a', {
      messages: [
        { role: 'user', text: 'do the thing' },
        { role: 'assistant', text: 'ok', metrics: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 2, cost: 0.01 } },
        { role: 'user', text: '' },
        { role: 'assistant', text: 'done', metrics: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.02 } },
      ],
    })

    const calls = await collect(tmpDir)

    expect(calls).toHaveLength(2)
    expect(calls.map(c => c.inputTokens)).toEqual([100, 200])
    expect(calls.map(c => c.outputTokens)).toEqual([10, 20])
    expect(calls[0]?.cacheReadInputTokens).toBe(5)
    expect(calls[0]?.cacheCreationInputTokens).toBe(2)
    expect(calls.map(c => c.costUSD)).toEqual([0.01, 0.02])
    expect(calls.every(c => c.costIsEstimated === false)).toBe(true)
    expect(calls.every(c => c.provider === 'cline-cli')).toBe(true)
  })

  it('carries session identity, project and timestamps onto each call', async () => {
    await writeSession(tmpDir, 'sess-a', {
      workspaceRoot: '/Users/dev/work/awesome-repo',
      cwd: '/Users/dev/work/awesome-repo/sub',
      messages: [{ role: 'assistant', text: 'hi', ts: 1785701064304, metrics: { inputTokens: 1, outputTokens: 1, cost: 0.1 } }],
    })

    const [call] = await collect(tmpDir)

    expect(call?.sessionId).toBe('sess-a')
    expect(call?.project).toBe('awesome-repo')
    expect(call?.projectPath).toBe('/Users/dev/work/awesome-repo')
    expect(call?.workingDirectory).toBe('/Users/dev/work/awesome-repo/sub')
    expect(call?.timestamp).toBe(new Date(1785701064304).toISOString())
  })

  it('prefers the per-message model over the session model', async () => {
    await writeSession(tmpDir, 'sess-a', {
      model: 'session-model',
      messages: [
        { role: 'assistant', text: 'a', model: 'z-ai/glm-5.2', metrics: { inputTokens: 1, outputTokens: 1, cost: 0.1 } },
        { role: 'assistant', text: 'b', metrics: { inputTokens: 1, outputTokens: 1, cost: 0.1 } },
      ],
    })

    const calls = await collect(tmpDir)

    expect(calls.map(c => c.model)).toEqual(['z-ai/glm-5.2', 'session-model'])
  })

  it('extracts tools and bash commands from tool_use blocks', async () => {
    await writeSession(tmpDir, 'sess-a', {
      messages: [
        {
          role: 'assistant', text: 'running', metrics: { inputTokens: 1, outputTokens: 1, cost: 0.1 },
          toolUse: { name: 'run_commands', input: { commands: JSON.stringify(['git status', 'ls -la']) } },
        },
        {
          role: 'assistant', text: 'reading', metrics: { inputTokens: 1, outputTokens: 1, cost: 0.1 },
          toolUse: { name: 'read_files', input: { path: '/tmp/a.ts' } },
        },
      ],
    })

    const calls = await collect(tmpDir)

    expect(calls[0]?.tools).toEqual(['Bash'])
    expect(calls[0]?.bashCommands).toContain('git')
    expect(calls[0]?.bashCommands).toContain('ls')
    expect(calls[1]?.tools).toEqual(['Read'])
    expect(calls[1]?.toolSequence?.[0]?.[0]).toEqual({ tool: 'Read', file: '/tmp/a.ts' })
  })

  it('treats a non-JSON commands string as a single command', async () => {
    await writeSession(tmpDir, 'sess-a', {
      messages: [{
        role: 'assistant', text: 'x', metrics: { inputTokens: 1, outputTokens: 1, cost: 0.1 },
        toolUse: { name: 'run_commands', input: { commands: 'git status' } },
      }],
    })

    const [call] = await collect(tmpDir)

    expect(call?.bashCommands).toContain('git')
  })

  it('uses the first user text as the session user message, skipping tool results', async () => {
    await writeSession(tmpDir, 'sess-a', {
      messages: [
        { role: 'user', text: 'the real prompt' },
        { role: 'assistant', text: 'ok', metrics: { inputTokens: 1, outputTokens: 1, cost: 0.1 } },
      ],
    })

    const [call] = await collect(tmpDir)

    expect(call?.userMessage).toBe('the real prompt')
  })

  it('deduplicates repeated parses via the shared seenKeys set', async () => {
    await writeSession(tmpDir, 'sess-a', {
      messages: [{ role: 'assistant', text: 'a', metrics: { inputTokens: 5, outputTokens: 1, cost: 0.1 } }],
    })

    const provider = createClineCliProvider(tmpDir)
    const [source] = await provider.discoverSessions()
    const seenKeys = new Set<string>()

    const first: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source!, seenKeys).parse()) first.push(call)
    const second: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source!, seenKeys).parse()) second.push(call)

    expect(first).toHaveLength(1)
    expect(second).toHaveLength(0)
  })

  it('estimates cost when the message reports none', async () => {
    await writeSession(tmpDir, 'sess-a', {
      messages: [{ role: 'assistant', text: 'a', metrics: { inputTokens: 1000, outputTokens: 100 } }],
    })

    const [call] = await collect(tmpDir)

    expect(call?.costIsEstimated).toBe(true)
    expect(call?.costUSD).toBeGreaterThan(0)
  })

  it('keeps a metered $0 cost reported instead of re-estimating it', async () => {
    await writeSession(tmpDir, 'sess-a', {
      messages: [{ role: 'assistant', text: 'a', metrics: { inputTokens: 1000, outputTokens: 100, cost: 0 } }],
    })

    const [call] = await collect(tmpDir)

    expect(call?.costUSD).toBe(0)
    expect(call?.costIsEstimated).toBe(false)
  })

  it('treats a negative cost as absent rather than reporting a clamped $0', async () => {
    await writeSession(tmpDir, 'sess-a', {
      messages: [{ role: 'assistant', text: 'a', metrics: { inputTokens: 1000, outputTokens: 100, cost: -5 } }],
    })

    const [call] = await collect(tmpDir)

    expect(call?.costIsEstimated).toBe(true)
    expect(call?.costUSD).toBeGreaterThan(0)
  })

  it('promotes a seconds-resolution timestamp instead of landing in 1970', async () => {
    const seconds = Math.floor(Date.parse('2026-08-02T20:04:18.000Z') / 1000)
    await writeSession(tmpDir, 'sess-a', {
      messages: [{ role: 'assistant', text: 'a', ts: seconds, metrics: { inputTokens: 1, outputTokens: 1, cost: 0.1 } }],
    })

    const [call] = await collect(tmpDir)

    expect(call?.timestamp).toBe('2026-08-02T20:04:18.000Z')
  })

  it('falls back to the session start when a message carries no timestamp', async () => {
    await writeSession(tmpDir, 'sess-a', {
      startedAt: '2026-08-02T20:04:18.628Z',
      messages: [{ role: 'assistant', text: 'a', ts: 0, metrics: { inputTokens: 1, outputTokens: 1, cost: 0.1 } }],
    })

    const [call] = await collect(tmpDir)

    expect(call?.timestamp).toBe('2026-08-02T20:04:18.628Z')
  })

  it('survives a messages file whose messages field is not an array', async () => {
    const dir = join(tmpDir, 'sess-a')
    await writeSession(tmpDir, 'sess-a', { messages: [] })
    await writeFile(join(dir, 'sess-a.messages.json'), JSON.stringify({ version: 1, messages: { nope: true } }))

    expect(await collect(tmpDir)).toHaveLength(0)
  })

  it('survives a corrupt messages file without dropping the session rollup', async () => {
    const dir = join(tmpDir, 'sess-a')
    await writeSession(tmpDir, 'sess-a', {
      usage: { inputTokens: 100, outputTokens: 10, totalCost: 0.05 },
      messages: [],
    })
    await writeFile(join(dir, 'sess-a.messages.json'), '{ not json')

    const calls = await collect(tmpDir)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.inputTokens).toBe(100)
  })

  it('ignores assistant messages with no usage at all', async () => {
    await writeSession(tmpDir, 'sess-a', {
      messages: [
        { role: 'assistant', text: 'no metrics here' },
        { role: 'assistant', text: 'zeroed', metrics: { inputTokens: 0, outputTokens: 0, cost: 0 } },
      ],
    })

    expect(await collect(tmpDir)).toHaveLength(0)
  })

  it('reads the co-located messages file when messages_path is stale', async () => {
    await writeSession(tmpDir, 'sess-a', {
      messagesPath: '/nonexistent/other-machine/sess-a.messages.json',
      messages: [{ role: 'assistant', text: 'a', metrics: { inputTokens: 7, outputTokens: 1, cost: 0.1 } }],
    })

    const calls = await collect(tmpDir)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.inputTokens).toBe(7)
  })
})

describe('cline-cli provider - rollup fallback', () => {
  it('falls back to the session rollup when no message carries metrics', async () => {
    await writeSession(tmpDir, 'sess-a', {
      omitMessagesFile: true,
      usage: { inputTokens: 5483, outputTokens: 133, cacheReadTokens: 50, cacheWriteTokens: 0, totalCost: 0.0081984 },
    })

    const calls = await collect(tmpDir)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.inputTokens).toBe(5483)
    expect(calls[0]?.outputTokens).toBe(133)
    expect(calls[0]?.cacheReadInputTokens).toBe(50)
    expect(calls[0]?.costUSD).toBeCloseTo(0.0081984, 7)
    expect(calls[0]?.costIsEstimated).toBe(false)
  })

  it('does not double count when per-message metrics already covered the session', async () => {
    await writeSession(tmpDir, 'sess-a', {
      usage: { inputTokens: 300, outputTokens: 30, totalCost: 0.03 },
      messages: [
        { role: 'assistant', text: 'a', metrics: { inputTokens: 100, outputTokens: 10, cost: 0.01 } },
        { role: 'assistant', text: 'b', metrics: { inputTokens: 200, outputTokens: 20, cost: 0.02 } },
      ],
    })

    const calls = await collect(tmpDir)

    expect(calls).toHaveLength(2)
    expect(calls.reduce((sum, c) => sum + c.inputTokens, 0)).toBe(300)
  })

  it('does not fire the rollup when a duplicated session_id deduped every per-message call', async () => {
    // A session directory copied on disk: two dirs sharing the same internal
    // session_id and message ids, the second also carrying a metadata.usage
    // rollup. The shared dedup suppresses the copy's per-message calls; the
    // rollup must not then fire and re-count the session. Regression for #894.
    for (const [dirName, withRollup] of [['aaa', false], ['bbb', true]] as const) {
      const dir = join(tmpDir, dirName)
      await mkdir(dir, { recursive: true })
      const metadata: Record<string, unknown> = {}
      if (withRollup) metadata['usage'] = { inputTokens: 100, outputTokens: 10, totalCost: 0.01 }
      await writeFile(join(dir, `${dirName}.json`), JSON.stringify({
        version: 1, session_id: 'shared', source: 'cli', status: 'completed',
        provider: 'cline-pass', model: 'z-ai/glm-5.2',
        cwd: '/Users/dev/work/my-repo', workspace_root: '/Users/dev/work/my-repo',
        started_at: '2026-08-02T20:04:18.628Z', ended_at: '2026-08-02T20:08:27.768Z',
        metadata, messages_path: join(dir, `${dirName}.messages.json`),
      }))
      await writeFile(join(dir, `${dirName}.messages.json`), JSON.stringify({
        version: 1, sessionId: 'shared', messages: [{
          id: 'msg_0', role: 'assistant', content: [{ type: 'text', text: 'a' }],
          ts: 1785701064304, metrics: { inputTokens: 100, outputTokens: 10, cost: 0.01 },
          modelInfo: { id: 'z-ai/glm-5.2', provider: 'cline-pass' },
        }],
      }))
    }

    const calls = await collect(tmpDir)

    // Exactly one call (the first copy's msg_0); the copy is deduped and its
    // rollup declined, so cost stays $0.01 rather than doubling to $0.02.
    expect(calls).toHaveLength(1)
    expect(calls.some(c => c.deduplicationKey === 'cline-cli:shared:rollup')).toBe(false)
    expect(calls.reduce((sum, c) => sum + c.costUSD, 0)).toBeCloseTo(0.01, 7)
  })

  it('keeps a metered $0 rollup reported instead of re-estimating it', async () => {
    await writeSession(tmpDir, 'sess-a', {
      omitMessagesFile: true,
      usage: { inputTokens: 1000, outputTokens: 100, totalCost: 0 },
    })

    const calls = await collect(tmpDir)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.costUSD).toBe(0)
    expect(calls[0]?.costIsEstimated).toBe(false)
  })

  it('estimates a rollup that reports no cost at all', async () => {
    await writeSession(tmpDir, 'sess-a', {
      omitMessagesFile: true,
      usage: { inputTokens: 1000, outputTokens: 100 },
    })

    const calls = await collect(tmpDir)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.costIsEstimated).toBe(true)
    expect(calls[0]?.costUSD).toBeGreaterThan(0)
  })

  it('emits nothing for a session with neither message metrics nor a rollup', async () => {
    await writeSession(tmpDir, 'sess-a', { omitMessagesFile: true })

    expect(await collect(tmpDir)).toHaveLength(0)
  })
})

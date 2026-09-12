import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'fs/promises'
import { join } from 'path'
import { homedir, tmpdir } from 'os'
import zlib from 'zlib'

import { createDshProvider, readZstdLines } from '../../src/providers/dsh.js'
import { billableOutputTokens, calculateCost } from '../../src/models.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

// DSH session logs are concatenations of INDEPENDENT zstd frames (one per
// appended event batch), so fixtures must compress each batch separately —
// a single zstdCompressSync over the whole file is a different (single-frame)
// format than what DSH writes.

const zstdCompress = (zlib as { zstdCompressSync?: (buf: Buffer) => Buffer }).zstdCompressSync
// node:zlib gained zstd in 22.15; the package floor (and CI's pinned Node) is
// 22.13. Container-specific tests skip there; the rest fall back to plain jsonl
// so the parsing semantics are still exercised.
const itZstd = zstdCompress ? it : it.skip

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'dsh-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

function sessionHeader(opts: { id?: string; cwd?: string } = {}) {
  return JSON.stringify({
    type: 'session',
    version: 0,
    id: opts.id ?? 'session-00000000-0000-0000-0000-000000000001',
    createdAt: 1786707336131,
    cwd: opts.cwd ?? 'C:\\Users\\test\\myproject',
    delegationDepth: 0,
    agentPreset: 'cordis',
  })
}

function requestHeader(model: string, time = 1786707337000) {
  return JSON.stringify({
    type: 'request/header',
    seq: 10,
    time,
    data: { header: { config: { provider: 'deepseek-official', model, reasoningEffort: 'max', maxTokens: 256000 } } },
  })
}

function turnStart(turn: number, time: number) {
  return JSON.stringify({ type: 'turn/start', seq: 1, time, data: { turn } })
}

function userMessage(text: string, time: number) {
  return JSON.stringify({
    type: 'user/message',
    seq: 2,
    time,
    data: { content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user', id: 'msg-1' },
  })
}

function chunkUsage(turn: number, step: number, usage: Record<string, number>, time: number) {
  return JSON.stringify({
    type: 'assistant/chunk',
    seq: 3,
    time,
    data: { turn, step, chunk: { type: 'usage', usage } },
  })
}

function assistantMessage(turn: number, step: number, usage: Record<string, number> | undefined, time: number) {
  return JSON.stringify({
    type: 'assistant/message',
    seq: 4,
    time,
    data: {
      turn,
      step,
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      ...(usage ? { usage } : {}),
    },
  })
}

function toolCall(turn: number, step: number, name: string, args: Record<string, unknown>, time: number) {
  return JSON.stringify({
    type: 'tool/call',
    seq: 5,
    time,
    data: { turn, step, callId: `call_${name}`, name, arguments: JSON.stringify(args) },
  })
}

// Write one frame per batch of lines, matching DSH's append-per-batch layout.
async function writeZstdSession(projectDirName: string, sessionDirName: string, batches: string[][]) {
  const dir = join(tmpDir, 'sessions', projectDirName, sessionDirName)
  await mkdir(dir, { recursive: true })
  if (!zstdCompress) {
    const filePath = join(dir, 'session.jsonl')
    await writeFile(filePath, batches.map(lines => lines.join('\n') + '\n').join(''))
    return filePath
  }
  const filePath = join(dir, 'session.jsonl.zstd')
  const frames = batches.map(lines => zstdCompress(Buffer.from(lines.join('\n') + '\n', 'utf-8')))
  await writeFile(filePath, Buffer.concat(frames))
  return filePath
}

async function writePlainSession(projectDirName: string, sessionDirName: string, lines: string[]) {
  const dir = join(tmpDir, 'sessions', projectDirName, sessionDirName)
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, 'session.jsonl')
  await writeFile(filePath, lines.join('\n') + '\n')
  return filePath
}

async function writeVersionedSession(
  version: 1 | 2 | 3,
  projectDirName: string,
  sessionDirName: string,
  lines: string[],
  compressed = false,
) {
  const dir = join(tmpDir, 'sessions', projectDirName, sessionDirName)
  await mkdir(dir, { recursive: true })
  const suffix = compressed ? '.zstd' : ''
  const filePath = join(dir, `session.v${version}.jsonl${suffix}`)
  if (compressed && zstdCompress) {
    const split = Math.max(1, Math.floor(lines.length / 2))
    const frames = [lines.slice(0, split), lines.slice(split)]
      .filter(batch => batch.length > 0)
      .map(batch => zstdCompress(Buffer.from(batch.join('\n') + '\n')))
    await writeFile(filePath, Buffer.concat(frames))
  } else {
    await writeFile(filePath, lines.join('\n') + '\n')
  }
  return filePath
}

// Released layouts checked against deepseek-ai/deepseek-harness at
// c291e7961a515f6d7af9304e7fd1d257929aef26:
// packages/session/session-format-v0-to-v1/src/codec.ts (v1),
// packages/session/session-format-v1-to-v2/src/codec.ts (v2), and
// packages/session/session-format-v2-to-v3/src/codec.ts (v3).
// Embedded usage and retry settlements follow packages/llm/token-meter/src/usage-projection.ts.
function versionedHeader(version: 1 | 2 | 3, opts: { id?: string; cwd?: string; isSeeded?: boolean } = {}) {
  return JSON.stringify({
    type: 'session',
    version,
    id: opts.id ?? `session-v${version}`,
    createdAt: 1786707336131,
    cwd: opts.cwd ?? '/home/u/proj',
    ...(version <= 1 ? {} : { isSeeded: opts.isSeeded ?? false }),
    delegationDepth: 0,
  })
}

function embeddedUsage(usage: Record<string, number>, time: number) {
  return [{ type: 'chunk', time, chunk: { type: 'usage', usage } }]
}

async function parseAll(provider: ReturnType<typeof createDshProvider>, filePath: string): Promise<ParsedProviderCall[]> {
  const source = { path: filePath, project: 'myproject', provider: 'dsh' }
  const calls: ParsedProviderCall[] = []
  for await (const call of provider.createSessionParser(source, new Set()).parse()) {
    calls.push(call)
  }
  return calls
}

describe('dsh provider - session discovery', () => {
  itZstd('discovers a multi-frame zstd session, project from the header cwd', async () => {
    await writeZstdSession('--C-Users-test-myproject--', 'session-abc', [
      [sessionHeader({ cwd: 'C:\\Users\\test\\myproject' })],
      [assistantMessage(1, 1, { inputTokens: 100, outputTokens: 10 }, 1786707340000)],
    ])

    const provider = createDshProvider(tmpDir)
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.provider).toBe('dsh')
    expect(sessions[0]!.project).toBe('myproject')
    expect(sessions[0]!.path).toContain('session.jsonl.zstd')
  })

  it('discovers the uncompressed session.jsonl variant (compression=none)', async () => {
    await writePlainSession('--home-u-proj--', 'session-plain', [
      sessionHeader({ cwd: '/home/u/proj' }),
      assistantMessage(1, 1, { inputTokens: 100, outputTokens: 10 }, 1786707340000),
    ])

    const provider = createDshProvider(tmpDir)
    const sessions = await provider.discoverSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.path).toContain('session.jsonl')
    expect(sessions[0]!.path).not.toContain('zstd')
    expect(sessions[0]!.project).toBe('proj')
  })

  it('discovers a v3 session log', async () => {
    const dir = join(tmpDir, 'sessions', '--home-u-proj--', 'session-v3')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'session.v3.jsonl'),
      JSON.stringify({
        type: 'session',
        version: 3,
        id: 'session-v3',
        createdAt: 1786707336131,
        cwd: '/home/u/proj',
      }) + '\n',
    )

    const sessions = await createDshProvider(tmpDir).discoverSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.path).toBe(join(dir, 'session.v3.jsonl'))
  })

  it('selects only the highest generation when migrated logs coexist', async () => {
    const dir = join(tmpDir, 'sessions', '--home-u-proj--', 'session-migrated')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session.jsonl'), sessionHeader({ id: 'session-migrated' }) + '\n')
    await writeFile(join(dir, 'session.v2.jsonl'), versionedHeader(2, { id: 'session-migrated' }) + '\n')
    await writeFile(join(dir, 'session.v3.jsonl'), versionedHeader(3, { id: 'session-migrated' }) + '\n')

    const sessions = await createDshProvider(tmpDir).discoverSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.path).toBe(join(dir, 'session.v3.jsonl'))
  })

  it('does not fall back when the highest generation is corrupt or unknown', async () => {
    const corrupt = join(tmpDir, 'sessions', '--home-u-proj--', 'session-corrupt')
    const unknown = join(tmpDir, 'sessions', '--home-u-proj--', 'session-unknown')
    await mkdir(corrupt, { recursive: true })
    await mkdir(unknown, { recursive: true })
    await writeFile(join(corrupt, 'session.jsonl'), sessionHeader({ id: 'session-corrupt' }) + '\n')
    await writeFile(join(corrupt, 'session.v3.jsonl'), '{broken\n')
    await writeFile(join(unknown, 'session.jsonl'), sessionHeader({ id: 'session-unknown' }) + '\n')
    await writeFile(join(unknown, 'session.v4.jsonl'), JSON.stringify({ type: 'session', version: 4 }) + '\n')

    expect(await createDshProvider(tmpDir).discoverSessions()).toEqual([])
  })

  it('rejects a filename/header generation mismatch and counts it as skipped', async () => {
    await writeVersionedSession(3, '--home-u-proj--', 'session-mismatch', [versionedHeader(2)])

    const skipped: number[] = []
    expect(await createDshProvider(tmpDir).discoverSessions(v => { skipped.push(v) })).toEqual([])
    expect(skipped).toEqual([3])
  })

  it('counts an unreadable header as skipped', async () => {
    const dir = join(tmpDir, 'sessions', '--home-u-proj--', 'session-unreadable')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session.v3.jsonl'), '{broken\n')

    const skipped: number[] = []
    expect(await createDshProvider(tmpDir).discoverSessions(v => { skipped.push(v) })).toEqual([])
    expect(skipped).toEqual([3])
  })

  it('orders generations numerically, not lexically', async () => {
    const dir = join(tmpDir, 'sessions', '--home-u-proj--', 'session-v10')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session.v3.jsonl'), versionedHeader(3, { id: 'session-v10' }) + '\n')
    await writeFile(join(dir, 'session.v10.jsonl'), JSON.stringify({ type: 'session', version: 10 }) + '\n')

    const skipped: number[] = []
    expect(await createDshProvider(tmpDir).discoverSessions(v => { skipped.push(v) })).toEqual([])
    expect(skipped).toEqual([10])
  })

  it('reads session.v0 as the unversioned generation and session.v03 as generation 3', async () => {
    const zero = join(tmpDir, 'sessions', '--home-u-proj--', 'session-v0')
    const padded = join(tmpDir, 'sessions', '--home-u-proj--', 'session-v03')
    await mkdir(zero, { recursive: true })
    await mkdir(padded, { recursive: true })
    await writeFile(join(zero, 'session.v0.jsonl'), sessionHeader({ id: 'session-v0', cwd: '/home/u/proj' }) + '\n')
    await writeFile(join(padded, 'session.v03.jsonl'), versionedHeader(3, { id: 'session-v03' }) + '\n')

    const sessions = await createDshProvider(tmpDir).discoverSessions()

    expect(sessions.map(s => s.path).sort()).toEqual([join(padded, 'session.v03.jsonl'), join(zero, 'session.v0.jsonl')].sort())
  })

  it.each([
    ['session.v03.jsonl', 3],
    ['session.v99999999999999999999.jsonl', 1e20],
  ])('skips and counts a session whose generation filename %s is ambiguous', async (name, expected) => {
    const dir = join(tmpDir, 'sessions', '--home-u-proj--', 'session-ambiguous')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session.v3.jsonl'), versionedHeader(3, { id: 'session-ambiguous' }) + '\n')
    await writeFile(join(dir, name), versionedHeader(3, { id: 'session-ambiguous' }) + '\n')

    const skipped: number[] = []
    expect(await createDshProvider(tmpDir).discoverSessions(v => { skipped.push(v) })).toEqual([])
    expect(skipped).toEqual([expected])
  })

  it('explains missing zstd support once instead of naming every compressed log', async () => {
    for (const id of ['one', 'two', 'three', 'four', 'five']) {
      const dir = join(tmpDir, 'sessions', '--home-u-proj--', id)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'session.v3.jsonl.zstd'), 'not zstd')
    }
    const zlibExports = zlib as unknown as Record<string, unknown>
    const original = zlibExports['zstdDecompressSync']
    delete zlibExports['zstdDecompressSync']
    const warnings = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      vi.resetModules()
      const { createDshProvider: create } = await import('../../src/providers/dsh.js')
      const skipped: number[] = []
      expect(await create(tmpDir).discoverSessions(v => { skipped.push(v) })).toEqual([])
      expect(skipped).toEqual([3, 3, 3, 3, 3])
      expect(warnings.mock.calls.map(([m]) => String(m)))
        .toEqual(['codeburn: DSH sessions need Node >= 22.15 (zstd support); skipping DSH usage.\n'])
    } finally {
      warnings.mockRestore()
      if (original !== undefined) zlibExports['zstdDecompressSync'] = original
      vi.resetModules()
    }
  })

  it('returns empty for a non-existent home', async () => {
    const provider = createDshProvider('/nonexistent/dsh/home')
    expect(await provider.discoverSessions()).toEqual([])
  })

  it('skips session dirs without a session log', async () => {
    await mkdir(join(tmpDir, 'sessions', '--x--', 'session-empty'), { recursive: true })
    const provider = createDshProvider(tmpDir)
    expect(await provider.discoverSessions()).toEqual([])
  })

  it('DSH_HOME relocates discovery; an empty string is treated as unset', async () => {
    const home = join(tmpDir, 'dsh home-café')
    await mkdir(join(home, 'sessions', '--x--', 'session-env'), { recursive: true })
    await writeFile(
      join(home, 'sessions', '--x--', 'session-env', 'session.jsonl'),
      sessionHeader({ cwd: '/x' }) + '\n',
    )

    const saved = process.env['DSH_HOME']
    process.env['DSH_HOME'] = home
    try {
      const sessions = await createDshProvider().discoverSessions()
      expect(sessions).toHaveLength(1)
    } finally {
      if (saved === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = saved
    }

    process.env['DSH_HOME'] = ''
    try {
      const roots = await createDshProvider().probeRoots!()
      expect(roots).toEqual([{ path: join(homedir(), '.dsh', 'sessions'), label: 'sessions' }])
    } finally {
      if (saved === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = saved
    }
  })

  it('probeRoots reports the sessions dir under the factory root', async () => {
    expect(await createDshProvider('/tmp/dsh-a').probeRoots!()).toEqual([
      { path: join('/tmp/dsh-a', 'sessions'), label: 'sessions' },
    ])
  })
})

describe('dsh provider - parsing', () => {
  it('counts failed and successful attempts from the official-validated retry fixture', async () => {
    const content = await readFile(join(import.meta.dirname, '../fixtures/dsh/v3-retry.jsonl'), 'utf8')
    const path = await writeVersionedSession(3, '--fixture--', 'fixture-retry', content.trim().split('\n'))
    const calls = await parseAll(createDshProvider(tmpDir), path)
    expect(calls.map(call => [call.inputTokens, call.outputTokens, call.reasoningTokens])).toEqual([[10, 4, 2], [100, 20, 8]])
    expect(calls.every(call => call.model === 'deepseek-v4-flash')).toBe(true)
    expect(calls.reduce((sum, call) => sum + call.inputTokens + billableOutputTokens('dsh', call.outputTokens, call.reasoningTokens)
      + call.cacheReadInputTokens + call.cacheCreationInputTokens, 0)).toBe(174)
  })

  it.each(([0, 1, 2, 3] as const).flatMap(version => [false, true].map(retry => ({ version, retry }))))(
    'replaces non-adjacent settlements per step in v$version (retry=$retry)', async ({ version, retry }) => {
    const sample = (step: number, input: number) => version <= 1
      ? chunkUsage(1, step, { inputTokens: input, outputTokens: 10 }, 1786707340000)
      : JSON.stringify({ type: 'assistant/attempt', seq: step, time: 1786707340000,
          data: { turn: 1, step, stream: embeddedUsage({ inputTokens: input, outputTokens: 10 }, 1786707340000) } })
    const rows = [version === 0 ? sessionHeader() : versionedHeader(version),
      sample(1, 100), sample(2, 200),
      assistantMessage(1, 1, { inputTokens: 100, outputTokens: 10 }, 1786707340100),
      ...(retry ? [JSON.stringify({ type: 'llm/retry-started', seq: 8, time: 1786707340150,
        data: { turn: 1, step: 1, retryId: 'interleaved-retry', retry: 1 } }),
      assistantMessage(1, 1, { inputTokens: 150, outputTokens: 10 }, 1786707340180)] : []),
      assistantMessage(1, 2, { inputTokens: 200, outputTokens: 10 }, 1786707340200)]
    const path = version === 0 ? await writePlainSession('--fixture--', 'interleaved', rows)
      : await writeVersionedSession(version, '--fixture--', 'interleaved', rows)
    const calls = await parseAll(createDshProvider(tmpDir), path)
    expect(calls.map(call => call.inputTokens)).toEqual(retry ? [100, 150, 200] : [100, 200])
  })

  it.each([0, 1] as const)('retains non-fork v%s usage when only seedLength is present', async version => {
    const rows = [JSON.stringify({ type: 'session', version, id: 'non-fork', seedLength: 4,
      createdAt: 1786707340000, cwd: '/fixture/project', delegationDepth: 0 }),
    ...[1, 2, 3, 4].map((step, seq) => JSON.stringify({ type: 'assistant/message', seq,
      time: 1786707340000, data: { turn: 1, step, usage: { inputTokens: 100, outputTokens: 10 } } }))]
    const path = version === 0 ? await writePlainSession('--fixture--', 'non-fork', rows)
      : await writeVersionedSession(version, '--fixture--', 'non-fork', rows)
    expect((await parseAll(createDshProvider(tmpDir), path)).map(call => call.inputTokens)).toEqual([100, 100, 100, 100])
  })

  it.each([0, 1, 2, 3] as const)('matches official DSH totals for the sanitized v%s fixture', async version => {
    const content = await readFile(join(import.meta.dirname, `../fixtures/dsh/v${version}.jsonl`), 'utf8')
    const lines = content.trim().split('\n')
    const path = version === 0
      ? await writePlainSession('--fixture--', 'fixture-session', lines)
      : await writeVersionedSession(version, '--fixture--', 'fixture-session', lines)
    const calls = await parseAll(createDshProvider(tmpDir), path)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ inputTokens: 100, outputTokens: 20, reasoningTokens: 8, cacheReadInputTokens: 30, cacheCreationInputTokens: 5 })
    expect(billableOutputTokens('dsh', calls[0]!.outputTokens, calls[0]!.reasoningTokens)).toBe(20)
  })
  it('does not reuse the previous request context after a model change', async () => {
    const filePath = await writeVersionedSession(3, '--home-u-proj--', 'session-context-change', [
      versionedHeader(3),
      requestHeader('first-model'),
      JSON.stringify({ type: 'request/context', seq: 1, time: 1786707337000, data: { model: 'first-model', provider: 'route' } }),
      assistantMessage(1, 1, { inputTokens: 10, outputTokens: 1 }, 1786707340000),
      requestHeader('second-model'),
      JSON.stringify({ type: 'assistant/attempt', seq: 4, time: 1786707341000, data: {
        turn: 1, step: 2, stream: embeddedUsage({ inputTokens: 20, outputTokens: 2 }, 1786707340900),
      } }),
    ])
    expect((await parseAll(createDshProvider(tmpDir), filePath)).map(call => call.model)).toEqual(['first-model', 'second-model'])
  })

  it('keeps metered attempts when another attempt has no usage, without inventing a zero call', async () => {
    const filePath = await writeVersionedSession(3, '--home-u-proj--', 'session-missing-usage', [
      versionedHeader(3),
      assistantMessage(1, 1, { inputTokens: 10, outputTokens: 1 }, 1786707340000),
      JSON.stringify({ type: 'assistant/attempt', seq: 2, time: 1786707341000, data: { turn: 1, step: 2, stream: [] } }),
    ])
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const calls = await parseAll(createDshProvider(tmpDir), filePath)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ inputTokens: 10, outputTokens: 1, costIsEstimated: false })
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('attempt without usage'))
    } finally {
      stderr.mockRestore()
    }
  })

  it.each([
    { inputTokens: 10 },
    { inputTokens: 10, outputTokens: 2, reasoningTokens: 3 },
  ])('marks incomplete or inconsistent usage as estimated: %j', async (usage) => {
    const filePath = await writeVersionedSession(3, '--home-u-proj--', 'session-incomplete-usage', [
      versionedHeader(3),
      assistantMessage(1, 1, usage, 1786707340000),
    ])
    const calls = await parseAll(createDshProvider(tmpDir), filePath)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ inputTokens: 10, outputTokens: 'outputTokens' in usage ? usage.outputTokens : 0, costIsEstimated: true })
  })

  it.each([1, 2, 3] as const)('uses only the usage layout belonging to format v%s', async (version) => {
    // v1-to-v2 consumes top-level chunks and introduces settlement streams.
    // A row from the other physical layout must not become an extra call.
    const filePath = await writeVersionedSession(version, '--home-u-proj--', 'session-layout', [
      versionedHeader(version),
      chunkUsage(1, 1, { inputTokens: 10, outputTokens: 1 }, 1786707340000),
      JSON.stringify({
        type: 'assistant/attempt', seq: 4, time: 1786707341000,
        data: { turn: 1, step: 2, stream: embeddedUsage({ inputTokens: 20, outputTokens: 2 }, 1786707340900) },
      }),
    ])
    const calls = await parseAll(createDshProvider(tmpDir), filePath)
    expect(calls.map(call => [call.inputTokens, call.outputTokens])).toEqual(version === 1 ? [[10, 1]] : [[20, 2]])
  })

  it('keeps the released v1 top-level event layout compatible', async () => {
    const filePath = await writeVersionedSession(1, '--home-u-proj--', 'session-v1', [
      versionedHeader(1, { id: 'session-v1' }),
      requestHeader('deepseek-v4-pro'),
      assistantMessage(1, 1, { inputTokens: 111, outputTokens: 22 }, 1786707340000),
    ])

    const calls = await parseAll(createDshProvider(tmpDir), filePath)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ model: 'deepseek-v4-pro', inputTokens: 111, outputTokens: 22 })
  })

  it.each([2, 3] as const)('reads v%s embedded streams and prefers message usage', async (version) => {
    const filePath = await writeVersionedSession(version, '--home-u-proj--', `session-v${version}`, [
      versionedHeader(version, { id: `session-v${version}` }),
      JSON.stringify({
        type: 'request/context', seq: 0, time: 1786707337000,
        data: { provider: 'openai', model: 'requested-model' },
      }),
      JSON.stringify({
        type: 'assistant/message', seq: 1, time: 1786707340000, surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'openai', model: 'served-model' } },
          stream: embeddedUsage({ inputTokens: 90, outputTokens: 9 }, 1786707339900),
          usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 30 },
        },
      }),
    ])

    const calls = await parseAll(createDshProvider(tmpDir), filePath)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      model: 'served-model', inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 30,
    })
  })

  it('counts each retry attempt and resolves failed-attempt models from request context', async () => {
    const filePath = await writeVersionedSession(3, '--home-u-proj--', 'session-retry', [
      versionedHeader(3, { id: 'session-retry' }),
      JSON.stringify({ type: 'turn/start', seq: 0, time: 1786707337000, data: { turn: 1 } }),
      JSON.stringify({
        type: 'request/header', seq: 1, time: 1786707337100,
        data: { header: { config: { provider: 'configured', model: 'configured-model' } }, reason: 'initial' },
      }),
      JSON.stringify({
        type: 'request/context', seq: 2, time: 1786707337200,
        data: { provider: 'actual-route', model: 'attempt-model' },
      }),
      JSON.stringify({
        type: 'assistant/attempt', seq: 3, time: 1786707338000,
        data: { turn: 1, step: 1, stream: embeddedUsage({ inputTokens: 10, outputTokens: 1 }, 1786707337900) },
      }),
      JSON.stringify({
        type: 'llm/retry-started', seq: 4, time: 1786707338100,
        data: { retryId: 'retry-1', turn: 1, step: 1, retry: 1 },
      }),
      JSON.stringify({
        type: 'assistant/message', seq: 5, time: 1786707339000, surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'actual-route', model: 'served-model' } },
          stream: embeddedUsage({ inputTokens: 20, outputTokens: 2 }, 1786707338900),
        },
      }),
    ])

    const calls = await parseAll(createDshProvider(tmpDir), filePath)
    expect(calls.map(call => [call.model, call.inputTokens, call.outputTokens])).toEqual([
      ['attempt-model', 10, 1],
      ['served-model', 20, 2],
    ])
    expect(calls.map(call => call.deduplicationKey)).toEqual([
      'dsh:session-retry:1:1',
      'dsh:session-retry:1:1:attempt:2',
    ])
  })

  it.each([2, 3] as const)('excludes the inherited prefix using the last tagged v%s end-seed marker', async (version) => {
    const filePath = await writeVersionedSession(version, '--home-u-proj--', `session-v${version}-fork`, [
      versionedHeader(version, { id: `session-v${version}-fork`, isSeeded: true }),
      JSON.stringify({
        type: 'request/context', seq: 0, time: 1786707336900,
        data: { provider: 'deepseek', model: 'inherited-model' },
      }),
      JSON.stringify({
        type: 'assistant/message', seq: 1, time: 1786707337000, surfaceOp: 'append',
        data: { turn: 1, step: 1, message: { role: 'assistant', content: [] }, usage: { inputTokens: 999, outputTokens: 99 }, stream: [] },
      }),
      JSON.stringify({ type: 'session/end-seed', seq: 2, time: 1786707337100, data: { inherited: true } }),
      JSON.stringify({
        type: 'assistant/message', seq: 3, time: 1786707338000, surfaceOp: 'append',
        data: { turn: 2, step: 1, message: { role: 'assistant', content: [] }, usage: { inputTokens: 500, outputTokens: 50 }, stream: [] },
      }),
      JSON.stringify({ type: 'session/end-seed', seq: 4, time: 1786707338100, data: { inherited: true } }),
      JSON.stringify({
        type: 'assistant/message', seq: 5, time: 1786707339000, surfaceOp: 'append',
        data: { turn: 3, step: 1, message: { role: 'assistant', content: [] }, usage: { inputTokens: 100, outputTokens: 10 }, stream: [] },
      }),
    ])

    const calls = await parseAll(createDshProvider(tmpDir), filePath)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ model: 'inherited-model', inputTokens: 100, outputTokens: 10 })
  })

  it('treats pi-ai API routes as the same normalized TokenUsage contract', async () => {
    const routes = [
      ['anthropic', 'claude-sonnet-4-5', 10],
      ['openai-chat-completions', 'gpt-5.4', 20],
      ['openai-responses', 'gpt-5.4-codex', 30],
    ] as const
    const rows = routes.flatMap(([provider, model, input], index) => [
      JSON.stringify({ type: 'request/context', seq: index * 2, time: 1786707337000 + index, data: { provider, model } }),
      JSON.stringify({
        type: 'assistant/message', seq: index * 2 + 1, time: 1786707340000 + index, surfaceOp: 'append',
        data: {
          turn: 1, step: index + 1,
          message: { role: 'assistant', content: [], source: { kind: 'model', provider, model } },
          stream: embeddedUsage({ inputTokens: input, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2 }, 1786707339000 + index),
        },
      }),
    ])
    const filePath = await writeVersionedSession(3, '--home-u-proj--', 'session-routes', [
      versionedHeader(3, { id: 'session-routes' }),
      ...rows,
    ])

    const calls = await parseAll(createDshProvider(tmpDir), filePath)
    expect(calls.map(call => [call.model, call.inputTokens, call.outputTokens, call.cacheReadInputTokens, call.cacheCreationInputTokens]))
      .toEqual(routes.map(([, model, input]) => [model, input, 5, 3, 2]))
  })

  itZstd('decodes a versioned v3 log split across independent zstd frames', async () => {
    const filePath = await writeVersionedSession(3, '--home-u-proj--', 'session-v3-zstd', [
      versionedHeader(3, { id: 'session-v3-zstd' }),
      JSON.stringify({
        type: 'assistant/message', seq: 0, time: 1786707340000, surfaceOp: 'append',
        data: { turn: 1, step: 1, message: { role: 'assistant', content: [] }, stream: embeddedUsage({ inputTokens: 12, outputTokens: 3 }, 1786707339900) },
      }),
    ], true)

    expect((await parseAll(createDshProvider(tmpDir), filePath))[0]).toMatchObject({ inputTokens: 12, outputTokens: 3 })
  })

  itZstd('decodes every versioned generation from zstd', async () => {
    for (const version of [1, 2, 3] as const) {
      const settlement = version === 1
        ? assistantMessage(1, 1, { inputTokens: version * 10, outputTokens: version }, 1786707340000)
        : JSON.stringify({
            type: 'assistant/message', seq: 0, time: 1786707340000, surfaceOp: 'append',
            data: {
              turn: 1, step: 1, message: { role: 'assistant', content: [] },
              stream: embeddedUsage({ inputTokens: version * 10, outputTokens: version }, 1786707339900),
            },
          })
      const filePath = await writeVersionedSession(version, '--home-u-proj--', `session-v${version}-zstd`, [
        versionedHeader(version, { id: `session-v${version}-zstd` }),
        settlement,
      ], true)
      expect((await parseAll(createDshProvider(tmpDir), filePath))[0])
        .toMatchObject({ inputTokens: version * 10, outputTokens: version })
    }
  })

  itZstd('ignores a torn trailing frame in a v3 log', async () => {
    const filePath = await writeVersionedSession(3, '--home-u-proj--', 'session-v3-torn', [
      versionedHeader(3, { id: 'session-v3-torn' }),
      JSON.stringify({
        type: 'assistant/message', seq: 0, time: 1786707340000, surfaceOp: 'append',
        data: { turn: 1, step: 1, message: { role: 'assistant', content: [] }, usage: { inputTokens: 10, outputTokens: 1 }, stream: [] },
      }),
    ], true)
    const original = await readFile(filePath)
    const torn = zstdCompress!(Buffer.from(JSON.stringify({
      type: 'assistant/message', seq: 1, time: 1786707341000, surfaceOp: 'append',
      data: { turn: 1, step: 2, message: { role: 'assistant', content: [] }, usage: { inputTokens: 999, outputTokens: 99 }, stream: [] },
    }) + '\n'))
    await writeFile(filePath, Buffer.concat([original, torn.subarray(0, Math.floor(torn.length / 2))]))

    expect((await parseAll(createDshProvider(tmpDir), filePath)).map(call => call.inputTokens)).toEqual([10])
  })

  itZstd('decodes events spread across multiple independent zstd frames', async () => {
    const filePath = await writeZstdSession('--C-Users-test-myproject--', 'session-multi', [
      [sessionHeader({ id: 'session-multi', cwd: 'C:\\Users\\test\\myproject' })],
      [turnStart(1, 1786707339000), userMessage('build the thing', 1786707339100)],
      [chunkUsage(1, 1, { inputTokens: 500, outputTokens: 50 }, 1786707340000)],
      [chunkUsage(1, 2, { inputTokens: 800, outputTokens: 80 }, 1786707341000)],
    ])

    const calls = await parseAll(createDshProvider(tmpDir), filePath)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.inputTokens).toBe(500)
    expect(calls[1]!.inputTokens).toBe(800)
  })

  it('a final assistant/message usage REPLACES the earlier chunk sample for the same turn/step', async () => {
    const filePath = await writeZstdSession('--C-Users-test-myproject--', 'session-replace', [
      [sessionHeader({ id: 'session-replace' })],
      [turnStart(1, 1786707339000)],
      // Early sample, then the final report of the SAME API call: the totals
      // must come from the final report only, not the sum of both.
      [chunkUsage(1, 1, { inputTokens: 14900, outputTokens: 600, reasoningTokens: 500 }, 1786707340000)],
      [assistantMessage(1, 1, { inputTokens: 14981, outputTokens: 656, cacheReadTokens: 0, reasoningTokens: 609 }, 1786707340050)],
    ])

    const calls = await parseAll(createDshProvider(tmpDir), filePath)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens).toBe(14981)
    // Preserve raw output, including reasoning, for the shared billing rule.
    expect(calls[0]!.outputTokens).toBe(656)
    expect(calls[0]!.reasoningTokens).toBe(609)
    expect(calls[0]!.timestamp).toBe(new Date(1786707340050).toISOString())
  })

  it('a chunk sample arriving after the final report does not overwrite it', async () => {
    const filePath = await writeZstdSession('--C-Users-test-myproject--', 'session-late', [
      [sessionHeader({ id: 'session-late' })],
      [assistantMessage(1, 1, { inputTokens: 100, outputTokens: 10 }, 1786707340050)],
      [chunkUsage(1, 1, { inputTokens: 999, outputTokens: 99 }, 1786707340100)],
    ])

    const calls = await parseAll(createDshProvider(tmpDir), filePath)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens).toBe(100)
  })

  it('falls back to the chunk sample when no assistant/message usage arrives', async () => {
    const filePath = await writeZstdSession('--C-Users-test-myproject--', 'session-sample', [
      [sessionHeader({ id: 'session-sample' })],
      [chunkUsage(2, 3, { inputTokens: 42, outputTokens: 7 }, 1786707340000)],
    ])

    const calls = await parseAll(createDshProvider(tmpDir), filePath)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens).toBe(42)
    expect(calls[0]!.deduplicationKey).toBe('dsh:session-sample:2:3')
  })

  it('steps inherit the model of the most recent request/header', async () => {
    const filePath = await writeZstdSession('--C-Users-test-myproject--', 'session-model', [
      [sessionHeader({ id: 'session-model' })],
      [requestHeader('deepseek-v4-pro', 1786707337000)],
      [assistantMessage(1, 1, { inputTokens: 100, outputTokens: 10 }, 1786707340000)],
      [assistantMessage(1, 2, { inputTokens: 200, outputTokens: 20 }, 1786707341000)],
      [requestHeader('deepseek-v4-flash', 1786707342000)],
      [assistantMessage(2, 1, { inputTokens: 300, outputTokens: 30 }, 1786707343000)],
    ])

    const calls = await parseAll(createDshProvider(tmpDir), filePath)
    expect(calls.map(c => c.model)).toEqual(['deepseek-v4-pro', 'deepseek-v4-pro', 'deepseek-v4-flash'])
  })

  it('preserves inclusive reasoning and bills output once through the shared rule', async () => {
    const filePath = await writeZstdSession('--C-Users-test-myproject--', 'session-reason', [
      [sessionHeader({ id: 'session-reason' })],
      [requestHeader('deepseek-v4-pro')],
      [assistantMessage(1, 1, { inputTokens: 1000, outputTokens: 100, cacheWriteTokens: 50, cacheReadTokens: 500, reasoningTokens: 40 }, 1786707340000)],
    ])

    const calls = await parseAll(createDshProvider(tmpDir), filePath)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ outputTokens: 100, reasoningTokens: 40 })
    expect(billableOutputTokens('dsh', calls[0]!.outputTokens, calls[0]!.reasoningTokens)).toBe(100)
    // DSH's TokenUsage reasoningTokens is informational detail already
    // included in outputTokens, so the output bucket is billed exactly once.
    expect(calls[0]!.costUSD).toBeCloseTo(calculateCost('deepseek-v4-pro', 1000, 100, 50, 500, 0), 12)
  })

  it('collects mapped tools, skill names and bash commands from tool/call events', async () => {
    const filePath = await writeZstdSession('--C-Users-test-myproject--', 'session-tools', [
      [sessionHeader({ id: 'session-tools' })],
      [
        toolCall(1, 1, 'read', { path: '/x/a.ts' }, 1786707339500),
        toolCall(1, 1, 'edit', { path: '/x/a.ts' }, 1786707339600),
        toolCall(1, 1, 'bash', { command: 'git status && bun test' }, 1786707339700),
        toolCall(1, 1, 'skill', { name: 'coding-agent-orchestration' }, 1786707339800),
        toolCall(1, 1, 'cordis_run', { id: 'j1' }, 1786707339900),
        chunkUsage(1, 1, { inputTokens: 100, outputTokens: 10 }, 1786707340000),
      ],
    ])

    const calls = await parseAll(createDshProvider(tmpDir), filePath)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.tools).toEqual(['Read', 'Edit', 'Bash', 'Skill', 'cordis_run'])
    expect(calls[0]!.bashCommands).toEqual(['git', 'bun'])
    expect(calls[0]!.skills).toEqual(['coding-agent-orchestration'])
  })

  it('pairs the user message of the turn and carries session id and project', async () => {
    const filePath = await writeZstdSession('--C-Users-test-myproject--', 'session-ctx', [
      [sessionHeader({ id: 'session-ctx', cwd: 'C:\\Users\\test\\myproject' })],
      [turnStart(1, 1786707339000), userMessage('first question', 1786707339100)],
      [chunkUsage(1, 1, { inputTokens: 100, outputTokens: 10 }, 1786707340000)],
      [turnStart(2, 1786707350000), userMessage('second question', 1786707350100)],
      [chunkUsage(2, 1, { inputTokens: 200, outputTokens: 20 }, 1786707351000)],
    ])

    const calls = await parseAll(createDshProvider(tmpDir), filePath)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.userMessage).toBe('first question')
    expect(calls[1]!.userMessage).toBe('second question')
    expect(calls[0]!.sessionId).toBe('session-ctx')
    expect(calls[0]!.project).toBe('myproject')
    expect(calls[0]!.projectPath).toBe('C:\\Users\\test\\myproject')
  })

  it('parses the uncompressed session.jsonl variant', async () => {
    const filePath = await writePlainSession('--home-u-proj--', 'session-plain', [
      sessionHeader({ id: 'session-plain', cwd: '/home/u/proj' }),
      turnStart(1, 1786707339000),
      userMessage('hello', 1786707339100),
      chunkUsage(1, 1, { inputTokens: 123, outputTokens: 45 }, 1786707340000),
    ])

    const calls = await parseAll(createDshProvider(tmpDir), filePath)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens).toBe(123)
    expect(calls[0]!.outputTokens).toBe(45)
  })

  it('skips buckets whose usage is all zero', async () => {
    const filePath = await writeZstdSession('--C-Users-test-myproject--', 'session-zero', [
      [sessionHeader({ id: 'session-zero' })],
      [assistantMessage(1, 1, { inputTokens: 0, outputTokens: 0 }, 1786707340000)],
    ])

    const calls = await parseAll(createDshProvider(tmpDir), filePath)
    expect(calls).toHaveLength(0)
  })

  itZstd('ignores a torn final frame appended by a crashed writer', async () => {
    const dir = join(tmpDir, 'sessions', '--C-Users-test-myproject--', 'session-torn')
    await mkdir(dir, { recursive: true })
    const filePath = join(dir, 'session.jsonl.zstd')
    const good = zstdCompress!(Buffer.from(
      sessionHeader({ id: 'session-torn' }) + '\n' +
      chunkUsage(1, 1, { inputTokens: 100, outputTokens: 10 }, 1786707340000) + '\n',
    ))
    const torn = zstdCompress!(Buffer.from(chunkUsage(1, 2, { inputTokens: 1, outputTokens: 1 }, 1786707341000) + '\n'))
    await writeFile(filePath, Buffer.concat([good, torn.subarray(0, Math.floor(torn.length / 2))]))

    const calls = await parseAll(createDshProvider(tmpDir), filePath)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens).toBe(100)
  })

  it('deduplicates (turn, step) calls seen across multiple parses', async () => {
    const filePath = await writeZstdSession('--C-Users-test-myproject--', 'session-dedup', [
      [sessionHeader({ id: 'session-dedup' })],
      [chunkUsage(1, 1, { inputTokens: 100, outputTokens: 10 }, 1786707340000)],
    ])

    const provider = createDshProvider(tmpDir)
    const source = { path: filePath, project: 'myproject', provider: 'dsh' }
    const seenKeys = new Set<string>()

    const firstRun: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, seenKeys).parse()) firstRun.push(call)
    const secondRun: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, seenKeys).parse()) secondRun.push(call)

    expect(firstRun).toHaveLength(1)
    expect(secondRun).toHaveLength(0)
  })

  it('handles a missing session file gracefully', async () => {
    const provider = createDshProvider(tmpDir)
    const source = { path: join(tmpDir, 'nope', 'session.jsonl.zstd'), project: 'test', provider: 'dsh' }
    const calls: ParsedProviderCall[] = []
    for await (const call of provider.createSessionParser(source, new Set()).parse()) calls.push(call)
    expect(calls).toHaveLength(0)
  })
})

describe('dsh provider - display names', () => {
  const provider = createDshProvider('/tmp')

  it('has correct name and displayName', () => {
    expect(provider.name).toBe('dsh')
    expect(provider.displayName).toBe('DeepSeek Harness')
  })

  it('maps deepseek models to readable names and passes unknown ids through', () => {
    expect(provider.modelDisplayName('deepseek-v4-pro')).toBe('DeepSeek v4 Pro')
    expect(provider.modelDisplayName('some-future-model')).toBe('some-future-model')
  })

  it('normalizes tool names, keeping unknown names raw', () => {
    expect(provider.toolDisplayName('bash')).toBe('Bash')
    expect(provider.toolDisplayName('pwsh')).toBe('Bash')
    expect(provider.toolDisplayName('todo_write')).toBe('TodoWrite')
    expect(provider.toolDisplayName('cordis_run')).toBe('cordis_run')
  })
})

describe('dsh provider - real log fidelity', () => {
  // The upstream snapshot from deepseek-ai/deepseek-harness
  // (examples/acp-agent/tests/snapshots/bash-tool-turn/session.jsonl), with its
  // template placeholders filled in. It is the reference for every shape the
  // parser reads: packed `reasoning-chunks`/`tool-call-chunks` storage rows, a
  // plugin-injected user/message beside the typed one, and both the streamed
  // usage chunk and the final assistant/message usage for the same step.
  async function writeRealSession(): Promise<string> {
    const lines = (await readFile(join(import.meta.dirname, '../fixtures/dsh/bash-tool-turn.jsonl'), 'utf-8'))
      .split('\n').filter(l => l.trim())
    return writePlainSession('--home-u-proj--', 'e128dda9-ed11-4868-8266-0ef90d03c3d6', lines)
  }

  it('parses the upstream snapshot: two steps, exact usage, model from the message source', async () => {
    const calls = await parseAll(createDshProvider(tmpDir), await writeRealSession())

    expect(calls).toHaveLength(2)
    expect(calls.map(c => c.model)).toEqual(['deepseek-v4-flash', 'deepseek-v4-flash'])
    expect(calls[0]).toMatchObject({
      inputTokens: 2877,
      outputTokens: 90,
      cacheReadInputTokens: 0,
      reasoningTokens: 18,
      sessionId: 'e128dda9-ed11-4868-8266-0ef90d03c3d6',
      project: 'proj',
      projectPath: '/home/u/proj',
      workingDirectory: '/home/u/proj',
    })
    expect(calls[1]).toMatchObject({ inputTokens: 168, outputTokens: 25, cacheReadInputTokens: 2816, reasoningTokens: 22 })
    // Reasoning is a subset of output, so it must not be added a second time.
    expect(calls[0]!.costUSD).toBe(calculateCost('deepseek-v4-flash', 2877, 90, 0, 0, 0))
    expect(calls[0]!.costUSD).toBeGreaterThan(0)
  })

  it('takes the typed prompt as the preview, not the plugin-injected context', async () => {
    const calls = await parseAll(createDshProvider(tmpDir), await writeRealSession())

    expect(calls[0]!.userMessage).toBe('Use the bash tool to run exactly: echo TERMINAL_OK. Then reply with the single word DONE and stop.')
    expect(calls[0]!.userMessage).not.toContain('Current runtime context')
  })

  it('reads the tool call through the packed chunk rows around it', async () => {
    const calls = await parseAll(createDshProvider(tmpDir), await writeRealSession())

    expect(calls[0]!.tools).toEqual(['Bash'])
    expect(calls[0]!.bashCommands).toEqual(['echo'])
  })
})

describe('dsh provider - defensive reads', () => {
  it.each([2, 3] as const)('rejects malformed interior JSON in v%s while preserving a torn tail', async (version) => {
    const rows = [versionedHeader(version), assistantMessage(1, 1, { inputTokens: 10, outputTokens: 1 }, 1786707340000)]
    const corrupt = await writeVersionedSession(version, '--home-u-proj--', 'session-interior', [
      rows[0]!, '{broken', rows[1]!,
    ])
    const torn = await writeVersionedSession(version, '--home-u-proj--', 'session-tail', [...rows, '{broken'])
    expect(await parseAll(createDshProvider(tmpDir), corrupt)).toEqual([])
    expect(await parseAll(createDshProvider(tmpDir), torn)).toEqual([expect.objectContaining({ inputTokens: 10, outputTokens: 1 })])
  })

  it('does not accept a session header appearing after an unrelated first row', async () => {
    const path = await writeVersionedSession(3, '--home-u-proj--', 'session-late-header', [
      JSON.stringify({ type: 'turn/start', seq: 0, data: { turn: 1 } }),
      versionedHeader(3),
      assistantMessage(1, 1, { inputTokens: 10, outputTokens: 1 }, 1786707340000),
    ])
    expect(await parseAll(createDshProvider(tmpDir), path)).toEqual([])
  })

  it('skips a log stamped with an unsupported session format version', async () => {
    const filePath = await writePlainSession('--home-u-proj--', 'session-future', [
      JSON.stringify({ type: 'session', version: 1, id: 'session-future', createdAt: 1786707336131, cwd: '/home/u/proj', delegationDepth: 0 }),
      chunkUsage(1, 1, { inputTokens: 100, outputTokens: 10 }, 1786707340000),
    ])

    expect(await createDshProvider(tmpDir).discoverSessions()).toEqual([])
    expect(await parseAll(createDshProvider(tmpDir), filePath)).toEqual([])
  })

  it('does not bill a forked session for the events it inherited from its parent', async () => {
    const filePath = await writePlainSession('--home-u-proj--', 'session-fork', [
      JSON.stringify({
        type: 'session', version: 0, id: 'session-fork', createdAt: 1786707336131,
        cwd: '/home/u/proj', parentSession: 'session-parent', seedLength: 3, delegationDepth: 0,
      }),
      // seq 0..2 are a verbatim copy of the parent's log, which codeburn parses
      // as its own session; only seq >= 3 is this session's own work.
      JSON.stringify({ type: 'turn/start', seq: 0, time: 1786707337000, data: { turn: 1 } }),
      JSON.stringify({ type: 'assistant/message', seq: 1, time: 1786707337100, data: { turn: 1, step: 1, message: { role: 'assistant', content: [] }, usage: { inputTokens: 9999, outputTokens: 999 } } }),
      JSON.stringify({ type: 'session/end-seed', seq: 2, time: 1786707337200, data: {} }),
      JSON.stringify({ type: 'turn/start', seq: 3, time: 1786707338000, data: { turn: 2 } }),
      JSON.stringify({ type: 'assistant/message', seq: 4, time: 1786707338100, data: { turn: 2, step: 1, message: { role: 'assistant', content: [] }, usage: { inputTokens: 100, outputTokens: 10 } } }),
    ])

    const calls = await parseAll(createDshProvider(tmpDir), filePath)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens).toBe(100)
  })

  it('ignores unknown event types, packed chunk rows, and unparsable lines', async () => {
    const filePath = await writePlainSession('--home-u-proj--', 'session-noise', [
      sessionHeader({ id: 'session-noise', cwd: '/home/u/proj' }),
      JSON.stringify({ type: 'agent/inbox/spliced', seq: 0, time: 1786707337000, data: { target: 'next-turn' } }),
      JSON.stringify({ type: 'reasoning-chunks', seq0: 1, time0: 1786707337100, data: { turn: 1, step: 1, index: 0, dt: [0], texts: ['a', 'b'] } }),
      '{ not json at all',
      'null',
      '42',
      '[]',
      JSON.stringify({ type: 'user/message', data: { source: { kind: 'user' }, content: {} } }),
      JSON.stringify({ type: 'user/message', data: { source: { kind: 'user' }, content: [null] } }),
      '   ',
      chunkUsage(1, 1, { inputTokens: 100, outputTokens: 10 }, 1786707340000),
    ])

    const calls = await parseAll(createDshProvider(tmpDir), filePath)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens).toBe(100)
  })

  it('falls back to the header createdAt when a usage event carries no usable time', async () => {
    const filePath = await writePlainSession('--home-u-proj--', 'session-notime', [
      JSON.stringify({ type: 'session', version: 0, id: 'session-notime', createdAt: 1786707336131, cwd: '/home/u/proj', delegationDepth: 0 }),
      JSON.stringify({ type: 'assistant/message', seq: 1, data: { turn: 1, step: 1, message: { role: 'assistant', content: [] }, usage: { inputTokens: 100, outputTokens: 10 } } }),
    ])

    const calls = await parseAll(createDshProvider(tmpDir), filePath)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.timestamp).toBe(new Date(1786707336131).toISOString())
  })
})

describe('dsh provider - real log, real container', () => {
  itZstd('reads the upstream snapshot out of multi-frame zstd with a torn tail identically to plain jsonl', async () => {
    const lines = (await readFile(join(import.meta.dirname, '../fixtures/dsh/bash-tool-turn.jsonl'), 'utf-8'))
      .split('\n').filter(l => l.trim())
    const plain = await parseAll(
      createDshProvider(tmpDir),
      await writePlainSession('--home-u-proj--', 'plain', lines),
    )

    // Header batch, then three append batches — the layout DSH writes.
    const dir = join(tmpDir, 'sessions', '--home-u-proj--', 'framed')
    await mkdir(dir, { recursive: true })
    const filePath = join(dir, 'session.jsonl.zstd')
    const frames = [[lines[0]!], lines.slice(1, 10), lines.slice(10, 25), lines.slice(25)]
      .map(batch => zstdCompress!(Buffer.from(batch.join('\n') + '\n', 'utf-8')))
    // A crashed writer's half-written final batch, carrying usage that must not count.
    const torn = zstdCompress!(Buffer.from(assistantMessage(9, 9, { inputTokens: 123456, outputTokens: 1 }, 1785730424999) + '\n', 'utf-8'))
    await writeFile(filePath, Buffer.concat([...frames, torn.subarray(0, Math.floor(torn.length / 2))]))

    const framed = await parseAll(createDshProvider(tmpDir), filePath)
    expect(framed.map(c => [c.inputTokens, c.outputTokens, c.reasoningTokens, c.model]))
      .toEqual(plain.map(c => [c.inputTokens, c.outputTokens, c.reasoningTokens, c.model]))
    expect(framed).toHaveLength(2)
  })
})

describe('dsh provider - hostile input', () => {
  itZstd('skips a session whose frames decompress to far more than the file cap', async () => {
    const dir = join(tmpDir, 'sessions', '--home-u-proj--', 'session-bomb')
    await mkdir(dir, { recursive: true })
    const filePath = join(dir, 'session.jsonl.zstd')
    // 200 MB of zeros compresses to a few KB. Uncapped this decoded to ~916 MB
    // of RSS for a 16 KB file; the per-frame cap now rejects it without
    // allocating past the cap.
    const bomb = zstdCompress!(Buffer.alloc(200 * 1024 * 1024))
    const good = zstdCompress!(Buffer.from(
      sessionHeader({ id: 'session-bomb', cwd: '/home/u/proj' }) + '\n'
      + chunkUsage(1, 1, { inputTokens: 100, outputTokens: 10 }, 1786707340000) + '\n',
      'utf-8',
    ))
    await writeFile(filePath, Buffer.concat([good, bomb]))
    expect((await stat(filePath)).size).toBeLessThan(64 * 1024)

    // The whole file is skipped: the frames read before the bomb are not
    // counted, so a crafted tail cannot poison a partial total.
    expect(await parseAll(createDshProvider(tmpDir), filePath)).toEqual([])
  })

  itZstd('stops decoding once the frames exceed the running budget', async () => {
    const frame = zstdCompress!(Buffer.from('{"type":"turn/start","seq":0,"time":1,"data":{"turn":1}}\n', 'utf-8'))
    const buffer = Buffer.concat([frame, frame, frame])

    expect([...readZstdLines(buffer, Number.POSITIVE_INFINITY, 4096)]).toHaveLength(3)
    // A budget under two frames' plaintext stops at the frame that overruns it.
    expect(() => [...readZstdLines(buffer, Number.POSITIVE_INFINITY, 60)]).toThrow()
  })

  it('coerces non-numeric usage fields instead of poisoning the totals', async () => {
    const filePath = await writePlainSession('--home-u-proj--', 'session-poison', [
      sessionHeader({ id: 'session-poison', cwd: '/home/u/proj' }),
      JSON.stringify({
        type: 'assistant/message', seq: 1, time: 1786707340000,
        data: {
          turn: 1, step: 1, message: { role: 'assistant', content: [] },
          usage: { inputTokens: '999', outputTokens: [1, 2], reasoningTokens: 1e308 * 10, cacheReadTokens: -5, cacheWriteTokens: 7 },
        },
      }),
    ])

    const calls = await parseAll(createDshProvider(tmpDir), filePath)
    expect(calls).toHaveLength(1)
    // Only the one genuinely numeric field survives; every other shape is 0.
    expect(calls[0]).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 7,
    })
    for (const value of [calls[0]!.inputTokens, calls[0]!.outputTokens, calls[0]!.costUSD]) {
      expect(typeof value).toBe('number')
      expect(Number.isFinite(value)).toBe(true)
    }
  })

  it('still skips a call whose usage is all non-numeric', async () => {
    const filePath = await writePlainSession('--home-u-proj--', 'session-poison-zero', [
      sessionHeader({ id: 'session-poison-zero', cwd: '/home/u/proj' }),
      JSON.stringify({
        type: 'assistant/message', seq: 1, time: 1786707340000,
        data: { turn: 1, step: 1, message: { role: 'assistant', content: [] }, usage: { inputTokens: '999', outputTokens: [1, 2] } },
      }),
    ])

    expect(await parseAll(createDshProvider(tmpDir), filePath)).toEqual([])
  })
})

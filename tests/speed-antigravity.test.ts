import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { AntigravitySpeedObserver } from '../src/speed/antigravity.js'
import { readSpeedSamples } from '../src/speed/store.js'
import { buildSpeedReport } from '../src/speed/report.js'

// Anonymized shape from the installed agy CLI's actual five-frame print run.
// DONE and result repeat usage; neither is a separate token generation.
const init = { event: 'init', conversation_id: 'private-conversation', init: {
  model: 'gemini-3.8-flash-low', cwd: '/PRIVATE/project', tools: ['private-tool'], permission_mode: 'plan',
} }
const user = { event: 'step_update', step_update: {
  conversation_id: 'private-conversation', step_index: 0, state: 'DONE', step_type: 'user_input',
} }
const delta = { event: 'step_update', step_update: {
  conversation_id: 'private-conversation', step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'PRIVATE răspuns',
} }
const usage = { input_tokens: 20044, output_tokens: 6, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 20050 }
const done = { event: 'step_update', step_update: {
  conversation_id: 'private-conversation', step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: '\n', duration_seconds: 2.83924, usage,
} }
const result = { event: 'result', result: {
  conversation_id: 'private-conversation', status: 'SUCCESS', response: 'PRIVATE răspuns\n', duration_seconds: 2.937886, num_turns: 1, usage,
} }
const line = (frame: unknown) => JSON.stringify(frame) + '\n'
const frames = [init, user, delta, done, result]

function fixture(overrides?: { init?: unknown; delta?: unknown; result?: unknown; extra?: unknown }) {
  let clock = 8000
  const observer = new AntigravitySpeedObserver(() => clock, () => new Date('2026-10-01T20:00:00Z'))
  observer.feed(Buffer.from(line(overrides?.init ?? init)))
  clock += 100; observer.feed(Buffer.from(line(user)))
  clock += 2600; observer.feed(Buffer.from(line(overrides?.delta ?? delta)))
  clock += 160; observer.feed(Buffer.from(line(done)))
  if (overrides?.extra) observer.feed(Buffer.from(line(overrides.extra)))
  clock += 240; observer.feed(Buffer.from(line(overrides?.result ?? result)))
  return observer.finish()!
}

describe('Antigravity CLI timing', () => {
  it('observes the real init/step_update/result path with one local clock and counts final usage once', () => {
    const sample = fixture()
    expect(sample).toMatchObject({ harness: 'antigravity', source: 'antigravity-cli', model: 'gemini-3.8-flash-low',
      status: 'complete', resolution: 'chunk', inputTokens: 20044, outputTokens: 6, reasoningTokens: 0,
      durationMs: 3100, firstEmissionMs: 2700, lastEmissionMs: 2860 })
    expect(sample.events).toEqual([{ elapsedMs: 2700 }, { elapsedMs: 2860 }])
    expect(JSON.stringify(sample)).not.toMatch(/PRIVATE|private|răspuns|cwd|tools|response|duration_seconds/)
    expect(buildSpeedReport([sample]).rows[0]).toMatchObject({ timedRequests: 1,
      effectiveTokensPerSecond: 6 / 3.1, generationTokensPerSecondP50: 5 / 0.16, generationRequests: 1,
      interTokenMsP50: null, generationRateEstimated: true })
  })

  it('handles split UTF-8, CRLF and an unterminated final line without inventing token boundaries', () => {
    let clock = 0
    const observer = new AntigravitySpeedObserver(() => clock)
    observer.feed(Buffer.from(line(init)))
    clock = 100
    const wire = Buffer.from(line(delta).replace(/\n/g, '\r\n'))
    const split = wire.indexOf(Buffer.from('ă')) + 1
    observer.feed(wire.subarray(0, split)); observer.feed(wire.subarray(split))
    clock = 500; observer.feed(Buffer.from(JSON.stringify(result)))
    expect(observer.finish()).toMatchObject({ status: 'complete', durationMs: 500, outputTokens: 6,
      firstEmissionMs: 100, events: [{ elapsedMs: 100 }] })
  })

  it('uses inclusive thinking usage and observes thinking deltas without storing reasoning text', () => {
    const sample = fixture({ delta: { ...delta, step_update: { ...delta.step_update, text_delta: '', thinking_delta: 'PRIVATE reasoning' } },
      result: { ...result, result: { ...result.result, usage: { input_tokens: 10415, output_tokens: 657, thinking_tokens: 616, total_tokens: 11072 } } } })
    expect(sample).toMatchObject({ status: 'complete', outputTokens: 657, reasoningTokens: 616, firstEmissionMs: 2700 })
    expect(buildSpeedReport([sample]).rows[0].outputTokens).toBe(657)
    expect(JSON.stringify(sample)).not.toContain('PRIVATE')
  })

  it('excludes tools, multiple response steps and multi-turn totals from per-model throughput', () => {
    for (const extra of [
      { ...delta, step_update: { ...delta.step_update, step_index: 2, step_type: 'tool_call' } },
      { ...delta, step_update: { ...delta.step_update, step_index: 3 } },
    ]) {
      const sample = fixture({ extra })
      expect(sample).toMatchObject({ status: 'incomplete', resolution: 'turn' })
      expect(buildSpeedReport([sample]).rows[0]).toMatchObject({ timedRequests: 0, effectiveTokensPerSecond: null, generationTokensPerSecondP50: null })
    }
    expect(fixture({ result: { ...result, result: { ...result.result, num_turns: 2 } } })).toMatchObject({ status: 'incomplete', resolution: 'turn' })
  })

  it('keeps missing/malformed counters, model identity and mismatched conversations unavailable', () => {
    for (const badUsage of [{ input_tokens: 3 }, { output_tokens: -1 }, { output_tokens: 1.5 }, { output_tokens: 6, thinking_tokens: 7 }]) {
      const sample = fixture({ result: { ...result, result: { ...result.result, usage: badUsage } } })
      expect(sample.status).toBe('incomplete')
      expect(buildSpeedReport([sample]).rows[0].effectiveTokensPerSecond).toBeNull()
    }
    expect(fixture({ init: { ...init, init: {} } }).status).toBe('incomplete')
    expect(fixture({ init: { ...init, init: { model: 'MODEL_PLACEHOLDER_RETRY' } } }).status).toBe('incomplete')
    expect(fixture({ delta: { ...delta, step_update: { ...delta.step_update, conversation_id: 'other' } } }).status).toBe('incomplete')
    expect(fixture({ result: { ...result, result: { ...result.result, conversation_id: 'other' } } }).status).toBe('incomplete')
  })

  it('discloses malformed or oversized frames even when a success footer follows', () => {
    for (const malformed of ['not-json\n', '{"private":"' + 'x'.repeat(1024 * 1024 + 1) + '"}\n']) {
      const observer = new AntigravitySpeedObserver(() => 100)
      observer.feed(Buffer.from(line(init) + malformed + line(result)))
      expect(observer.finish()!.status).toBe('incomplete')
    }
  })

  it('retains errors and early EOF as untimed metadata and never fabricates a sample without init', () => {
    expect(fixture({ result: { ...result, result: { ...result.result, status: 'ERROR' } } }).status).toBe('error')
    expect(fixture({ result: { ...result, result: { ...result.result, status: 'CANCELLED' } } }).status).toBe('interrupted')
    let clock = 0
    const observer = new AntigravitySpeedObserver(() => clock)
    observer.feed(Buffer.from(line(init))); clock = 100; observer.feed(Buffer.from(line(delta)))
    clock = 200
    const sample = observer.finish()!
    expect(sample).toMatchObject({ status: 'interrupted', durationMs: 200, events: [{ elapsedMs: 100 }] })
    expect(sample.outputTokens).toBeUndefined()
    expect(buildSpeedReport([sample]).rows[0].effectiveTokensPerSecond).toBeNull()
    expect(new AntigravitySpeedObserver().finish()).toBeNull()
  })

  it('caps a long emitted timeline while retaining truthful first/last arrivals and marking truncation', () => {
    let clock = 0
    const observer = new AntigravitySpeedObserver(() => clock)
    observer.feed(Buffer.from(line(init)))
    const wire = Buffer.from(line(delta))
    for (clock = 1; clock <= 100001; clock++) observer.feed(wire)
    observer.feed(Buffer.from(line(result)))
    const sample = observer.finish()!
    expect(sample).toMatchObject({ timelineTruncated: true, firstEmissionMs: 1, lastEmissionMs: 100001 })
    expect(sample.events).toHaveLength(100000)
    expect(buildSpeedReport([sample]).rows[0].interTokenMsP50).toBeNull()
  })

  it('forwards CLI bytes unchanged, stores private metadata and makes the native stream reportable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeburn-agy-speed-'))
    try {
      const file = join(dir, 'speed.jsonl')
      const wire = frames.map(line).join('')
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'speed', 'capture-antigravity', '--file', file],
        { stdio: ['pipe', 'pipe', 'pipe'] })
      let received = ''
      child.stdout.on('data', bytes => { received += String(bytes) })
      child.stderr.resume()
      const exited = once(child, 'close')
      for (const frame of frames.slice(0, -1)) {
        const forwarded = once(child.stdout, 'data')
        child.stdin.write(line(frame))
        await forwarded
      }
      child.stdin.end(line(result))
      expect((await exited)[0]).toBe(0)
      expect(received).toBe(wire)
      const { samples } = await readSpeedSamples(file)
      expect(samples).toHaveLength(1)
      expect(samples[0]).toMatchObject({ harness: 'antigravity', source: 'antigravity-cli', resolution: 'chunk', status: 'complete', outputTokens: 6 })
      expect(await readFile(file, 'utf8')).not.toMatch(/PRIVATE|private|răspuns|cwd|tools|response/)
      if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
      const report = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'speed', '--no-history', '--file', file, '--json'],
        { encoding: 'utf8', timeout: 15000 }))
      expect(report.rows[0]).toMatchObject({ harness: 'antigravity', timedRequests: 1, interTokenMsP50: null })
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it.skipIf(process.platform === 'win32')('drains observed partial timing before exiting after SIGTERM', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeburn-agy-cancel-'))
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'speed', 'capture-antigravity', '--file', join(dir, 'speed.jsonl')],
      { stdio: ['pipe', 'pipe', 'pipe'] })
    try {
      let stderr = ''
      child.stderr.on('data', bytes => { stderr += String(bytes) })
      const exited = once(child, 'exit')
      const forwarded = once(child.stdout, 'data')
      child.stdin.write(line(init) + line(delta))
      await forwarded
      child.kill('SIGTERM')
      const [code, signal] = await exited
      expect({ code, signal, stderr }).toMatchObject({ code: 130, signal: null })
      const { samples } = await readSpeedSamples(join(dir, 'speed.jsonl'))
      expect(samples[0]).toMatchObject({ status: 'interrupted', events: [{ elapsedMs: expect.any(Number) }] })
      expect(buildSpeedReport(samples).rows[0].timedRequests).toBe(0)
    } finally { child.kill('SIGKILL'); await rm(dir, { recursive: true, force: true }) }
  })

  it.skipIf(process.platform === 'win32')('retains partial metadata when a downstream reader closes the forwarded output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeburn-agy-epipe-'))
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'speed', 'capture-antigravity', '--file', join(dir, 'speed.jsonl')],
      { stdio: ['pipe', 'pipe', 'pipe'] })
    try {
      child.stderr.resume()
      child.stdin.on('error', () => undefined)
      const exited = once(child, 'close')
      const forwarded = once(child.stdout, 'data')
      child.stdin.write(line(init))
      await forwarded
      child.stdout.destroy()
      child.stdin.end(line(delta))
      expect((await exited)[0]).toBe(0)
      const { samples } = await readSpeedSamples(join(dir, 'speed.jsonl'))
      expect(samples[0]).toMatchObject({ status: 'interrupted', events: [{ elapsedMs: expect.any(Number) }] })
      expect(buildSpeedReport(samples).rows[0].timedRequests).toBe(0)
    } finally { child.kill('SIGKILL'); await rm(dir, { recursive: true, force: true }) }
  })
})

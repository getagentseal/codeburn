import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, stat, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { execFileSync } from 'node:child_process'
import { SpeedStreamObserver } from '../src/speed/stream.js'
import { appendSpeedSample, readSpeedSamples } from '../src/speed/store.js'
import { startSpeedServer, type SpeedServer } from '../src/speed/server.js'
import { buildSpeedReport, renderSpeedReport } from '../src/speed/report.js'
import { validateSpeedSample, type SpeedSample } from '../src/speed/types.js'

let dir: string
const servers: SpeedServer[] = []
const upstreams: Server[] = []
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'codeburn-speed-')) })
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const server of upstreams.splice(0)) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
  await rm(dir, { recursive: true, force: true })
})

function native(overrides: Partial<SpeedSample> = {}): SpeedSample {
  return { version: 1, id: 'request-1', harness: 'hermes', model: 'test-model', source: 'native', resolution: 'token',
    startedAt: '2026-10-01T09:00:00Z', durationMs: 1000, firstEmissionMs: 100, lastEmissionMs: 500,
    outputTokens: 3, status: 'complete', events: [{ elapsedMs: 100, tokens: 1 }, { elapsedMs: 300, tokens: 1 }, { elapsedMs: 500, tokens: 1 }], ...overrides }
}
const sse = (value: unknown) => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`

describe('stream timing', () => {
  it('timestamps generated SSE events across UTF-8/socket fragmentation; never infers individual tokens from text', () => {
    let now = 0
    const observer = new SpeedStreamObserver('claude', 'unknown', () => now)
    observer.feed(Buffer.from(': heartbeat\n\n' + sse({ type: 'message_start', message: { model: 'claude-test', usage: { input_tokens: 9, output_tokens: 0 } } })))
    now = 100
    const chunk = Buffer.from(sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'A PRIVATE răspuns with many words' } }))
    const split = chunk.indexOf(Buffer.from('ă')) + 1
    observer.feed(chunk.subarray(0, split)); observer.feed(chunk.subarray(split))
    now = 300
    observer.feed(Buffer.from(sse({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'SECRET reasoning' } })))
    now = 500
    observer.feed(Buffer.from((sse({ type: 'message_delta', usage: { output_tokens: 40 } }) + sse({ type: 'message_stop' })).replace(/\n/g, '\r\n')))
    now = 600
    const sample = observer.finish('complete')
    expect(sample).toMatchObject({ model: 'claude-test', resolution: 'chunk', status: 'complete', outputTokens: 40, inputTokens: 9, firstEmissionMs: 100, lastEmissionMs: 300, durationMs: 600 })
    expect(sample.events).toEqual([{ elapsedMs: 100 }, { elapsedMs: 300 }])
    expect(JSON.stringify(sample)).not.toMatch(/PRIVATE|SECRET|răspuns/)
    expect(buildSpeedReport([sample]).rows[0]).toMatchObject({ generationRateEstimated: true, interTokenMsP50: null })
  })

  it('captures DeepSeek/OpenAI content, reasoning and tool deltas, with inclusive usage counted once', () => {
    let now = 0
    const observer = new SpeedStreamObserver('dsh', 'unknown', () => now)
    now = 10
    observer.feed(Buffer.from(sse({ model: 'deepseek-test', choices: [{ delta: { reasoning_content: 'private thought' } }] })))
    now = 20
    observer.feed(Buffer.from(sse({ choices: [{ delta: { content: 'hello', tool_calls: [{ function: { arguments: '{}' } }] } }] })))
    now = 30
    observer.feed(Buffer.from(sse({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 10, completion_tokens_details: { reasoning_tokens: 6 } } }) + sse('[DONE]')))
    const sample = observer.finish('complete')
    expect(sample).toMatchObject({ model: 'deepseek-test', outputTokens: 10, reasoningTokens: 6, status: 'complete' })
    expect(sample.events).toHaveLength(2)
  })

  it('supports Responses streams and leaves missing/failed usage unavailable', () => {
    let now = 0
    const observer = new SpeedStreamObserver('codex', 'unknown', () => now)
    now = 25
    observer.feed(Buffer.from(sse({ type: 'response.output_text.delta', delta: 'Hello' })))
    now = 50
    observer.feed(Buffer.from(sse({ type: 'response.completed', response: { model: 'codex-test', usage: { input_tokens: 99, output_tokens: 5, output_tokens_details: { reasoning_tokens: 2 } } } })))
    expect(observer.finish('complete')).toMatchObject({ outputTokens: 5, model: 'codex-test', status: 'complete' })
    const missing = new SpeedStreamObserver('codex')
    missing.feed(Buffer.from(sse('[DONE]')))
    expect(missing.finish('complete')).toMatchObject({ status: 'incomplete' })
    const failed = new SpeedStreamObserver('codex')
    failed.feed(Buffer.from(sse({ type: 'response.failed' }) + sse('[DONE]')))
    expect(failed.finish('complete').status).toBe('incomplete')
  })

  it('does not accept malformed, truncated or oversized SSE as complete telemetry', () => {
    const observer = new SpeedStreamObserver('hermes')
    observer.feed(Buffer.from('data: not-json\n\n'))
    expect(observer.finish('complete').status).toBe('incomplete')
    const oversized = new SpeedStreamObserver('hermes')
    oversized.feed(Buffer.from('data: ' + 'x'.repeat(1024 * 1024 + 1)))
    expect(oversized.finish('complete').status).toBe('incomplete')
  })
})

describe('native token telemetry and reports', () => {
  it('reports actual token intervals, first-token latency, N-1 decode intervals and harness-separated rows', () => {
    const report = buildSpeedReport([native(), native({ id: 'request-2', harness: 'claude' })])
    expect(report.rows).toHaveLength(2)
    for (const row of report.rows) expect(row).toMatchObject({ effectiveTokensPerSecond: 3, generationTokensPerSecondP50: 5,
      firstEmissionMsP50: 100, interTokenMsP50: 200, interTokenMsP95: 200, generationRateEstimated: false, generationRequests: 1 })
    expect(report.unavailableHarnesses).toContain('antigravity')
  })

  it('keeps generation speed unchanged when only the initial wait grows', () => {
    const original = native({ harness: 'dsh' })
    const delayed = native({ id: 'slow-first-token', harness: 'dsh', durationMs: 4000, firstEmissionMs: 3100, lastEmissionMs: 3500,
      events: [{ elapsedMs: 3100, tokens: 1 }, { elapsedMs: 3300, tokens: 1 }, { elapsedMs: 3500, tokens: 1 }] })
    const fast = buildSpeedReport([original]).rows[0]!
    const slow = buildSpeedReport([delayed]).rows[0]!
    expect(fast.generationTokensPerSecondP50).toBe(5)
    expect(slow.generationTokensPerSecondP50).toBe(5)
    expect(slow.effectiveTokensPerSecond).toBe(0.75)
    expect(slow.firstEmissionMsP50).toBe(3100)
    const printed = renderSpeedReport(buildSpeedReport([delayed]))
    expect(printed).toContain('Generation Tok/s p50')
    expect(printed).toContain('DeepSeek Harness\ttest-model\tnative/token\t1/1\t5.0\t3100.0')
    expect(printed).not.toContain('Effective Tok/s')
  })

  it('never substitutes request throughput for missing generation timing', () => {
    const samples = [
      native({ model: 'single-token', outputTokens: 1, firstEmissionMs: 100, lastEmissionMs: 100, events: [{ elapsedMs: 100, tokens: 1 }] }),
      native({ model: 'single-chunk', source: 'proxy', resolution: 'chunk', lastEmissionMs: 100, events: [{ elapsedMs: 100 }] }),
      native({ model: 'no-first-token', source: 'zcode-db', resolution: 'request', firstEmissionMs: undefined, lastEmissionMs: undefined, events: [] }),
      native({ model: 'turn-only', source: 'codex-checkpoint', resolution: 'turn', firstEmissionMs: undefined, lastEmissionMs: undefined, events: [] }),
      native({ model: 'cancelled', status: 'interrupted' }),
    ]
    const report = buildSpeedReport(samples)
    expect(report.rows.every(r => r.generationTokensPerSecondP50 === null && r.generationRequests === 0)).toBe(true)
    expect(report.rows.filter(r => r.effectiveTokensPerSecond !== null)).toHaveLength(4)
    expect(report.unavailableHarnesses).toContain('hermes')
  })

  it('weights throughput by timed durations and excludes interrupted calls instead of treating them as zero', () => {
    const report = buildSpeedReport([
      native({ resolution: 'request', outputTokens: 40, events: [] }),
      native({ id: 'request-2', resolution: 'request', durationMs: 9000, outputTokens: 90, events: [] }),
      native({ id: 'request-3', resolution: 'request', status: 'interrupted', events: [] }),
    ])
    expect(report.rows[0]).toMatchObject({ effectiveTokensPerSecond: 13, timedRequests: 2, requests: 3, incompleteRequests: 1, interTokenMsP50: null })
  })

  it('keeps overlapping source recordings separate and never invents token intervals for request/chunk timing', () => {
    const report = buildSpeedReport([native(), native({ source: 'zcode-db', resolution: 'request', events: [] }), native({ source: 'proxy', resolution: 'chunk', events: [{ elapsedMs: 100 }, { elapsedMs: 500 }] })])
    expect(report.rows).toHaveLength(3)
    expect(report.rows.filter(r => r.resolution !== 'token').every(r => r.interTokenMsP50 === null && r.generationRateEstimated)).toBe(true)
  })

  it('rejects fabricated per-token timing and strips producer content', () => {
    expect(() => validateSpeedSample(native({ source: 'proxy' }))).toThrow(/native/)
    expect(() => validateSpeedSample(native({ outputTokens: 4 }))).toThrow(/match/)
    expect(() => validateSpeedSample(native({ events: [{ elapsedMs: 300, tokens: 1 }, { elapsedMs: 100, tokens: 1 }] }))).toThrow()
    expect(() => validateSpeedSample(native({ durationMs: Infinity }))).toThrow()
    expect(() => validateSpeedSample(native({ model: '\u001b[2J' }))).toThrow()
    const clean = validateSpeedSample({ ...native(), headers: { authorization: 'secret' }, text: 'private prompt', events: native().events.map(e => ({ ...e, tokenText: 'secret' })) })
    expect(JSON.stringify(clean)).not.toMatch(/secret|private|headers|tokenText/)
  })
})

describe('local store and HTTP capture', () => {
  it('deduplicates identities per harness/source, ignores a torn row and creates a private regular file', async () => {
    const file = join(dir, 'speed.jsonl')
    await Promise.all(Array.from({ length: 10 }, (_, i) => appendSpeedSample(native({ id: `r-${i}` }), file)))
    await appendSpeedSample(native({ id: 'r-0' }), file)
    await appendSpeedSample(native({ id: 'r-0', harness: 'claude' }), file)
    const { appendFile } = await import('node:fs/promises')
    await appendFile(file, '{torn')
    const result = await readSpeedSamples(file)
    expect(result.samples).toHaveLength(11)
    expect(result.rejected).toBe(1)
    const limited = await readSpeedSamples(file, 1)
    expect(limited.samples).toHaveLength(1)
    expect(limited.omitted).toBeGreaterThan(0)
    const selected = await readSpeedSamples(file, 1, s => s.harness === 'claude')
    expect(selected.samples[0].harness).toBe('claude')
    expect(selected.omitted).toBe(0)
    if (process.platform !== 'win32') {
      expect((await stat(file)).mode & 0o777).toBe(0o600)
      const link = join(dir, 'link.jsonl')
      await symlink(file, link)
      await expect(appendSpeedSample(native(), link)).rejects.toThrow()
    }
  })

  it('relays authenticated SSE bytes unchanged, records the real arrivals, and stores no content or credentials', async () => {
    const body = JSON.stringify({ model: 'test-claude', stream: true, messages: [{ role: 'user', content: 'PRIVATE-PROMPT' }] })
    const wire = sse({ type: 'message_start', message: { model: 'test-claude', usage: { input_tokens: 7 } } })
      + sse({ type: 'content_block_delta', delta: { text: 'PRIVATE-REPLY' } })
      + sse({ type: 'message_delta', usage: { output_tokens: 4 } }) + sse({ type: 'message_stop' })
    let receivedBody = '', auth: string | undefined
    const upstream = createServer((req, res) => {
      auth = req.headers.authorization
      req.on('data', c => { receivedBody += c })
      req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(wire.slice(0, 80)); res.end(wire.slice(80)) })
    })
    upstreams.push(upstream)
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    const address = upstream.address() as { port: number }
    const file = join(dir, 'proxy.jsonl')
    const proxy = await startSpeedServer({ upstream: `http://127.0.0.1:${address.port}`, harness: 'claude', file })
    servers.push(proxy)
    const response = await fetch(proxy.url + '/v1/messages', { method: 'POST', headers: { authorization: 'Bearer SECRET-CREDENTIAL', 'content-type': 'application/json' }, body })
    expect(await response.text()).toBe(wire)
    expect(receivedBody).toBe(body)
    expect(auth).toBe('Bearer SECRET-CREDENTIAL')
    await proxy.close(); servers.splice(servers.indexOf(proxy), 1)
    const stored = await readSpeedSamples(file)
    expect(stored.samples[0]).toMatchObject({ harness: 'claude', model: 'test-claude', status: 'complete', outputTokens: 4, resolution: 'chunk' })
    expect(await readFile(file, 'utf8')).not.toMatch(/PRIVATE|SECRET|authorization|messages/)
  })

  it('collects native token timelines and rejects browser/unauthenticated ingestion', async () => {
    const file = join(dir, 'native.jsonl')
    const server = await startSpeedServer({ file })
    servers.push(server)
    const url = server.url + '/v1/speed'
    expect((await fetch(url, { method: 'POST', headers: { origin: 'https://example.com', 'content-type': 'application/json', 'x-codeburn-speed': '1' }, body: JSON.stringify(native()) })).status).toBe(403)
    expect((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(native()) })).status).toBe(403)
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-codeburn-speed': '1' }, body: JSON.stringify({ ...native(), privateText: 'SECRET' }) })
    expect(response.status).toBe(204)
    expect((await readSpeedSamples(file)).samples[0].events).toHaveLength(3)
    expect(await readFile(file, 'utf8')).not.toContain('SECRET')
    expect((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-codeburn-speed': '1' }, body: JSON.stringify(native({ outputTokens: 40 })) })).status).toBe(400)
  })

  it('marks a cancelled upstream stream as interrupted and unavailable for complete-request throughput', async () => {
    const upstream = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(sse({ model: 'test-model', choices: [{ delta: { content: 'partial' } }] }))
    })
    upstreams.push(upstream)
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    const file = join(dir, 'cancelled.jsonl')
    const proxy = await startSpeedServer({ upstream: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`, harness: 'hermes', file })
    servers.push(proxy)
    const response = await fetch(proxy.url + '/v1/chat/completions', { method: 'POST', body: '{"model":"test-model"}' })
    await response.body!.cancel()
    await proxy.close(); servers.splice(servers.indexOf(proxy), 1)
    const stored = await readSpeedSamples(file)
    expect(stored.samples).toHaveLength(1)
    expect(stored.samples[0].status).toBe('interrupted')
    expect(buildSpeedReport(stored.samples).rows[0]).toMatchObject({ timedRequests: 0, effectiveTokensPerSecond: null })
  })

  it('runs the CLI against a native trace, scopes coverage to the selected harness and exposes token timestamps', async () => {
    const file = join(dir, 'cli.jsonl')
    await appendSpeedSample(native(), file)
    const run = (...args: string[]) => execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'speed', ...args], { encoding: 'utf8', timeout: 15_000 })
    const report = JSON.parse(run('--no-history', '--harness', 'hermes', '--file', file, '--json'))
    expect(report.rows[0]).toMatchObject({ harness: 'hermes', interTokenMsP50: 200, latestSampleId: 'request-1', latestStartedAt: '2026-10-01T09:00:00.000Z' })
    expect(report.unavailableHarnesses).toEqual([])
    expect(JSON.parse(run('events', 'request-1', '--file', file)).events).toEqual(native().events)
  })

  it('applies desktop date bounds before the record limit and honors custom ranges over the period', async () => {
    const file = join(dir, 'date-filter.jsonl')
    const day = (date: string) => new Date(date + 'T12:00:00').toISOString()
    for (const date of ['2026-09-30', '2026-10-01', '2026-10-02']) {
      await appendSpeedSample(native({ id: date, startedAt: day(date) }), file)
    }
    const raw = execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'speed', '--no-history', '--json', '--file', file,
      '--period', 'today', '--from', '2026-10-01', '--to', '2026-10-01', '--limit', '1'], { encoding: 'utf8', timeout: 15_000 })
    const report = JSON.parse(raw)
    expect(report.rows).toHaveLength(1)
    expect(report.rows[0]).toMatchObject({ requests: 1, latestSampleId: '2026-10-01' })
    expect(report.omittedRecords).toBe(0)
    expect(report.historyLimit).toBe(0)
  })

  it('refuses credential-bearing or remote plaintext upstreams', async () => {
    await expect(startSpeedServer({ upstream: 'https://user:secret@example.com', harness: 'codex' })).rejects.toThrow(/origin/)
    await expect(startSpeedServer({ upstream: 'http://example.com', harness: 'codex' })).rejects.toThrow(/HTTPS/)
    await expect(startSpeedServer({ upstream: 'https://example.com/v1', harness: 'codex' })).rejects.toThrow(/origin/)
  })
})

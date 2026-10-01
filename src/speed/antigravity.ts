import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { StringDecoder } from 'node:string_decoder'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { appendSpeedSample } from './store.js'
import { validateSpeedSample, type SpeedSample } from './types.js'

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const label = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value)

// Observe the CLI's own NDJSON deltas. Arrival times share one local clock;
// duration_seconds belongs to a different clock and is never used to invent
// first/last-token timestamps. CLI startup before init is outside this window.
export class AntigravitySpeedObserver {
  private decoder = new StringDecoder('utf8')
  private pending = ''
  private discarding = false
  private invalid = false
  private started = false
  private ended = false
  private conversation = '' // ephemeral consistency check, never persisted
  private start = 0
  private responseStep: number | undefined
  private composite = false
  private sample: SpeedSample = {
    version: 1, id: randomUUID(), harness: 'antigravity', model: 'unknown',
    source: 'antigravity-cli', resolution: 'chunk', startedAt: '',
    durationMs: 0, status: 'incomplete', events: [],
  }

  constructor(private now: () => number = () => performance.now(), private wall: () => Date = () => new Date()) {}

  feed(bytes: Buffer): void {
    const at = this.now()
    const text = this.decoder.write(bytes)
    // Split without retaining an unbounded readline buffer. Oversized frames
    // are discarded through their next newline; timings then remain incomplete.
    for (const part of text.split(/(?<=\n)/)) {
      if (!this.discarding) {
        this.pending += part
        if (this.pending.length > 1024 * 1024) { this.pending = ''; this.discarding = true; this.invalid = true }
      }
      if (part.endsWith('\n')) {
        if (!this.discarding) this.line(this.pending, at)
        this.pending = ''; this.discarding = false
      }
    }
  }

  private line(raw: string, at: number): void {
    if (!raw.trim()) return
    let frame: Record<string, unknown>
    try { frame = object(JSON.parse(raw)) } catch { this.invalid = true; return }
    if (frame.event === 'init') {
      if (this.started) { this.invalid = true; return }
      this.started = true; this.start = at; this.sample.startedAt = this.wall().toISOString()
      this.conversation = label(frame.conversation_id) ? frame.conversation_id : ''
      const model = object(frame.init).model
      if (label(model) && !model.startsWith('MODEL_PLACEHOLDER_')) this.sample.model = model
      return
    }
    if (!this.started) { this.invalid = true; return }
    if (this.ended) { if (frame.event === 'init' || frame.event === 'result' || frame.event === 'step_update') this.invalid = true; return }
    const elapsedMs = Math.max(0, at - this.start)
    if (frame.event === 'step_update') {
      const update = object(frame.step_update)
      if (!this.conversation || update.conversation_id !== this.conversation) { this.invalid = true; return }
      if (update.step_type === 'user_input') return
      if (update.step_type !== 'agent_response') { this.composite = true; return }
      if (!count(update.step_index)) { this.invalid = true; return }
      this.responseStep ??= update.step_index
      if (this.responseStep !== update.step_index) this.composite = true
      if ([update.text_delta, update.thinking_delta].some(delta => typeof delta === 'string' && delta.length > 0)) {
        this.sample.firstEmissionMs ??= elapsedMs
        this.sample.lastEmissionMs = elapsedMs
        if (this.sample.events.length < 100_000) this.sample.events.push({ elapsedMs })
        else this.sample.timelineTruncated = true
      }
      return
    }
    if (frame.event === 'result') {
      const result = object(frame.result)
      if (!this.conversation || result.conversation_id !== this.conversation) this.invalid = true
      this.ended = true; this.sample.durationMs = elapsedMs
      const usage = object(result.usage)
      if (count(usage.output_tokens)) this.sample.outputTokens = usage.output_tokens
      else this.invalid = true
      if (usage.input_tokens !== undefined) {
        if (count(usage.input_tokens)) this.sample.inputTokens = usage.input_tokens
        else this.invalid = true
      }
      // Antigravity's output_tokens includes thinking_tokens (also reflected
      // by total_tokens = input_tokens + output_tokens). Do not add it twice.
      if (usage.thinking_tokens !== undefined) {
        if (count(usage.thinking_tokens) && count(usage.output_tokens) && usage.thinking_tokens <= usage.output_tokens) this.sample.reasoningTokens = usage.thinking_tokens
        else this.invalid = true
      }
      if (result.num_turns !== 1) this.composite = true
      this.sample.status = result.status === 'SUCCESS' ? 'complete'
        : ['CANCELLED', 'CANCELED', 'TIMEOUT', 'INTERRUPTED'].includes(String(result.status)) ? 'interrupted'
          : result.status === 'ERROR' ? 'error' : 'incomplete'
    }
  }

  finish(interrupted = false): SpeedSample | null {
    this.pending += this.decoder.end()
    if (!this.discarding && this.pending.trim()) this.line(this.pending, this.now())
    this.pending = ''
    if (!this.started) return null
    if (!this.ended) this.sample.durationMs = Math.max(0, this.now() - this.start)
    if (interrupted || !this.ended) this.sample.status = 'interrupted'
    if (this.composite) this.sample.resolution = 'turn'
    // A composite run may combine tools/subagents/models. Its final aggregate
    // cannot establish this model's generation speed, so keep it untimed.
    if ((this.invalid || this.composite || this.sample.model === 'unknown' || !this.conversation) && this.sample.status === 'complete') this.sample.status = 'incomplete'
    return validateSpeedSample(this.sample)
  }
}

let activeCapture: Promise<SpeedSample | null> | undefined

// A downstream reader may close stdout while a capture is in flight. The
// shared CLI EPIPE handler waits for its partial record before exiting.
export async function awaitAntigravitySpeedCapture(): Promise<void> {
  await activeCapture?.catch(() => undefined)
}

export function captureAntigravitySpeed(file?: string): Promise<SpeedSample | null> {
  activeCapture = capture(file)
  return activeCapture
}

async function capture(file?: string): Promise<SpeedSample | null> {
  if (process.stdin.isTTY) throw new Error('Pipe agy --output-format stream-json into speed capture-antigravity')
  const observer = new AntigravitySpeedObserver()
  const controller = new AbortController()
  let interrupted = false
  const stop = () => { interrupted = true; controller.abort() }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  // Destroying the forwarding stream on cancellation must not destroy stdout:
  // the CLI's shared stdout error handler would exit before partial data saves.
  const forward = new Writable({ write(bytes: Buffer, _encoding, done) {
    observer.feed(bytes); process.stdout.write(bytes, done)
  } })
  let failed = false
  try { await pipeline(process.stdin, forward, { signal: controller.signal }) }
  catch { failed = true }
  finally { process.off('SIGINT', stop); process.off('SIGTERM', stop) }
  const sample = observer.finish(interrupted || failed)
  if (sample) await appendSpeedSample(sample, file)
  if (failed && !interrupted) throw new Error('Antigravity stream forwarding failed; partial timing retained when available')
  if (interrupted) process.exitCode = 130
  return sample
}

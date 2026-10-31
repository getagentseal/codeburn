import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type { SpeedHarness, SpeedSample } from './types.js'

type Json = Record<string, unknown>
const object = (v: unknown): Json => v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {}
const positiveText = (v: unknown): boolean => typeof v === 'string' && v.length > 0
const tokens = (v: unknown): number | undefined => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined

// Observe SSE *events*, not socket chunks. A TCP read can split one delta or
// batch many deltas; neither changes how many model emission events occurred.
export class SpeedStreamObserver {
  private decoder = new StringDecoder('utf8')
  private pending = ''
  private unusable = false
  private completed = false
  private sample: SpeedSample

  constructor(harness: SpeedHarness, model = 'unknown', private now: () => number = () => performance.now(), private start = now()) {
    this.sample = { version: 1, id: randomUUID(), harness, model, source: 'proxy', resolution: 'chunk',
      startedAt: new Date().toISOString(), durationMs: 0, status: 'incomplete', events: [] }
  }

  setModel(model: unknown): void {
    if (typeof model === 'string' && model.length && model.length <= 256 && !/[\x00-\x1f\x7f]/.test(model)) this.sample.model = model
  }

  private usage(raw: unknown, protocol: 'anthropic' | 'openai'): void {
    const u = object(raw)
    const output = tokens(protocol === 'anthropic' ? u.output_tokens : u.output_tokens ?? u.completion_tokens)
    const input = tokens(protocol === 'anthropic' ? u.input_tokens : u.input_tokens ?? u.prompt_tokens)
    const reasoning = tokens(object(u.output_tokens_details ?? u.completion_tokens_details).reasoning_tokens)
    if (output !== undefined) this.sample.outputTokens = output
    if (input !== undefined) this.sample.inputTokens = input
    if (reasoning !== undefined) this.sample.reasoningTokens = reasoning
  }

  private event(data: string): void {
    if (data.trim() === '[DONE]') { this.completed = true; return }
    let parsed: unknown
    try { parsed = JSON.parse(data) } catch { this.unusable = true; return }
    const p = object(parsed)
    const delta = object(p.delta)
    const response = object(p.response)
    this.setModel(p.model ?? response.model ?? object(p.message).model)
    let emitted = false
    if (p.type === 'message_start') this.usage(object(p.message).usage, 'anthropic')
    if (p.type === 'message_delta') this.usage(p.usage, 'anthropic')
    if (p.type === 'message_stop' || p.type === 'response.completed') this.completed = true
    if (p.type === 'error' || p.type === 'response.failed' || p.type === 'response.incomplete') this.unusable = true
    if (p.type === 'content_block_delta') emitted = [delta.text, delta.thinking, delta.partial_json].some(positiveText)
    if (['response.output_text.delta', 'response.reasoning_text.delta', 'response.reasoning_summary_text.delta', 'response.function_call_arguments.delta'].includes(String(p.type))) emitted = positiveText(p.delta)
    if (p.type === 'response.completed') this.usage(response.usage, 'openai')
    if (Array.isArray(p.choices)) {
      emitted ||= p.choices.some(c => {
        const d = object(object(c).delta)
        return positiveText(d.content) || positiveText(d.reasoning_content) || positiveText(d.reasoning)
          || (Array.isArray(d.tool_calls) && d.tool_calls.some(t => positiveText(object(object(t).function).arguments)))
      })
      this.usage(p.usage, 'openai')
    }
    if (emitted) {
      const elapsedMs = Math.max(0, this.now() - this.start)
      this.sample.firstEmissionMs ??= elapsedMs
      this.sample.lastEmissionMs = elapsedMs
      if (this.sample.events.length < 100_000) this.sample.events.push({ elapsedMs })
      else this.sample.timelineTruncated = true
    }
  }

  feed(bytes: Buffer): void {
    if (this.unusable) return
    this.pending += this.decoder.write(bytes)
    let boundary: RegExpExecArray | null
    while ((boundary = /\r?\n\r?\n/.exec(this.pending))) {
      const frame = this.pending.slice(0, boundary.index)
      this.pending = this.pending.slice(boundary.index + boundary[0].length)
      if (frame.length > 1024 * 1024) { this.unusable = true; this.pending = ''; return }
      const data = frame.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n')
      if (data) this.event(data)
    }
    if (this.pending.length > 1024 * 1024) { this.unusable = true; this.pending = '' }
  }

  finish(status: 'complete' | 'interrupted' | 'error'): SpeedSample {
    this.sample.durationMs = Math.max(0, this.now() - this.start)
    this.sample.status = status === 'complete'
      ? (!this.unusable && this.completed && this.sample.outputTokens !== undefined ? 'complete' : 'incomplete') : status
    return this.sample
  }
}

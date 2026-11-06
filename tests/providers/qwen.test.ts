import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { calculateCost, loadPricing } from '../../src/models.js'
import { createQwenProvider } from '../../src/providers/qwen.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

const dirs: string[] = []

beforeAll(async () => {
  await loadPricing()
})

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

const model = 'qwen3-coder-flash'

async function parseUsage(usageMetadata: Record<string, number>, authType?: string): Promise<ParsedProviderCall[]> {
  const dir = await mkdtemp(join(tmpdir(), 'codeburn-qwen-test-'))
  dirs.push(dir)
  const chats = join(dir, '-tmp-demo', 'chats')
  await mkdir(chats, { recursive: true })
  const user = { uuid: 'u1', sessionId: 's1', timestamp: '2026-10-20T09:59:59.000Z', type: 'user', message: { role: 'user', parts: [{ text: 'go' }] }, executionContext: { modelId: model, authType } }
  await writeFile(join(chats, 's1.jsonl'), [...(authType ? [user] : []), {
    uuid: 'a1', sessionId: 's1', timestamp: '2026-10-20T10:00:00.000Z', type: 'assistant', model,
    message: { role: 'model', parts: [{ text: 'done' }] },
    usageMetadata,
  }].map(r => JSON.stringify(r)).join('\n') + '\n')
  const provider = createQwenProvider(dir)
  const [source] = await provider.discoverSessions()
  const calls: ParsedProviderCall[] = []
  for await (const call of provider.createSessionParser(source!, new Set()).parse()) calls.push(call)
  return calls
}

describe('qwen provider', () => {
  it('bills cached prompt tokens once, at the cache-read rate', async () => {
    const calls = await parseUsage({ promptTokenCount: 100_000, candidatesTokenCount: 1_000, thoughtsTokenCount: 0, totalTokenCount: 101_000, cachedContentTokenCount: 90_000 })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens).toBe(10_000)
    expect(calls[0]!.cacheReadInputTokens).toBe(90_000)
    expect(calls[0]!.costUSD).toBeGreaterThan(0)
    expect(calls[0]!.costUSD).toBeCloseTo(calculateCost(model, 10_000, 1_000, 0, 90_000, 0), 12)
  })

  it('adds thoughts reported beside candidates (Gemini backend)', async () => {
    const [call] = await parseUsage({ promptTokenCount: 1_000, candidatesTokenCount: 200, thoughtsTokenCount: 50, totalTokenCount: 1_250, cachedContentTokenCount: 0 })
    expect(call!.outputTokens + call!.reasoningTokens).toBe(250)
    expect(call!.costUSD).toBeCloseTo(calculateCost(model, 1_000, 250, 0, 0, 0), 12)
  })

  it('does not add thoughts already inside candidates (OpenAI-compatible backend)', async () => {
    const [call] = await parseUsage({ promptTokenCount: 1_000, candidatesTokenCount: 200, thoughtsTokenCount: 50, totalTokenCount: 1_200, cachedContentTokenCount: 0 })
    expect(call!.outputTokens).toBe(150)
    expect(call!.reasoningTokens).toBe(50)
    expect(call!.costUSD).toBeCloseTo(calculateCost(model, 1_000, 200, 0, 0, 0), 12)
  })

  it('without a total, the recorded auth type decides, and an unknown one adds no thoughts', async () => {
    const usage = { promptTokenCount: 1_000, candidatesTokenCount: 200, thoughtsTokenCount: 50, cachedContentTokenCount: 0 }
    const [gemini] = await parseUsage(usage, 'gemini')
    expect(gemini!.costUSD).toBeCloseTo(calculateCost(model, 1_000, 250, 0, 0, 0), 12)
    const [openai] = await parseUsage(usage, 'openai')
    expect(openai!.costUSD).toBeCloseTo(calculateCost(model, 1_000, 200, 0, 0, 0), 12)
    const [unknown] = await parseUsage(usage)
    expect(unknown!.costUSD).toBeCloseTo(calculateCost(model, 1_000, 200, 0, 0, 0), 12)
  })

  it('never bills more cached tokens than the prompt held', async () => {
    const [call] = await parseUsage({ promptTokenCount: 1_000, candidatesTokenCount: 100, thoughtsTokenCount: 0, totalTokenCount: 1_100, cachedContentTokenCount: 5_000 })
    expect(call!.inputTokens).toBe(0)
    expect(call!.cacheReadInputTokens).toBe(1_000)
    expect(call!.costUSD).toBeCloseTo(calculateCost(model, 0, 100, 0, 1_000, 0), 12)
  })

  it('reads a negative cached count as none', async () => {
    const [call] = await parseUsage({ promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 0, totalTokenCount: 15, cachedContentTokenCount: -20 })
    expect(call!.inputTokens).toBe(10)
    expect(call!.cacheReadInputTokens).toBe(0)
  })
})

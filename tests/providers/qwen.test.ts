import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { calculateCost, loadPricing } from '../../src/models.js'
import { createQwenProvider } from '../../src/providers/qwen.js'
import type { ParsedProviderCall } from '../../src/providers/types.js'

let dir: string

beforeAll(async () => {
  await loadPricing()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const model = 'qwen3-coder-flash'

async function parseUsage(usageMetadata: Record<string, number>): Promise<ParsedProviderCall[]> {
  dir = await mkdtemp(join(tmpdir(), 'codeburn-qwen-test-'))
  const chats = join(dir, '-tmp-demo', 'chats')
  await mkdir(chats, { recursive: true })
  await writeFile(join(chats, 's1.jsonl'), JSON.stringify({
    uuid: 'a1', sessionId: 's1', timestamp: '2026-10-20T10:00:00.000Z', type: 'assistant', model,
    message: { role: 'model', parts: [{ text: 'done' }] },
    usageMetadata,
  }) + '\n')
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
})

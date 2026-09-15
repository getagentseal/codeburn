import { describe, it, expect, beforeAll, afterEach } from 'vitest'

import {
  calculateCost,
  findUnpricedModels,
  getModelRoute,
  getShortModelName,
  isExpectedFreeModel,
  loadPricing,
  setModelAliases,
} from '../src/models.js'

beforeAll(async () => {
  await loadPricing()
})

afterEach(() => {
  setModelAliases({})
})

// The same model billed through a different door must stay a separate row.
// Bedrock ids are the first route; the ids below were captured from real
// Claude Code (CLAUDE_CODE_USE_BEDROCK=1) and Hermes (bedrock provider)
// sessions, plus the shapes AWS documents for inference profiles and ARNs.

describe('getModelRoute - Bedrock ids', () => {
  it('recognises a bare foundation-model id and peels the vendor segment', () => {
    expect(getModelRoute('anthropic.claude-fable-5-1')).toEqual({
      id: 'bedrock', label: 'Bedrock', baseModel: 'claude-fable-5-1',
    })
    expect(getModelRoute('anthropic.claude-haiku-4-5-20251001-v1:0')).toEqual({
      id: 'bedrock', label: 'Bedrock', baseModel: 'claude-haiku-4-5-20251001',
    })
  })

  it('recognises cross-region inference-profile prefixes', () => {
    for (const geo of ['us', 'eu', 'apac', 'global', 'jp', 'au', 'us-gov']) {
      const route = getModelRoute(`${geo}.anthropic.claude-sonnet-4-5-20250929-v1:0`)
      expect(route?.id, geo).toBe('bedrock')
      expect(route?.baseModel, geo).toBe('claude-sonnet-4-5-20250929')
    }
  })

  it("recognises Bedrock's OpenAI ids, including the `-1:0` version spelling", () => {
    expect(getModelRoute('openai.gpt-5.6-luna')?.baseModel).toBe('gpt-5.6-luna')
    expect(getModelRoute('openai.gpt-oss-120b-1:0')?.baseModel).toBe('gpt-oss-120b')
  })

  it('drops a trailing context-length tag from the base model', () => {
    expect(getModelRoute('amazon.nova-lite-v1:0:300k')?.baseModel).toBe('nova-lite')
  })

  it('re-joins the vendor when the model segment does not name its brand', () => {
    // `deepseek.r1` alone would display as "r1 (Bedrock)" and miss the
    // `deepseek-r1` short name; the vendor is the brand here.
    expect(getModelRoute('deepseek.r1-v1:0')?.baseModel).toBe('deepseek-r1')
    expect(getModelRoute('deepseek.v3.2')?.baseModel).toBe('deepseek-v3.2')
    // Segments that already carry the brand are left alone, including when
    // the brand is the vendor's own name.
    expect(getModelRoute('minimax.minimax-m2.5')?.baseModel).toBe('minimax-m2.5')
    expect(getModelRoute('meta.llama3-1-70b-instruct-v1:0')?.baseModel).toBe('llama3-1-70b-instruct')
    expect(getModelRoute('moonshotai.kimi-k2.5')?.baseModel).toBe('kimi-k2.5')
    expect(getModelRoute('zai.glm-5')?.baseModel).toBe('glm-5')
  })

  it('unwraps the ARN and LiteLLM `bedrock/` spellings of the same id', () => {
    expect(getModelRoute('arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-fable-5-1')?.baseModel)
      .toBe('claude-fable-5-1')
    expect(getModelRoute('arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0')?.baseModel)
      .toBe('claude-3-5-sonnet-20241022')
    expect(getModelRoute('bedrock/anthropic.claude-fable-5-1')?.baseModel).toBe('claude-fable-5-1')
    expect(getModelRoute('bedrock/us-east-1/anthropic.claude-3-5-sonnet-20240620-v1:0')?.baseModel).toBe('claude-3-5-sonnet-20240620')
    expect(getModelRoute('bedrock/invoke/anthropic.claude-3-5-sonnet-20240620-v1:0')?.baseModel).toBe('claude-3-5-sonnet-20240620')
  })

  it('returns undefined for direct-API and other non-Bedrock ids', () => {
    for (const id of [
      // direct vendor ids
      'claude-fable-5-1', 'claude-sonnet-4-5-20250929', 'gpt-5.6-luna', 'gemini-2.5-pro', 'o3',
      // dotted version numbers, not vendor segments
      'gpt-4.1-mini', 'glm-4.7', 'MiniMax-M2.7', 'deepseek-v3.2', 'grok-4.6',
      // other routers / path ids keep their own handling
      'openrouter/anthropic/claude-sonnet-4.5', 'anthropic/claude-sonnet-4-5', 'accounts/fireworks/models/glm-5p2', 'kimi/k3[1m]',
      // Vertex `@` suffix, local tags, placeholder
      'claude-3-5-sonnet@20241022', 'qwen3.6:35b-a3b-bf16', 'gpt-oss:120b', '<synthetic>', '',
    ]) {
      expect(getModelRoute(id), id).toBeUndefined()
    }
  })

  it('does not treat an unknown dotted vendor as Bedrock', () => {
    expect(getModelRoute('acme.widget-v1:0')).toBeUndefined()
  })
})

describe('getShortModelName - route suffix', () => {
  it('appends the route to the base short name so Bedrock rows stay separate', () => {
    expect(getShortModelName('anthropic.claude-fable-5-1')).toBe('Fable 5.1 (Bedrock)')
    expect(getShortModelName('us.anthropic.claude-fable-5-1')).toBe('Fable 5.1 (Bedrock)')
    expect(getShortModelName('global.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe('Haiku 4.5 (Bedrock)')
    expect(getShortModelName('anthropic.claude-3-5-sonnet-20241022-v2:0')).toBe('Sonnet 3.5 (Bedrock)')
    expect(getShortModelName('openai.gpt-5.6-luna')).toBe('GPT-5.6 Luna (Bedrock)')
    expect(getShortModelName('deepseek.r1-v1:0')).toBe('DeepSeek R1 (Bedrock)')
    expect(getShortModelName('moonshotai.kimi-k2.5')).toBe('Kimi K2.5 (Bedrock)')
  })

  it('keeps the direct-API name unchanged, so the two routes never merge', () => {
    expect(getShortModelName('claude-fable-5-1')).toBe('Fable 5.1')
    expect(getShortModelName('gpt-5.6-luna')).toBe('GPT-5.6 Luna')
    expect(getShortModelName('anthropic.claude-fable-5-1')).not.toBe(getShortModelName('claude-fable-5-1'))
  })

  it('folds every Bedrock spelling of one model onto one row', () => {
    const spellings = [
      'anthropic.claude-fable-5-1',
      'us.anthropic.claude-fable-5-1',
      'global.anthropic.claude-fable-5-1',
      'bedrock/anthropic.claude-fable-5-1',
      'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-fable-5-1',
    ]
    expect(new Set(spellings.map(getShortModelName))).toEqual(new Set(['Fable 5.1 (Bedrock)']))
  })

  it('falls back to the base id when the base has no short name', () => {
    expect(getShortModelName('amazon.nova-pro-v1:0')).toBe('nova-pro (Bedrock)')
    expect(getShortModelName('meta.llama3-1-70b-instruct-v1:0')).toBe('llama3-1-70b-instruct (Bedrock)')
  })

  it('lets a user alias on the full Bedrock id win over the route', () => {
    setModelAliases({ 'anthropic.claude-fable-5-1': 'claude-fable-5-1' })
    expect(getShortModelName('anthropic.claude-fable-5-1')).toBe('Fable 5.1')
  })
})

describe('Bedrock ids - pricing and unpriced detection', () => {
  it('still prices off the full Bedrock id (the route is display-only)', () => {
    // Direct and Bedrock list rows share the base rate…
    expect(calculateCost('anthropic.claude-sonnet-4-5-20250929-v1:0', 1_000_000, 0, 0, 0, 0))
      .toBeCloseTo(calculateCost('claude-sonnet-4-5-20250929', 1_000_000, 0, 0, 0, 0), 6)
    // …while a cross-region profile keeps its own (uplifted) catalog row.
    expect(calculateCost('us.anthropic.claude-sonnet-4-5-20250929-v1:0', 1_000_000, 0, 0, 0, 0))
      .toBeGreaterThan(calculateCost('anthropic.claude-sonnet-4-5-20250929-v1:0', 1_000_000, 0, 0, 0, 0))
    expect(calculateCost('openai.gpt-5.6-luna', 1_000_000, 0, 0, 0, 0)).toBeGreaterThan(0)
  })

  it('does not mistake the `-v1:0` version for an Ollama tag', () => {
    // Before the route existed, `:` marked a Bedrock id as free local
    // inference and an unpriced one silently disappeared from Unpriced.
    expect(isExpectedFreeModel('anthropic.claude-haiku-4-5-20251001-v1:0')).toBe(false)
    expect(isExpectedFreeModel('acme.nonexistent-model-v9:0')).toBe(true) // not a Bedrock vendor: local-tag rule still applies
    const unpriced = findUnpricedModels([
      { model: 'anthropic.claude-nonexistent-99-v1:0', calls: 3, cost: 0, tokens: 1000 },
    ])
    expect(unpriced.map(u => u.model)).toEqual(['anthropic.claude-nonexistent-99-v1:0'])
  })
})

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('adds context tiers without repricing base rows or losing exact-key carry-forward (#1478)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codeburn-bundle-tiers-'))
  try {
    mkdirSync(join(dir, 'scripts'))
    mkdirSync(join(dir, 'src/data'), { recursive: true })
    copyFileSync(fileURLToPath(new URL('../scripts/bundle-litellm.mjs', import.meta.url)), join(dir, 'scripts/bundle-litellm.mjs'))
    const oldPrimary = { 'retired-model': [1e-6, 2e-6, null, null, null] }
    const oldFallback = {
      'grok-latest': [3e-6, 15e-6, null, null, null],
      'qwen3.5-plus': [1e-6, 3e-6, null, null, null],
    }
    writeFileSync(join(dir, 'src/data/litellm-snapshot.json'), JSON.stringify(oldPrimary))
    writeFileSync(join(dir, 'src/data/pricing-fallback.json'), JSON.stringify(oldFallback))
    const row = (input: number, output: number, extra = {}) => ({
      input_cost_per_token: input, output_cost_per_token: output, ...extra,
    })
    const source = {
      'grok-3': row(3e-6, 15e-6),
      'reseller/grok-3': row(1.25e-6, 2.5e-6, { cache_read_input_token_cost: 0.1e-6 }),
      'mistral-large-latest': row(8e-6, 24e-6),
      'reseller/mistral-large-latest': row(0.5e-6, 1.5e-6, { cache_read_input_token_cost: 0.05e-6 }),
      // The #1134 ordering bug: a reseller-prefixed row (`reseller/vendor/x`)
      // strips to the SAME key as an official prefixed row (`vendor/x`) that
      // appears later in the upstream JSON. The reseller row must never claim
      // that slot - the official row wins regardless of which came first.
      'reseller/vendor/x': row(1e-6, 2e-6),
      'vendor/x': row(2e-6, 4e-6),
      'gpt-5.6': row(4e-6, 20e-6, {
        input_cost_per_token_above_128k_tokens: 6e-6,
        output_cost_per_token_above_128k_tokens: 25e-6,
        cache_read_input_token_cost_above_128k_tokens: 0.6e-6,
        input_cost_per_token_above_272k_tokens: 8e-6,
        output_cost_per_token_above_272k_tokens: 30e-6,
        input_cost_per_token_above_272k_priority_tokens: 99e-6,
      }),
      'cache-model': row(1e-6, 2e-6),
      'vendor/cache-model': row(1e-6, 2e-6, { cache_read_input_token_cost: 0.1e-6 }),
      // A published cache rate is never overwritten: the vendor row is MORE
      // complete (adds cache-write, changes cache-read) but a fill must keep
      // every filled slot verbatim, so nothing swaps in.
      'cache-own': row(1e-6, 2e-6, { cache_read_input_token_cost: 0.2e-6 }),
      'vendor/cache-own': row(1e-6, 2e-6, {
        cache_creation_input_token_cost: 0.5e-6,
        cache_read_input_token_cost: 0.9e-6,
      }),
      // Negative and null tier values are filtered before the largest
      // threshold is chosen, so the broken 200k/300k tiers cannot shadow
      // the valid 128k one (whose cache slots still map).
      'tier-guard': row(1e-6, 2e-6, {
        input_cost_per_token_above_128k_tokens: 2e-6,
        output_cost_per_token_above_128k_tokens: 4e-6,
        cache_creation_input_token_cost_above_128k_tokens: 0.5e-6,
        cache_read_input_token_cost_above_128k_tokens: 0.05e-6,
        input_cost_per_token_above_200k_tokens: -1,
        output_cost_per_token_above_200k_tokens: -1,
        input_cost_per_token_above_300k_tokens: null,
        output_cost_per_token_above_300k_tokens: null,
      }),
      // A tier-bearing bare row must still gain a missing cache slot from a
      // prefixed row with identical base rates: the tier object (slot 5) is
      // rebuilt fresh per row, so any reference compare on it is always false
      // and would veto this fill.
      'direct-tier': row(5e-6, 25e-6, {
        input_cost_per_token_above_272k_tokens: 8e-6,
        output_cost_per_token_above_272k_tokens: 30e-6,
      }),
      'azure/direct-tier': row(5e-6, 25e-6, {
        input_cost_per_token_above_272k_tokens: 8e-6,
        output_cost_per_token_above_272k_tokens: 30e-6,
        cache_read_input_token_cost: 3e-6,
      }),
      // Among two prefixed aliases of an absent bare key, the base-richer row
      // wins even though the sparser one carries a tier: tier presence does
      // not count toward completeness, and the winner's tier (here, none)
      // travels with its own base rates.
      'ven/alias-model': row(2e-6, 6e-6, {
        cache_read_input_token_cost: 0.2e-6,
        input_cost_per_token_above_128k_tokens: 3e-6,
        output_cost_per_token_above_128k_tokens: 9e-6,
      }),
      'corp/alias-model': row(2e-6, 6e-6, {
        cache_read_input_token_cost: 0.2e-6,
        cache_creation_input_token_cost: 0.4e-6,
      }),
      // A prefix or date variant does not cover the old bare query.
      'gateway/x-ai/grok-latest': row(2e-6, 4e-6),
      'qwen/qwen3.5-plus-20260420': row(2e-6, 4e-6),
    }
    writeFileSync(join(dir, 'source.json'), JSON.stringify(source))
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { readFileSync } from 'node:fs';
      const source = JSON.parse(readFileSync('source.json', 'utf8'));
      globalThis.fetch = async (url) => ({ ok: true, json: async () =>
        url.includes('raw.githubusercontent.com') ? source : url.includes('models.dev') ? {} : { data: [] }
      });
      await import('./scripts/bundle-litellm.mjs');
    `], { cwd: dir, encoding: 'utf8', timeout: 10_000 })
    expect(run.status, run.stderr).toBe(0)
    const snapshot = JSON.parse(readFileSync(join(dir, 'src/data/litellm-snapshot.json'), 'utf8'))
    const fallback = JSON.parse(readFileSync(join(dir, 'src/data/pricing-fallback.json'), 'utf8'))
    // The prefixed richer rows keep their own keys and never re-price the
    // bare entries - not even by leaking a cache slot into them.
    expect(snapshot['grok-3']).toEqual([3e-6, 15e-6, null, null, null, null])
    expect(snapshot['mistral-large-latest']).toEqual([8e-6, 24e-6, null, null, null, null])
    expect(snapshot['reseller/grok-3']).toEqual([1.25e-6, 2.5e-6, null, 0.1e-6, null, null])
    // #1134: a reseller-prefixed row appearing before the official prefixed
    // row must not shadow it - the official rate wins regardless of order.
    expect(snapshot['vendor/x']).toEqual([2e-6, 4e-6, null, null, null, null])
    expect(snapshot['gateway/x-ai/grok-latest']).toEqual([2e-6, 4e-6, null, null, null, null])
    expect(snapshot['qwen/qwen3.5-plus-20260420']).toEqual([2e-6, 4e-6, null, null, null, null])
    // Fill adds a missing cache slot; it never overwrites a published one.
    expect(snapshot['cache-model']).toEqual([1e-6, 2e-6, null, 0.1e-6, null, null])
    expect(snapshot['cache-own']).toEqual([1e-6, 2e-6, null, 0.2e-6, null, null])
    expect(snapshot['gpt-5.6']).toEqual([4e-6, 20e-6, null, null, null, {
      threshold: 272_000, input: 8e-6, output: 30e-6, cacheWrite: null, cacheRead: null,
    }])
    // Invalid tiers are filtered before the max, so the valid 128k tier wins.
    expect(snapshot['tier-guard']).toEqual([1e-6, 2e-6, null, null, null, {
      threshold: 128_000, input: 2e-6, output: 4e-6, cacheWrite: 0.5e-6, cacheRead: 0.05e-6,
    }])
    // The bare tiered row keeps its tier and gains the prefixed row's
    // cache-read slot (a structural tier compare would also hold here, but the
    // guard must not depend on reference equality of slot 5).
    expect(snapshot['direct-tier']).toEqual([5e-6, 25e-6, null, 3e-6, null, {
      threshold: 272_000, input: 8e-6, output: 30e-6, cacheWrite: null, cacheRead: null,
    }])
    // The base-richer alias (cache-write + cache-read, no tier) wins over the
    // tier-bearing one; no tier is spliced onto its base rates.
    expect(snapshot['alias-model']).toEqual([2e-6, 6e-6, 0.4e-6, 0.2e-6, null, null])
    // Exact-key-only carry: the prefixed and dated variants did not count as
    // coverage, so the old rows stay; a dropped primary row stays primary.
    expect(snapshot['retired-model']).toEqual(oldPrimary['retired-model'])
    expect(fallback).toEqual(oldFallback)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// #1616: Codex's Fast speed setting bills through OpenAI's priority tier, whose
// rates LiteLLM publishes as `<rate>_priority` keys. Slot 5 (the fast
// multiplier) derives from those when the row carries no
// `provider_specific_entry.fast`, so the next routine snapshot refresh carries
// the multiplier offline. Mirrors the live-path assertions in models.test.ts.
it('derives the fast multiplier from priority rates without inventing one (#1616)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codeburn-bundle-priority-'))
  try {
    mkdirSync(join(dir, 'scripts'))
    mkdirSync(join(dir, 'src/data'), { recursive: true })
    copyFileSync(fileURLToPath(new URL('../scripts/bundle-litellm.mjs', import.meta.url)), join(dir, 'scripts/bundle-litellm.mjs'))
    writeFileSync(join(dir, 'src/data/litellm-snapshot.json'), '{}')
    writeFileSync(join(dir, 'src/data/pricing-fallback.json'), '{}')
    const row = (input: number, output: number, extra = {}) => ({
      input_cost_per_token: input, output_cost_per_token: output, ...extra,
    })
    const source = {
      // gpt-5.4 as quoted live: 2x on input, output and cache read.
      'gpt-5.4': row(2.5e-6, 15e-6, {
        cache_read_input_token_cost: 2.5e-7,
        input_cost_per_token_priority: 5e-6,
        output_cost_per_token_priority: 30e-6,
        cache_read_input_token_cost_priority: 5e-7,
      }),
      // gpt-5.5 as quoted live: 2.5x on every published bucket.
      'gpt-5.5': row(5e-6, 30e-6, {
        cache_read_input_token_cost: 5e-7,
        input_cost_per_token_priority: 1.25e-5,
        output_cost_per_token_priority: 7.5e-5,
        cache_read_input_token_cost_priority: 1.25e-6,
      }),
      // A tier without priority keys: OpenAI quotes no Fast long-context price.
      'gpt-5.5-tiered': row(5e-6, 30e-6, {
        input_cost_per_token_above_272k_tokens: 1e-5,
        output_cost_per_token_above_272k_tokens: 4.5e-5,
        input_cost_per_token_priority: 1.25e-5,
        output_cost_per_token_priority: 7.5e-5,
      }),
      // A tier with agreeing priority keys inherits the base multiplier.
      'gpt-5.6-tiered': row(4e-6, 20e-6, {
        input_cost_per_token_above_272k_tokens: 8e-6,
        output_cost_per_token_above_272k_tokens: 3e-5,
        input_cost_per_token_priority: 8e-6,
        output_cost_per_token_priority: 4e-5,
        input_cost_per_token_above_272k_tokens_priority: 1.6e-5,
        output_cost_per_token_above_272k_tokens_priority: 6e-5,
      }),
      // Division noise (1.7999999999999998) is rounded away.
      'gemini-2.5-pro': row(1.25e-6, 1e-5, {
        input_cost_per_token_priority: 2.25e-6,
        output_cost_per_token_priority: 1.8e-5,
      }),
      // No priority keys at all: stays 1x (null slot).
      'gpt-5-codex': row(1.25e-6, 1e-5, { cache_read_input_token_cost: 1.25e-7 }),
      // azure/gpt-5.5 as quoted live: 2.5x base but 2x above 272k, so no single
      // multiplier prices both regimes and none is guessed.
      'azure/gpt-5.5': row(5e-6, 30e-6, {
        cache_read_input_token_cost: 5e-7,
        cache_read_input_token_cost_above_272k_tokens: 1e-6,
        input_cost_per_token_priority: 1.25e-5,
        output_cost_per_token_priority: 7.5e-5,
        cache_read_input_token_cost_priority: 1.25e-6,
        input_cost_per_token_above_272k_tokens_priority: 2e-5,
        output_cost_per_token_above_272k_tokens_priority: 6e-5,
        cache_read_input_token_cost_above_272k_tokens_priority: 2e-6,
      }),
      // Anthropic's explicit multiplier wins even when priority keys exist.
      'claude-opus-4-8': row(5e-6, 25e-6, {
        input_cost_per_token_priority: 1e-5,
        output_cost_per_token_priority: 5e-5,
        provider_specific_entry: { fast: 1.4 },
      }),
    }
    writeFileSync(join(dir, 'source.json'), JSON.stringify(source))
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { readFileSync } from 'node:fs';
      const source = JSON.parse(readFileSync('source.json', 'utf8'));
      globalThis.fetch = async (url) => ({ ok: true, json: async () =>
        url.includes('raw.githubusercontent.com') ? source : url.includes('models.dev') ? {} : { data: [] }
      });
      await import('./scripts/bundle-litellm.mjs');
    `], { cwd: dir, encoding: 'utf8', timeout: 10_000 })
    expect(run.status, run.stderr).toBe(0)
    const snapshot = JSON.parse(readFileSync(join(dir, 'src/data/litellm-snapshot.json'), 'utf8'))
    expect(snapshot['gpt-5.4']![4]).toBe(2)
    expect(snapshot['gpt-5.5']![4]).toBe(2.5)
    expect(snapshot['gpt-5.5-tiered']![4]).toBe(2.5)
    expect(snapshot['gpt-5.5-tiered']![5].fast).toBe(1)
    expect(snapshot['gpt-5.6-tiered']![4]).toBe(2)
    expect(snapshot['gpt-5.6-tiered']![5]).not.toHaveProperty('fast')
    expect(snapshot['gemini-2.5-pro']![4]).toBe(1.8)
    expect(snapshot['gpt-5-codex']![4]).toBeNull()
    expect(snapshot['azure/gpt-5.5']![4]).toBeNull()
    expect(snapshot['claude-opus-4-8']![4]).toBe(1.4)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('gives a bare id the maker\'s price over a reseller\'s, and a priced reseller row over a $0 one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codeburn-bundle-maker-'))
  try {
    mkdirSync(join(dir, 'scripts'))
    mkdirSync(join(dir, 'src/data'), { recursive: true })
    copyFileSync(fileURLToPath(new URL('../scripts/bundle-litellm.mjs', import.meta.url)), join(dir, 'scripts/bundle-litellm.mjs'))
    writeFileSync(join(dir, 'src/data/litellm-snapshot.json'), '{}')
    writeFileSync(join(dir, 'src/data/pricing-fallback.json'), '{}')
    const row = (input: number, output: number) => ({ input_cost_per_token: input, output_cost_per_token: output })
    const source = {
      'azure_ai/grok-x': row(1.25e-6, 6e-6),
      'xai/grok-x': row(2e-6, 6e-6),
      'xai/grok-y': row(2e-6, 6e-6),
      'azure_ai/grok-y': row(1.25e-6, 6e-6),
      'codestral/codestral-x': row(0, 0),
      'mistral/codestral-x': row(0.3e-6, 0.9e-6),
      'ollama/free-only': row(0, 0),
      'deepinfra/gemma-free': row(0.15e-6, 0.6e-6),
      'gemini/gemma-free': row(0, 0),
      'azure_ai/resold': row(1e-6, 3e-6),
      'fireworks_ai/resold': row(2e-6, 4e-6),
      'openrouter/openai/sol': row(2e-6, 10e-6),
      'perplexity/openai/sol': row(4e-6, 20e-6),
    }
    writeFileSync(join(dir, 'source.json'), JSON.stringify(source))
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { readFileSync } from 'node:fs';
      const source = JSON.parse(readFileSync('source.json', 'utf8'));
      globalThis.fetch = async (url) => ({ ok: true, json: async () =>
        url.includes('raw.githubusercontent.com') ? source : url.includes('models.dev') ? {} : { data: [] }
      });
      await import('./scripts/bundle-litellm.mjs');
    `], { cwd: dir, encoding: 'utf8', timeout: 10_000 })
    expect(run.status, run.stderr).toBe(0)
    const snapshot = JSON.parse(readFileSync(join(dir, 'src/data/litellm-snapshot.json'), 'utf8'))
    expect(snapshot['grok-x']).toEqual([2e-6, 6e-6, null, null, null, null])
    expect(snapshot['grok-y']).toEqual([2e-6, 6e-6, null, null, null, null])
    expect(snapshot['azure_ai/grok-x']).toEqual([1.25e-6, 6e-6, null, null, null, null])
    expect(snapshot['codestral-x']).toEqual([0.3e-6, 0.9e-6, null, null, null, null])
    expect(snapshot['free-only']).toEqual([0, 0, null, null, null, null])
    // The maker's own $0 is a real price (Gemma is free on Google's API).
    expect(snapshot['gemma-free']).toEqual([0, 0, null, null, null, null])
    expect(snapshot['resold']).toEqual([1e-6, 3e-6, null, null, null, null])
    // A maker prefix in front of another vendor's path is a reseller row.
    expect(snapshot['openai/sol']).toEqual([2e-6, 10e-6, null, null, null, null])
    // The bare key keeps the position its first claimant gave it.
    expect(Object.keys(snapshot).indexOf('grok-x')).toBe(Object.keys(snapshot).indexOf('azure_ai/grok-x') + 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

type Row = (number | null | object)[]
const next = (run: { snapshot: Record<string, Row>, fallback: Record<string, Row>, meta: object }): Previous => ({ primary: run.snapshot, fallback: run.fallback, meta: run.meta })
const rate = (input: number, output: number, extra = {}) => ({ input_cost_per_token: input, output_cost_per_token: output, ...extra })

type Previous = { primary?: Record<string, Row>, fallback?: Record<string, Row>, meta?: object }
function bundle(source: object, previous: Previous = {}, modelsDev: object = {}, openrouter: object[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'codeburn-bundle-rules-'))
  try {
    mkdirSync(join(dir, 'scripts'))
    mkdirSync(join(dir, 'src/data'), { recursive: true })
    copyFileSync(fileURLToPath(new URL('../scripts/bundle-litellm.mjs', import.meta.url)), join(dir, 'scripts/bundle-litellm.mjs'))
    writeFileSync(join(dir, 'src/data/litellm-snapshot.json'), JSON.stringify(previous.primary ?? {}))
    writeFileSync(join(dir, 'src/data/pricing-fallback.json'), JSON.stringify(previous.fallback ?? {}))
    if (previous.meta) writeFileSync(join(dir, 'src/data/litellm-snapshot.meta.json'), JSON.stringify(previous.meta))
    writeFileSync(join(dir, 'sources.json'), JSON.stringify({ source, modelsDev, openrouter }))
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { readFileSync } from 'node:fs';
      const { source, modelsDev, openrouter } = JSON.parse(readFileSync('sources.json', 'utf8'));
      globalThis.fetch = async (url) => ({ ok: true, json: async () =>
        url.includes('raw.githubusercontent.com') ? source : url.includes('models.dev') ? modelsDev : { data: openrouter }
      });
      await import('./scripts/bundle-litellm.mjs');
    `], { cwd: dir, encoding: 'utf8', timeout: 10_000 })
    expect(run.status, run.stderr).toBe(0)
    const read = (f: string) => JSON.parse(readFileSync(join(dir, 'src/data', f), 'utf8'))
    return { snapshot: read('litellm-snapshot.json'), fallback: read('pricing-fallback.json'), meta: read('litellm-snapshot.meta.json') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

it('keeps a primary row upstream dropped in the primary snapshot, not the fallback', () => {
  const primary: Record<string, Row> = {
    'mistral': [0, 0, null, null, null, null],
    'mistral-large': [4e-6, 12e-6, null, null, null, null],
    'z-ai/glm-x': [0.2e-6, 1e-6, null, null, null, null],
  }
  const { snapshot, fallback, meta } = bundle({ 'ollama/mistral': rate(0, 0) }, { primary })
  expect(snapshot['mistral-large']).toEqual(primary['mistral-large'])
  expect(snapshot['z-ai/glm-x']).toEqual(primary['z-ai/glm-x'])
  expect(fallback).toEqual({})
  expect(meta.carried).toEqual(['mistral-large', 'z-ai/glm-x'])
})

it('leaves router ids out of the gap-fill', () => {
  const modelsDev = {
    morph: { models: {
      auto: { family: 'auto', cost: { input: 0.85, output: 1.55 } },
      'morph-v4': { family: 'morph', cost: { input: 0.9, output: 1.9 } },
    } },
  }
  const openrouter = [
    { id: 'openrouter/fusion', architecture: { tokenizer: 'Other' }, pricing: { prompt: '0.000001', completion: '0.000002' } },
    { id: '~acme/acme-latest', architecture: { tokenizer: 'Router' }, pricing: { prompt: '0.000001', completion: '0.000002' } },
    { id: 'acme/acme-2', architecture: { tokenizer: 'Other' }, pricing: { prompt: '0.000001', completion: '0.000002' } },
  ]
  const { fallback } = bundle({}, {}, modelsDev, openrouter)
  expect(Object.keys(fallback).sort()).toEqual(['acme-2', 'morph-v4'])
})

it('prices a reseller\'s namespaced key at the maker\'s row and holds a reseller-only key only while a reseller still quotes it', () => {
  const source = {
    'perplexity/openai/gpt-x': rate(3.5e-6, 28e-6),
    'gpt-x': rate(1.75e-6, 14e-6, { litellm_provider: 'openai' }),
    'azure/eu/gpt-x': rate(1.925e-6, 15.4e-6),
    'inferenceapis/MiniMaxAI/mm-3': rate(0.39e-6, 1.56e-6),
    'together_ai/MiniMaxAI/mm-3': rate(0.3e-6, 1.2e-6),
    'minimax/mm-3': rate(0.3e-6, 1.2e-6),
    'coralbricks/flash-x': rate(0.01e-6, 1.2e-6),
    'newco/quoted-x': rate(5e-6, 6e-6),
    'oldco/quoted-x': rate(1e-6, 2e-6),
    'midco/quoted-x': rate(4e-6, 5e-6),
    'acme/repriced-x': rate(1.5e-6, 2e-6),
    'newco/fresh-x': rate(1e-6, 2e-6),
    'moonshot/kimi-x': rate(0.95e-6, 4e-6, { cache_read_input_token_cost: 0.19e-6 }),
    'tencent/kimi-x': rate(0.95e-6, 4e-6, { cache_creation_input_token_cost: 0, cache_read_input_token_cost: 0.19e-6 }),
  }
  const primary: Record<string, Row> = {
    'kimi-x': [0.95e-6, 4e-6, null, 0.19e-6, null, null],
    'openai/gpt-x': [2e-6, 10e-6, null, null, null, null],
    'flash-x': [0.3e-6, 1.2e-6, null, 0.006e-6, null, null],
    'gone/flash-x': [0.3e-6, 1.2e-6, null, 0.006e-6, null, null],
    'quoted-x': [1e-6, 2e-6, null, null, null, null],
    'repriced-x': [1e-6, 2e-6, null, null, null, null],
    'acme/repriced-x': [1e-6, 2e-6, null, null, null, null],
  }
  const { snapshot, meta } = bundle(source, { primary })
  expect(snapshot['openai/gpt-x']).toEqual([1.75e-6, 14e-6, null, null, null, null])
  expect(snapshot['eu/gpt-x']).toEqual([1.925e-6, 15.4e-6, null, null, null, null])
  expect(snapshot['MiniMaxAI/mm-3']).toEqual([0.3e-6, 1.2e-6, null, null, null, null])
  // Its source row was dropped and the remaining quote moved: it moves.
  expect(snapshot['flash-x']).toEqual([0.01e-6, 1.2e-6, null, null, null, null])
  // Another reseller still quotes the previous value: held.
  expect(snapshot['quoted-x']).toEqual(primary['quoted-x'])
  // The row it came from repriced: it moves.
  expect(snapshot['repriced-x']).toEqual([1.5e-6, 2e-6, null, null, null, null])
  expect(snapshot['fresh-x']).toEqual([1e-6, 2e-6, null, null, null, null])
  // A reseller row added since does not top up a slot the id never had.
  expect(snapshot['kimi-x']).toEqual(primary['kimi-x'])
  expect(Object.keys(meta.held)).toEqual(['quoted-x'])
})

it('keeps the previous long-context tier when upstream drops it from a row whose base rates did not change', () => {
  const tier = { threshold: 200_000, input: 6e-6, output: 22.5e-6, cacheWrite: 7.5e-6, cacheRead: 0.6e-6 }
  const primary: Record<string, Row> = {
    'sonnet-x': [3e-6, 15e-6, 3.75e-6, 0.3e-6, null, tier],
    'retiered': [1e-6, 2e-6, null, null, null, tier],
    'repriced': [3e-6, 15e-6, null, null, null, tier],
  }
  const { snapshot, meta } = bundle({
    'sonnet-x': rate(3e-6, 15e-6, { cache_creation_input_token_cost: 3.75e-6, cache_read_input_token_cost: 0.3e-6 }),
    'retiered': rate(1e-6, 2e-6, { input_cost_per_token_above_128k_tokens: 2e-6, output_cost_per_token_above_128k_tokens: 4e-6 }),
    'repriced': rate(2e-6, 10e-6),
  }, { primary })
  // Upstream re-priced the row, so its shape is upstream's: no tier.
  expect(snapshot['repriced']).toEqual([2e-6, 10e-6, null, null, null, null])
  expect(snapshot['sonnet-x']).toEqual(primary['sonnet-x'])
  expect(snapshot['retiered'][5]).toEqual({ threshold: 128_000, input: 2e-6, output: 4e-6, cacheWrite: null, cacheRead: null })
  expect(Object.keys(meta.keptTiers)).toEqual(['sonnet-x'])
})

it('keeps the previous value only when the maker row is more than 2x above the resellers quoting the same model', () => {
  const source = {
    'mistral/medium-x': rate(1.5e-6, 7.5e-6),
    'vertex_ai/mistralai/medium-x': rate(0.4e-6, 2e-6),
    'nscale/mistralai/medium-x': rate(0.42e-6, 2.1e-6),
    'mistral/small-x': rate(0.1e-6, 0.3e-6),
    'vertex_ai/mistralai/small-x': rate(0.12e-6, 0.36e-6),
    'deepseek/cheap-x': rate(0.27e-6, 1.1e-6),
    'replicate/deepseek-ai/cheap-x': rate(1.45e-6, 1.45e-6),
  }
  const primary: Record<string, Row> = {
    'mistralai/medium-x': [0.4e-6, 2e-6, null, null, null, null],
    'mistralai/small-x': [0.12e-6, 0.36e-6, null, null, null, null],
    'deepseek-ai/cheap-x': [1.45e-6, 1.45e-6, null, null, null, null],
  }
  const { snapshot, meta } = bundle(source, { primary })
  // A maker row below the resale quote is the maker's own price.
  expect(snapshot['deepseek-ai/cheap-x']).toEqual([0.27e-6, 1.1e-6, null, null, null, null])
  expect(snapshot['mistralai/medium-x']).toEqual(primary['mistralai/medium-x'])
  expect(snapshot['mistralai/small-x']).toEqual([0.1e-6, 0.3e-6, null, null, null, null])
  expect(Object.keys(meta.outliers)).toEqual(['mistralai/medium-x'])
})

it('treats a rate that turns exactly $0 on a priced row as missing', () => {
  const primary: Record<string, Row> = {
    'deep-x': [0.27e-6, 1.1e-6, null, 0.07e-6, null, null],
    'free-write': [1e-6, 2e-6, 0, 0.1e-6, null, null],
    'repriced-zero': [0.27e-6, 1.1e-6, null, 0.07e-6, null, null],
  }
  const { snapshot, meta } = bundle({
    'repriced-zero': rate(0.28e-6, 1.1e-6, { cache_creation_input_token_cost: 0, cache_read_input_token_cost: 0.07e-6 }),
    'deep-x': rate(0.27e-6, 1.1e-6, { cache_creation_input_token_cost: 0, cache_read_input_token_cost: 0.07e-6 }),
    'free-write': rate(1e-6, 2e-6, { cache_creation_input_token_cost: 0, cache_read_input_token_cost: 0.1e-6 }),
  }, { primary })
  expect(snapshot['deep-x']).toEqual(primary['deep-x'])
  expect(snapshot['free-write']).toEqual(primary['free-write'])
  // The row's input moved too, so the $0 is upstream's new shape.
  expect(snapshot['repriced-zero']).toEqual([0.28e-6, 1.1e-6, 0, 0.07e-6, null, null])
  expect(Object.keys(meta.zeroSlots)).toEqual(['deep-x'])
})

it('never carries a router id forward, but keeps a version pointer users already price', () => {
  const primary: Record<string, Row> = {
    'openrouter/auto': [0, 0, null, null, null, null],
    'openrouter/openrouter/auto': [0, 0, null, null, null, null],
    'openrouter/typesafe/jev-router': [0, 0, null, null, null, null],
    'openrouter/~acme/acme-latest': [1e-6, 2e-6, null, null, null, null],
    'openrouter/acme/acme-2': [1e-6, 2e-6, null, null, null, null],
  }
  const openrouter = [
    { id: 'openrouter/auto', architecture: { tokenizer: 'Router' }, pricing: { prompt: '-1', completion: '-1' } },
    { id: 'typesafe/jev-router', architecture: { tokenizer: 'Router' }, pricing: { prompt: '-1', completion: '-1' } },
    { id: '~acme/acme-latest', architecture: { tokenizer: 'Router' }, pricing: { prompt: '0.000001', completion: '0.000002' } },
  ]
  const { snapshot, meta } = bundle({}, { primary }, {}, openrouter)
  expect(snapshot['openrouter/acme/acme-2']).toEqual(primary['openrouter/acme/acme-2'])
  expect(snapshot['openrouter/~acme/acme-latest']).toEqual(primary['openrouter/~acme/acme-latest'])
  for (const k of ['openrouter/auto', 'openrouter/openrouter/auto', 'openrouter/typesafe/jev-router']) expect(snapshot).not.toHaveProperty([k])
  expect(meta.droppedRouters).toEqual(['openrouter/auto', 'openrouter/openrouter/auto', 'openrouter/typesafe/jev-router'])
})

it('lets a hold last one refresh: the next refresh with the same stale inputs takes the upstream value', () => {
  const source = {
    // (c): the previous value is still quoted by a stale reseller row.
    'newco/quoted-x': rate(5e-6, 6e-6),
    'oldco/quoted-x': rate(1e-6, 2e-6),
    'midco/quoted-x': rate(4e-6, 5e-6),
    // (e): the maker row is more than 2x above the only reseller quote.
    'mistral/medium-x': rate(1.5e-6, 7.5e-6),
    'vertex_ai/mistralai/medium-x': rate(0.4e-6, 2e-6),
  }
  const primary: Record<string, Row> = {
    'quoted-x': [1e-6, 2e-6, null, null, null, null],
    'mistralai/medium-x': [0.4e-6, 2e-6, null, null, null, null],
  }
  const first = bundle(source, { primary })
  expect(first.snapshot['quoted-x']).toEqual(primary['quoted-x'])
  expect(first.snapshot['mistralai/medium-x']).toEqual(primary['mistralai/medium-x'])
  expect(Object.keys(first.meta.held)).toEqual(['quoted-x'])
  expect(Object.keys(first.meta.outliers)).toEqual(['mistralai/medium-x'])
  expect(first.meta.held['quoted-x']).toMatch(/^\d{4}-\d{2}-\d{2}$/)

  const second = bundle(source, next(first))
  // On expiry the key takes the median of the current quotes (5, 1 and 4 -> 4).
  expect(second.snapshot['quoted-x']).toEqual([4e-6, 5e-6, null, null, null, null])
  expect(second.snapshot['mistralai/medium-x']).toEqual([1.5e-6, 7.5e-6, null, null, null, null])
  expect(second.meta.held).toEqual({})
  expect(second.meta.outliers).toEqual({})
  expect(second.meta.expired.sort()).toEqual(['mistralai/medium-x', 'quoted-x'])

  // A third refresh does not re-arm: the released value is now the previous one.
  const third = bundle(source, next(second))
  expect(third.snapshot['quoted-x']).toEqual(second.snapshot['quoted-x'])
  expect(third.meta.held).toEqual({})
})

it('releases a hold at once when the stale quote disappears', () => {
  const primary: Record<string, Row> = {
    'quoted-x': [1e-6, 2e-6, null, null, null, null],
    'mistralai/medium-x': [0.4e-6, 2e-6, null, null, null, null],
  }
  const first = bundle({
    'newco/quoted-x': rate(5e-6, 6e-6),
    'oldco/quoted-x': rate(1e-6, 2e-6),
    'midco/quoted-x': rate(4e-6, 5e-6),
    'mistral/medium-x': rate(1.5e-6, 7.5e-6),
    'vertex_ai/mistralai/medium-x': rate(0.4e-6, 2e-6),
  }, { primary })
  expect(Object.keys(first.meta.held)).toEqual(['quoted-x'])
  // The stale reseller quotes are gone; the one left agrees with the maker.
  const second = bundle({
    'newco/quoted-x': rate(5e-6, 6e-6),
    'midco/quoted-x': rate(4e-6, 5e-6),
    'mistral/medium-x': rate(1.5e-6, 7.5e-6),
    'vertex_ai/mistralai/medium-x': rate(1.4e-6, 7e-6),
  }, next(first))
  // Two quotes left: the lower middle one.
  expect(second.snapshot['quoted-x']).toEqual([4e-6, 5e-6, null, null, null, null])
  expect(second.snapshot['mistralai/medium-x']).toEqual([1.5e-6, 7.5e-6, null, null, null, null])
  expect(second.meta.held).toEqual({})
  expect(second.meta.outliers).toEqual({})
  expect(second.meta.expired).toEqual([])
})

it('lets a kept tier and a restored $0 slot last one refresh', () => {
  const tier = { threshold: 200_000, input: 6e-6, output: 22.5e-6, cacheWrite: 7.5e-6, cacheRead: 0.6e-6 }
  const primary: Record<string, Row> = {
    'sonnet-x': [3e-6, 15e-6, 3.75e-6, 0.3e-6, null, tier],
    'deep-x': [0.27e-6, 1.1e-6, null, 0.07e-6, null, null],
  }
  const source = {
    'sonnet-x': rate(3e-6, 15e-6, { cache_creation_input_token_cost: 3.75e-6, cache_read_input_token_cost: 0.3e-6 }),
    'deep-x': rate(0.27e-6, 1.1e-6, { cache_creation_input_token_cost: 0, cache_read_input_token_cost: 0.07e-6 }),
  }
  const first = bundle(source, { primary })
  expect(first.snapshot['sonnet-x']).toEqual(primary['sonnet-x'])
  expect(first.snapshot['deep-x']).toEqual(primary['deep-x'])
  expect(Object.keys(first.meta.keptTiers)).toEqual(['sonnet-x'])
  expect(Object.keys(first.meta.zeroSlots)).toEqual(['deep-x'])
  const second = bundle(source, next(first))
  expect(second.snapshot['sonnet-x']).toEqual([3e-6, 15e-6, 3.75e-6, 0.3e-6, null, null])
  expect(second.snapshot['deep-x']).toEqual([0.27e-6, 1.1e-6, 0, 0.07e-6, null, null])
  expect(second.meta.keptTiers).toEqual({})
  expect(second.meta.zeroSlots).toEqual({})
  expect(second.meta.expired.sort()).toEqual(['deep-x', 'sonnet-x'])
})

it('prices a reseller-only key at the median quote, whatever the upstream order', () => {
  const quotes: [string, number, number][] = [['aco', 3e-6, 4e-6], ['bco', 1e-6, 2e-6], ['cco', 2e-6, 3e-6], ['dco', 0, 0]]
  const build = (order: typeof quotes) => Object.fromEntries(order.flatMap(([p, i, o]) => [[`${p}/odd-x`, rate(i, o)], [`${p}/even-x`, rate(i * 2, o * 2)]])
    .concat([['eco/even-x', rate(8e-6, 9e-6)]]))
  const forward = bundle(build(quotes)).snapshot
  const reversed = bundle(build([...quotes].reverse())).snapshot
  // Three priced quotes (the $0 one is skipped): 1, 2, 3 -> 2.
  expect(forward['odd-x']).toEqual([2e-6, 3e-6, null, null, null, null])
  // Four priced quotes: 2, 4, 6, 8 -> the lower middle, 4.
  expect(forward['even-x']).toEqual([4e-6, 6e-6, null, null, null, null])
  expect(reversed['odd-x']).toEqual(forward['odd-x'])
  expect(reversed['even-x']).toEqual(forward['even-x'])
})

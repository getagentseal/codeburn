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
    // Exact-key-only carry: the fallback is exactly the previously-priced
    // rows - the prefixed and dated variants did not count as their coverage.
    expect(fallback).toEqual({ ...oldPrimary, ...oldFallback })
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

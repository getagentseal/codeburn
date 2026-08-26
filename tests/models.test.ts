import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, it, expect, beforeAll, afterEach } from 'vitest'

import {
  findUnpricedModels,
  getModelCosts,
  getShortModelName,
  resolveCanonicalModelId,
  calculateCost,
  CACHE_SCHEMA_VERSION,
  loadPricing,
  setModelAliases,
  setPriceOverrides,
  setLocalModelSavings,
  setFlatRateModels,
  setFlatRateRemoved,
  isExpectedFreeModel,
  isFlatRateModel,
  getLocalModelSavingsConfigHash,
  getPriceOverridesConfigHash,
  getModelAliasesConfigHash,
  getFlatRateModelsConfigHash,
  parseLiteLLMEntry,
  unpricedModelHint,
} from '../src/models.js'
import { getDailyCacheConfigHash } from '../src/usage-aggregator.js'
import snapshotData from '../src/data/litellm-snapshot.json' with { type: 'json' }

beforeAll(async () => {
  await loadPricing()
})

afterEach(() => {
  setModelAliases({})
  setPriceOverrides({})
  setLocalModelSavings({})
  setFlatRateModels([])
  setFlatRateRemoved([])
})

describe('getModelCosts', () => {
  it('does not match short canonical against longer pricing key', () => {
    const costs = getModelCosts('gpt-4')
    if (costs) {
      expect(costs.inputCostPerToken).not.toBe(2.5e-6)
    }
  })

  it('returns correct pricing for gpt-4o vs gpt-4o-mini', () => {
    const mini = getModelCosts('gpt-4o-mini')
    const full = getModelCosts('gpt-4o')
    expect(mini).not.toBeNull()
    expect(full).not.toBeNull()
    expect(mini!.inputCostPerToken).toBeLessThan(full!.inputCostPerToken)
  })

  it('returns fallback pricing for known Claude models', () => {
    const costs = getModelCosts('claude-opus-4-6-20260205')
    expect(costs).not.toBeNull()
    expect(costs!.inputCostPerToken).toBe(5e-6)
  })

  it('prices lowercase glm-5.2 (Hermes spelling) the same as capitalized GLM-5.2', () => {
    const lower = getModelCosts('glm-5.2')
    const upper = getModelCosts('GLM-5.2')
    expect(lower).not.toBeNull()
    expect(upper).not.toBeNull()
    expect(lower!.inputCostPerToken).toBe(upper!.inputCostPerToken)
    expect(lower!.outputCostPerToken).toBe(upper!.outputCostPerToken)
  })

  it('prices glm-5.3 (Hermes / Cline spelling) instead of leaving it unpriced', () => {
    const lower = getModelCosts('glm-5.3')
    const upper = getModelCosts('GLM-5.3')
    const sibling = getModelCosts('glm-5p2')
    expect(lower).not.toBeNull()
    expect(upper).not.toBeNull()
    expect(sibling).not.toBeNull()
    expect(lower!.inputCostPerToken).toBe(sibling!.inputCostPerToken)
    expect(upper!.outputCostPerToken).toBe(sibling!.outputCostPerToken)
    expect(getModelCosts('cp/cline-pass/glm-5.3')!.inputCostPerToken).toBe(sibling!.inputCostPerToken)
    expect(getModelCosts('omniroute:cp/cline-pass/glm-5.3')!.inputCostPerToken).toBe(sibling!.inputCostPerToken)
    expect(getModelCosts('cmd/deepseek/deepseek-v4-flash')).not.toBeNull()
    expect(getModelCosts('provider/org/glm-5.3')).toBeNull()
    expect(getModelCosts('provider/glm-5.3')).toBeNull()
    expect(getModelCosts('cp/provider/glm-5.3')).toBeNull()
    expect(getModelCosts('omniroute:provider/glm-5.3')).toBeNull()
    expect(getModelCosts('unknown/deepseek-v4-flash')).toBeNull()
    expect(getModelCosts('z-ai/glm-5.2')).not.toBeNull()
    expect(getModelCosts('z-ai/glm-5.3')!.inputCostPerToken).toBe(sibling!.inputCostPerToken)
  })

  it('prices gpt-5.6-codex and gpt-5.6-codex-max, sourced directly from the snapshot (#1077)', () => {
    // Directly checks the bundled snapshot data (not just the resolved lookup),
    // so this fails if the litellm-snapshot.json entries are ever reverted even
    // though getModelCosts would still resolve both ids via the `gpt-5.6` prefix
    // fallback - explicit rows are still correct and match every other Codex
    // generation LiteLLM ships (gpt-5-codex, gpt-5.1-codex, gpt-5.1-codex-max,
    // gpt-5.2-codex, gpt-5.3-codex all carry their base model's exact rate).
    const snapshot = snapshotData as Record<string, unknown>
    // 2026-08-24: OpenAI cut the gpt-5.6 base rate ($5/$30 to $4/$20) and
    // LiteLLM updated the base row before the codex SKUs, so codex-equals-base
    // cannot be asserted until upstream syncs. The codex rows must still exist
    // explicitly and carry the pre-cut rate they ship with today.
    expect(snapshot['gpt-5.6-codex']).toBeDefined()
    expect(snapshot['gpt-5.6-codex-max']).toEqual(snapshot['gpt-5.6-codex'])

    const codex = getModelCosts('gpt-5.6-codex')
    const codexMax = getModelCosts('gpt-5.6-codex-max')
    expect(codex).not.toBeNull()
    expect(codexMax).not.toBeNull()
    expect(codex!.inputCostPerToken).toBe(5e-6)
    expect(codex!.outputCostPerToken).toBe(3e-5)
    expect(codex!.cacheWriteCostPerToken).toBe(6.25e-6)
    expect(codex!.cacheReadCostPerToken).toBe(5e-7)
    expect(codex!.cacheWriteCostIsExplicit).toBe(true)
    expect(codexMax).toEqual(codex)

    expect(calculateCost('gpt-5.6-codex', 1_000_000, 1_000_000, 0, 0, 0)).toBeGreaterThan(0)
    expect(calculateCost('gpt-5.6-codex-max', 1_000_000, 1_000_000, 0, 0, 0)).toBeGreaterThan(0)
  })

  describe('grok-4.6 prompt tier', () => {
    it('uses the low tier below 200000 prompt tokens', () => {
      expect(calculateCost('grok-4.6', 100_000, 10_000, 0, 99_999, 0)).toBeCloseTo(0.3099995, 12)
    })

    it('uses the high tier for every token at exactly 200000 prompt tokens', () => {
      expect(calculateCost('grok-4.6', 100_000, 10_000, 0, 100_000, 0)).toBeCloseTo(0.62, 12)
    })

    it('uses the high tier above 200000 prompt tokens', () => {
      expect(calculateCost('grok-4.6', 100_001, 10_000, 0, 100_000, 0)).toBeCloseTo(0.620004, 12)
    })

    it('uses a price override instead of the built-in prompt tier', () => {
      setPriceOverrides({ 'grok-4.6': { input: 2, output: 6, cacheRead: 0.5 } })

      expect(calculateCost('grok-4.6', 100_000, 10_000, 0, 100_000, 0)).toBeCloseTo(0.31, 12)
    })
  })

  it('prices claude-haiku-4.5 (copilot session-store raw id), aliased to the existing claude-haiku-4-5 row (#1093)', () => {
    const haiku45 = getModelCosts('claude-haiku-4.5')
    const haiku45Dash = getModelCosts('claude-haiku-4-5')
    expect(haiku45).not.toBeNull()
    expect(haiku45).toEqual(haiku45Dash)
    expect(haiku45!.inputCostPerToken).toBe(1e-6)
    expect(haiku45!.outputCostPerToken).toBe(5e-6)
    expect(haiku45!.cacheWriteCostPerToken).toBe(1.25e-6)
    expect(haiku45!.cacheReadCostPerToken).toBe(1e-7)
    expect(haiku45!.cacheWriteCostIsExplicit).toBe(true)
    expect(calculateCost('claude-haiku-4.5', 1_000_000, 1_000_000, 0, 0, 0)).toBe(6)
  })

  // A price override on a synthetic bare id can only be reached if the leading
  // segment was stripped, so these assert the namespace allowlist itself without
  // pinning to any real model's presence in (or absence from) the snapshot.
  it('strips vendor namespaces the pricing catalog knows and fails closed on the rest', () => {
    setPriceOverrides({ 'zzz-namespace-probe': { input: 1, output: 2 } })

    const known = ['anthropic', 'x-ai', 'xai', 'qwen', 'moonshotai', 'nousresearch', 'kimi',
      'litellm_proxy', 'openai_like', 'zhipu', 'mimo', 'xiaomi',
      'cp', 'cline-pass', 'cline-free', 'cmd', 'antigravity', 'orcarouter']
    for (const ns of known) {
      expect(getModelCosts(`${ns}/zzz-namespace-probe`), ns).not.toBeNull()
    }

    // Local runners and unknown vendors must never strip down to a priced row.
    const unknown = ['ollama', 'local', 'lmstudio', 'hosted_vllm', 'unsloth', 'nosuchvendor']
    for (const ns of unknown) {
      expect(getModelCosts(`${ns}/zzz-namespace-probe`), ns).toBeNull()
    }
  })

  it('peels every routing wrapper but not an unknown vendor inside one', () => {
    setPriceOverrides({ 'zzz-router-probe': { input: 1, output: 2 } })

    const routed = [
      'omniroute:zzz-router-probe',
      'omniroute:cp/cline-pass/zzz-router-probe',
      'omniroute:cline-free/zzz-router-probe',
      'omniroute:antigravity/zzz-router-probe',
      'omniroute:cmd/zzz-router-probe',
      'omniroute:orcarouter/zzz-router-probe',
    ]
    for (const id of routed) expect(getModelCosts(id), id).not.toBeNull()

    expect(getModelCosts('omniroute:nosuchvendor/zzz-router-probe')).toBeNull()
    // A nested unknown vendor inside a known routing wrapper must fail closed.
    expect(getModelCosts('omniroute:orcarouter/nosuchvendor/zzz-router-probe')).toBeNull()
  })

  it('lets a user price override for a bare id win over the routed catalog row', () => {
    setPriceOverrides({ 'glm-5.3': { input: 99, output: 99 } })
    expect(getModelCosts('cp/cline-pass/glm-5.3')!.inputCostPerToken).toBe(99 / 1_000_000)
    expect(getModelCosts('omniroute:cp/cline-pass/glm-5.3')!.outputCostPerToken).toBe(99 / 1_000_000)
  })

  it('prices OrcaRouter fusion and nested upstreams; auto stays fail-closed', () => {
    // `orcarouter/auto` rotates onto a Qwen/Llama flash model. No live probe
    // pins a rate, so it stays unpriced rather than inheriting Sonnet.
    expect(getModelCosts('orcarouter/auto')).toBeNull()

    // The fusion routes currently resolve to openai/gpt-oss-120b (live 2026-08).
    expect(getModelCosts('orcarouter/fusion')!.inputCostPerToken).toBe(
      getModelCosts('openai/gpt-oss-120b')!.inputCostPerToken,
    )
    expect(getModelCosts('orcarouter/fusion-flash')!.inputCostPerToken).toBe(
      getModelCosts('openai/gpt-oss-120b')!.inputCostPerToken,
    )
    expect(getModelCosts('orcarouter/fusion-mini')!.inputCostPerToken).toBe(
      getModelCosts('openai/gpt-oss-120b')!.inputCostPerToken,
    )

    // Fully-qualified upstream ids peel to the exact LiteLLM row.
    expect(getModelCosts('orcarouter/deepseek/deepseek-v4-pro')!.inputCostPerToken).toBe(
      getModelCosts('deepseek/deepseek-v4-pro')!.inputCostPerToken,
    )
    expect(getModelCosts('orcarouter/deepseek/deepseek-v4-flash')!.outputCostPerToken).toBe(
      getModelCosts('deepseek/deepseek-v4-flash')!.outputCostPerToken,
    )

    // A route id for an unknown upstream stays unpriced (fail closed).
    expect(getModelCosts('orcarouter/nosuchvendor/zzz-router-probe')).toBeNull()
  })
})

describe('resolveCanonicalModelId', () => {
  it('aliases, peels path-form ids, and leaves display-only collisions distinct', () => {
    expect(resolveCanonicalModelId('k3')).toBe('kimi-k3')
    expect(resolveCanonicalModelId('k3-agent')).toBe('kimi-k3')
    expect(resolveCanonicalModelId('kimi-k3')).toBe('kimi-k3')
    expect(resolveCanonicalModelId('accounts/fireworks/models/glm-5p2')).toBe('glm-5p2')
    expect(resolveCanonicalModelId('glm-5p2')).toBe('glm-5p2')
    expect(resolveCanonicalModelId('GLM-5.2')).toBe('glm-5p1')
    expect(resolveCanonicalModelId('gpt-5-fast')).toBe('gpt-5')
    expect(resolveCanonicalModelId('gpt-5-untracked-xyz')).toBe('gpt-5-untracked-xyz')
    expect(resolveCanonicalModelId('claude-opus-4.6')).toBe('claude-opus-4-6')
    expect(resolveCanonicalModelId('kimi-code')).toBe('kimi-k2-thinking')
    expect(resolveCanonicalModelId('cline-pass/kimi-k3')).toBe('kimi-k3')
    expect(resolveCanonicalModelId('orcarouter/auto')).not.toBe(resolveCanonicalModelId('claude-sonnet-4-5'))
    expect(resolveCanonicalModelId('orcarouter/fusion')).toBe(resolveCanonicalModelId('openai/gpt-oss-120b'))
    expect(resolveCanonicalModelId('orcarouter/fusion-flash')).toBe(resolveCanonicalModelId('openai/gpt-oss-120b'))
    expect(resolveCanonicalModelId('orcarouter/fusion-mini')).toBe(resolveCanonicalModelId('openai/gpt-oss-120b'))
    expect(resolveCanonicalModelId('orcarouter/deepseek/deepseek-v4-pro')).toBe(
      resolveCanonicalModelId('deepseek/deepseek-v4-pro'),
    )
  })
})

describe('getShortModelName', () => {
  it('maps gpt-4o-mini correctly (not gpt-4o)', () => {
    expect(getShortModelName('gpt-4o-mini-2024-07-18')).toBe('GPT-4o Mini')
  })

  it('maps gpt-4o correctly', () => {
    expect(getShortModelName('gpt-4o-2024-08-06')).toBe('GPT-4o')
  })

  it('maps gpt-4.1-mini correctly (not gpt-4.1)', () => {
    expect(getShortModelName('gpt-4.1-mini-2025-04-14')).toBe('GPT-4.1 Mini')
  })

  it('maps gpt-5.4-mini correctly (not gpt-5.4)', () => {
    expect(getShortModelName('gpt-5.4-mini')).toBe('GPT-5.4 Mini')
  })

  // Regression for #461: spark is a distinct variant, not a reasoning suffix.
  it('maps gpt-5.3-codex-spark to its own label (not GPT-5.3 Codex)', () => {
    const name = getShortModelName('gpt-5.3-codex-spark')
    expect(name).not.toBe('GPT-5.3 Codex')
    expect(name).toBe('GPT-5.3 Codex Spark')
  })

  it('maps gpt-5.3-codex reasoning suffixes to the base label', () => {
    expect(getShortModelName('gpt-5.3-codex-high')).toBe('GPT-5.3 Codex')
    expect(getShortModelName('gpt-5.3-codex-low')).toBe('GPT-5.3 Codex')
  })

  it('maps claude-opus-4-6 with date suffix', () => {
    expect(getShortModelName('claude-opus-4-6-20260205')).toBe('Opus 4.6')
  })

  // Regression for #420: claude-opus-4-8 must get its own line, not collapse
  // into the generic "Opus 4" bucket via the shorter claude-opus-4 prefix.
  it('maps claude-opus-4-8 to its own line (not Opus 4)', () => {
    expect(getShortModelName('claude-opus-4-8')).toBe('Opus 4.8')
  })

  // A future version is derived from the id with no hand-maintained entry.
  it('derives an unreleased claude version with no SHORT_NAMES entry', () => {
    expect(getShortModelName('claude-sonnet-5-2')).toBe('Sonnet 5.2')
    expect(getShortModelName('claude-haiku-5')).toBe('Haiku 5')
    expect(getShortModelName('claude-opus-9-9-20300101')).toBe('Opus 9.9')
  })

  it('shows the real model name for pricing-sibling aliases, not the internal key', () => {
    // GLM-5.2 (and its lowercase Hermes spelling) price via the glm-5p1 sibling;
    // reports must show GLM-5.2, not the pricing key.
    expect(getShortModelName('GLM-5.2')).toBe('GLM-5.2')
    expect(getShortModelName('glm-5.2')).toBe('GLM-5.2')
    expect(getShortModelName('glm-5p1')).toBe('GLM-5.2')
    expect(getShortModelName('glm-5.3')).toBe('GLM-5.3')
    expect(getShortModelName('GLM-5.3')).toBe('GLM-5.3')
    // Prices via the glm-5p2 sibling, but must not be LABELLED as GLM-5.2.
    expect(getShortModelName('cmd/glm-5.3')).toBe('GLM-5.3')
    expect(getShortModelName('z-ai/glm-5.3')).toBe('GLM-5.3')
    expect(getShortModelName('xiaomi/glm-5.3')).toBe('GLM-5.3')
    expect(getShortModelName('cp/cline-pass/glm-5.3')).toBe('GLM-5.3')
    // OrcaRouter route ids peel to the upstream id, which keeps the upstream label.
    expect(getShortModelName('orcarouter/deepseek/deepseek-v4-pro')).toBe('DeepSeek v4 Pro')
    // Route ids display as the model they route to, not a branded gateway label.
    expect(getShortModelName('orcarouter/auto')).not.toBe(getShortModelName('claude-sonnet-4-5'))
    expect(getShortModelName('orcarouter/fusion')).toBe(getShortModelName('openai/gpt-oss-120b'))
    expect(getShortModelName('orcarouter/fusion-flash')).toBe(getShortModelName('openai/gpt-oss-120b'))
    expect(getShortModelName('orcarouter/fusion-mini')).toBe(getShortModelName('openai/gpt-oss-120b'))
    // Grok Build prices via the grok-build-0.1 sibling.
    expect(getShortModelName('grok-build')).toBe('Grok Build')
    expect(getShortModelName('grok-build-0.1')).toBe('Grok Build')
    // grok-composer has no alias, just a missing display entry.
    expect(getShortModelName('grok-composer-2.5-fast')).toBe('Grok Composer 2.5 Fast')
  })

  it('shows the last path segment for an unmapped path-style raw id', () => {
    expect(getShortModelName('fireworks/routers/glm-fast-latest')).toBe('glm-fast-latest')
    expect(getShortModelName('accounts/fireworks/models/some-unlisted-slug')).toBe('some-unlisted-slug')
  })

  it('names GPT-5.6 variants individually rather than collapsing them', () => {
    expect(getShortModelName('gpt-5.6-sol')).toBe('GPT-5.6 Sol')
    expect(getShortModelName('gpt-5.6-terra')).toBe('GPT-5.6 Terra')
    expect(getShortModelName('gpt-5.6-luna')).toBe('GPT-5.6 Luna')
    // No bare `gpt-5.6` entry exists, so an unlisted future variant must still
    // fall through to its raw id rather than borrow a sibling's label.
    expect(getShortModelName('gpt-5.6-unlisted')).toBe('gpt-5.6-unlisted')
  })

  it('names grok-4.5 without disturbing the Grok Build harness label', () => {
    // The Grok Build CLI reports the model it runs, so the model id gets the
    // model's name; ids that really are grok-build keep the harness label.
    expect(getShortModelName('grok-4.5')).toBe('Grok 4.5')
    expect(getShortModelName('grok-build-0.1')).toBe('Grok Build')
  })

  it('names ClinePass-routed slugs through the path fallback', () => {
    // ClinePass ids arrive as `cline-pass/<slug>`; the path fallback strips the
    // prefix and re-resolves the bare slug, as it does for Fireworks ids.
    expect(getShortModelName('cline-pass/qwen3.7-max')).toBe('Qwen 3.7 Max')
    expect(getShortModelName('cline-pass/minimax-m3')).toBe('MiniMax M3')
    expect(getShortModelName('cline-pass/mimo-v2.5-pro')).toBe('MiMo v2.5 Pro')
    expect(getShortModelName('cline-pass/kimi-k3')).toBe('Kimi K3')
  })

  it('names MiniMax M3 in both the lowercase-slug and capitalized spellings', () => {
    expect(getShortModelName('minimax-m3')).toBe('MiniMax M3')
    expect(getShortModelName('MiniMax-M3')).toBe('MiniMax M3')
  })

  it('resolves Fireworks-hosted fleet models to friendly names via the path fallback', () => {
    // Real ids are the full Fireworks path `accounts/fireworks/models/<slug>`.
    expect(getShortModelName('accounts/fireworks/models/glm-5p2')).toBe('GLM-5.2')
    expect(getShortModelName('accounts/fireworks/models/qwen3p7-plus')).toBe('Qwen 3.7 Plus')
    expect(getShortModelName('accounts/fireworks/models/kimi-k2p7-code')).toBe('Kimi K2.7 Code')
    expect(getShortModelName('accounts/fireworks/models/deepseek-v4-pro')).toBe('DeepSeek v4 Pro')
    expect(getShortModelName('accounts/fireworks/models/deepseek-v4-flash')).toBe('DeepSeek v4 Flash')
  })
})

describe('claude-fable-5 pricing + name', () => {
  it('prices at $10/M input, $50/M output via models.dev/OpenRouter gap-fill', () => {
    expect(calculateCost('claude-fable-5', 1_000_000, 0, 0, 0, 0)).toBeCloseTo(10, 6)
    expect(calculateCost('claude-fable-5', 0, 1_000_000, 0, 0, 0)).toBeCloseTo(50, 6)
  })
  it('shows its own display name', () => {
    expect(getShortModelName('claude-fable-5')).toBe('Fable 5')
  })
})

describe('builtin aliases - getModelCosts', () => {
  it('resolves anthropic--claude-4.6-opus', () => {
    expect(getModelCosts('anthropic--claude-4.6-opus')).not.toBeNull()
  })

  it('resolves anthropic--claude-4.6-sonnet', () => {
    expect(getModelCosts('anthropic--claude-4.6-sonnet')).not.toBeNull()
  })

  it('resolves anthropic--claude-4.5-opus', () => {
    expect(getModelCosts('anthropic--claude-4.5-opus')).not.toBeNull()
  })

  it('resolves anthropic--claude-4.5-sonnet', () => {
    expect(getModelCosts('anthropic--claude-4.5-sonnet')).not.toBeNull()
  })

  it('resolves anthropic--claude-4.5-haiku', () => {
    expect(getModelCosts('anthropic--claude-4.5-haiku')).not.toBeNull()
  })

  it('resolves double-wrapped anthropic/anthropic--claude-4.6-opus', () => {
    expect(getModelCosts('anthropic/anthropic--claude-4.6-opus')).not.toBeNull()
  })

  it('resolves double-wrapped anthropic/anthropic--claude-4.6-sonnet', () => {
    expect(getModelCosts('anthropic/anthropic--claude-4.6-sonnet')).not.toBeNull()
  })

  it('resolves double-wrapped anthropic/anthropic--claude-4.5-haiku', () => {
    expect(getModelCosts('anthropic/anthropic--claude-4.5-haiku')).not.toBeNull()
  })

  it('OMP opus resolves to same pricing as canonical claude-opus-4-6', () => {
    expect(getModelCosts('anthropic--claude-4.6-opus')).toEqual(getModelCosts('claude-opus-4-6'))
  })

  it('OMP sonnet resolves to same pricing as canonical claude-sonnet-4-6', () => {
    expect(getModelCosts('anthropic--claude-4.6-sonnet')).toEqual(getModelCosts('claude-sonnet-4-6'))
  })

  it('OMP haiku resolves to same pricing as canonical claude-haiku-4-5', () => {
    expect(getModelCosts('anthropic--claude-4.5-haiku')).toEqual(getModelCosts('claude-haiku-4-5'))
  })
})

describe('builtin aliases - getShortModelName', () => {
  it('anthropic--claude-4.6-opus -> Opus 4.6', () => {
    expect(getShortModelName('anthropic--claude-4.6-opus')).toBe('Opus 4.6')
  })

  it('anthropic--claude-4.6-sonnet -> Sonnet 4.6', () => {
    expect(getShortModelName('anthropic--claude-4.6-sonnet')).toBe('Sonnet 4.6')
  })

  it('anthropic--claude-4.5-opus -> Opus 4.5', () => {
    expect(getShortModelName('anthropic--claude-4.5-opus')).toBe('Opus 4.5')
  })

  it('anthropic--claude-4.5-sonnet -> Sonnet 4.5', () => {
    expect(getShortModelName('anthropic--claude-4.5-sonnet')).toBe('Sonnet 4.5')
  })

  it('anthropic--claude-4.5-haiku -> Haiku 4.5', () => {
    expect(getShortModelName('anthropic--claude-4.5-haiku')).toBe('Haiku 4.5')
  })

  it('anthropic/anthropic--claude-4.6-opus -> Opus 4.6', () => {
    expect(getShortModelName('anthropic/anthropic--claude-4.6-opus')).toBe('Opus 4.6')
  })
})

// Codex driving a Kimi backend records the model as `kimi/k3[1m]` (provider
// prefix + context-length tag). getCanonicalName strips the prefix but the
// `[1m]` tag used to survive, so it matched no alias and priced to $0 - the
// Kimi-via-codex spend was silently reported as free.
describe('codex Kimi context-tag normalization (kimi/k3[1m])', () => {
  it('prices kimi/k3[1m] the same as canonical kimi-k3 instead of $0', () => {
    expect(getModelCosts('kimi/k3[1m]')).not.toBeNull()
    expect(getModelCosts('kimi/k3[1m]')).toEqual(getModelCosts('kimi-k3'))
    expect(calculateCost('kimi/k3[1m]', 1_000_000, 100_000, 0, 0, 0)).toBeGreaterThan(0)
  })

  it('resolves the bare k3[1m] tag too', () => {
    expect(getModelCosts('k3[1m]')).toEqual(getModelCosts('kimi-k3'))
  })

  it('names kimi/k3[1m] as Kimi K3', () => {
    expect(getShortModelName('kimi/k3[1m]')).toBe('Kimi K3')
  })

  it('does not strip a non-bracket suffix from an ordinary model id', () => {
    expect(getShortModelName('gpt-5.5')).toBe('GPT-5.5')
    expect(getModelCosts('gpt-5.5')).toEqual(getModelCosts('gpt-5.5'))
    expect(calculateCost('gpt-5.5', 1_000_000, 100_000, 0, 0, 0)).toBeCloseTo(8, 5)
  })
})

describe('Antigravity Gemini 3.5 Flash variants resolve to pricing', () => {
  const variants = [
    'gemini-3.5-flash',
    'gemini-3.5-flash-high',
    'gemini-3.5-flash-medium',
    'gemini-3.5-flash-low',
    'Gemini 3.5 Flash (High)',
  ]

  for (const variant of variants) {
    it(`${variant} resolves to Gemini 3.5 Flash`, () => {
      expect(getModelCosts(variant)).toEqual(getModelCosts('gemini-3.5-flash'))
      expect(getShortModelName(variant)).toBe('Gemini 3.5 Flash')
    })
  }

  it('calculates non-zero cost for high thinking labels', () => {
    expect(calculateCost('gemini-3.5-flash-high', 1000, 100, 0, 0, 0)).toBeGreaterThan(0)
  })
})

describe('user aliases via setModelAliases', () => {
  it('user alias resolves for getModelCosts', () => {
    setModelAliases({ 'my-internal-model': 'claude-sonnet-4-6' })
    expect(getModelCosts('my-internal-model')).toEqual(getModelCosts('claude-sonnet-4-6'))
  })

  it('user alias resolves for getShortModelName', () => {
    setModelAliases({ 'my-internal-model': 'claude-opus-4-6' })
    expect(getShortModelName('my-internal-model')).toBe('Opus 4.6')
  })

  it('user alias overrides builtin', () => {
    setModelAliases({ 'anthropic--claude-4.6-opus': 'claude-sonnet-4-5' })
    expect(getModelCosts('anthropic--claude-4.6-opus')).toEqual(getModelCosts('claude-sonnet-4-5'))
  })

  it('user alias whose source already has a short name displays the target', () => {
    setModelAliases({ 'gpt-4o': 'claude-opus-4-6' })
    expect(getModelCosts('gpt-4o')).toEqual(getModelCosts('claude-opus-4-6'))
    expect(getShortModelName('gpt-4o')).toBe('Opus 4.6')
    setModelAliases({})
  })

  it('resetting aliases restores builtins', () => {
    setModelAliases({ 'anthropic--claude-4.6-opus': 'claude-sonnet-4-5' })
    setModelAliases({})
    expect(getModelCosts('anthropic--claude-4.6-opus')).toEqual(getModelCosts('claude-opus-4-6'))
  })
})

describe('user price overrides', () => {
  it('prices a model missing from the pricing snapshot', () => {
    const model = 'zz-price-override-missing-model-390'
    expect(getModelCosts(model)).toBeNull()

    setPriceOverrides({
      [model]: { input: 1.25, output: 2.5 },
    })

    const costs = getModelCosts(model)
    expect(costs).not.toBeNull()
    expect(costs!.inputCostPerToken).toBe(1.25e-6)
    expect(costs!.outputCostPerToken).toBe(2.5e-6)
    expect(calculateCost(model, 1_000_000, 1_000_000, 0, 0, 0)).toBe(3.75)
  })

  it('wins over snapshot pricing and configured aliases', () => {
    setModelAliases({
      'price-override-aliased-model': 'claude-opus-4-6',
      'price-override-canonical-source': 'price-override-canonical-target',
    })
    setPriceOverrides({
      'gpt-4o': { input: 7, output: 8 },
      'claude-opus-4-6': { input: 4, output: 5 },
      'price-override-aliased-model': { input: 2, output: 3 },
      'price-override-canonical-target': { input: 6, output: 7 },
    })

    expect(getModelCosts('gpt-4o')!.inputCostPerToken).toBe(7e-6)
    expect(getModelCosts('price-override-aliased-model')!.inputCostPerToken).toBe(2e-6)
    expect(getModelCosts('price-override-canonical-source')!.inputCostPerToken).toBe(6e-6)
  })

  it('converts USD per 1,000,000 tokens to per-token ModelCosts exactly', () => {
    const model = 'price-override-unit-conversion'
    setPriceOverrides({
      [model]: { input: 1, output: 0 },
    })

    expect(getModelCosts(model)!.inputCostPerToken).toBe(1e-6)
    expect(calculateCost(model, 1_000_000, 0, 0, 0, 0)).toBe(1)
  })

  it('defaults cache rates from input pricing when omitted', () => {
    const model = 'price-override-cache-defaults'
    setPriceOverrides({
      [model]: { input: 10, output: 20 },
    })

    const costs = getModelCosts(model)
    expect(costs).not.toBeNull()
    expect(costs!.cacheWriteCostPerToken).toBeCloseTo(12.5e-6, 12)
    expect(costs!.cacheReadCostPerToken).toBeCloseTo(1e-6, 12)
  })

  it('wins for case-insensitive and prefix matches without shadowing a more-specific exact snapshot entry', () => {
    const miniSnapshot = getModelCosts('gpt-5-mini')
    expect(miniSnapshot).not.toBeNull()

    setPriceOverrides({
      'gpt-5': { input: 91, output: 92 },
    })

    expect(getModelCosts('GPT-5')!.inputCostPerToken).toBe(91e-6)
    expect(getModelCosts('gpt-5-foo')!.inputCostPerToken).toBe(91e-6)

    const mini = getModelCosts('gpt-5-mini')
    expect(mini).not.toBeNull()
    expect(mini!.inputCostPerToken).toBe(miniSnapshot!.inputCostPerToken)
    expect(mini!.outputCostPerToken).toBe(miniSnapshot!.outputCostPerToken)
  })

  it('includes builtin and user price overrides in the daily cache config hash', () => {
    setLocalModelSavings({ local: 'gpt-4o' })
    setPriceOverrides({})

    // The builtin overrides always participate, so a release that edits them
    // invalidates cached daily costs even with no user overrides configured.
    const builtinOnly = getPriceOverridesConfigHash()
    expect(builtinOnly).toContain('builtin:')
    expect(getPriceOverridesConfigHash()).toBe(builtinOnly)
    const baseline = getDailyCacheConfigHash()

    setPriceOverrides({ 'price-hash-model': { input: 1, output: 2 } })
    const firstCombined = getDailyCacheConfigHash()

    setPriceOverrides({ 'price-hash-model': { input: 3, output: 2 } })
    const secondCombined = getDailyCacheConfigHash()

    expect(firstCombined).not.toBe(baseline)
    expect(secondCombined).not.toBe(baseline)
    expect(secondCombined).not.toBe(firstCombined)
  })

  it('includes flat-rate marks in the daily cache config hash', () => {
    setLocalModelSavings({})
    setPriceOverrides({})
    setFlatRateModels([])
    const baseline = getDailyCacheConfigHash()
    setFlatRateModels(['zz-flat-hash'])
    expect(getDailyCacheConfigHash()).not.toBe(baseline)
    setFlatRateModels([])
    expect(getDailyCacheConfigHash()).toBe(baseline)
  })
})

describe('calculateCost - OMP names produce non-zero cost', () => {
  it('calculates cost for anthropic--claude-4.6-opus', () => {
    expect(calculateCost('anthropic--claude-4.6-opus', 1000, 200, 0, 0, 0)).toBeGreaterThan(0)
  })

  it('calculates cost for anthropic/anthropic--claude-4.6-sonnet', () => {
    expect(calculateCost('anthropic/anthropic--claude-4.6-sonnet', 1000, 200, 0, 0, 0)).toBeGreaterThan(0)
  })
})

describe('Warp Claude variants resolve to pricing', () => {
  const cases: Array<[string, string]> = [
    ['claude-4-6-sonnet-high', 'claude-sonnet-4-6'],
    ['claude-4-6-sonnet-low', 'claude-sonnet-4-6'],
    ['claude-4-6-sonnet-medium', 'claude-sonnet-4-6'],
    ['claude-4-6-sonnet-high-fast', 'claude-sonnet-4-6'],
    ['claude-4-7-opus-xhigh', 'claude-opus-4-7'],
    ['claude-4-7-opus-xhigh-fast', 'claude-opus-4-7'],
  ]

  for (const [input, expectedAlias] of cases) {
    it(`${input} resolves to ${expectedAlias} pricing`, () => {
      const costs = getModelCosts(input)
      expect(costs).not.toBeNull()
      expect(costs!.inputCostPerToken).toBeGreaterThan(0)
      const expected = getModelCosts(expectedAlias)
      expect(expected).not.toBeNull()
      expect(costs!.inputCostPerToken).toBe(expected!.inputCostPerToken)
      expect(costs!.outputCostPerToken).toBe(expected!.outputCostPerToken)
    })

    it(`${input} calculates non-zero cost`, () => {
      expect(calculateCost(input, 1000, 200, 0, 0, 0)).toBeGreaterThan(0)
    })
  }
})

describe('calculateCost - Claude cache write durations', () => {
  it('prices 1-hour cache writes at 1.6x the 5-minute cache write rate', () => {
    const fiveMinute = calculateCost('claude-opus-4-7', 0, 0, 1_000_000, 0, 0)
    const oneHour = calculateCost('claude-opus-4-7', 0, 0, 1_000_000, 0, 0, 'standard', 1_000_000)
    const mixed = calculateCost('claude-opus-4-7', 0, 0, 100_000, 0, 0, 'standard', 60_000)

    expect(fiveMinute).toBeCloseTo(6.25, 6)
    expect(oneHour).toBeCloseTo(10, 6)
    expect(mixed).toBeCloseTo(0.85, 6)
  })
})

describe('existing model names still resolve', () => {
  it('canonical claude-opus-4-6', () => {
    expect(getModelCosts('claude-opus-4-6')).not.toBeNull()
  })

  it('canonical claude-sonnet-4-5', () => {
    expect(getModelCosts('claude-sonnet-4-5')).not.toBeNull()
  })

  it('date-stamped claude-sonnet-4-20250514', () => {
    expect(getModelCosts('claude-sonnet-4-20250514')).not.toBeNull()
  })

  it('pinned claude-sonnet-4-6@20250929', () => {
    expect(getModelCosts('claude-sonnet-4-6@20250929')).not.toBeNull()
  })

  it('anthropic/-prefixed anthropic/claude-opus-4-6', () => {
    expect(getModelCosts('anthropic/claude-opus-4-6')).not.toBeNull()
  })

  // #420: 4.8 has its own LiteLLM pricing tier ($5/$25), so it must not fall
  // through the prefix match to the older, 3x-pricier claude-opus-4 ($15/$75).
  it('claude-opus-4-8 prices at its own tier, not original claude-opus-4', () => {
    const v48 = getModelCosts('claude-opus-4-8')
    expect(v48).not.toBeNull()
    // $5/$25 per M tokens — the 4.6/4.7 tier, not the original opus-4 $15/$75.
    expect(v48!.inputCostPerToken).toBeCloseTo(0.000005, 12)
    expect(v48!.outputCostPerToken).toBeCloseTo(0.000025, 12)
    expect(v48!.inputCostPerToken).not.toEqual(getModelCosts('claude-opus-4')!.inputCostPerToken)
  })
})

// Issue #159: every model name Cursor emits in its SQLite database must
// resolve to a non-zero pricing entry, otherwise the dashboard shows $0 for
// that model. Each case asserts the resolved pricing identity matches the
// pricing of the expected canonical key, so an accidental alias swap (e.g.
// `claude-4.6-opus` aliased to a haiku entry) fails the test even though
// haiku also has positive pricing.
describe('Cursor model variants resolve to pricing', () => {
  const cases: Array<[string, string]> = [
    // Sonnet family
    ['claude-4-sonnet', 'claude-sonnet-4'],
    ['claude-4-sonnet-1m', 'claude-sonnet-4'],
    ['claude-4-sonnet-thinking', 'claude-sonnet-4'],
    ['claude-4.5-sonnet', 'claude-sonnet-4-5'],
    ['claude-4.5-sonnet-thinking', 'claude-sonnet-4-5'],
    ['claude-4.6-sonnet', 'claude-sonnet-4-6'],
    ['claude-4.6-sonnet-high', 'claude-sonnet-4-6'],
    ['claude-4.6-sonnet-low', 'claude-sonnet-4-6'],
    ['claude-4.6-sonnet-thinking', 'claude-sonnet-4-6'],
    ['claude-4.6-sonnet-high-thinking', 'claude-sonnet-4-6'],
    // Opus family
    ['claude-4-opus', 'claude-opus-4'],
    ['claude-4.5-opus', 'claude-opus-4-5'],
    ['claude-4.5-opus-high', 'claude-opus-4-5'],
    ['claude-4.5-opus-low', 'claude-opus-4-5'],
    ['claude-4.5-opus-medium', 'claude-opus-4-5'],
    ['claude-4.5-opus-high-thinking', 'claude-opus-4-5'],
    ['claude-4.6-opus', 'claude-opus-4-6'],
    ['claude-4.6-opus-fast-mode', 'claude-opus-4-6'],
    ['claude-4.6-opus-high', 'claude-opus-4-6'],
    ['claude-4.6-opus-low', 'claude-opus-4-6'],
    ['claude-4.6-opus-medium', 'claude-opus-4-6'],
    ['claude-4.6-opus-high-thinking', 'claude-opus-4-6'],
    ['claude-4.7-opus', 'claude-opus-4-7'],
    ['claude-opus-4-7-thinking-high', 'claude-opus-4-7'],
    // Haiku family
    ['claude-4.5-haiku', 'claude-haiku-4-5'],
    ['claude-4.6-haiku', 'claude-haiku-4-5'],
    // Cursor auto proxy
    ['cursor-auto', 'claude-sonnet-4-5'],
    // Codex activity surface (official rate card, observed raw id)
    ['codex-auto-review', 'gpt-5.5'],
    // OpenAI variants Cursor emits
    ['gpt-5', 'gpt-5'],
    ['gpt-5-fast', 'gpt-5'],
    ['gpt-5.2', 'gpt-5.2'],
    ['gpt-5.2-low', 'gpt-5'],
    // Direct LiteLLM hits where no alias is required
    ['grok-code-fast-1', 'grok-code-fast-1'],
    ['gemini-3-pro', 'gemini-3-pro-preview'],
  ]

  for (const [input, expectedAlias] of cases) {
    it(`${input} resolves to ${expectedAlias} pricing`, () => {
      const costs = getModelCosts(input)
      expect(costs, `${input} should resolve to pricing (and not produce $0 in the dashboard)`).not.toBeNull()
      expect(costs!.inputCostPerToken).toBeGreaterThan(0)
      expect(costs!.outputCostPerToken).toBeGreaterThan(0)
      const expected = getModelCosts(expectedAlias)
      expect(expected, `expected target ${expectedAlias} should itself resolve`).not.toBeNull()
      // Identity check: the alias must produce the SAME pricing object as
      // the canonical key, not just any non-zero pricing. Catches drift
      // where a future edit re-points an alias at a wrong-but-positive entry.
      expect(costs!.inputCostPerToken).toBe(expected!.inputCostPerToken)
      expect(costs!.outputCostPerToken).toBe(expected!.outputCostPerToken)
    })
  }

  // Regression for #912: Cursor's unversioned `claude-4-sonnet-thinking`
  // slug is the thinking variant of Sonnet 4, not Sonnet 4.5. The two models
  // currently share a price, so the display name pins the canonical identity
  // independently of today's pricing coincidence.
  it('keeps claude-4-sonnet-thinking in the Sonnet 4 model family', () => {
    expect(getShortModelName('claude-4-sonnet-thinking')).toBe('Sonnet 4')
  })
})

describe('Codex activity ids (#1047)', () => {
  it('keeps the activity label instead of collapsing to the underlying model name', () => {
    expect(getShortModelName('codex-auto-review')).toBe('Codex Auto Review')
  })

  it('prices as the exact bundled GPT-5.5 object, not an invented rate', () => {
    expect(getModelCosts('codex-auto-review')).toBe(getModelCosts('gpt-5.5'))
    const auto = calculateCost('codex-auto-review', 1_000_000, 1_000_000, 0, 0, 0)
    const gpt55 = calculateCost('gpt-5.5', 1_000_000, 1_000_000, 0, 0, 0)
    expect(auto).toBeGreaterThan(0)
    expect(auto).toBe(gpt55)
  })

  it('does not invent a family or an unobserved sibling id', () => {
    expect(getModelCosts('codex-code-review')).toBeNull()
    expect(getModelCosts('codex-cloud-task')).toBeNull()
    expect(getModelCosts('codex-automation')).toBeNull()
    expect(getModelCosts('code-review')).toBeNull()
    expect(getModelCosts('auto-review')).toBeNull()
    expect(calculateCost('codex-code-review', 1_000_000, 1_000_000, 0, 0, 0)).toBe(0)
  })
})

describe('Cursor house model pricing', () => {
  const cases: Array<[string, { input: number; output: number; cacheWrite: number; cacheRead: number }]> = [
    ['composer-2.5', { input: 0.5, output: 2.5, cacheWrite: 0.5, cacheRead: 0.2 }],
    ['composer-2', { input: 0.5, output: 2.5, cacheWrite: 0.5, cacheRead: 0.2 }],
    ['composer-1.5', { input: 3.5, output: 17.5, cacheWrite: 3.5, cacheRead: 0.35 }],
    ['composer-1', { input: 1.25, output: 10, cacheWrite: 1.25, cacheRead: 0.125 }],
  ]

  for (const [model, rates] of cases) {
    it(`${model} uses Cursor-published rates instead of Claude Sonnet proxy pricing`, () => {
      const costs = getModelCosts(model)
      expect(costs).not.toBeNull()
      expect(costs!.inputCostPerToken).toBeCloseTo(rates.input * 1e-6, 12)
      expect(costs!.outputCostPerToken).toBeCloseTo(rates.output * 1e-6, 12)
      expect(costs!.cacheWriteCostPerToken).toBeCloseTo(rates.cacheWrite * 1e-6, 12)
      expect(costs!.cacheReadCostPerToken).toBeCloseTo(rates.cacheRead * 1e-6, 12)
    })
  }
})

// Regression: LiteLLM ships `snowflake/claude-4-opus` ($5/M, a gateway rate),
// which the bundler strips to a bare `claude-4-opus` snapshot key. Without the
// alias-precedence guard in getModelCosts, that bare reseller key shadows the
// curated alias `claude-4-opus -> claude-opus-4` and mis-prices Opus 4 at a
// third of its official list price. Pin the official number so a re-shadowing
// fails loudly rather than silently under-reporting spend.
describe('alias precedence over stripped reseller keys', () => {
  it('claude-4-opus resolves to the official Opus 4 list price, not a gateway discount', () => {
    const aliased = getModelCosts('claude-4-opus')
    const canonical = getModelCosts('claude-opus-4')
    expect(aliased).not.toBeNull()
    expect(canonical).not.toBeNull()
    expect(aliased!.inputCostPerToken).toBe(canonical!.inputCostPerToken)
    expect(aliased!.outputCostPerToken).toBe(canonical!.outputCostPerToken)
    expect(aliased!.inputCostPerToken).toBe(15e-6)
    expect(aliased!.outputCostPerToken).toBe(75e-6)
  })

  it('the explicit provider prefix is still honored for the gateway rate', () => {
    // The guard fires only for the bare name; a fully-qualified gateway id must
    // still return that gateway's own price when LiteLLM publishes one.
    const gateway = getModelCosts('snowflake/claude-4-opus')
    const bare = getModelCosts('claude-4-opus')
    expect(gateway).not.toBeNull()
    expect(gateway!.inputCostPerToken).toBeLessThan(bare!.inputCostPerToken)
  })
})

// The case-insensitive index that lets `MiniMax-M3` reach a lowercase
// `minimax-m3` slug must NOT let a case-mismatched query resolve to one of
// LiteLLM's [0,0] price stubs (e.g. `GigaChat-2-Max`). Doing so would flip an
// honest null (which fires the "no pricing data, will show $0" warning) into a
// silent $0 and hide real spend. A case-EXACT query still finds the stub.
describe('zero-priced stubs do not satisfy case-insensitive lookup', () => {
  it('a case-mismatched query to a [0,0] stub stays null', () => {
    expect(getModelCosts('gigachat-2-max')).toBeNull()
  })

  it('the case-exact stub still resolves (just at zero cost)', () => {
    const exact = getModelCosts('GigaChat-2-Max')
    expect(exact).not.toBeNull()
    expect(exact!.inputCostPerToken).toBe(0)
  })
})

describe('DeepSeek v4 models resolve to pricing', () => {
  it('deepseek-v4-pro has current official discounted pricing', () => {
    const costs = getModelCosts('deepseek-v4-pro')
    expect(costs).not.toBeNull()
    expect(costs!.inputCostPerToken).toBe(4.35e-7)
    expect(costs!.outputCostPerToken).toBe(8.7e-7)
    expect(costs!.cacheReadCostPerToken).toBe(3.625e-9)
    expect(costs!.cacheWriteCostPerToken).toBe(0)
  })

  it('deepseek-v4-flash has current official pricing', () => {
    const costs = getModelCosts('deepseek-v4-flash')
    expect(costs).not.toBeNull()
    expect(costs!.inputCostPerToken).toBe(1.4e-7)
    expect(costs!.outputCostPerToken).toBe(2.8e-7)
    expect(costs!.cacheReadCostPerToken).toBe(2.8e-9)
    expect(costs!.cacheWriteCostPerToken).toBe(0)
  })

  it('provider-prefixed DeepSeek v4 names resolve to real pricing', () => {
    // 2026-08-24: DeepSeek repriced v4-pro and LiteLLM updated the
    // `deepseek/`-namespaced row before the bare one, so the two spellings
    // legitimately differ until upstream syncs. Both must still price
    // non-null; flash rows are in sync and must stay equal.
    expect(getModelCosts('deepseek/deepseek-v4-pro')).not.toBeNull()
    expect(getModelCosts('deepseek-v4-pro')).not.toBeNull()
    expect(getModelCosts('deepseek/deepseek-v4-flash')).not.toBeNull()
    expect(getModelCosts('deepseek-v4-flash')).not.toBeNull()
  })

  it('calculates non-zero costs for observed DeepSeek v4 Claude usage', () => {
    const pro = calculateCost('deepseek-v4-pro', 2_477_914, 762_994, 0, 258_556_928, 0)
    const flash = calculateCost('deepseek-v4-flash', 1_552_573, 353_914, 0, 48_388_608, 0)

    expect(pro).toBeCloseTo(2.68, 2)
    expect(flash).toBeCloseTo(0.45, 2)
  })

  it('uses DeepSeek v4 display names', () => {
    expect(getShortModelName('deepseek-v4-pro')).toBe('DeepSeek v4 Pro')
    expect(getShortModelName('deepseek-v4-flash')).toBe('DeepSeek v4 Flash')
  })

  it('keeps bundled DeepSeek v4 fallback entries when runtime pricing cache is stale', async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), 'codeburn-pricing-cache-'))

    try {
      process.env['CODEBURN_CACHE_DIR'] = cacheRoot
      await mkdir(cacheRoot, { recursive: true })
      await writeFile(join(cacheRoot, 'litellm-pricing.json'), JSON.stringify({
        version: CACHE_SCHEMA_VERSION,
        timestamp: Date.now(),
        data: {
          'gpt-4o-mini': {
            inputCostPerToken: 9e-7,
            outputCostPerToken: 1.8e-6,
            cacheWriteCostPerToken: 0,
            cacheReadCostPerToken: 9e-8,
            webSearchCostPerRequest: 0.01,
            fastMultiplier: 1,
          },
        },
      }), 'utf-8')

      await loadPricing()

      expect(getModelCosts('gpt-4o-mini')!.inputCostPerToken).toBe(9e-7)
      expect(getModelCosts('deepseek-v4-pro')!.inputCostPerToken).toBe(4.35e-7)
      expect(getModelCosts('deepseek-v4-flash')!.inputCostPerToken).toBe(1.4e-7)
    } finally {
      await rm(cacheRoot, { recursive: true, force: true })
      await loadPricing()
    }
  })
})

describe('pricing cache schema version (#1075/#1078 follow-up)', () => {
  it('discards a cache written by a pre-#1078 binary instead of reading its missing cacheWriteCostIsExplicit as false', async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), 'codeburn-pricing-cache-'))
    try {
      process.env['CODEBURN_CACHE_DIR'] = cacheRoot
      await mkdir(cacheRoot, { recursive: true })
      // Shape of a cache file written before #1078 added `version` and
      // `cacheWriteCostIsExplicit`: no version field, and entries missing the
      // key despite carrying a real (non-default) cache-write rate.
      await writeFile(join(cacheRoot, 'litellm-pricing.json'), JSON.stringify({
        timestamp: Date.now(),
        data: {
          'gpt-5.6': {
            inputCostPerToken: 5e-6,
            outputCostPerToken: 3e-5,
            cacheWriteCostPerToken: 6.25e-6,
            cacheReadCostPerToken: 5e-7,
            webSearchCostPerRequest: 0.01,
            fastMultiplier: 1,
          },
        },
      }), 'utf-8')

      await loadPricing()

      // Pre-fix, loadCachedPricing had no version check: it would read this
      // cache verbatim, and gpt-5.6's missing key would resolve to undefined
      // (falsy) here instead of the true its LiteLLM entry actually carries.
      expect(getModelCosts('gpt-5.6')!.cacheWriteCostIsExplicit).toBe(true)
    } finally {
      await rm(cacheRoot, { recursive: true, force: true })
      await loadPricing()
    }
  })
})

describe('provider pricing suffix variants', () => {
  const cases: Array<[string, string]> = [
    ['GLM-4.7-TEE', 'glm-4.7'],
    ['glm-4.7:thinking', 'glm-4.7'],
    ['Kimi-K2.5-TEE', 'kimi-k2.5'],
    ['deepseek-v4-pro:cloud', 'deepseek-v4-pro'],
    ['glm-5:thinking', 'glm-5'],
    ['kimi-k2.6:thinking', 'kimi-k2.6'],
    ['deepseek-v4-flash:thinking', 'deepseek-v4-flash'],
    ['minimax-m3:cloud', 'minimax-m3'],
  ]

  for (const [input, expectedBase] of cases) {
    it(`${input} resolves through ${expectedBase}`, () => {
      const costs = getModelCosts(input)
      const expected = getModelCosts(expectedBase)
      expect(costs).not.toBeNull()
      expect(expected).not.toBeNull()
      expect(costs!.inputCostPerToken).toBe(expected!.inputCostPerToken)
      expect(costs!.outputCostPerToken).toBe(expected!.outputCostPerToken)
    })
  }

  it('does not strip arbitrary local runtime tags', () => {
    expect(getModelCosts('qwen3.6:35b-a3b-bf16')).toBeNull()
  })

  it('does not strip free-tier markers into paid pricing', () => {
    expect(getModelCosts('mimo-v2-flash:free')).toBeNull()
  })
})

describe('observed provider model aliases', () => {
  const cases: Array<[string, string]> = [
    ['MiMo-V2-Flash', 'xiaomi/mimo-v2-flash'],
    ['mimo-v2.5-pro', 'xiaomi/mimo-v2.5-pro'],
    ['MiMo-v2.5-Pro', 'xiaomi/mimo-v2.5-pro'],
    ['mimo-v2.5', 'xiaomi/mimo-v2.5'],
    ['MiMo-v2.5', 'xiaomi/mimo-v2.5'],
    ['KAT-Coder-Pro-V1', 'kwaipilot/kat-coder-pro'],
    // Kimi Code wires report bare `k3` in llm.request.model; it must price
    // through the kimi-k3 table entry, not fall through to $0.
    ['k3', 'kimi-k3'],
  ]

  for (const [input, expectedModel] of cases) {
    it(`${input} resolves through ${expectedModel}`, () => {
      const costs = getModelCosts(input)
      const expected = getModelCosts(expectedModel)
      expect(costs).not.toBeNull()
      expect(expected).not.toBeNull()
      expect(costs).toEqual(expected)
      expect(calculateCost(input, 1_000_000, 1_000_000, 0, 0, 0)).toBeGreaterThan(0)
    })
  }

  it('k3 shows the Kimi K3 display name', () => {
    expect(getShortModelName('k3')).toBe('Kimi K3')
  })

  it('does not recurse on vendor-requalified MiMo aliases', () => {
    expect(getShortModelName('mimo-v2.5')).toBe('MiMo v2.5')
    expect(getShortModelName('MiMo-v2.5')).toBe('MiMo v2.5')
    expect(getShortModelName('cline-pass/mimo-v2.5')).toBe('MiMo v2.5')
    expect(getShortModelName('cline-pass/mimo-v2.5-pro')).toBe('MiMo v2.5 Pro')
  })

  // The `mimo-v2-flash -> xiaomi/mimo-v2-flash` alias shipped before this
  // change and already cycled: strip the namespace, alias it back, take the
  // leaf, repeat. Every display surface (overview's model table included)
  // threw RangeError on a real MiMo v2 Flash session. Pin the shipped ids.
  it('resolves the already-shipped MiMo v2 Flash alias without blowing the stack', () => {
    for (const id of ['mimo-v2-flash', 'MiMo-V2-Flash', 'cline-pass/mimo-v2-flash', 'mimo/mimo-v2-flash']) {
      expect(() => getShortModelName(id)).not.toThrow()
      expect(getShortModelName(id)).toBe('MiMo v2 Flash')
      expect(getModelCosts(id)).toEqual(getModelCosts('xiaomi/mimo-v2-flash'))
    }
  })

  it('names the base MiMo 2.5 row without swallowing the Pro tier', () => {
    expect(getShortModelName('mimo-v2.5')).toBe('MiMo v2.5')
    expect(getShortModelName('mimo-v2.5-pro')).toBe('MiMo v2.5 Pro')
    expect(getModelCosts('mimo-v2.5')).not.toEqual(getModelCosts('mimo-v2.5-pro'))
  })

  it('stays unary so Array.map cannot feed the index as cycle state', () => {
    expect(['mimo-v2.5', 'gpt-4o', 'cline-pass/mimo-v2.5-pro'].map(getShortModelName)).toEqual([
      'MiMo v2.5',
      'GPT-4o',
      'MiMo v2.5 Pro',
    ])
  })

  it('does not map dated Qwen3 Max to a reseller price without provider context', () => {
    expect(getModelCosts('qwen3-max-2026-01-23')).toBeNull()
    expect(calculateCost('qwen3-max-2026-01-23', 1_000_000, 1_000_000, 0, 0, 0)).toBe(0)
  })
})

describe('findUnpricedModels', () => {
  it('flags an unknown paid-looking model with $0 cost and skips priced ones', () => {
    const rows = [
      { model: 'claude-opus-4-6', calls: 10, cost: 2.5, tokens: 5000 },
      { model: 'zz-mystery-paid-model-999', calls: 3, cost: 0, tokens: 1200 },
    ]
    const unpriced = findUnpricedModels(rows)
    expect(unpriced).toEqual([{ model: 'zz-mystery-paid-model-999', calls: 3, tokens: 1200 }])
  })

  it('never flags a row that carries real cost, even when the lookup misses', () => {
    // Aggregation keys rows by display name; the lookup misses but the row was
    // priced at parse time, so it must not be reported as unpriced.
    const unpriced = findUnpricedModels([
      { model: 'Opus 4.8', calls: 100, cost: 42.5, tokens: 1_000_000 },
      { model: 'zz-unknown-but-priced-elsewhere', calls: 5, cost: 0.01, tokens: 500 },
    ])
    expect(unpriced).toEqual([])
  })

  it('flags $0 display-name rows even when the raw id would price today', () => {
    // Droid prices the lowercased display name ("claude sonnet 4.6" -> no
    // pricing -> $0) and the parser keys the row by display name. Those
    // tokens really entered the report at $0, so the row must be flagged
    // even though claude-sonnet-4-6 itself is priced.
    const unpriced = findUnpricedModels([
      { model: 'Sonnet 4.6', calls: 12, cost: 0, tokens: 500_000 },
    ])
    expect(unpriced).toEqual([{ model: 'Sonnet 4.6', calls: 12, tokens: 500_000 }])
  })

  it('flags zero-rate pricing stubs but not explicit zero-rate user overrides', async () => {
    // LiteLLM ships [0,0] stubs for models it lists but has no price for;
    // a stub hit means "unknown price", not "free".
    const cacheRoot = await mkdtemp(join(tmpdir(), 'codeburn-pricing-cache-'))
    try {
      process.env['CODEBURN_CACHE_DIR'] = cacheRoot
      await writeFile(join(cacheRoot, 'litellm-pricing.json'), JSON.stringify({
        version: CACHE_SCHEMA_VERSION,
        timestamp: Date.now(),
        data: {
          'zz-zero-stub-model': {
            inputCostPerToken: 0,
            outputCostPerToken: 0,
            cacheWriteCostPerToken: 0,
            cacheReadCostPerToken: 0,
            webSearchCostPerRequest: 0,
            fastMultiplier: 1,
          },
        },
      }), 'utf-8')
      await loadPricing()

      expect(getModelCosts('zz-zero-stub-model')).not.toBeNull()
      const rows = [{ model: 'zz-zero-stub-model', calls: 3, cost: 0, tokens: 1100 }]
      expect(findUnpricedModels(rows)).toHaveLength(1)

      // An explicit user override at zero rates means "this model is free".
      setPriceOverrides({ 'zz-zero-stub-model': { input: 0, output: 0 } })
      expect(findUnpricedModels(rows)).toEqual([])

      // A prefix override cannot prove intent: getModelCosts resolves table
      // hits before prefix overrides, so the $0 came from the stub, not the
      // user. Still flagged.
      setPriceOverrides({ 'zz-zero-stub': { input: 0, output: 0 } })
      expect(findUnpricedModels(rows)).toHaveLength(1)
    } finally {
      delete process.env['CODEBURN_CACHE_DIR']
      await rm(cacheRoot, { recursive: true, force: true })
      setPriceOverrides({})
      await loadPricing()
    }
  })

  it('skips synthetic, empty, local-looking, and zero-usage rows', () => {
    const unpriced = findUnpricedModels([
      { model: '<synthetic>', calls: 5, cost: 0, tokens: 100 },
      { model: '', calls: 5, cost: 0, tokens: 100 },
      { model: 'llama3.1:8b', calls: 5, cost: 0, tokens: 100 },
      { model: 'zz-quantized-model-bf16', calls: 5, cost: 0, tokens: 100 },
      { model: 'zz-no-usage-model', calls: 0, cost: 0, tokens: 0 },
    ])
    expect(unpriced).toEqual([])
  })

  it('heals when the user configures an alias or a price override', () => {
    const model = 'zz-proxy-renamed-model-x1'
    expect(findUnpricedModels([{ model, calls: 1, cost: 0, tokens: 10 }])).toHaveLength(1)

    setModelAliases({ [model]: 'claude-opus-4-6' })
    expect(findUnpricedModels([{ model, calls: 1, cost: 0, tokens: 10 }])).toEqual([])
    setModelAliases({})

    setPriceOverrides({ [model]: { input: 1, output: 2 } })
    expect(findUnpricedModels([{ model, calls: 1, cost: 0, tokens: 10 }])).toEqual([])
  })

  it('skips models mapped via model-savings (intentionally $0)', () => {
    const model = 'zz-my-local-runner'
    expect(findUnpricedModels([{ model, calls: 1, cost: 0, tokens: 10 }])).toHaveLength(1)
    setLocalModelSavings({ [model]: 'gpt-4o' })
    expect(findUnpricedModels([{ model, calls: 1, cost: 0, tokens: 10 }])).toEqual([])
  })

  it('skips subscription / flat-rate product SKUs where $0 is correct', () => {
    const rows = [
      { model: 'auto-genius', calls: 898, cost: 0, tokens: 35_300_000 },
      { model: 'cline-pass/auto-genius', calls: 4, cost: 0, tokens: 33_900 },
      { model: 'auto', calls: 449, cost: 0, tokens: 17_700_000 },
      { model: 'kimi-for-coding-highspeed', calls: 12, cost: 0, tokens: 3_400_000 },
      { model: 'moonshot/kimi-for-coding-highspeed', calls: 2, cost: 0, tokens: 80_000 },
      { model: 'grok-composer-2.5-fast', calls: 10, cost: 0, tokens: 1_900_000 },
      { model: 'Grok Composer 2.5 Fast', calls: 10, cost: 0, tokens: 1_900_000 },
      { model: 'Warp Auto (efficient)', calls: 3, cost: 0, tokens: 50_000 },
      { model: 'warp', calls: 449, cost: 0, tokens: 17_700_000 },
      { model: 'codex-auto-review', calls: 940, cost: 0, tokens: 7_200_000 },
      { model: 'Codex Auto Review', calls: 2, cost: 0, tokens: 100 },
      { model: 'big-pickle', calls: 4, cost: 0, tokens: 33_900 },
      { model: 'zz-mystery-paid-model-999', calls: 3, cost: 0, tokens: 1200 },
    ]
    expect(findUnpricedModels(rows)).toEqual([
      { model: 'warp', calls: 449, tokens: 17_700_000 },
      // Note: NOT 'codex-auto-review' — #1056 aliases it to gpt-5.5, so it
      // now resolves a billable rate and is filtered out here (a $0 row for
      // it is stale data, not evidence of missing pricing). It still left
      // the flat-rate list, verified separately in the "Codex activity ids
      // (#1047)" describe block below.
      { model: 'big-pickle', calls: 4, tokens: 33_900 },
      { model: 'zz-mystery-paid-model-999', calls: 3, tokens: 1200 },
      { model: 'Codex Auto Review', calls: 2, tokens: 100 },
    ])
  })

  it('skips a user-declared flat-rate model, including path-prefixed siblings', () => {
    const model = 'zz-my-pass-codename'
    expect(findUnpricedModels([{ model, calls: 1, cost: 0, tokens: 10 }])).toHaveLength(1)
    setFlatRateModels([model])
    expect(findUnpricedModels([{ model, calls: 1, cost: 0, tokens: 10 }])).toEqual([])
    expect(findUnpricedModels([{ model: `vendor/${model}`, calls: 1, cost: 0, tokens: 10 }])).toEqual([])
    expect(findUnpricedModels([{ model: 'zz-other-unknown', calls: 1, cost: 0, tokens: 10 }])).toHaveLength(1)
  })

  it('does not treat a priced sibling as expected-free just because a family is flat-rate', () => {
    // warp-auto-* is a subscription SKU, but main already aliases it onto a
    // billable row. Coverage must still count those priced calls.
    expect(isFlatRateModel('warp-auto-efficient')).toBe(true)
    expect(getModelCosts('warp-auto-efficient')).not.toBeNull()
    expect(isExpectedFreeModel('warp-auto-efficient')).toBe(false)
    expect(isExpectedFreeModel('auto-genius')).toBe(true)
    expect(isExpectedFreeModel('auto')).toBe(true)
    expect(isExpectedFreeModel('kimi-for-coding-highspeed')).toBe(true)
    expect(isExpectedFreeModel('warp')).toBe(false)
    expect(isExpectedFreeModel('codex-auto-review')).toBe(false)
    expect(isExpectedFreeModel('zz-mystery-paid-model-999')).toBe(false)
  })

  it('lets --remove opt out of a built-in so a false positive can warn again', () => {
    expect(findUnpricedModels([{ model: 'auto-genius', calls: 1, cost: 0, tokens: 10 }])).toEqual([])
    setFlatRateRemoved(['auto-genius'])
    expect(isFlatRateModel('auto-genius')).toBe(false)
    expect(findUnpricedModels([{ model: 'auto-genius', calls: 1, cost: 0, tokens: 10 }])).toEqual([
      { model: 'auto-genius', calls: 1, tokens: 10 },
    ])
    expect(findUnpricedModels([{ model: 'cline-pass/auto-genius', calls: 1, cost: 0, tokens: 10 }])).toEqual([
      { model: 'cline-pass/auto-genius', calls: 1, tokens: 10 },
    ])
    expect(isFlatRateModel('auto')).toBe(true)
  })

  it('sorts by tokens, then calls', () => {
    const unpriced = findUnpricedModels([
      { model: 'zz-small', calls: 9, cost: 0, tokens: 10 },
      { model: 'zz-big', calls: 1, cost: 0, tokens: 9999 },
    ])
    expect(unpriced.map(u => u.model)).toEqual(['zz-big', 'zz-small'])
  })
})

describe('parseLiteLLMEntry hardening', () => {
  it('returns null instead of throwing on a null or non-object entry', () => {
    // The live LiteLLM map is remote JSON; a null value for a model used to
    // throw on the field reads and abort the whole pricing load.
    expect(parseLiteLLMEntry(null as unknown as Parameters<typeof parseLiteLLMEntry>[0])).toBeNull()
    expect(parseLiteLLMEntry(undefined as unknown as Parameters<typeof parseLiteLLMEntry>[0])).toBeNull()
    expect(parseLiteLLMEntry(42 as unknown as Parameters<typeof parseLiteLLMEntry>[0])).toBeNull()
  })

  it('still parses a valid entry', () => {
    const costs = parseLiteLLMEntry({ input_cost_per_token: 0.000003, output_cost_per_token: 0.000015 } as Parameters<typeof parseLiteLLMEntry>[0])
    expect(costs).not.toBeNull()
  })
})

describe('getModelAliasesConfigHash', () => {
  it('is empty for no aliases, changes with content, ignores insertion order', () => {
    setModelAliases({})
    expect(getModelAliasesConfigHash()).toBe('')
    setModelAliases({ 'my-model': 'claude-opus-4-6' })
    const one = getModelAliasesConfigHash()
    expect(one).not.toBe('')
    setModelAliases({ 'b-model': 'gpt-5', 'my-model': 'claude-opus-4-6' })
    const two = getModelAliasesConfigHash()
    expect(two).not.toBe(one)
    setModelAliases({ 'my-model': 'claude-opus-4-6', 'b-model': 'gpt-5' })
    expect(getModelAliasesConfigHash()).toBe(two)
    setModelAliases({})
  })
})

describe('getFlatRateModelsConfigHash', () => {
  it('is empty for no marks, changes with content, ignores insertion order', () => {
    setFlatRateModels([])
    expect(getFlatRateModelsConfigHash()).toBe('')
    setFlatRateModels(['auto-genius'])
    const one = getFlatRateModelsConfigHash()
    expect(one).not.toBe('')
    setFlatRateModels(['warp', 'auto-genius'])
    const two = getFlatRateModelsConfigHash()
    expect(two).not.toBe(one)
    setFlatRateModels(['auto-genius', 'warp'])
    expect(getFlatRateModelsConfigHash()).toBe(two)
    setFlatRateModels([])
  })

  it('changes when a built-in is opted out', () => {
    setFlatRateModels([])
    setFlatRateRemoved([])
    const baseline = getFlatRateModelsConfigHash()
    setFlatRateRemoved(['auto-genius'])
    expect(getFlatRateModelsConfigHash()).not.toBe(baseline)
    setFlatRateRemoved([])
    expect(getFlatRateModelsConfigHash()).toBe(baseline)
  })
})

describe('pricing snapshot carries flat-rate marks', () => {
  it('restorePricingState reapplies user flat-rate marks', async () => {
    const { snapshotPricingState, restorePricingState } = await import('../src/models.js')
    setFlatRateModels(['zz-snapshot-flat'])
    const snap = snapshotPricingState()
    expect(snap.flatRateModels).toEqual(['zz-snapshot-flat'])
    setFlatRateModels([])
    expect(isFlatRateModel('zz-snapshot-flat')).toBe(false)
    restorePricingState(snap)
    expect(isFlatRateModel('zz-snapshot-flat')).toBe(true)
    setFlatRateModels([])
  })

  it('restorePricingState reapplies built-in opt-outs', async () => {
    const { snapshotPricingState, restorePricingState } = await import('../src/models.js')
    setFlatRateRemoved(['auto-genius'])
    const snap = snapshotPricingState()
    expect(snap.flatRateModelsRemoved).toEqual(['auto-genius'])
    setFlatRateRemoved([])
    expect(isFlatRateModel('auto-genius')).toBe(true)
    restorePricingState(snap)
    expect(isFlatRateModel('auto-genius')).toBe(false)
    setFlatRateRemoved([])
  })
})

describe('unpricedModelHint', () => {
  it('never tells the user to alias unconditionally', () => {
    expect(unpricedModelHint()).toContain('If a model is billed per token')
    expect(unpricedModelHint()).toContain('model-flat-rate')
    expect(unpricedModelHint()).not.toContain('Fix: codeburn model-alias')
  })

  it('names both hatches for a concrete unknown SKU', () => {
    const hint = unpricedModelHint('zz-new-subscription-pass-sku')
    expect(hint).toContain('codeburn model-alias "zz-new-subscription-pass-sku"')
    expect(hint).toContain('codeburn model-flat-rate "zz-new-subscription-pass-sku"')
    expect(hint).toContain('If a model is billed per token')
    expect(hint).toContain('If $0 is correct')
  })
})

describe('calculateCost verbose unknown-model warning', () => {
  it('does not present model-alias as the only fix for an unknown SKU', () => {
    const previous = process.env['CODEBURN_VERBOSE']
    process.env['CODEBURN_VERBOSE'] = '1'
    const chunks: string[] = []
    const originalWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
      return (originalWrite as (chunk: string | Uint8Array, ...rest: unknown[]) => boolean)(chunk, ...args)
    }) as typeof process.stderr.write
    try {
      expect(calculateCost('zz-new-subscription-pass-sku', 10, 10, 0, 0, 0)).toBe(0)
    } finally {
      process.stderr.write = originalWrite
      if (previous === undefined) delete process.env['CODEBURN_VERBOSE']
      else process.env['CODEBURN_VERBOSE'] = previous
    }
    const text = chunks.join('')
    expect(text).toContain('zz-new-subscription-pass-sku')
    expect(text).toContain('If a model is billed per token')
    expect(text).toContain('model-flat-rate')
    expect(text).toContain('model-alias')
    expect(text).not.toMatch(/Map it with: codeburn model-alias/)
  })
})

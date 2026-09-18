import { describe, it, expect, beforeAll, afterEach } from 'vitest'

import {
  callBillingMode,
  calculateCost,
  effectiveRouteId,
  getModelRoute,
  getRouteById,
  getShortModelName,
  loadPricing,
  modelRowKey,
  parseBillingMode,
  registeredRouteIds,
  resolveCanonicalModelId,
  routeFromProviderField,
  routeSuffix,
  setModelAliases,
} from '../src/models.js'
import { modelFoldKey } from '../src/models-report.js'

beforeAll(async () => {
  await loadPricing()
})

afterEach(() => {
  setModelAliases({})
})

// A billing route is the door a call was billed through. It has two sources:
// the model id, when the door renames the model (Bedrock), and the provider's
// own endpoint column, when it does not (Hermes `billing_provider`). Both feed
// `modelRowKey`, the one key every report keys a model row on (#1450).

describe('getModelRoute - Bedrock id shape', () => {
  it('recognises <vendor>.<model>[-vN:M] for the two vendors with sessions on disk', () => {
    expect(getModelRoute('anthropic.claude-haiku-4-5-20251001-v1:0')).toMatchObject({
      id: 'bedrock', label: 'Bedrock', baseModel: 'claude-haiku-4-5-20251001',
    })
    expect(getModelRoute('anthropic.claude-fable-5-1')?.baseModel).toBe('claude-fable-5-1')
    expect(getModelRoute('openai.gpt-5.6-luna')?.baseModel).toBe('gpt-5.6-luna')
    expect(getModelRoute('anthropic.claude-3-5-sonnet-20241022-v2:0')?.baseModel).toBe('claude-3-5-sonnet-20241022')
  })

  it('keeps a cross-region inference profile as its own SKU variant', () => {
    // `us.` prices above the bare id in LiteLLM; #1053: distinct SKUs stay
    // distinct rows, so the profile prefix is a variant, not folded away.
    const us = getModelRoute('us.anthropic.claude-haiku-4-5-20251001-v1:0')
    expect(us).toMatchObject({ id: 'bedrock', baseModel: 'claude-haiku-4-5-20251001', variant: 'us' })
    expect(getModelRoute('global.anthropic.claude-fable-5-1')?.variant).toBe('global')
    expect(getModelRoute('anthropic.claude-fable-5-1')?.variant).toBeUndefined()
  })

  it('returns undefined for direct-API ids and for dotted ids that are versions, not vendors', () => {
    for (const id of [
      'claude-fable-5-1', 'claude-sonnet-4-5-20250929', 'gpt-5.6-luna', 'gemini-2.5-pro', 'o3',
      'gpt-4.1-mini', 'glm-4.7', 'MiniMax-M2.7', 'deepseek-v3.2', 'grok-4.6',
      // other vendors' Bedrock ids are not recognised until a provider is shown to write them
      'deepseek.v3.2', 'amazon.nova-pro-v1:0', 'meta.llama3-1-70b-instruct-v1:0',
      // wrappers the first cut of #1448 accepted and the review cut: not on disk
      'bedrock/anthropic.claude-fable-5-1', 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-fable-5-1',
      // other routers, Vertex, local tags, placeholder
      'openrouter/anthropic/claude-sonnet-4.5', 'anthropic/claude-sonnet-4-5', 'accounts/fireworks/models/glm-5p2',
      'claude-3-5-sonnet@20241022', 'qwen3.6:35b-a3b-bf16', '<synthetic>', '',
    ]) {
      expect(getModelRoute(id), id).toBeUndefined()
    }
  })
})

describe('routeFromProviderField - the provider column', () => {
  it('maps the door spelling Hermes writes', () => {
    expect(routeFromProviderField('bedrock')?.id).toBe('bedrock')
    expect(routeFromProviderField('Bedrock ')?.id).toBe('bedrock')
  })

  it('maps only the exact Amazon Bedrock provider field OpenCode writes', () => {
    expect(routeFromProviderField('amazon-bedrock')).toMatchObject({ id: 'bedrock', label: 'Bedrock' })
    expect(routeFromProviderField('Amazon-Bedrock')).toBeUndefined()
    expect(routeFromProviderField(' amazon-bedrock ')).toBeUndefined()
  })

  it('maps only the exact OpenRouter provider field now that usage-bearing sessions exist', () => {
    // Two Hermes sessions ran through OpenRouter on 2026-09-18 with the exact
    // `billing_provider = openrouter`; unlike legacy Bedrock normalization, no
    // case or whitespace aliases have real data behind them.
    expect(routeFromProviderField('openrouter')).toMatchObject({ id: 'openrouter', label: 'OpenRouter' })
    expect(routeFromProviderField('OpenRouter')).toBeUndefined()
    expect(routeFromProviderField(' openrouter ')).toBeUndefined()
  })

  it('returns undefined for the direct doors, subscription doors and doors with no sessions yet', () => {
    // Direct: the unsuffixed row IS the direct row. Subscription: a ChatGPT
    // plan does not change which row a model lands on. `bedrock-mantle` is a
    // real Hermes value with no sessions on disk, so it is not registered yet
    // and maps to nothing. Only the exact field spelling counts: OpenRouter's
    // own `openrouter/<vendor>/<model>` ids are model names, not doors.
    for (const v of ['anthropic', 'openai', 'openai-codex', 'google', 'moa', 'acme-gateway', 'bedrock-mantle', 'openrouter/auto', 'openrouter:free', '', null, undefined]) {
      expect(routeFromProviderField(v), String(v)).toBeUndefined()
    }
  })

  it('round-trips a persisted id', () => {
    expect(getRouteById('bedrock')?.label).toBe('Bedrock')
    expect(getRouteById('nope')).toBeUndefined()
    expect(getRouteById(undefined)).toBeUndefined()
  })
})

describe('modelRowKey - one SKU through one door is one row', () => {
  it('is exactly getShortModelName for ids that name no door', () => {
    for (const id of ['claude-fable-5-1', 'gpt-5.6-sol', 'accounts/fireworks/models/glm-5p2', 'kimi/k3[1m]', 'qwen3.6:35b-a3b-bf16', '<synthetic>', 'MiniMax-M2.7']) {
      expect(modelRowKey(id), id).toBe(getShortModelName(id))
    }
  })

  it('keeps the direct, single-region Bedrock and cross-region Bedrock rows of one model apart', () => {
    // The three Claude sessions the #1448 review seeded. Before: raw ids on
    // every surface. #1448's first cut: the two Bedrock ids blended into one
    // row at two prices. Now: three rows, and the same three on every surface.
    expect(modelRowKey('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(modelRowKey('anthropic.claude-haiku-4-5-20251001-v1:0')).toBe('Haiku 4.5 (Bedrock)')
    expect(modelRowKey('us.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe('Haiku 4.5 (Bedrock us)')
    expect(modelRowKey('openai.gpt-5.6-luna')).toBe('GPT-5.6 Luna (Bedrock)')
  })

  it('applies a column-sourced route to a plain vendor id', () => {
    // Hermes `billing_provider = bedrock` next to `claude-sonnet-4-5`: the id
    // alone says "direct"; the route says otherwise.
    expect(modelRowKey('claude-sonnet-4-5', 'bedrock')).toBe('Sonnet 4.5 (Bedrock)')
    expect(modelRowKey('claude-sonnet-4-5', null)).toBe('Sonnet 4.5')
    expect(modelRowKey('claude-sonnet-4-5', 'not-a-route')).toBe('Sonnet 4.5')
  })

  it('lets the persisted route win over the id shape, and a user alias win over both', () => {
    // A Hermes bedrock session whose id is Bedrock-shaped: same answer either way.
    expect(modelRowKey('openai.gpt-5.6-luna', 'bedrock')).toBe('GPT-5.6 Luna (Bedrock)')
    setModelAliases({ 'anthropic.claude-fable-5-1': 'claude-fable-5-1' })
    expect(modelRowKey('anthropic.claude-fable-5-1')).toBe('Fable 5.1')
  })

  it('is idempotent, so a pre-v33 daily row keyed by display name re-keys to itself', () => {
    for (const key of ['Haiku 4.5', 'Haiku 4.5 (Bedrock)', 'Haiku 4.5 (Bedrock us)', 'GPT-5.6 Sol']) {
      expect(modelRowKey(key), key).toBe(key)
    }
  })

  it('exposes the suffix alone for provider-first labels', () => {
    expect(routeSuffix('claude-haiku-4-5-20251001')).toBe('')
    expect(routeSuffix('anthropic.claude-haiku-4-5-20251001-v1:0')).toBe('(Bedrock)')
    expect(routeSuffix('us.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe('(Bedrock us)')
    expect(routeSuffix('claude-sonnet-4-5', 'bedrock')).toBe('(Bedrock)')
  })

  it('folds on the row key, so two route ids with one label cannot make two rows', () => {
    // `bedrock` and `bedrock-mantle` are one door with two endpoint names.
    // models-report folded on the route id and printed two rows both called
    // "GPT-5.6 Sol (Bedrock)" while every label-keyed surface showed one. The
    // fold key carries the row key's suffix and never the route id, so the
    // next door added under an existing label folds instead of twinning.
    const key = modelFoldKey('claude-sonnet-4-5', 'bedrock')
    expect(key).toBe(`${resolveCanonicalModelId('claude-sonnet-4-5')} ${routeSuffix('claude-sonnet-4-5', 'bedrock')}`)
    expect(key).toContain('(Bedrock)')
    expect(key).not.toContain('bedrock')
    // An id-shaped Bedrock call and a column-routed one of the same SKU are
    // one row, whichever source named the door.
    expect(modelFoldKey('anthropic.claude-sonnet-4-5', 'bedrock')).toBe(modelFoldKey('anthropic.claude-sonnet-4-5', null))
  })
})

describe('routes never move a dollar', () => {
  it('prices on the raw id: the profile keeps its uplift, the bare Bedrock id matches direct', () => {
    const direct = calculateCost('claude-haiku-4-5-20251001', 1_000_000, 100_000, 0, 0, 0)
    const bare = calculateCost('anthropic.claude-haiku-4-5-20251001-v1:0', 1_000_000, 100_000, 0, 0, 0)
    const profile = calculateCost('us.anthropic.claude-haiku-4-5-20251001-v1:0', 1_000_000, 100_000, 0, 0, 0)
    expect(bare).toBeCloseTo(direct, 6)
    expect(profile).toBeGreaterThan(bare)
    expect(getShortModelName('us.anthropic.claude-haiku-4-5-20251001-v1:0')).not.toContain('Bedrock') // display resolver untouched
  })
})

// Billing mode is the second half of the same question: the route says which
// door, the mode says whether that door charges per call (`metered`) or the
// usage is already paid for by a subscription. It is optional everywhere —
// unknown stays unknown and is never coerced into either mode (#1451).

describe('effectiveRouteId - the door that actually applies', () => {
  it('prefers the persisted route and falls back to the id shape', () => {
    expect(effectiveRouteId('claude-sonnet-4-5', 'bedrock')).toBe('bedrock')
    expect(effectiveRouteId('claude-sonnet-4-5', 'openrouter')).toBe('openrouter')
    expect(effectiveRouteId('anthropic.claude-haiku-4-5-20251001-v1:0', null)).toBe('bedrock')
    expect(effectiveRouteId('us.anthropic.claude-haiku-4-5-20251001-v1:0', undefined)).toBe('bedrock')
  })

  it('is null for the direct door and for a route id nothing registers', () => {
    expect(effectiveRouteId('claude-sonnet-4-5', null)).toBeNull()
    expect(effectiveRouteId('claude-sonnet-4-5', 'not-a-route')).toBeNull()
    // OpenRouter names its models `openrouter/<vendor>/<model>`; that is a
    // model id, not a door, and must never be read as one.
    expect(effectiveRouteId('openrouter/anthropic/claude-sonnet-4.5', null)).toBeNull()
    expect(effectiveRouteId('openrouter/auto', null)).toBeNull()
  })

  it('lists the registered ids for the CLI to validate against', () => {
    expect(registeredRouteIds()).toEqual(['bedrock', 'openrouter'])
  })
})

describe('parseBillingMode - exactly two modes', () => {
  it('accepts the two modes and nothing else', () => {
    expect(parseBillingMode('metered')).toBe('metered')
    expect(parseBillingMode('subscription')).toBe('subscription')
    for (const v of ['Metered', 'included', 'actual', 'unknown', 'direct', '', null, undefined]) {
      expect(parseBillingMode(v), String(v)).toBeUndefined()
    }
  })
})

describe('callBillingMode - the call\'s own evidence first', () => {
  it('takes a provider-observed fact over everything else', () => {
    // Hermes records the resolved cost basis: `included` is subscription-covered
    // usage, `actual` is a recorded invoice amount.
    expect(callBillingMode({ model: 'claude-sonnet-4-5', billing: 'subscription' })).toBe('subscription')
    expect(callBillingMode({ model: 'claude-sonnet-4-5', billing: 'metered' })).toBe('metered')
  })

  it('lets an observed subscription override a registered route default', () => {
    // A door registered as metered does not get to overrule a recorded
    // `included` basis — the fact outranks the default.
    expect(callBillingMode({ model: 'claude-sonnet-4-5', route: 'bedrock', billing: 'subscription' })).toBe('subscription')
    expect(callBillingMode({ model: 'anthropic.claude-fable-5-1', billing: 'subscription' })).toBe('subscription')
  })

  it('falls back to the effective route default when the call states no fact', () => {
    expect(callBillingMode({ model: 'claude-sonnet-4-5', route: 'bedrock' })).toBe('metered')
    expect(callBillingMode({ model: 'claude-sonnet-4-5', route: 'openrouter' })).toBe('metered')
    expect(callBillingMode({ model: 'anthropic.claude-haiku-4-5-20251001-v1:0' })).toBe('metered')
  })

  it('leaves a direct call with no recorded basis unknown', () => {
    // An estimated or calculated cost on the direct door proves nothing about
    // who billed it, so it is neither metered nor subscription.
    expect(callBillingMode({ model: 'claude-sonnet-4-5' })).toBeUndefined()
    expect(callBillingMode({ model: 'claude-sonnet-4-5', route: null, billing: null })).toBeUndefined()
    expect(callBillingMode({ model: 'claude-sonnet-4-5', route: 'not-a-route' })).toBeUndefined()
    expect(callBillingMode({ model: 'openrouter/auto' })).toBeUndefined()
  })
})

/**
 * Billing engine for CodeBurn v2.0.0
 *
 * Two mutually exclusive billing modes:
 *   - credits: Only Augment credits (ground-truth or synthesized), never USD
 *   - token_plus: Only USD (base + surcharge = billed), never credits
 *
 * Environment variables:
 *   CODEBURN_BILLING_MODE: 'credits' | 'token_plus' (default: 'credits')
 *   CODEBURN_SURCHARGE_RATE: decimal surcharge for token_plus mode (default: 0)
 *
 * Credit formula (no surcharge): Math.ceil(baseCostUsd × 1600 × 1.0 × 1.0)
 */

import type { ModelCosts } from './models.js'

// ============================================================================
// Constants
// ============================================================================

/** Augment credits per dollar */
export const CREDITS_PER_DOLLAR = 1600

/** Activity multiplier - hardcoded per spec (module-internal) */
const ACTIVITY_MULTIPLIER = 1.0

/** Model multiplier - hardcoded per spec (module-internal) */
const MODEL_MULTIPLIER = 1.0

// ============================================================================
// Types
// ============================================================================

export type BillingMode = 'credits' | 'token_plus'

export type BillingConfig = {
  mode: BillingMode
  surchargeRate: number // only used in token_plus mode
}

export type BillingResult = {
  mode: BillingMode
  baseCostUsd: number // always computed
  surchargeUsd: number | null // null in credits mode
  billedAmountUsd: number | null // null in credits mode
  creditsAugment: number | null // null in token_plus mode or when model unknown
  creditsSynthesized: number | null // null unless synthesized in credits mode
  synthesized: boolean // true iff credits were synthesized (no ground truth)
}

// ============================================================================
// Config loading
// ============================================================================

export function loadBillingConfig(env: NodeJS.ProcessEnv = process.env): BillingConfig {
  const rawMode = env.CODEBURN_BILLING_MODE
  const mode: BillingMode = rawMode === 'token_plus' ? 'token_plus' : 'credits' // invalid → 'credits'

  const rawSurcharge = env.CODEBURN_SURCHARGE_RATE
  const parsed = rawSurcharge !== undefined ? Number(rawSurcharge) : NaN
  const surchargeRate = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0

  return { mode, surchargeRate }
}

// ============================================================================
// Credit synthesis
// ============================================================================

/**
 * Synthesize credits from base USD cost.
 * Formula: Math.ceil(baseCostUsd × CREDITS_PER_DOLLAR × ACTIVITY_MULTIPLIER × MODEL_MULTIPLIER)
 * Note: NO surcharge applied to credits - surcharge is a token_plus concept only.
 */
export function synthesizeCredits(baseCostUsd: number): number {
  return Math.ceil(baseCostUsd * CREDITS_PER_DOLLAR * ACTIVITY_MULTIPLIER * MODEL_MULTIPLIER)
}

// ============================================================================
// Core billing computation
// ============================================================================

/**
 * Calculate base USD cost from tokens and model costs.
 */
function calculateBaseCost(
  tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
  modelCosts: ModelCosts,
): number {
  return (
    tokens.input * modelCosts.inputCostPerToken +
    tokens.output * modelCosts.outputCostPerToken +
    (tokens.cacheRead ?? 0) * modelCosts.cacheReadCostPerToken +
    (tokens.cacheWrite ?? 0) * modelCosts.cacheWriteCostPerToken
  )
}

/**
 * Compute billing for a single API call.
 *
 * @param tokens - Token counts (input, output, cacheRead, cacheWrite)
 * @param modelCosts - Model pricing info, or null for unknown/legacy models
 * @param config - Billing configuration (mode and surchargeRate)
 * @param groundTruthCredits - Credits from type-9 BILLING_METADATA (optional)
 */
export function computeBilling(
  tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
  modelCosts: ModelCosts | null,
  config: BillingConfig,
  groundTruthCredits?: number | null,
): BillingResult {
  const baseCostUsd = modelCosts ? calculateBaseCost(tokens, modelCosts) : 0

  if (config.mode === 'credits') {
    // Credits mode: NO surcharge, NO billed USD. Either ground-truth or synthesized.
    let creditsAugment: number | null
    let creditsSynthesized: number | null = null
    let synthesized = false

    if (groundTruthCredits != null) {
      creditsAugment = groundTruthCredits
    } else if (modelCosts) {
      creditsSynthesized = synthesizeCredits(baseCostUsd)
      creditsAugment = creditsSynthesized
      synthesized = true
    } else {
      creditsAugment = null // unknown model AND no ground truth → cannot compute
    }

    return {
      mode: 'credits',
      baseCostUsd,
      surchargeUsd: null,
      billedAmountUsd: null,
      creditsAugment,
      creditsSynthesized,
      synthesized,
    }
  }

  // Token+ mode: NO credits. Base + surcharge = billed.
  const surchargeUsd = baseCostUsd * config.surchargeRate
  const billedAmountUsd = baseCostUsd + surchargeUsd

  return {
    mode: 'token_plus',
    baseCostUsd,
    surchargeUsd,
    billedAmountUsd,
    creditsAugment: null,
    creditsSynthesized: null,
    synthesized: false,
  }
}

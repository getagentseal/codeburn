/**
 * Billing engine for CodeBurn v2.0.0
 *
 * Supports dual billing: estimated USD (via LiteLLM pricing) and Augment credits.
 * The credit formula matches Augment's internal billing:
 *   credits = ⌈costUSD × BASE_RATE × (1 + surchargeRate)⌉
 *
 * Environment variables:
 *   CODEBURN_BILLING_MODE: 'usd' | 'credits' | 'dual' (default: 'dual')
 *   CODEBURN_SURCHARGE_RATE: decimal surcharge (default: 0)
 *
 * Activity and model multipliers are hardcoded to 1.0 per spec.
 */

import { calculateCost } from './models.js'

// ============================================================================
// Constants (module-internal, not configurable via env)
// ============================================================================

/** Base conversion rate: 1 USD = 100 credits */
const BASE_RATE = 100

/** Activity multiplier - hardcoded per spec */
const ACTIVITY_MULTIPLIER = 1.0

/** Model multiplier - hardcoded per spec */
const MODEL_MULTIPLIER = 1.0

// ============================================================================
// Types
// ============================================================================

export type BillingMode = 'usd' | 'credits' | 'dual'

export type BillingConfig = {
  mode: BillingMode
  surchargeRate: number
}

export type BillingResult = {
  costUSD: number
  credits: number | null
}

// ============================================================================
// Config loading
// ============================================================================

function parseBillingMode(value: string | undefined): BillingMode {
  if (value === 'usd' || value === 'credits' || value === 'dual') {
    return value
  }
  return 'dual'
}

function parseSurchargeRate(value: string | undefined): number {
  if (!value) return 0
  const parsed = parseFloat(value)
  if (Number.isNaN(parsed) || parsed < 0) return 0
  return parsed
}

/**
 * Load billing configuration from environment variables.
 */
export function loadBillingConfig(): BillingConfig {
  return {
    mode: parseBillingMode(process.env['CODEBURN_BILLING_MODE']),
    surchargeRate: parseSurchargeRate(process.env['CODEBURN_SURCHARGE_RATE']),
  }
}

// ============================================================================
// Credit calculation
// ============================================================================

/**
 * Calculate credits from USD cost using Augment's formula:
 *   credits = ⌈costUSD × BASE_RATE × activityMultiplier × modelMultiplier × (1 + surchargeRate)⌉
 *
 * Activity and model multipliers are hardcoded to 1.0.
 */
export function calculateCredits(costUSD: number, surchargeRate: number): number {
  if (costUSD <= 0) return 0
  const raw = costUSD * BASE_RATE * ACTIVITY_MULTIPLIER * MODEL_MULTIPLIER * (1 + surchargeRate)
  return Math.ceil(raw)
}

// ============================================================================
// Billing calculation
// ============================================================================

/**
 * Calculate billing for a single API call.
 *
 * Uses calculateCost from models.ts for the USD calculation, then converts to credits
 * based on the billing mode.
 */
export function calculateBilling(
  config: BillingConfig,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
  webSearchRequests: number,
  speed: 'standard' | 'fast' = 'standard',
): BillingResult {
  const costUSD = calculateCost(
    model,
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    webSearchRequests,
    speed,
  )

  let credits: number | null = null

  if (config.mode === 'credits' || config.mode === 'dual') {
    credits = calculateCredits(costUSD, config.surchargeRate)
  }

  return { costUSD, credits }
}

/**
 * Format billing result for display based on mode.
 */
export function formatBillingResult(result: BillingResult, mode: BillingMode): string {
  switch (mode) {
    case 'usd':
      return `$${result.costUSD.toFixed(4)}`
    case 'credits':
      return result.credits !== null ? `${result.credits} credits` : 'N/A'
    case 'dual':
      return result.credits !== null
        ? `$${result.costUSD.toFixed(4)} (${result.credits} credits)`
        : `$${result.costUSD.toFixed(4)}`
  }
}

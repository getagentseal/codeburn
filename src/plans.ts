import type { Plan, PlanId, PlanProvider } from './config.js'
import { AI_CREDIT_USD } from './copilot-aiu.js'

export const PLAN_PROVIDERS: PlanProvider[] = ['all', 'claude', 'codex', 'cursor', 'grok', 'copilot', 'antigravity']
export const PLAN_IDS: PlanId[] = ['claude-pro', 'claude-max', 'claude-max-5x', 'cursor-pro', 'supergrok', 'supergrok-heavy', 'copilot-pro', 'copilot-pro-plus', 'copilot-max', 'google-ai-pro', 'google-ai-ultra-5x', 'google-ai-ultra-20x', 'custom', 'none']

// Official Copilot individual allotments from GitHub Docs, *Usage-based
// billing for individuals*, fetched 2026-08-23. Flex is documented as
// variable — pin this table, do not invent a later flex number.
// https://docs.github.com/copilot/concepts/billing/usage-based-billing-for-individuals
// monthlyUsd is credits × $0.01 (the budget equivalent), not the sticker price.
const COPILOT_PRO_CREDITS = 1500
const COPILOT_PRO_PLUS_CREDITS = 7000
const COPILOT_MAX_CREDITS = 20000

export const PRESET_PLANS: Record<'claude-pro' | 'claude-max' | 'claude-max-5x' | 'cursor-pro' | 'supergrok' | 'supergrok-heavy' | 'copilot-pro' | 'copilot-pro-plus' | 'copilot-max' | 'google-ai-pro' | 'google-ai-ultra-5x' | 'google-ai-ultra-20x', Omit<Plan, 'setAt'>> = {
  'claude-pro': {
    id: 'claude-pro',
    monthlyUsd: 20,
    provider: 'claude',
    resetDay: 1,
  },
  'claude-max': {
    id: 'claude-max',
    monthlyUsd: 200,
    provider: 'claude',
    resetDay: 1,
  },
  'claude-max-5x': {
    id: 'claude-max-5x',
    monthlyUsd: 100,
    provider: 'claude',
    resetDay: 1,
  },
  'cursor-pro': {
    id: 'cursor-pro',
    monthlyUsd: 20,
    provider: 'cursor',
    resetDay: 1,
  },
  'supergrok': {
    id: 'supergrok',
    monthlyUsd: 30,
    provider: 'grok',
    resetDay: 1,
  },
  'supergrok-heavy': {
    id: 'supergrok-heavy',
    monthlyUsd: 300,
    provider: 'grok',
    resetDay: 1,
  },
  'copilot-pro': {
    id: 'copilot-pro',
    monthlyCredits: COPILOT_PRO_CREDITS,
    monthlyUsd: COPILOT_PRO_CREDITS * AI_CREDIT_USD,
    provider: 'copilot',
    resetDay: 1,
  },
  'copilot-pro-plus': {
    id: 'copilot-pro-plus',
    monthlyCredits: COPILOT_PRO_PLUS_CREDITS,
    monthlyUsd: COPILOT_PRO_PLUS_CREDITS * AI_CREDIT_USD,
    provider: 'copilot',
    resetDay: 1,
  },
  'copilot-max': {
    id: 'copilot-max',
    monthlyCredits: COPILOT_MAX_CREDITS,
    monthlyUsd: COPILOT_MAX_CREDITS * AI_CREDIT_USD,
    provider: 'copilot',
    resetDay: 1,
  },
  // US monthly prices from https://gemini.google/us/subscriptions/, fetched
  // 2026-10-07. Antigravity is the only local tool these plans cover since
  // Google retired Gemini CLI OAuth for individual tiers.
  'google-ai-pro': {
    id: 'google-ai-pro',
    monthlyUsd: 19.99,
    provider: 'antigravity',
    resetDay: 1,
  },
  'google-ai-ultra-5x': {
    id: 'google-ai-ultra-5x',
    monthlyUsd: 99.99,
    provider: 'antigravity',
    resetDay: 1,
  },
  'google-ai-ultra-20x': {
    id: 'google-ai-ultra-20x',
    monthlyUsd: 199.99,
    provider: 'antigravity',
    resetDay: 1,
  },
}

export function isPlanProvider(value: string): value is PlanProvider {
  return PLAN_PROVIDERS.includes(value as PlanProvider)
}

export function isPlanId(value: string): value is PlanId {
  return PLAN_IDS.includes(value as PlanId)
}

export function getPresetPlan(id: string): Omit<Plan, 'setAt'> | null {
  if (id in PRESET_PLANS) {
    return PRESET_PLANS[id as keyof typeof PRESET_PLANS]
  }
  return null
}

export function planDisplayName(id: PlanId): string {
  switch (id) {
    case 'claude-pro':
      return 'Claude Pro'
    case 'claude-max':
      return 'Claude Max 20x'
    case 'claude-max-5x':
      return 'Claude Max 5x'
    case 'cursor-pro':
      return 'Cursor Pro'
    case 'supergrok':
      return 'SuperGrok'
    case 'supergrok-heavy':
      return 'SuperGrok Heavy'
    case 'copilot-pro':
      return 'Copilot Pro'
    case 'copilot-pro-plus':
      return 'Copilot Pro+'
    case 'copilot-max':
      return 'Copilot Max'
    case 'google-ai-pro':
      return 'Google AI Pro'
    case 'google-ai-ultra-5x':
      return 'Google AI Ultra 5x'
    case 'google-ai-ultra-20x':
      return 'Google AI Ultra 20x'
    case 'custom':
      return 'Custom'
    case 'none':
      return 'None'
  }
}

import type { Plan, PlanId, PlanProvider } from './config.js'

export const PLAN_PROVIDERS: PlanProvider[] = ['all', 'claude', 'codex', 'cursor', 'grok']
export const PLAN_IDS: PlanId[] = ['claude-pro', 'claude-max', 'claude-max-5x', 'cursor-pro', 'supergrok', 'supergrok-heavy', 'custom', 'none']

export const PRESET_PLANS: Record<'claude-pro' | 'claude-max' | 'claude-max-5x' | 'cursor-pro' | 'supergrok' | 'supergrok-heavy', Omit<Plan, 'setAt'>> = {
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
    case 'custom':
      return 'Custom'
    case 'none':
      return 'None'
  }
}

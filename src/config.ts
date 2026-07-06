import { readFile, writeFile, mkdir, rename } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { randomBytes } from 'crypto'
import { PLAN_PROVIDERS } from './plans.js'

export type PlanId = 'claude-pro' | 'claude-max' | 'claude-max-5x' | 'cursor-pro' | 'supergrok' | 'supergrok-heavy' | 'custom' | 'none'
export type PlanProvider = 'claude' | 'codex' | 'cursor' | 'grok' | 'all'

export type Plan = {
  id: PlanId
  monthlyUsd: number
  provider: PlanProvider
  resetDay?: number
  setAt: string
}

export type PlanConfig = Omit<Plan, 'provider' | 'setAt'> & Partial<Pick<Plan, 'provider' | 'setAt'>>
export type PlanConfigMap = Partial<Record<PlanProvider, PlanConfig>>
export type PlanMap = Partial<Record<PlanProvider, Plan>>

export type CodeburnConfig = {
  currency?: {
    code: string
    symbol?: string
  }
  devin?: {
    acuUsdRate?: number
  }
  plan?: Plan
  plans?: PlanConfigMap
  modelAliases?: Record<string, string>
  // Rates are stored as USD per 1,000,000 tokens; models.ts converts them to per-token ModelCosts.
  priceOverrides?: Record<string, { input: number; output: number; cacheRead?: number; cacheCreation?: number }>
  // Extra Claude config directories to aggregate usage across (e.g. work /
  // personal accounts). Honored by getClaudeConfigDirs() below the
  // CLAUDE_CONFIG_DIRS/CLAUDE_CONFIG_DIR env vars. Lets the macOS menubar (a
  // GUI app that doesn't inherit the user's shell env) configure multi-account
  // aggregation without injecting env into every spawned subprocess.
  claudeConfigDirs?: string[]
  // Map raw local-model names (e.g. "llama3.1:8b") to the paid model we would
  // price the call against (e.g. "gpt-4o"). The local call still costs $0; we
  // track what the same tokens would have cost on the baseline so the dashboard
  // can show "saved $X by running locally". Distinct from modelAliases which
  // rewrites actual spend.
  localModelSavings?: Record<string, string>
  // Absolute directory prefixes whose Claude Code sessions are routed through a
  // subscription-backed LLM proxy (e.g. GitHub Copilot via ANTHROPIC_BASE_URL;
  // tools like claude-code-over-github-copilot / claudegate). The JSONL records
  // the underlying model name and no endpoint, so codeburn cannot auto-detect
  // proxying — the user declares it here, scoped by the project's canonical cwd.
  // Matching projects keep their full API-rate `totalCostUSD` (the billable /
  // would-be figure is never destroyed) but expose `totalProxiedCostUSD` so the
  // report can show what was subscription-covered and the net out-of-pocket.
  // Matched against the canonical project path: prefix on a path-segment
  // boundary, case-insensitive, trailing-slash and backslash tolerant.
  proxyPaths?: string[]
}

function getConfigDir(): string {
  return join(homedir(), '.config', 'codeburn')
}

function getConfigPath(): string {
  return join(getConfigDir(), 'config.json')
}

export async function readConfig(): Promise<CodeburnConfig> {
  try {
    const raw = await readFile(getConfigPath(), 'utf-8')
    return JSON.parse(raw) as CodeburnConfig
  } catch {
    return {}
  }
}

export async function saveConfig(config: CodeburnConfig): Promise<void> {
  await mkdir(getConfigDir(), { recursive: true })
  const configPath = getConfigPath()
  // Randomize the temp path so two simultaneous saveConfig calls (from
  // overlapping menubar + CLI runs, for example) do not race on the same
  // staging file. The previous fixed `.tmp` suffix could leave one
  // process reading partial bytes the other was mid-writing.
  const tmpPath = `${configPath}.${randomBytes(8).toString('hex')}.tmp`
  await writeFile(tmpPath, JSON.stringify(config, null, 2) + '\n', 'utf-8')
  await rename(tmpPath, configPath)
}

export async function readPlan(): Promise<Plan | undefined> {
  const plans = await readPlans()
  for (const provider of PLAN_PROVIDERS) {
    const plan = plans[provider]
    if (plan) return plan
  }
  return undefined
}

function planFromConfig(provider: PlanProvider, plan: PlanConfig | undefined): Plan | undefined {
  if (!plan) return undefined
  return {
    ...plan,
    provider,
    setAt: plan.setAt ?? '',
  }
}

function normalizePlans(config: CodeburnConfig): PlanMap {
  const plans: PlanMap = {}

  if (config.plans && Object.keys(config.plans).length > 0) {
    for (const provider of PLAN_PROVIDERS) {
      const plan = planFromConfig(provider, config.plans[provider])
      if (plan) plans[provider] = plan
    }
    if (plans.all && PLAN_PROVIDERS.some(provider => provider !== 'all' && plans[provider])) {
      delete plans.all
    }
    return plans
  }

  if (config.plan) {
    plans[config.plan.provider] = config.plan
  }

  return plans
}

export async function readPlans(): Promise<PlanMap> {
  return normalizePlans(await readConfig())
}

export async function savePlan(plan: Plan): Promise<void> {
  const config = await readConfig()
  const plans = normalizePlans(config)
  if (plan.provider === 'all') {
    config.plans = { all: plan }
  } else {
    delete plans.all
    plans[plan.provider] = plan
    config.plans = plans
  }
  delete config.plan
  await saveConfig(config)
}

export async function clearPlan(provider?: PlanProvider): Promise<void> {
  const config = await readConfig()
  if (provider) {
    const plans = normalizePlans(config)
    delete plans[provider]
    if (Object.keys(plans).length > 0) {
      config.plans = plans
    } else {
      delete config.plans
    }
    delete config.plan
    await saveConfig(config)
    return
  }

  delete config.plan
  delete config.plans
  await saveConfig(config)
}

export function getConfigFilePath(): string {
  return getConfigPath()
}

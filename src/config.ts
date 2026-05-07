import { readFile, writeFile, mkdir, rename } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { randomBytes } from 'crypto'

export type PlanId = 'claude-pro' | 'claude-max' | 'claude-max-5x' | 'cursor-pro' | 'custom' | 'none'
export type PlanProvider = 'claude' | 'codex' | 'cursor' | 'all'

export type Plan = {
  id: PlanId
  monthlyUsd: number
  provider: PlanProvider
  resetDay?: number
  setAt: string
}

export type CodeburnConfig = {
  currency?: {
    code: string
    symbol?: string
  }
  plan?: Plan
  modelAliases?: Record<string, string>
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
  const config = await readConfig()
  return config.plan
}

export async function savePlan(plan: Plan): Promise<void> {
  const config = await readConfig()
  config.plan = plan
  await saveConfig(config)
}

export async function clearPlan(): Promise<void> {
  const config = await readConfig()
  delete config.plan
  await saveConfig(config)
}

export function getConfigFilePath(): string {
  return getConfigPath()
}

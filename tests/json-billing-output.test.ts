import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
const fixtureDir = fileURLToPath(new URL('./fixtures/auggie/', import.meta.url))

let workDir: string

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'codeburn-json-billing-'))
  await mkdir(join(workDir, 'sessions'), { recursive: true })
  await copyFile(join(fixtureDir, 'single-call.json'), join(workDir, 'sessions', 'single-call.json'))
})

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true })
})

function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', cliPath, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
      AUGMENT_HOME: workDir,
      CODEBURN_CACHE_DIR: join(workDir, 'cache'),
    },
    timeout: 10_000,
  })
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(0)
  return JSON.parse(result.stdout)
}

describe('billing-aware report/status JSON', () => {
  it('uses credits fields and nullable cost for credits mode rows', () => {
    const report = runCli(['report', '--period', 'all', '--format', 'json'], { CODEBURN_BILLING_MODE: 'credits' })

    expect(report).toMatchObject({ schema: 'codeburn.report.v2', schemaVersion: 2 })
    expect(report.billing.mode).toBe('credits')
    expect(report.overview.cost).toBeNull()
    expect(report.overview.creditsAugment).toBeGreaterThan(0)
    expect(report.overview.creditsSynthesizedCalls).toBe(1)
    expect(report.overview.costEstimateUsd).toBeGreaterThan(0)
    expect(report.daily[0]).toMatchObject({ cost: null, creditsSynthesizedCalls: 1 })
    expect(report.models[0]).toMatchObject({ cost: null, creditsSynthesizedCalls: 1 })
    expect(report.topSessions[0]).toMatchObject({ cost: null, creditsSynthesizedCalls: 1 })

    const status = runCli(['status', '--format', 'json'], { CODEBURN_BILLING_MODE: 'credits' })
    expect(status).toMatchObject({ schema: 'codeburn.status.v2', schemaVersion: 2 })
    expect(status.billing.mode).toBe('credits')
    expect(status.month.cost).toBeNull()
    expect(status.month.creditsSynthesizedCalls).toBe(1)
  })

  it('reports nonzero sub-agent credits separately without adding them to credit totals', async () => {
    await rm(join(workDir, 'sessions', 'single-call.json'), { force: true })
    await copyFile(join(fixtureDir, 'sub-agent-credits-nonzero.json'), join(workDir, 'sessions', 'sub-agent-credits-nonzero.json'))

    const report = runCli(['report', '--period', 'all', '--format', 'json'], { CODEBURN_BILLING_MODE: 'credits' })

    expect(report.billing.informationalFields.subAgentCreditsUsedUnconfirmed).toContain('not included in billing totals')
    expect(report.overview.creditsAugment).toBe(40)
    expect(report.overview.subAgentCreditsUsedUnconfirmed).toBe(6.5)
    expect(report.projects[0].creditsAugment).toBe(40)
    expect(report.projects[0].subAgentCreditsUsedUnconfirmed).toBe(6.5)
    expect(report.topSessions[0].creditsAugment).toBe(40)
    expect(report.topSessions[0].subAgentCreditsUsedUnconfirmed).toBe(6.5)
  })

  it('uses base surcharge and billed USD fields for token_plus rows', () => {
    const env = { CODEBURN_BILLING_MODE: 'token_plus', CODEBURN_SURCHARGE_RATE: '0.3' }
    const report = runCli(['report', '--period', 'all', '--format', 'json'], env)

    expect(report.billing).toMatchObject({ mode: 'token_plus', surchargeRate: 0.3 })
    expect(report.overview.baseCostUsd).toBeGreaterThan(0)
    expect(Math.abs(report.overview.surchargeUsd - report.overview.baseCostUsd * 0.3)).toBeLessThanOrEqual(0.01)
    expect(Math.abs(report.overview.billedAmountUsd - (report.overview.baseCostUsd + report.overview.surchargeUsd))).toBeLessThanOrEqual(0.01)
    expect(report.overview.cost).toBe(report.overview.billedAmountUsd)
    expect(report.daily[0].billedAmountUsd).toBe(report.overview.billedAmountUsd)
    expect(report.models[0].billedAmountUsd).toBe(report.overview.billedAmountUsd)
    expect(report.topSessions[0].billedAmountUsd).toBe(report.overview.billedAmountUsd)

    const status = runCli(['status', '--format', 'json'], env)
    expect(status.billing.mode).toBe('token_plus')
    expect(status.month.billedAmountUsd).toBe(report.overview.billedAmountUsd)
  })

  it('marks unpriced raw model ids without authoritative token_plus totals', async () => {
    await rm(join(workDir, 'sessions', 'single-call.json'))
    const raw = await readFile(join(fixtureDir, 'single-call.json'), 'utf-8')
    await writeFile(join(workDir, 'sessions', 'unknown-model.json'), raw.replace('"claude-sonnet-4-5"', '"butler"'), 'utf-8')

    const report = runCli(['report', '--period', 'all', '--format', 'json'], { CODEBURN_BILLING_MODE: 'token_plus' })
    const rawModel = report.models.find((model: { name: string }) => model.name === 'butler')

    expect(rawModel).toMatchObject({
      name: 'butler',
      pricingStatus: 'unpriced',
      baseCostUsd: null,
      billedAmountUsd: null,
      cost: null,
    })
    expect(rawModel.warnings[0]).toContain('butler')
    expect(report.warnings.some((warning: string) => warning.includes('butler'))).toBe(true)

    const status = runCli(['status', '--format', 'json'], { CODEBURN_BILLING_MODE: 'token_plus' })
    expect(status.month.warnings.some((warning: string) => warning.includes('butler'))).toBe(true)
  })

  it('updates report pricing when an alias is configured after a raw model was cached', async () => {
    await rm(join(workDir, 'sessions', 'single-call.json'))
    await copyFile(join(fixtureDir, 'old-schema.json'), join(workDir, 'sessions', 'old-schema.json'))

    const rawReport = runCli(['report', '--period', 'all', '--format', 'json'])
    const rawModel = rawReport.models.find((model: { name: string }) => model.name === 'butler')
    expect(rawModel).toMatchObject({ name: 'butler', pricingStatus: 'unpriced' })
    expect(rawModel.warnings[0]).toContain('butler')
    await readFile(join(workDir, 'cache', 'auggie', 'old-schema.json'), 'utf-8')

    const aliasReport = runCli(['report', '--period', 'all', '--format', 'json'], {
      CODEBURN_AUGGIE_ALIAS_BUTLER: 'claude-haiku-4-5',
    })

    expect(aliasReport.models.some((model: { name: string }) => model.name === 'butler')).toBe(false)
    expect(aliasReport.models[0]).toMatchObject({ name: 'Haiku 4.5', pricingStatus: 'estimated', warnings: [] })
  })
})
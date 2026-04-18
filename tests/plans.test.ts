import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, it, expect } from 'vitest'

import { clearPlan, readPlan, savePlan } from '../src/config.js'
import { getPresetPlan, isPlanId, isPlanProvider } from '../src/plans.js'

describe('plan presets', () => {
  it('resolves builtin presets', () => {
    expect(getPresetPlan('claude-pro')).toMatchObject({ id: 'claude-pro', monthlyUsd: 20, provider: 'claude' })
    expect(getPresetPlan('claude-max')).toMatchObject({ id: 'claude-max', monthlyUsd: 200, provider: 'claude' })
    expect(getPresetPlan('cursor-pro')).toMatchObject({ id: 'cursor-pro', monthlyUsd: 20, provider: 'cursor' })
    expect(getPresetPlan('custom')).toBeNull()
  })

  it('validates ids and providers', () => {
    expect(isPlanId('claude-pro')).toBe(true)
    expect(isPlanId('none')).toBe(true)
    expect(isPlanId('bad-plan')).toBe(false)

    expect(isPlanProvider('all')).toBe(true)
    expect(isPlanProvider('claude')).toBe(true)
    expect(isPlanProvider('invalid')).toBe(false)
  })
})

describe('plan config persistence', () => {
  it('round-trips savePlan/readPlan and clearPlan', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeburn-plan-test-'))
    const previousHome = process.env['HOME']
    process.env['HOME'] = dir

    try {
      await savePlan({
        id: 'claude-max',
        monthlyUsd: 200,
        provider: 'claude',
        resetDay: 12,
        setAt: '2026-04-17T12:00:00.000Z',
      })

      const plan = await readPlan()
      expect(plan).toMatchObject({
        id: 'claude-max',
        monthlyUsd: 200,
        provider: 'claude',
        resetDay: 12,
      })

      await clearPlan()
      expect(await readPlan()).toBeUndefined()
    } finally {
      if (previousHome === undefined) {
        delete process.env['HOME']
      } else {
        process.env['HOME'] = previousHome
      }
      await rm(dir, { recursive: true, force: true })
    }
  })
})

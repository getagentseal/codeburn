import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, it, expect } from 'vitest'

import { clearPlan, readPlan, readPlans, saveConfig, savePlan } from '../src/config.js'
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
  it('round-trips per-provider plans and clears one provider at a time', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeburn-plan-test-'))
    process.env['HOME'] = dir

    try {
      await savePlan({
        id: 'claude-max',
        monthlyUsd: 200,
        provider: 'claude',
        resetDay: 12,
        setAt: '2026-04-17T12:00:00.000Z',
      })
      await savePlan({
        id: 'custom',
        monthlyUsd: 200,
        provider: 'codex',
        resetDay: 1,
        setAt: '2026-04-18T12:00:00.000Z',
      })

      const plans = await readPlans()
      expect(plans.claude).toMatchObject({
        id: 'claude-max',
        monthlyUsd: 200,
        provider: 'claude',
        resetDay: 12,
      })
      expect(plans.codex).toMatchObject({
        id: 'custom',
        monthlyUsd: 200,
        provider: 'codex',
        resetDay: 1,
      })
      expect(await readPlan()).toMatchObject({ id: 'claude-max', provider: 'claude' })

      await clearPlan('codex')
      expect((await readPlans()).codex).toBeUndefined()
      expect((await readPlans()).claude).toMatchObject({ id: 'claude-max' })

      await clearPlan('all')
      expect((await readPlans()).claude).toMatchObject({ id: 'claude-max' })

      await clearPlan()
      expect(await readPlan()).toBeUndefined()
      expect(await readPlans()).toEqual({})
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reads legacy single-plan config as a provider-keyed plan map', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeburn-plan-test-'))
    process.env['HOME'] = dir

    try {
      await saveConfig({
        plan: {
          id: 'cursor-pro',
          monthlyUsd: 20,
          provider: 'cursor',
          resetDay: 3,
          setAt: '2026-04-17T12:00:00.000Z',
        },
      })

      const plans = await readPlans()
      expect(plans.cursor).toMatchObject({
        id: 'cursor-pro',
        monthlyUsd: 20,
        provider: 'cursor',
        resetDay: 3,
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('drops a hand-edited all plan when provider-specific plans are present', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeburn-plan-test-'))
    process.env['HOME'] = dir

    try {
      await saveConfig({
        plans: {
          all: {
            id: 'custom',
            monthlyUsd: 300,
            resetDay: 1,
            setAt: '2026-04-17T12:00:00.000Z',
          },
          claude: {
            id: 'claude-max',
            monthlyUsd: 200,
            resetDay: 1,
            setAt: '2026-04-18T12:00:00.000Z',
          },
        },
      })

      const plans = await readPlans()
      expect(plans.all).toBeUndefined()
      expect(plans.claude).toMatchObject({ id: 'claude-max', provider: 'claude' })
      expect(await readPlan()).toMatchObject({ id: 'claude-max', provider: 'claude' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not allow an all-provider plan to overlap provider-specific plans', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeburn-plan-test-'))
    process.env['HOME'] = dir

    try {
      await savePlan({
        id: 'custom',
        monthlyUsd: 100,
        provider: 'all',
        resetDay: 1,
        setAt: '2026-04-17T12:00:00.000Z',
      })
      await savePlan({
        id: 'claude-max',
        monthlyUsd: 200,
        provider: 'claude',
        resetDay: 1,
        setAt: '2026-04-18T12:00:00.000Z',
      })

      expect(await readPlans()).toMatchObject({
        claude: { id: 'claude-max' },
      })
      expect((await readPlans()).all).toBeUndefined()

      await savePlan({
        id: 'custom',
        monthlyUsd: 300,
        provider: 'all',
        resetDay: 1,
        setAt: '2026-04-19T12:00:00.000Z',
      })
      expect(await readPlans()).toMatchObject({
        all: { id: 'custom', monthlyUsd: 300 },
      })
      expect((await readPlans()).claude).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

import { describe, expect, it } from 'vitest'

import {
  AC_IDLE_SECONDS,
  ACTIVE_SECONDS,
  BATTERY_IDLE_SECONDS,
  CLI_MIN_REFRESH_SECONDS,
  LOW_POWER_IDLE_SECONDS,
  NAP_BACKSTOP_INTERVAL_SECONDS,
  NAP_BACKSTOP_TOLERANCE_SECONDS,
  SESSION_IDLE_THRESHOLD_SECONDS,
  napBackstopPlan,
  refreshIntervalSeconds,
  sessionsAreActive,
} from '../gnome/refreshCadence.js'

const AC = { onBattery: false, lowPowerMode: false }
const BATTERY = { onBattery: true, lowPowerMode: false }
const SAVER = { onBattery: true, lowPowerMode: true }

describe('GNOME refresh cadence', () => {
  it('uses the menubar constants', () => {
    expect(ACTIVE_SECONDS).toBe(30)
    expect(AC_IDLE_SECONDS).toBe(120)
    expect(BATTERY_IDLE_SECONDS).toBe(150)
    expect(LOW_POWER_IDLE_SECONDS).toBe(300)
    expect(SESSION_IDLE_THRESHOLD_SECONDS).toBe(120)
    expect(NAP_BACKSTOP_INTERVAL_SECONDS).toBe(180)
    expect(NAP_BACKSTOP_TOLERANCE_SECONDS).toBe(60)
    expect(CLI_MIN_REFRESH_SECONDS).toBe(60)
    expect(ACTIVE_SECONDS).toBeLessThan(AC_IDLE_SECONDS)
    expect(AC_IDLE_SECONDS).toBeLessThan(BATTERY_IDLE_SECONDS)
    expect(BATTERY_IDLE_SECONDS).toBeLessThan(LOW_POWER_IDLE_SECONDS)
    for (const idle of [AC_IDLE_SECONDS, BATTERY_IDLE_SECONDS, LOW_POWER_IDLE_SECONDS]) {
      expect(idle).toBeGreaterThanOrEqual(CLI_MIN_REFRESH_SECONDS)
    }
  })

  it('stays on the active cadence while the menu is open, on any power state', () => {
    for (const power of [AC, BATTERY, SAVER, { onBattery: false, lowPowerMode: true }]) {
      expect(refreshIntervalSeconds({ menuOpen: true, configuredSeconds: 30, ...power })).toBe(ACTIVE_SECONDS)
    }
  })

  it('honors a faster setting while active and caps a slower one at 30s', () => {
    expect(refreshIntervalSeconds({ menuOpen: true, configuredSeconds: 10, ...SAVER })).toBe(10)
    expect(refreshIntervalSeconds({ sessionsActive: true, menuOpen: false, configuredSeconds: 300, ...SAVER })).toBe(ACTIVE_SECONDS)
  })

  it('stretches a closed idle menu the way the menubar does', () => {
    expect(refreshIntervalSeconds({ menuOpen: false, sessionsActive: false, configuredSeconds: 30, ...AC })).toBe(AC_IDLE_SECONDS)
    expect(refreshIntervalSeconds({ menuOpen: false, sessionsActive: false, configuredSeconds: 30, ...BATTERY })).toBe(BATTERY_IDLE_SECONDS)
    expect(refreshIntervalSeconds({ menuOpen: false, sessionsActive: false, configuredSeconds: 30, ...SAVER })).toBe(LOW_POWER_IDLE_SECONDS)
    expect(refreshIntervalSeconds({
      menuOpen: false,
      sessionsActive: false,
      configuredSeconds: 30,
      onBattery: false,
      lowPowerMode: true,
    })).toBe(LOW_POWER_IDLE_SECONDS)
  })

  it('keeps a slower user setting when it already waits longer than the idle floor', () => {
    expect(refreshIntervalSeconds({ menuOpen: false, configuredSeconds: 200, ...AC })).toBe(200)
    expect(refreshIntervalSeconds({ menuOpen: false, configuredSeconds: 200, ...BATTERY })).toBe(200)
    expect(refreshIntervalSeconds({ menuOpen: false, configuredSeconds: 200, ...SAVER })).toBe(LOW_POWER_IDLE_SECONDS)
  })

  it('treats a working session as active even with the menu closed', () => {
    expect(sessionsAreActive({
      windowSeconds: 600,
      sessions: [{ idleSeconds: 0 }, { idleSeconds: SESSION_IDLE_THRESHOLD_SECONDS }],
    })).toBe(true)
    expect(sessionsAreActive({
      windowSeconds: 600,
      sessions: [{ idleSeconds: SESSION_IDLE_THRESHOLD_SECONDS }],
    })).toBe(true)
    expect(sessionsAreActive({
      windowSeconds: 600,
      sessions: [{ idleSeconds: SESSION_IDLE_THRESHOLD_SECONDS + 1 }],
    })).toBe(false)
    expect(sessionsAreActive({ windowSeconds: 600, sessions: [{}] })).toBe(true)
    expect(sessionsAreActive(undefined)).toBe(false)
    expect(sessionsAreActive({ windowSeconds: 600, sessions: [] })).toBe(false)

    expect(refreshIntervalSeconds({
      menuOpen: false,
      sessionsActive: true,
      configuredSeconds: 30,
      ...BATTERY,
    })).toBe(ACTIVE_SECONDS)
  })

  it('falls back to the active cadence for an unset interval and never returns zero', () => {
    expect(refreshIntervalSeconds({ menuOpen: true, configuredSeconds: 0 })).toBe(ACTIVE_SECONDS)
    expect(refreshIntervalSeconds({ menuOpen: false, configuredSeconds: Number.NaN, ...AC })).toBe(AC_IDLE_SECONDS)
    expect(refreshIntervalSeconds()).toBeGreaterThan(0)
  })

  it('does not arm the nap backstop on GNOME', () => {
    expect(napBackstopPlan()).toEqual({
      applies: false,
      intervalSeconds: NAP_BACKSTOP_INTERVAL_SECONDS,
      toleranceSeconds: NAP_BACKSTOP_TOLERANCE_SECONDS,
    })
  })
})

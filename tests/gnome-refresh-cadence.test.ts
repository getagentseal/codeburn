import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  AC_SECONDS,
  BATTERY_SECONDS,
  LOW_POWER_SECONDS,
  powerFloorSeconds,
  refreshIntervalSeconds,
} from '../gnome/refreshCadence.js'

describe('GNOME refresh cadence', () => {
  it('uses the menubar Auto floors', () => {
    expect(AC_SECONDS).toBe(120)
    expect(BATTERY_SECONDS).toBe(150)
    expect(LOW_POWER_SECONDS).toBe(300)
  })

  it('picks the floor from power state, low power winning', () => {
    expect(powerFloorSeconds({})).toBe(120)
    expect(powerFloorSeconds({ onBattery: true })).toBe(150)
    expect(powerFloorSeconds({ lowPowerMode: true })).toBe(300)
    expect(powerFloorSeconds({ onBattery: true, lowPowerMode: true })).toBe(300)
  })

  it('raises a faster setting to the floor', () => {
    expect(refreshIntervalSeconds({ configuredSeconds: 30 })).toBe(120)
    expect(refreshIntervalSeconds({ configuredSeconds: 30, onBattery: true })).toBe(150)
    expect(refreshIntervalSeconds({ configuredSeconds: 30, lowPowerMode: true })).toBe(300)
  })

  it('keeps a slower setting', () => {
    expect(refreshIntervalSeconds({ configuredSeconds: 200 })).toBe(200)
    expect(refreshIntervalSeconds({ configuredSeconds: 200, lowPowerMode: true })).toBe(300)
  })

  it('treats missing or bad settings as the floor and clamps to the schema range', () => {
    expect(refreshIntervalSeconds()).toBe(120)
    expect(refreshIntervalSeconds({ configuredSeconds: 0 })).toBe(120)
    expect(refreshIntervalSeconds({ configuredSeconds: Number.NaN, onBattery: true })).toBe(150)
    expect(refreshIntervalSeconds({ configuredSeconds: 9999 })).toBe(300)
  })
})

describe('GNOME indicator wiring', () => {
  const src = readFileSync(new URL('../gnome/indicator.js', import.meta.url), 'utf8')
  const timer = src.slice(src.indexOf('_armRefreshTimer() {'), src.indexOf('_clearRefreshTimer() {'))
  const menu = src.slice(src.indexOf('_connectMenu() {'), src.indexOf('_currentRefreshIntervalSeconds() {'))

  it('fetches when the menu opens', () => {
    expect(menu).toContain('if (open) this._refresh(true)')
  })

  it('keeps timer ticks behind the payload cache', () => {
    expect(timer).toContain('this._refresh();')
    expect(timer).not.toContain('this._refresh(true)')
  })

  it('has no session tier or nap backstop', () => {
    expect(src).not.toMatch(/napBackstop|_napSourceId|sessionsAreActive|_sessionsActive/)
  })
})

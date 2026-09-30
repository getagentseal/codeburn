import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_TRAY_APP_PREFS,
  canDeselect,
  isPatchObject,
  normalizeScale,
  normalizedPreferred,
  parseTrayAppPrefs,
  parseTrayDockPrefs,
  patchTrayFile,
  readTrayFile,
  sanitizeAppPatch,
  sanitizeDockPatch,
} from './tray-settings'

describe('reading the tray app files', () => {
  let home: string
  const settingsPath = () => join(home, '.config', 'codeburn', 'windows-settings.json')
  const dockPath = () => join(home, '.config', 'codeburn', 'windows-dock.json')

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'tray-settings-'))
    mkdirSync(join(home, '.config', 'codeburn'), { recursive: true })
  })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  it('is empty for a machine where the tray app has never run', () => {
    expect(readTrayFile('app', home)).toEqual({})
    expect(readTrayFile('dock', home)).toEqual({})
  })

  it('reads each file from the path the tray app reads it from', () => {
    writeFileSync(settingsPath(), JSON.stringify({ metric: 'tokens' }))
    writeFileSync(dockPath(), JSON.stringify({ enabled: true }))

    expect(readTrayFile('app', home)).toEqual({ metric: 'tokens' })
    expect(readTrayFile('dock', home)).toEqual({ enabled: true })
  })

  it('survives a byte order mark and refuses anything that is not an object', () => {
    writeFileSync(settingsPath(), `﻿${JSON.stringify({ metric: 'tokens' })}`)
    expect(readTrayFile('app', home)).toEqual({ metric: 'tokens' })

    writeFileSync(settingsPath(), '[1, 2]')
    expect(readTrayFile('app', home)).toEqual({})
  })

  // Both files hold keys this side has no business touching: the rail's placement, the tray
  // app's own theme cache, the provider set it seeded for itself.
  it('merges into what is already there rather than replacing it', () => {
    writeFileSync(dockPath(), JSON.stringify({
      enabled: true,
      placement: { docked: 'right', x: 1, y: 0.37 },
      scale: 0.6,
    }))

    patchTrayFile('dock', { scale: 1.1 }, home)

    expect(JSON.parse(readFileSync(dockPath(), 'utf8'))).toEqual({
      enabled: true,
      placement: { docked: 'right', x: 1, y: 0.37 },
      scale: 1.1,
    })
  })

  it('creates the directory when nothing has written there yet', () => {
    rmSync(join(home, '.config'), { recursive: true, force: true })

    patchTrayFile('app', { metric: 'cost' }, home)

    expect(JSON.parse(readFileSync(settingsPath(), 'utf8'))).toEqual({ metric: 'cost' })
  })
})

// The tray app collapses a value it cannot read to a default, so sending one would silently
// lose the setting. Everything is checked against the same closed set it parses with.
describe('parseTrayAppPrefs', () => {
  it('reads every key the Menu bar pane shows', () => {
    expect(parseTrayAppPrefs({
      metric: 'totalTokens',
      menubarPeriod: 'week',
      accent: 'green',
      trayBadge: true,
      usageRefreshSeconds: 300,
      quotaCadenceSeconds: 900,
      terminal: 'powershell',
    })).toEqual({
      metric: 'totalTokens',
      menubarPeriod: 'week',
      accent: 'green',
      trayBadge: true,
      usageRefreshSeconds: 300,
      quotaCadenceSeconds: 900,
      terminal: 'powershell',
    })
  })

  it('falls back to the tray app defaults for anything it would not understand', () => {
    expect(parseTrayAppPrefs({
      metric: 'credits',
      menubarPeriod: '30days',
      accent: 'chartreuse',
      trayBadge: 'yes',
      usageRefreshSeconds: 45,
      quotaCadenceSeconds: -5,
      terminal: 'bash',
    })).toEqual(DEFAULT_TRAY_APP_PREFS)
    expect(parseTrayAppPrefs({})).toEqual(DEFAULT_TRAY_APP_PREFS)
  })
})

describe('parseTrayDockPrefs', () => {
  it('reads every key the Capacity Dock pane shows', () => {
    expect(parseTrayDockPrefs({
      enabled: true,
      preferred: 'claude',
      scale: 0.9,
      theme: 'glass',
      gaugeShape: 'squircle',
      providers: ['claude', 'codex'],
      manualSelection: true,
      claudeProfiles: 'separate',
    })).toEqual({
      enabled: true,
      preferred: 'claude',
      scale: 0.9,
      theme: 'glass',
      gaugeShape: 'squircle',
      providers: ['claude', 'codex'],
      manualSelection: true,
      claudeProfiles: 'separate',
    })
  })

  it('still understands the appearance by the name it used to have', () => {
    expect(parseTrayDockPrefs({ theme: 'acrylic' }).theme).toBe('glass')
  })

  it('clamps and snaps the size to the steps the slider offers', () => {
    expect(normalizeScale(0.2)).toBe(0.6)
    expect(normalizeScale(9)).toBe(1.2)
    expect(normalizeScale(0.93)).toBe(0.95)
    expect(normalizeScale('big')).toBe(0.6)
  })

  it('keeps the Claude profiles mode to its two spelled values', () => {
    expect(parseTrayDockPrefs({ claudeProfiles: 'separate' }).claudeProfiles).toBe('separate')
    expect(parseTrayDockPrefs({ claudeProfiles: 'Combined' }).claudeProfiles).toBe('combined')
    expect(parseTrayDockPrefs({}).claudeProfiles).toBe('combined')
  })
})

describe('sanitizeAppPatch', () => {
  it('passes each key through, one at a time', () => {
    expect(sanitizeAppPatch({ metric: 'iconOnly' })).toEqual({ metric: 'iconOnly' })
    expect(sanitizeAppPatch({ menubarPeriod: 'month' })).toEqual({ menubarPeriod: 'month' })
    expect(sanitizeAppPatch({ accent: 'purple' })).toEqual({ accent: 'purple' })
    expect(sanitizeAppPatch({ trayBadge: true })).toEqual({ trayBadge: true })
    expect(sanitizeAppPatch({ usageRefreshSeconds: 0 })).toEqual({ usageRefreshSeconds: 0 })
    expect(sanitizeAppPatch({ quotaCadenceSeconds: 60 })).toEqual({ quotaCadenceSeconds: 60 })
    expect(sanitizeAppPatch({ terminal: 'commandPrompt' })).toEqual({ terminal: 'commandPrompt' })
  })

  // The renderer cannot reach a key the tray app owns, and cannot store a value it would
  // later fail to read.
  it('drops keys it is not allowed to write and repairs values it is', () => {
    expect(sanitizeAppPatch({ theme: 'dark', claudeConfigDirs: ['C:\\x'] })).toEqual({})
    expect(sanitizeAppPatch({ accent: 'not-a-colour' })).toEqual({ accent: 'ember' })
    expect(sanitizeAppPatch({ trayBadge: 'on' })).toEqual({ trayBadge: false })
  })
})

describe('sanitizeDockPatch', () => {
  it('passes each key through, one at a time', () => {
    expect(sanitizeDockPatch({ enabled: true })).toEqual({ enabled: true })
    expect(sanitizeDockPatch({ scale: 1.05 })).toEqual({ scale: 1.05 })
    expect(sanitizeDockPatch({ theme: 'glass' })).toEqual({ theme: 'glass' })
    expect(sanitizeDockPatch({ gaugeShape: 'squircle' })).toEqual({ gaugeShape: 'squircle' })
    expect(sanitizeDockPatch({ claudeProfiles: 'separate' })).toEqual({ claudeProfiles: 'separate' })
    expect(sanitizeDockPatch({ preferred: 'codex' })).toEqual({ preferred: 'codex' })
  })

  // Editing the set by hand is what stops the tray app seeding it from whatever is connected.
  it('latches the manual selection whenever the provider set is written', () => {
    expect(sanitizeDockPatch({ providers: ['claude', 'codex'] }))
      .toEqual({ providers: ['claude', 'codex'], manualSelection: true })
  })

  it('refuses anything that is not a provider id, and the rail placement', () => {
    expect(sanitizeDockPatch({ placement: { docked: 'left' } })).toEqual({})
    expect(sanitizeDockPatch({ preferred: '../../etc' })).toEqual({ preferred: null })
    expect(sanitizeDockPatch({ providers: ['claude', 'Bad Id', 42] }))
      .toEqual({ providers: ['claude'], manualSelection: true })
    // An unknown profiles mode is repaired to the default rather than written where the tray
    // app would have to parse it back.
    expect(sanitizeDockPatch({ claudeProfiles: 'one-ring-each' })).toEqual({ claudeProfiles: 'combined' })
  })
})

// Both patches arrive over IPC, so the argument is whatever the renderer sent rather than the
// object the signature promises. `'metric' in patch` throws a TypeError on a string, a number
// and null, and on an array it answers about indices, so the shape is settled first.
describe('a patch that is not an object at all', () => {
  const notObjects: unknown[] = [null, undefined, 'metric', 42, ['metric'], [], true]

  it('is dropped whole by isPatchObject', () => {
    for (const value of notObjects) expect(isPatchObject(value)).toBe(false)
    expect(isPatchObject({})).toBe(true)
    expect(isPatchObject({ metric: 'cost' })).toBe(true)
  })

  it('writes nothing through sanitizeAppPatch, and does not throw', () => {
    for (const value of notObjects) expect(sanitizeAppPatch(value)).toEqual({})
  })

  it('writes nothing through sanitizeDockPatch, and does not throw', () => {
    for (const value of notObjects) expect(sanitizeDockPatch(value)).toEqual({})
  })
})

describe('the rail always has something to show', () => {
  it('moves the resting provider when it leaves the set', () => {
    expect(normalizedPreferred('claude', ['claude', 'codex'])).toBe('claude')
    expect(normalizedPreferred('gemini', ['claude', 'codex'])).toBe('claude')
    expect(normalizedPreferred('claude', [])).toBeNull()
  })

  it('keeps the last connected provider switched on', () => {
    expect(canDeselect('claude', ['claude', 'codex'], ['claude', 'codex'])).toBe(true)
    expect(canDeselect('claude', ['claude'], ['claude'])).toBe(false)
    // One that is not connected is not what the rail is being kept alive by.
    expect(canDeselect('codex', ['claude', 'codex'], ['claude'])).toBe(true)
    expect(canDeselect('gemini', ['claude'], ['claude'])).toBe(true)
  })
})

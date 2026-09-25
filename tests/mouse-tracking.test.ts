import { PassThrough } from 'node:stream'

import React from 'react'
import { render } from 'ink'
import stripAnsi from 'strip-ansi'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'

import { InteractiveDashboard } from '../src/dashboard.js'
import type { ProjectSummary } from '../src/types.js'

const MOUSE_TRACKING_ON = '\x1b[?1000h\x1b[?1006h'
const MOUSE_TRACKING_OFF = '\x1b[?1006l\x1b[?1000l'

const PROJECTS: ProjectSummary[] = [
  { project: 'proj', projectPath: 'proj', sessions: [], totalCostUSD: 0, totalSavingsUSD: 0, totalApiCalls: 0 },
]

// The viewport writes the tracking sequences to the process's own stdout (the
// terminal), not to Ink's injected stream, and only when both ends are a TTY.
let writes: string[]
let stdoutTTY: boolean | undefined
let stdinTTY: boolean | undefined

beforeEach(() => {
  writes = []
  stdoutTTY = process.stdout.isTTY
  stdinTTY = process.stdin.isTTY
  process.stdout.isTTY = true
  process.stdin.isTTY = true
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { writes.push(String(chunk)); return true })
})

afterEach(() => {
  vi.restoreAllMocks()
  process.stdout.isTTY = stdoutTTY as boolean
  process.stdin.isTTY = stdinTTY as boolean
})

function makeTui(columns = 120) {
  const stdin = new PassThrough() as PassThrough & NodeJS.ReadStream
  const stdout = new PassThrough({ highWaterMark: 4 * 1024 * 1024 }) as PassThrough & NodeJS.WriteStream
  stdin.isTTY = true
  stdin.setRawMode = () => stdin
  stdin.ref = () => stdin
  stdin.unref = () => stdin
  stdout.isTTY = true
  stdout.columns = columns
  stdout.rows = 50
  return { stdin, stdout }
}

async function mountDashboard(columns = 120) {
  const { stdin, stdout } = makeTui(columns)
  const frames: string[] = []
  stdout.on('data', chunk => frames.push(stripAnsi(String(chunk))))
  const app = render(React.createElement(InteractiveDashboard, {
    initialProjects: PROJECTS,
    initialPeriod: 'today',
    initialProvider: 'all',
    refreshSeconds: 0,
    windowColumns: columns,
  }), { stdin, stdout, debug: true, interactive: true, patchConsole: false })
  await app.waitUntilRenderFlush()
  return { app, stdin, frames }
}

describe('dashboard mouse tracking toggle (#951)', () => {
  it('does not enable mouse tracking at mount, so text selection keeps working', async () => {
    const { app } = await mountDashboard()
    onTestFinished(() => app.unmount())

    expect(writes.join('')).not.toContain(MOUSE_TRACKING_ON)
  })

  it('m enables tracking, and m again disables it without waiting for unmount', async () => {
    const { app, stdin } = await mountDashboard()
    onTestFinished(() => app.unmount())

    stdin.write('m')
    await app.waitUntilRenderFlush()
    expect(writes.join('')).toContain(MOUSE_TRACKING_ON)

    writes.length = 0
    stdin.write('m')
    await app.waitUntilRenderFlush()
    expect(writes.join('')).toContain(MOUSE_TRACKING_OFF)
    expect(writes.join('')).not.toContain(MOUSE_TRACKING_ON)
  })

  it('unmount after enabling leaves tracking off', async () => {
    const { app, stdin } = await mountDashboard()

    stdin.write('m')
    await app.waitUntilRenderFlush()
    writes.length = 0
    app.unmount()
    await app.waitUntilExit()

    expect(writes.join('')).toContain(MOUSE_TRACKING_OFF)
  })

  it('shows the toggle in the key hints at 80 columns', async () => {
    const { app, frames } = await mountDashboard(80)
    onTestFinished(() => app.unmount())

    expect(frames.join('')).toContain('m mouse')
  })
})

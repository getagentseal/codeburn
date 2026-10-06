import { describe, expect, it } from 'vitest'

import { chooseRuntime, meetsFloor } from '../src/runtime'

describe('meetsFloor', () => {
  it('needs 22.13 or later', () => {
    expect(meetsFloor('22.13.0')).toBe(true)
    expect(meetsFloor('24.21.0')).toBe(true)
    expect(meetsFloor('22.12.9')).toBe(false)
    expect(meetsFloor('20.19.0')).toBe(false)
  })
})

describe('chooseRuntime', () => {
  const probes: Record<string, { version: string; sqlite: boolean }> = {
    '/old/node': { version: '20.11.0', sqlite: false },
    '/new/node': { version: '22.14.0', sqlite: true },
  }
  const probe = (bin: string) => probes[bin] ?? null

  it("uses the editor's own Node when it is new enough and has node:sqlite", () => {
    expect(chooseRuntime({ host: { version: '24.21.0', sqlite: true }, configured: '', candidates: ['/new/node'], probe })).toEqual({ kind: 'host', version: '24.21.0' })
  })

  it('prefers a configured Node that works', () => {
    expect(chooseRuntime({ host: { version: '24.21.0', sqlite: true }, configured: '/new/node', candidates: [], probe })).toEqual({ kind: 'node', bin: '/new/node', version: '22.14.0' })
  })

  it('falls back to a discovered Node when the editor is too old', () => {
    expect(chooseRuntime({ host: { version: '20.18.0', sqlite: false }, configured: '/old/node', candidates: ['/missing', '/old/node', '/new/node'], probe }))
      .toEqual({ kind: 'node', bin: '/new/node', version: '22.14.0' })
  })

  it('runs degraded on the editor when nothing else works', () => {
    expect(chooseRuntime({ host: { version: '20.18.0', sqlite: false }, configured: '', candidates: ['/old/node'], probe }))
      .toEqual({ kind: 'degraded', version: '20.18.0', sqlite: false })
  })
})
